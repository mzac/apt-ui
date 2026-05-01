"""
iCal feed for maintenance windows (issue #59).

Exposes ``GET /api/calendar.ics?token=<api_token>`` returning an RFC 5545
``text/calendar`` document. One ``VEVENT`` is emitted per enabled maintenance
window, using a weekly ``RRULE`` derived from the ``days_of_week`` bitmask.

Auth: a normal API token (issue #38) passed via the ``token`` query parameter.
Calendar clients (Apple Calendar, Google Calendar, Thunderbird) cannot send
custom ``Authorization: Bearer`` headers when subscribing to a feed, so the
token-in-URL pattern is the standard approach. The token is hashed with the
same scrypt parameters as ``backend/auth.py:hash_api_token`` and looked up in
the ``api_tokens`` table.

Times are emitted as **floating** local times (no ``TZID``, no ``Z`` suffix),
which RFC 5545 defines as "the time the user has", i.e. each calendar client
displays the event at the same wall-clock time in its own timezone. This
matches how operators typically think about maintenance windows ("9 AM
weekdays") and avoids shipping a hand-rolled VTIMEZONE block.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import select

from backend.auth import API_TOKEN_PREFIX, hash_api_token
from backend.config import APP_VERSION
from backend.database import AsyncSessionLocal
from backend.models import ApiToken, MaintenanceWindow, Server, User

router = APIRouter(tags=["calendar"])


# Python weekday(): Monday=0 ... Sunday=6 — matches our days_of_week bitmask.
_BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def _ical_escape(text: str) -> str:
    """Escape characters per RFC 5545 §3.3.11."""
    return (
        text.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _fold(line: str) -> str:
    """Fold a content line at 75 octets per RFC 5545 §3.1 (CRLF + space).

    Naive byte-count (good enough for ASCII-only output we generate).
    """
    if len(line) <= 75:
        return line
    pieces = []
    while len(line) > 75:
        pieces.append(line[:75])
        line = " " + line[75:]
    pieces.append(line)
    return "\r\n".join(pieces)


def _fmt_local(dt: datetime) -> str:
    """Format a naive datetime as a floating local time per RFC 5545."""
    return dt.strftime("%Y%m%dT%H%M%S")


def _fmt_utc(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _last_monday_on_or_before(d: date) -> date:
    """Reference start date: the most recent Monday on/before *d*."""
    return d - timedelta(days=d.weekday())


def _build_event(window: MaintenanceWindow, server_name: str | None, ref_monday: date,
                 dtstamp: datetime) -> list[str]:
    """Build the VEVENT lines for a single maintenance window."""
    # Pick the first set day of the week as the anchor for DTSTART.
    days_of_week = window.days_of_week & 0x7F
    if not days_of_week:
        return []
    first_day = 0
    while first_day < 7 and not (days_of_week & (1 << first_day)):
        first_day += 1
    anchor = ref_monday + timedelta(days=first_day)

    start_h, start_m = divmod(window.start_minutes, 60)
    end_h, end_m = divmod(window.end_minutes, 60)
    dtstart = datetime(anchor.year, anchor.month, anchor.day, start_h, start_m)
    if window.end_minutes > window.start_minutes:
        dtend = datetime(anchor.year, anchor.month, anchor.day, end_h, end_m)
    else:
        # Wraps midnight — DTEND is on the next day.
        next_day = anchor + timedelta(days=1)
        dtend = datetime(next_day.year, next_day.month, next_day.day, end_h, end_m)

    byday = ",".join(_BYDAY[i] for i in range(7) if days_of_week & (1 << i))

    if server_name is not None:
        scope_label = server_name
    else:
        scope_label = "fleet"
    summary = f"apt-ui — maintenance ({scope_label})"

    description_lines = [
        f"Maintenance window: {window.name}",
        f"Scope: {scope_label}",
    ]
    description = "\\n".join(_ical_escape(line) for line in description_lines)

    lines = [
        "BEGIN:VEVENT",
        f"UID:maintenance-{window.id}@apt-ui",
        f"DTSTAMP:{_fmt_utc(dtstamp)}",
        f"DTSTART:{_fmt_local(dtstart)}",
        f"DTEND:{_fmt_local(dtend)}",
        f"RRULE:FREQ=WEEKLY;BYDAY={byday}",
        f"SUMMARY:{_ical_escape(summary)}",
        f"DESCRIPTION:{description}",
        "TRANSP:OPAQUE",
        "END:VEVENT",
    ]
    return lines


async def _resolve_user_from_token(raw_token: str) -> User:
    """Validate *raw_token* and return the owning User, or raise 401."""
    if not raw_token or not raw_token.startswith(API_TOKEN_PREFIX):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    token_hash = hash_api_token(raw_token)
    async with AsyncSessionLocal() as session:
        tok_res = await session.execute(
            select(ApiToken).where(ApiToken.token_hash == token_hash)
        )
        tok = tok_res.scalar_one_or_none()
        if tok is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        if tok.expires_at and tok.expires_at < datetime.utcnow():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
        user_res = await session.execute(select(User).where(User.id == tok.user_id))
        user = user_res.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token owner not found")
        # Best-effort last_used_at update
        tok.last_used_at = datetime.utcnow()
        await session.commit()
        return user


@router.get("/api/calendar.ics", include_in_schema=False)
async def maintenance_calendar(token: str = Query(..., description="API token (issue #38)")):
    """Return all enabled maintenance windows as an iCalendar (RFC 5545) feed."""
    await _resolve_user_from_token(token)

    async with AsyncSessionLocal() as session:
        win_res = await session.execute(
            select(MaintenanceWindow).where(MaintenanceWindow.enabled == True)
            .order_by(MaintenanceWindow.id)
        )
        windows = list(win_res.scalars().all())

        # Pre-fetch server names for per-server windows in a single query.
        server_ids = {w.server_id for w in windows if w.server_id is not None}
        server_names: dict[int, str] = {}
        if server_ids:
            srv_res = await session.execute(select(Server).where(Server.id.in_(server_ids)))
            for s in srv_res.scalars().all():
                server_names[s.id] = s.name

    ref_monday = _last_monday_on_or_before(date.today())
    dtstamp = datetime.utcnow()

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:-//apt-ui//maintenance//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:apt-ui Maintenance Windows",
        f"X-WR-CALDESC:Scheduled maintenance windows from apt-ui {APP_VERSION}",
    ]

    for w in windows:
        server_name = server_names.get(w.server_id) if w.server_id is not None else None
        lines.extend(_build_event(w, server_name, ref_monday, dtstamp))

    lines.append("END:VCALENDAR")

    body = "\r\n".join(_fold(line) for line in lines) + "\r\n"
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'inline; filename="apt-ui-maintenance.ics"',
            "Cache-Control": "private, max-age=300",
        },
    )
