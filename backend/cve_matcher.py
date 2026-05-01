"""
CVE matcher (issue #37).

Daily job fetches Ubuntu's USN (Security Notice) database and caches it as a
small lookup table {package_name: [{usn, cves, severity, summary, fixed_version}]}.

Notes:
- Ubuntu USN covers most Debian packages too (same source), so we use a single
  feed for both Ubuntu and Debian-derived servers.
- The feed at usn-db/database.json is ~10-20 MB; we cache the post-processed
  index in /data/cve_cache.json to keep lookups fast.
- We do NOT do exact version comparison (Debian version semantics are tricky);
  we surface the most recent USN per package so the user can decide if their
  version is below the fix. The UI links to the USN URL for details.
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
    for usn_id, entry in usn_db.items():
        cves = entry.get("cves") or []
        title = entry.get("title", "")
        # USN releases is { release: { sources: { src_pkg: { version, binaries: [...] } } } }
        releases = entry.get("releases") or {}
        # Highest-severity CVE wins
        worst_severity = "unknown"
        for cve_summary in entry.get("description") or []:
            pass
        # Pull severity from cves field if present (newer USN format)
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


def _load_cache() -> dict:
    global _in_memory_cache
    if _in_memory_cache is not None:
        return _in_memory_cache
    try:
        with open(CACHE_PATH) as f:
            _in_memory_cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _in_memory_cache = {"fetched_at": None, "package_count": 0, "index": {}}
    return _in_memory_cache


def lookup(package_name: str) -> list[dict]:
    """Return the recent USNs matching *package_name*, or [] if none/cache empty."""
    return _load_cache().get("index", {}).get(package_name, [])


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


# Convenience for the scheduler
async def daily_refresh_job():
    try:
        await refresh_and_reload()
    except Exception as exc:
        logger.error("CVE feed refresh failed: %s", exc)
