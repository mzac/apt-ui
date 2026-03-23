import os

DATABASE_PATH = os.getenv("DATABASE_PATH", "/data/apt-dashboard.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DATABASE_PATH}"

SSH_PRIVATE_KEY = os.getenv("SSH_PRIVATE_KEY", "")
SSH_AUTH_SOCK = os.getenv("SSH_AUTH_SOCK", "")  # path to SSH agent socket (optional alternative to SSH_PRIVATE_KEY)

JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TZ = os.getenv("TZ", "America/Montreal")

# Set to "true" to enable the interactive SSH shell terminal in the UI.
# Disabled by default — only enable if you trust all dashboard users.
ENABLE_TERMINAL = os.getenv("ENABLE_TERMINAL", "false").lower() == "true"

APP_VERSION = "1.0.0"
