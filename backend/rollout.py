"""
Durable, DateTrigger-driven staged rollouts (issue #62).

Problem this replaces: the staged auto-upgrade in ``backend/scheduler.py``
used to drive ring-by-ring promotion with an in-process
``await asyncio.sleep(ring_delay_hours * 3600)`` inside one long-lived
coroutine. A container restart mid-sleep silently dropped every remaining
ring — there was no persisted record a rollout was even in progress, so
nothing ever surfaced the fact it just stopped.

This module is the single source of truth for:

  - ring-tag grouping (:func:`group_servers_by_ring`) — previously
    duplicated between ``backend/scheduler.py``'s ``_job_auto_upgrade`` and
    ``backend/routers/upgrades.py``'s ``ws_reboot_all``
    (``_group_servers_by_ring``). Both now call this helper, per the
    CLAUDE.md warning to keep the two in sync.
  - persisting a ``Rollout`` + one ``RolloutStep`` per ring up front
    (:func:`start_auto_upgrade_rollout`)
  - driving promotion with APScheduler ``DateTrigger`` jobs instead of an
    in-process sleep (:func:`_run_step_job` / :func:`_execute_step`)
  - the ring-level canary/health gate that decides whether to promote or
    halt — the same "new failed systemd units only" + "any UpdateHistory
    error in the ring" checks that used to be inlined in
    ``_job_auto_upgrade`` (:func:`get_failed_systemd_units`,
    :func:`ring_has_history_errors`)
  - startup reconciliation (:func:`reconcile_rollouts`) — re-arms
    APScheduler jobs for steps still due in the future, and steps whose due
    time already passed while the process was down fire almost immediately
    once the scheduler starts (APScheduler's in-memory jobstore does not
    survive a restart, unlike this module's ground truth: the DB rows)
  - "queue this server for its next maintenance-window opening" instead of
    dropping it from the run (:func:`queue_server_for_next_window`), built
    on the same Rollout/RolloutStep persistence rather than a parallel
    mechanism, computing "when does it next open" by reusing
    ``backend.routers.maintenance.is_in_window`` for the actual bitmask /
    midnight-wraparound time math (this module only does the forward scan)
  - rollout control operations (:func:`promote_now`, :func:`pause_rollout`,
    :func:`resume_rollout`, :func:`abort_rollout`) called by
    ``backend/routers/rollouts.py``

``backend/routers/rollouts.py`` owns the HTTP surface (serialization, auth,
admin gating) only; this module owns the state machine and scheduling.
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.triggers.date import DateTrigger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.actor import get_actor, set_actor
from backend.config import TZ, now_local
from backend.database import AsyncSessionLocal
from backend.models import Rollout, RolloutStep, Server, Tag, ServerTag, UpdateHistory
from backend.timeutil import utc_iso

logger = logging.getLogger(__name__)

# Rollout.status values that represent "still alive" — used to guard against
# double-aborting/double-completing an already-terminal rollout.
ACTIVE_ROLLOUT_STATUSES = {"pending", "running", "paused"}


# ---------------------------------------------------------------------------
# Ring grouping — single source of truth (see module docstring)
# ---------------------------------------------------------------------------

async def group_servers_by_ring(
    db: AsyncSession, servers: list[Server], *, apply_order_tag: bool = True,
) -> dict[str, list[Server]]:
    """Group *servers* by their ``ring:*`` tag (``ring:default`` when absent).

    When *apply_order_tag* is set (the default), servers within each ring are
    additionally sorted by an optional ``order:N`` tag (lower first, default
    100) then by name — this lets dependency-ordered hosts (e.g. a DB replica
    before its primary, or HA members one at a time) patch in a safe sequence
    within a ring (issue #62).
    """
    if not servers:
        return {}

    like_clause = Tag.name.like("ring:%")
    if apply_order_tag:
        like_clause = Tag.name.like("ring:%") | Tag.name.like("order:%")

    rings: dict[str, list[Server]] = {}
    order_of: dict[int, int] = {}
    for s in servers:
        tag_res = await db.execute(
            select(Tag.name).join(ServerTag, ServerTag.tag_id == Tag.id)
            .where(ServerTag.server_id == s.id, like_clause)
        )
        names = [r for (r,) in tag_res.all()]
        ring_tags = sorted(n for n in names if n.startswith("ring:"))
        ring = ring_tags[0] if ring_tags else "ring:default"
        if apply_order_tag:
            order_tags = [n for n in names if n.startswith("order:")]
            try:
                order_of[s.id] = int(order_tags[0].split(":", 1)[1]) if order_tags else 100
            except (ValueError, IndexError):
                order_of[s.id] = 100
        rings.setdefault(ring, []).append(s)

    if apply_order_tag:
        for ring_name in rings:
            rings[ring_name].sort(key=lambda srv: (order_of.get(srv.id, 100), srv.name))

    return rings


# ---------------------------------------------------------------------------
# Canary / ring health gate — the model everyone should reuse (CLAUDE.md)
# ---------------------------------------------------------------------------

async def get_failed_systemd_units(server: Server) -> set[str]:
    """Return the set of failed systemd units (empty if the probe is unavailable).

    Moved here from ``backend/scheduler.py``'s ``_job_auto_upgrade`` closure
    (``_failed_units``) so the rollout driver, which now owns ring promotion,
    and any future caller share one implementation instead of a second
    hand-rolled copy.
    """
    from backend.ssh_manager import run_command, sudo_prefix
    sudo = sudo_prefix(server)
    res = await run_command(
        server,
        f"{sudo}systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{{print $1}}'",
        timeout=30,
    )
    if res.exit_code != 0:
        return set()  # probe unavailable — don't manufacture a degradation
    return {ln.strip() for ln in (res.stdout or "").splitlines() if ln.strip()}


async def ring_has_history_errors(db: AsyncSession, server_ids: list[int], since: datetime) -> bool:
    """True if any of *server_ids* has an ``UpdateHistory`` error since *since*."""
    if not server_ids:
        return False
    res = await db.execute(
        select(UpdateHistory).where(
            UpdateHistory.server_id.in_(server_ids),
            UpdateHistory.started_at >= since,
            UpdateHistory.status == "error",
        )
    )
    return len(list(res.scalars().all())) > 0


# ---------------------------------------------------------------------------
# APScheduler job bookkeeping
# ---------------------------------------------------------------------------

def _job_id(rollout_id: int, step_index: int) -> str:
    return f"rollout_step_{rollout_id}_{step_index}"


def _schedule_step_job(rollout_id: int, step_index: int, run_at_utc: datetime) -> None:
    """Register (or replace) the APScheduler DateTrigger job that will execute
    one rollout step. *run_at_utc* must be timezone-aware (UTC) — the actual
    ring-promotion delay is always computed in UTC so it is immune to the
    configured ``TZ`` (a DST transition inside a 24h wait must not shift when
    the ring actually promotes)."""
    from backend.scheduler import get_scheduler
    sched = get_scheduler()
    sched.add_job(
        _run_step_job,
        DateTrigger(run_date=run_at_utc),
        id=_job_id(rollout_id, step_index),
        replace_existing=True,
        kwargs={"rollout_id": rollout_id, "step_index": step_index},
        # No grace-time cutoff: a step whose time already passed (the process
        # was down) must still fire, not be silently dropped — reconciliation
        # relies on this rather than on APScheduler's own persistence, since
        # the default in-memory jobstore has nothing left after a restart.
        misfire_grace_time=None,
    )


def _remove_future_jobs(rollout_id: int) -> None:
    """Best-effort removal of any not-yet-fired step job for *rollout_id*
    (used by pause/abort so a stale delay doesn't fire after the fact)."""
    from backend.scheduler import get_scheduler
    sched = get_scheduler()
    for job in sched.get_jobs():
        if job.id.startswith(f"rollout_step_{rollout_id}_"):
            try:
                job.remove()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Plan creation
# ---------------------------------------------------------------------------

async def start_auto_upgrade_rollout(
    db: AsyncSession,
    servers: list[Server],
    *,
    action: str,
    allow_phased: bool,
    conffile_action: str,
    canary: bool,
    ring_delay_hours: int,
    initiated_by: str | None = None,
) -> Rollout | None:
    """Persist the plan for a staged auto-upgrade and kick off ring 0 immediately.

    Every ring is written up front as a ``RolloutStep``; promotion between
    rings is driven by APScheduler ``DateTrigger`` jobs (:func:`_run_step_job`)
    rather than a sleeping coroutine, so a restart has something durable to
    reconcile against (:func:`reconcile_rollouts`). Returns ``None`` if there
    is nothing to upgrade.
    """
    if not servers:
        return None
    rings = await group_servers_by_ring(db, servers)
    ring_names = sorted(rings.keys())
    if not ring_names:
        return None

    rollout = Rollout(
        kind="auto_upgrade",
        status="running",
        started_at=datetime.utcnow(),
        initiated_by=initiated_by or get_actor(),
        config_json=json.dumps({
            "action": action,
            "allow_phased": allow_phased,
            "conffile_action": conffile_action,
            "canary": canary,
            "ring_delay_hours": ring_delay_hours,
        }),
    )
    db.add(rollout)
    await db.commit()
    await db.refresh(rollout)

    now_utc = datetime.now(timezone.utc)
    for idx, ring_name in enumerate(ring_names):
        step = RolloutStep(
            rollout_id=rollout.id,
            step_index=idx,
            ring_name=ring_name,
            status="scheduled" if idx == 0 else "pending",
            scheduled_at=now_utc.replace(tzinfo=None) if idx == 0 else None,
            server_ids_json=json.dumps([s.id for s in rings[ring_name]]),
        )
        db.add(step)
    await db.commit()

    _schedule_step_job(rollout.id, 0, now_utc)
    logger.info(
        "Rollout %d: started (%d ring(s): %s)", rollout.id, len(ring_names), ", ".join(ring_names),
    )
    return rollout


async def queue_server_for_next_window(
    db: AsyncSession,
    server: Server,
    *,
    action: str,
    allow_phased: bool,
    conffile_action: str,
    initiated_by: str | None = None,
) -> tuple[Rollout, RolloutStep] | None:
    """Persist a single-server, single-step rollout scheduled for the next
    time *server* is clear of every active maintenance window, instead of
    dropping it from the current run with a bare ``skipped`` message
    (issue #62). Reuses the same Rollout/RolloutStep persistence + DateTrigger
    driving as the ring-based staged rollout — a "rollout" here just happens
    to have exactly one ring with exactly one server in it.

    Returns ``None`` if there is no active window to wait out (caller
    shouldn't have called this) or the 14-day scan guard gave up.
    """
    next_open_local = await compute_next_window_opening(db, server.id)
    if next_open_local is None:
        return None
    next_open_utc = next_open_local.astimezone(timezone.utc)

    rollout = Rollout(
        kind="queued_upgrade",
        status="running",
        started_at=datetime.utcnow(),
        initiated_by=initiated_by or get_actor(),
        config_json=json.dumps({
            "action": action,
            "allow_phased": allow_phased,
            "conffile_action": conffile_action,
            "canary": False,
            "ring_delay_hours": 0,
        }),
        detail=f"Queued {server.name} for its next maintenance-window opening ({utc_iso(next_open_utc.replace(tzinfo=None))})",
    )
    db.add(rollout)
    await db.commit()
    await db.refresh(rollout)

    step = RolloutStep(
        rollout_id=rollout.id,
        step_index=0,
        ring_name=f"queued:{server.name}",
        status="scheduled",
        scheduled_at=next_open_utc.replace(tzinfo=None),
        server_ids_json=json.dumps([server.id]),
    )
    db.add(step)
    await db.commit()
    await db.refresh(step)

    _schedule_step_job(rollout.id, 0, next_open_utc)
    logger.info("Rollout %d: queued %s for next window opening at %s", rollout.id, server.name, utc_iso(step.scheduled_at))
    return rollout, step


async def compute_next_window_opening(
    db: AsyncSession, server_id: int, after: datetime | None = None,
) -> datetime | None:
    """Return the next local-time instant at which *server_id* is NOT blocked
    by any enabled maintenance window (per-server or global), scanning
    forward from *after* (default: now).

    Reuses :func:`backend.routers.maintenance.is_in_window` for the actual
    bitmask/midnight-wraparound time math instead of re-deriving it — this
    function only does the forward minute-by-minute scan. Returns ``after``
    unchanged if no window currently applies, and ``None`` if every window
    covers the next 14 days solid (misconfiguration guard).
    """
    from backend.routers.maintenance import is_in_window
    from backend.models import MaintenanceWindow

    res = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.enabled == True))
    windows = [w for w in res.scalars().all() if w.server_id in (None, server_id)]

    probe = after or now_local()
    if not windows:
        return probe

    # Maintenance windows are defined in whole minutes (start_minutes/
    # end_minutes), so stepping minute-by-minute cannot skip over an opening.
    for _ in range(14 * 24 * 60):
        if not any(is_in_window(w, probe) for w in windows):
            return probe
        probe = probe + timedelta(minutes=1)
    return None


