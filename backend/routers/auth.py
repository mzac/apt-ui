from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import bcrypt

from backend.auth import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from backend.database import get_db
from backend.models import User
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
