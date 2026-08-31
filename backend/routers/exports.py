"""Server-side filtered exports (issue #62) — CSV / Markdown, streamed.

Today the only exports in the app (Reports, Security) are built client-side
from whatever page of data happens to already be on screen, so an export
silently misses everything past page 1. These endpoints fix that for Upgrade
History and the SSH audit log: they accept the same filters the corresponding
list endpoint accepts, run the query server-side, and stream the *full*
filtered result set back via ``StreamingResponse`` — nothing is materialized
in memory, which matters because a fleet's SSH audit log can get very large.

Filter/gating provenance (read carefully — this reuses, but does not import,
the two list endpoints, because neither one exposes its filter-building as a
separate callable):

* Upgrade History mirrors ``global_history()`` in ``backend/routers/stats.py``
  (``/api/history``) — filters: ``server_id``, ``status``. That endpoint is
  gated with ``get_current_user`` only (no admin requirement), so the export
  below uses the same gate.
* SSH audit log mirrors ``get_audit_log()`` in ``backend/routers/servers.py``
  (``/api/servers/audit-log``) — filter: ``server_id``. That endpoint is *also*
  gated with ``get_current_user`` only. Note this contradicts an assumption
  made when this feature was scoped (that the SSH audit log, like the
  ``/api/auth/events`` auth-event log, is admin-only) — it verifiably is not,
  today. This module matches the real gate on the endpoint it mirrors rather
  than the assumption; if admin-only is actually wanted here, that's a
  one-line gate change plus (separately) tightening ``get_audit_log`` itself
  for consistency.

Both endpoints additionally accept ``start_date`` / ``end_date`` (ISO 8601)
for a date-range filter that neither source endpoint currently offers — a
reasonable, additive extension for an export, not a behavior change to the
endpoints being mirrored.

Pagination for the stream itself uses keyset pagination on the primary key
(ascending), not the ``OFFSET``/``LIMIT`` the list endpoints use for on-screen
paging — ``OFFSET`` re-scans and discards every prior row on each page, which
is fine for a handful of UI pages but becomes O(n^2) against a table the size
a full fleet export can reach.
"""

import csv
import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, SshAuditLog, UpdateHistory, User
from backend.timeutil import utc_iso

router = APIRouter(prefix="/api/exports", tags=["exports"])

