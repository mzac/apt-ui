"""
Compliance / SLA reports (issue #51).

Canned queries that aggregate UpdateCheck and UpdateHistory data for audit/SLA
reporting. Exposed as JSON; the frontend offers CSV download.
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, UpdateCheck, UpdateHistory, User

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/patch-coverage")
async def patch_coverage(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """% of servers that have been successfully checked within 24h, 7d, 30d."""
    now = datetime.utcnow()
    res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = list(res.scalars().all())

    rows = []
    counts = {"24h": 0, "7d": 0, "30d": 0}
    cutoffs = {"24h": now - timedelta(hours=24), "7d": now - timedelta(days=7), "30d": now - timedelta(days=30)}
    for s in servers:
        chk_res = await db.execute(
            select(UpdateCheck).where(UpdateCheck.server_id == s.id, UpdateCheck.status == "success")
            .order_by(UpdateCheck.checked_at.desc()).limit(1)
        )
        chk = chk_res.scalar_one_or_none()
        last = chk.checked_at if chk else None
        in_24h = bool(last and last >= cutoffs["24h"])
        in_7d = bool(last and last >= cutoffs["7d"])
        in_30d = bool(last and last >= cutoffs["30d"])
        if in_24h:
            counts["24h"] += 1
        if in_7d:
            counts["7d"] += 1
        if in_30d:
            counts["30d"] += 1
        rows.append({
            "server": s.name,
            "hostname": s.hostname,
            "last_check": last.isoformat() if last else None,
            "in_24h": in_24h,
            "in_7d": in_7d,
            "in_30d": in_30d,
        })

    total = len(servers)
    return {
        "generated_at": now.isoformat() + "Z",
        "total_enabled_servers": total,
        "summary": {
            "checked_in_24h": counts["24h"],
            "checked_in_7d": counts["7d"],
            "checked_in_30d": counts["30d"],
            "pct_24h": round(counts["24h"] / total * 100, 1) if total else 0,
            "pct_7d": round(counts["7d"] / total * 100, 1) if total else 0,
            "pct_30d": round(counts["30d"] / total * 100, 1) if total else 0,
        },
        "servers": rows,
    }


@router.get("/upgrade-success-rate")
async def upgrade_success_rate(
    days: int = Query(default=30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Per-server upgrade success/failure counts over the last *days*."""
    now = datetime.utcnow()
    cutoff = now - timedelta(days=days)
    res = await db.execute(select(Server))
    servers = {s.id: s for s in res.scalars().all()}

    hist_res = await db.execute(
        select(UpdateHistory.server_id, UpdateHistory.status, func.count())
        .where(UpdateHistory.started_at >= cutoff)
        .group_by(UpdateHistory.server_id, UpdateHistory.status)
    )
    counts: dict[int, dict[str, int]] = {}
    for sid, status_, n in hist_res.all():
        counts.setdefault(sid, {})[status_] = n

    rows = []
    total_success = 0
    total_error = 0
    for sid, server in servers.items():
        c = counts.get(sid, {})
        success = c.get("success", 0)
        error = c.get("error", 0)
        running = c.get("running", 0)
        total = success + error
        rows.append({
            "server": server.name,
            "hostname": server.hostname,
            "success": success,
            "error": error,
            "running": running,
            "success_rate": round(success / total * 100, 1) if total else None,
        })
        total_success += success
        total_error += error

    return {
        "generated_at": now.isoformat() + "Z",
        "window_days": days,
        "summary": {
            "total_success": total_success,
            "total_error": total_error,
            "overall_rate": round(total_success / (total_success + total_error) * 100, 1) if (total_success + total_error) else None,
        },
        "servers": rows,
    }


@router.get("/security-sla")
async def security_sla(
    sla_days: int = Query(default=7, ge=1, le=90),
    window_days: int = Query(default=90, ge=7, le=365),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Of servers that had pending security updates within *window_days*, how
    many had no security updates pending *sla_days* later? Approximation —
    full per-package SLA would need package-level tracking we don't have."""
    now = datetime.utcnow()
    res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = list(res.scalars().all())
    cutoff = now - timedelta(days=window_days)

    rows = []
    in_sla = 0
    out_sla = 0
    no_sec_seen = 0
    for s in servers:
        # First check in the window where security_packages > 0
        first_sec_res = await db.execute(
            select(UpdateCheck).where(
                UpdateCheck.server_id == s.id,
                UpdateCheck.security_packages > 0,
                UpdateCheck.checked_at >= cutoff,
            ).order_by(UpdateCheck.checked_at.asc()).limit(1)
        )
        first_sec = first_sec_res.scalar_one_or_none()
        if first_sec is None:
            no_sec_seen += 1
            rows.append({
                "server": s.name,
                "hostname": s.hostname,
                "first_security_seen": None,
                "cleared_at": None,
                "days_to_clear": None,
                "in_sla": None,
            })
            continue

        # Earliest later check that has security_packages == 0
        cleared_res = await db.execute(
            select(UpdateCheck).where(
                UpdateCheck.server_id == s.id,
                UpdateCheck.security_packages == 0,
                UpdateCheck.checked_at > first_sec.checked_at,
            ).order_by(UpdateCheck.checked_at.asc()).limit(1)
        )
        cleared = cleared_res.scalar_one_or_none()
        if cleared:
            days = (cleared.checked_at - first_sec.checked_at).total_seconds() / 86400
            ok = days <= sla_days
            if ok:
                in_sla += 1
            else:
                out_sla += 1
            rows.append({
                "server": s.name,
                "hostname": s.hostname,
                "first_security_seen": first_sec.checked_at.isoformat(),
                "cleared_at": cleared.checked_at.isoformat(),
                "days_to_clear": round(days, 2),
                "in_sla": ok,
            })
        else:
            # Still pending; use "now" as the open duration
            days = (now - first_sec.checked_at).total_seconds() / 86400
            ok = days <= sla_days
            if ok:
                in_sla += 1
            else:
                out_sla += 1
            rows.append({
                "server": s.name,
                "hostname": s.hostname,
                "first_security_seen": first_sec.checked_at.isoformat(),
                "cleared_at": None,
                "days_to_clear": round(days, 2),
                "in_sla": ok,
            })

    total = in_sla + out_sla
    return {
        "generated_at": now.isoformat() + "Z",
        "sla_days": sla_days,
        "window_days": window_days,
        "summary": {
            "in_sla": in_sla,
            "out_of_sla": out_sla,
            "no_security_seen": no_sec_seen,
            "pct_in_sla": round(in_sla / total * 100, 1) if total else None,
        },
        "servers": rows,
    }
