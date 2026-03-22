from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import NotificationConfig, User
from backend.schemas import NotificationConfigOut, NotificationConfigUpdate

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _mask(cfg: NotificationConfig) -> NotificationConfigOut:
    """Return config with sensitive fields masked."""
    out = NotificationConfigOut.model_validate(cfg)
    if out.smtp_password:
        out.smtp_password = "••••••••"
    if out.telegram_bot_token:
        out.telegram_bot_token = out.telegram_bot_token[:8] + "••••••••"
    return out


async def _get_cfg(db: AsyncSession) -> NotificationConfig:
    result = await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
    cfg = result.scalar_one_or_none()
    if cfg is None:
        cfg = NotificationConfig(id=1)
        db.add(cfg)
        await db.commit()
        await db.refresh(cfg)
    return cfg


@router.get("/config", response_model=NotificationConfigOut)
async def get_config(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg = await _get_cfg(db)
    return _mask(cfg)


@router.put("/config", response_model=NotificationConfigOut)
async def update_config(
    body: NotificationConfigUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg = await _get_cfg(db)

    for field, value in body.model_dump(exclude_unset=True).items():
        # Don't overwrite secrets with the masked placeholder
        if field in ("smtp_password", "telegram_bot_token") and value and "••••" in value:
            continue
        setattr(cfg, field, value)

    await db.commit()
    await db.refresh(cfg)

    # Reschedule daily summary if time changed
    try:
        from backend.scheduler import configure_jobs
        await configure_jobs()
    except Exception:
        pass

    return _mask(cfg)


@router.post("/test/email")
async def test_email(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg = await _get_cfg(db)
    if not cfg.email_enabled or not cfg.smtp_host:
        raise HTTPException(status_code=400, detail="Email is not configured")

    from backend.notifier import send_daily_summary
    try:
        await send_daily_summary(cfg, db)
        return {"detail": "Test email sent"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/test/telegram")
async def test_telegram(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg = await _get_cfg(db)
    if not cfg.telegram_enabled or not cfg.telegram_bot_token:
        raise HTTPException(status_code=400, detail="Telegram is not configured")

    from backend.notifier import _send_telegram
    try:
        await _send_telegram(cfg, "✅ Apt Dashboard test message — Telegram notifications are working!")
        return {"detail": "Test Telegram message sent"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/telegram/detect-chat-id")
async def detect_chat_id(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    cfg = await _get_cfg(db)
    if not cfg.telegram_bot_token:
        raise HTTPException(status_code=400, detail="Telegram bot token is not configured")

    from backend.notifier import get_telegram_updates
    try:
        chats = await get_telegram_updates(cfg.telegram_bot_token)
        return {"chats": chats}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
