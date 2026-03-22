import asyncio
import json

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, get_current_user_ws
from backend.config import ENABLE_TERMINAL
from backend.database import get_db, AsyncSessionLocal
from backend.models import Server, ScheduleConfig, UpdateCheck, User
from backend.schemas import UpgradeRequest
from backend.ssh_manager import _connect_options
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

    histories: list = []

    async def _do_tracked(server: Server):
        async with semaphore:
            async with AsyncSessionLocal() as session:
                async def send_fn(msg: dict):
                    msg["server_id"] = server.id
                    msg["server_name"] = server.name
                    try:
                        await websocket.send_json(msg)
                    except Exception:
                        pass

                h = await upgrade_server(
                    server, session,
                    action=action,
                    allow_phased=allow_phased,
                    send_fn=send_fn,
                    skip_notify=True,  # suppress per-server emails
                )
                histories.append((server, h))

    try:
        await asyncio.gather(*[_do_tracked(s) for s in to_upgrade])
    except WebSocketDisconnect:
        pass
    finally:
        # Send one summary email/telegram for the whole batch
        try:
            from backend.models import NotificationConfig
            from backend.notifier import notify_upgrade_all_complete
            from sqlalchemy import select as _select
            async with AsyncSessionLocal() as ndb:
                cfg_res = await ndb.execute(_select(NotificationConfig).where(NotificationConfig.id == 1))
                cfg = cfg_res.scalar_one_or_none()
                if cfg and histories:
                    await notify_upgrade_all_complete(cfg, histories)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Upgrade-all notification failed: %s", exc)
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# WebSocket — interactive SSH shell
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/shell/{server_id}")
async def ws_shell(websocket: WebSocket, server_id: int):
    await websocket.accept()

    if not ENABLE_TERMINAL:
        await websocket.send_json({"type": "error", "data": "Terminal access is disabled. Set ENABLE_TERMINAL=true in your environment."})
        await websocket.close(code=1008)
        return

    # Auth via cookie
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

    # Read first message for terminal size
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        size_params = json.loads(raw)
        cols = int(size_params.get("cols", 80))
        rows = int(size_params.get("rows", 24))
    except Exception:
        cols, rows = 80, 24

    try:
        async with asyncssh.connect(**_connect_options(server)) as conn:
            process = await conn.create_process(
                term_type="xterm-256color",
                term_size=(cols, rows),
                encoding=None,
            )

            async def ssh_to_ws():
                """Read chunks from SSH stdout and send to WebSocket."""
                try:
                    while True:
                        data = await process.stdout.read(4096)
                        if not data:
                            break
                        text = data.decode("utf-8", errors="replace")
                        await websocket.send_json({"type": "output", "data": text})
                except Exception:
                    pass

            async def ws_to_ssh():
                """Receive WebSocket messages and forward to SSH stdin."""
                try:
                    while True:
                        raw_msg = await websocket.receive_text()
                        msg = json.loads(raw_msg)
                        if msg.get("type") == "input":
                            process.stdin.write(msg["data"].encode())
                        elif msg.get("type") == "resize":
                            new_cols = int(msg.get("cols", cols))
                            new_rows = int(msg.get("rows", rows))
                            process.change_terminal_size(new_cols, new_rows)
                except WebSocketDisconnect:
                    pass
                except Exception:
                    pass

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(ssh_to_ws()),
                    asyncio.create_task(ws_to_ssh()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            process.close()

    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "data": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# WebSocket — autoremove
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/autoremove/{server_id}")
async def ws_autoremove(websocket: WebSocket, server_id: int):
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

        packages = params.get("packages", None)  # None = all, [] = all too

        await websocket.send_json({"type": "status", "data": "connecting"})

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            from backend.upgrade_manager import run_autoremove
            await run_autoremove(
                server, db,
                packages=packages if packages else None,
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
