"""Timestamp serialization helpers.

The database stores naive UTC datetimes (``func.now()`` under SQLite is
``CURRENT_TIMESTAMP``, which is UTC, and the checker code uses
``datetime.utcnow()``). Serializing those with a bare ``.isoformat()``
produces an offset-less string like ``2026-08-31T14:00:00``, which every
JavaScript client parses as *local* time — shifting every displayed
timestamp by the viewer's UTC offset.

Always run outbound timestamps through :func:`utc_iso` so naive values are
explicitly stamped ``Z``. Timezone-aware values (e.g. APScheduler's next-run
times, or anything from ``config.now_local()``) keep their real offset.

Note: timestamps parsed out of a *remote host's* logs (``/var/log/dpkg.log``)
are that host's local wall clock, not UTC — do not pass those through here.
"""

from datetime import datetime, timezone
from typing import Optional


def utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """ISO-8601 string that always carries an explicit timezone.

    Naive datetimes are treated as UTC (the storage convention) and get a
    ``Z`` suffix; aware datetimes keep their own offset.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
