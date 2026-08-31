"""
Fleet-wide CVE inventory (issue #54) + remediation planner (issue #62).

This is a pivot of the per-server CVE annotations already produced by
``backend.update_checker.check_server`` (issue #37). The annotation lives in
``UpdateCheck.packages_json`` as ``cves: [{usn, url, severity, ids, fixed_version}]``
on each pending package.

Endpoints:
    GET /api/security/cves
        ?status=pending|fixed|all       (default: pending)
        &severity=critical,high,...     (CSV; default: all)
        &group_id=<id>                  (filter to servers in this group)
        &tag=<name>                     (filter to servers with this tag)
        &since=<ISO date>               (only CVEs first seen on/after this date)
        &until=<ISO date>               (only CVEs first seen on/before this date)
    GET /api/security/summary
    GET /api/security/severity/status
    GET /api/security/remediation/{identifier}   (a CVE-... or USN-... id)

The /cves response is a CVE→servers pivot. ``first_seen_in_fleet`` is the earliest
``UpdateCheck.checked_at`` where the CVE appeared anywhere in the fleet — we
walk every check for every server (capped — we limit the lookback to the
schedule's log_retention_days when available, or 365 days otherwise).

Severity (issue #62): ``backend.cve_matcher.severity_for_cve()`` is a pure,
in-memory lookup against a separately-cached, real severity source (Ubuntu's
``ubuntu.com/security/cves.json`` API — see that module's docstring for the
live-verified shape and the reliability findings that shaped its design). It
never blocks this endpoint; ``list_cves`` schedules a bounded, best-effort
background backfill (FastAPI ``BackgroundTasks``) for whatever packages are
still "unknown" in the current view, so severity fills in progressively
across page loads without ever making a page load wait on a flaky upstream API.

MTTR (issue #62): a CVE row only flips to "fixed" once every server that ever
had it pending has cleared it. We can prove *when* each server cleared it by
walking that server's check history and noting the first check where a
previously-pending (cve, package) pair disappears — that's real evidence of
resolution, not a guess. ``mttr_hours`` on a row is populated only when we have
that proof for every server that ever saw the CVE; otherwise it's left ``null``
with an explanatory ``mttr_note`` (e.g. resolved before the retention window
began) rather than inventing a number.
"""

from __future__ import annotations

import json
import logging
import statistics
from collections import defaultdict
from datetime import datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import cve_matcher
from backend.auth import get_current_user
from backend.database import get_db
from backend.eol_data import parse_os_info
from backend.models import (
    ScheduleConfig,
    Server,
    ServerGroupMembership,
    ServerTag,
    Tag,
    UpdateCheck,
    User,
)
from backend.query_helpers import latest_checks_by_server
from backend.timeutil import utc_iso

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/security", tags=["security"])

_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "unknown": 0}

