"""
Pre/post-upgrade hooks (issue #29).

Hooks are shell commands run on the managed server via SSH:
- pre-hook failure (non-zero exit) aborts the upgrade
- post-hook always runs after the apt-get phase, even on failure

Use cases:
- Pre: stop a service before its package upgrades (e.g. systemctl stop nginx)
- Post: restart, run a smoke test, send a custom notification
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import Server, UpgradeHook, User

router = APIRouter(prefix="/api/hooks", tags=["hooks"])


def _serialize(h: UpgradeHook) -> dict:
    return {
        "id": h.id,
        "server_id": h.server_id,
        "name": h.name,
        "phase": h.phase,
        "command": h.command,
        "sort_order": h.sort_order,
        "enabled": h.enabled,
        "created_at": h.created_at,
    }


@router.get("")
async def list_hooks(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    res = await db.execute(select(UpgradeHook).order_by(UpgradeHook.sort_order, UpgradeHook.id))
    return [_serialize(h) for h in res.scalars().all()]


@router.post("", status_code=201)
async def create_hook(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    name = (body.get("name") or "").strip()
    phase = (body.get("phase") or "").strip()
    command = (body.get("command") or "").strip()
    if not name or phase not in ("pre", "post") or not command:
        raise HTTPException(status_code=400, detail="Name, phase ('pre'|'post'), and command required")

    sid = body.get("server_id")
    if sid is not None:
        srv = (await db.execute(select(Server).where(Server.id == sid))).scalar_one_or_none()
        if srv is None:
            raise HTTPException(status_code=404, detail="Server not found")

    h = UpgradeHook(
        server_id=sid,
        name=name,
        phase=phase,
        command=command,
        sort_order=int(body.get("sort_order", 0)),
        enabled=bool(body.get("enabled", True)),
    )
    db.add(h)
    await db.commit()
    await db.refresh(h)
    return _serialize(h)


@router.put("/{hook_id}")
async def update_hook(
    hook_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(select(UpgradeHook).where(UpgradeHook.id == hook_id))
    h = res.scalar_one_or_none()
    if h is None:
        raise HTTPException(status_code=404, detail="Hook not found")
    if "name" in body and body["name"]:
        h.name = body["name"].strip()
    if "phase" in body and body["phase"] in ("pre", "post"):
        h.phase = body["phase"]
    if "command" in body and body["command"]:
        h.command = body["command"]
    if "sort_order" in body:
        h.sort_order = int(body["sort_order"])
    if "enabled" in body:
        h.enabled = bool(body["enabled"])
    if "server_id" in body:
        h.server_id = body["server_id"]
    await db.commit()
    await db.refresh(h)
    return _serialize(h)


@router.delete("/{hook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_hook(
    hook_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(select(UpgradeHook).where(UpgradeHook.id == hook_id))
    h = res.scalar_one_or_none()
    if h is None:
        raise HTTPException(status_code=404, detail="Hook not found")
    await db.delete(h)
    await db.commit()
