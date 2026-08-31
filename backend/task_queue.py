"""
Persistent job / control-plane primitives for :class:`backend.models.Task` (issue #62).

Before this, "what is running" lived only in module-global dicts and in-memory
``asyncio.gather`` calls (see ``backend/routers/upgrades.py``) — a page reload or
a container restart lost all visibility into an in-flight fleet operation. A
``Task`` row is the durable record of one such operation: created when the work
starts, updated as it progresses, and closed out with a terminal status. This
module owns the small set of helpers that create/update/finish those rows plus
the pieces needed to wire cooperative cancellation and startup reconciliation.

It deliberately does NOT own upgrade/reboot/autoremove *execution* — that stays
in ``backend/upgrade_manager.py`` (and the per-server ``_upgrade_locks`` there
remain the single source of truth for "is something running on this server").
Callers (``backend/routers/upgrades.py``) create a Task around their existing
gather/semaphore-bounded fan-out and feed it progress/log updates; they do not
hand execution to this module.
"""

import asyncio
import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.actor import get_actor
from backend.database import AsyncSessionLocal
from backend.models import ScheduleConfig, Task

logger = logging.getLogger(__name__)

# Same convention as the 1 MB cap already applied to UpdateHistory.log_output
# (backend/upgrade_manager.py: `combined_output[:1_000_000]`) — a long-running
# fleet operation can produce a lot of apt output and must not be allowed to
# bloat the DB. We cap by keeping the *earliest* MAX_LOG_CHARS and silently
# dropping anything appended after that point, matching upgrade_manager's
# slice-from-the-front behaviour so a client polling with `log_offset` never
# sees an offset it previously received become invalid.
MAX_LOG_CHARS = 1_000_000

TERMINAL_STATUSES = {"success", "error", "cancelled", "interrupted"}


# ---------------------------------------------------------------------------
# Task lifecycle
# ---------------------------------------------------------------------------