# ---------------------------------------------------------------------------
# Step execution — the APScheduler entry point
# ---------------------------------------------------------------------------

async def _run_step_job(rollout_id: int, step_index: int) -> None:
    """APScheduler entry point. Runs one ring's upgrades then schedules (or
    doesn't) the next step. Wrapped so any exception is caught and recorded
    rather than silently killing the scheduler's job.

    Actor attribution (CLAUDE.md): this runs with no HTTP/WS request behind
    it, so it must set the actor itself — same convention as
    ``_job_auto_upgrade``/``_job_check_all``.
    """
    set_actor("scheduled")
    try:
        await _execute_step(rollout_id, step_index)
    except Exception:
        logger.exception("Rollout %d step %d failed unexpectedly", rollout_id, step_index)
        try:
            async with AsyncSessionLocal() as db:
                await _abort_rollout(db, rollout_id, detail=f"Step {step_index} raised an unexpected exception — see server log")
        except Exception:
            logger.exception("Rollout %d: failed to record abort after step %d exception", rollout_id, step_index)


async def _execute_step(rollout_id: int, step_index: int) -> None:
    from backend.task_queue import create_task, start_task, finish_task, increment_task_progress, get_upgrade_concurrency
    from backend.upgrade_manager import upgrade_server

    async with AsyncSessionLocal() as db:
        rollout = await db.get(Rollout, rollout_id)
        step = (await db.execute(
            select(RolloutStep).where(RolloutStep.rollout_id == rollout_id, RolloutStep.step_index == step_index)
        )).scalar_one_or_none()
        if rollout is None or step is None:
            return
        if rollout.status != "running":
            # Paused/aborted/cancelled between scheduling and firing — a paused
            # rollout's next step must not silently run just because its
            # DateTrigger already fired; pause/resume/abort own this rollout's
            # state from here.
            logger.info("Rollout %d step %d skipped — rollout status is %s", rollout_id, step_index, rollout.status)
            return
        if step.status != "scheduled":
            return  # already handled (promoted manually, or reconciled elsewhere)

        cfg = json.loads(rollout.config_json or "{}")
        action = cfg.get("action", "upgrade")
        allow_phased = cfg.get("allow_phased", False)
        conffile_action = cfg.get("conffile_action", "confdef_confold")
        canary = cfg.get("canary", False)
        ring_delay_hours = cfg.get("ring_delay_hours", 24)

        server_ids: list[int] = json.loads(step.server_ids_json or "[]")
        srv_res = await db.execute(select(Server).where(Server.id.in_(server_ids)))
        ring_servers = list(srv_res.scalars().all())

        step.status = "running"
        step.started_at = datetime.utcnow()
        await db.commit()

        concurrency = await get_upgrade_concurrency(db)
        task = await create_task(
            db, "rollout_step", rollout_id=rollout_id,
            label=f"Rollout {rollout_id} — {step.ring_name}",
            initiated_by="scheduled", progress_total=len(ring_servers),
        )
        task_id = task.id
        await start_task(db, task_id)

    if not ring_servers:
        async with AsyncSessionLocal() as fdb:
            await finish_task(fdb, task_id, "success", detail="Ring had no servers")
        await _finish_step_and_promote(rollout_id, step_index, ring_delay_hours)
        return

    semaphore = asyncio.Semaphore(max(1, concurrency))

    baseline: dict[int, set[str]] = {}
    if canary:
        for s in ring_servers:
            baseline[s.id] = await get_failed_systemd_units(s)

    async def _do(server: Server) -> None:
        async with semaphore:
            async with AsyncSessionLocal() as sdb:
                await upgrade_server(
                    server, sdb,
                    action=action, allow_phased=allow_phased,
                    conffile_action=conffile_action, initiated_by="scheduled",
                    skip_notify=True,  # per-server emails would spam every ring; the fleet already gets the daily summary
                )
            async with AsyncSessionLocal() as pdb:
                await increment_task_progress(pdb, task_id)

    if canary and len(ring_servers) > 1:
        # Canary: upgrade the first server, verify no new failures, then promote the rest.
        canary_srv, rest = ring_servers[0], ring_servers[1:]
        await _do(canary_srv)
        new = await get_failed_systemd_units(canary_srv) - baseline.get(canary_srv.id, set())
        if new:
            detail = f"Canary {canary_srv.name} degraded (new failed units: {', '.join(sorted(new))})"
            async with AsyncSessionLocal() as fdb:
                await finish_task(fdb, task_id, "error", detail=detail)
            await _finish_step_and_abort(rollout_id, step_index, detail)
            return
        await asyncio.gather(*[_do(s) for s in rest])
    else:
        await asyncio.gather(*[_do(s) for s in ring_servers])

    # Check for failures in this ring's upgrade history (same 1h lookback the
    # original inline implementation used).
    since = datetime.utcnow() - timedelta(hours=1)
    server_ids_list = [s.id for s in ring_servers]
    async with AsyncSessionLocal() as hdb:
        history_failed = await ring_has_history_errors(hdb, server_ids_list, since)

    degraded: list[tuple[Server, set[str]]] = []
    if canary and not history_failed:
        for s in ring_servers:
            new = await get_failed_systemd_units(s) - baseline.get(s.id, set())
            if new:
                degraded.append((s, new))

    if history_failed or degraded:
        if history_failed:
            detail = "Ring had upgrade failure(s) — see update history"
        else:
            names = ", ".join(s.name for s, _ in degraded)
            detail = f"{len(degraded)} server(s) degraded after upgrade (new failed systemd units): {names}"
        async with AsyncSessionLocal() as fdb:
            await finish_task(fdb, task_id, "error", detail=detail)
        await _finish_step_and_abort(rollout_id, step_index, detail)
        return

    async with AsyncSessionLocal() as fdb:
        await finish_task(fdb, task_id, "success")
    await _finish_step_and_promote(rollout_id, step_index, ring_delay_hours)


