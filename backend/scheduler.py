"""
APScheduler setup — all schedule configuration lives in the DB.

Jobs:
  check_all      — run update checks on all enabled servers (cron)
  auto_upgrade   — run upgrade on all servers with pending updates (optional cron)
  daily_summary  — send daily notification summary (after scheduled check)
  log_purge      — delete old check/history/stats records (daily 03:00)
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone  # noqa: F401 — timezone used in ping job

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from backend.config import TZ, now_local

logger = logging.getLogger(__name__)

_scheduler = AsyncIOScheduler(timezone=TZ)


def get_scheduler() -> AsyncIOScheduler:
    return _scheduler


def get_next_run_time(job_id: str) -> datetime | None:
    job = _scheduler.get_job(job_id)
    if job and job.next_run_time:
        return job.next_run_time
    return None


# ---------------------------------------------------------------------------
# Job functions
# ---------------------------------------------------------------------------

async def _job_check_all():
    logger.info("Scheduler: running scheduled check-all")
    from backend.database import AsyncSessionLocal
    from backend.models import Server, ScheduleConfig
    from backend.update_checker import check_all_servers
    from sqlalchemy import select

    try:
        async with AsyncSessionLocal() as db:
            cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
            cfg = cfg_res.scalar_one_or_none()
            concurrency = cfg.upgrade_concurrency if cfg else 5

            srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
            servers = srv_res.scalars().all()
            await check_all_servers(list(servers), db, concurrency)
    except Exception as exc:
        logger.error("Scheduled check-all failed: %s", exc)

    # Send event notifications (security updates, reboot required)
    try:
        await _send_event_notifications()
    except Exception as exc:
        logger.error("Event notifications failed: %s", exc)

    # Send daily summary regardless of whether the check succeeded
    try:
        await _send_daily_summary()
    except Exception as exc:
        logger.error("Daily summary failed: %s", exc)


async def _job_auto_upgrade():
    logger.info("Scheduler: running auto-upgrade")
    from backend.database import AsyncSessionLocal
    from backend.models import Server, ScheduleConfig, UpdateCheck
    from backend.upgrade_manager import upgrade_server
    from sqlalchemy import select
    import asyncio

    async with AsyncSessionLocal() as db:
        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        concurrency = cfg.upgrade_concurrency if cfg else 5
        allow_phased = cfg.allow_phased_on_auto if cfg else False
        conffile_action = cfg.conffile_action if cfg else "confdef_confold"
        staged = cfg.staged_rollout_enabled if cfg else False
        ring_delay = cfg.ring_promotion_delay_hours if cfg else 24

        srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
        servers = srv_res.scalars().all()

        # Only upgrade servers that have pending updates AND aren't in a maintenance deny window
        from backend.routers.maintenance import get_active_window_for_server
        to_upgrade = []
        skipped_for_maintenance = 0
        for s in servers:
            chk_res = await db.execute(
                select(UpdateCheck)
                .where(UpdateCheck.server_id == s.id)
                .order_by(UpdateCheck.checked_at.desc())
                .limit(1)
            )
            chk = chk_res.scalar_one_or_none()
            if chk and chk.status == "success" and chk.packages_available > 0:
                # Skip servers currently in a maintenance window (issue #40)
                window = await get_active_window_for_server(db, s.id)
                if window:
                    skipped_for_maintenance += 1
                    logger.info("Auto-upgrade skipping %s — inside maintenance window '%s'", s.name, window.name)
                    continue
                to_upgrade.append(s)
        if skipped_for_maintenance:
            logger.info("Auto-upgrade: skipped %d server(s) inside maintenance windows", skipped_for_maintenance)

        # Group by ring tag for staged rollout (issue #41)
        rings: dict[str, list[Server]] = {}
        if staged:
            from backend.models import Tag, ServerTag
            from sqlalchemy import select as _sel
            for s in to_upgrade:
                tag_res = await db.execute(
                    _sel(Tag.name)
                    .join(ServerTag, ServerTag.tag_id == Tag.id)
                    .where(ServerTag.server_id == s.id, Tag.name.like("ring:%"))
                )
                ring_tags = [r for (r,) in tag_res.all()]
                # Use the first matching ring tag, or "default" if none
                ring = ring_tags[0] if ring_tags else "ring:default"
                rings.setdefault(ring, []).append(s)
        else:
            rings = {"all": to_upgrade}

    semaphore = asyncio.Semaphore(concurrency)

    async def _do(server):
        async with semaphore:
            from backend.database import AsyncSessionLocal as ASL
            async with ASL() as db2:
                await upgrade_server(
                    server, db2,
                    action="upgrade",
                    allow_phased=allow_phased,
                    conffile_action=conffile_action,
                    initiated_by="scheduled",
                )

    if not staged:
        await asyncio.gather(*[_do(s) for s in to_upgrade])
        return

    # Staged rollout: process rings in alphabetical order, with delays between
    ring_names = sorted(rings.keys())
    logger.info("Staged rollout: %d rings to process — %s", len(ring_names), ring_names)

    for i, ring_name in enumerate(ring_names):
        ring_servers = rings[ring_name]
        logger.info("Staged rollout: starting %s (%d servers)", ring_name, len(ring_servers))
        await asyncio.gather(*[_do(s) for s in ring_servers])

        # Check for failures in this ring's upgrade history
        async with AsyncSessionLocal() as db:
            from backend.models import UpdateHistory
            from sqlalchemy import select as _sel
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
            ring_server_ids = [s.id for s in ring_servers]
            if ring_server_ids:
                fail_res = await db.execute(
                    _sel(UpdateHistory).where(
                        UpdateHistory.server_id.in_(ring_server_ids),
                        UpdateHistory.started_at >= cutoff,
                        UpdateHistory.status == "error",
                    )
                )
                failures = list(fail_res.scalars().all())
                if failures:
                    logger.error(
                        "Staged rollout: %s had %d failure(s); aborting promotion to remaining rings",
                        ring_name, len(failures),
                    )
                    return

        # If not the last ring, wait the configured delay before promoting
        if i < len(ring_names) - 1:
            sleep_seconds = ring_delay * 3600
            logger.info("Staged rollout: waiting %dh before next ring", ring_delay)
            await asyncio.sleep(sleep_seconds)


async def _send_event_notifications():
    from backend.database import AsyncSessionLocal
    from backend.models import NotificationConfig
    from backend.notifier import notify_security_updates_found, notify_reboot_required
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        cfg_res = await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        if cfg:
            await notify_security_updates_found(cfg, db)
            await notify_reboot_required(cfg, db)


async def _send_daily_summary():
    from backend.database import AsyncSessionLocal
    from backend.models import NotificationConfig
    from backend.notifier import send_daily_summary
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        cfg_res = await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        if cfg and cfg.daily_summary_enabled:
            await send_daily_summary(cfg, db)


async def _job_weekly_digest():
    """Compose and dispatch the weekly patch digest (issue #58)."""
    from backend.database import AsyncSessionLocal
    from backend.models import NotificationConfig, ScheduleConfig
    from backend.notifier import send_weekly_digest
    from sqlalchemy import select

    logger.info("Scheduler: running weekly digest job")
    try:
        async with AsyncSessionLocal() as db:
            sc_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
            sc = sc_res.scalar_one_or_none()
            if not sc or not sc.weekly_digest_enabled:
                logger.info("Weekly digest disabled — skipping")
                return
            cfg_res = await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
            cfg = cfg_res.scalar_one_or_none()
            if cfg is None:
                logger.warning("Weekly digest: no NotificationConfig row — skipping")
                return
            results = await send_weekly_digest(cfg, db)
            logger.info("Weekly digest dispatched: %s", results)
    except Exception as exc:
        logger.error("Weekly digest job failed: %s", exc)


async def _job_reboot_check(server_id: int):
    """Poll until server is reachable post-reboot, then run a full check."""
    from backend.database import AsyncSessionLocal
    from backend.models import Server
    from backend.ssh_manager import run_command
    from backend.update_checker import check_server
    from sqlalchemy import select

    logger.info("Reboot-check: starting post-reboot check for server %d", server_id)

    async with AsyncSessionLocal() as db:
        srv_res = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_res.scalar_one_or_none()

    if server is None or not server.is_enabled:
        logger.warning("Reboot-check: server %d not found or disabled, skipping", server_id)
        return

    # Poll every 30 s for up to 10 minutes
    max_attempts = 20
    for attempt in range(1, max_attempts + 1):
        result = await run_command(server, "echo ok", timeout=10)
        if result.exit_code == 0 and "ok" in result.stdout:
            logger.info(
                "Reboot-check: server %d (%s) is back up after %d attempt(s)",
                server_id, server.hostname, attempt,
            )
            break
        logger.debug(
            "Reboot-check: server %d not yet reachable (attempt %d/%d)",
            server_id, attempt, max_attempts,
        )
        if attempt < max_attempts:
            await asyncio.sleep(30)
    else:
        logger.error(
            "Reboot-check: server %d (%s) did not come back within 10 minutes",
            server_id, server.hostname,
        )
        return

    # Run a full update check now that the server is back
    try:
        async with AsyncSessionLocal() as db:
            srv_res = await db.execute(select(Server).where(Server.id == server_id))
            server = srv_res.scalar_one_or_none()
            if server:
                await check_server(server, db)
                logger.info("Reboot-check: post-reboot check complete for server %d", server_id)
    except Exception as exc:
        logger.error("Reboot-check: check failed for server %d: %s", server_id, exc)


def schedule_reboot_check(server_id: int, delay_seconds: int = 60) -> None:
    """Schedule a one-shot post-reboot check job for *server_id*.

    Fires after *delay_seconds* (default 60 s) then polls until the server
    is reachable, then runs a full update check to clear the reboot_required flag.
    Replaces any existing pending reboot-check for the same server.
    """
    run_at = now_local() + timedelta(seconds=delay_seconds)
    job_id = f"reboot_check_{server_id}"
    _scheduler.add_job(
        _job_reboot_check,
        DateTrigger(run_date=run_at, timezone=TZ),
        id=job_id,
        replace_existing=True,
        kwargs={"server_id": server_id},
    )
    logger.info(
        "Reboot-check: scheduled post-reboot check for server %d in %ds (job %s)",
        server_id, delay_seconds, job_id,
    )


async def _job_ping_all():
    """TCP-ping all enabled servers and update is_reachable / last_seen on the Server row."""
    from backend.database import AsyncSessionLocal
    from backend.models import Server
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Server).where(Server.is_enabled == True))
        servers = result.scalars().all()

    async def _ping(server: Server):
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(server.hostname, server.ssh_port), timeout=3.0
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            reachable = True
        except Exception:
            reachable = False

        try:
            async with AsyncSessionLocal() as db2:
                res = await db2.execute(select(Server).where(Server.id == server.id))
                s = res.scalar_one_or_none()
                if s:
                    s.is_reachable = reachable
                    if reachable:
                        s.last_seen = datetime.now(timezone.utc).replace(tzinfo=None)
                    await db2.commit()
        except Exception as exc:
            logger.debug("Ping update failed for server %d: %s", server.id, exc)

    await asyncio.gather(*[_ping(s) for s in servers], return_exceptions=True)
    logger.debug("Ping-all: checked %d servers", len(servers))


