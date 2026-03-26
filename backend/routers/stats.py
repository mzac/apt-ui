from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, UpdateCheck, UpdateHistory, User
from backend.schemas import FleetOverview

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/stats/overview", response_model=FleetOverview)
async def fleet_overview(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Server))
    servers = result.scalars().all()

    total = len(servers)
    up_to_date = 0
    updates_available = 0
    security_total = 0
    errors = 0
    reboot_required = 0
    held_total = 0
    autoremove_total = 0
    last_check_time: datetime | None = None

    for server in servers:
        check_result = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == server.id)
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        check = check_result.scalar_one_or_none()
        if check is None:
            continue
        if last_check_time is None or check.checked_at > last_check_time:
            last_check_time = check.checked_at
        if check.status == "error":
            errors += 1
        elif check.packages_available == 0:
            up_to_date += 1
        else:
            updates_available += 1
            if check.security_packages > 0:
                security_total += 1
        if check.reboot_required:
            reboot_required += 1
        held_total += check.held_packages
        autoremove_total += check.autoremove_count or 0

    # Next check time from scheduler
    next_check_time = None
    try:
        from backend.scheduler import get_next_run_time
        next_check_time = get_next_run_time("check_all")
    except Exception:
        pass

    return FleetOverview(
        total_servers=total,
        up_to_date=up_to_date,
        updates_available=updates_available,
        security_servers=security_total,
        errors=errors,
        reboot_required=reboot_required,
        held_packages_total=held_total,
        autoremove_total=autoremove_total,
        last_check_time=last_check_time,
        next_check_time=next_check_time,
    )


@router.get("/history")
async def global_history(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=200),
    server_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    import json
    from backend.models import Server

    offset = (page - 1) * per_page
    base_q = select(UpdateHistory)
    count_q = select(func.count()).select_from(UpdateHistory)
    if server_id is not None:
        base_q = base_q.where(UpdateHistory.server_id == server_id)
        count_q = count_q.where(UpdateHistory.server_id == server_id)
    if status is not None:
        base_q = base_q.where(UpdateHistory.status == status)
        count_q = count_q.where(UpdateHistory.status == status)

    result = await db.execute(
        base_q.order_by(UpdateHistory.started_at.desc()).offset(offset).limit(per_page)
    )
    rows = result.scalars().all()

    total_result = await db.execute(count_q)
    total = total_result.scalar_one()

    # Build server name map
    srv_result = await db.execute(select(Server))
    srv_map = {s.id: s.name for s in srv_result.scalars().all()}

    items = []
    for h in rows:
        pkgs = None
        if h.packages_upgraded:
            try:
                pkgs = json.loads(h.packages_upgraded)
            except Exception:
                pkgs = []
        items.append({
            "id": h.id,
            "server_id": h.server_id,
            "server_name": srv_map.get(h.server_id, f"Server {h.server_id}"),
            "started_at": h.started_at,
            "completed_at": h.completed_at,
            "status": h.status,
            "action": h.action,
            "phased_updates": h.phased_updates,
            "packages_upgraded": pkgs,
            "log_output": h.log_output,
            "initiated_by": h.initiated_by,
        })

    return {"total": total, "page": page, "per_page": per_page, "items": items}


@router.get("/servers/{server_id}/history")
async def server_history(
    server_id: int,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    import json

    offset = (page - 1) * per_page
    result = await db.execute(
        select(UpdateHistory)
        .where(UpdateHistory.server_id == server_id)
        .order_by(UpdateHistory.started_at.desc())
        .offset(offset)
        .limit(per_page)
    )
    rows = result.scalars().all()

    total_result = await db.execute(
        select(func.count()).select_from(UpdateHistory).where(UpdateHistory.server_id == server_id)
    )
    total = total_result.scalar_one()

    items = []
    for h in rows:
        pkgs = None
        if h.packages_upgraded:
            try:
                pkgs = json.loads(h.packages_upgraded)
            except Exception:
                pkgs = []
        items.append({
            "id": h.id,
            "server_id": h.server_id,
            "started_at": h.started_at,
            "completed_at": h.completed_at,
            "status": h.status,
            "action": h.action,
            "phased_updates": h.phased_updates,
            "packages_upgraded": pkgs,
            "log_output": h.log_output,
            "initiated_by": h.initiated_by,
        })

    return {"total": total, "page": page, "per_page": per_page, "items": items}