async def _finish_step_and_abort(rollout_id: int, step_index: int, detail: str) -> None:
    async with AsyncSessionLocal() as db:
        step = (await db.execute(
            select(RolloutStep).where(RolloutStep.rollout_id == rollout_id, RolloutStep.step_index == step_index)
        )).scalar_one_or_none()
        if step is not None:
            step.status = "error"
            step.finished_at = datetime.utcnow()
            step.detail = detail
            await db.commit()
        await _abort_rollout(db, rollout_id, detail=detail)


async def _abort_rollout(db: AsyncSession, rollout_id: int, *, detail: str) -> None:
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None or rollout.status not in ACTIVE_ROLLOUT_STATUSES:
        return
    rollout.status = "aborted"
    rollout.finished_at = datetime.utcnow()
    rollout.detail = f"{rollout.detail}\n{detail}" if rollout.detail else detail
    await db.commit()
    logger.error("Rollout %d aborted: %s", rollout_id, detail)
    _remove_future_jobs(rollout_id)


async def _finish_step_and_promote(rollout_id: int, step_index: int, ring_delay_hours: int) -> None:
    async with AsyncSessionLocal() as db:
        step = (await db.execute(
            select(RolloutStep).where(RolloutStep.rollout_id == rollout_id, RolloutStep.step_index == step_index)
        )).scalar_one_or_none()
        if step is not None:
            step.status = "success"
            step.finished_at = datetime.utcnow()

        rollout = await db.get(Rollout, rollout_id)
        if rollout is None or rollout.status != "running":
            await db.commit()
            return

        next_step = (await db.execute(
            select(RolloutStep).where(RolloutStep.rollout_id == rollout_id, RolloutStep.step_index == step_index + 1)
        )).scalar_one_or_none()
        if next_step is None:
            rollout.status = "complete"
            rollout.finished_at = datetime.utcnow()
            await db.commit()
            logger.info("Rollout %d complete", rollout_id)
            return

        run_at_utc = datetime.now(timezone.utc) + timedelta(hours=ring_delay_hours)
        next_step.status = "scheduled"
        next_step.scheduled_at = run_at_utc.replace(tzinfo=None)
        next_index = next_step.step_index
        await db.commit()

    _schedule_step_job(rollout_id, next_index, run_at_utc)
    logger.info("Rollout %d: promoted to step %d, due %s", rollout_id, next_index, utc_iso(run_at_utc.replace(tzinfo=None)))


