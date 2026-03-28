import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, User
from backend.ssh_manager import run_command

router = APIRouter(tags=["dpkg_log"])
logger = logging.getLogger(__name__)

KEPT_ACTIONS = {"install", "upgrade", "remove", "purge"}


def _parse_dpkg_log(output: str) -> list[dict]:
    """Parse dpkg.log lines into structured entries, keeping only package-state actions."""
    entries = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        date_str, time_str, action = parts[0], parts[1], parts[2]
        if action not in KEPT_ACTIONS:
            continue

        pkg_arch = parts[3]
        ver_parts = parts[4].split()

        if ":" in pkg_arch:
            package, arch = pkg_arch.rsplit(":", 1)
        else:
            package, arch = pkg_arch, ""

        old_version = ver_parts[0] if len(ver_parts) > 0 else ""
        new_version = ver_parts[1] if len(ver_parts) > 1 else ""
        if old_version == "<none>":
            old_version = ""
        if new_version == "<none>":
            new_version = ""

        try:
            ts = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue

        entries.append({
            "timestamp": ts.isoformat(),
            "action": action,
            "package": package,
            "arch": arch,
            "old_version": old_version,
            "new_version": new_version,
        })
    return entries


@router.get("/api/servers/{server_id}/dpkg-log")
async def get_dpkg_log(
    server_id: int,
    package: str | None = Query(default=None, description="Filter by package name (substring)"),
    action: str | None = Query(default=None, description="Filter by action: install, upgrade, remove, purge"),
    days: int | None = Query(default=None, ge=1, le=3650, description="Limit to last N days"),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    # Read current log + rotated plain log + all compressed rotations
    cmd = (
        "{ "
        "[ -f /var/log/dpkg.log ] && cat /var/log/dpkg.log; "
        "[ -f /var/log/dpkg.log.1 ] && cat /var/log/dpkg.log.1; "
        "ls /var/log/dpkg.log.*.gz 2>/dev/null | sort -t. -k3 -n | xargs -r zcat; "
        "} 2>/dev/null"
    )

    cmd_result = await run_command(server, cmd, timeout=30)
    entries = _parse_dpkg_log(cmd_result.stdout)

    # Sort newest first
    entries.sort(key=lambda e: e["timestamp"], reverse=True)

    # Apply filters
    if package:
        pkg_lower = package.lower()
        entries = [e for e in entries if pkg_lower in e["package"].lower()]

    if action and action in KEPT_ACTIONS:
        entries = [e for e in entries if e["action"] == action]

    if days is not None:
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        entries = [e for e in entries if e["timestamp"] >= cutoff]

    total = len(entries)
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": entries[offset: offset + limit],
    }
