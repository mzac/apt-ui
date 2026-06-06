import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

import bcrypt

from backend.auth import (
    create_access_token,
    generate_api_token,
    get_current_user,
    hash_password,
    require_admin,
    verify_password,
)
from backend.database import get_db
from backend.models import ApiToken, AuthEventLog, User
from backend.schemas import ChangePasswordRequest, LoginRequest, UserOut

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "apt_ui_token"
COOKIE_MAX_AGE = 60 * 60 * 24  # 24 hours

# ---------------------------------------------------------------------------
# Brute-force protection (issue #62) — in-memory per (username, ip) tracker.
# Resets on container restart, which is acceptable for a self-hosted single node.
# ---------------------------------------------------------------------------
_MAX_ATTEMPTS = 5
_WINDOW_SECONDS = 15 * 60
_LOCKOUT_SECONDS = 15 * 60
_attempts: dict[tuple[str, str], list[float]] = {}
_locked_until: dict[tuple[str, str], float] = {}


def _client_ip(request: Request | None) -> str:
    if request is None:
        return "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _lockout_remaining(key: tuple[str, str]) -> int:
    until = _locked_until.get(key)
    if until and until > time.time():
        return int(until - time.time())
    return 0


def _record_failure(key: tuple[str, str]) -> bool:
    """Record a failed attempt; return True if this trips a fresh lockout."""
    now = time.time()
    recent = [t for t in _attempts.get(key, []) if now - t < _WINDOW_SECONDS]
    recent.append(now)
    _attempts[key] = recent
    if len(recent) >= _MAX_ATTEMPTS:
        _locked_until[key] = now + _LOCKOUT_SECONDS
        _attempts[key] = []
        return True
    return False


def _clear_attempts(key: tuple[str, str]) -> None:
    _attempts.pop(key, None)
    _locked_until.pop(key, None)


async def record_auth_event(db, event_type: str, username: str | None = None,
                            actor: str | None = None, ip: str | None = None,
                            detail: str | None = None, success: bool = True) -> None:
    """Best-effort append to the auth event log."""
    try:
        db.add(AuthEventLog(
            event_type=event_type, username=username, actor=actor,
            ip_address=ip, detail=detail, success=success,
        ))
        await db.commit()
    except Exception as exc:
        logger.debug("auth event write failed: %s", exc)


async def _alert_lockout(username: str, ip: str) -> None:
    """Fire a notification when an account locks out (best-effort), via whatever
    simple channels are enabled."""
    try:
        from backend.database import AsyncSessionLocal
        from backend.models import NotificationConfig
        from backend import notifier
        msg = f"🔒 apt-ui: account '{username}' locked after {_MAX_ATTEMPTS} failed logins from {ip}."
        async with AsyncSessionLocal() as ndb:
            cfg = (await ndb.execute(select(NotificationConfig).where(NotificationConfig.id == 1))).scalar_one_or_none()
            if not cfg:
                return
            if getattr(cfg, "telegram_enabled", False):
                await notifier._send_telegram(cfg, msg, event_type="lockout")
            if getattr(cfg, "slack_enabled", False):
                await notifier._send_slack(cfg, "Account lockout", body=msg, event_type="lockout")
            if getattr(cfg, "webhook_enabled", False):
                await notifier._send_webhook(cfg, "lockout", {"username": username, "ip": ip, "attempts": _MAX_ATTEMPTS})
        await notifier.notify_destinations("lockout", "🔒 apt-ui account lockout", msg)
    except Exception as exc:
        logger.debug("lockout alert failed: %s", exc)


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    ip = _client_ip(request)
    key = ((body.username or "").lower().strip(), ip)

    # Brute-force lockout gate
    remaining = _lockout_remaining(key)
    if remaining > 0:
        await record_auth_event(db, "login_blocked", username=body.username, ip=ip,
                                detail=f"locked ({remaining}s remaining)", success=False)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {remaining // 60 + 1} min.",
        )

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if user is None or not verify_password(body.password, user.password_hash):
        tripped = _record_failure(key)
        await record_auth_event(db, "login_failed", username=body.username, ip=ip,
                                detail="invalid credentials", success=False)
        if tripped:
            await record_auth_event(db, "lockout", username=body.username, ip=ip,
                                    detail=f"locked for {_LOCKOUT_SECONDS // 60} min", success=False)
            await _alert_lockout(body.username, ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )

    # 2FA challenge (issue #18) — if user has TOTP enabled, require a valid code
    if user.totp_enabled and user.totp_secret_enc:
        code = (body.totp_code or "").strip()
        if not code:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="2FA code required",
                headers={"X-2FA-Required": "true"},
            )
        try:
            import pyotp
            from backend.crypto import decrypt
            secret = decrypt(user.totp_secret_enc)
            totp = pyotp.TOTP(secret)
            if not totp.verify(code, valid_window=1):
                tripped = _record_failure(key)
                await record_auth_event(db, "login_failed", username=body.username, ip=ip,
                                        detail="invalid 2FA code", success=False)
                if tripped:
                    await record_auth_event(db, "lockout", username=body.username, ip=ip,
                                            detail="repeated 2FA failures", success=False)
                    await _alert_lockout(body.username, ip)
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid 2FA code")
            # Replay protection: reject a code from a TOTP step already used to log in.
            counter = int(time.time()) // 30
            if user.totp_last_counter is not None and counter <= user.totp_last_counter:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                    detail="2FA code already used; wait for the next code")
            user.totp_last_counter = counter
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="2FA verification failed")

    _clear_attempts(key)
    user.last_login = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    await record_auth_event(db, "login", username=user.username, ip=ip, success=True)

    token = create_access_token(user.username)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=COOKIE_MAX_AGE,
    )
    out = UserOut.model_validate(user)
    out.is_default_password = bcrypt.checkpw(b"admin", user.password_hash.encode())
    return out


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(key=COOKIE_NAME)
    return {"detail": "Logged out"}


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    out = UserOut.model_validate(current_user)
    out.is_default_password = bcrypt.checkpw(b"admin", current_user.password_hash.encode())
    return out


