import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, UpdateCheck, User
from backend.schemas import UpdateCheckOut, PackageInfo
from backend.update_checker import check_server

router = APIRouter(prefix="/api/servers", tags=["updates"])


@router.post("/{server_id}/check")
async def trigger_check(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    server = result.scalar_one_or_none()
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    check = await check_server(server, db)
    return {"id": check.id, "status": check.status, "packages_available": check.packages_available}


@router.post("/check-all")
async def trigger_check_all(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    from backend.models import ScheduleConfig
    from backend.update_checker import check_all_servers

    cfg_result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_result.scalar_one_or_none()
    concurrency = cfg.upgrade_concurrency if cfg else 5

    result = await db.execute(select(Server).where(Server.is_enabled == True))
    servers = result.scalars().all()

    results = await check_all_servers(list(servers), db, concurrency)
    return {
        "checked": len(results),
        "results": [
            {"server_id": sid, "status": c.status, "packages_available": c.packages_available}
            for sid, c in results.items()
        ],
    }


@router.get("/{server_id}/packages")
async def get_packages(
    server_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Server).where(Server.id == server_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Server not found")

    check_result = await db.execute(
        select(UpdateCheck)
        .where(UpdateCheck.server_id == server_id)
        .order_by(UpdateCheck.checked_at.desc())
        .limit(1)
    )
    check = check_result.scalar_one_or_none()
    if check is None:
        return {"packages": [], "held": []}

    packages = []
    if check.packages_json:
        try:
            packages = json.loads(check.packages_json)
        except Exception:
            pass

    held = []
    if check.held_packages_list:
        try:
            held = json.loads(check.held_packages_list)
        except Exception:
            pass

    return {"packages": packages, "held": held, "checked_at": check.checked_at}
