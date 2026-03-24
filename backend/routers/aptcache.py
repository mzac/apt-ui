"""
apt-cacher-ng monitoring router.
Fetches and parses stats from one or more apt-cacher-ng instances.
"""
import re
import html as html_lib
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import AptCacheServer

router = APIRouter(prefix="/api/aptcache", tags=["aptcache"])


# ---------------------------------------------------------------------------
# HTML parsing helpers
# ---------------------------------------------------------------------------

def _strip_tags(s: str) -> str:
    return html_lib.unescape(re.sub(r'<[^>]+>', ' ', s)).strip()


def _table_rows(table_html: str) -> list[list[str]]:
    """Return list of rows, each row is a list of cell text strings."""
    rows = []
    for row_m in re.finditer(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE):
        cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row_m.group(1), re.DOTALL | re.IGNORECASE)
        rows.append([_strip_tags(c) for c in cells])
    return rows


def _parse_count_pct(s: str) -> tuple[int, float]:
    """Parse '80 (12.12%)' → (80, 12.12)."""
    m = re.match(r'(\d[\d,]*)\s*\(([\d.]+)%\)', s.strip())
    if m:
        return int(m.group(1).replace(',', '')), float(m.group(2))
    try:
        return int(s.strip().replace(',', '')), 0.0
    except Exception:
        return 0, 0.0


def _parse_acng_html(html: str) -> dict:
    """
    Parse the full apt-cacher-ng HTML report page.
    Returns transfer totals (startup + recent) and per-day log analysis rows.
    """
    tables = re.findall(r'<table[^>]*>(.*?)</table>', html, re.DOTALL | re.IGNORECASE)

    data_fetched_startup = data_fetched_recent = ""
    data_served_startup  = data_served_recent  = ""
    daily: list[dict] = []

    for tbl in tables:
        rows = _table_rows(tbl)
        for row in rows:
            if not row:
                continue

            # Transfer statistics table: "Data fetched:" | startup_val | recent_val
            if len(row) >= 3 and 'fetched' in row[0].lower():
                data_fetched_startup = row[1]
                data_fetched_recent  = row[2]
            elif len(row) >= 3 and 'served' in row[0].lower():
                data_served_startup = row[1]
                data_served_recent  = row[2]

            # Log analysis rows start with a date pattern: "2026-03-23 03:01 - 2026-03-24 03:01"
            elif re.match(r'\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}', row[0]):
                period = row[0].strip()
                date   = period[:10]
                # Strip empty/whitespace-only cells (acng adds blank spacer cells)
                cells  = [c for c in row[1:] if c.strip()]
                # Expected order: hits_req, misses_req, total_req, hits_data, misses_data, total_data
                if len(cells) < 6:
                    continue
                hit_req,  hit_req_pct  = _parse_count_pct(cells[0])
                miss_req, miss_req_pct = _parse_count_pct(cells[1])
                try:
                    total_req = int(cells[2].replace(',', ''))
                except Exception:
                    total_req = hit_req + miss_req

                hits_data_raw   = cells[3]
                misses_data_raw = cells[4]
                total_data_raw  = cells[5]

                hits_data   = hits_data_raw.split('(')[0].strip()
                misses_data = misses_data_raw.split('(')[0].strip()
                total_data  = total_data_raw.split('(')[0].strip()

                hits_data_pct_m = re.search(r'\(([\d.]+)%\)', hits_data_raw)
                hits_data_pct   = float(hits_data_pct_m.group(1)) if hits_data_pct_m else 0.0

                daily.append({
                    "period":        period,
                    "date":          date,
                    "hit_requests":  hit_req,
                    "hit_req_pct":   round(hit_req_pct, 1),
                    "miss_requests": miss_req,
                    "total_requests": total_req,
                    "hits_data":     hits_data,
                    "hits_data_pct": round(hits_data_pct, 1),
                    "misses_data":   misses_data,
                    "total_data":    total_data,
                })

    return {
        "data_fetched_startup": data_fetched_startup,
        "data_fetched_recent":  data_fetched_recent,
        "data_served_startup":  data_served_startup,
        "data_served_recent":   data_served_recent,
        "daily":                daily[:14],   # cap at 14 days
    }


async def _fetch_stats(host: str, port: int) -> dict:
    # Fetch the full HTML report (not ?output=plain — the plain format lacks the daily table)
    url = f"http://{host}:{port}/acng-report.html"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            return {"ok": True, **_parse_acng_html(r.text)}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Connection timed out"}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_servers(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(AptCacheServer).order_by(AptCacheServer.id))
    servers = result.scalars().all()
    return [
        {
            "id":      s.id,
            "label":   s.label,
            "host":    s.host,
            "port":    s.port,
            "enabled": s.enabled,
        }
        for s in servers
    ]


@router.post("")
async def add_server(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    s = AptCacheServer(
        label=body.get("label", body.get("host", "apt-cacher-ng")),
        host=body["host"],
        port=int(body.get("port", 3142)),
        enabled=bool(body.get("enabled", True)),
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return {"id": s.id, "label": s.label, "host": s.host, "port": s.port, "enabled": s.enabled}


@router.put("/{server_id}")
async def update_server(
    server_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(AptCacheServer).where(AptCacheServer.id == server_id))
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Not found")
    if "label" in body:
        s.label = body["label"]
    if "host" in body:
        s.host = body["host"]
    if "port" in body:
        s.port = int(body["port"])
    if "enabled" in body:
        s.enabled = bool(body["enabled"])
    await db.commit()
    return {"id": s.id, "label": s.label, "host": s.host, "port": s.port, "enabled": s.enabled}


@router.delete("/{server_id}")
async def delete_server(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(AptCacheServer).where(AptCacheServer.id == server_id))
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Not found")
    await db.delete(s)
    await db.commit()
    return {"ok": True}


@router.get("/{server_id}/stats")
async def get_stats(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(AptCacheServer).where(AptCacheServer.id == server_id))
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Not found")
    stats = await _fetch_stats(s.host, s.port)
    return {"id": s.id, "label": s.label, "host": s.host, "port": s.port, **stats}


@router.get("/stats/all")
async def get_all_stats(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Fetch stats for all enabled cache servers in parallel."""
    import asyncio
    result = await db.execute(
        select(AptCacheServer).where(AptCacheServer.enabled == True).order_by(AptCacheServer.id)
    )
    servers = result.scalars().all()
    if not servers:
        return []

    async def fetch_one(s: AptCacheServer):
        stats = await _fetch_stats(s.host, s.port)
        return {"id": s.id, "label": s.label, "host": s.host, "port": s.port, **stats}

    return await asyncio.gather(*[fetch_one(s) for s in servers])
