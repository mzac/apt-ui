import asyncio
import json
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, ServerGroup, ServerGroupMembership, ServerStats, ServerTag, Tag, UpdateCheck, User
from backend.schemas import (
    CheckAllProgress, GroupRef, ServerCreate, ServerOut, ServerUpdate,
    LatestCheckOut, TagOut,
)
from backend.ssh_manager import test_connection, run_command

router = APIRouter(prefix="/api/servers", tags=["servers"])

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
    _: User = Depends(get_current_user),
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
    _: User = Depends(get_current_user),
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
    _: User = Depends(get_current_user),
):
    server = await _get_server_or_404(server_id, db)
    await db.delete(server)
    await db.commit()


@router.delete("/{server_id}/ssh-key", status_code=204)
async def clear_server_ssh_key(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
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
    _: User = Depends(get_current_user),
):
    server = await _get_server_or_404(server_id, db)
    sudo = "" if server.username == "root" else "sudo "
    result = await run_command(server, f"{sudo}reboot", timeout=15)
    # SSH will drop mid-command on reboot — exit code 255 is normal here
    if result.exit_code == 0 or result.exit_code == 255:
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


@router.post("/{server_id}/auto-security-updates")
async def set_auto_security_updates(
    server_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Enable or disable unattended-upgrades (auto security updates) on a server via SSH."""
    server = await _get_server_or_404(server_id, db)
    enable: bool = body.get("enable", True)
    sudo = "" if server.username == "root" else "sudo "

    if enable:
        # Install unattended-upgrades if missing, then enable it
        cmd = (
            f"{sudo}apt-get install -y unattended-upgrades 2>/dev/null; "
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
