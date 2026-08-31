"""
REST surface for the persistent job / control-plane Task queue (issue #62).

A Task row is created by the fleet operations in ``backend/routers/upgrades.py``
(and, going forward, other long-running entry points) via ``backend.task_queue``.
This router only reads/paginates/cancels those rows — it never runs work itself.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import Server, Task, User
from backend.task_queue import request_cancel
from backend.timeutil import utc_iso

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _task_summary(task: Task, server_name: str | None) -> dict:
    return {
        "id": task.id,
        "task_type": task.task_type,
        "status": task.status,
        "server_id": task.server_id,
        "server_name": server_name,
        "rollout_id": task.rollout_id,
        "label": task.label,
        "initiated_by": task.initiated_by,
        "created_at": utc_iso(task.created_at),
        "started_at": utc_iso(task.started_at),
        "finished_at": utc_iso(task.finished_at),
        "progress_done": task.progress_done,
        "progress_total": task.progress_total,
        "detail": task.detail,
        "cancel_requested": task.cancel_requested,
    }


@router.get("")
async def list_tasks(
    status: str | None = Query(default=None, description="Filter by status: queued/running/success/error/cancelled/interrupted"),
    task_type: str | None = Query(default=None, description="Filter by task_type, e.g. upgrade / upgrade_all / reboot_all / autoremove_all"),
    server_id: int | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Newest-first, paginated. Mirrors the page/per_page/total/items shape used
    by /api/stats/history and /api/notifications/history."""
    offset = (page - 1) * per_page

    base_q = select(Task)
    count_q = select(func.count()).select_from(Task)
    if status is not None:
        base_q = base_q.where(Task.status == status)
        count_q = count_q.where(Task.status == status)
    if task_type is not None:
        base_q = base_q.where(Task.task_type == task_type)
        count_q = count_q.where(Task.task_type == task_type)
    if server_id is not None:
        base_q = base_q.where(Task.server_id == server_id)
        count_q = count_q.where(Task.server_id == server_id)

    result = await db.execute(
        base_q.order_by(Task.created_at.desc()).offset(offset).limit(per_page)
    )
    rows = result.scalars().all()

    total = (await db.execute(count_q)).scalar_one()

    server_ids = {t.server_id for t in rows if t.server_id is not None}
    srv_map: dict[int, str] = {}
    if server_ids:
        srv_res = await db.execute(select(Server).where(Server.id.in_(server_ids)))
        srv_map = {s.id: s.name for s in srv_res.scalars().all()}

    items = [_task_summary(t, srv_map.get(t.server_id) if t.server_id is not None else None) for t in rows]
    return {"total": total, "page": page, "per_page": per_page, "items": items}


@router.get("/{task_id}")
async def get_task(
    task_id: int,
    log_offset: int = Query(
        default=0, ge=0,
        description="Character offset into the task's log — pass the previous "
                     "response's log_next_offset to fetch only new output instead "
                     "of refetching the whole transcript.",
    ),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    task = await db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    server_name = None
    if task.server_id is not None:
        server = await db.get(Server, task.server_id)
        server_name = server.name if server else None

    full_log = task.log_output or ""
    log_tail = full_log[log_offset:] if log_offset <= len(full_log) else ""

    out = _task_summary(task, server_name)
    out["log"] = log_tail
    out["log_length"] = len(full_log)
    out["log_next_offset"] = len(full_log)
    return out


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Cooperative cancellation: flags the task so the running fleet stream stops
    after its in-flight server finishes (never mid-transaction). See
    ``backend.task_queue.watch_task_cancel`` for how the running stream picks
    this up, and the WS handlers in ``backend/routers/upgrades.py`` for the
    existing same-socket cancel this reuses.
    """
    existing = await db.get(Task, task_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if existing.status in ("success", "error", "cancelled", "interrupted"):
        raise HTTPException(status_code=409, detail=f"Task already finished ({existing.status})")

    task = await request_cancel(db, task_id)
    if task is None:
        # Finished between the check above and now — treat as a 409, not a 404.
        raise HTTPException(status_code=409, detail="Task already finished")

    server_name = None
    if task.server_id is not None:
        server = await db.get(Server, task.server_id)
        server_name = server.name if server else None
    return _task_summary(task, server_name)
