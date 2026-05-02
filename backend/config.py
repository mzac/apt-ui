import os
from datetime import datetime
from zoneinfo import ZoneInfo

DATABASE_PATH = os.getenv("DATABASE_PATH", "/data/apt-ui.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DATABASE_PATH}"

SSH_PRIVATE_KEY = os.getenv("SSH_PRIVATE_KEY", "")
SSH_AUTH_SOCK = os.getenv("SSH_AUTH_SOCK", "")  # path to SSH agent socket (optional alternative to SSH_PRIVATE_KEY)
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "")  # master key for encrypting per-server SSH keys in the DB

JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TZ = os.getenv("TZ", "America/Montreal")
LOCAL_ZONE = ZoneInfo(TZ)

# Set to "true" to enable the interactive SSH shell terminal in the UI.
# Disabled by default — only enable if you trust all dashboard users.
ENABLE_TERMINAL = os.getenv("ENABLE_TERMINAL", "false").lower() == "true"

APP_VERSION = os.getenv("APP_VERSION", "dev")


def now_local() -> datetime:
    """Return the current time as a tz-aware datetime in the configured TZ.

    Use this anywhere you need a timezone-aware "now" — the bare
    `datetime.now(tz=TZ)` pattern is wrong because `datetime.now()`
    requires a `tzinfo` subclass, not a string.
    """
    return datetime.now(tz=LOCAL_ZONE)
