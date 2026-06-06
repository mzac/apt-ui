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
    from backend.query_helpers import latest_checks_by_server

    result = await db.execute(select(Server))
    servers = result.scalars().all()
    checks = await latest_checks_by_server(db)   # one query instead of one per server

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
        check = checks.get(server.id)
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


@router.get("/stats/trend")
async def fleet_trend(
    days: int = Query(default=30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Time series of fleet snapshots over the last *days* (for dashboard trend charts)."""
    from datetime import timedelta
    from backend.models import FleetSnapshot

    cutoff = datetime.utcnow() - timedelta(days=days)
    res = await db.execute(
        select(FleetSnapshot)
        .where(FleetSnapshot.recorded_at >= cutoff)
        .order_by(FleetSnapshot.recorded_at.asc())
    )
    rows = res.scalars().all()
    return {
        "points": [
            {
                "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
                "total_servers": r.total_servers,
                "up_to_date": r.up_to_date,
                "updates_available": r.updates_available,
                "security_servers": r.security_servers,
                "errors": r.errors,
                "reboot_required": r.reboot_required,
                "pending_packages_total": r.pending_packages_total,
                "security_packages_total": r.security_packages_total,
                "pct_up_to_date": round(100.0 * r.up_to_date / r.total_servers, 1) if r.total_servers else None,
            }
            for r in rows
        ]
    }


@router.get("/stats/pending-updates")
async def pending_updates(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Aggregate every server's pending package list in one response, read from the
    latest stored UpdateCheck (no live SSH). Replaces the dashboard modal's sequential
    per-server /packages loop. New-dependency packages are excluded so the list count
    matches packages_available."""
    import json as _json
    from backend.query_helpers import latest_checks_by_server

    result = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = result.scalars().all()
    checks = await latest_checks_by_server(db)

    out: list[dict] = []
    for server in servers:
        check = checks.get(server.id)
        if check is None or check.status == "error" or (check.packages_available or 0) <= 0:
            continue
        packages: list[dict] = []
        if check.packages_json:
            try:
                for p in _json.loads(check.packages_json):
                    if p.get("is_new"):
                        continue
                    packages.append({
                        "name": p.get("name"),
                        "current_version": p.get("current_version", ""),
                        "available_version": p.get("available_version", ""),
                        "is_security": bool(p.get("is_security")),
                        "is_phased": bool(p.get("is_phased")),
                        "is_kernel": bool(p.get("is_kernel")),
                    })
            except Exception:
                pass
        out.append({"id": server.id, "packages": packages})
    return {"servers": out}


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
            "snapshot_name": h.snapshot_name,
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
            "snapshot_name": h.snapshot_name,
        })

    return {"total": total, "page": page, "per_page": per_page, "items": items}
