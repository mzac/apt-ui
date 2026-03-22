import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, ServerGroup, UpdateCheck, User
from backend.schemas import ServerCreate, ServerOut, ServerUpdate, LatestCheckOut
from backend.ssh_manager import test_connection, run_command

router = APIRouter(prefix="/api/servers", tags=["servers"])


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


def _build_server_out(server: Server, check: UpdateCheck | None, group: ServerGroup | None) -> ServerOut:
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
    try:
        tags = json.loads(server.tags) if server.tags else []
    except Exception:
        tags = []
    return ServerOut(
        id=server.id,
        name=server.name,
        hostname=server.hostname,
        username=server.username,
        ssh_port=server.ssh_port,
        group_id=server.group_id,
        group_name=group.name if group else None,
        group_color=group.color if group else None,
        os_info=server.os_info,
        tags=tags,
        is_enabled=server.is_enabled,
        created_at=server.created_at,
        updated_at=server.updated_at,
        latest_check=latest,
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
        q = q.where(Server.group_id == group_id)
    result = await db.execute(q.order_by(Server.name))
    servers = result.scalars().all()

    out = []
    for s in servers:
        check = await _latest_check(s.id, db)
        group = None
        if s.group_id:
            g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == s.group_id))
            group = g_result.scalar_one_or_none()
        server_out = _build_server_out(s, check, group)

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

    # Validate group exists if provided
    group = None
    if body.group_id:
        g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == body.group_id))
        group = g_result.scalar_one_or_none()
        if group is None:
            raise HTTPException(status_code=400, detail="Group not found")

    server = Server(
        name=body.name,
        hostname=body.hostname,
        username=body.username,
        ssh_port=body.ssh_port,
        group_id=body.group_id,
        tags=json.dumps(body.tags) if body.tags else None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(server)
    await db.commit()
    await db.refresh(server)

    # Test SSH connectivity and grab OS info immediately
    result = await test_connection(server)
    if result.success:
        from backend.ssh_manager import run_command
        os_result = await run_command(server, "grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '\"' || lsb_release -ds 2>/dev/null || echo Unknown")
        if os_result.success and os_result.stdout.strip():
            server.os_info = os_result.stdout.strip().splitlines()[0]
            await db.commit()
            await db.refresh(server)

        # Kick off a full update check in the background so the dashboard
        # shows real package counts without requiring a manual "Check"
        import asyncio
        from backend.update_checker import check_server
        from backend.database import AsyncSessionLocal

        async def _bg_check():
            async with AsyncSessionLocal() as bg_db:
                from sqlalchemy import select as _select
                srv = (await bg_db.execute(_select(Server).where(Server.id == server.id))).scalar_one_or_none()
                if srv:
                    await check_server(srv, bg_db)

        asyncio.create_task(_bg_check())

    return _build_server_out(server, None, group)


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
    if body.tags is not None:
        server.tags = json.dumps(body.tags)

    server.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(server)

    check = await _latest_check(server.id, db)
    group = None
    if server.group_id:
        g_result = await db.execute(select(ServerGroup).where(ServerGroup.id == server.group_id))
        group = g_result.scalar_one_or_none()

    return _build_server_out(server, check, group)


@router.delete("/{server_id}", status_code=204)
async def delete_server(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    server = await _get_server_or_404(server_id, db)
    await db.delete(server)
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
