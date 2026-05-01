"""
Public status page (issue #50).

`/status.json` returns a compact fleet health snapshot suitable for embedding
in dashboards. No auth required when STATUS_PAGE_PUBLIC=true (default false);
otherwise returns 404.

Hostnames are not included by default to avoid leaking inventory; set
STATUS_PAGE_SHOW_NAMES=true to include server names (still not hostnames).
"""

import os
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from backend.database import AsyncSessionLocal
from backend.models import Server, UpdateCheck

router = APIRouter(tags=["status"])

PUBLIC = os.environ.get("STATUS_PAGE_PUBLIC", "").lower() in ("1", "true", "yes")
SHOW_NAMES = os.environ.get("STATUS_PAGE_SHOW_NAMES", "").lower() in ("1", "true", "yes")
TITLE = os.environ.get("STATUS_PAGE_TITLE", "apt-ui Fleet Status").strip()


@router.get("/status.json", include_in_schema=False)
async def status_json():
    if not PUBLIC:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    async with AsyncSessionLocal() as db:
        srv_res = await db.execute(select(Server).where(Server.is_enabled == True))
        servers = srv_res.scalars().all()

        total = len(servers)
        reachable = sum(1 for s in servers if s.is_reachable)

        with_updates = 0
        with_security = 0
        with_errors = 0
        with_reboot = 0
        last_check_max_age: int | None = None

        items = []
        for s in servers:
            chk_res = await db.execute(
                select(UpdateCheck)
                .where(UpdateCheck.server_id == s.id)
                .order_by(UpdateCheck.checked_at.desc())
                .limit(1)
            )
            chk = chk_res.scalar_one_or_none()
            if not chk:
                continue
            if chk.status == "error":
                with_errors += 1
            elif (chk.packages_available or 0) > 0:
                with_updates += 1
            if (chk.security_packages or 0) > 0:
                with_security += 1
            if chk.reboot_required:
                with_reboot += 1
            if chk.checked_at:
                age = int(time.time() - chk.checked_at.timestamp())
                last_check_max_age = max(last_check_max_age or 0, age)

            entry: dict = {
                "status": "error" if chk.status == "error"
                          else "updates" if (chk.packages_available or 0) > 0
                          else "ok",
                "reachable": bool(s.is_reachable),
            }
            if SHOW_NAMES:
                entry["name"] = s.name
            items.append(entry)

    overall = "ok"
    if with_errors > 0 or reachable < total:
        overall = "degraded"
    if with_security > 0:
        overall = "warning"

    return {
        "title": TITLE,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "overall": overall,
        "totals": {
            "servers": total,
            "reachable": reachable,
            "with_updates": with_updates,
            "with_security_updates": with_security,
            "with_reboot_required": with_reboot,
            "with_errors": with_errors,
        },
        "max_check_age_seconds": last_check_max_age,
        "servers": items,
    }