@router.put("/password")
async def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    # Re-fetch within this session to allow update
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()
    user.password_hash = hash_password(body.new_password)
    await db.commit()

    return {"detail": "Password changed successfully"}


# ---------------------------------------------------------------------------
# API tokens (issue #38)
# ---------------------------------------------------------------------------

@router.get("/tokens")
async def list_tokens(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List API tokens for the current user. Token values are NOT returned —
    only metadata (name, prefix, created/last-used)."""
    res = await db.execute(
        select(ApiToken)
        .where(ApiToken.user_id == current_user.id)
        .order_by(ApiToken.created_at.desc())
    )
    return [
        {
            "id": t.id,
            "name": t.name,
            "prefix": t.token_prefix,
            "created_at": t.created_at,
            "last_used_at": t.last_used_at,
            "expires_at": t.expires_at,
            "scopes": t.scopes,
        }
        for t in res.scalars().all()
    ]


@router.post("/tokens")
async def create_token(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mint a new API token. The raw token is returned ONCE — store it now.

    Optional body: scopes (list of read/check/upgrade/calendar; empty = full access),
    expires_days (int)."""
    from datetime import timedelta
    from backend.auth import ALL_SCOPES
    name = (body.get("name") or "").strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="Token name required (1-100 chars)")
    raw_scopes = body.get("scopes") or []
    if isinstance(raw_scopes, str):
        raw_scopes = [s.strip() for s in raw_scopes.split(",") if s.strip()]
    scopes = [s for s in raw_scopes if s in ALL_SCOPES]
    expires_at = None
    days = body.get("expires_days")
    if isinstance(days, (int, float)) and days > 0:
        expires_at = datetime.utcnow() + timedelta(days=int(days))
    raw, hashed, prefix = generate_api_token()
    tok = ApiToken(
        user_id=current_user.id,
        name=name,
        token_hash=hashed,
        token_prefix=prefix,
        scopes=",".join(scopes) or None,
        expires_at=expires_at,
    )
    db.add(tok)
    await db.commit()
    await db.refresh(tok)
    result = {
        "id": tok.id,
        "name": tok.name,
        "prefix": tok.token_prefix,
        "token": raw,  # shown ONCE
        "created_at": tok.created_at,
        "scopes": tok.scopes,
        "expires_at": tok.expires_at,
    }
    await record_auth_event(db, "token_created", username=current_user.username,
                            actor=current_user.username, detail=name)
    return result


@router.delete("/tokens/{token_id}")
async def revoke_token(
    token_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.user_id == current_user.id)
    )
    tok = res.scalar_one_or_none()
    if tok is None:
        raise HTTPException(status_code=404, detail="Token not found")
    tok_name = tok.name
    await db.delete(tok)
    await db.commit()
    await record_auth_event(db, "token_revoked", username=current_user.username,
                            actor=current_user.username, detail=tok_name)
    return {"detail": "Token revoked"}


# ---------------------------------------------------------------------------
# TOTP 2FA (issue #18)
# ---------------------------------------------------------------------------

