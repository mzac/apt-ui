"""
CVE matcher (issue #37) + remediation-planner support data (issue #62).

Daily job fetches Ubuntu's USN (Security Notice) database and caches it as a
small lookup table {package_name: [{usn, cves, severity, summary, fixed_version}]}.

Notes:
- Ubuntu USN covers most Debian packages too (same source), so we use a single
  feed for both Ubuntu and Debian-derived servers.
- The feed at usn-db/database.json is ~344 MB uncompressed (verified 2026-08-31)
  and held in memory only transiently while indexing; we cache the small
  post-processed index in /data/cve_cache.json to keep lookups fast and avoid
  re-downloading it on every request.
- We do NOT do exact version comparison (Debian version semantics are tricky);
  we surface the most recent USN per package so the user can decide if their
  version is below the fix. The UI links to the USN URL for details.

Severity (issue #62)
---------------------
The USN feed above carries NO severity data — verified 2026-08-31: 7788+
entries, every "cves" value is a flat list of CVE id strings, and the
"cves_data" key some derived exports use never appears. Real severity comes
from a *separate* source: the bulk, paginated ``https://ubuntu.com/security/
cves.json`` API. Verified live (2026-08-31) against real CVE ids
(CVE-2026-47892, CVE-2026-47893, CVE-2026-75803): each entry carries a
``priority`` field with exactly the bucket values this app already uses
("critical"/"high"/"medium"/"low"), plus a numeric ``cvss3`` score. The API
supports ``?package=<name>`` (bulk — one call returns every CVE tied to that
source package) and ``?q=<cve-id>`` (single-CVE lookup); comma-joined or
repeated ``q=`` params do NOT combine into a multi-id filter (tested).

That API is also demonstrably flaky from a single client: verified live that
after roughly 5-6 requests in quick succession — including some spaced 20s+
apart — *every* further request to ubuntu.com/security/* (a plain HEAD, the
per-CVE ``/security/cves/<id>.json`` URL the issue names) started timing out,
while usn.ubuntu.com stayed fast throughout. An unfiltered ``?limit=100`` and
a high-cardinality ``?package=openssl`` query also timed out solo. So this
module never calls that API synchronously in a request path, fetches only a
small, bounded batch of *packages* (not CVE ids — there can be 20k+ distinct
CVE ids in the feed but far fewer distinct packages) per cycle, uses a long
TTL plus a separate failure-backoff window, and always degrades to
"unknown" rather than raising. See ``fetch_severities_for_packages``.
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

USN_FEED_URL = "https://usn.ubuntu.com/usn-db/database.json"
CACHE_PATH = Path(os.environ.get("CVE_CACHE_PATH", "/data/cve_cache.json"))

UBUNTU_CVE_API_URL = "https://ubuntu.com/security/cves.json"
SEVERITY_CACHE_PATH = Path(os.environ.get("CVE_SEVERITY_CACHE_PATH", "/data/cve_severity_cache.json"))
_SEVERITY_FETCH_TIMEOUT = 12.0
# Severity buckets essentially never change after publication, and the live API is
# rate-limit-prone (see module docstring), so we refresh rarely and prefer a stale
# cache over hammering it.
_SEVERITY_TTL_SECONDS = 7 * 24 * 3600
_SEVERITY_FAILED_RETRY_SECONDS = 3600
_SEVERITY_MAX_PACKAGES_PER_CYCLE = 8
_SEVERITY_INTER_REQUEST_DELAY = 1.5


def _severity_from_cve_score(score: float | None) -> str:
    """Bucket a CVSS score into a severity label."""
    if score is None:
        return "unknown"
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "medium"
    return "low"


async def fetch_and_index() -> dict:
    """Download the USN feed and produce a {package: [usn_entry, ...]} index.

    Each entry: {"id", "url", "title", "cves", "severity", "fixed_version", "published"}.
    """
    logger.info("CVE: fetching USN feed from %s", USN_FEED_URL)
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        resp = await client.get(USN_FEED_URL)
        resp.raise_for_status()
        usn_db: dict[str, Any] = resp.json()

    index: dict[str, list[dict]] = {}
    # Release-aware fixed-version map (issue #62 remediation planner):
    # {usn_id: {release_codename: {src_pkg: fixed_version}}}. The flattened per-package
    # `index` above intentionally keeps only ONE (whichever release comes first in feed
    # order) fixed_version per package — fine as an informational annotation, but wrong
    # for the planner, which must pick the version that matches a *specific* server's
    # Ubuntu release. Built from the same already-downloaded feed (no second fetch).
    # Kept compact: verified against the full live feed (2026-08-31, 7805 entries) that
    # "binaries" is *always* null despite the schema allowing it, so there is nothing to
    # add there — only source-package version strings are kept. Real measured size of
    # this structure across the whole feed: ~4 MB.
    usn_releases: dict[str, dict[str, dict[str, str]]] = {}
    # Reverse index so the planner can go from a CVE id to its USN(s). Real measured size
    # across the whole feed: ~2 MB (24k+ distinct CVE ids).
    cve_to_usns: dict[str, list[str]] = {}
    for usn_id, entry in usn_db.items():
        cves = entry.get("cves") or []
        title = entry.get("title", "")
        # USN releases is { release: { sources: { src_pkg: { version, binaries: [...] } } } }
        releases = entry.get("releases") or {}

        for cid in cves:
            cve_to_usns.setdefault(cid, []).append(usn_id)

        rel_out: dict[str, dict[str, str]] = {}
        for release_name, rel_data in releases.items():
            srcs = {
                src_pkg: src_data.get("version")
                for src_pkg, src_data in ((rel_data or {}).get("sources") or {}).items()
                if src_data.get("version")
            }
            if srcs:
                rel_out[release_name] = srcs
        if rel_out:
            usn_releases[usn_id] = rel_out
        # Severity: the published USN feed (usn.ubuntu.com/usn-db/database.json) carries
        # only a flat list of CVE *ids* under "cves" — it has no per-CVE severity, so
        # there is nothing here to rank and every entry stays "unknown". The richer
        # "cves_data" shape below exists in newer/derived exports of this feed and is
        # read opportunistically, so severity starts working the moment a feed that
        # provides it is used. (Verified against the live feed 2026-08-31: 7788
        # entries, no "cves_data" key — so severity is currently always "unknown".)
        worst_severity = "unknown"
        for c in entry.get("cves_data") or []:
            sev = (c.get("severity") or "").lower()
            if sev in ("critical", "high", "medium", "low"):
                if (
                    sev == "critical"
                    or (sev == "high" and worst_severity not in ("critical",))
                    or (sev == "medium" and worst_severity not in ("critical", "high"))
                    or (sev == "low" and worst_severity == "unknown")
                ):
                    worst_severity = sev
        published = entry.get("isummary") or ""
        timestamp = entry.get("timestamp")
        try:
            published_dt = datetime.utcfromtimestamp(int(timestamp)).isoformat() if timestamp else ""
        except (ValueError, OSError, TypeError):
            published_dt = ""

        # Walk all packages mentioned in the USN
        seen_pkgs: set[str] = set()
        for _release, rel_data in releases.items():
            sources = (rel_data or {}).get("sources") or {}
            for src_pkg, src_data in sources.items():
                fixed_version = src_data.get("version", "")
                # Source package
                if src_pkg not in seen_pkgs:
                    index.setdefault(src_pkg, []).append({
                        "usn": usn_id,
                        "url": f"https://ubuntu.com/security/notices/USN-{usn_id}",
                        "title": title,
                        "cves": list(cves),
                        "severity": worst_severity,
                        "fixed_version": fixed_version,
                        "published": published_dt,
                    })
                    seen_pkgs.add(src_pkg)
                # Binary packages
                for bin_pkg in (src_data.get("binaries") or {}):
                    if bin_pkg in seen_pkgs:
                        continue
                    index.setdefault(bin_pkg, []).append({
                        "usn": usn_id,
                        "url": f"https://ubuntu.com/security/notices/USN-{usn_id}",
                        "title": title,
                        "cves": list(cves),
                        "severity": worst_severity,
                        "fixed_version": fixed_version,
                        "published": published_dt,
                    })
                    seen_pkgs.add(bin_pkg)

    # Keep only the 5 most recent USNs per package
    for pkg, entries in index.items():
        entries.sort(key=lambda e: e.get("published") or "", reverse=True)
        index[pkg] = entries[:5]

    payload = {
        "fetched_at": datetime.utcnow().isoformat() + "Z",
        "package_count": len(index),
        "index": index,
        "usn_releases": usn_releases,
        "cve_to_usns": cve_to_usns,
    }

    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE_PATH, "w") as f:
            json.dump(payload, f)
        logger.info("CVE: cached %d packages → %s", len(index), CACHE_PATH)
    except Exception as exc:
        logger.warning("CVE: could not write cache to %s: %s", CACHE_PATH, exc)

    return payload


_in_memory_cache: dict | None = None
_EMPTY_CACHE = {
    "fetched_at": None,
    "package_count": 0,
    "index": {},
    "usn_releases": {},
    "cve_to_usns": {},
}


def _load_cache() -> dict:
    global _in_memory_cache
    if _in_memory_cache is not None:
        return _in_memory_cache
    try:
        with open(CACHE_PATH) as f:
            loaded = json.load(f)
        # Backfill keys for a cache file written before issue #62 added them.
        _in_memory_cache = {**_EMPTY_CACHE, **loaded}
    except (FileNotFoundError, json.JSONDecodeError):
        _in_memory_cache = dict(_EMPTY_CACHE)
    return _in_memory_cache


def lookup(package_name: str) -> list[dict]:
    """Return the recent USNs matching *package_name*, or [] if none/cache empty."""
    return _load_cache().get("index", {}).get(package_name, [])


def usn_releases_for(usn_id: str) -> dict[str, dict[str, str]]:
    """Return {release_codename: {src_pkg: fixed_version}} for *usn_id* (issue #62).

    *usn_id* is the bare id as used as a dict key in the feed (e.g. "4147-1"), not
    prefixed with "USN-". Returns {} if the USN is unknown or carries no release data.
    """
    return _load_cache().get("usn_releases", {}).get(usn_id.removeprefix("USN-"), {})


def usns_for_cve(cve_id: str) -> list[str]:
    """Return the bare USN ids (e.g. ["4147-1"]) that reference *cve_id*, or []."""
    return _load_cache().get("cve_to_usns", {}).get(cve_id.upper(), [])


def cache_status() -> dict:
    c = _load_cache()
    return {
        "fetched_at": c.get("fetched_at"),
        "package_count": c.get("package_count", 0),
        "available": bool(c.get("index")),
    }


async def refresh_and_reload() -> dict:
    global _in_memory_cache
    payload = await fetch_and_index()
    _in_memory_cache = payload
    return payload


# ---------------------------------------------------------------------------
# Real severity (issue #62) — see the module docstring for the full rationale
# and the live-API findings that shaped this design.
# ---------------------------------------------------------------------------

_severity_cache: dict | None = None
_EMPTY_SEVERITY_CACHE = {"cves": {}, "packages_fetched_at": {}, "packages_failed_at": {}}


def _load_severity_cache() -> dict:
    global _severity_cache
    if _severity_cache is not None:
        return _severity_cache
    try:
        with open(SEVERITY_CACHE_PATH) as f:
            loaded = json.load(f)
        _severity_cache = {**_EMPTY_SEVERITY_CACHE, **loaded}
    except (FileNotFoundError, json.JSONDecodeError):
        _severity_cache = {k: dict(v) for k, v in _EMPTY_SEVERITY_CACHE.items()}
    return _severity_cache


def _save_severity_cache(cache: dict) -> None:
    global _severity_cache
    _severity_cache = cache
    try:
        SEVERITY_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(SEVERITY_CACHE_PATH, "w") as f:
            json.dump(cache, f)
    except Exception as exc:
        logger.warning("CVE severity: could not write cache to %s: %s", SEVERITY_CACHE_PATH, exc)


def severity_for_cve(cve_id: str) -> str:
    """Return the real cached severity for *cve_id*, or "unknown" if not yet fetched.

    Never makes a network call — always instant, safe to call per-row in a hot request
    path. Population happens out-of-band via ``fetch_severities_for_packages``.
    """
    entry = _load_severity_cache().get("cves", {}).get(cve_id.upper())
    if not entry:
        return "unknown"
    return entry.get("severity") or "unknown"


def severity_cache_status() -> dict:
    c = _load_severity_cache()
    return {
        "cve_count": len(c.get("cves", {})),
        "packages_fetched": len(c.get("packages_fetched_at", {})),
        "packages_pending_retry": len(c.get("packages_failed_at", {})),
    }


# Only one severity backfill may be in flight process-wide. Each call is already
# bounded, but the trigger is per-request: two open dashboards would start two
# backfills, select the same still-unknown packages, and duplicate every upstream
# call — provoking exactly the rate-limiting this module is built to avoid. A
# second concurrent caller returns immediately rather than queueing, since the
# work is best-effort and the next request will pick up whatever is still missing.
_severity_backfill_lock = asyncio.Lock()


async def fetch_severities_for_packages(
    package_names: list[str],
    *,
    max_packages: int = _SEVERITY_MAX_PACKAGES_PER_CYCLE,
) -> int:
    """Best-effort severity backfill for a bounded slice of *package_names*.

    Never raises — every failure (timeout, HTTP error, bad JSON) is logged and skipped,
    leaving those CVEs at "unknown" for this cycle and eligible for retry after
    ``_SEVERITY_FAILED_RETRY_SECONDS``. Intended to be called from a background task
    (FastAPI ``BackgroundTasks`` or the daily scheduler job below) — never awaited
    inline in a request handler, since the upstream API is measurably slow/flaky (see
    module docstring).

    Fetches by *source package name* (bulk — one call returns every CVE tied to that
    package), not by CVE id, because a fleet can reference thousands of distinct CVE
    ids but a far smaller number of distinct packages; per-CVE fetching at that volume
    is exactly what the issue calls out as unacceptable.

    Returns the number of CVE severity entries updated (0 if nothing needed fetching
    or every attempted fetch failed).
    """
    if _severity_backfill_lock.locked():
        logger.debug("CVE severity backfill already running — skipping this trigger")
        return 0
    async with _severity_backfill_lock:
        return await _fetch_severities_for_packages(package_names, max_packages=max_packages)


async def _fetch_severities_for_packages(
    package_names: list[str],
    *,
    max_packages: int = _SEVERITY_MAX_PACKAGES_PER_CYCLE,
) -> int:
    cache = _load_severity_cache()
    cves_out = cache.setdefault("cves", {})
    fetched_at = cache.setdefault("packages_fetched_at", {})
    failed_at = cache.setdefault("packages_failed_at", {})

    now = datetime.utcnow()

    def _age_seconds(iso: str | None) -> float:
        if not iso:
            return float("inf")
        try:
            return (now - datetime.fromisoformat(iso)).total_seconds()
        except ValueError:
            return float("inf")

    candidates = [
        pkg for pkg in dict.fromkeys(package_names)  # de-dup, keep order
        if _age_seconds(fetched_at.get(pkg)) >= _SEVERITY_TTL_SECONDS
        and _age_seconds(failed_at.get(pkg)) >= _SEVERITY_FAILED_RETRY_SECONDS
    ][:max_packages]

    if not candidates:
        return 0

    updated = 0
    async with httpx.AsyncClient(timeout=_SEVERITY_FETCH_TIMEOUT) as client:
        for i, pkg in enumerate(candidates):
            if i > 0:
                # Space requests out — the live API rate-limits/throttles a client
                # making several requests in quick succession (verified 2026-08-31:
                # after ~5-6 rapid requests, ALL further requests to
                # ubuntu.com/security/* started timing out, including ones spaced
                # 20s+ apart, while usn.ubuntu.com stayed fast throughout).
                await asyncio.sleep(_SEVERITY_INTER_REQUEST_DELAY)
            try:
                resp = await client.get(UBUNTU_CVE_API_URL, params={"package": pkg, "limit": 200})
                resp.raise_for_status()
                data = resp.json()
                for c in data.get("cves") or []:
                    cid = c.get("id")
                    if not cid:
                        continue
                    sev = (c.get("priority") or "").lower()
                    if sev not in ("critical", "high", "medium", "low"):
                        sev = "unknown"
                    cves_out[cid] = {
                        "severity": sev,
                        "cvss3": c.get("cvss3"),
                        "fetched_at": now.isoformat(),
                    }
                    updated += 1
                fetched_at[pkg] = now.isoformat()
                failed_at.pop(pkg, None)
            except Exception as exc:
                logger.debug("CVE severity: fetch skipped for package %r: %s", pkg, exc)
                failed_at[pkg] = now.isoformat()

    _save_severity_cache(cache)
    return updated


# Convenience for the scheduler
async def daily_refresh_job():
    try:
        payload = await refresh_and_reload()
    except Exception as exc:
        logger.error("CVE feed refresh failed: %s", exc)
        return

    # Best-effort, bounded severity backfill (issue #62). Passing the FULL package
    # list is intentional and cheap (dict lookups only) — fetch_severities_for_packages
    # internally skips anything already fresh or in failure-backoff and only ever
    # attempts up to `max_packages` per call, so this naturally makes incremental
    # progress through the whole package list across successive daily runs rather
    # than ever hammering the upstream API in one go.
    try:
        await fetch_severities_for_packages(sorted(payload.get("index", {}).keys()))
    except Exception as exc:
        logger.debug("CVE severity backfill skipped: %s", exc)
