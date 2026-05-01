from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import ScheduleConfig, User
from backend.schemas import ScheduleConfigOut, ScheduleConfigUpdate
from backend.config import TZ

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])


def _to_out(cfg: ScheduleConfig | None) -> ScheduleConfigOut:
    """Build a ScheduleConfigOut from a ScheduleConfig row (or defaults)."""
    from backend.scheduler import get_next_run_time
    if cfg is None:
        return ScheduleConfigOut(
            id=1,
            check_enabled=True,
            check_cron="0 6 * * *",
            auto_upgrade_enabled=False,
            auto_upgrade_cron=None,
            allow_phased_on_auto=False,
            upgrade_concurrency=5,
            log_retention_days=90,
            auto_tag_os=False,
            auto_tag_virt=False,
            run_apt_update_before_upgrade=False,
            conffile_action="confdef_confold",
            reachability_ttl_minutes=5,
            staged_rollout_enabled=False,
            ring_promotion_delay_hours=24,
            weekly_digest_enabled=False,
            weekly_digest_day_of_week=0,
            weekly_digest_hour=9,
            weekly_digest_minute=0,
            next_check_time=get_next_run_time("check_all"),
            next_upgrade_time=get_next_run_time("auto_upgrade"),
            next_weekly_digest_time=get_next_run_time("weekly_digest"),
            timezone=TZ,
        )
    return ScheduleConfigOut(
        id=cfg.id,
        check_enabled=cfg.check_enabled,
        check_cron=cfg.check_cron,
        auto_upgrade_enabled=cfg.auto_upgrade_enabled,
        auto_upgrade_cron=cfg.auto_upgrade_cron,
        allow_phased_on_auto=cfg.allow_phased_on_auto,
        upgrade_concurrency=cfg.upgrade_concurrency,
        log_retention_days=cfg.log_retention_days,
        auto_tag_os=cfg.auto_tag_os,
        auto_tag_virt=cfg.auto_tag_virt,
        run_apt_update_before_upgrade=cfg.run_apt_update_before_upgrade,
        conffile_action=cfg.conffile_action,
        reachability_ttl_minutes=cfg.reachability_ttl_minutes,
        staged_rollout_enabled=cfg.staged_rollout_enabled,
        ring_promotion_delay_hours=cfg.ring_promotion_delay_hours,
        weekly_digest_enabled=cfg.weekly_digest_enabled,
        weekly_digest_day_of_week=cfg.weekly_digest_day_of_week,
        weekly_digest_hour=cfg.weekly_digest_hour,
        weekly_digest_minute=cfg.weekly_digest_minute,
        next_check_time=get_next_run_time("check_all"),
        next_upgrade_time=get_next_run_time("auto_upgrade"),
        next_weekly_digest_time=get_next_run_time("weekly_digest"),
        timezone=TZ,
    )


@router.get("/status", response_model=ScheduleConfigOut)
async def get_status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = result.scalar_one_or_none()
    return _to_out(cfg)


@router.put("/config", response_model=ScheduleConfigOut)
async def update_config(
    body: ScheduleConfigUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    from backend.scheduler import configure_jobs

    result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = result.scalar_one_or_none()
    if cfg is None:
        cfg = ScheduleConfig(id=1)
        db.add(cfg)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(cfg, field, value)

    await db.commit()
    await db.refresh(cfg)

    # Reconfigure APScheduler jobs with new settings
    await configure_jobs()

    return _to_out(cfg)
