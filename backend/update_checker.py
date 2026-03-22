"""
Update checker — runs apt commands over SSH and stores results.

Apt list --upgradable output format:
  libssl3/jammy-security 3.0.2-0ubuntu1.14 amd64 [upgradable from: 3.0.2-0ubuntu1.12]
  some-pkg/jammy-updates,jammy-security 1.2.3 amd64 [upgradable from: 1.2.2]
  phased-pkg/jammy-updates 1.0 amd64 [upgradable from: 0.9] (50%)
"""

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Server, ServerStats, UpdateCheck
from backend.ssh_manager import run_command

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# Matches: name/repo[,repo...] version arch [upgradable from: old_ver] [(phased%)]
_APT_LINE_RE = re.compile(
    r"^(?P<name>[^/]+)/(?P<repos>\S+)\s+(?P<new_ver>\S+)\s+\S+\s+\[upgradable from:\s+(?P<old_ver>[^\]]+)\]"
    r"(?:\s+\((?P<phased>\d+)%\))?"
)


def _parse_autoremove_packages(output: str) -> list[str]:
    """Extract package names from apt-get --dry-run autoremove output."""
    packages = []
    in_section = False
    for line in output.splitlines():
        if "The following packages will be REMOVED:" in line:
            in_section = True
            continue
        if in_section:
            if line.startswith("  "):
                packages.extend(line.split())
            else:
                in_section = False
    return packages


def _parse_apt_upgradable(output: str) -> list[dict]:
    """Parse `apt list --upgradable` output into a list of package dicts."""
    packages = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("Listing..."):
            continue
        m = _APT_LINE_RE.match(line)
        if not m:
            continue
        repos_raw = m.group("repos")
        repos = repos_raw.split(",")
        is_security = any(
            "-security" in r or "/updates" in r for r in repos
        )
        packages.append({
            "name": m.group("name"),
            "current_version": m.group("old_ver").strip(),
            "available_version": m.group("new_ver"),
            "repository": repos[0],
            "is_security": is_security,
            "is_phased": m.group("phased") is not None,
        })
    return packages


async def _gather_stats(server: Server) -> dict:
    """Gather server stats in parallel: uptime, kernel, disk, packages, apt cache age."""
    commands = {
        "uptime": "cat /proc/uptime",
        "kernel": "uname -r",
        "disk": "df -P / | awk 'NR==2{print $5}'",
        "pkg_count": "dpkg --list 2>/dev/null | grep -c '^ii'",
        "apt_cache": "stat -c %Y /var/cache/apt/pkgcache.bin 2>/dev/null || echo ''",
        "os_info": "lsb_release -ds 2>/dev/null || grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'",
    }
    tasks = {k: run_command(server, v, timeout=30) for k, v in commands.items()}
    results = {k: await t for k, t in tasks.items()}

    uptime_seconds = None
    raw = results["uptime"].stdout.strip()
    if raw:
        try:
            uptime_seconds = int(float(raw.split()[0]))
        except (ValueError, IndexError):
            pass

    kernel_version = results["kernel"].stdout.strip() or None

    disk_usage_percent = None
    raw_disk = results["disk"].stdout.strip().rstrip("%")
    if raw_disk:
        try:
            disk_usage_percent = float(raw_disk)
        except ValueError:
            pass

    total_packages = None
    raw_pkg = results["pkg_count"].stdout.strip()
    if raw_pkg:
        try:
            total_packages = int(raw_pkg)
        except ValueError:
            pass

    last_apt_update = None
    raw_cache = results["apt_cache"].stdout.strip()
    if raw_cache:
        try:
            last_apt_update = datetime.utcfromtimestamp(int(raw_cache))
        except (ValueError, OSError):
            pass

    os_info = results["os_info"].stdout.strip().splitlines()
    os_info_str = os_info[0] if os_info else None

    return {
        "uptime_seconds": uptime_seconds,
        "kernel_version": kernel_version,
        "disk_usage_percent": disk_usage_percent,
        "total_packages": total_packages,
        "last_apt_update": last_apt_update,
        "os_info": os_info_str,
    }


