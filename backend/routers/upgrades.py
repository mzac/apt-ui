import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, get_current_user_ws
from backend.database import get_db, AsyncSessionLocal
from backend.models import Server, ScheduleConfig, UpdateCheck, User
from backend.schemas import UpgradeRequest
from backend.upgrade_manager import upgrade_server, upgrade_packages_selective

router = APIRouter(tags=["upgrades"])


async def _get_server(server_id: int, db: AsyncSession) -> Server:
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")
    return server


# ---------------------------------------------------------------------------
# REST trigger endpoints (return immediately, upgrade runs in background)
# ---------------------------------------------------------------------------

@router.post("/api/servers/{server_id}/upgrade")
async def start_upgrade(
    server_id: int,
    body: UpgradeRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    server = await _get_server(server_id, db)
    # Fire and forget — client connects via WebSocket for live output
    asyncio.create_task(
        upgrade_server(server, db, action=body.action, allow_phased=body.allow_phased)
    )
    return {"detail": "Upgrade started", "server_id": server_id}


@router.post("/api/servers/upgrade-all")
async def start_upgrade_all(
    body: UpgradeRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    concurrency = cfg.upgrade_concurrency if cfg else 5

    srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = srv_res.scalars().all()

    # Only servers with pending updates
    to_upgrade = []
    for s in servers:
        chk_res = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == s.id)
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        chk = chk_res.scalar_one_or_none()
        if chk and chk.status == "success" and chk.packages_available > 0:
            to_upgrade.append(s)

    semaphore = asyncio.Semaphore(concurrency)

    async def _do(server: Server):
        async with semaphore:
            async with AsyncSessionLocal() as session:
                await upgrade_server(
                    server, session,
                    action=body.action,
                    allow_phased=body.allow_phased,
                )

    asyncio.create_task(asyncio.gather(*[_do(s) for s in to_upgrade]))
    return {"detail": "Upgrade-all started", "servers": [s.id for s in to_upgrade]}


# ---------------------------------------------------------------------------
# WebSocket — single server
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/upgrade/{server_id}")
async def ws_upgrade(websocket: WebSocket, server_id: int):
    await websocket.accept()

    # Auth via cookie
    token = websocket.cookies.get("apt_dashboard_token")
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(token or "", db)
        if user is None:
            await websocket.close(code=1008)
            return

        server = await db.execute(select(Server).where(Server.id == server_id))
        server = server.scalar_one_or_none()
        if server is None:
            await websocket.send_json({"type": "error", "data": "Server not found"})
            await websocket.close()
            return

        # Read upgrade params from first message
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            params = json.loads(raw)
        except Exception:
            params = {}

        action = params.get("action", "upgrade")
        allow_phased = params.get("allow_phased", False)

        await websocket.send_json({"type": "status", "data": "connecting"})

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            await upgrade_server(
                server, db,
                action=action,
                allow_phased=allow_phased,
                send_fn=send_fn,
            )
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            await send_fn({"type": "error", "data": str(exc)})
        finally:
            try:
                await websocket.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# WebSocket — selective upgrade (specific packages)
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/upgrade-selective/{server_id}")
async def ws_upgrade_selective(websocket: WebSocket, server_id: int):
    await websocket.accept()

    token = websocket.cookies.get("apt_dashboard_token")
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(token or "", db)
        if user is None:
            await websocket.close(code=1008)
            return

        server_result = await db.execute(select(Server).where(Server.id == server_id))
        server = server_result.scalar_one_or_none()
        if server is None:
            await websocket.send_json({"type": "error", "data": "Server not found"})
            await websocket.close()
            return

        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            params = json.loads(raw)
        except Exception:
            params = {}

        packages = params.get("packages", [])
        allow_phased = params.get("allow_phased", False)

        if not packages:
            await websocket.send_json({"type": "error", "data": "No packages specified"})
            await websocket.close()
            return

        await websocket.send_json({"type": "status", "data": "connecting"})

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            await upgrade_packages_selective(
                server, db,
                packages=packages,
                allow_phased=allow_phased,
                send_fn=send_fn,
            )
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            await send_fn({"type": "error", "data": str(exc)})
        finally:
            try:
                await websocket.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# WebSocket — upgrade-all (multiplexed)
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/upgrade-all")
async def ws_upgrade_all(websocket: WebSocket):
    await websocket.accept()

    token = websocket.cookies.get("apt_dashboard_token")
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(token or "", db)
        if user is None:
            await websocket.close(code=1008)
            return

        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            params = json.loads(raw)
        except Exception:
            params = {}

        action = params.get("action", "upgrade")
        allow_phased = params.get("allow_phased", False)

        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        concurrency = cfg.upgrade_concurrency if cfg else 5

        srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
        servers = srv_res.scalars().all()

        to_upgrade = []
        for s in servers:
            chk_res = await db.execute(
                select(UpdateCheck)
                .where(UpdateCheck.server_id == s.id)
                .order_by(UpdateCheck.checked_at.desc())
                .limit(1)
            )
            chk = chk_res.scalar_one_or_none()
            if chk and chk.status == "success" and chk.packages_available > 0:
                to_upgrade.append(s)

    semaphore = asyncio.Semaphore(concurrency)

    async def _do(server: Server):
        async with semaphore:
            async with AsyncSessionLocal() as session:
                async def send_fn(msg: dict):
                    msg["server_id"] = server.id
                    msg["server_name"] = server.name
                    try:
                        await websocket.send_json(msg)
                    except Exception:
                        pass

                await upgrade_server(
                    server, session,
                    action=action,
                    allow_phased=allow_phased,
                    send_fn=send_fn,
                )

    try:
        await asyncio.gather(*[_do(s) for s in to_upgrade])
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
