from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import NotificationConfig, NotificationLog, User
from backend.schemas import NotificationConfigOut, NotificationConfigUpdate, NotificationLogOut

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
    _: User = Depends(require_admin),
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
    _: User = Depends(require_admin),
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
    _: User = Depends(require_admin),
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


@router.post("/test/slack")
async def test_slack(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = await _get_cfg(db)
    if not cfg.slack_enabled or not cfg.slack_webhook_url:
        raise HTTPException(status_code=400, detail="Slack is not configured")

    from backend.notifier import _send_slack
    try:
        await _send_slack(
            cfg,
            header="✅ Apt Dashboard test message",
            body="Slack notifications are working — you'll receive fleet alerts here.",
            event_type="test",
        )
        return {"detail": "Test Slack message sent"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/test-weekly-digest")
async def test_weekly_digest(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Compose and dispatch the weekly digest immediately (issue #58).

    Returns a per-channel result map (`sent` / `skipped` / `error: …`).
    Channels marked `skipped` are either disabled or have their per-channel
    weekly-digest toggle off in NotificationConfig.
    """
    cfg = await _get_cfg(db)
    if not (cfg.email_enabled or cfg.telegram_enabled or cfg.webhook_enabled or cfg.slack_enabled):
        raise HTTPException(status_code=400, detail="No notification channels are enabled")

    from backend.notifier import send_weekly_digest
    try:
        results = await send_weekly_digest(cfg, db)
        return {"detail": "Weekly digest dispatched", "results": results}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/history")
async def get_notification_history(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return paginated notification send history."""
    offset = (page - 1) * limit
    total_res = await db.execute(select(func.count(NotificationLog.id)))
    total = total_res.scalar_one()
    items_res = await db.execute(
        select(NotificationLog)
        .order_by(NotificationLog.sent_at.desc())
        .offset(offset)
        .limit(limit)
    )
    items = items_res.scalars().all()
    return {
        "total": total,
        "page": page,
        "limit": limit,
        "items": [NotificationLogOut.model_validate(i) for i in items],
    }


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


# ---------------------------------------------------------------------------
# Extra notification destinations (issue #62) — on-call / chat adapters
# ---------------------------------------------------------------------------

_DEST_TYPES = {"discord", "mattermost", "ntfy", "webhook", "pagerduty", "opsgenie"}


def _dest_dict(d) -> dict:
    return {"id": d.id, "name": d.name, "type": d.type, "url": d.url,
            "events": d.events, "enabled": d.enabled, "created_at": d.created_at}


@router.get("/destinations")
async def list_destinations(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from backend.models import NotificationDestination
    res = await db.execute(select(NotificationDestination).order_by(NotificationDestination.name))
    return [_dest_dict(d) for d in res.scalars().all()]


@router.post("/destinations", status_code=201)
async def create_destination(body: dict, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    from backend.models import NotificationDestination
    name = (body.get("name") or "").strip()
    dtype = (body.get("type") or "").strip().lower()
    url = (body.get("url") or "").strip()
    if not name or dtype not in _DEST_TYPES or not url:
        raise HTTPException(status_code=400, detail="name, valid type, and url are required")
    d = NotificationDestination(name=name, type=dtype, url=url,
                                events=(body.get("events") or "").strip() or None,
                                enabled=bool(body.get("enabled", True)))
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return _dest_dict(d)


@router.put("/destinations/{dest_id}")
async def update_destination(dest_id: int, body: dict, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    from backend.models import NotificationDestination
    d = (await db.execute(select(NotificationDestination).where(NotificationDestination.id == dest_id))).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Destination not found")
    for f in ("name", "type", "url", "events", "enabled"):
        if f in body:
            setattr(d, f, body[f])
    await db.commit()
    await db.refresh(d)
    return _dest_dict(d)


@router.delete("/destinations/{dest_id}", status_code=204)
async def delete_destination(dest_id: int, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    from backend.models import NotificationDestination
    d = (await db.execute(select(NotificationDestination).where(NotificationDestination.id == dest_id))).scalar_one_or_none()
    if d is not None:
        await db.delete(d)
        await db.commit()


@router.post("/destinations/{dest_id}/test")
async def test_destination(dest_id: int, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    from backend.models import NotificationDestination
    from backend.notifier import _send_destination
    d = (await db.execute(select(NotificationDestination).where(NotificationDestination.id == dest_id))).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Destination not found")
    await _send_destination(d, "apt-ui test notification", "This is a test from apt-ui.")
    return {"detail": "Test sent"}
