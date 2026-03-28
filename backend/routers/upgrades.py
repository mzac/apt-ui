import asyncio
import io
import ipaddress
import json
import logging
import re
import shlex
import socket
from urllib.parse import urlparse

import asyncssh
import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, get_current_user_ws
from backend.config import ENABLE_TERMINAL
from backend.database import get_db, AsyncSessionLocal
from backend.models import Server, ScheduleConfig, UpdateCheck, User
from backend.schemas import PackageSearchResult, UpgradeRequest
from backend.ssh_manager import _connect_options, run_command
from backend.upgrade_manager import upgrade_server, upgrade_packages_selective

router = APIRouter(tags=["upgrades"])


async def _get_server(server_id: int, db: AsyncSession) -> Server:
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")
    return server


# ---------------------------------------------------------------------------
# Package search
# ---------------------------------------------------------------------------

def _parse_apt_cache_show(output: str) -> dict[str, dict]:
    """Parse apt-cache show output into a dict keyed by package name."""
    packages: dict[str, dict] = {}
    current: dict = {}
    current_name = ""
    for line in output.splitlines():
        if line.startswith("Package: "):
            if current_name:
                packages[current_name] = current
            current_name = line[len("Package: "):].strip()
            current = {"name": current_name}
        elif line.startswith("Version: ") and current_name:
            current["version"] = line[len("Version: "):].strip()
        elif line.startswith("Description: ") and current_name and "description" not in current:
            current["description"] = line[len("Description: "):].strip()
        elif line.startswith("Installed-Size: ") and current_name:
            try:
                current["installed_size"] = int(line[len("Installed-Size: "):].strip()) * 1024
            except ValueError:
                current["installed_size"] = 0
        elif line.startswith("Size: ") and current_name:
            try:
                current["download_size"] = int(line[len("Size: "):].strip())
            except ValueError:
                current["download_size"] = 0
        elif line.startswith("Section: ") and current_name:
            current["section"] = line[len("Section: "):].strip()
    if current_name:
        packages[current_name] = current
    return packages