# ---------------------------------------------------------------------------
# Startup reconciliation
# ---------------------------------------------------------------------------

async def reconcile_rollouts() -> dict:
    """Startup reconciliation for durable rollouts (issue #62).

    Call once from ``main.py``'s lifespan, after ``start_scheduler()`` (the
    APScheduler instance needs to exist so jobs can be re-added to it — unlike
    ``task_queue.reconcile_interrupted_tasks()``, which has nothing left to
    reconcile against, a RolloutStep's DateTrigger job is easy to recreate
    from the DB because persisting the plan was the entire point).

    - A ``RolloutStep`` left ``running`` belongs to a process that's gone —
      its in-flight per-server upgrades and SSH sessions went with it, so it
      is marked ``error`` (mirrors ``task_queue``'s "interrupted" treatment;
      ``RolloutStep`` has no ``interrupted`` status of its own) and its
      rollout is aborted — a ring that was wiped out mid-run is not safe to
      silently promote past.
    - A ``scheduled`` step (of a rollout still ``running``) gets its
      APScheduler job re-armed. If its due time already passed while the
      process was down, it fires almost immediately once the scheduler
      starts polling rather than waiting out a delay that has already
      elapsed — restoring the original intent as closely as a restart allows.
    - ``paused`` rollouts are left untouched for an explicit resume.

    Returns a dict of counts for logging.
    """
    rearmed = 0
    ran_now = 0
    errored = 0

    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Rollout).where(Rollout.status == "running"))
        rollouts = list(res.scalars().all())

        for rollout in rollouts:
            steps = list((await db.execute(
                select(RolloutStep).where(RolloutStep.rollout_id == rollout.id).order_by(RolloutStep.step_index)
            )).scalars().all())

            any_wiped = False
            for step in steps:
                if step.status == "running":
                    step.status = "error"
                    step.finished_at = datetime.utcnow()
                    note = "Interrupted by an apt-ui restart mid-ring — its in-flight upgrades and SSH sessions were lost; check the affected server(s) manually."
                    step.detail = f"{step.detail} {note}" if step.detail else note
                    errored += 1
                    any_wiped = True

            if any_wiped:
                rollout.status = "aborted"
                rollout.finished_at = datetime.utcnow()
                note = "Aborted at startup — a ring was interrupted mid-run by a restart."
                rollout.detail = f"{rollout.detail}\n{note}" if rollout.detail else note
                await db.commit()
                continue  # don't re-arm anything for a rollout we just aborted

            for step in steps:
                if step.status != "scheduled":
                    continue
                now = datetime.now(timezone.utc)
                due = step.scheduled_at
                if due is not None and due.tzinfo is None:
                    due = due.replace(tzinfo=timezone.utc)
                run_at = due if due is not None else now
                if run_at <= now:
                    ran_now += 1
                else:
                    rearmed += 1
                _schedule_step_job(rollout.id, step.step_index, run_at)

        await db.commit()

    logger.info(
        "Rollout reconciliation: %d step(s) re-armed for the future, %d due-immediately, %d marked error after restart",
        rearmed, ran_now, errored,
    )
    return {"rearmed": rearmed, "ran_immediately": ran_now, "errored": errored}


