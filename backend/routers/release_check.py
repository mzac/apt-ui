"""
GitHub release check (issue #13).

Polls the GitHub releases API for the latest release tag and compares it
against the running APP_VERSION. Cached in-memory for 6 hours so we don't
hit GitHub on every page load.
"""

import asyncio
import logging
import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends

from backend.auth import get_current_user
from backend.config import APP_VERSION
from backend.models import User

router = APIRouter(prefix="/api/release-check", tags=["release-check"])
logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com/repos/mzac/apt-ui/releases/latest"
CACHE_TTL_SECONDS = 6 * 3600  # 6 hours

# Cache shape: (timestamp, payload)
_cache: tuple[float, dict[str, Any]] | None = None
_cache_lock = asyncio.Lock()


def _parse_version(v: str) -> tuple[int, ...]:
    """Coerce 'YYYY.MM.DD-NN' or 'vN.N.N' into a comparable tuple. dev/empty → ()."""
    if not v or v == "dev":
        return ()
    parts = re.findall(r"\d+", v)
    return tuple(int(p) for p in parts)


def _is_newer(latest: str, current: str) -> bool:
    """Is *latest* newer than *current*?  Returns False when current is 'dev'."""
    if not current or current == "dev":
        return False
    return _parse_version(latest) > _parse_version(current)


@router.get("")
async def check_for_updates(_: User = Depends(get_current_user)):
    """Return the latest GitHub release info and whether an update is available."""
    global _cache
    now = time.time()
    async with _cache_lock:
        if _cache and (now - _cache[0]) < CACHE_TTL_SECONDS:
            return _cache[1]

        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                resp = await client.get(GITHUB_API, headers={"Accept": "application/vnd.github+json"})
            if resp.status_code != 200:
                payload = {
                    "current": APP_VERSION,
                    "latest": None,
                    "update_available": False,
                    "error": f"GitHub API returned {resp.status_code}",
                }
            else:
                data = resp.json()
                latest_tag = data.get("tag_name") or data.get("name") or ""
                published = data.get("published_at")
                payload = {
                    "current": APP_VERSION,
                    "latest": latest_tag,
                    "url": data.get("html_url"),
                    "published_at": published,
                    "update_available": _is_newer(latest_tag, APP_VERSION),
                    "error": None,
                }
        except Exception as exc:
            logger.warning("Release check failed: %s", exc)
            payload = {
                "current": APP_VERSION,
                "latest": None,
                "update_available": False,
                "error": str(exc),
            }

        _cache = (now, payload)
        return payload