@router.get("/api/servers/{server_id}/packages/search", response_model=list[PackageSearchResult])
async def search_packages(
    server_id: int,
    q: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    server = await _get_server(server_id, db)

    safe_q = shlex.quote(q)
    # Search package names and get top 20
    search_result = await run_command(
        server,
        f"apt-cache search --names-only {safe_q} 2>/dev/null | head -20 | awk '{{print $1}}'",
        timeout=30,
    )
    pkg_names = [n.strip() for n in search_result.stdout.splitlines() if n.strip()]
    if not pkg_names:
        return []

    # Get details for all matched packages at once
    pkg_list = " ".join(shlex.quote(p) for p in pkg_names[:20])
    show_result = await run_command(
        server,
        f"apt-cache show {pkg_list} 2>/dev/null",
        timeout=30,
    )
    details = _parse_apt_cache_show(show_result.stdout)

    # Check which are installed
    dpkg_result = await run_command(
        server,
        f"dpkg -l {pkg_list} 2>/dev/null | awk '/^ii/{{print $2}}'",
        timeout=30,
    )
    installed_set = set(dpkg_result.stdout.split())

    results = []
    for name in pkg_names:
        d = details.get(name, {})
        results.append(PackageSearchResult(
            name=name,
            description=d.get("description", ""),
            installed_size=d.get("installed_size", 0),
            download_size=d.get("download_size", 0),
            version=d.get("version", ""),
            section=d.get("section", ""),
            is_installed=name in installed_set,
        ))
    return results


# ---------------------------------------------------------------------------
# WebSocket — package install
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/install/{server_id}")
async def ws_install(websocket: WebSocket, server_id: int):
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

        packages: list[str] = params.get("packages", [])
        if not packages:
            await websocket.send_json({"type": "error", "data": "No packages specified"})
            await websocket.close()
            return

        # Sanitise package names
        safe_packages = [p for p in packages if re.match(r'^[a-zA-Z0-9][a-zA-Z0-9.+\-]*$', p)]
        if not safe_packages:
            await websocket.send_json({"type": "error", "data": "No valid package names"})
            await websocket.close()
            return

        await websocket.send_json({"type": "status", "data": "connecting"})

        sudo = "" if server.username == "root" else "sudo "
        pkg_str = " ".join(safe_packages)
        cmd = f"{sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y {pkg_str}"

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            from backend.ssh_manager import run_command_stream
            await send_fn({"type": "status", "data": "running_install"})
            result = await run_command_stream(server, cmd, send_fn)
            success = result.exit_code == 0
            await send_fn({"type": "complete", "data": {"success": success, "packages": safe_packages}})

            # Trigger a background check to refresh state
            from backend.update_checker import check_server
            from backend.database import AsyncSessionLocal as ASL

            async def _bg():
                async with ASL() as bg_db:
                    from sqlalchemy import select as _sel
                    srv = (await bg_db.execute(_sel(Server).where(Server.id == server_id))).scalar_one_or_none()
                    if srv:
                        await check_server(srv, bg_db)

            asyncio.create_task(_bg())
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
# WebSocket — auto security updates (enable / disable unattended-upgrades)
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/auto-security-updates/{server_id}")
async def ws_auto_security_updates(websocket: WebSocket, server_id: int):
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

        enable: bool = params.get("enable", True)
        sudo = "" if server.username == "root" else "sudo "

        if enable:
            cmd = (
                f"DEBIAN_FRONTEND=noninteractive {sudo}apt-get install -y unattended-upgrades; "
                f"printf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"1\";\\n' "
                f"| {sudo}tee /etc/apt/apt.conf.d/20auto-upgrades"
            )
        else:
            cmd = (
                f"printf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"0\";\\n' "
                f"| {sudo}tee /etc/apt/apt.conf.d/20auto-upgrades"
            )

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            from backend.ssh_manager import run_command_stream
            await send_fn({"type": "status", "data": "connecting"})
            result = await run_command_stream(server, cmd, send_fn)
            success = result.exit_code == 0
            new_val = "enabled" if enable else "disabled"

            if success:
                # Persist the new state to the latest stats row
                from backend.models import ServerStats
                from sqlalchemy import select as _sel
                stats_res = await db.execute(
                    _sel(ServerStats)
                    .where(ServerStats.server_id == server_id)
                    .order_by(ServerStats.recorded_at.desc())
                    .limit(1)
                )
                stats_row = stats_res.scalar_one_or_none()
                if stats_row:
                    stats_row.auto_security_updates = new_val
                    await db.commit()

            await send_fn({"type": "complete", "data": {"success": success, "auto_security_updates": new_val if success else None}})
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
# EEPROM firmware update (Raspberry Pi 4 / Pi 400 / CM4 / Pi 5)
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/eeprom-update/{server_id}")
async def ws_eeprom_update(websocket: WebSocket, server_id: int):
    """Stage an EEPROM firmware update via `rpi-eeprom-update -a`.
    The update is applied on next reboot — no immediate system change.
    """
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

        sudo = "" if server.username == "root" else "sudo "
        cmd = f"{sudo}rpi-eeprom-update -a"

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            from backend.ssh_manager import run_command_stream
            await send_fn({"type": "status", "data": "connecting"})
            result = await run_command_stream(server, cmd, send_fn)
            success = result.exit_code == 0

            if success:
                # Mark the update as staged in the latest stats row.
                # The EEPROM is not actually updated until the Pi reboots.
                from backend.models import ServerStats
                from sqlalchemy import select as _sel
                stats_res = await db.execute(
                    _sel(ServerStats)
                    .where(ServerStats.server_id == server_id)
                    .order_by(ServerStats.recorded_at.desc())
                    .limit(1)
                )
                stats_row = stats_res.scalar_one_or_none()
                if stats_row:
                    stats_row.eeprom_update_available = "update_staged"
                    await db.commit()

            await send_fn({"type": "complete", "data": {"success": success}})
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
# Dry-run preview — shows what would be upgraded without actually upgrading
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/dry-run/{server_id}")
async def ws_dry_run(websocket: WebSocket, server_id: int):
    """Run apt-get upgrade/dist-upgrade --dry-run and stream the output."""
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
        params = await websocket.receive_json()
    except Exception:
        await websocket.close()
        return

    action = params.get("action", "upgrade")
    if action not in ("upgrade", "dist-upgrade"):
        action = "upgrade"

    allow_phased = params.get("allow_phased", False)
    phased_flag = " -o APT::Get::Always-Include-Phased-Updates=true" if allow_phased else ""
    sudo = "" if server.username == "root" else "sudo "
    cmd = f"DEBIAN_FRONTEND=noninteractive {sudo}apt-get {action} --dry-run{phased_flag} 2>&1"

    async def send_fn(msg: dict):
        try:
            await websocket.send_json(msg)
        except Exception:
            pass

    try:
        from backend.ssh_manager import run_command_stream
        await send_fn({"type": "status", "data": "running_dry_run"})
        result = await run_command_stream(server, cmd, send_fn)
        await send_fn({"type": "complete", "data": {"success": result.exit_code == 0}})
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
    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    run_apt_update = cfg.run_apt_update_before_upgrade if cfg else False
    # Fire and forget — client connects via WebSocket for live output
    asyncio.create_task(
        upgrade_server(server, db, action=body.action, allow_phased=body.allow_phased,
                       conffile_action=body.conffile_action, run_apt_update=run_apt_update)
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
    run_apt_update = cfg.run_apt_update_before_upgrade if cfg else False

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
                    conffile_action=body.conffile_action,
                    run_apt_update=run_apt_update,
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
        conffile_action = params.get("conffile_action", "confdef_confold")

        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        run_apt_update = cfg.run_apt_update_before_upgrade if cfg else False

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
                conffile_action=conffile_action,
                send_fn=send_fn,
                run_apt_update=run_apt_update,
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

        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        run_apt_update = cfg.run_apt_update_before_upgrade if cfg else False

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
                run_apt_update=run_apt_update,
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
        conffile_action = params.get("conffile_action", "confdef_confold")

        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        concurrency = cfg.upgrade_concurrency if cfg else 5
        run_apt_update = cfg.run_apt_update_before_upgrade if cfg else False

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
                    conffile_action=conffile_action,
                    send_fn=send_fn,
                    run_apt_update=run_apt_update,
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
                    conffile_action=conffile_action,
                    send_fn=send_fn,
                    skip_notify=True,  # suppress per-server emails
                    run_apt_update=run_apt_update,
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
# WebSocket — template apply
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/template-apply/{template_id}")
async def ws_template_apply(websocket: WebSocket, template_id: int):
    await websocket.accept()

    token = websocket.cookies.get("apt_dashboard_token")
    async with AsyncSessionLocal() as db:
        user = await get_current_user_ws(token or "", db)
        if user is None:
            await websocket.close(code=1008)
            return

        from backend.models import Template, TemplatePackage
        template_result = await db.execute(select(Template).where(Template.id == template_id))
        template = template_result.scalar_one_or_none()
        if template is None:
            await websocket.send_json({"type": "error", "data": "Template not found"})
            await websocket.close()
            return

        await db.refresh(template, ["packages"])

        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            params = json.loads(raw)
        except Exception:
            params = {}

        server_ids: list[int] = params.get("server_ids", [])
        if not server_ids:
            await websocket.send_json({"type": "error", "data": "No servers specified"})
            await websocket.close()
            return

        pkg_names = [p.package_name for p in template.packages]
        if not pkg_names:
            await websocket.send_json({"type": "error", "data": "Template has no packages"})
            await websocket.close()
            return

        servers_result = await db.execute(
            select(Server).where(Server.id.in_(server_ids), Server.is_enabled == True)
        )
        servers = servers_result.scalars().all()

    pkg_str = " ".join(pkg_names)

    async def _apply_to_server(server: Server):
        sudo = "" if server.username == "root" else "sudo "
        cmd = f"{sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y {pkg_str}"

        async def send_fn(msg: dict):
            msg["server_id"] = server.id
            msg["server_name"] = server.name
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            from backend.ssh_manager import run_command_stream as _stream
            await send_fn({"type": "status", "data": "connecting"})
            result = await _stream(server, cmd, send_fn)
            success = result.exit_code == 0
            await send_fn({"type": "complete", "data": {"success": success, "packages": pkg_names}})
        except Exception as exc:
            await send_fn({"type": "error", "data": str(exc)})

    try:
        await asyncio.gather(*[_apply_to_server(s) for s in servers])
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# WebSocket — autoremove
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/apt-update/{server_id}")
async def ws_apt_update(websocket: WebSocket, server_id: int):
    """Run `sudo apt-get update` on the server and stream the output."""
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

        await websocket.send_json({"type": "status", "data": "connecting"})

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        try:
            conn_opts = _connect_options(server)
            async with asyncssh.connect(**conn_opts) as conn:
                await send_fn({"type": "status", "data": "running"})
                async with conn.create_process(
                    "sudo DEBIAN_FRONTEND=noninteractive apt-get update",
                    stderr=asyncssh.STDOUT,
                ) as proc:
                    async for line in proc.stdout:
                        await send_fn({"type": "output", "data": line})
                await send_fn({"type": "complete", "data": {"success": True}})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            await send_fn({"type": "error", "data": str(exc)})
        finally:
            try:
                await websocket.close()
            except Exception:
                pass


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


# ---------------------------------------------------------------------------
# .deb file installation — URL validation
# ---------------------------------------------------------------------------

class DebUrlRequest(BaseModel):
    url: str


@router.post("/api/servers/{server_id}/validate-deb-url")
async def validate_deb_url(
    server_id: int,
    body: DebUrlRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """HEAD-request the URL from the dashboard container to validate it is a .deb file."""
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        return {"valid": False, "error": "URL must start with http:// or https://"}

    # SSRF protection: resolve the hostname and block private/loopback/link-local ranges
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return {"valid": False, "error": "Invalid URL: could not parse hostname"}
        resolved_ip = socket.gethostbyname(hostname)
        ip_obj = ipaddress.ip_address(resolved_ip)
        if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved:
            return {"valid": False, "error": "URL hostname resolves to a private or reserved address"}
    except socket.gaierror:
        return {"valid": False, "error": "URL hostname could not be resolved"}
    except Exception:
        return {"valid": False, "error": "Invalid URL"}

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
            resp = await client.head(url)
    except httpx.TimeoutException:
        return {"valid": False, "error": "Request timed out"}
    except httpx.RequestError:
        return {"valid": False, "error": "Request failed: could not connect to host"}
    except Exception:
        logging.getLogger(__name__).exception("Unexpected error validating deb URL")
        return {"valid": False, "error": "Request failed"}

    if resp.status_code != 200:
        return {"valid": False, "error": f"Server returned HTTP {resp.status_code}"}

    content_type = resp.headers.get("content-type", "")
    is_deb = (
        "debian" in content_type
        or "octet-stream" in content_type
        or url.lower().split("?")[0].endswith(".deb")
    )
    if not is_deb:
        return {"valid": False, "error": f"URL does not appear to be a .deb file (Content-Type: {content_type})"}

    filename = url.split("/")[-1].split("?")[0] or "package.deb"
    filename = re.sub(r"[^a-zA-Z0-9._\-+]", "_", filename)
    if not filename.endswith(".deb"):
        filename += ".deb"

    content_length = resp.headers.get("content-length")
    return {
        "valid": True,
        "filename": filename,
        "content_length": int(content_length) if content_length else None,
    }


# ---------------------------------------------------------------------------
# .deb file installation — file upload (SCP to remote /tmp/)
# ---------------------------------------------------------------------------

@router.post("/api/servers/{server_id}/upload-deb")
async def upload_deb(
    server_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Receive a .deb file and copy it to /tmp/ on the target server via SFTP."""
    server = await _get_server(server_id, db)

    if not (file.filename or "").lower().endswith(".deb"):
        raise HTTPException(status_code=400, detail="File must be a .deb package")

    contents = await file.read()
    if len(contents) > 500 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 500 MB)")

    safe_name = re.sub(r"[^a-zA-Z0-9._\-+]", "_", file.filename or "package.deb")
    if not safe_name.endswith(".deb"):
        safe_name += ".deb"
    remote_path = f"/tmp/{safe_name}"

    try:
        async with asyncssh.connect(**_connect_options(server)) as conn:
            async with conn.start_sftp_client() as sftp:
                await sftp.putfo(io.BytesIO(contents), remote_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SFTP upload failed: {exc}")

    return {"remote_path": remote_path, "filename": safe_name, "size": len(contents)}


# ---------------------------------------------------------------------------
# .deb file installation — WebSocket (download URL or install pre-uploaded)
# ---------------------------------------------------------------------------

@router.websocket("/api/ws/install-deb/{server_id}")
async def ws_install_deb(websocket: WebSocket, server_id: int):
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

        async def send_fn(msg: dict):
            try:
                await websocket.send_json(msg)
            except Exception:
                pass

        source = params.get("source", "url")  # "url" | "remote"
        sudo = "" if server.username == "root" else "sudo "

        try:
            if source == "url":
                url = params.get("url", "").strip()
                if not url.lower().startswith(("http://", "https://")):
                    await send_fn({"type": "error", "data": "Invalid URL"})
                    await websocket.close()
                    return

                filename = url.split("/")[-1].split("?")[0] or "package.deb"
                filename = re.sub(r"[^a-zA-Z0-9._\-+]", "_", filename)
                if not filename.endswith(".deb"):
                    filename += ".deb"
                remote_path = shlex.quote(f"/tmp/{filename}")

                await send_fn({"type": "status", "data": "downloading"})
                dl_cmd = f"wget -O {remote_path} {shlex.quote(url)}"
                dl_result = await run_command_stream(server, dl_cmd, send_fn, timeout=300)
                if dl_result.exit_code != 0:
                    await send_fn({"type": "complete", "data": {"success": False, "error": "Download failed"}})
                    return

            elif source == "remote":
                path = params.get("path", "")
                if not re.match(r"^/tmp/[a-zA-Z0-9._\-+]+\.deb$", path):
                    await send_fn({"type": "error", "data": "Invalid remote path"})
                    await websocket.close()
                    return
                remote_path = shlex.quote(path)

            else:
                await send_fn({"type": "error", "data": "Invalid source"})
                await websocket.close()
                return

            # Install with dpkg
            await send_fn({"type": "status", "data": "installing"})
            install_cmd = f"{sudo}DEBIAN_FRONTEND=noninteractive dpkg -i {remote_path}"
            await run_command_stream(server, install_cmd, send_fn, timeout=300)

            # Fix any missing dependencies
            await send_fn({"type": "status", "data": "fixing_deps"})
            fix_cmd = f"{sudo}DEBIAN_FRONTEND=noninteractive apt-get install -f -y"
            fix_result = await run_command_stream(server, fix_cmd, send_fn, timeout=300)

            # Clean up temp file
            await run_command(server, f"rm -f {remote_path}", timeout=10)

            success = fix_result.exit_code == 0
            await send_fn({"type": "complete", "data": {"success": success}})

            if success:
                from backend.update_checker import check_server
                from backend.database import AsyncSessionLocal as ASL

                async def _bg():
                    async with ASL() as bg_db:
                        from sqlalchemy import select as _sel
                        srv = (await bg_db.execute(_sel(Server).where(Server.id == server_id))).scalar_one_or_none()
                        if srv:
                            await check_server(srv, bg_db)

                asyncio.create_task(_bg())

        except WebSocketDisconnect:
            pass
        except Exception as exc:
            await send_fn({"type": "error", "data": str(exc)})
        finally:
            try:
                await websocket.close()
            except Exception:
                pass
