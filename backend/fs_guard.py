"""Read-only / overlay root filesystem guard (issue #86).

Every update check records the host's root filesystem mode in
``server_stats.root_fs_mode`` (see the ``root_fs_mode`` probe in
``backend/update_checker.py``):

- ``'ro'``      — ``/`` is mounted read-only. apt/dpkg fail with EROFS, so every
                  upgrade fails and auto-upgrade re-fails (and re-notifies) every run.
- ``'overlay'`` — ``/`` is a RAM-backed overlay (Raspberry Pi OS "Overlay File
                  System", Ubuntu ``overlayroot``). Writes *succeed*, so an upgrade
                  reports success, and the next reboot silently reverts every package.
- ``'rw'``      — normal.

Package-changing actions go through :func:`root_fs_block_reason`, which returns a
human-readable reason fragment (same shape as
``backend.routers.maintenance.window_block_reason``: callers render it as
``f"Upgrade {reason}"``) or ``None`` when the action may proceed.

``Server.allow_readonly_root`` lets an admin opt a ``'ro'`` host back in when they
remount it read-write themselves (e.g. pre/post-upgrade hooks running
``mount -o remount,rw /``). It deliberately does **not** unblock ``'overlay'``:
no hook can make writes to a tmpfs upper layer survive a reboot, so allowing it
would only bring back the false-success problem.

The decision uses the mode recorded by the most recent check rather than probing
live, like the other pre-flight gates (pending-update counts, EEPROM status).
An unknown mode (never checked, or the probe failed) is allowed.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Server, ServerStats

OVERLAY_REASON = (
    "blocked: the root filesystem is a RAM-backed overlay (e.g. the Raspberry Pi "
    "overlay file system), so package changes would be discarded at the next reboot. "
    "Disable the overlay, reboot, upgrade, then re-enable it"
)
READONLY_REASON = (
    "blocked: the root filesystem is mounted read-only. Remount it read-write "
    "(e.g. with pre/post-upgrade hooks) and enable 'Allow read-only root' for this server"
)


def block_reason_for_mode(mode: str | None, allow_readonly_root: bool = False) -> str | None:
    """Pure decision: reason fragment for *mode*, or None if package changes may proceed."""
    if mode == "overlay":
        return OVERLAY_REASON
    if mode == "ro" and not allow_readonly_root:
        return READONLY_REASON
    return None


async def latest_root_fs_mode(db: AsyncSession, server_id: int) -> str | None:
    res = await db.execute(
        select(ServerStats.root_fs_mode)
        .where(ServerStats.server_id == server_id)
        .order_by(ServerStats.recorded_at.desc())
        .limit(1)
    )
    return res.scalar_one_or_none()


async def root_fs_block_reason(db: AsyncSession, server: Server) -> str | None:
    """Reason fragment if package changes on *server* must be refused, else None."""
    mode = await latest_root_fs_mode(db, server.id)
    return block_reason_for_mode(mode, bool(getattr(server, "allow_readonly_root", False)))
