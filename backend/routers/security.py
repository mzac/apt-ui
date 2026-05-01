"""
Fleet-wide CVE inventory (issue #54).

This is a pivot of the per-server CVE annotations already produced by
``backend.update_checker.check_server`` (issue #37). The annotation lives in
``UpdateCheck.packages_json`` as ``cves: [{usn, url, severity, ids, fixed_version}]``
on each pending package.

Endpoint:
    GET /api/security/cves
        ?status=pending|fixed|all       (default: pending)
        &severity=critical,high,...     (CSV; default: all)
        &group_id=<id>                  (filter to servers in this group)
        &tag=<name>                     (filter to servers with this tag)
        &since=<ISO date>               (only CVEs first seen on/after this date)
        &until=<ISO date>               (only CVEs first seen on/before this date)

The response is a CVE→servers pivot. ``first_seen_in_fleet`` is the earliest
``UpdateCheck.checked_at`` where the CVE appeared anywhere in the fleet — we
walk every check for every server (capped — we limit the lookback to the
schedule's log_retention_days when available, or 365 days otherwise).
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import (
    ScheduleConfig,
    Server,
    ServerGroupMembership,
    ServerTag,
    Tag,
    UpdateCheck,
    User,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/security", tags=["security"])

_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "unknown": 0}


def _worst(a: str, b: str) -> str:
    return a if _SEVERITY_RANK.get(a, 0) >= _SEVERITY_RANK.get(b, 0) else b


def _parse_severity_csv(severity: str | None) -> set[str] | None:
    if not severity:
        return None
    parts = {s.strip().lower() for s in severity.split(",") if s.strip()}
    return parts or None


async def _filtered_server_ids(
    db: AsyncSession,
    group_id: int | None,
    tag: str | None,
) -> set[int] | None:
    """Return the set of server IDs to include, or None for "no filter".

    Combines group + tag filters with an intersection (AND).
    """
    sets: list[set[int]] = []

    if group_id is not None:
        rows = await db.execute(
            select(ServerGroupMembership.server_id).where(
                ServerGroupMembership.group_id == group_id
            )
        )
        sets.append({r[0] for r in rows.all()})

    if tag:
        rows = await db.execute(
            select(ServerTag.server_id)
            .join(Tag, Tag.id == ServerTag.tag_id)
            .where(Tag.name == tag)
        )
        sets.append({r[0] for r in rows.all()})

    if not sets:
        return None

    out = sets[0]
    for s in sets[1:]:
        out &= s
    return out


async def _compute_cve_pivot(
    db: AsyncSession,
    *,
    status: str = "all",
    severities: set[str] | None = None,
    server_filter: set[int] | None = None,
    since_dt: datetime | None = None,
    until_dt: datetime | None = None,
) -> list[dict[str, Any]]:
    """Core aggregation — used by both /cves and /summary."""
    cfg_res = await db.execute(select(ScheduleConfig).where(ScheduleConfig.id == 1))
    cfg = cfg_res.scalar_one_or_none()
    lookback_days = cfg.log_retention_days if cfg and cfg.log_retention_days else 365
    cutoff = datetime.utcnow() - timedelta(days=lookback_days)

    srv_res = await db.execute(select(Server))
    servers_by_id: dict[int, Server] = {s.id: s for s in srv_res.scalars().all()}

    first_seen: dict[tuple[str, str], datetime] = {}
    cve_meta: dict[tuple[str, str], dict[str, Any]] = {}
    pending_in_latest: dict[tuple[str, str], dict[int, dict[str, Any]]] = defaultdict(dict)
    ever_seen: dict[tuple[str, str], set[int]] = defaultdict(set)

    latest_checks: dict[int, UpdateCheck] = {}
    for sid in servers_by_id:
        if server_filter is not None and sid not in server_filter:
            continue
        latest_res = await db.execute(
            select(UpdateCheck)
            .where(UpdateCheck.server_id == sid, UpdateCheck.status == "success")
            .order_by(UpdateCheck.checked_at.desc())
            .limit(1)
        )
        latest = latest_res.scalar_one_or_none()
        if latest is not None:
            latest_checks[sid] = latest

    for sid in servers_by_id:
        if server_filter is not None and sid not in server_filter:
            continue
        chk_res = await db.execute(
            select(UpdateCheck)
            .where(
                UpdateCheck.server_id == sid,
                UpdateCheck.status == "success",
                UpdateCheck.checked_at >= cutoff,
            )
            .order_by(UpdateCheck.checked_at.asc())
        )
        for chk in chk_res.scalars().all():
            if not chk.packages_json:
                continue
            try:
                pkgs = json.loads(chk.packages_json)
            except Exception:
                continue
            for p in pkgs:
                cves = p.get("cves") or []
                if not cves:
                    continue
                pkg_name = p.get("name") or ""
                for usn_entry in cves:
                    sev = (usn_entry.get("severity") or "unknown").lower()
                    cve_ids: list[str] = list(usn_entry.get("ids") or [])
                    usn_id = usn_entry.get("usn") or ""
                    fixed_version = usn_entry.get("fixed_version") or ""
                    url = usn_entry.get("url") or (
                        f"https://ubuntu.com/security/notices/USN-{usn_id}" if usn_id else ""
                    )
                    ids_for_key = cve_ids or [f"USN-{usn_id}"]
                    for cid in ids_for_key:
                        key = (cid, pkg_name)
                        if key not in first_seen or chk.checked_at < first_seen[key]:
                            first_seen[key] = chk.checked_at
                        meta = cve_meta.get(key)
                        if meta is None:
                            cve_meta[key] = {
                                "cve_id": cid,
                                "package": pkg_name,
                                "usn_ids": [usn_id] if usn_id else [],
                                "severity": sev,
                                "fixed_version": fixed_version,
                                "url": url,
                            }
                        else:
                            meta["severity"] = _worst(meta["severity"], sev)
                            if usn_id and usn_id not in meta["usn_ids"]:
                                meta["usn_ids"].append(usn_id)
                            if not meta.get("fixed_version") and fixed_version:
                                meta["fixed_version"] = fixed_version
                        ever_seen[key].add(sid)

    for sid, chk in latest_checks.items():
        if not chk.packages_json:
            continue
        try:
            pkgs = json.loads(chk.packages_json)
        except Exception:
            continue
        for p in pkgs:
            cves = p.get("cves") or []
            if not cves:
                continue
            pkg_name = p.get("name") or ""
            installed_version = p.get("current_version") or ""
            for usn_entry in cves:
                cve_ids = list(usn_entry.get("ids") or [])
                usn_id = usn_entry.get("usn") or ""
                ids_for_key = cve_ids or [f"USN-{usn_id}"]
                fixed_version = usn_entry.get("fixed_version") or ""
                for cid in ids_for_key:
                    key = (cid, pkg_name)
                    pending_in_latest[key][sid] = {
                        "id": sid,
                        "name": servers_by_id[sid].name if sid in servers_by_id else f"#{sid}",
                        "hostname": servers_by_id[sid].hostname if sid in servers_by_id else "",
                        "installed_version": installed_version,
                        "fixed_version": fixed_version,
                        "status": "pending",
                    }

    out: list[dict[str, Any]] = []
    for key, meta in cve_meta.items():
        first = first_seen.get(key)
        pending = pending_in_latest.get(key, {})
        ever = ever_seen.get(key, set())

        if pending and len(pending) == len(ever):
            row_status = "pending"
        elif pending and len(pending) < len(ever):
            row_status = "partial"
        else:
            row_status = "fixed"

        if status == "pending" and row_status == "fixed":
            continue
        if status == "fixed" and row_status != "fixed":
            continue

        if severities and meta["severity"] not in severities:
            continue

        if since_dt and (first is None or first < since_dt):
            continue
        if until_dt and (first is not None and first > until_dt):
            continue

        affected: list[dict[str, Any]] = list(pending.values())
        if status != "pending":
            for sid in ever - set(pending.keys()):
                if sid not in servers_by_id:
                    continue
                affected.append({
                    "id": sid,
                    "name": servers_by_id[sid].name,
                    "hostname": servers_by_id[sid].hostname,
                    "installed_version": "",
                    "fixed_version": meta.get("fixed_version", ""),
                    "status": "fixed",
                })

        affected.sort(key=lambda s: s.get("name", "").lower())

        out.append({
            "cve_id": meta["cve_id"],
            "usn_ids": [f"USN-{u}" if u and not u.startswith("USN-") else u for u in meta["usn_ids"]],
            "severity": meta["severity"],
            "package": meta["package"],
            "fixed_version": meta.get("fixed_version", ""),
            "url": meta.get("url", ""),
            "first_seen_in_fleet": first.isoformat() + "Z" if first else None,
            "status": row_status,
            "affected_servers": affected,
            "affected_count": len(affected),
            "pending_count": len(pending),
        })

    out.sort(
        key=lambda r: (
            -_SEVERITY_RANK.get(r["severity"], 0),
            -r["pending_count"],
            r["cve_id"],
        )
    )
    return out


@router.get("/cves")
async def list_cves(
    status: str = Query(default="pending", pattern="^(pending|fixed|all)$"),
    severity: str | None = Query(default=None),
    group_id: int | None = Query(default=None),
    tag: str | None = Query(default=None),
    since: str | None = Query(default=None, description="ISO date — only CVEs first seen on/after"),
    until: str | None = Query(default=None, description="ISO date — only CVEs first seen on/before"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Pivot per-server CVE annotations into a CVE→servers view."""

    severities = _parse_severity_csv(severity)
    server_filter = await _filtered_server_ids(db, group_id, tag)

    since_dt: datetime | None = None
    until_dt: datetime | None = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            since_dt = None
    if until:
        try:
            until_dt = datetime.fromisoformat(until.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            until_dt = None

    return await _compute_cve_pivot(
        db,
        status=status,
        severities=severities,
        server_filter=server_filter,
        since_dt=since_dt,
        until_dt=until_dt,
    )


@router.get("/summary")
async def cve_summary(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, int]:
    """Lightweight counters for nav badge & header tiles. No filters."""
    rows = await _compute_cve_pivot(db, status="all")

    open_total = sum(1 for r in rows if r["status"] != "fixed")
    crit = sum(1 for r in rows if r["status"] != "fixed" and r["severity"] == "critical")
    high = sum(1 for r in rows if r["status"] != "fixed" and r["severity"] == "high")

    week_ago = datetime.utcnow() - timedelta(days=7)
    fixed_7d = 0
    for r in rows:
        if r["status"] != "fixed":
            continue
        fs = r.get("first_seen_in_fleet")
        if not fs:
            continue
        try:
            ts = datetime.fromisoformat(fs.rstrip("Z"))
        except ValueError:
            continue
        if ts >= week_ago:
            fixed_7d += 1

    return {
        "open_total": open_total,
        "critical": crit,
        "high": high,
        "fixed_last_7d": fixed_7d,
    }
