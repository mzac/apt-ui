"""
Upgrade execution — runs apt-get upgrade/dist-upgrade over SSH with live WebSocket streaming.

Prerequisites on remote servers:
  - The SSH user must have passwordless sudo configured.
    Example /etc/sudoers.d/apt-dashboard:
      deploy ALL=(ALL) NOPASSWD: /usr/bin/apt-get
"""

import asyncio
import json
import logging
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Server, UpdateHistory
from backend.ssh_manager import run_command, run_command_stream
from backend.update_checker import check_server

logger = logging.getLogger(__name__)

# In-memory lock per server_id to prevent concurrent upgrades on the same host
_upgrade_locks: dict[int, asyncio.Lock] = {}


def _get_lock(server_id: int) -> asyncio.Lock:
    if server_id not in _upgrade_locks:
        _upgrade_locks[server_id] = asyncio.Lock()
    return _upgrade_locks[server_id]


def _build_upgrade_command(action: str, allow_phased: bool) -> str:
    base = f"sudo DEBIAN_FRONTEND=noninteractive apt-get {action} -y"
    if allow_phased:
        base += " -o APT::Get::Always-Include-Phased-Updates=true"
    return base


async def upgrade_server(
    server: Server,
    db: AsyncSession,
    action: str = "upgrade",
    allow_phased: bool = False,
    initiated_by: str = "manual",
    send_fn=None,
) -> UpdateHistory:
    """
    Run apt-get upgrade (or dist-upgrade) on *server*.

    If *send_fn* is provided, streams output over WebSocket in real time.
    Always creates an UpdateHistory record.
    """
    lock = _get_lock(server.id)
    if lock.locked():
        msg = f"An upgrade is already running on {server.name}"
        if send_fn:
            await send_fn({"type": "error", "data": msg})
        # Return a fake history entry to signal the conflict
        history = UpdateHistory(
            server_id=server.id,
            started_at=datetime.utcnow(),
            completed_at=datetime.utcnow(),
            status="error",
            action=action,
            phased_updates=allow_phased,
            log_output=msg,
            initiated_by=initiated_by,
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)
        return history

    async with lock:
        history = UpdateHistory(
            server_id=server.id,
            started_at=datetime.utcnow(),
            status="running",
            action=action,
            phased_updates=allow_phased,
            initiated_by=initiated_by,
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)

        log_chunks: list[str] = []

        async def _send(msg: dict):
            line = msg.get("data", "")
            log_chunks.append(line)
            if send_fn:
                await send_fn(msg)

        try:
            if send_fn:
                await send_fn({"type": "status", "data": "running_update"})

            # Step 1: apt-get update
            update_cmd = "sudo apt-get update -q"
            if send_fn:
                update_result = await run_command_stream(server, update_cmd, _send)
            else:
                update_result = await run_command(server, update_cmd, timeout=120)
                log_chunks.append(update_result.stdout)
                log_chunks.append(update_result.stderr)

            if update_result.exit_code == 255:
                raise RuntimeError(update_result.stderr or "SSH connection failed")

            # Step 2: apt-get upgrade / dist-upgrade
            upgrade_cmd = _build_upgrade_command(action, allow_phased)
            if send_fn:
                await send_fn({"type": "status", "data": "running_upgrade"})
                upgrade_result = await run_command_stream(server, upgrade_cmd, _send, timeout=3600)
            else:
                upgrade_result = await run_command(server, upgrade_cmd, timeout=3600)
                log_chunks.append(upgrade_result.stdout)
                log_chunks.append(upgrade_result.stderr)

            # Check for common error conditions
            combined_output = "".join(log_chunks)
            if "sudo: a password is required" in combined_output:
                raise RuntimeError(
                    "Sudo requires a password. Configure passwordless sudo for this user."
                )
            if "Could not get lock" in combined_output:
                raise RuntimeError(
                    "apt lock is held by another process. Try again later."
                )

            success = upgrade_result.exit_code == 0

            # Parse upgraded package list from output
            packages_upgraded = _parse_upgraded_packages(combined_output)

            history.completed_at = datetime.utcnow()
            history.status = "success" if success else "error"
            history.packages_upgraded = json.dumps(packages_upgraded)
            history.log_output = combined_output[:1_000_000]

            if send_fn:
                await send_fn({
                    "type": "complete",
                    "data": {
                        "success": success,
                        "packages_upgraded": len(packages_upgraded),
                    },
                })

        except Exception as exc:
            error_msg = str(exc)
            history.completed_at = datetime.utcnow()
            history.status = "error"
            history.log_output = ("".join(log_chunks) + f"\n\nError: {error_msg}")[:1_000_000]
            if send_fn:
                await send_fn({"type": "error", "data": error_msg})
            logger.error("Upgrade failed on %s: %s", server.name, error_msg)
        finally:
            await db.commit()
            await db.refresh(history)

        # Re-check updates after upgrade
        try:
            await check_server(server, db)
        except Exception as exc:
            logger.warning("Post-upgrade check failed on %s: %s", server.name, exc)

        # Fire notifications
        try:
            from backend.database import AsyncSessionLocal
            from backend.models import NotificationConfig
            from backend.notifier import notify_upgrade_complete
            from sqlalchemy import select

            async with AsyncSessionLocal() as ndb:
                cfg_res = await ndb.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
                cfg = cfg_res.scalar_one_or_none()
                if cfg:
                    await notify_upgrade_complete(cfg, server, history)
        except Exception as exc:
            logger.warning("Upgrade notification failed: %s", exc)

        return history