# ---------------------------------------------------------------------------
# Control operations (used by backend/routers/rollouts.py)
# ---------------------------------------------------------------------------

async def promote_now(db: AsyncSession, rollout_id: int, *, actor: str) -> Rollout:
    """Run the next scheduled/pending step immediately instead of waiting for
    its due time (admin override)."""
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None:
        raise ValueError("not_found")
    if rollout.status not in ("running", "paused"):
        raise ValueError(f"cannot promote a rollout in status '{rollout.status}'")

    next_step = (await db.execute(
        select(RolloutStep).where(
            RolloutStep.rollout_id == rollout_id,
            RolloutStep.status.in_(["scheduled", "pending"]),
        ).order_by(RolloutStep.step_index).limit(1)
    )).scalar_one_or_none()
    if next_step is None:
        raise ValueError("no pending step to promote")

    if rollout.status == "paused":
        rollout.status = "running"
    note = f"Promoted by {actor} at {utc_iso(datetime.utcnow())}"
    rollout.detail = f"{rollout.detail}\n{note}" if rollout.detail else note

    run_at_utc = datetime.now(timezone.utc)
    next_step.status = "scheduled"
    next_step.scheduled_at = run_at_utc.replace(tzinfo=None)
    next_index = next_step.step_index
    await db.commit()
    await db.refresh(rollout)

    _schedule_step_job(rollout_id, next_index, run_at_utc)
    return rollout


