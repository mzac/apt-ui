"""Package version watch evaluation (issue #62).

A :class:`~backend.models.PackageWatch` lets an operator pin a package name and
get alerted when its version either diverges across the fleet or a new version
shows up anywhere. Evaluation is deliberately data-reuse only: it reads the
``packages_json`` blob already written to the latest :class:`~backend.models.UpdateCheck`
row per server (the same cache ``/stats/pending-updates`` and the daily summary
read) instead of opening any new SSH connections.

Important limitation this implies: ``packages_json`` only lists packages that
currently have a *pending upgrade* (``apt list --upgradable`` + the dist-upgrade
dry-run — see ``update_checker.py`` / CLAUDE.md). A server that already has the
watched package at the latest version produces **no entry at all**, so it is
invisible to the watch rather than reporting "up to date". There is no cached
signal that distinguishes "not installed" from "installed and already current"
without an extra SSH round trip, and adding one was explicitly out of scope
here. Divergence/new-version detection below is therefore over the subset of
servers that currently have a pending upgrade for the watched package.

Call :func:`evaluate_package_watches` once per fleet-check cycle, after fresh
UpdateCheck rows have been written (see backend/scheduler.py `_job_check_all`).
"""

import json
import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import NotificationConfig, PackageWatch, Server, UpdateCheck
from backend.query_helpers import latest_checks_by_server

logger = logging.getLogger(__name__)


def _fleet_versions_for_package(
    checks: dict[int, UpdateCheck],
    servers: dict[int, Server],
    package_name: str,
) -> dict[str, dict[str, str]]:
    """Return ``{server_name: {"current": ..., "available": ...}}`` for every
    server whose latest cached check has a pending upgrade for *package_name*.

    Servers with no pending upgrade for this package (already current, not
    installed, or held) are simply absent — see the module docstring.
    """
    state: dict[str, dict[str, str]] = {}
    for server_id, chk in checks.items():
        if not chk or not chk.packages_json:
            continue
        server = servers.get(server_id)
        if server is None:
            continue
        try:
            pkgs = json.loads(chk.packages_json)
        except Exception:
            continue
        if not isinstance(pkgs, list):
            continue
        for p in pkgs:
            if not isinstance(p, dict) or p.get("name") != package_name:
                continue
            state[server.name] = {
                "current": p.get("current_version") or "",
                "available": p.get("available_version") or "",
            }
            break  # packages_json has at most one entry per package name
    return state


async def evaluate_package_watches(db: AsyncSession) -> None:
    """Evaluate every enabled :class:`PackageWatch` against the latest cached
    check data and fire notifications for divergence / new-version events.

    No-ops immediately if there are no enabled watches, so it is always safe
    to call after a fleet check regardless of whether anyone has configured one.
    """
    watches = (
        await db.execute(select(PackageWatch).where(PackageWatch.enabled == True))
    ).scalars().all()
    if not watches:
        return

    servers = {s.id: s for s in (await db.execute(select(Server))).scalars().all()}
    checks = await latest_checks_by_server(db)
    cfg = (
        await db.execute(select(NotificationConfig).where(NotificationConfig.id == 1))
    ).scalar_one_or_none()

    for watch in watches:
        try:
            await _evaluate_one(db, watch, servers, checks, cfg)
        except Exception:
            logger.exception("Package watch evaluation failed for '%s'", watch.package_name)


async def _evaluate_one(
    db: AsyncSession,
    watch: PackageWatch,
    servers: dict[int, Server],
    checks: dict[int, UpdateCheck],
    cfg: NotificationConfig | None,
) -> None:
    from backend.notifier import notify_package_watch  # local import: avoid import cycle at module load

    new_state = _fleet_versions_for_package(checks, servers, watch.package_name)

    is_first_run = watch.last_versions_json is None
    old_state: dict[str, dict[str, str]] = {}
    if watch.last_versions_json:
        try:
            parsed = json.loads(watch.last_versions_json)
            if isinstance(parsed, dict):
                old_state = parsed
        except Exception:
            old_state = {}

    if new_state == old_state:
        # Nothing changed since the last cycle — this is the dedup that keeps a
        # static (even if already-diverged) fleet state from re-alerting every
        # single check cycle (alert storms are a stated concern for this repo).
        return

    if is_first_run:
        # First-ever evaluation just establishes the baseline. Firing divergence/
        # new-version alerts immediately on watch creation would just restate
        # whatever the fleet's pre-existing state already was, which is exactly
        # the alert-storm-on-creation case we want to avoid.
        watch.last_versions_json = json.dumps(new_state)
        await db.commit()
        return

    notified = False

    current_versions = {v["current"] for v in new_state.values() if v.get("current")}
    old_current_versions = {v["current"] for v in old_state.values() if v.get("current")}
    diverges_now = len(current_versions) > 1
    diverged_before = len(old_current_versions) > 1

    # Only re-alert on divergence if it's a new transition into divergence, or the
    # set of diverging versions actually changed — not on every cycle it persists.
    if watch.notify_on_divergence and diverges_now and (not diverged_before or current_versions != old_current_versions):
        await notify_package_watch(
            cfg, watch, event="divergence",
            detail={"servers": new_state},
        )
        notified = True

    # "New version anywhere" = an available_version we haven't seen before, in
    # either the current or available slot of any prior evaluation.
    old_seen_versions = old_current_versions | {v["available"] for v in old_state.values() if v.get("available")}
    new_versions = {v["available"] for v in new_state.values() if v.get("available")} - old_seen_versions

    if watch.notify_on_new_version and new_versions:
        await notify_package_watch(
            cfg, watch, event="new_version",
            detail={"versions": sorted(new_versions), "servers": new_state},
        )
        notified = True

    watch.last_versions_json = json.dumps(new_state)
    if notified:
        watch.last_notified_at = datetime.utcnow()
    await db.commit()
