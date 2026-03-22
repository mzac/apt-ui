import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Cookie, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import config

_jwt_secret: str | None = None


def init_jwt_secret(secret: str) -> None:
    """Called once at startup to set the JWT secret (from env var or DB)."""
    global _jwt_secret
    _jwt_secret = secret


def get_jwt_secret() -> str:
    global _jwt_secret
    if _jwt_secret is None:
        # Fallback: env var or ephemeral random (won't persist across restarts
        # unless init_jwt_secret() was called during startup via seed_defaults)
        _jwt_secret = config.JWT_SECRET or secrets.token_hex(32)
    return _jwt_secret


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_access_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=config.JWT_EXPIRY_HOURS)
    payload = {"sub": username, "exp": expire}
    return jwt.encode(payload, get_jwt_secret(), algorithm=config.JWT_ALGORITHM)


def decode_token(token: str) -> str:
    """Return username from token or raise HTTPException."""
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[config.JWT_ALGORITHM])
        username: str = payload.get("sub")
        if not username:
            raise ValueError("missing sub")
        return username
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired"
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def get_current_user(
    apt_dashboard_token: str | None = Cookie(default=None),
):
    """FastAPI dependency — resolves the logged-in User or raises 401."""
    if not apt_dashboard_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    username = decode_token(apt_dashboard_token)

    # Import here to avoid circular imports at module load
    from backend.database import AsyncSessionLocal
    from backend.models import User

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    return user


async def get_current_user_ws(token: str, session: AsyncSession):
    """Validate token for WebSocket handshake; returns user or None."""
    try:
        username = decode_token(token)
    except HTTPException:
        return None

    from backend.models import User

    result = await session.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()