async def pause_rollout(db: AsyncSession, rollout_id: int, *, actor: str) -> Rollout:
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None:
        raise ValueError("not_found")
    if rollout.status != "running":
        raise ValueError(f"cannot pause a rollout in status '{rollout.status}'")

    rollout.status = "paused"
    note = f"Paused by {actor} at {utc_iso(datetime.utcnow())}"
    rollout.detail = f"{rollout.detail}\n{note}" if rollout.detail else note
    await db.commit()
    await db.refresh(rollout)

    # Remove any not-yet-fired job — a resume computes a fresh delay instead
    # of an arbitrary already-elapsed one firing right away. `_execute_step`
    # also re-checks rollout.status == 'running' and no-ops otherwise, so this
    # is belt-and-braces rather than the only guard.
    _remove_future_jobs(rollout_id)
    return rollout


async def resume_rollout(db: AsyncSession, rollout_id: int, *, actor: str) -> Rollout:
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None:
        raise ValueError("not_found")
    if rollout.status != "paused":
        raise ValueError(f"cannot resume a rollout in status '{rollout.status}'")

    rollout.status = "running"
    note = f"Resumed by {actor} at {utc_iso(datetime.utcnow())}"
    rollout.detail = f"{rollout.detail}\n{note}" if rollout.detail else note
    await db.commit()

    next_step = (await db.execute(
        select(RolloutStep).where(
            RolloutStep.rollout_id == rollout_id,
            RolloutStep.status.in_(["scheduled", "pending"]),
        ).order_by(RolloutStep.step_index).limit(1)
    )).scalar_one_or_none()

    if next_step is not None:
        run_at_utc = datetime.now(timezone.utc)
        next_step.status = "scheduled"
        next_step.scheduled_at = run_at_utc.replace(tzinfo=None)
        next_index = next_step.step_index
        await db.commit()
        _schedule_step_job(rollout_id, next_index, run_at_utc)

    await db.refresh(rollout)
    return rollout


async def abort_rollout(db: AsyncSession, rollout_id: int, *, actor: str) -> Rollout:
    rollout = await db.get(Rollout, rollout_id)
    if rollout is None:
        raise ValueError("not_found")
    if rollout.status not in ACTIVE_ROLLOUT_STATUSES:
        raise ValueError(f"rollout already terminal ('{rollout.status}')")

    rollout.status = "aborted"
    rollout.finished_at = datetime.utcnow()
    note = f"Aborted by {actor} at {utc_iso(datetime.utcnow())}"
    rollout.detail = f"{rollout.detail}\n{note}" if rollout.detail else note
    await db.commit()

    await db.execute(
        RolloutStep.__table__.update()
        .where(RolloutStep.rollout_id == rollout_id, RolloutStep.status.in_(["pending", "scheduled"]))
        .values(status="cancelled")
    )
    await db.commit()
    await db.refresh(rollout)

    _remove_future_jobs(rollout_id)
    return rollout