async def check_server(server: Server, db: AsyncSession) -> UpdateCheck:
    """
    Run a full update check on *server*, persist the result, return the UpdateCheck row.
    """
    logger.info("Checking updates on %s (%s)", server.name, server.hostname)

    # Run apt update + list --upgradable + held + reboot concurrently with stats
    apt_update_task = run_command(
        server,
        ("" if server.username == "root" else "sudo ") + "apt-get update -q 2>&1",
        timeout=120,
    )
    stats_task = _gather_stats(server)

    apt_update_result, stats = await asyncio.gather(apt_update_task, stats_task)

    if not apt_update_result.success and apt_update_result.exit_code == 255:
        # SSH connection failure
        check = UpdateCheck(
            server_id=server.id,
            checked_at=datetime.utcnow(),
            status="error",
            error_message=apt_update_result.stderr or "SSH connection failed",
            packages_available=0,
            security_packages=0,
            regular_packages=0,
            held_packages=0,
        )
        db.add(check)
        await db.commit()
        await db.refresh(check)
        return check

    # Parallel: list upgradable, held packages, reboot required, autoremove dry-run
    list_task = run_command(server, "apt list --upgradable 2>/dev/null", timeout=60)
    held_task = run_command(server, "apt-mark showhold 2>/dev/null", timeout=30)
    reboot_task = run_command(server, "test -f /var/run/reboot-required && echo yes || echo no", timeout=10)
    autoremove_task = run_command(server, "apt-get --dry-run autoremove 2>/dev/null", timeout=60)

    list_result, held_result, reboot_result, autoremove_result = await asyncio.gather(
        list_task, held_task, reboot_task, autoremove_task
    )

    packages = _parse_apt_upgradable(list_result.stdout)
    security_count = sum(1 for p in packages if p["is_security"])
    regular_count = sum(1 for p in packages if not p["is_security"])

    held_list = [h.strip() for h in held_result.stdout.splitlines() if h.strip()] if held_result.success else []
    reboot_required = reboot_result.stdout.strip() == "yes"
    autoremove_packages = _parse_autoremove_packages(autoremove_result.stdout) if autoremove_result.success else []

    # Update os_info on server if we got fresh data
    if stats.get("os_info") and not server.os_info:
        server.os_info = stats["os_info"]

    check = UpdateCheck(
        server_id=server.id,
        checked_at=datetime.utcnow(),
        status="success",
        packages_available=len(packages),
        security_packages=security_count,
        regular_packages=regular_count,
        held_packages=len(held_list),
        held_packages_list=json.dumps(held_list),
        autoremove_count=len(autoremove_packages),
        autoremove_packages=json.dumps(autoremove_packages) if autoremove_packages else None,
        reboot_required=reboot_required,
        raw_output=list_result.stdout[:1_000_000],  # cap at 1MB
        packages_json=json.dumps(packages),
    )
    db.add(check)

    # Upsert server stats
    stat_row = ServerStats(
        server_id=server.id,
        recorded_at=datetime.utcnow(),
        uptime_seconds=stats["uptime_seconds"],
        kernel_version=stats["kernel_version"],
        disk_usage_percent=stats["disk_usage_percent"],
        total_packages=stats["total_packages"],
        last_apt_update=stats["last_apt_update"],
    )
    db.add(stat_row)

    await db.commit()
    await db.refresh(check)
    logger.info(
        "Check complete on %s: %d updates (%d security)",
        server.name, len(packages), security_count,
    )
    return check


async def check_all_servers(servers: list[Server], db: AsyncSession, concurrency: int = 5):
    """Check all enabled servers with a concurrency limit."""
    semaphore = asyncio.Semaphore(concurrency)
    results = {}

    async def _check(s: Server):
        async with semaphore:
            results[s.id] = await check_server(s, db)

    await asyncio.gather(*[_check(s) for s in servers if s.is_enabled])
    return results