@router.post("/2fa/setup")
async def totp_setup(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a fresh TOTP secret and provisioning URI for the current user.

    Does NOT enable 2FA — call /2fa/verify with a valid code from the authenticator
    to confirm enrolment. Subsequent calls overwrite the pending secret.
    """
    import pyotp
    from backend.crypto import encrypt
    secret = pyotp.random_base32()
    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=current_user.username,
        issuer_name="apt-ui",
    )
    # Store the pending secret encrypted; totp_enabled stays False until verify
    res = await db.execute(select(User).where(User.id == current_user.id))
    user = res.scalar_one()
    user.totp_secret_enc = encrypt(secret)
    user.totp_enabled = False
    await db.commit()

    # Render the URI as a small SVG QR code
    import io
    import qrcode
    import qrcode.image.svg as qsvg
    img = qrcode.make(uri, image_factory=qsvg.SvgImage, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf)
    qr_svg = buf.getvalue().decode()

    return {"secret": secret, "uri": uri, "qr_svg": qr_svg}


@router.post("/2fa/verify")
async def totp_verify(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Confirm a TOTP enrolment by submitting a code from the authenticator."""
    import pyotp
    from backend.crypto import decrypt
    code = (body.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code required")

    res = await db.execute(select(User).where(User.id == current_user.id))
    user = res.scalar_one()
    if not user.totp_secret_enc:
        raise HTTPException(status_code=400, detail="No pending 2FA setup; call /2fa/setup first")

    secret = decrypt(user.totp_secret_enc)
    totp = pyotp.TOTP(secret)
    if not totp.verify(code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code")

    user.totp_enabled = True
    await db.commit()
    await record_auth_event(db, "2fa_enabled", username=user.username, actor=user.username)
    return {"detail": "2FA enabled"}


@router.post("/2fa/disable")
async def totp_disable(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Disable 2FA. Requires the current password to confirm."""
    if not verify_password(body.get("password") or "", current_user.password_hash):
        raise HTTPException(status_code=400, detail="Invalid password")
    res = await db.execute(select(User).where(User.id == current_user.id))
    user = res.scalar_one()
    user.totp_enabled = False
    user.totp_secret_enc = None
    user.totp_last_counter = None
    await db.commit()
    await record_auth_event(db, "2fa_disabled", username=user.username, actor=user.username)
    return {"detail": "2FA disabled"}


@router.get("/2fa/status")
async def totp_status(current_user: User = Depends(get_current_user)):
    return {"enabled": current_user.totp_enabled}


# ---------------------------------------------------------------------------
# User management (admin only) — issue #39
# ---------------------------------------------------------------------------

def _user_dict(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "is_admin": u.is_admin,
        "created_at": u.created_at,
        "last_login": u.last_login,
    }


@router.get("/users")
async def list_users(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(select(User).order_by(User.username))
    return [_user_dict(u) for u in res.scalars().all()]


@router.post("/users", status_code=201)
async def create_user(
    body: dict,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    is_admin = bool(body.get("is_admin", False))

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    if len(username) > 100:
        raise HTTPException(status_code=400, detail="Username too long")

    existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        username=username,
        password_hash=hash_password(password),
        is_admin=is_admin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await record_auth_event(db, "user_created", username=user.username,
                            actor=current_user.username, detail="admin" if is_admin else "user")
    return _user_dict(user)


@router.put("/users/{user_id}")
async def update_user(
    user_id: int,
    body: dict,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(select(User).where(User.id == user_id))
    user = res.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Update role
    if "is_admin" in body:
        new_admin = bool(body["is_admin"])
        # Don't let an admin demote themselves if they're the last admin
        if user.id == current_user.id and not new_admin:
            other_admins = await db.execute(
                select(User).where(User.is_admin == True, User.id != user.id)
            )
            if other_admins.scalar_one_or_none() is None:
                raise HTTPException(status_code=400, detail="Cannot demote the last admin")
        user.is_admin = new_admin

    # Update password (admin reset)
    if body.get("password"):
        if len(body["password"]) < 4:
            raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
        user.password_hash = hash_password(body["password"])

    await db.commit()
    await db.refresh(user)
    changes = []
    if "is_admin" in body:
        changes.append("admin" if user.is_admin else "non-admin")
    if body.get("password"):
        changes.append("password reset")
    await record_auth_event(db, "user_updated", username=user.username,
                            actor=current_user.username, detail=", ".join(changes) or None)
    return _user_dict(user)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    res = await db.execute(select(User).where(User.id == user_id))
    user = res.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    # Make sure we don't delete the last admin
    if user.is_admin:
        other_admins = await db.execute(
            select(User).where(User.is_admin == True, User.id != user.id)
        )
        if other_admins.scalar_one_or_none() is None:
            raise HTTPException(status_code=400, detail="Cannot delete the last admin")
    # Cascade-delete the user's API tokens
    deleted_username = user.username
    tokens_res = await db.execute(select(ApiToken).where(ApiToken.user_id == user_id))
    for tok in tokens_res.scalars().all():
        await db.delete(tok)
    await db.delete(user)
    await db.commit()
    await record_auth_event(db, "user_deleted", username=deleted_username,
                            actor=current_user.username)


# ---------------------------------------------------------------------------
# Auth event log (issue #62) — admin-only audit trail
# ---------------------------------------------------------------------------

@router.get("/events")
async def list_auth_events(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    total = (await db.execute(select(func.count()).select_from(AuthEventLog))).scalar() or 0
    res = await db.execute(
        select(AuthEventLog)
        .order_by(AuthEventLog.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    items = [
        {
            "id": e.id,
            "created_at": e.created_at,
            "event_type": e.event_type,
            "username": e.username,
            "actor": e.actor,
            "ip_address": e.ip_address,
            "detail": e.detail,
            "success": e.success,
        }
        for e in res.scalars().all()
    ]
    return {"total": total, "page": page, "limit": limit, "items": items}
