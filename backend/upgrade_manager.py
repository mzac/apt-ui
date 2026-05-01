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
import re
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from backend.models import Server, UpdateCheck, UpdateHistory
from backend.ssh_manager import run_command, run_command_stream
from backend.update_checker import check_server

logger = logging.getLogger(__name__)

# In-memory lock per server_id to prevent concurrent upgrades on the same host
_upgrade_locks: dict[int, asyncio.Lock] = {}
# Tracks server IDs with an upgrade in progress for fail-fast detection.
# Using a set alongside the lock avoids the check-then-acquire race where two
# requests could both see lock.locked()==False and queue serially.
_upgrade_running: set[int] = set()


def _get_lock(server_id: int) -> asyncio.Lock:
    return _upgrade_locks.setdefault(server_id, asyncio.Lock())


# Debian/Ubuntu package names must start with an alphanumeric and contain only
# lowercase letters, digits, and `.+-`. Anchored to prevent shell metacharacters.
_PACKAGE_NAME_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9.+\-]*$')


async def _load_hooks(server_id: int, phase: str, db: AsyncSession):
    """Return enabled hooks (global + per-server) for *phase*, ordered by sort_order.

    Issue #29 — global hooks (server_id=NULL) run on every server; per-server
    hooks add to that. They run sequentially in sort_order, with global hooks
    interleaved by sort_order.
    """
    from backend.models import UpgradeHook
    res = await db.execute(
        select(UpgradeHook).where(
            UpgradeHook.enabled == True,
            UpgradeHook.phase == phase,
            (UpgradeHook.server_id == server_id) | (UpgradeHook.server_id.is_(None)),
        ).order_by(UpgradeHook.sort_order, UpgradeHook.id)
    )
    return list(res.scalars().all())


def _validate_package_names(packages: list[str]) -> list[str]:
    """Return *packages* unchanged if all names are valid; raise ValueError otherwise.

    Used to guard against shell injection when package names are interpolated
    into apt-get commands. Invalid names include any with shell metacharacters
    (spaces, semicolons, quotes, etc.).
    """
    invalid = [p for p in packages if not _PACKAGE_NAME_RE.match(p or "")]
    if invalid:
        raise ValueError(f"Invalid package name(s): {', '.join(invalid[:5])}")
    return packages


def _sudo(server) -> str:
    """Return 'sudo ' prefix unless the SSH user is root."""
    return "" if server.username == "root" else "sudo "


_CONFFILE_OPTS = {
    # Use the package's declared default answer; fall back to keeping the existing
    # file if there is no default. This is the safest choice for production servers.
    "confdef_confold": '-o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"',
    # Always keep the locally-installed config file, even if the package ships a newer one.
    "confold": '-o Dpkg::Options::="--force-confold"',
    # Always take the new config file from the package, overwriting local changes.
    "confnew": '-o Dpkg::Options::="--force-confnew"',
}


def _build_upgrade_command(server, action: str, allow_phased: bool, conffile_action: str = "confdef_confold") -> str:
    dpkg_opts = _CONFFILE_OPTS.get(conffile_action, _CONFFILE_OPTS["confdef_confold"])
    base = f"{_sudo(server)}DEBIAN_FRONTEND=noninteractive apt-get {action} -y {dpkg_opts}"
    if allow_phased:
        base += " -o APT::Get::Always-Include-Phased-Updates=true"
    return base


