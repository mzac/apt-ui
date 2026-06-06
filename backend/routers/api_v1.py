"""Stable inbound automation API (issue #62).

Versioned, scoped REST surface over the operations that were previously WebSocket-only.
Auth is the existing API-token system; each endpoint requires a token scope
(read/check/upgrade). Long-running upgrades are accepted and run in the background —
poll History for the result (a pollable job_id arrives with the durable job queue).
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.actor import set_actor
from backend.auth import require_scope
from backend.database import get_db, AsyncSessionLocal
from backend.models import Server, User
from backend.query_helpers import latest_checks_by_server

router = APIRouter(prefix="/api/v1", tags=["api-v1"])


@router.get("/servers")
async def v1_list_servers(db: AsyncSession = Depends(get_db), _: User = Depends(require_scope("read"))):
    servers = (await db.execute(select(Server))).scalars().all()
    checks = await latest_checks_by_server(db)
    out = []
    for s in servers:
        c = checks.get(s.id)
        out.append({
            "id": s.id, "name": s.name, "hostname": s.hostname, "enabled": s.is_enabled,
            "reachable": s.is_reachable,
            "status": c.status if c else None,
            "packages_available": c.packages_available if c else None,
            "security_packages": c.security_packages if c else None,
            "reboot_required": bool(c.reboot_required) if c else None,
            "last_check": c.checked_at.isoformat() if c and c.checked_at else None,
        })
    return {"servers": out}


@router.get("/overview")
async def v1_overview(db: AsyncSession = Depends(get_db), _: User = Depends(require_scope("read"))):
    servers = (await db.execute(select(Server))).scalars().all()
    checks = await latest_checks_by_server(db)
    agg = {"total": len(servers), "up_to_date": 0, "updates_available": 0,
           "security_servers": 0, "errors": 0, "reboot_required": 0}
    for s in servers:
        c = checks.get(s.id)
        if c is None:
            continue
        if c.status == "error":
            agg["errors"] += 1
        elif (c.packages_available or 0) == 0:
            agg["up_to_date"] += 1
        else:
            agg["updates_available"] += 1
            if (c.security_packages or 0) > 0:
                agg["security_servers"] += 1
        if c.reboot_required:
            agg["reboot_required"] += 1
    return agg


@router.post("/servers/{server_id}/check")
async def v1_check(server_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_scope("check"))):
    set_actor(user.username)
    server = (await db.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")
    from backend.update_checker import check_server
    chk = await check_server(server, db)
    return {"status": chk.status, "packages_available": chk.packages_available,
            "security_packages": chk.security_packages, "reboot_required": bool(chk.reboot_required)}


@router.post("/servers/{server_id}/upgrade", status_code=202)
async def v1_upgrade(server_id: int, body: dict | None = None,
                     db: AsyncSession = Depends(get_db), user: User = Depends(require_scope("upgrade"))):
    body = body or {}
    set_actor(user.username)
    server = (await db.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")

    from backend.routers.maintenance import window_block_reason
    block = await window_block_reason(db, server_id, override=bool(body.get("override_window")) and user.is_admin)
    if block:
        raise HTTPException(status_code=409, detail=f"Upgrade {block}")

    action = body.get("action", "upgrade")
    if action not in ("upgrade", "dist-upgrade"):
        raise HTTPException(status_code=400, detail="action must be 'upgrade' or 'dist-upgrade'")
    allow_phased = bool(body.get("allow_phased", False))
    actor = user.username

    async def _run():
        async with AsyncSessionLocal() as s2:
            srv = (await s2.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
            if srv is None:
                return
            set_actor(actor)
            from backend.upgrade_manager import upgrade_server
            try:
                await upgrade_server(srv, s2, action=action, allow_phased=allow_phased)
            except Exception:
                pass

    asyncio.create_task(_run())
    return {"accepted": True, "detail": "Upgrade started; poll /api/v1/servers or History for the result."}