async def create_task(
    db: AsyncSession,
    task_type: str,
    *,
    server_id: int | None = None,
    rollout_id: int | None = None,
    label: str | None = None,
    initiated_by: str | None = None,
    progress_total: int = 0,
) -> Task:
    """Create a new Task row in ``queued`` status. Does not start it."""
    task = Task(
        task_type=task_type,
        status="queued",
        server_id=server_id,
        rollout_id=rollout_id,
        label=label,
        initiated_by=initiated_by or get_actor(),
        progress_total=progress_total,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def start_task(db: AsyncSession, task_id: int) -> None:
    task = await db.get(Task, task_id)
    if task is None:
        return
    task.status = "running"
    task.started_at = datetime.utcnow()
    await db.commit()


async def update_task_progress(
    db: AsyncSession,
    task_id: int,
    *,
    done: int | None = None,
    total: int | None = None,
    detail: str | None = None,
) -> None:
    task = await db.get(Task, task_id)
    if task is None:
        return
    if done is not None:
        task.progress_done = done
    if total is not None:
        task.progress_total = total
    if detail is not None:
        task.detail = detail
    await db.commit()


async def increment_task_progress(db: AsyncSession, task_id: int, *, detail: str | None = None) -> None:
    """Bump progress_done by one — the common case of "one more server finished"."""
    task = await db.get(Task, task_id)
    if task is None:
        return
    task.progress_done = (task.progress_done or 0) + 1
    if detail is not None:
        task.detail = detail
    await db.commit()


async def append_task_log(db: AsyncSession, task_id: int, text: str) -> None:
    """Append *text* to the task's transcript, capped at MAX_LOG_CHARS (see above)."""
    if not text:
        return
    task = await db.get(Task, task_id)
    if task is None:
        return
    current = task.log_output or ""
    if len(current) >= MAX_LOG_CHARS:
        return  # already at cap — drop further output silently, same as UpdateHistory
    task.log_output = (current + text)[:MAX_LOG_CHARS]
    await db.commit()


async def finish_task(db: AsyncSession, task_id: int, status: str, *, detail: str | None = None) -> None:
    if status not in TERMINAL_STATUSES:
        raise ValueError(f"finish_task: '{status}' is not a terminal status {sorted(TERMINAL_STATUSES)}")
    task = await db.get(Task, task_id)
    if task is None:
        return
    task.status = status
    task.finished_at = datetime.utcnow()
    if detail is not None:
        task.detail = detail
    await db.commit()


# ---------------------------------------------------------------------------
# Cooperative cancellation
# ---------------------------------------------------------------------------

async def request_cancel(db: AsyncSession, task_id: int) -> Task | None:
    """Flag *task_id* for cooperative cancellation.

    Returns the Task row, or None if it doesn't exist or is already terminal
    (callers use this to distinguish "not found" from "already finished").
    """
    task = await db.get(Task, task_id)
    if task is None or task.status in TERMINAL_STATUSES:
        return None
    task.cancel_requested = True
    await db.commit()
    await db.refresh(task)
    return task


async def is_cancel_requested(task_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        task = await db.get(Task, task_id)
        return bool(task and task.cancel_requested)


def watch_task_cancel(task_id: int, cancel_event: asyncio.Event, interval: float = 2.0) -> asyncio.Task:
    """Background task: poll ``Task.cancel_requested`` and set *cancel_event* when seen.

    The fleet WS streams in ``backend/routers/upgrades.py`` already support a
    same-socket cancel (``{"action": "cancel"}``) via a local ``cancel_event`` —
    "stop after the in-flight server completes, never kill a running apt
    transaction". This helper lets ``POST /api/tasks/{id}/cancel`` (e.g. from a
    client that reloaded and no longer holds the original WebSocket) reach the
    same ``cancel_event`` by polling the durable flag instead. Caller is
    responsible for cancelling the returned asyncio.Task once the run ends.
    """
    async def _poll():
        try:
            while not cancel_event.is_set():
                await asyncio.sleep(interval)
                if await is_cancel_requested(task_id):
                    cancel_event.set()
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("watch_task_cancel: poll failed for task %d", task_id)

    return asyncio.create_task(_poll())


# ---------------------------------------------------------------------------
# Log transcript buffering
# ---------------------------------------------------------------------------

class TaskLogWriter:
    """Buffers a task's streamed output in memory and flushes it periodically.

    A fleet-wide WS stream can emit thousands of output lines across several
    concurrently-upgrading servers; committing a DB write per line against the
    single shared SQLite file would serialize every server behind that write
    and risks "database is locked" contention. Callers push text with
    ``write()`` (sync, cheap) and this flushes on a timer plus once more on
    ``close()``, so the persisted transcript lags live output by at most
    ``flush_interval`` seconds instead of being written line-by-line.
    """

    def __init__(self, task_id: int, flush_interval: float = 2.0):
        self.task_id = task_id
        self._buffer: list[str] = []
        self._flush_interval = flush_interval
        self._flusher: asyncio.Task | None = None
        self._closed = False

    def write(self, text: str) -> None:
        if text:
            self._buffer.append(text)

    async def _flush(self) -> None:
        if not self._buffer:
            return
        pending = "".join(self._buffer)
        self._buffer = []
        try:
            async with AsyncSessionLocal() as db:
                await append_task_log(db, self.task_id, pending)
        except Exception:
            logger.exception("TaskLogWriter: flush failed for task %d", self.task_id)

    async def _loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self._flush_interval)
                await self._flush()
        except asyncio.CancelledError:
            pass

    def start(self) -> None:
        self._flusher = asyncio.create_task(self._loop())

    async def close(self) -> None:
        """Stop the periodic flusher and flush whatever remains, once."""
        self._closed = True
        if self._flusher is not None:
            self._flusher.cancel()
            try:
                await self._flusher
            except (asyncio.CancelledError, Exception):
                pass
        await self._flush()


def format_task_log_line(msg: dict) -> str:
    """Render one WS protocol message (see routers/upgrades.py's ``send_fn`` shape)
    as a line for the task's persisted transcript.

    ``{"type": "output", "data": <str>}`` carries raw command output and is
    passed through as-is; the other message types (status/skipped/error/complete)
    carry a short string or small dict in ``data`` and are summarised so the
    transcript reads like the on-screen log instead of raw JSON.
    """
    mtype = msg.get("type", "")
    server_name = msg.get("server_name")
    prefix = f"[{server_name}] " if server_name else ""
    data = msg.get("data")
    if data is None:
        # Some messages (e.g. the rolling-reboot stream) carry the interesting
        # bit in "phase" rather than "data" — fall back to it for a readable line.
        data = msg.get("phase")

    if mtype == "output":
        return data if isinstance(data, str) else ""
    if mtype == "status":
        return f"{prefix}--- {data} ---\n"
    if mtype == "skipped":
        return f"{prefix}SKIPPED: {data}\n"
    if mtype == "error":
        return f"{prefix}ERROR: {data}\n"
    if mtype == "complete":
        if isinstance(data, dict):
            return f"{prefix}complete (success={data.get('success')})\n"
        return f"{prefix}complete: {data}\n" if data else f"{prefix}complete\n"
    return ""


# ---------------------------------------------------------------------------
# Concurrency helper
# ---------------------------------------------------------------------------

async def get_upgrade_concurrency(db: AsyncSession) -> int:
    """Read ``ScheduleConfig.upgrade_concurrency`` (default 5), the single knob
    every fleet-wide operation already bounds itself by."""
    cfg = (await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))).scalar_one_or_none()
    return (cfg.upgrade_concurrency if cfg else 5) or 5


async def run_bounded(items: list, worker, concurrency: int) -> list:
    """Run ``worker(item)`` for every item in *items*, at most *concurrency* at
    once. A small shared primitive so a *new* task-queue-driven entry point
    doesn't need to hand-roll its own semaphore+gather — the existing fleet WS
    streams in routers/upgrades.py already have their own well-tested version
    of this pattern inline and are left as-is (see module docstring).
    """
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def _run(item):
        async with semaphore:
            return await worker(item)

    return await asyncio.gather(*[_run(i) for i in items], return_exceptions=True)


# ---------------------------------------------------------------------------
# Startup reconciliation
# ---------------------------------------------------------------------------

async def reconcile_interrupted_tasks() -> int:
    """Mark any Task left ``queued``/``running`` from a previous process as
    ``interrupted``.

    Call once from ``main.py``'s startup, after ``init_db()``. A restart drops
    every in-memory piece a running Task depended on — the WS connection, the
    ``_upgrade_locks`` entry, the semaphore slot, any open SSH session — so
    there is no live work left to reconcile against (unlike ``Rollout`` steps,
    which are DateTrigger-driven and can be rescheduled). Returns the number of
    rows updated.
    """
    updated = 0
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Task).where(Task.status.in_(["queued", "running"])))
        stale = list(result.scalars().all())
        if not stale:
            return 0
        now = datetime.utcnow()
        for task in stale:
            task.status = "interrupted"
            task.finished_at = now
            note = (
                "Interrupted by an apt-ui restart — its progress and any in-flight "
                "SSH work were lost; check the affected server(s) manually and retry if needed."
            )
            task.detail = f"{task.detail} {note}" if task.detail else note
            updated += 1
        await db.commit()
    logger.warning("Task queue: marked %d stale task(s) as interrupted after restart", updated)
    return updated