async def upgrade_server(
    server: Server,
    db: AsyncSession,
    action: str = "upgrade",
    allow_phased: bool = False,
    conffile_action: str = "confdef_confold",
    initiated_by: str = "manual",
    send_fn=None,
    skip_notify: bool = False,
    run_apt_update: bool = False,
    reboot_if_required: bool = False,
) -> UpdateHistory:
    """
    Run apt-get upgrade (or dist-upgrade) on *server*.

    If *send_fn* is provided, streams output over WebSocket in real time.
    Always creates an UpdateHistory record.
    """
    lock = _get_lock(server.id)
    # Fail fast (atomic in single-threaded asyncio: no await between check and add)
    if server.id in _upgrade_running:
        msg = f"An upgrade is already running on {server.name}"
        if send_fn:
            await send_fn({"type": "error", "data": msg})
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
    _upgrade_running.add(server.id)

    try:
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
                # Step 0: pre-upgrade hooks (issue #29)
                pre_hooks = await _load_hooks(server.id, "pre", db)
                if pre_hooks:
                    for hook in pre_hooks:
                        if send_fn:
                            await send_fn({"type": "output", "data": f"\n→ pre-hook: {hook.name}\n"})
                        hr = await run_command_stream(server, hook.command, _send, timeout=600)
                        if hr.exit_code != 0:
                            raise RuntimeError(f"Pre-hook '{hook.name}' failed (exit {hr.exit_code}); aborting upgrade")

                # Step 1: apt-get update (optional, controlled by preferences)
                if run_apt_update:
                    if send_fn:
                        await send_fn({"type": "status", "data": "running_update"})
                    update_cmd = f"{_sudo(server)}apt-get update -q"
                    if send_fn:
                        update_result = await run_command_stream(server, update_cmd, _send)
                    else:
                        update_result = await run_command(server, update_cmd, timeout=120)
                        log_chunks.append(update_result.stdout)
                        log_chunks.append(update_result.stderr)
                    if update_result.exit_code == 255:
                        raise RuntimeError(update_result.stderr or "SSH connection failed")

                # Step 2: apt-get upgrade / dist-upgrade
                upgrade_cmd = _build_upgrade_command(server, action, allow_phased, conffile_action)
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

                # Parse upgraded package list from output and enrich with version info
                pkg_names = _parse_upgraded_packages(combined_output)
                packages_upgraded = await _enrich_packages_with_versions(pkg_names, server.id, db)

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
                # Post-upgrade hooks always run, success or failure (issue #29)
                try:
                    post_hooks = await _load_hooks(server.id, "post", db)
                    for hook in post_hooks:
                        if send_fn:
                            await send_fn({"type": "output", "data": f"\n→ post-hook: {hook.name}\n"})
                        try:
                            await run_command_stream(server, hook.command, _send, timeout=600)
                        except Exception as hexc:
                            logger.warning("Post-hook '%s' on %s raised: %s", hook.name, server.name, hexc)
                            if send_fn:
                                await send_fn({"type": "output", "data": f"  (post-hook error: {hexc})\n"})
                except Exception as exc:
                    logger.warning("Loading post-hooks failed on %s: %s", server.name, exc)
                history.log_output = "".join(log_chunks)[:1_000_000]
                await db.commit()
                await db.refresh(history)

            # Auto-reboot if requested AND upgrade succeeded AND reboot is required
            rebooted = False
            if reboot_if_required and history.status == "success":
                try:
                    rb_check = await run_command(
                        server,
                        "test -f /var/run/reboot-required && echo yes || echo no",
                        timeout=10,
                    )
                    if rb_check.stdout.strip() == "yes":
                        if send_fn:
                            await send_fn({"type": "status", "data": "rebooting"})
                        # Schedule reboot in 1 minute so the SSH command can return cleanly
                        await run_command(
                            server,
                            f"{_sudo(server)}shutdown -r +1 'apt-ui auto-reboot after upgrade'",
                            timeout=10,
                        )
                        rebooted = True
                        # Schedule the post-reboot check job
                        try:
                            from backend.scheduler import schedule_reboot_check
                            schedule_reboot_check(server.id, delay_seconds=120)
                        except Exception as exc:
                            logger.warning("Could not schedule post-reboot check for %s: %s", server.name, exc)
                        if send_fn:
                            await send_fn({
                                "type": "output",
                                "data": "\n→ Server is rebooting (apt-ui auto-reboot). Re-check will run automatically.\n",
                            })
                except Exception as exc:
                    logger.warning("Auto-reboot failed on %s: %s", server.name, exc)

            # Re-check updates after upgrade — skip if we rebooted, the scheduled check handles it
            if not rebooted:
                try:
                    await check_server(server, db)
                except Exception as exc:
                    logger.warning("Post-upgrade check failed on %s: %s", server.name, exc)

            # Fire notifications (suppressed when called from upgrade-all batch)
            if not skip_notify:
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
    finally:
        _upgrade_running.discard(server.id)


async def upgrade_packages_selective(
    server: Server,
    db: AsyncSession,
    packages: list[str],
    allow_phased: bool = False,
    initiated_by: str = "manual",
    send_fn=None,
    run_apt_update: bool = False,
) -> UpdateHistory:
    """
    Upgrade only the specified *packages* using apt-get install --only-upgrade.
    Uses the same lock, history, and notification machinery as upgrade_server.
    """
    if not packages:
        raise ValueError("No packages specified")
    # Validate package names to prevent shell injection (CWE-78)
    _validate_package_names(packages)

    lock = _get_lock(server.id)
    if server.id in _upgrade_running:
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
    _upgrade_running.add(server.id)

    try:
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
                if run_apt_update:
                    if send_fn:
                        await send_fn({"type": "status", "data": "running_update"})
                    update_result = await run_command_stream(server, f"{_sudo(server)}apt-get update -q", _send)
                    if update_result.exit_code == 255:
                        raise RuntimeError(update_result.stderr or "SSH connection failed")

                pkg_list = " ".join(packages)
                cmd = f"{_sudo(server)}DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y {pkg_list}"
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
                pkg_names = _parse_upgraded_packages(combined_output)
                packages_upgraded = await _enrich_packages_with_versions(pkg_names, server.id, db)

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
    finally:
        _upgrade_running.discard(server.id)


