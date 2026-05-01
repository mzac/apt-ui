"""
Prometheus /metrics endpoint (issue #45).

Exposes fleet state as Prometheus gauges/counters for scraping by Grafana,
VictoriaMetrics, etc. Optionally protected by a bearer token via the
METRICS_TOKEN env var; if unset, the endpoint is unauthenticated.

Scrape config example:
  - job_name: apt-ui
    metrics_path: /metrics
    bearer_token: <your-METRICS_TOKEN-value>  # optional
    static_configs:
      - targets: ['apt-ui.example.com']
"""

import os
import time
from datetime import datetime

from fastapi import APIRouter, Header, HTTPException, Response, status
from prometheus_client import (
    CollectorRegistry,
    Gauge,
    generate_latest,
    CONTENT_TYPE_LATEST,
)
from sqlalchemy import select

from backend.database import AsyncSessionLocal
from backend.models import Server, ServerStats, UpdateCheck

router = APIRouter(tags=["metrics"])

METRICS_TOKEN = os.environ.get("METRICS_TOKEN", "").strip() or None


def _check_auth(authorization: str | None) -> None:
    """Optional bearer token check — only enforced when METRICS_TOKEN is set."""
    if METRICS_TOKEN is None:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization[7:].strip()
    if token != METRICS_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


@router.get("/metrics", include_in_schema=False)
async def prometheus_metrics(authorization: str | None = Header(default=None)):
    _check_auth(authorization)

    # Build a fresh registry per request — gauges reflect current DB state.
    registry = CollectorRegistry()

    g_servers_total = Gauge("apt_ui_servers_total", "Total servers", ["enabled"], registry=registry)
    g_reachable = Gauge("apt_ui_servers_reachable", "Server reachable (1=yes, 0=no)", ["server"], registry=registry)
    g_pending = Gauge("apt_ui_pending_packages", "Pending package upgrades", ["server", "security"], registry=registry)
    g_reboot = Gauge("apt_ui_reboot_required", "Reboot required (1=yes, 0=no)", ["server"], registry=registry)
    g_last_check = Gauge("apt_ui_last_check_age_seconds", "Seconds since last successful check", ["server"], registry=registry)
    g_kernel_age = Gauge("apt_ui_kernel_age_days", "Days since running kernel was installed", ["server"], registry=registry)
    g_disk = Gauge("apt_ui_disk_usage_percent", "Disk usage percentage", ["server", "mount"], registry=registry)
    g_held = Gauge("apt_ui_held_packages", "Number of held packages", ["server"], registry=registry)

    async with AsyncSessionLocal() as db:
        servers_res = await db.execute(select(Server))
        servers = servers_res.scalars().all()

        enabled = sum(1 for s in servers if s.is_enabled)
        g_servers_total.labels(enabled="true").set(enabled)
        g_servers_total.labels(enabled="false").set(len(servers) - enabled)

        for s in servers:
            label = s.name
            g_reachable.labels(server=label).set(1 if s.is_reachable else 0)

            chk_res = await db.execute(
                select(UpdateCheck)
                .where(UpdateCheck.server_id == s.id)
                .order_by(UpdateCheck.checked_at.desc())
                .limit(1)
            )
            chk = chk_res.scalar_one_or_none()
            if chk:
                g_pending.labels(server=label, security="true").set(chk.security_packages or 0)
                g_pending.labels(server=label, security="false").set(chk.regular_packages or 0)
                g_reboot.labels(server=label).set(1 if chk.reboot_required else 0)
                g_held.labels(server=label).set(chk.held_packages or 0)
                if chk.checked_at:
                    age = max(0, int(time.time() - chk.checked_at.timestamp()))
                    g_last_check.labels(server=label).set(age)

            stats_res = await db.execute(
                select(ServerStats)
                .where(ServerStats.server_id == s.id)
                .order_by(ServerStats.recorded_at.desc())
                .limit(1)
            )
            stats = stats_res.scalar_one_or_none()
            if stats:
                if stats.disk_usage_percent is not None:
                    g_disk.labels(server=label, mount="/").set(stats.disk_usage_percent)
                if stats.boot_total_mb and stats.boot_free_mb is not None:
                    used_pct = 100.0 * (1.0 - stats.boot_free_mb / stats.boot_total_mb)
                    g_disk.labels(server=label, mount="/boot").set(used_pct)
                if stats.kernel_install_date:
                    age_days = (datetime.utcnow() - stats.kernel_install_date).days
                    g_kernel_age.labels(server=label).set(max(0, age_days))

    output = generate_latest(registry)
    return Response(content=output, media_type=CONTENT_TYPE_LATEST)


# ---------------------------------------------------------------------------
# CVE matcher status / manual refresh (issue #37)
# ---------------------------------------------------------------------------

from fastapi import Depends as _Depends  # noqa: E402

from backend.auth import get_current_user, require_admin  # noqa: E402
from backend.models import User  # noqa: E402


@router.get("/api/cve/status")
async def cve_status(_: User = _Depends(get_current_user)):
    from backend.cve_matcher import cache_status
    return cache_status()


@router.post("/api/cve/refresh")
async def cve_refresh(_: User = _Depends(require_admin)):
    """Manually trigger a CVE feed refresh."""
    from backend.cve_matcher import refresh_and_reload
    payload = await refresh_and_reload()
    return {
        "fetched_at": payload.get("fetched_at"),
        "package_count": payload.get("package_count", 0),
    }