# Ubuntu release version -> codename, used only to pick the *release-specific* fixed
# version out of cve_matcher.usn_releases_for() for a given server (issue #62). Server.os_info
# is a free-form PRETTY_NAME string (e.g. "Ubuntu 22.04.3 LTS") with no codename, so
# backend.eol_data.parse_os_info() gets us (os_id, version_id) and this table finishes the
# job for Ubuntu servers. Non-Ubuntu servers (Debian, Proxmox, ...) fall back to a
# best-effort version drawn from any release the USN mentions (marked "approximate" in the
# response) — the USN feed only carries Ubuntu release codenames.
_UBUNTU_CODENAME_BY_VERSION = {
    "14.04": "trusty", "16.04": "xenial", "18.04": "bionic", "19.10": "eoan",
    "20.04": "focal", "20.10": "groovy", "21.04": "hirsute", "21.10": "impish",
    "22.04": "jammy", "22.10": "kinetic", "23.04": "lunar", "23.10": "mantic",
    "24.04": "noble", "24.10": "oracular", "25.04": "plucky", "25.10": "questing",
    "26.04": "resolute",
}


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
    # MTTR support (issue #62): per-(cve,package) key, per-server first-seen and the
    # checked_at of the first check where it stopped appearing after having appeared —
    # i.e. real, observed proof of resolution (see module docstring for the honesty rule).
    first_seen_per_server: dict[tuple[str, str], dict[int, datetime]] = defaultdict(dict)
    resolved_at: dict[tuple[str, str], dict[int, datetime]] = defaultdict(dict)

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
        prev_pending_keys: set[tuple[str, str]] = set()
        for chk in chk_res.scalars().all():
            if not chk.packages_json:
                continue
            try:
                pkgs = json.loads(chk.packages_json)
            except Exception:
                continue
            this_check_keys: set[tuple[str, str]] = set()
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
                        this_check_keys.add(key)
                        if key not in first_seen or chk.checked_at < first_seen[key]:
                            first_seen[key] = chk.checked_at
                        if sid not in first_seen_per_server[key] or chk.checked_at < first_seen_per_server[key][sid]:
                            first_seen_per_server[key][sid] = chk.checked_at
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
            # Any key pending in the previous check for this server but absent from this
            # one just proved it stopped being pending by chk.checked_at — real evidence
            # for MTTR, not an inference (issue #62).
            for key in prev_pending_keys - this_check_keys:
                resolved_at[key].setdefault(sid, chk.checked_at)
            prev_pending_keys = this_check_keys

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

        # Real severity (issue #62) — cve_matcher.severity_for_cve() is a pure in-memory
        # lookup against the separately-cached Ubuntu CVE API data (see module docstring).
        # The USN feed annotation in `meta["severity"]` is currently always "unknown" (that
        # feed carries no severity at all), so this is the only source of a real bucket
        # today; falling back to `meta["severity"]` keeps this forward-compatible if the
        # USN feed ever starts carrying one.
        cve_id = meta["cve_id"]
        real_sev = cve_matcher.severity_for_cve(cve_id) if cve_id.startswith("CVE-") else "unknown"
        severity = real_sev if real_sev != "unknown" else meta["severity"]

        if severities and severity not in severities:
            continue

        if since_dt and (first is None or first < since_dt):
            continue
        if until_dt and (first is not None and first > until_dt):
            continue

        # MTTR (issue #62) — only claim a number when every server that ever had this
        # pending has proven resolution evidence in-window; otherwise be explicit about why
        # not, rather than guessing.
        mttr_hours: float | None = None
        mttr_note: str | None = None
        if row_status == "fixed" and ever:
            resolved_map = resolved_at.get(key, {})
            fs_map = first_seen_per_server.get(key, {})
            if ever <= set(resolved_map.keys()):
                latest_resolved = max(resolved_map[s] for s in ever)
                earliest_seen = min(fs_map.get(s, first) or first for s in ever)
                if earliest_seen and latest_resolved >= earliest_seen:
                    mttr_hours = round((latest_resolved - earliest_seen).total_seconds() / 3600, 1)
            if mttr_hours is None:
                mttr_note = (
                    "No reliable MTTR: at least one affected server's resolution wasn't "
                    "observed within the retention window (e.g. it was already fixed before "
                    "history in this window began)."
                )

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
            "severity": severity,
            "package": meta["package"],
            "fixed_version": meta.get("fixed_version", ""),
            "url": meta.get("url", ""),
            "first_seen_in_fleet": utc_iso(first),
            "status": row_status,
            "affected_servers": affected,
            "affected_count": len(affected),
            "pending_count": len(pending),
            "mttr_hours": mttr_hours,
            "mttr_note": mttr_note,
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
    background_tasks: BackgroundTasks,
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
        raw_until = until.strip()
        try:
            parsed = datetime.fromisoformat(raw_until.replace("Z", "+00:00")).replace(tzinfo=None)
            # "To (inclusive)": a bare date means "through the end of that day".
            # Parsing it as midnight excluded every CVE first seen during the day
            # the user picked as the end of the range.
            date_only = "T" not in raw_until and ":" not in raw_until
            until_dt = datetime.combine(parsed.date(), time.max) if date_only else parsed
        except ValueError:
            until_dt = None

    rows = await _compute_cve_pivot(
        db,
        status=status,
        severities=severities,
        server_filter=server_filter,
        since_dt=since_dt,
        until_dt=until_dt,
    )

    # Best-effort, bounded severity backfill (issue #62) for whatever packages in *this*
    # view are still "unknown" — runs after the response is sent (FastAPI BackgroundTasks),
    # so a flaky/slow upstream API (see cve_matcher module docstring) never delays the page.
    missing_packages = sorted({r["package"] for r in rows if r["severity"] == "unknown" and r["package"]})
    if missing_packages:
        background_tasks.add_task(cve_matcher.fetch_severities_for_packages, missing_packages)

    return rows


