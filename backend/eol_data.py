"""OS end-of-life data and helpers (issue #57).

Provides a hardcoded EOL date table for the Linux distros apt-ui supports
plus parsers that turn the free-form ``Server.os_info`` string into the
``(os_id, version_id)`` tuple used to look up an EOL date.

EOL dates here track each distribution's standard / LTS support window —
the point at which the project stops shipping security updates. A few notes:

- Ubuntu LTS is covered for 5 years; ESM (Ubuntu Pro) extends each LTS to
  10 years. We surface the standard EOL but flag ESM availability.
- Debian standard support runs ~3 years; LTS adds two more, but is community
  driven and out of scope here.
- Raspberry Pi OS / Raspbian tracks the upstream Debian release cycle.
- Proxmox VE matches its underlying Debian base — 7.x → Debian 11, 8.x → Debian 12.

The table is intentionally simple (no LTS/ESM split) — when a date has passed
or is approaching, the dashboard surfaces a badge. Periodic updates to this
file are expected as releases age out.
"""

from __future__ import annotations

import re
from datetime import date


# ---------------------------------------------------------------------------
# EOL table  —  {os_id: {version_id: ISO date string}}
# ---------------------------------------------------------------------------

EOL_DATES: dict[str, dict[str, str]] = {
    "ubuntu": {
        "20.04": "2025-05-31",  # Focal Fossa
        "22.04": "2027-04-30",  # Jammy Jellyfish
        "24.04": "2029-04-30",  # Noble Numbat
    },
    "debian": {
        "11": "2026-08-31",  # Bullseye (LTS)
        "12": "2028-06-30",  # Bookworm (LTS)
    },
    "raspbian": {
        "11": "2026-08-31",
        "12": "2028-06-30",
    },
    "proxmox": {
        "7": "2024-07-31",
        "8": "2026-07-31",
    },
}

# Distros that have an extended-security-maintenance program available
# (paid Ubuntu Pro for Ubuntu, community LTS for Debian — we only flag Ubuntu
# here since Debian LTS is out of scope).
_ESM_DISTROS = {"ubuntu"}


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

# Matches "Ubuntu 22.04.5 LTS", "Ubuntu 24.04 LTS"
_UBUNTU_RE = re.compile(r"\bubuntu\b\s+(\d+\.\d+)", re.IGNORECASE)
# Matches "Debian GNU/Linux 12 (bookworm)" or "Debian 11"
_DEBIAN_RE = re.compile(r"\bdebian\b[^\d]*(\d+)", re.IGNORECASE)
# Matches "Raspbian GNU/Linux 11 (bullseye)" / "Raspberry Pi OS 12 ..."
_RASPBIAN_RE = re.compile(r"\b(?:raspbian|raspberry\s*pi\s*os)\b[^\d]*(\d+)", re.IGNORECASE)
# Matches "Proxmox VE 8.0", "Proxmox VE 7.4-1", "Proxmox VE (6.5-pve...)"
_PROXMOX_RE = re.compile(r"\bproxmox\b[^\d]*(\d+)", re.IGNORECASE)


def parse_os_info(os_info: str | None) -> tuple[str | None, str | None]:
    """Parse the free-form ``Server.os_info`` string into ``(os_id, version_id)``.

    Returns ``(None, None)`` for unrecognized strings.

    Examples
    --------
    >>> parse_os_info("Ubuntu 22.04.5 LTS")
    ('ubuntu', '22.04')
    >>> parse_os_info("Debian GNU/Linux 12 (bookworm)")
    ('debian', '12')
    >>> parse_os_info("Proxmox VE 8.0")
    ('proxmox', '8')
    """
    if not os_info:
        return None, None
    raw = os_info.strip()

    # Order matters: Proxmox and Raspbian must be matched before the generic
    # "debian" branch (they typically also contain "Debian" in their banners).
    m = _PROXMOX_RE.search(raw)
    if m:
        return "proxmox", m.group(1)

    m = _RASPBIAN_RE.search(raw)
    if m:
        return "raspbian", m.group(1)

    m = _UBUNTU_RE.search(raw)
    if m:
        return "ubuntu", m.group(1)

    m = _DEBIAN_RE.search(raw)
    if m:
        return "debian", m.group(1)

    return None, None


def get_eol_date(os_id: str | None, version_id: str | None) -> date | None:
    """Look up the EOL date for the given OS / version. Returns None if unknown."""
    if not os_id or not version_id:
        return None
    table = EOL_DATES.get(os_id.lower())
    if not table:
        return None
    iso = table.get(version_id)
    if not iso:
        return None
    try:
        return date.fromisoformat(iso)
    except ValueError:
        return None


def _severity_for(days_remaining: int | None) -> str:
    if days_remaining is None:
        return "unknown"
    if days_remaining < 0:
        return "expired"
    if days_remaining < 30:
        return "alert"
    if days_remaining < 90:
        return "warning"
    if days_remaining < 365:
        return "ok"
    return "ok"


def get_eol_status(
    os_id: str | None,
    version_id: str | None,
    today: date | None = None,
) -> dict:
    """Compute EOL status for an OS/version.

    Returns a dict with keys::

        {
            "date": ISO date string | None,
            "days_remaining": int | None,
            "severity": "ok" | "warning" | "alert" | "expired" | "unknown",
            "esm_available": bool,
        }

    Severity thresholds (matches dashboard badge colours):

        - days_remaining >= 365  → "ok"      (no badge — too far out to surface)
        - 90  <= d < 365         → "ok"      (cyan)
        - 30  <= d < 90          → "warning" (amber)
        - 0   <= d < 30          → "alert"   (red)
        - d < 0                  → "expired" (red)
        - unknown OS/version     → "unknown"
    """
    eol = get_eol_date(os_id, version_id)
    if eol is None:
        return {
            "date": None,
            "days_remaining": None,
            "severity": "unknown",
            "esm_available": False,
        }
    if today is None:
        today = date.today()
    days_remaining = (eol - today).days
    return {
        "date": eol.isoformat(),
        "days_remaining": days_remaining,
        "severity": _severity_for(days_remaining),
        "esm_available": (os_id or "").lower() in _ESM_DISTROS,
    }


def get_eol_status_from_os_info(
    os_info: str | None,
    today: date | None = None,
) -> dict:
    """Convenience: parse os_info and return the full EOL status dict."""
    os_id, version_id = parse_os_info(os_info)
    return get_eol_status(os_id, version_id, today=today)
