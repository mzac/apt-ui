import contextvars
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Cookie, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import config


# ---------------------------------------------------------------------------
# API token helpers (issue #38)
# ---------------------------------------------------------------------------

API_TOKEN_PREFIX = "aptui_"

# Scopes of the API token used for the current request (None = interactive/cookie
# session or an unscoped legacy token → full access). Set during get_current_user.
ALL_SCOPES = ("read", "check", "upgrade", "calendar")
_token_scopes: contextvars.ContextVar[set[str] | None] = contextvars.ContextVar("apt_ui_token_scopes", default=None)


def current_token_scopes() -> set[str] | None:
    try:
        return _token_scopes.get()
    except LookupError:
        return None


def require_scope(scope: str):
    """Dependency factory: 403 if the request's API token doesn't include *scope*.
    Cookie sessions and unscoped tokens are unrestricted."""
    from fastapi import Depends

    async def _impl(user=Depends(get_current_user)):
        scopes = current_token_scopes()
        if scopes is not None and scope not in scopes:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"API token lacks the '{scope}' scope")
        return user
    return _impl


def generate_api_token() -> tuple[str, str, str]:
    """Mint a new token. Returns (raw_token, scrypt_hash, display_prefix).

    The raw token is shown ONCE; only the scrypt hash is stored in the DB.
    """
    raw = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    h = hash_api_token(raw)
    return raw, h, raw[:12]


def hash_api_token(raw: str) -> str:
    """Compute a stable hash of an API token for DB storage / lookup.

    scrypt (memory-hard KDF) is used so that a DB leak alone cannot be used
    to brute-force tokens. A fixed salt is acceptable because tokens are
    256-bit random secrets — the token entropy provides the primary security.
    scrypt at n=2^14 adds ~10 ms overhead per lookup, which is fine for the
    low-frequency create/verify path.
    """
    return hashlib.scrypt(
        raw.encode(), salt=b"apt-ui-api-token", n=2**14, r=8, p=1
    ).hex()

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

def create_access_token(username: str, token_version: int = 0) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=config.JWT_EXPIRY_HOURS)
    payload = {"sub": username, "exp": expire, "tv": int(token_version or 0)}
    return jwt.encode(payload, get_jwt_secret(), algorithm=config.JWT_ALGORITHM)


def session_is_current(user, token_version: int) -> bool:
    """False once the user's password has changed since the session was issued.

    Without this a stolen cookie kept working for its full 24h even after the
    victim (or an admin) reset the password. Tokens issued before this claim
    existed carry no ``tv`` and count as version 0, so upgrading logs nobody out.
    """
    return int(getattr(user, "token_version", 0) or 0) == token_version


def decode_token(token: str) -> tuple[str, int]:
    """Return (username, token_version) from token or raise HTTPException."""
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[config.JWT_ALGORITHM])
        username: str = payload.get("sub")
        if not username:
            raise ValueError("missing sub")
        tv = payload.get("tv", 0)
        return username, tv if isinstance(tv, int) else 0
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired"
        )
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def _enforce_token_confinement(request: Request, scopes: set[str] | None) -> None:
    """Keep a *scoped* API token inside what its scopes actually cover.

    Scopes used to be consulted only by ``require_scope`` (i.e. only on /api/v1),
    so a ``calendar``-only token — which by design sits in feed URLs, proxy logs
    and third-party calendar services — was accepted as a full credential on every
    other endpoint, including ``POST /api/auth/tokens`` (mint an unscoped token).

    A scoped token may now only:
      * call /api/v1/* (where ``require_scope`` checks the specific scope), or
      * make read-only GET requests elsewhere, and only with the ``read`` scope —
        never under /api/auth or /api/config (credentials, config export).
    Unscoped tokens and cookie sessions are unaffected.
    """
    if scopes is None:
        return
    path = request.url.path
    if path == "/api/v1" or path.startswith("/api/v1/"):
        return
    sensitive = path.startswith("/api/auth") or path.startswith("/api/config")
    if request.method in ("GET", "HEAD") and "read" in scopes and not sensitive:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This API token is scoped and cannot be used on this endpoint",
    )


