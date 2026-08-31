"""
Maintenance windows (issue #40).

CRUD endpoints + a helper to test whether a server is currently inside a
deny window. Auto-upgrade and (optionally) Upgrade All consult this helper
to skip / warn about servers that should not be touched right now.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.config import now_local as _now_local
from backend.database import get_db
from backend.models import MaintenanceWindow, Server, User
from backend.timeutil import utc_iso

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


def is_in_window(window: MaintenanceWindow, now: datetime | None = None) -> bool:
    """Test whether *now* falls inside the configured window."""
    if not window.enabled:
        return False
    n = now or _now_local()
    minute_of_day = n.hour * 60 + n.minute
    # Python: Monday=0 ... Sunday=6
    if not (window.days_of_week & (1 << n.weekday())):
        return False
    if window.start_minutes <= window.end_minutes:
        return window.start_minutes <= minute_of_day < window.end_minutes
    # Wraps midnight (e.g. 22:00 → 06:00)
    return minute_of_day >= window.start_minutes or minute_of_day < window.end_minutes


def _mode(w: MaintenanceWindow) -> str:
    """Window mode, tolerating rows written before the column existed."""
    return (getattr(w, "mode", None) or "deny").lower()


async def _windows_for_server(db: AsyncSession, server_id: int) -> list[MaintenanceWindow]:
    """Every enabled window applying to *server_id*: its own **and** the global
    (``server_id IS NULL``) ones.

    They MERGE — a per-server window does not exempt a host from a fleet-wide
    window. Making per-server windows replace the global set would mean adding
    any per-server schedule silently cancels a fleet-wide emergency freeze for
    that host, which is the opposite of what a freeze is for.
    """
    res = await db.execute(
        select(MaintenanceWindow).where(MaintenanceWindow.enabled == True)
    )
    return [w for w in res.scalars().all() if w.server_id in (None, server_id)]


def is_blocked_at(windows: list[MaintenanceWindow], when: datetime) -> str | None:
    """Reason *when* is blocked by *windows*, or None if the action may proceed.

    THE single definition of what a window means, so callers can never drift:
      * a deny window blocks while it is open, and always wins; and
      * if any allow window applies, the action is permitted *only* while one of
        them is open.

    Pure and synchronous so a forward scan (see
    ``backend.rollout.compute_next_window_opening``) can call it per candidate
    minute without re-querying.
    """
    allow: list[MaintenanceWindow] = []
    for w in windows:
        if _mode(w) == "deny":
            if is_in_window(w, when):
                return f"blocked by maintenance window '{w.name}'"
        else:
            allow.append(w)
    if allow and not any(is_in_window(w, when) for w in allow):
        names = ", ".join(sorted(w.name for w in allow))
        return f"outside the permitted maintenance window(s): {names}"
    return None


async def get_active_window_for_server(db: AsyncSession, server_id: int) -> MaintenanceWindow | None:
    """Return the first active *deny* window for *server_id*, or None.

    Per-server windows take priority; falls back to global windows. Allow-mode
    windows are handled separately in :func:`window_block_reason` — they do not
    block by being active, they block by *not* being active.
    """
    now = _now_local()
    for w in await _windows_for_server(db, server_id):
        if _mode(w) == "deny" and is_in_window(w, now):
            return w
    return None


async def window_block_reason(db: AsyncSession, server_id: int, override: bool = False) -> str | None:
    """Return a human-readable reason if a mutating action on *server_id* is currently
    blocked by an active maintenance (deny) window, or None if allowed. `override=True`
    (admin) bypasses the gate."""
    if override:
        return None

    return is_blocked_at(await _windows_for_server(db, server_id), _now_local())


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _serialize(w: MaintenanceWindow) -> dict:
    return {
        "id": w.id,
        "server_id": w.server_id,
        "name": w.name,
        "start_minutes": w.start_minutes,
        "end_minutes": w.end_minutes,
        "days_of_week": w.days_of_week,
        "enabled": w.enabled,
        "mode": _mode(w),
        "created_at": utc_iso(w.created_at),
    }


@router.get("")
async def list_windows(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    res = await db.execute(select(MaintenanceWindow).order_by(MaintenanceWindow.id))
    return [_serialize(w) for w in res.scalars().all()]


@router.post("", status_code=201)
async def create_window(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    try:
        start = int(body.get("start_minutes", 0))
        end = int(body.get("end_minutes", 0))
        days = int(body.get("days_of_week", 127))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid time/days")
    if not (0 <= start < 1440) or not (0 <= end < 1440):
        raise HTTPException(status_code=400, detail="Times must be 0..1439 (minutes since midnight)")
    if not (0 < days < 128):
        raise HTTPException(status_code=400, detail="days_of_week must be 1..127")

    mode = (body.get("mode") or "deny").strip().lower()
    if mode not in ("deny", "allow"):
        raise HTTPException(status_code=400, detail="mode must be 'deny' or 'allow'")

    sid = body.get("server_id")
    if sid is not None:
        srv = (await db.execute(select(Server).where(Server.id == sid))).scalar_one_or_none()
        if srv is None:
            raise HTTPException(status_code=404, detail="Server not found")

    w = MaintenanceWindow(
        server_id=sid,
        name=name,
        start_minutes=start,
        end_minutes=end,
        days_of_week=days,
        enabled=bool(body.get("enabled", True)),
        mode=mode,
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.put("/{window_id}")
async def update_window(
    window_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = res.scalar_one_or_none()
    if w is None:
        raise HTTPException(status_code=404, detail="Not found")
    if "name" in body:
        w.name = (body["name"] or "").strip() or w.name
    if "start_minutes" in body:
        w.start_minutes = max(0, min(1439, int(body["start_minutes"])))
    if "end_minutes" in body:
        w.end_minutes = max(0, min(1439, int(body["end_minutes"])))
    if "days_of_week" in body:
        d = int(body["days_of_week"])
        if 0 < d < 128:
            w.days_of_week = d
    if "enabled" in body:
        w.enabled = bool(body["enabled"])
    if "mode" in body:
        m = (body["mode"] or "deny").strip().lower()
        if m not in ("deny", "allow"):
            raise HTTPException(status_code=400, detail="mode must be 'deny' or 'allow'")
        w.mode = m
    if "server_id" in body:
        w.server_id = body["server_id"]
    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.delete("/{window_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_window(
    window_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    res = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = res.scalar_one_or_none()
    if w is None:
        raise HTTPException(status_code=404, detail="Not found")
    await db.delete(w)
    await db.commit()


@router.get("/active")
async def list_active(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return the set of server IDs currently inside a deny window.

    Used by the dashboard to badge servers that should not be upgraded right now.
    """
    res = await db.execute(select(Server))
    servers = res.scalars().all()
    blocked: dict[int, dict] = {}
    for s in servers:
        # Report what actually blocks, so allow-only windows (which block by NOT
        # being open) show up here too rather than reading as "not blocked".
        reason = is_blocked_at(await _windows_for_server(db, s.id), _now_local())
        if reason:
            w = await get_active_window_for_server(db, s.id)
            blocked[s.id] = {
                "window_id": w.id if w else None,
                "name": w.name if w else None,
                "reason": reason,
            }
    return {"blocked": blocked, "checked_at": _now_local().isoformat()}