async def _job_log_purge():
    from backend.database import AsyncSessionLocal
    from backend.models import ScheduleConfig, UpdateCheck, UpdateHistory, ServerStats, NotificationLog, SshAuditLog
    from sqlalchemy import select, delete
    from datetime import timedelta

    async with AsyncSessionLocal() as db:
        cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = cfg_res.scalar_one_or_none()
        days = cfg.log_retention_days if cfg else 90
        if days == 0:
            return

        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
        checks = await db.execute(delete(UpdateCheck).where(UpdateCheck.checked_at < cutoff))
        history = await db.execute(delete(UpdateHistory).where(UpdateHistory.started_at < cutoff))
        stats = await db.execute(delete(ServerStats).where(ServerStats.recorded_at < cutoff))
        notif_logs = await db.execute(delete(NotificationLog).where(NotificationLog.sent_at < cutoff))
        ssh_logs = await db.execute(delete(SshAuditLog).where(SshAuditLog.started_at < cutoff))
        await db.commit()
        logger.info(
            "Log purge: removed %d checks, %d history, %d stats, %d notif-logs, %d ssh-audit older than %d days",
            checks.rowcount, history.rowcount, stats.rowcount, notif_logs.rowcount, ssh_logs.rowcount, days,
        )


# ---------------------------------------------------------------------------
# Configure / reconfigure jobs from DB
# ---------------------------------------------------------------------------