CHUNK_SIZE = 500  # rows fetched per DB round-trip while streaming


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _parse_date(value: str | None, field_name: str) -> datetime | None:
    """Parse an ISO 8601 date/datetime query param into a naive UTC datetime
    (matching the DB's naive-UTC storage convention — see backend/timeutil.py)."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {field_name}: expected ISO 8601 date or datetime")
    if dt.tzinfo is not None:
        # Normalize to naive UTC to compare against the DB's naive-UTC columns.
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


async def _iter_rows_keyset(db: AsyncSession, base_stmt: Select, id_column) -> AsyncIterator:
    """Stream ORM rows from *base_stmt*, keyset-paginated ascending by *id_column*.

    Monotonic and safe against concurrent inserts during a long export (a new
    row landing mid-stream always sorts after ``last_id`` and is simply picked
    up — or not — by whichever page it would naturally fall in; nothing already
    yielded is skipped or duplicated).
    """
    last_id = 0
    while True:
        page_stmt = base_stmt.where(id_column > last_id).order_by(id_column.asc()).limit(CHUNK_SIZE)
        rows = (await db.execute(page_stmt)).scalars().all()
        if not rows:
            return
        for r in rows:
            yield r
        last_id = rows[-1].id
        if len(rows) < CHUNK_SIZE:
            return


class _Echo:
    """File-like shim so csv.writer hands us each formatted row as a string
    instead of writing to a real buffer — the standard streaming-CSV recipe."""

    def write(self, value: str) -> str:
        return value


def _filename(prefix: str, ext: str, **filters) -> str:
    """Content-Disposition filename that encodes the active filter values."""
    bits = [prefix]
    for k, v in filters.items():
        if v not in (None, ""):
            bits.append(f"{k}-{v}")
    bits.append(datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"))
    return "-".join(bits) + f".{ext}"


def _attachment_headers(filename: str) -> dict:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


# ---------------------------------------------------------------------------
# Upgrade History export
# ---------------------------------------------------------------------------

def _upgrade_history_stmt(
    server_id: int | None, status: str | None, start: datetime | None, end: datetime | None
) -> Select:
    """Duplicates the filter set of stats.py `global_history()` (server_id,
    status) plus an additive start/end date range — see module docstring."""
    stmt = select(UpdateHistory)
    if server_id is not None:
        stmt = stmt.where(UpdateHistory.server_id == server_id)
    if status is not None:
        stmt = stmt.where(UpdateHistory.status == status)
    if start is not None:
        stmt = stmt.where(UpdateHistory.started_at >= start)
    if end is not None:
        stmt = stmt.where(UpdateHistory.started_at <= end)
    return stmt


def _history_pkg_count(h: UpdateHistory) -> int:
    if not h.packages_upgraded:
        return 0
    try:
        parsed = json.loads(h.packages_upgraded)
        return len(parsed) if isinstance(parsed, list) else 0
    except Exception:
        return 0


async def _history_csv_stream(db: AsyncSession, stmt: Select, srv_map: dict[int, str]) -> AsyncIterator[str]:
    writer = csv.writer(_Echo())
    yield writer.writerow([
        "id", "started_at", "completed_at", "server_id", "server_name",
        "status", "action", "phased_updates", "packages_upgraded_count",
        "initiated_by", "snapshot_name",
    ])
    async for h in _iter_rows_keyset(db, stmt, UpdateHistory.id):
        yield writer.writerow([
            h.id,
            utc_iso(h.started_at) or "",
            utc_iso(h.completed_at) or "",
            h.server_id,
            srv_map.get(h.server_id, f"#{h.server_id}"),
            h.status,
            h.action,
            h.phased_updates,
            _history_pkg_count(h),
            h.initiated_by or "",
            h.snapshot_name or "",
        ])


def _md_escape(value: str) -> str:
    """Keep a value from breaking a Markdown table row (no pipes, no newlines)."""
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", "")


async def _history_md_stream(
    db: AsyncSession, stmt: Select, srv_map: dict[int, str], filters_desc: str
) -> AsyncIterator[str]:
    yield "# Upgrade History Export\n\n"
    yield f"Filters: {filters_desc}\n\n"
    yield f"Generated: {utc_iso(datetime.utcnow())}\n\n"
    yield "| ID | Started | Completed | Server | Status | Action | Packages | Initiated By | Snapshot |\n"
    yield "|---|---|---|---|---|---|---|---|---|\n"
    async for h in _iter_rows_keyset(db, stmt, UpdateHistory.id):
        yield (
            f"| {h.id} | {utc_iso(h.started_at) or ''} | {utc_iso(h.completed_at) or ''} | "
            f"{_md_escape(srv_map.get(h.server_id, f'#{h.server_id}'))} | {_md_escape(h.status)} | "
            f"{_md_escape(h.action)} | {_history_pkg_count(h)} | "
            f"{_md_escape(h.initiated_by or '')} | {_md_escape(h.snapshot_name or '')} |\n"
        )


@router.get("/upgrade-history")
async def export_upgrade_history(
    fmt: str = Query(default="csv", pattern="^(csv|md)$"),
    server_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    start_date: str | None = Query(default=None, description="ISO 8601 lower bound on started_at"),
    end_date: str | None = Query(default=None, description="ISO 8601 upper bound on started_at"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Stream the *full* filtered Upgrade History as CSV or Markdown.

    Same gate and filters (server_id, status) as GET /api/history, plus an
    additive start_date/end_date range. Streams via keyset pagination rather
    than materializing the result set — see module docstring.
    """
    start = _parse_date(start_date, "start_date")
    end = _parse_date(end_date, "end_date")
    stmt = _upgrade_history_stmt(server_id, status, start, end)

    srv_map = {s.id: s.name for s in (await db.execute(select(Server))).scalars().all()}

    filename_bits = {"server": server_id, "status": status, "from": start_date, "to": end_date}
    filters_desc = ", ".join(f"{k}={v}" for k, v in filename_bits.items() if v not in (None, "")) or "none"

    if fmt == "csv":
        filename = _filename("upgrade-history", "csv", **filename_bits)
        return StreamingResponse(
            _history_csv_stream(db, stmt, srv_map),
            media_type="text/csv",
            headers=_attachment_headers(filename),
        )

    filename = _filename("upgrade-history", "md", **filename_bits)
    return StreamingResponse(
        _history_md_stream(db, stmt, srv_map, filters_desc),
        media_type="text/markdown",
        headers=_attachment_headers(filename),
    )


