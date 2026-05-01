import asyncio
import functools
import json
import os
import socket
import struct
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import Server, ServerGroup, ServerGroupMembership, ServerStats, ServerTag, Tag, UpdateCheck, User
from backend.schemas import (
    CheckAllProgress, GroupRef, ServerCreate, ServerOut, ServerUpdate,
    LatestCheckOut, TagOut,
)
from backend.ssh_manager import test_connection, run_command

router = APIRouter(prefix="/api/servers", tags=["servers"])

# ---------------------------------------------------------------------------
# Docker host detection
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def _get_docker_host_ips() -> frozenset[str]:
    """Return the IP(s) of the Docker host, or empty set if not running in Docker.

    In bridge-mode Docker the host is always the default gateway.  We read
    /proc/net/route rather than shelling out so there are no extra deps.
    Result is cached for the lifetime of the process — the host IP never
    changes while the container is running.
    """
    # /.dockerenv  — created by Docker and by Podman (for compatibility)
    # /run/.containerenv — created by Podman (more reliable for rootful Podman)
    if not (os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")):
        return frozenset()

    ips: set[str] = set()

    # Default gateway from kernel routing table (Linux only)
    try:
        with open("/proc/net/route") as f:
            for line in f:
                parts = line.strip().split()
                # Destination == 00000000 → default route; Gateway is hex little-endian
                if len(parts) >= 3 and parts[1] == "00000000":
                    gw_int = int(parts[2], 16)
                    gw_ip = socket.inet_ntoa(struct.pack("<I", gw_int))
                    if gw_ip not in ("0.0.0.0", ""):
                        ips.add(gw_ip)
    except Exception:
        pass

    # Docker Desktop (Mac/Windows) injects this hostname
    try:
        ips.add(socket.gethostbyname("host.docker.internal"))
    except Exception:
        pass

    return frozenset(ips)


def _server_is_docker_host(hostname: str, stored_ips_json: str | None = None) -> bool:
    """Return True if this server is the Docker host running this container.

    Two complementary checks:
    1. Resolve the server hostname and compare against the container's gateway IP.
       Works when the server is added by its Docker bridge IP (rare).
    2. Compare the container's gateway IP against the server's own IPs collected
       during the last SSH check (`hostname -I`). Works for the common case where
       the server is added by its LAN hostname/IP — because the Docker host also
       has the bridge IP (e.g. 172.17.0.1) assigned to its docker0 interface.
    """
    host_ips = _get_docker_host_ips()
    if not host_ips:
        return False

    # Check 1: hostname resolution
    try:
        results = socket.getaddrinfo(hostname, None)
        server_ips = {r[4][0] for r in results}
        if host_ips & server_ips:
            return True
    except Exception:
        pass

    # Check 2: compare against IPs collected from the server via SSH
    if stored_ips_json:
        try:
            import json as _json
            stored_ips = set(_json.loads(stored_ips_json))
            if host_ips & stored_ips:
                return True
        except Exception:
            pass

    return False


# ---------------------------------------------------------------------------
# In-memory reachability cache  {server_id: (reachable: bool, checked_at: float)}
# ---------------------------------------------------------------------------

_reachability_cache: dict[int, tuple[bool, float]] = {}


# ---------------------------------------------------------------------------
# In-memory check-all progress tracker
# ---------------------------------------------------------------------------

_check_progress: dict = {
    "running": False,
    "total": 0,
    "done": 0,
    "current": [],  # list of server names currently being checked
    "results": {},  # server_id -> status string
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_server_or_404(server_id: int, db: AsyncSession) -> Server:
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")
    return server


async def _latest_check(server_id: int, db: AsyncSession) -> UpdateCheck | None:
    result = await db.execute(
        select(UpdateCheck)
        .where(UpdateCheck.server_id == server_id)
        .order_by(UpdateCheck.checked_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _latest_stats(server_id: int, db: AsyncSession) -> ServerStats | None:
    result = await db.execute(
        select(ServerStats)
        .where(ServerStats.server_id == server_id)
        .order_by(ServerStats.recorded_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _get_server_tags(server_id: int, db: AsyncSession) -> list[TagOut]:
    """Return TagOut list for a server from the server_tags join table."""
    result = await db.execute(
        select(Tag)
        .join(ServerTag, ServerTag.tag_id == Tag.id)
        .where(ServerTag.server_id == server_id)
        .order_by(Tag.sort_order, Tag.name)
    )
    tags = result.scalars().all()
    # We need server_count per tag; skip it in card context (use 0)
    return [TagOut(id=t.id, name=t.name, color=t.color, sort_order=t.sort_order, server_count=0) for t in tags]


async def _get_server_groups(server_id: int, db: AsyncSession) -> list[GroupRef]:
    """Return GroupRef list for a server from the server_group_memberships join table."""
    result = await db.execute(
        select(ServerGroup)
        .join(ServerGroupMembership, ServerGroupMembership.group_id == ServerGroup.id)
        .where(ServerGroupMembership.server_id == server_id)
        .order_by(ServerGroup.sort_order, ServerGroup.name)
    )
    groups = result.scalars().all()
    return [GroupRef(id=g.id, name=g.name, color=g.color) for g in groups]


async def _build_server_out(
    server: Server,
    check: UpdateCheck | None,
    group: ServerGroup | None,
    db: AsyncSession,
) -> ServerOut:
    latest = None
    if check:
        held_list = None
        if check.held_packages_list:
            try:
                held_list = json.loads(check.held_packages_list)
            except Exception:
                held_list = []
        # Count kept-back / new packages from packages_json (set by check_server's dist-upgrade dry-run)
        kept_back_count = 0
        new_packages_count = 0
        if check.packages_json:
            try:
                pkg_list = json.loads(check.packages_json)
                kept_back_count = sum(1 for p in pkg_list if p.get("needs_dist_upgrade"))
                new_packages_count = sum(1 for p in pkg_list if p.get("is_new"))
            except Exception:
                pass
        latest = LatestCheckOut(
            checked_at=check.checked_at,
            status=check.status,
            packages_available=check.packages_available,
            security_packages=check.security_packages,
            regular_packages=check.regular_packages,
            held_packages=check.held_packages,
            autoremove_count=check.autoremove_count or 0,
            reboot_required=check.reboot_required,
            error_message=check.error_message,
            kept_back_count=kept_back_count,
            new_packages_count=new_packages_count,
        )

    # New tag system (from server_tags)
    tags = await _get_server_tags(server.id, db)

    # Multiple group memberships
    groups = await _get_server_groups(server.id, db)

    # Primary group (backward compat)
    primary_group = group
    if primary_group is None and groups:
        # Use first membership group as primary
        first_g = await db.execute(select(ServerGroup).where(ServerGroup.id == groups[0].id))
        primary_group = first_g.scalar_one_or_none()

    # Latest stats
    stats_row = await _latest_stats(server.id, db)

    return ServerOut(
        id=server.id,
        name=server.name,
        hostname=server.hostname,
        username=server.username,
        ssh_port=server.ssh_port,
        group_id=server.group_id,
        group_name=primary_group.name if primary_group else None,
        group_color=primary_group.color if primary_group else None,
        groups=groups,
        os_info=server.os_info,
        tags=tags,
        is_enabled=server.is_enabled,
        ssh_key_configured=bool(server.ssh_private_key_enc),
        created_at=server.created_at,
        updated_at=server.updated_at,
        latest_check=latest,
        cpu_count=stats_row.cpu_count if stats_row else None,
        mem_total_mb=stats_row.mem_total_mb if stats_row else None,
        kernel_version=stats_row.kernel_version if stats_row else None,
        uptime_seconds=stats_row.uptime_seconds if stats_row else None,
        virt_type=stats_row.virt_type if stats_row else None,
        auto_security_updates=stats_row.auto_security_updates if stats_row else None,
        eeprom_update_available=stats_row.eeprom_update_available if stats_row else None,
        eeprom_current_version=stats_row.eeprom_current_version if stats_row else None,
        eeprom_latest_version=stats_row.eeprom_latest_version if stats_row else None,
        last_apt_update=stats_row.last_apt_update if stats_row else None,
        notes=server.notes,
        is_docker_host=_server_is_docker_host(server.hostname, stats_row.host_ips if stats_row else None),
        apt_proxy=stats_row.apt_proxy if stats_row else None,
        is_proxmox=bool(server.os_info and server.os_info.startswith("Proxmox VE")),
        is_reachable=server.is_reachable,
        last_seen=server.last_seen,
        kernel_install_date=stats_row.kernel_install_date if stats_row else None,
        boot_free_mb=stats_row.boot_free_mb if stats_row else None,
        boot_total_mb=stats_row.boot_total_mb if stats_row else None,
    )


async def _resolve_or_create_tags(
    db: AsyncSession,
    tag_ids: list[int],
    tag_names: list[str],
) -> list[int]:
    """Return a deduplicated list of tag IDs, creating any new tags from tag_names."""
    PALETTE = [
        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
        '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a3e635',
        '#e879f9', '#fb7185', '#34d399', '#60a5fa', '#fbbf24',
    ]

    result_ids = list(tag_ids)

    # Count existing tags for color picking
    existing_count_res = await db.execute(select(Tag))
    existing_count = len(existing_count_res.scalars().all())

    for name in tag_names:
        name = name.strip()
        if not name:
            continue
        existing = await db.execute(select(Tag).where(Tag.name == name))
        tag = existing.scalar_one_or_none()
        if tag is None:
            color = PALETTE[existing_count % len(PALETTE)]
            existing_count += 1
            tag = Tag(name=name, color=color, sort_order=0)
            db.add(tag)
            await db.flush()  # get the id
        if tag.id not in result_ids:
            result_ids.append(tag.id)

    return list(set(result_ids))


async def _set_server_tags(db: AsyncSession, server_id: int, tag_ids: list[int]):
    """Replace all ServerTag associations for a server with the given tag_ids."""
    await db.execute(delete(ServerTag).where(ServerTag.server_id == server_id))
    for tid in tag_ids:
        db.add(ServerTag(server_id=server_id, tag_id=tid))


async def _set_server_groups(db: AsyncSession, server_id: int, group_ids: list[int], primary_group_id: int | None = None):
    """Replace all ServerGroupMembership associations for a server."""
    await db.execute(
        delete(ServerGroupMembership).where(ServerGroupMembership.server_id == server_id)
    )
    seen = set()
    for gid in group_ids:
        if gid not in seen:
            db.add(ServerGroupMembership(server_id=server_id, group_id=gid))
            seen.add(gid)
    # Also ensure primary group_id is included if provided
    if primary_group_id and primary_group_id not in seen:
        db.add(ServerGroupMembership(server_id=server_id, group_id=primary_group_id))


# ---------------------------------------------------------------------------
# Check-all progress endpoint
# ---------------------------------------------------------------------------

@router.get("/check-all/progress", response_model=CheckAllProgress)
async def get_check_all_progress(_: User = Depends(get_current_user)):
    return CheckAllProgress(
        running=_check_progress["running"],
        total=_check_progress["total"],
        done=_check_progress["done"],
        current_servers=list(_check_progress["current"]),
        results={str(k): v for k, v in _check_progress["results"].items()},
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=list[ServerOut])
async def list_servers(
    group_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = select(Server)
    if group_id is not None:
        # Filter by membership in the group_id
        q = q.join(ServerGroupMembership, ServerGroupMembership.server_id == Server.id).where(
            ServerGroupMembership.group_id == group_id
        )
    result = await db.execute(q.order_by(Server.name))
    servers = result.scalars().all()

    out = []
    for s in servers:
        check = await _latest_check(s.id, db)
        group = None
        if s.group_id:
            g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == s.group_id))
            group = g_result.scalar_one_or_none()
        server_out = await _build_server_out(s, check, group, db)

        # Filter by status if requested
        if status:
            c = server_out.latest_check
            if status == "updates_available":
                if not c or c.packages_available == 0:
                    continue
            elif status == "error":
                if not c or c.status != "error":
                    continue
            elif status == "up_to_date":
                if not c or c.packages_available != 0 or c.status != "success":
                    continue

        out.append(server_out)

    return out


@router.post("", response_model=ServerOut, status_code=201)
async def create_server(
    body: ServerCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    # Check hostname uniqueness
    existing = await db.execute(select(Server).where(Server.hostname == body.hostname))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A server with that hostname already exists")

    # Validate primary group exists if provided
    group = None
    if body.group_id:
        g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == body.group_id))
        group = g_result.scalar_one_or_none()
        if group is None:
            raise HTTPException(status_code=400, detail="Group not found")

    ssh_key_enc = None
    if body.ssh_private_key and body.ssh_private_key.strip():
        from backend.crypto import encrypt
        ssh_key_enc = encrypt(body.ssh_private_key.strip())

    server = Server(
        name=body.name,
        hostname=body.hostname,
        username=body.username,
        ssh_port=body.ssh_port,
        group_id=body.group_id,
        ssh_private_key_enc=ssh_key_enc,
        notes=body.notes,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(server)
    await db.flush()  # get server.id

    # Resolve tags
    all_tag_ids = await _resolve_or_create_tags(db, body.tag_ids, body.tag_names)
    # Also handle legacy tags list (strings)
    if body.tags:
        all_tag_ids = await _resolve_or_create_tags(db, all_tag_ids, body.tags)
    await _set_server_tags(db, server.id, all_tag_ids)

    # Set group memberships
    group_ids = list(body.group_ids)
    if body.group_id and body.group_id not in group_ids:
        group_ids.append(body.group_id)
    await _set_server_groups(db, server.id, group_ids, body.group_id)

    await db.commit()
    await db.refresh(server)

    # Test SSH connectivity and grab OS info immediately
    result = await test_connection(server)
    if result.success:
        os_result = await run_command(
            server,
            "if [ -f /etc/pve/pve-release ]; then "
            "  ver=$(head -1 /etc/pve/pve-release | cut -d/ -f2 2>/dev/null); "
            "  echo \"Proxmox VE ${ver}\"; "
            "elif [ -f /etc/os-release ]; then "
            "  grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2 | tr -d '\"'; "
            "else "
            "  lsb_release -ds 2>/dev/null || echo Unknown; "
            "fi"
        )
        if os_result.success and os_result.stdout.strip():
            server.os_info = os_result.stdout.strip().splitlines()[0]
            await db.commit()
            await db.refresh(server)

        # Kick off a full update check in the background
        from backend.update_checker import check_server as do_check
        from backend.database import AsyncSessionLocal

        async def _bg_check():
            async with AsyncSessionLocal() as bg_db:
                from sqlalchemy import select as _select
                srv = (await bg_db.execute(_select(Server).where(Server.id == server.id))).scalar_one_or_none()
                if srv:
                    await do_check(srv, bg_db)

        asyncio.create_task(_bg_check())

    return await _build_server_out(server, None, group, db)


@router.put("/{server_id}", response_model=ServerOut)
async def update_server(
    server_id: int,
    body: ServerUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    server = await _get_server_or_404(server_id, db)

    if body.name is not None:
        server.name = body.name
    if body.hostname is not None:
        # Check uniqueness (exclude self)
        existing = await db.execute(
            select(Server).where(Server.hostname == body.hostname, Server.id != server_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A server with that hostname already exists")
        server.hostname = body.hostname
    if body.username is not None:
        server.username = body.username
    if body.ssh_port is not None:
        server.ssh_port = body.ssh_port
    if body.group_id is not None:
        g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == body.group_id))
        if g_result.scalar_one_or_none() is None:
            raise HTTPException(status_code=400, detail="Group not found")
        server.group_id = body.group_id
    elif "group_id" in body.model_fields_set and body.group_id is None:
        server.group_id = None
    if body.is_enabled is not None:
        server.is_enabled = body.is_enabled
    if "notes" in body.model_fields_set:
        server.notes = body.notes
    if body.ssh_private_key is not None:
        if body.ssh_private_key.strip():
            from backend.crypto import encrypt
            server.ssh_private_key_enc = encrypt(body.ssh_private_key.strip())
        else:
            server.ssh_private_key_enc = None  # empty string = clear the key

    # Handle tags
    if body.tag_ids is not None or body.tag_names is not None or body.tags is not None:
        new_ids = list(body.tag_ids or [])
        new_names = list(body.tag_names or [])
        # Legacy tags field support
        if body.tags is not None:
            new_names.extend(body.tags)
        all_tag_ids = await _resolve_or_create_tags(db, new_ids, new_names)
        await _set_server_tags(db, server.id, all_tag_ids)

    # Handle multiple group memberships
    if body.group_ids is not None:
        group_ids = list(body.group_ids)
        # Ensure primary group_id stays in memberships
        effective_primary = body.group_id if "group_id" in body.model_fields_set else server.group_id
        if effective_primary and effective_primary not in group_ids:
            group_ids.append(effective_primary)
        await _set_server_groups(db, server.id, group_ids, effective_primary)
    elif "group_id" in body.model_fields_set:
        # Primary group changed — update memberships to reflect
        # Get current memberships
        current_memberships = await _get_server_groups(server.id, db)
        current_ids = [g.id for g in current_memberships]
        # Replace old primary with new primary if needed
        old_primary = server.group_id
        new_primary = body.group_id
        new_ids_list = [gid for gid in current_ids if gid != old_primary]
        if new_primary:
            new_ids_list.append(new_primary)
        await _set_server_groups(db, server.id, new_ids_list, new_primary)

    server.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(server)

    check = await _latest_check(server.id, db)
    group = None
    if server.group_id:
        g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == server.group_id))
        group = g_result.scalar_one_or_none()

    return await _build_server_out(server, check, group, db)


@router.delete("/{server_id}", status_code=204)
async def delete_server(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    server = await _get_server_or_404(server_id, db)
    await db.delete(server)
    await db.commit()


@router.post("/generate-ssh-key")
async def generate_ssh_key(
    _: User = Depends(require_admin),
):
    """Generate a new Ed25519 SSH key pair and return both keys as strings.
    The private key is returned in OpenSSH PEM format; the public key in
    authorized_keys format.  Neither is stored — the caller decides what to do.
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PrivateFormat,
        PublicFormat,
        NoEncryption,
    )

    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.OpenSSH,
        encryption_algorithm=NoEncryption(),
    ).decode()
    public_openssh = private_key.public_key().public_bytes(
        encoding=Encoding.OpenSSH,
        format=PublicFormat.OpenSSH,
    ).decode()

    return {"private_key": private_pem, "public_key": public_openssh}


@router.delete("/{server_id}/ssh-key", status_code=204)
async def clear_server_ssh_key(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Remove the per-server SSH key; the server will fall back to the global key."""
    server = await _get_server_or_404(server_id, db)
    server.ssh_private_key_enc = None
    server.updated_at = datetime.utcnow()
    await db.commit()


@router.post("/{server_id}/reboot")
async def reboot_server(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    server = await _get_server_or_404(server_id, db)
    sudo = "" if server.username == "root" else "sudo "
    result = await run_command(server, f"{sudo}reboot", timeout=15)
    # SSH will drop mid-command on reboot — exit code 255 is normal here
    if result.exit_code == 0 or result.exit_code == 255:
        from backend.scheduler import schedule_reboot_check
        schedule_reboot_check(server_id)
        return {"success": True, "detail": "Reboot command sent"}
    return {"success": False, "detail": result.stderr or "Reboot command failed"}


@router.get("/reachability")
async def get_reachability(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return cached SSH reachability for all enabled servers, refreshing stale entries.

    TTL is controlled by schedule_config.reachability_ttl_minutes.
    Returns {server_id: bool} — omits servers whose cached result is still fresh.
    Setting TTL to 0 disables reachability checks (returns empty dict).
    """
    from backend.models import ScheduleConfig
    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    ttl_minutes = cfg.reachability_ttl_minutes if cfg else 5

    if ttl_minutes == 0:
        return {}

    ttl_seconds = ttl_minutes * 60
    now = time.time()

    servers_res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = servers_res.scalars().all()

    stale = [s for s in servers if s.id not in _reachability_cache or (now - _reachability_cache[s.id][1]) >= ttl_seconds]

    if stale:
        sem = asyncio.Semaphore(10)
        async def _check(server):
            async with sem:
                try:
                    result = await test_connection(server)
                    _reachability_cache[server.id] = (result.success, time.time())
                except Exception:
                    _reachability_cache[server.id] = (False, time.time())
        await asyncio.gather(*[_check(s) for s in stale])

    return {s.id: _reachability_cache[s.id][0] for s in servers if s.id in _reachability_cache}


@router.post("/search-package")
async def search_package_fleet(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Fleet-wide package search with flexible match modes (issue #46).

    Accepts: {
      "name": "openssl",
      "mode": "contains" | "exact" | "starts-with" | "ends-with" | "regex"
    }
    Returns: {
      "servers": [{"id": 1, "name": "...", "hostname": "..."}],
      "matches": {
        "<package_name>": { "<server_id>": "version", ... }
      },
      "errors": { "<server_id>": "error message" }
    }

    Note that *matches* is keyed by package name (not server) — multiple
    packages can match per server.
    """
    import asyncssh as _asyncssh
    import re as _re
    from backend.ssh_manager import _connect_options

    pkg = (body.get("name") or "").strip()
    mode = (body.get("mode") or "contains").strip().lower()
    if mode not in {"exact", "contains", "starts-with", "ends-with", "regex"}:
        raise HTTPException(status_code=400, detail="Invalid mode")
    if not pkg:
        raise HTTPException(status_code=400, detail="Search term required")

    # Build the dpkg-query glob and an optional Python regex post-filter
    # We always pass dpkg-query a safe glob (only [a-zA-Z0-9.+\-*?]) to avoid
    # shell injection — for regex mode we list everything (`*`) and filter in Python.
    py_filter: _re.Pattern | None = None
    if mode == "regex":
        try:
            py_filter = _re.compile(pkg)
        except _re.error as exc:
            raise HTTPException(status_code=400, detail=f"Invalid regex: {exc}")
        glob = "*"
    else:
        # Validate that the user-supplied substring is "package-name-shaped"
        if not _re.match(r'^[a-zA-Z0-9._+\-]+$', pkg):
            raise HTTPException(status_code=400, detail="Search term may only contain letters, digits, '.', '_', '+', '-'")
        if mode == "exact":
            glob = pkg
        elif mode == "starts-with":
            glob = f"{pkg}*"
        elif mode == "ends-with":
            glob = f"*{pkg}"
        else:  # contains
            glob = f"*{pkg}*"

    # Cap the number of returned matches to keep the response sane
    MAX_MATCHES_PER_SERVER = 200

    res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers_list = res.scalars().all()

    # matches: { package_name: { server_id: version } }
    matches: dict[str, dict[str, str]] = {}
    errors: dict[str, str] = {}

    async def _query(server: Server):
        try:
            opts = _connect_options(server)
            async with _asyncssh.connect(**opts) as conn:
                # Quote the glob carefully — it's already validated to safe chars
                r = await conn.run(
                    f"dpkg-query -W -f='${{Status}}\\t${{Package}}\\t${{Version}}\\n' '{glob}' 2>/dev/null || true",
                    timeout=30,
                )
                count = 0
                for line in (r.stdout or "").splitlines():
                    if count >= MAX_MATCHES_PER_SERVER:
                        break
                    parts = line.split("\t", 2)
                    if len(parts) != 3:
                        continue
                    status_field, name, version = parts
                    if "install ok installed" not in status_field:
                        continue
                    if py_filter and not py_filter.search(name):
                        continue
                    matches.setdefault(name, {})[str(server.id)] = version
                    count += 1
        except Exception as exc:
            errors[str(server.id)] = str(exc)

    await asyncio.gather(*[_query(s) for s in servers_list])

    return {
        "servers": [
            {"id": s.id, "name": s.name, "hostname": s.hostname}
            for s in servers_list
        ],
        "matches": matches,
        "errors": errors,
    }


@router.post("/compare")
async def compare_server_packages(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Compare installed packages across multiple servers via SSH (on-demand).

    Accepts: { "server_ids": [1, 2, 3] }
    Returns: {
      "servers": [{"id": 1, "name": "...", "hostname": "..."}],
      "packages": { "pkg-name": {"1": "1.2.3", "2": null} },
      "errors": {"3": "Connection failed"}
    }
    where package version is null when not installed on that server.
    """
    import asyncssh as _asyncssh
    from backend.ssh_manager import _connect_options

    server_ids: list[int] = body.get("server_ids", [])
    if not server_ids:
        return {"servers": [], "packages": {}, "errors": {}}

    # Fetch server records
    result = await db.execute(select(Server).where(Server.id.in_(server_ids)))
    servers_list = result.scalars().all()
    server_map = {s.id: s for s in servers_list}

    installed: dict[int, dict[str, str]] = {}
    errors: dict[str, str] = {}

    async def _fetch(server: Server):
        try:
            opts = _connect_options(server)
            async with _asyncssh.connect(**opts) as conn:
                result = await conn.run(
                    "dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null",
                    timeout=30,
                )
                pkgs: dict[str, str] = {}
                for line in (result.stdout or "").splitlines():
                    parts = line.split("\t", 1)
                    if len(parts) == 2 and parts[0]:
                        pkgs[parts[0]] = parts[1]
                installed[server.id] = pkgs
        except Exception as exc:
            errors[str(server.id)] = str(exc)

    await asyncio.gather(*[_fetch(server_map[sid]) for sid in server_ids if sid in server_map])

    # Compute union of all packages
    all_pkg_names: set[str] = set()
    for pkgs in installed.values():
        all_pkg_names.update(pkgs.keys())

    # Build per-package-per-server version map; null = not installed
    packages: dict[str, dict[str, str | None]] = {}
    for pkg in sorted(all_pkg_names):
        row: dict[str, str | None] = {}
        for sid in server_ids:
            if sid in installed:
                row[str(sid)] = installed[sid].get(pkg)  # None if absent
            # servers with errors are omitted from the matrix
        packages[pkg] = row

    return {
        "servers": [
            {"id": s.id, "name": s.name, "hostname": s.hostname}
            for s in servers_list
        ],
        "packages": packages,
        "errors": errors,
    }


@router.post("/{server_id}/test")
async def test_server_connection(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    server = await _get_server_or_404(server_id, db)
    result = await test_connection(server)
    if result.success:
        return {"success": True, "detail": "Connection successful"}
    return {"success": False, "detail": result.stderr or "Connection failed"}


@router.get("/{server_id}/health")
async def get_server_health(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Service health snapshot (issue #42).

    On-demand SSH probe — not part of the regular check, since this is an
    optional view that adds SSH calls. Returns:
      - failed_services: list of failed systemd units
      - recent_errors: last 20 boot-priority error lines from journalctl
      - reboots: last 5 reboots from `last reboot`
    """
    server = await _get_server_or_404(server_id, db)
    cmd = (
        "echo '__FAILED__'; "
        "systemctl --failed --no-legend --plain --no-pager 2>/dev/null | head -50; "
        "echo '__ERRORS__'; "
        f"{('' if server.username == 'root' else 'sudo ')}journalctl -p err -b --no-pager -n 20 2>/dev/null || echo '(journalctl unavailable)'; "
        "echo '__REBOOTS__'; "
        "last reboot 2>/dev/null | head -5 | grep -v '^$'"
    )
    result = await run_command(server, cmd, timeout=20)

    failed_services: list[dict] = []
    recent_errors: list[str] = []
    reboots: list[str] = []
    section = None
    for line in (result.stdout or "").splitlines():
        if line == "__FAILED__":
            section = "failed"; continue
        if line == "__ERRORS__":
            section = "errors"; continue
        if line == "__REBOOTS__":
            section = "reboots"; continue
        if section == "failed" and line.strip():
            parts = line.split(None, 4)
            if len(parts) >= 4:
                failed_services.append({
                    "unit": parts[0],
                    "load": parts[1],
                    "active": parts[2],
                    "sub": parts[3],
                    "description": parts[4] if len(parts) > 4 else "",
                })
        elif section == "errors" and line.strip():
            recent_errors.append(line)
        elif section == "reboots" and line.strip():
            reboots.append(line)

    return {
        "failed_services": failed_services,
        "recent_errors": recent_errors,
        "reboots": reboots,
        "collected_at": datetime.utcnow().isoformat(),
    }


@router.post("/{server_id}/restart-service")
async def restart_service(
    server_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Restart a systemd service (issue #42)."""
    import re as _re
    server = await _get_server_or_404(server_id, db)
    unit = (body.get("unit") or "").strip()
    if not unit or not _re.match(r'^[a-zA-Z0-9@.\-_:]+\.(service|socket|timer|target|path|mount)$', unit):
        raise HTTPException(status_code=400, detail="Invalid unit name")
    sudo = "" if server.username == "root" else "sudo "
    result = await run_command(server, f"{sudo}systemctl restart {unit}", timeout=30)
    return {
        "success": result.exit_code == 0,
        "unit": unit,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


@router.post("/{server_id}/auto-security-updates")
async def set_auto_security_updates(
    server_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Enable or disable unattended-upgrades (auto security updates) on a server via SSH."""
    server = await _get_server_or_404(server_id, db)
    enable: bool = body.get("enable", True)
    sudo = "" if server.username == "root" else "sudo "

    if enable:
        # Install unattended-upgrades if missing, then enable it
        cmd = (
            f"DEBIAN_FRONTEND=noninteractive {sudo}apt-get install -y unattended-upgrades 2>/dev/null; "
            f"printf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"1\";\\n' "
            f"| {sudo}tee /etc/apt/apt.conf.d/20auto-upgrades"
        )
    else:
        cmd = (
            f"printf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"0\";\\n' "
            f"| {sudo}tee /etc/apt/apt.conf.d/20auto-upgrades"
        )

    result = await run_command(server, cmd, timeout=60)
    if not result.success and result.exit_code == 255:
        raise HTTPException(status_code=502, detail="SSH connection failed")

    # Update the latest stats row with the new value
    stats_res = await db.execute(
        select(ServerStats).where(ServerStats.server_id == server_id).order_by(ServerStats.recorded_at.desc()).limit(1)
    )
    stats_row = stats_res.scalar_one_or_none()
    new_val = "enabled" if enable else "disabled"
    if stats_row:
        stats_row.auto_security_updates = new_val
        await db.commit()

    return {"success": True, "auto_security_updates": new_val}


@router.post("/check-all")
async def check_all_servers_endpoint(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Trigger a check on all enabled servers, tracking progress in _check_progress."""
    from backend.update_checker import check_all_servers
    from backend.models import ScheduleConfig

    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    concurrency = cfg.upgrade_concurrency if cfg else 5

    srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = list(srv_res.scalars().all())

    _check_progress["running"] = True
    _check_progress["total"] = len(servers)
    _check_progress["done"] = 0
    _check_progress["current"] = []
    _check_progress["results"] = {}

    async def _progress_cb(server: Server, status: str):
        if status == "running":
            _check_progress["current"].append(server.name)
        else:
            _check_progress["done"] += 1
            _check_progress["results"][server.id] = status
            try:
                _check_progress["current"].remove(server.name)
            except ValueError:
                pass

    async def _run():
        from backend.database import AsyncSessionLocal
        try:
            async with AsyncSessionLocal() as bg_db:
                await check_all_servers(servers, bg_db, concurrency=concurrency, progress_callback=_progress_cb)
        finally:
            _check_progress["running"] = False
            _check_progress["current"] = []

    asyncio.create_task(_run())
    return {"detail": "Check started", "total": len(servers)}


@router.post("/refresh-all")
async def refresh_all_servers_endpoint(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Like /check-all but skips apt-get update — reads each server's existing local apt cache.
    Much faster than a full check; use when you want to see what's already known without
    fetching fresh package index data from upstream repositories.
    """
    from backend.update_checker import check_all_servers
    from backend.models import ScheduleConfig

    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    concurrency = cfg.upgrade_concurrency if cfg else 5

    srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = list(srv_res.scalars().all())

    _check_progress["running"] = True
    _check_progress["total"] = len(servers)
    _check_progress["done"] = 0
    _check_progress["current"] = []
    _check_progress["results"] = {}

    async def _progress_cb(server: Server, status: str):
        if status == "running":
            _check_progress["current"].append(server.name)
        else:
            _check_progress["done"] += 1
            _check_progress["results"][server.id] = status
            try:
                _check_progress["current"].remove(server.name)
            except ValueError:
                pass

    async def _run():
        from backend.database import AsyncSessionLocal
        try:
            async with AsyncSessionLocal() as bg_db:
                await check_all_servers(
                    servers, bg_db,
                    concurrency=concurrency,
                    progress_callback=_progress_cb,
                    skip_apt_update=True,
                )
        finally:
            _check_progress["running"] = False
            _check_progress["current"] = []

    asyncio.create_task(_run())
    return {"detail": "Refresh started", "total": len(servers)}
