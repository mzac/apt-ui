"""Shared queries for the per-server "latest row" lookups.

Several hot endpoints (/stats/overview, /status.json, /metrics, list_servers, reports)
previously looped a separate "latest UpdateCheck/ServerStats for this server" query per
server — an N+1 that ran on every 30s dashboard poll, every metrics scrape, and every
unauthenticated status hit. These helpers fetch all of them in a single query each.
"""
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import UpdateCheck, ServerStats


async def latest_checks_by_server(db: AsyncSession) -> dict[int, UpdateCheck]:
    """Return {server_id: latest UpdateCheck} in one query (was one query per server)."""
    subq = (
        select(
            UpdateCheck.server_id.label("sid"),
            func.max(UpdateCheck.checked_at).label("mx"),
        )
        .group_by(UpdateCheck.server_id)
        .subquery()
    )
    stmt = select(UpdateCheck).join(
        subq,
        and_(UpdateCheck.server_id == subq.c.sid, UpdateCheck.checked_at == subq.c.mx),
    )
    result = await db.execute(stmt)
    out: dict[int, UpdateCheck] = {}
    for chk in result.scalars().all():
        out[chk.server_id] = chk  # on a (rare) checked_at tie, last wins
    return out


async def latest_stats_by_server(db: AsyncSession) -> dict[int, ServerStats]:
    """Return {server_id: latest ServerStats} in one query."""
    subq = (
        select(
            ServerStats.server_id.label("sid"),
            func.max(ServerStats.recorded_at).label("mx"),
        )
        .group_by(ServerStats.server_id)
        .subquery()
    )
    stmt = select(ServerStats).join(
        subq,
        and_(ServerStats.server_id == subq.c.sid, ServerStats.recorded_at == subq.c.mx),
    )
    result = await db.execute(stmt)
    out: dict[int, ServerStats] = {}
    for st in result.scalars().all():
        out[st.server_id] = st
    return out


async def record_fleet_snapshot(db: AsyncSession) -> None:
    """Compute and persist a point-in-time fleet aggregate (for trend charts)."""
    from backend.models import Server, FleetSnapshot

    servers = (await db.execute(select(Server).where(Server.is_enabled == True))).scalars().all()
    checks = await latest_checks_by_server(db)
    up = ua = sec = err = reboot = pend = secpk = 0
    for s in servers:
        chk = checks.get(s.id)
        if chk is None:
            continue
        if chk.status == "error":
            err += 1
        elif (chk.packages_available or 0) == 0:
            up += 1
        else:
            ua += 1
            if (chk.security_packages or 0) > 0:
                sec += 1
        if chk.reboot_required:
            reboot += 1
        pend += (chk.packages_available or 0)
        secpk += (chk.security_packages or 0)
    db.add(FleetSnapshot(
        total_servers=len(servers), up_to_date=up, updates_available=ua,
        security_servers=sec, errors=err, reboot_required=reboot,
        pending_packages_total=pend, security_packages_total=secpk,
    ))
    await db.commit()
