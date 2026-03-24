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
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from backend.config import TZ

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

        srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
        servers = srv_res.scalars().all()

        # Only upgrade servers that have pending updates
        to_upgrade = []
        for s in servers:
            chk_res = await db.execute(
                select(UpdateCheck)
                .where(UpdateCheck.server_id == s.id)
                .order_by(UpdateCheck.checked_at.desc())
                .limit(1)
            )
            chk = chk_res.scalar_one_or_none()
            if chk and chk.status == "success" and chk.packages_available > 0:
                to_upgrade.append(s)

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

    await asyncio.gather(*[_do(s) for s in to_upgrade])


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
    run_at = datetime.now(tz=TZ) + timedelta(seconds=delay_seconds)
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


async def _job_log_purge():
    from backend.database import AsyncSessionLocal
    from backend.models import ScheduleConfig, UpdateCheck, UpdateHistory, ServerStats
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
        await db.commit()
        logger.info(
            "Log purge: removed %d checks, %d history, %d stats older than %d days",
            checks.rowcount, history.rowcount, stats.rowcount, days,
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

    # Log purge always runs daily at 03:00
    _scheduler.add_job(
        _job_log_purge,
        CronTrigger(hour=3, minute=0, timezone=TZ),
        id="log_purge",
        replace_existing=True,
    )


def _remove_jobs():
    for job_id in ("check_all", "auto_upgrade"):
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
