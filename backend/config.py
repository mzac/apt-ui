import os

DATABASE_PATH = os.getenv("DATABASE_PATH", "/data/apt-dashboard.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DATABASE_PATH}"

SSH_PRIVATE_KEY = os.getenv("SSH_PRIVATE_KEY", "")

JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TZ = os.getenv("TZ", "America/Montreal")

APP_VERSION = "1.0.0"
