from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import ScheduleConfig, User
from backend.schemas import ScheduleConfigOut, ScheduleConfigUpdate
from backend.config import TZ

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])


@router.get("/status", response_model=ScheduleConfigOut)
async def get_status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    from backend.scheduler import get_next_run_time

    result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = result.scalar_one_or_none()

    return ScheduleConfigOut(
        id=cfg.id if cfg else 1,
        check_enabled=cfg.check_enabled if cfg else True,
        check_cron=cfg.check_cron if cfg else "0 6 * * *",
        auto_upgrade_enabled=cfg.auto_upgrade_enabled if cfg else False,
        auto_upgrade_cron=cfg.auto_upgrade_cron if cfg else None,
        allow_phased_on_auto=cfg.allow_phased_on_auto if cfg else False,
        upgrade_concurrency=cfg.upgrade_concurrency if cfg else 5,
        log_retention_days=cfg.log_retention_days if cfg else 90,
        auto_tag_os=cfg.auto_tag_os if cfg else False,
        auto_tag_virt=cfg.auto_tag_virt if cfg else False,
        run_apt_update_before_upgrade=cfg.run_apt_update_before_upgrade if cfg else False,
        conffile_action=cfg.conffile_action if cfg else "confdef_confold",
        reachability_ttl_minutes=cfg.reachability_ttl_minutes if cfg else 5,
        staged_rollout_enabled=cfg.staged_rollout_enabled if cfg else False,
        ring_promotion_delay_hours=cfg.ring_promotion_delay_hours if cfg else 24,
        reboot_batch_size=cfg.reboot_batch_size if cfg else 3,
        reboot_batch_wait_minutes=cfg.reboot_batch_wait_minutes if cfg else 5,
        reboot_timeout_minutes=cfg.reboot_timeout_minutes if cfg else 10,
        next_check_time=get_next_run_time("check_all"),
        next_upgrade_time=get_next_run_time("auto_upgrade"),
        timezone=TZ,
    )


@router.put("/config", response_model=ScheduleConfigOut)
async def update_config(
    body: ScheduleConfigUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    from backend.scheduler import configure_jobs, get_next_run_time

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
        reboot_batch_size=cfg.reboot_batch_size,
        reboot_batch_wait_minutes=cfg.reboot_batch_wait_minutes,
        reboot_timeout_minutes=cfg.reboot_timeout_minutes,
        next_check_time=get_next_run_time("check_all"),
        next_upgrade_time=get_next_run_time("auto_upgrade"),
        timezone=TZ,
    )
