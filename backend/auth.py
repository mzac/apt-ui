import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Cookie, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import config


# ---------------------------------------------------------------------------
# API token helpers (issue #38)
# ---------------------------------------------------------------------------

API_TOKEN_PREFIX = "aptui_"


def generate_api_token() -> tuple[str, str, str]:
    """Mint a new token. Returns (raw_token, hmac_hash, display_prefix).

    The raw token is returned ONCE for display; only the keyed HMAC of the
    token is stored. Using HMAC-SHA256 keyed with the JWT secret means a DB
    leak alone does not let an attacker authenticate — they would also need
    the server-side secret to forge a matching hash.
    """
    raw = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    h = hash_api_token(raw)
    return raw, h, raw[:12]


def hash_api_token(raw: str) -> str:
    """Compute a stable, keyed hash of an API token for DB storage / lookup.

    HMAC-SHA256 is appropriate here because tokens are 256-bit random secrets
    (not user-chosen passwords), so the dominant security comes from token
    entropy. The HMAC key prevents pre-computed table attacks if the DB leaks.
    """
    key = get_jwt_secret().encode()
    return hmac.new(key, raw.encode(), hashlib.sha256).hexdigest()

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
    apt_ui_token: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """FastAPI dependency — resolves the logged-in User or raises 401.

    Accepts either:
      1. JWT cookie (browser sessions)
      2. Authorization: Bearer aptui_<token> header (API tokens, issue #38)
    """
    from backend.database import AsyncSessionLocal
    from backend.models import ApiToken, User

    # Path 1: API token via Authorization header
    if authorization and authorization.lower().startswith("bearer "):
        raw_token = authorization[7:].strip()
        if raw_token.startswith(API_TOKEN_PREFIX):
            token_hash = hash_api_token(raw_token)
            async with AsyncSessionLocal() as session:
                tok_res = await session.execute(
                    select(ApiToken).where(ApiToken.token_hash == token_hash)
                )
                tok = tok_res.scalar_one_or_none()
                if tok is None:
                    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API token")
                if tok.expires_at and tok.expires_at < datetime.utcnow():
                    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API token expired")
                user_res = await session.execute(select(User).where(User.id == tok.user_id))
                user = user_res.scalar_one_or_none()
                if user is None:
                    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token owner not found")
                # Update last_used_at (best effort)
                tok.last_used_at = datetime.utcnow()
                await session.commit()
                return user

    # Path 2: JWT cookie (existing behaviour)
    if not apt_ui_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    username = decode_token(apt_ui_token)

    from backend.models import User as _User

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(_User).where(_User.username == username))
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    return user


async def require_admin(user=None):
    """FastAPI dependency that 403s if the current user is not an admin.

    Use as: `_: User = Depends(require_admin)` on mutation endpoints.
    Read-only users can still call GET endpoints (which depend on get_current_user only).
    """
    # Resolve current user lazily — accept it via Depends below
    from fastapi import Depends as _Depends
    raise NotImplementedError  # placeholder; real impl below


# Re-define using proper Depends chaining
def _build_require_admin():
    from fastapi import Depends
    async def _impl(user=Depends(get_current_user)):
        if not getattr(user, "is_admin", False):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin access required",
            )
        return user
    return _impl


require_admin = _build_require_admin()  # type: ignore[assignment]


async def get_current_user_ws(token: str, session: AsyncSession):
    """Validate token for WebSocket handshake; returns user or None."""
    try:
        username = decode_token(token)
    except HTTPException:
        return None

    from backend.models import User

    result = await session.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()