async def upgrade_packages_selective(
    server: Server,
    db: AsyncSession,
    packages: list[str],
    allow_phased: bool = False,
    initiated_by: str = "manual",
    send_fn=None,
) -> UpdateHistory:
    """
    Upgrade only the specified *packages* using apt-get install --only-upgrade.
    Uses the same lock, history, and notification machinery as upgrade_server.
    """
    if not packages:
        raise ValueError("No packages specified")

    lock = _get_lock(server.id)
    if lock.locked():
        msg = f"An upgrade is already running on {server.name}"
        if send_fn:
            await send_fn({"type": "error", "data": msg})
        history = UpdateHistory(
            server_id=server.id,
            started_at=datetime.utcnow(),
            completed_at=datetime.utcnow(),
            status="error",
            action="selective",
            phased_updates=allow_phased,
            log_output=msg,
            initiated_by=initiated_by,
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)
        return history

    async with lock:
        history = UpdateHistory(
            server_id=server.id,
            started_at=datetime.utcnow(),
            status="running",
            action="selective",
            phased_updates=allow_phased,
            initiated_by=initiated_by,
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)

        log_chunks: list[str] = []

        async def _send(msg: dict):
            log_chunks.append(msg.get("data", ""))
            if send_fn:
                await send_fn(msg)

        try:
            if send_fn:
                await send_fn({"type": "status", "data": "running_update"})

            update_result = await run_command_stream(server, "sudo apt-get update -q", _send)
            if update_result.exit_code == 255:
                raise RuntimeError(update_result.stderr or "SSH connection failed")

            pkg_list = " ".join(packages)
            cmd = f"sudo DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y {pkg_list}"
            if allow_phased:
                cmd += " -o APT::Get::Always-Include-Phased-Updates=true"

            if send_fn:
                await send_fn({"type": "status", "data": "running_upgrade"})

            upgrade_result = await run_command_stream(server, cmd, _send, timeout=3600)

            combined_output = "".join(log_chunks)
            if "sudo: a password is required" in combined_output:
                raise RuntimeError("Sudo requires a password. Configure passwordless sudo for this user.")
            if "Could not get lock" in combined_output:
                raise RuntimeError("apt lock is held by another process. Try again later.")

            success = upgrade_result.exit_code == 0
            packages_upgraded = _parse_upgraded_packages(combined_output)

            history.completed_at = datetime.utcnow()
            history.status = "success" if success else "error"
            history.packages_upgraded = json.dumps(packages_upgraded)
            history.log_output = combined_output[:1_000_000]

            if send_fn:
                await send_fn({
                    "type": "complete",
                    "data": {"success": success, "packages_upgraded": len(packages_upgraded)},
                })

        except Exception as exc:
            error_msg = str(exc)
            history.completed_at = datetime.utcnow()
            history.status = "error"
            history.log_output = ("".join(log_chunks) + f"\n\nError: {error_msg}")[:1_000_000]
            if send_fn:
                await send_fn({"type": "error", "data": error_msg})
            logger.error("Selective upgrade failed on %s: %s", server.name, error_msg)
        finally:
            await db.commit()
            await db.refresh(history)

        try:
            await check_server(server, db)
        except Exception as exc:
            logger.warning("Post-upgrade check failed on %s: %s", server.name, exc)

        try:
            from backend.database import AsyncSessionLocal
            from backend.models import NotificationConfig
            from backend.notifier import notify_upgrade_complete
            from sqlalchemy import select

            async with AsyncSessionLocal() as ndb:
                cfg_res = await ndb.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
                cfg = cfg_res.scalar_one_or_none()
                if cfg:
                    await notify_upgrade_complete(cfg, server, history)
        except Exception as exc:
            logger.warning("Upgrade notification failed: %s", exc)

        return history


def _parse_upgraded_packages(output: str) -> list[str]:
    """Extract package names from 'The following packages will be upgraded:' section."""
    packages = []
    in_section = False
    for line in output.splitlines():
        if "The following packages will be upgraded:" in line:
            in_section = True
            continue
        if in_section:
            if line.startswith(" ") or line.startswith("  "):
                packages.extend(line.split())
            else:
                in_section = False
    return packages
