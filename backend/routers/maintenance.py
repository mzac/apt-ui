"""
Maintenance windows (issue #40).

CRUD endpoints + a helper to test whether a server is currently inside a
deny window. Auto-upgrade and (optionally) Upgrade All consult this helper
to skip / warn about servers that should not be touched right now.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.config import TZ
from backend.database import get_db
from backend.models import MaintenanceWindow, Server, User

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


def _now_local() -> datetime:
    return datetime.now(tz=TZ)


def is_in_window(window: MaintenanceWindow, now: datetime | None = None) -> bool:
    """Test whether *now* falls inside the configured window."""
    if not window.enabled:
        return False
    n = now or _now_local()
    minute_of_day = n.hour * 60 + n.minute
    # Python: Monday=0 ... Sunday=6
    if not (window.days_of_week & (1 << n.weekday())):
        return False
    if window.start_minutes <= window.end_minutes:
        return window.start_minutes <= minute_of_day < window.end_minutes
    # Wraps midnight (e.g. 22:00 → 06:00)
    return minute_of_day >= window.start_minutes or minute_of_day < window.end_minutes


async def get_active_window_for_server(db: AsyncSession, server_id: int) -> MaintenanceWindow | None:
    """Return the first active deny window for *server_id*, or None.

    Per-server windows take priority; falls back to global windows.
    """
    now = _now_local()
    res = await db.execute(
        select(MaintenanceWindow).where(MaintenanceWindow.enabled == True)
    )
    windows = list(res.scalars().all())
    # Per-server first
    for w in windows:
        if w.server_id == server_id and is_in_window(w, now):
            return w
    # Then global (server_id IS NULL)
    for w in windows:
        if w.server_id is None and is_in_window(w, now):
            return w
    return None


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _serialize(w: MaintenanceWindow) -> dict:
    return {
        "id": w.id,
        "server_id": w.server_id,
        "name": w.name,
        "start_minutes": w.start_minutes,
        "end_minutes": w.end_minutes,
        "days_of_week": w.days_of_week,
        "enabled": w.enabled,
        "created_at": w.created_at,
    }


@router.get("")
async def list_windows(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    res = await db.execute(select(MaintenanceWindow).order_by(MaintenanceWindow.id))
    return [_serialize(w) for w in res.scalars().all()]


@router.post("", status_code=201)
async def create_window(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    try:
        start = int(body.get("start_minutes", 0))
        end = int(body.get("end_minutes", 0))
        days = int(body.get("days_of_week", 127))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid time/days")
    if not (0 <= start < 1440) or not (0 <= end < 1440):
        raise HTTPException(status_code=400, detail="Times must be 0..1439 (minutes since midnight)")
    if not (0 < days < 128):
        raise HTTPException(status_code=400, detail="days_of_week must be 1..127")

    sid = body.get("server_id")
    if sid is not None:
        srv = (await db.execute(select(Server).where(Server.id == sid))).scalar_one_or_none()
        if srv is None:
            raise HTTPException(status_code=404, detail="Server not found")

    w = MaintenanceWindow(
        server_id=sid,
        name=name,
        start_minutes=start,
        end_minutes=end,
        days_of_week=days,
        enabled=bool(body.get("enabled", True)),
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.put("/{window_id}")
async def update_window(
    window_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    res = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = res.scalar_one_or_none()
    if w is None:
        raise HTTPException(status_code=404, detail="Not found")
    if "name" in body:
        w.name = (body["name"] or "").strip() or w.name
    if "start_minutes" in body:
        w.start_minutes = max(0, min(1439, int(body["start_minutes"])))
    if "end_minutes" in body:
        w.end_minutes = max(0, min(1439, int(body["end_minutes"])))
    if "days_of_week" in body:
        d = int(body["days_of_week"])
        if 0 < d < 128:
            w.days_of_week = d
    if "enabled" in body:
        w.enabled = bool(body["enabled"])
    if "server_id" in body:
        w.server_id = body["server_id"]
    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.delete("/{window_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_window(
    window_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    res = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = res.scalar_one_or_none()
    if w is None:
        raise HTTPException(status_code=404, detail="Not found")
    await db.delete(w)
    await db.commit()


@router.get("/active")
async def list_active(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return the set of server IDs currently inside a deny window.

    Used by the dashboard to badge servers that should not be upgraded right now.
    """
    res = await db.execute(select(Server))
    servers = res.scalars().all()
    blocked: dict[int, dict] = {}
    for s in servers:
        w = await get_active_window_for_server(db, s.id)
        if w:
            blocked[s.id] = {"window_id": w.id, "name": w.name}
    return {"blocked": blocked, "checked_at": _now_local().isoformat()}