@router.get("/summary")
async def cve_summary(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
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

    # MTTR (issue #62) — median across rows where _compute_cve_pivot could actually prove
    # a resolution time (see its docstring). None of these are invented: mttr_hours is only
    # ever set when every affected server's resolution was directly observed in-window.
    mttr_samples = [r["mttr_hours"] for r in rows if r.get("mttr_hours") is not None]
    median_mttr_hours = round(statistics.median(mttr_samples), 1) if mttr_samples else None

    return {
        "open_total": open_total,
        "critical": crit,
        "high": high,
        "fixed_last_7d": fixed_7d,
        "median_mttr_hours": median_mttr_hours,
        "mttr_sample_size": len(mttr_samples),
    }


@router.get("/severity/status")
async def severity_status(
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Coverage of the real-severity cache (issue #62) — how many CVEs/packages have been
    resolved against the Ubuntu CVE API so far, for an admin/observability view."""
    return cve_matcher.severity_cache_status()


# ---------------------------------------------------------------------------
# Remediation planner (issue #62)
# ---------------------------------------------------------------------------

def _server_ubuntu_codename(server: Server) -> str | None:
    os_id, version_id = parse_os_info(server.os_info)
    if os_id != "ubuntu" or not version_id:
        return None
    return _UBUNTU_CODENAME_BY_VERSION.get(version_id)


async def _compute_remediation_plan(db: AsyncSession, identifier: str) -> dict[str, Any]:
    """Per-server remediation plan for one CVE-id or USN-id (issue #62).

    For the given identifier, resolves the USN(s) that fix it, pulls their release-aware
    fixed-version data out of ``cve_matcher`` (built from the same USN feed already cached
    for issue #37 — no extra fetch), and cross-references that against each server's
    *actual currently-pending* packages (the same ``UpdateCheck.packages_json`` data the
    rest of this router already reads) to say, per server: is the fix actually available
    in what apt already sees as pending right now, and if so, exactly which package names
    to pass to the existing selective-upgrade engine
    (``/api/ws/upgrade-selective/{server_id}`` → ``upgrade_manager.upgrade_packages_selective``)
    to remediate it. No new upgrade path is introduced — this only produces the package list
    that engine already accepts.
    """
    ident = identifier.strip()
    cve_id: str | None = None
    if ident.upper().startswith("CVE-"):
        cve_id = ident.upper()
        usn_ids = cve_matcher.usns_for_cve(cve_id)
    else:
        usn_ids = [ident.upper().removeprefix("USN-")]

    if not usn_ids:
        return {
            "identifier": identifier,
            "found": False,
            "message": (
                "No USN found for this identifier in the cached feed — it may not have been "
                "refreshed yet, or this id doesn't exist in Ubuntu's USN database."
            ),
        }

    # Union of every release's {package: fixed_version} across all matching USNs. Release-
    # specific resolution happens per-server below; this union is also the fallback when a
    # server's Ubuntu release can't be determined (e.g. Debian/Proxmox — the USN feed only
    # carries Ubuntu release codenames).
    package_versions_by_release: dict[str, dict[str, str]] = {}
    any_release_versions: dict[str, str] = {}
    for usn_id in usn_ids:
        for codename, pkgs in cve_matcher.usn_releases_for(usn_id).items():
            package_versions_by_release.setdefault(codename, {}).update(pkgs)
            any_release_versions.update(pkgs)

    if not any_release_versions:
        return {
            "identifier": identifier,
            "found": False,
            "message": "USN(s) found but carry no package/version data in the cached feed.",
        }

    expected_packages = set(any_release_versions.keys())

    srv_res = await db.execute(select(Server).where(Server.is_enabled == True))  # noqa: E712
    servers = srv_res.scalars().all()
    latest_checks = await latest_checks_by_server(db)

    affected: list[dict[str, Any]] = []
    remediation_plan: list[dict[str, Any]] = []

    for server in servers:
        chk = latest_checks.get(server.id)
        pending_by_name: dict[str, dict[str, Any]] = {}
        if chk and chk.packages_json:
            try:
                for p in json.loads(chk.packages_json):
                    name = p.get("name")
                    if name:
                        pending_by_name[name] = p
            except Exception:
                pass

        codename = _server_ubuntu_codename(server)
        release_versions = package_versions_by_release.get(codename) if codename else None
        version_confidence = "exact" if release_versions else "approximate"
        version_map = release_versions or any_release_versions

        matched = [
            {
                "name": name,
                "current_version": p.get("current_version", ""),
                "available_version": p.get("available_version", ""),
                "required_fixed_version": version_map.get(name, ""),
            }
            for name, p in pending_by_name.items()
            if name in expected_packages
        ]
        matched.sort(key=lambda m: m["name"])

        entry = {
            "server_id": server.id,
            "name": server.name,
            "hostname": server.hostname,
            "ubuntu_codename": codename,
            "status": "fix_pending" if matched else "not_pending",
            "version_confidence": version_confidence if matched else None,
            "matched_packages": matched,
            "note": None if matched else (
                "None of this USN's packages are in this server's current pending-update "
                "list — it may already be patched, the package may not be installed here, "
                "or the apt cache is stale (run a check)."
            ),
        }
        affected.append(entry)
        if matched:
            remediation_plan.append({
                "server_id": server.id,
                "name": server.name,
                "packages": [m["name"] for m in matched],
            })

    affected.sort(key=lambda a: (a["status"] != "fix_pending", a["name"].lower()))

    return {
        "identifier": identifier,
        "found": True,
        "cve_id": cve_id,
        "usn_ids": [f"USN-{u}" if not u.startswith("USN-") else u for u in usn_ids],
        "expected_packages": sorted(expected_packages),
        "affected_servers": affected,
        "pending_count": sum(1 for a in affected if a["status"] == "fix_pending"),
        "not_pending_count": sum(1 for a in affected if a["status"] != "fix_pending"),
        # Ready to feed straight into the existing per-server selective-upgrade WS —
        # {server_id, name, packages} per server that actually has the fix pending.
        "remediation_plan": remediation_plan,
    }


@router.get("/remediation/{identifier}")
async def remediation_plan(
    identifier: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Per-server remediation plan for a CVE-... or USN-... identifier (issue #62)."""
    if not identifier or len(identifier) > 40:
        raise HTTPException(status_code=400, detail="Invalid identifier")
    return await _compute_remediation_plan(db, identifier)
