from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
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
from backend.models import ApiToken, User
from backend.schemas import ChangePasswordRequest, LoginRequest, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "apt_dashboard_token"
COOKIE_MAX_AGE = 60 * 60 * 24  # 24 hours


@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if user is None or not verify_password(body.password, user.password_hash):
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
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid 2FA code")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="2FA verification failed")

    user.last_login = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

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
        }
        for t in res.scalars().all()
    ]


@router.post("/tokens")
async def create_token(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mint a new API token. The raw token is returned ONCE — store it now."""
    name = (body.get("name") or "").strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="Token name required (1-100 chars)")
    raw, hashed, prefix = generate_api_token()
    tok = ApiToken(
        user_id=current_user.id,
        name=name,
        token_hash=hashed,
        token_prefix=prefix,
    )
    db.add(tok)
    await db.commit()
    await db.refresh(tok)
    return {
        "id": tok.id,
        "name": tok.name,
        "prefix": tok.token_prefix,
        "token": raw,  # shown ONCE
        "created_at": tok.created_at,
    }


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
    await db.delete(tok)
    await db.commit()
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
    await db.commit()
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
    tokens_res = await db.execute(select(ApiToken).where(ApiToken.user_id == user_id))
    for tok in tokens_res.scalars().all():
        await db.delete(tok)
    await db.delete(user)
    await db.commit()
