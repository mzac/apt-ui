"""
Control API for durable staged rollouts (issue #62).

Read endpoints (list/get) are available to any authenticated user, matching
the rest of the read surface (History, Reports, Tasks). The mutating
promote/pause/resume/abort actions are admin-gated and set the actor
(``backend.actor.set_actor``) before touching the DB so ``Rollout.detail``'s
audit trail, and any ``Task`` rows a promoted step creates, are attributed to
the acting admin rather than a stale/default actor — CLAUDE.md's
actor-attribution convention ("new background entry points must set_actor(...)
or they'll log a stale/empty actor").

This router only reads/serializes rows and calls into ``backend.rollout`` for
every state transition — it never drives ring execution itself.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import rollout as rollout_mod
from backend.actor import set_actor
from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import Rollout, RolloutStep, Server, Task, User
from backend.timeutil import utc_iso

router = APIRouter(prefix="/api/rollouts", tags=["rollouts"])
logger = logging.getLogger(__name__)


def _json_list(raw: str | None) -> list:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _step_summary(step: RolloutStep, server_names: dict[int, str] | None = None) -> dict:
    server_ids = _json_list(step.server_ids_json)
    out = {
        "id": step.id,
        "rollout_id": step.rollout_id,
        "step_index": step.step_index,
        "ring_name": step.ring_name,
        "status": step.status,
        "scheduled_at": utc_iso(step.scheduled_at),
        "started_at": utc_iso(step.started_at),
        "finished_at": utc_iso(step.finished_at),
        "server_ids": server_ids,
        "detail": step.detail,
    }
    if server_names is not None:
        out["server_names"] = [server_names.get(i, f"#{i}") for i in server_ids]
    return out


def _rollout_summary(rollout: Rollout) -> dict:
    try:
        config = json.loads(rollout.config_json or "{}")
    except (json.JSONDecodeError, TypeError):
        config = {}
    return {
        "id": rollout.id,
        "kind": rollout.kind,
        "status": rollout.status,
        "created_at": utc_iso(rollout.created_at),
        "started_at": utc_iso(rollout.started_at),
        "finished_at": utc_iso(rollout.finished_at),
        "initiated_by": rollout.initiated_by,
        "config": config,
        "detail": rollout.detail,
    }


async def _server_name_map(db: AsyncSession, server_ids: set[int]) -> dict[int, str]:
    if not server_ids:
        return {}
    res = await db.execute(select(Server).where(Server.id.in_(server_ids)))
    return {s.id: s.name for s in res.scalars().all()}


@router.get("")
async def list_rollouts(
    status: str | None = None,
    kind: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Newest-first. Each rollout is returned with its steps inline so the
    Rollouts page can render per-ring status/timing without N+1 requests."""
    q = select(Rollout).order_by(Rollout.created_at.desc()).limit(max(1, min(limit, 500)))
    if status:
        q = q.where(Rollout.status == status)
    if kind:
        q = q.where(Rollout.kind == kind)
    rollouts = (await db.execute(q)).scalars().all()
    if not rollouts:
        return []

    rollout_ids = [r.id for r in rollouts]
    steps = (await db.execute(
        select(RolloutStep).where(RolloutStep.rollout_id.in_(rollout_ids)).order_by(RolloutStep.step_index)
    )).scalars().all()

    all_server_ids: set[int] = set()
    for s in steps:
        all_server_ids.update(_json_list(s.server_ids_json))
    srv_map = await _server_name_map(db, all_server_ids)

    steps_by_rollout: dict[int, list[RolloutStep]] = {}
    for s in steps:
        steps_by_rollout.setdefault(s.rollout_id, []).append(s)

    out = []
    for r in rollouts:
        item = _rollout_summary(r)
        item["steps"] = [_step_summary(s, srv_map) for s in steps_by_rollout.get(r.id, [])]
        out.append(item)
    return out


@router.get("/{rollout_id}")
async def get_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """One rollout with its steps and the ``Task`` rows created for it (each
    ring's per-server upgrade work is tracked as a ``Task`` via
    ``Task.rollout_id`` — see ``backend/rollout.py``'s ``_execute_step``)."""
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None:
        raise HTTPException(status_code=404, detail="Rollout not found")

    steps = (await db.execute(
        select(RolloutStep).where(RolloutStep.rollout_id == rollout_id).order_by(RolloutStep.step_index)
    )).scalars().all()
    tasks = (await db.execute(
        select(Task).where(Task.rollout_id == rollout_id).order_by(Task.created_at)
    )).scalars().all()

    all_server_ids: set[int] = {t.server_id for t in tasks if t.server_id is not None}
    for s in steps:
        all_server_ids.update(_json_list(s.server_ids_json))
    srv_map = await _server_name_map(db, all_server_ids)

    out = _rollout_summary(rollout)
    out["steps"] = [_step_summary(s, srv_map) for s in steps]
    out["tasks"] = [
        {
            "id": t.id,
            "task_type": t.task_type,
            "status": t.status,
            "server_id": t.server_id,
            "server_name": srv_map.get(t.server_id) if t.server_id is not None else None,
            "label": t.label,
            "progress_done": t.progress_done,
            "progress_total": t.progress_total,
            "started_at": utc_iso(t.started_at),
            "finished_at": utc_iso(t.finished_at),
            "detail": t.detail,
        }
        for t in tasks
    ]
    return out


def _control_error(exc: ValueError) -> HTTPException:
    code = 404 if str(exc) == "not_found" else 409
    detail = "Rollout not found" if code == 404 else str(exc)
    return HTTPException(status_code=code, detail=detail)


@router.post("/{rollout_id}/promote")
async def promote_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Run the next pending/scheduled ring immediately instead of waiting for
    its due time."""
    set_actor(user.username)
    try:
        rollout = await rollout_mod.promote_now(db, rollout_id, actor=user.username)
    except ValueError as exc:
        raise _control_error(exc)
    return _rollout_summary(rollout)


@router.post("/{rollout_id}/pause")
async def pause_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Prevent the next ring from starting. A ring already in flight always
    finishes — this only withholds the *next* one, same "stop after current"
    semantics as the fleet WS streams' cancel support."""
    set_actor(user.username)
    try:
        rollout = await rollout_mod.pause_rollout(db, rollout_id, actor=user.username)
    except ValueError as exc:
        raise _control_error(exc)
    return _rollout_summary(rollout)


@router.post("/{rollout_id}/resume")
async def resume_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    set_actor(user.username)
    try:
        rollout = await rollout_mod.resume_rollout(db, rollout_id, actor=user.username)
    except ValueError as exc:
        raise _control_error(exc)
    return _rollout_summary(rollout)


@router.post("/{rollout_id}/abort")
async def abort_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Halt the rollout for good. Any not-yet-started step is marked
    ``cancelled``; a step already running finishes on its own."""
    set_actor(user.username)
    try:
        rollout = await rollout_mod.abort_rollout(db, rollout_id, actor=user.username)
    except ValueError as exc:
        raise _control_error(exc)
    return _rollout_summary(rollout)