# ---------------------------------------------------------------------------
# SSH audit log export
# ---------------------------------------------------------------------------

def _audit_log_stmt(server_id: int | None, start: datetime | None, end: datetime | None) -> Select:
    """Duplicates the filter set of servers.py `get_audit_log()` (server_id)
    plus an additive start/end date range — see module docstring."""
    stmt = select(SshAuditLog)
    if server_id is not None:
        stmt = stmt.where(SshAuditLog.server_id == server_id)
    if start is not None:
        stmt = stmt.where(SshAuditLog.started_at >= start)
    if end is not None:
        stmt = stmt.where(SshAuditLog.started_at <= end)
    return stmt


async def _audit_csv_stream(db: AsyncSession, stmt: Select, srv_map: dict[int, str]) -> AsyncIterator[str]:
    writer = csv.writer(_Echo())
    yield writer.writerow([
        "id", "started_at", "server_id", "server_name", "duration_ms",
        "initiated_by", "command", "exit_code", "output_excerpt",
    ])
    async for r in _iter_rows_keyset(db, stmt, SshAuditLog.id):
        yield writer.writerow([
            r.id,
            utc_iso(r.started_at) or "",
            r.server_id,
            srv_map.get(r.server_id, f"#{r.server_id}"),
            r.duration_ms if r.duration_ms is not None else "",
            r.initiated_by,
            r.command,
            r.exit_code if r.exit_code is not None else "",
            r.output_excerpt or "",
        ])


async def _audit_md_stream(
    db: AsyncSession, stmt: Select, srv_map: dict[int, str], filters_desc: str
) -> AsyncIterator[str]:
    yield "# SSH Audit Log Export\n\n"
    yield f"Filters: {filters_desc}\n\n"
    yield f"Generated: {utc_iso(datetime.utcnow())}\n\n"
    yield "| ID | Started | Server | Duration (ms) | Initiated By | Command | Exit Code | Output |\n"
    yield "|---|---|---|---|---|---|---|---|\n"
    async for r in _iter_rows_keyset(db, stmt, SshAuditLog.id):
        output = (r.output_excerpt or "")[:300]  # keep table rows sane; full text is in the CSV export
        yield (
            f"| {r.id} | {utc_iso(r.started_at) or ''} | {_md_escape(srv_map.get(r.server_id, f'#{r.server_id}'))} | "
            f"{r.duration_ms if r.duration_ms is not None else ''} | {_md_escape(r.initiated_by)} | "
            f"{_md_escape(r.command)} | {r.exit_code if r.exit_code is not None else ''} | "
            f"{_md_escape(output)} |\n"
        )


@router.get("/ssh-audit-log")
async def export_ssh_audit_log(
    fmt: str = Query(default="csv", pattern="^(csv|md)$"),
    server_id: int | None = Query(default=None),
    start_date: str | None = Query(default=None, description="ISO 8601 lower bound on started_at"),
    end_date: str | None = Query(default=None, description="ISO 8601 upper bound on started_at"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Stream the *full* filtered SSH audit log as CSV or Markdown.

    Same gate and filter (server_id) as GET /api/servers/audit-log, plus an
    additive start_date/end_date range. This endpoint exposes audit data —
    see the module docstring for why it is gated with get_current_user
    (matching the list endpoint it mirrors) rather than admin-only.
    """
    start = _parse_date(start_date, "start_date")
    end = _parse_date(end_date, "end_date")
    stmt = _audit_log_stmt(server_id, start, end)

    srv_map = {s.id: s.name for s in (await db.execute(select(Server))).scalars().all()}

    filename_bits = {"server": server_id, "from": start_date, "to": end_date}
    filters_desc = ", ".join(f"{k}={v}" for k, v in filename_bits.items() if v not in (None, "")) or "none"

    if fmt == "csv":
        filename = _filename("ssh-audit-log", "csv", **filename_bits)
        return StreamingResponse(
            _audit_csv_stream(db, stmt, srv_map),
            media_type="text/csv",
            headers=_attachment_headers(filename),
        )

    filename = _filename("ssh-audit-log", "md", **filename_bits)
    return StreamingResponse(
        _audit_md_stream(db, stmt, srv_map, filters_desc),
        media_type="text/markdown",
        headers=_attachment_headers(filename),
    )
