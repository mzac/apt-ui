"""
Export / import the full application configuration:
  groups, servers, schedule config, and notification config.
Passwords/secrets in the export are included as-is (the file should be
treated as sensitive). SSH keys are NOT exported.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import (
    NotificationConfig, ScheduleConfig, Server, ServerGroup, User,
)

router = APIRouter(prefix="/api/config", tags=["config"])

_EXPORT_VERSION = 1


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@router.get("/export")
async def export_config(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    groups_result = await db.execute(select(ServerGroup).order_by(ServerGroup.sort_order, ServerGroup.name))
    groups = [
        {"name": g.name, "color": g.color, "sort_order": g.sort_order}
        for g in groups_result.scalars().all()
    ]

    servers_result = await db.execute(select(Server).order_by(Server.name))
    servers = [
        {
            "name": s.name,
            "hostname": s.hostname,
            "username": s.username,
            "ssh_port": s.ssh_port,
            "group_name": None,  # resolved below
            "is_enabled": s.is_enabled,
        }
        for s in servers_result.scalars().all()
    ]
    # Resolve group names
    group_map: dict[int, str] = {}
    for g in (await db.execute(select(ServerGroup))).scalars().all():
        group_map[g.id] = g.name
    srv_rows = (await db.execute(select(Server).order_by(Server.name))).scalars().all()
    for i, s in enumerate(srv_rows):
        servers[i]["group_name"] = group_map.get(s.group_id) if s.group_id else None

    sched_result = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    sched = sched_result.scalar_one_or_none()
    schedule = {}
    if sched:
        schedule = {
            "check_enabled": sched.check_enabled,
            "check_cron": sched.check_cron,
            "auto_upgrade_enabled": sched.auto_upgrade_enabled,
            "auto_upgrade_cron": sched.auto_upgrade_cron,
            "allow_phased_on_auto": sched.allow_phased_on_auto,
            "upgrade_concurrency": sched.upgrade_concurrency,
            "log_retention_days": sched.log_retention_days,
        }

    notif_result = await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
    notif = notif_result.scalar_one_or_none()
    notifications = {}
    if notif:
        notifications = {
            "email_enabled": notif.email_enabled,
            "smtp_host": notif.smtp_host,
            "smtp_port": notif.smtp_port,
            "smtp_use_tls": notif.smtp_use_tls,
            "smtp_username": notif.smtp_username,
            "smtp_password": notif.smtp_password,
            "email_from": notif.email_from,
            "email_to": notif.email_to,
            "telegram_enabled": notif.telegram_enabled,
            "telegram_bot_token": notif.telegram_bot_token,
            "telegram_chat_id": notif.telegram_chat_id,
            "daily_summary_enabled": notif.daily_summary_enabled,
            "daily_summary_time": notif.daily_summary_time,
            "notify_on_upgrade_complete": notif.notify_on_upgrade_complete,
            "notify_on_error": notif.notify_on_error,
        }

    payload = {
        "version": _EXPORT_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "groups": groups,
        "servers": servers,
        "schedule": schedule,
        "notifications": notifications,
    }
    return JSONResponse(content=payload, headers={
        "Content-Disposition": f'attachment; filename="apt-dashboard-config-{datetime.utcnow().strftime("%Y%m%d")}.json"'
    })


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

class ImportPayload(dict):
    pass


from pydantic import BaseModel
from typing import Any


class ImportRequest(BaseModel):
    data: dict[str, Any]
    overwrite_servers: bool = False
    overwrite_schedule: bool = True
    overwrite_notifications: bool = True


@router.post("/import")
async def import_config(
    body: ImportRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    data = body.data
    results: dict[str, Any] = {"groups": 0, "servers": 0, "skipped_servers": 0}

    # --- Groups (upsert by name) ---
    for g in data.get("groups", []):
        name = g.get("name")
        if not name:
            continue
        existing = (await db.execute(select(ServerGroup).where(ServerGroup.name == name))).scalar_one_or_none()
        if existing:
            existing.color = g.get("color", existing.color)
            existing.sort_order = g.get("sort_order", existing.sort_order)
        else:
            db.add(ServerGroup(name=name, color=g.get("color"), sort_order=g.get("sort_order", 0)))
            results["groups"] += 1
    await db.commit()

    # Refresh group name→id map
    group_map: dict[str, int] = {
        g.name: g.id
        for g in (await db.execute(select(ServerGroup))).scalars().all()
    }

    # --- Servers (upsert by hostname) ---
    for s in data.get("servers", []):
        hostname = s.get("hostname")
        if not hostname:
            continue
        existing = (await db.execute(select(Server).where(Server.hostname == hostname))).scalar_one_or_none()
        if existing and not body.overwrite_servers:
            results["skipped_servers"] += 1
            continue
        group_id = group_map.get(s.get("group_name")) if s.get("group_name") else None
        if existing:
            existing.name = s.get("name", existing.name)
            existing.username = s.get("username", existing.username)
            existing.ssh_port = s.get("ssh_port", existing.ssh_port)
            existing.group_id = group_id
            existing.is_enabled = s.get("is_enabled", existing.is_enabled)
        else:
            db.add(Server(
                name=s.get("name", hostname),
                hostname=hostname,
                username=s.get("username", "root"),
                ssh_port=s.get("ssh_port", 22),
                group_id=group_id,
                is_enabled=s.get("is_enabled", True),
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            ))
            results["servers"] += 1
    await db.commit()

    # --- Schedule ---
    if body.overwrite_schedule and data.get("schedule"):
        s = data["schedule"]
        sched = (await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))).scalar_one_or_none()
        if sched:
            for field in ["check_enabled", "check_cron", "auto_upgrade_enabled", "auto_upgrade_cron",
                          "allow_phased_on_auto", "upgrade_concurrency", "log_retention_days"]:
                if field in s:
                    setattr(sched, field, s[field])
        await db.commit()
        results["schedule"] = True

    # --- Notifications ---
    if body.overwrite_notifications and data.get("notifications"):
        n = data["notifications"]
        notif = (await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))).scalar_one_or_none()
        if notif:
            for field in ["email_enabled", "smtp_host", "smtp_port", "smtp_use_tls", "smtp_username",
                          "smtp_password", "email_from", "email_to", "telegram_enabled",
                          "telegram_bot_token", "telegram_chat_id", "daily_summary_enabled",
                          "daily_summary_time", "notify_on_upgrade_complete", "notify_on_error"]:
                if field in n:
                    setattr(notif, field, n[field])
        await db.commit()
        results["notifications"] = True

    return {"imported": results}


# ---------------------------------------------------------------------------
# CSV export of servers
# ---------------------------------------------------------------------------

@router.get("/servers/csv")
async def export_servers_csv(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    import csv, io
    servers_result = await db.execute(select(Server).order_by(Server.name))
    srv_rows = servers_result.scalars().all()
    group_map: dict[int, str] = {
        g.id: g.name
        for g in (await db.execute(select(ServerGroup))).scalars().all()
    }
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["name", "hostname", "username", "ssh_port", "group_name", "is_enabled"])
    for s in srv_rows:
        writer.writerow([s.name, s.hostname, s.username, s.ssh_port,
                         group_map.get(s.group_id, "") if s.group_id else "", "true" if s.is_enabled else "false"])
    from fastapi.responses import Response
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="apt-dashboard-servers-{datetime.utcnow().strftime("%Y%m%d")}.csv"'},
    )


# ---------------------------------------------------------------------------
# CSV import of servers
# ---------------------------------------------------------------------------

from fastapi import UploadFile, File


@router.post("/servers/csv")
async def import_servers_csv(
    file: UploadFile = File(...),
    overwrite: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    import csv, io
    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    group_map: dict[str, int] = {}
    for g in (await db.execute(select(ServerGroup))).scalars().all():
        group_map[g.name] = g.id

    added = skipped = 0
    for row in reader:
        hostname = (row.get("hostname") or "").strip()
        if not hostname:
            continue
        name = (row.get("name") or hostname).strip()
        username = (row.get("username") or "root").strip()
        try:
            ssh_port = int(row.get("ssh_port") or 22)
        except ValueError:
            ssh_port = 22
        group_name = (row.get("group_name") or "").strip()
        group_id = group_map.get(group_name) if group_name else None
        is_enabled = (row.get("is_enabled") or "true").strip().lower() != "false"

        existing = (await db.execute(select(Server).where(Server.hostname == hostname))).scalar_one_or_none()
        if existing:
            if overwrite:
                existing.name = name
                existing.username = username
                existing.ssh_port = ssh_port
                existing.group_id = group_id
                existing.is_enabled = is_enabled
            else:
                skipped += 1
                continue
        else:
            db.add(Server(
                name=name, hostname=hostname, username=username,
                ssh_port=ssh_port, group_id=group_id, is_enabled=is_enabled,
                created_at=datetime.utcnow(), updated_at=datetime.utcnow(),
            ))
            added += 1

    await db.commit()
    return {"added": added, "skipped": skipped}