async def run_autoremove(
    server: Server,
    db: AsyncSession,
    packages: list[str] | None = None,
    initiated_by: str = "manual",
    send_fn=None,
) -> UpdateHistory:
    """
    Run apt-get autoremove (all) or apt-get remove (specific packages).
    Uses the same lock and history machinery as upgrade_server.
    packages=None means remove all autoremovable packages.
    """
    # Validate package names to prevent shell injection (CWE-78)
    if packages:
        _validate_package_names(packages)

    lock = _get_lock(server.id)
    if server.id in _upgrade_running:
        msg = f"An upgrade is already running on {server.name}"
        if send_fn:
            await send_fn({"type": "error", "data": msg})
        history = UpdateHistory(
            server_id=server.id,
            started_at=datetime.utcnow(),
            completed_at=datetime.utcnow(),
            status="error",
            action="autoremove",
            phased_updates=False,
            log_output=msg,
            initiated_by=initiated_by,
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)
        return history
    _upgrade_running.add(server.id)

    try:
        async with lock:
            history = UpdateHistory(
                server_id=server.id,
                started_at=datetime.utcnow(),
                status="running",
                action="autoremove",
                phased_updates=False,
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
                    await send_fn({"type": "status", "data": "running_autoremove"})

                if packages:
                    pkg_list = " ".join(packages)
                    cmd = f"{_sudo(server)}DEBIAN_FRONTEND=noninteractive apt-get remove -y {pkg_list}"
                else:
                    cmd = f"{_sudo(server)}DEBIAN_FRONTEND=noninteractive apt-get autoremove -y"

                result = await run_command_stream(server, cmd, _send, timeout=600)

                combined = "".join(log_chunks)
                if "sudo: a password is required" in combined:
                    raise RuntimeError("Sudo requires a password. Configure passwordless sudo for this user.")
                if "Could not get lock" in combined:
                    raise RuntimeError("apt lock is held by another process. Try again later.")

                success = result.exit_code == 0
                history.completed_at = datetime.utcnow()
                history.status = "success" if success else "error"
                history.log_output = combined[:1_000_000]

                if send_fn:
                    await send_fn({"type": "complete", "data": {"success": success}})

            except Exception as exc:
                error_msg = str(exc)
                history.completed_at = datetime.utcnow()
                history.status = "error"
                history.log_output = ("".join(log_chunks) + f"\n\nError: {error_msg}")[:1_000_000]
                if send_fn:
                    await send_fn({"type": "error", "data": error_msg})
                logger.error("Autoremove failed on %s: %s", server.name, error_msg)
            finally:
                await db.commit()
                await db.refresh(history)

            try:
                await check_server(server, db)
            except Exception as exc:
                logger.warning("Post-autoremove check failed on %s: %s", server.name, exc)

            return history
    finally:
        _upgrade_running.discard(server.id)


def _parse_upgraded_packages(output: str) -> list[str]:
    """Extract package names from 'The following packages will be upgraded:' section."""
    packages = []
    in_section = False
    for line in output.splitlines():
        if "The following packages will be upgraded:" in line:
            in_section = True
            continue
        if in_section:
            if line.startswith(" "):
                packages.extend(line.split())
            else:
                in_section = False
    return packages


async def _enrich_packages_with_versions(
    names: list[str], server_id: int, db: AsyncSession
) -> list[dict]:
    """
    Look up version info from the latest successful UpdateCheck and return
    a list of dicts with name/from_version/to_version for each upgraded package.
    Falls back to name-only entries when version data is unavailable.
    """
    version_map: dict[str, dict] = {}
    try:
        result = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == server_id, UpdateCheck.status == "success")
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        last_check = result.scalar_one_or_none()
        if last_check and last_check.packages_json:
            for p in json.loads(last_check.packages_json):
                version_map[p["name"]] = {
                    "from_version": p.get("current_version", ""),
                    "to_version": p.get("available_version", ""),
                }
    except Exception:
        pass

    enriched = []
    for name in names:
        entry: dict = {"name": name}
        if name in version_map:
            entry["from_version"] = version_map[name]["from_version"]
            entry["to_version"] = version_map[name]["to_version"]
        enriched.append(entry)
    return enriched
