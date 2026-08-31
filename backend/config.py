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

# Only honor X-Forwarded-For (for login lockout / audit IP) when behind a trusted
# reverse proxy; otherwise a client could spoof the header (issue #62).
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").lower() == "true"

APP_VERSION = os.getenv("APP_VERSION", "dev")

# ---------------------------------------------------------------------------
# OIDC / OAuth2 SSO (issue #62) — entirely optional, off by default. When
# OIDC_ENABLED is unset/false none of this is read and current behavior is
# unchanged. Local password login (incl. the break-glass admin account)
# always keeps working even when SSO is enabled, so a misconfigured IdP can
# never lock every admin out — see backend/oidc.py and routers/auth.py.
# ---------------------------------------------------------------------------
OIDC_ENABLED = os.getenv("OIDC_ENABLED", "false").lower() == "true"
OIDC_ISSUER = os.getenv("OIDC_ISSUER", "")  # e.g. https://idp.example.com/realms/main
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "")
OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")  # never logged, never returned by any API
# Full callback URL registered with the IdP, e.g. https://apt-ui.example.com/api/auth/sso/callback
OIDC_REDIRECT_URL = os.getenv("OIDC_REDIRECT_URL", "")
OIDC_SCOPES = os.getenv("OIDC_SCOPES", "openid profile email")
# Claim in the ID token (or userinfo) holding the user's group memberships.
OIDC_GROUPS_CLAIM = os.getenv("OIDC_GROUPS_CLAIM", "groups")
# Group value that grants is_admin. Empty = SSO users are never made admin via
# group mapping (they stay read-only JIT-provisioned users; an existing admin
# must promote them manually in Settings > Users).
OIDC_ADMIN_GROUP = os.getenv("OIDC_ADMIN_GROUP", "")
# An OIDC login whose username collides with an existing *local* account is
# refused by default (account-takeover protection — see oidc.py). Set this to
# "true" only if you have verified the IdP is trusted to assert that username.
OIDC_LINK_EXISTING_USERS = os.getenv("OIDC_LINK_EXISTING_USERS", "false").lower() == "true"


def now_local() -> datetime:
    """Return the current time as a tz-aware datetime in the configured TZ.

    Use this anywhere you need a timezone-aware "now" — the bare
    `datetime.now(tz=TZ)` pattern is wrong because `datetime.now()`
    requires a `tzinfo` subclass, not a string.
    """
    return datetime.now(tz=LOCAL_ZONE)
