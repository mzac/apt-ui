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
