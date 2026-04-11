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

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Server, ServerStats, ServerTag, Tag, UpdateCheck
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


def _parse_apt_cache_show(output: str) -> dict[str, str]:
    """Parse `apt-cache show` output, returning {package_name: short_description}."""
    descriptions: dict[str, str] = {}
    current_pkg: str | None = None
    for line in output.splitlines():
        if line.startswith("Package: "):
            current_pkg = line[9:].strip()
        elif line.startswith("Description") and ": " in line and current_pkg:
            desc = line[line.index(": ") + 2:].strip()
            if desc and current_pkg not in descriptions:
                descriptions[current_pkg] = desc
    return descriptions


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
    """Gather server stats in parallel: uptime, kernel, disk, packages, apt cache age, cpu, mem."""
    commands = {
        "uptime": "cat /proc/uptime",
        "kernel": "uname -r",
        "disk": "df -P / | awk 'NR==2{print $5}'",
        "pkg_count": "dpkg --list 2>/dev/null | grep -c '^ii'",
        "apt_cache": "stat -c %Y /var/cache/apt/pkgcache.bin 2>/dev/null || echo ''",
        # Detect OS: Proxmox (pveversion cmd or -pve kernel) → Armbian → os-release → lsb_release
        "os_info": (
            "if command -v pveversion > /dev/null 2>&1; then "
            "  ver=$(pveversion 2>/dev/null | cut -d/ -f2); "
            "  echo \"Proxmox VE ${ver}\"; "
            "elif uname -r 2>/dev/null | grep -q '\\-pve'; then "
            "  echo \"Proxmox VE ($(uname -r))\"; "
            "elif [ -f /etc/armbian-release ]; then "
            "  . /etc/armbian-release 2>/dev/null; "
            "  echo \"Armbian ${VERSION} ${IMAGE_TYPE} (${BOARD_NAME})\"; "
            "elif [ -f /etc/os-release ]; then "
            "  . /etc/os-release 2>/dev/null; "
            "  echo \"${PRETTY_NAME}\"; "
            "else "
            "  lsb_release -ds 2>/dev/null || uname -o 2>/dev/null || echo Unknown; "
            "fi"
        ),
        # Virtualisation type: none=bare-metal, kvm/vmware/…=VM, lxc/docker=container
        # systemd-detect-virt exits 1 on bare-metal ("none") — force exit 0 so the
        # fallback doesn't append a second line of output.
        "virt": "systemd-detect-virt 2>/dev/null; true",
        "cpu": "nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo ''",
        "mem": "free -m 2>/dev/null | awk '/^Mem:/{print $2}' || awk '/^MemTotal:/{printf \"%d\", $2/1024}' /proc/meminfo 2>/dev/null || echo ''",
        # All IPs on the server — used to detect if this machine is the Docker host
        "host_ips": "hostname -I 2>/dev/null || ip addr show | grep -oP 'inet \\K[0-9.]+' | tr '\\n' ' ' || echo ''",
        # Detect unattended-upgrades state: not_installed / disabled / enabled
        "auto_sec": (
            "if ! dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii'; then "
            "  echo not_installed; "
            "elif grep -qE '^APT::Periodic::Unattended-Upgrade \"[1-9]' "
            "  /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then "
            "  echo enabled; "
            "else "
            "  echo disabled; "
            "fi"
        ),
        # EEPROM firmware check (Raspberry Pi 4 / Pi 400 / CM4 / Pi 5 only).
        # Reads the model string from the device tree (strips NUL bytes) or cpuinfo,
        # then only runs rpi-eeprom-update on EEPROM-capable models.
        # Outputs the full rpi-eeprom-update text followed by EEPROM_EXIT:<code>.
        # Exit codes: 0=up_to_date  1=update_available  2=error  3=frozen
        "eeprom": (
            "model=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\\0' || "
            "  grep '^Model' /proc/cpuinfo 2>/dev/null | sed 's/.*: //'); "
            "if echo \"$model\" | grep -qE 'Raspberry Pi (4|400|5)|Compute Module 4'; then "
            "  if command -v rpi-eeprom-update > /dev/null 2>&1; then "
            "    sudo rpi-eeprom-update 2>&1; "
            "    echo \"EEPROM_EXIT:$?\"; "
            "  else "
            "    echo 'EEPROM_EXIT:not_available'; "
            "  fi; "
            "else "
            "  echo 'EEPROM_EXIT:not_applicable'; "
            "fi"
        ),
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

    cpu_count = None
    raw_cpu = results["cpu"].stdout.strip()
    if raw_cpu:
        try:
            cpu_count = int(raw_cpu)
        except ValueError:
            pass

    mem_total_mb = None
    raw_mem = results["mem"].stdout.strip()
    if raw_mem:
        try:
            mem_total_mb = int(raw_mem)
        except ValueError:
            pass

    # Virt type: map systemd-detect-virt output to a friendly label.
    # The command exits 1 on bare-metal but still prints "none" — we use ; true so
    # stdout is always just the first line of output (or empty if not installed).
    virt_raw = results["virt"].stdout.strip().splitlines()[0].lower() if results.get("virt") and results["virt"].stdout.strip() else ""
    if virt_raw == "none":
        virt_type = "bare-metal"
    elif virt_raw in ("lxc", "lxc-libvirt", "openvz", "docker", "podman", "container-other"):
        virt_type = f"container ({virt_raw})"
    elif virt_raw in ("", "unknown"):
        virt_type = None
    else:
        virt_type = f"vm ({virt_raw})"

    auto_sec_raw = results["auto_sec"].stdout.strip().splitlines()[0].lower() if results.get("auto_sec") and results["auto_sec"].stdout.strip() else ""
    auto_security_updates = auto_sec_raw if auto_sec_raw in ("not_installed", "disabled", "enabled") else None

    # EEPROM firmware check (Pi 4 / Pi 400 / CM4 / Pi 5 only)
    eeprom_update_available = None
    eeprom_current_version = None
    eeprom_latest_version = None
    eeprom_raw = results.get("eeprom")
    if eeprom_raw and eeprom_raw.stdout:
        output = eeprom_raw.stdout
        exit_match = re.search(r'EEPROM_EXIT:(\S+)', output)
        exit_val = exit_match.group(1) if exit_match else None
        _exit_map = {"0": "up_to_date", "1": "update_available", "2": "error", "3": "frozen"}
        eeprom_update_available = _exit_map.get(exit_val)  # None if not_applicable / not_available
        if eeprom_update_available in ("up_to_date", "update_available", "frozen"):
            cur = re.search(r'CURRENT:.*?\((\d+)\)', output)
            lat = re.search(r'LATEST:.*?\((\d+)\)', output)
            if cur:
                eeprom_current_version = cur.group(1)
            if lat:
                eeprom_latest_version = lat.group(1)

    # Parse IPs from `hostname -I` (space-separated) into a JSON list
    host_ips_raw = results.get("host_ips")
    host_ips_json = None
    if host_ips_raw and host_ips_raw.stdout.strip():
        ips = [ip for ip in host_ips_raw.stdout.strip().split() if ip]
        if ips:
            host_ips_json = json.dumps(ips)

    return {
        "uptime_seconds": uptime_seconds,
        "kernel_version": kernel_version,
        "disk_usage_percent": disk_usage_percent,
        "total_packages": total_packages,
        "last_apt_update": last_apt_update,
        "os_info": os_info_str,
        "cpu_count": cpu_count,
        "mem_total_mb": mem_total_mb,
        "virt_type": virt_type,
        "auto_security_updates": auto_security_updates,
        "eeprom_update_available": eeprom_update_available,
        "eeprom_current_version": eeprom_current_version,
        "eeprom_latest_version": eeprom_latest_version,
        "host_ips": host_ips_json,
    }


async def check_server(
    server: Server,
    db: AsyncSession,
    skip_apt_update: bool = False,
) -> UpdateCheck:
    """
    Run an update check on *server*, persist the result, return the UpdateCheck row.

    When skip_apt_update=True the ``apt-get update`` step is skipped and the
    existing local apt cache on the remote server is used directly.  This is
    faster but may not reflect the very latest package versions from upstream
    repositories.
    """
    logger.info(
        "%s updates on %s (%s)",
        "Refreshing (no apt-get update)" if skip_apt_update else "Checking",
        server.name,
        server.hostname,
    )

    stats_task = _gather_stats(server)

    if skip_apt_update:
        # Skip apt-get update — just gather stats, then query the local cache
        stats = await stats_task
        # Use a dummy success result so the rest of the function proceeds normally
        from backend.ssh_manager import CommandResult
        apt_update_result = CommandResult(stdout="", stderr="", exit_code=0, success=True)
    else:
        # Run apt update concurrently with stats collection
        apt_update_task = run_command(
            server,
            ("" if server.username == "root" else "sudo ") + "apt-get update -q 2>&1",
            timeout=120,
        )
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

    # Fetch short descriptions for all upgradable packages (one SSH call)
    if packages:
        pkg_names = " ".join(p["name"] for p in packages[:150])  # cap at 150 packages
        desc_result = await run_command(
            server,
            f"apt-cache show --no-all-versions {pkg_names} 2>/dev/null",
            timeout=30,
        )
        descriptions = _parse_apt_cache_show(desc_result.stdout)
        for p in packages:
            p["description"] = descriptions.get(p["name"], "")

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

    # Refresh server os_info if we got a better value
    if stats.get("os_info") and stats["os_info"] != server.os_info:
        server.os_info = stats["os_info"]

    # Upsert server stats
    stat_row = ServerStats(
        server_id=server.id,
        recorded_at=datetime.utcnow(),
        uptime_seconds=stats["uptime_seconds"],
        kernel_version=stats["kernel_version"],
        disk_usage_percent=stats["disk_usage_percent"],
        total_packages=stats["total_packages"],
        last_apt_update=stats["last_apt_update"],
        cpu_count=stats.get("cpu_count"),
        mem_total_mb=stats.get("mem_total_mb"),
        virt_type=stats.get("virt_type"),
        auto_security_updates=stats.get("auto_security_updates"),
        eeprom_update_available=stats.get("eeprom_update_available"),
        eeprom_current_version=stats.get("eeprom_current_version"),
        eeprom_latest_version=stats.get("eeprom_latest_version"),
        host_ips=stats.get("host_ips"),
    )
    db.add(stat_row)

    await db.commit()
    await db.refresh(check)

    # Auto-tag based on OS / virt type if enabled
    await _auto_tag_server(server, stats, db)
    await db.commit()

    logger.info(
        "Check complete on %s: %d updates (%d security)",
        server.name, len(packages), security_count,
    )
    return check


_OS_TAG_COLOR = "#06b6d4"   # cyan — auto-generated OS tags
_VIRT_TAG_COLOR = "#8b5cf6"  # purple — auto-generated virt tags


async def _auto_tag_server(server: Server, stats: dict, db: AsyncSession) -> None:
    """
    Create and assign automatic tags for OS and virtualisation type
    when the corresponding schedule_config flags are enabled.
    Runs after a successful check; idempotent (INSERT OR IGNORE).
    """
    try:
        from backend.models import ScheduleConfig
        cfg_res = await db.execute(sa.select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        if not cfg:
            return

        tags_to_apply: list[tuple[str, str]] = []  # (name, color)

        if cfg.auto_tag_os and stats.get("os_info"):
            # Simplify: "Ubuntu 22.04.3 LTS" → "Ubuntu 22.04", "Debian GNU/Linux 12" → "Debian 12"
            raw = stats["os_info"]
            # Strip common long suffixes
            import re as _re
            simplified = _re.sub(r"\s+LTS$", "", raw, flags=_re.IGNORECASE)
            simplified = _re.sub(r"\s+GNU/Linux", "", simplified)
            simplified = _re.sub(r"\.\d+$", "", simplified)  # drop patch version x.y.z → x.y
            simplified = simplified.strip()
            if simplified:
                tags_to_apply.append((simplified, _OS_TAG_COLOR))

        if cfg.auto_tag_virt and stats.get("virt_type"):
            tags_to_apply.append((stats["virt_type"], _VIRT_TAG_COLOR))

        for tag_name, tag_color in tags_to_apply:
            # Ensure tag exists
            await db.execute(
                sa.text("INSERT OR IGNORE INTO tags (name, color, sort_order) VALUES (:n, :c, 0)"),
                {"n": tag_name, "c": tag_color},
            )
            tid_row = (await db.execute(
                sa.text("SELECT id FROM tags WHERE name = :n"), {"n": tag_name}
            )).fetchone()
            if not tid_row:
                continue
            tag_id = tid_row[0]
            # Assign to server (idempotent)
            await db.execute(
                sa.text("INSERT OR IGNORE INTO server_tags (server_id, tag_id) VALUES (:s, :t)"),
                {"s": server.id, "t": tag_id},
            )
    except Exception as exc:
        logger.warning("auto_tag_server failed for %s: %s", server.name, exc)


async def check_all_servers(
    servers: list[Server],
    db: AsyncSession,
    concurrency: int = 5,
    progress_callback=None,
    skip_apt_update: bool = False,
):
    """Check all enabled servers with a concurrency limit.

    progress_callback: optional async callable(server, status) called on start/finish.
    skip_apt_update: when True, skip ``apt-get update`` and use the local apt cache.
    """
    semaphore = asyncio.Semaphore(concurrency)
    results = {}

    async def _check(s: Server):
        async with semaphore:
            if progress_callback:
                await progress_callback(s, "running")
            try:
                # Each server gets its own session — sharing one AsyncSession
                # across concurrent coroutines causes silent write failures.
                from backend.database import AsyncSessionLocal
                async with AsyncSessionLocal() as server_db:
                    results[s.id] = await check_server(s, server_db, skip_apt_update=skip_apt_update)
                status = results[s.id].status
            except Exception as exc:
                logger.error("Error checking %s: %s", s.name, exc)
                status = "error"
            if progress_callback:
                await progress_callback(s, status)

    await asyncio.gather(*[_check(s) for s in servers if s.is_enabled])
    return results