async def get_current_user(
    request: Request,
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
                # Record the token's scopes for require_scope() (empty/None = full access)
                scopes = {s.strip() for s in (getattr(tok, "scopes", None) or "").split(",") if s.strip()}
                _token_scopes.set(scopes or None)
                _enforce_token_confinement(request, scopes or None)
                # Update last_used_at (best effort)
                tok.last_used_at = datetime.utcnow()
                await session.commit()
                return user

    # Path 2: JWT cookie (existing behaviour) — full access
    _token_scopes.set(None)
    if not apt_ui_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    username, token_version = decode_token(apt_ui_token)

    from backend.models import User as _User

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(_User).where(_User.username == username))
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    if not session_is_current(user, token_version):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired"
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
        username, token_version = decode_token(token)
    except HTTPException:
        return None

    from backend.models import User

    result = await session.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if user is None or not session_is_current(user, token_version):
        return None
    return user


# ---------------------------------------------------------------------------
# WebSocket authentication
# ---------------------------------------------------------------------------

def _origin_allowed(websocket) -> bool:
    """Reject cross-origin WebSocket handshakes (cross-site WebSocket hijacking).

    WebSockets authenticate with the session cookie and browsers do not apply the
    same-origin policy to them, so without this any page the browser considers
    *same-site* — another port on the same host, a sibling subdomain — could open
    /api/ws/upgrade-all or the shell with the admin's cookie. ``SameSite=Lax``
    does not help there: "site" ignores port and subdomain.

    The Origin's host[:port] must match the Host the client connected to. Behind a
    reverse proxy that rewrites Host, ``X-Forwarded-Host`` is accepted as well — a
    browser cannot set that header on a WebSocket handshake, so honouring it does
    not reopen the hole. ``WS_ALLOWED_ORIGINS`` is the explicit escape hatch.
    Non-browser clients send no Origin and are not affected.
    """
    from urllib.parse import urlsplit

    origin = websocket.headers.get("origin")
    if not origin:
        return True
    origin = origin.strip().lower().rstrip("/")
    if origin in config.WS_ALLOWED_ORIGINS:
        return True
    parts = urlsplit(origin)
    if not parts.netloc:
        return False  # "null" (sandboxed iframe, file://) or garbage

    default_port = {"http": "80", "https": "443"}.get(parts.scheme)

    def _norm(host: str) -> str:
        host = host.strip().lower()
        if default_port and host.endswith(":" + default_port):
            host = host[: -len(default_port) - 1]
        return host

    candidates = [websocket.headers.get("host") or ""]
    candidates += (websocket.headers.get("x-forwarded-host") or "").split(",")
    return _norm(parts.netloc) in {_norm(c) for c in candidates if c.strip()}


async def ws_authenticate(websocket, session: AsyncSession, *, admin: bool):
    """Authenticate an already-accepted WebSocket; returns the User or None.

    On failure the socket has already been told why and closed (1008), so the
    caller just returns. Pass ``admin=True`` for anything that changes a managed
    host — read-only accounts must not be able to do over a WebSocket what the
    equivalent REST endpoint refuses them.
    """
    async def _refuse(message: str | None):
        try:
            if message:
                await websocket.send_json({"type": "error", "data": message})
            await websocket.close(code=1008)
        except Exception:
            pass

    if not _origin_allowed(websocket):
        await _refuse(
            "Cross-origin WebSocket connection refused. If apt-ui is behind a reverse proxy, "
            "have it preserve the Host header (or send X-Forwarded-Host), or list this origin "
            "in WS_ALLOWED_ORIGINS."
        )
        return None
    user = await get_current_user_ws(websocket.cookies.get("apt_ui_token") or "", session)
    if user is None:
        await _refuse(None)
        return None
    if admin and not user.is_admin:
        await _refuse("This action requires an administrator account.")
        return None
    return user