async def configure_jobs():
    """Load schedule_config from DB and register/update APScheduler jobs."""
    from backend.database import AsyncSessionLocal
    from backend.models import ScheduleConfig
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
        cfg = result.scalar_one_or_none()

    _remove_jobs()

    if cfg and cfg.check_enabled:
        _scheduler.add_job(
            _job_check_all,
            CronTrigger.from_crontab(cfg.check_cron, timezone=TZ),
            id="check_all",
            replace_existing=True,
            misfire_grace_time=300,
        )
        logger.info("Scheduled check_all: %s (%s)", cfg.check_cron, TZ)

    if cfg and cfg.auto_upgrade_enabled and cfg.auto_upgrade_cron:
        _scheduler.add_job(
            _job_auto_upgrade,
            CronTrigger.from_crontab(cfg.auto_upgrade_cron, timezone=TZ),
            id="auto_upgrade",
            replace_existing=True,
            misfire_grace_time=300,
        )
        logger.info("Scheduled auto_upgrade: %s (%s)", cfg.auto_upgrade_cron, TZ)

    # Weekly digest (issue #58) — separate cron from daily_summary
    if cfg and cfg.weekly_digest_enabled:
        dow = max(0, min(6, int(cfg.weekly_digest_day_of_week or 0)))
        hour = max(0, min(23, int(cfg.weekly_digest_hour or 9)))
        minute = max(0, min(59, int(cfg.weekly_digest_minute or 0)))
        _scheduler.add_job(
            _job_weekly_digest,
            CronTrigger(day_of_week=dow, hour=hour, minute=minute, timezone=TZ),
            id="weekly_digest",
            replace_existing=True,
            misfire_grace_time=600,
        )
        logger.info("Scheduled weekly_digest: dow=%d %02d:%02d (%s)", dow, hour, minute, TZ)

    # Log purge always runs daily at 03:00
    _scheduler.add_job(
        _job_log_purge,
        CronTrigger(hour=3, minute=0, timezone=TZ),
        id="log_purge",
        replace_existing=True,
    )

    # TCP ping runs every 5 minutes unconditionally
    _scheduler.add_job(
        _job_ping_all,
        CronTrigger(minute="*/5", timezone=TZ),
        id="ping_all",
        replace_existing=True,
    )

    # Daily CVE feed refresh (issue #37)
    from backend.cve_matcher import daily_refresh_job
    _scheduler.add_job(
        daily_refresh_job,
        CronTrigger(hour=4, minute=15, timezone=TZ),
        id="cve_refresh",
        replace_existing=True,
    )


def _remove_jobs():
    for job_id in ("check_all", "auto_upgrade", "weekly_digest"):
        job = _scheduler.get_job(job_id)
        if job:
            job.remove()


async def start_scheduler():
    await configure_jobs()
    if not _scheduler.running:
        _scheduler.start()
    logger.info("Scheduler started")


def stop_scheduler():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
