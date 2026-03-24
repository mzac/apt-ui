import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.config import LOG_LEVEL, APP_VERSION
from backend.database import init_db, AsyncSessionLocal
from backend import models  # noqa: F401

logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.INFO))
logger = logging.getLogger(__name__)


async def seed_defaults():
    """Create default admin user, notification config, and schedule config if missing."""
    import secrets
    import bcrypt
    from sqlalchemy import select
    from backend import auth as auth_module

    async with AsyncSessionLocal() as session:
        # Default admin user
        result = await session.execute(select(models.User))
        if not result.scalars().first():
            admin = models.User(
                username="admin",
                password_hash=bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode(),
                is_admin=True,
            )
            session.add(admin)
            logger.warning(
                "⚠️  Default admin account created. Login with admin/admin and change the password immediately."
            )

        # Default notification config (id=1)
        result = await session.execute(
            select(models.NotificationConfig).where(models.NotificationConfig.id == 1)
        )
        if not result.scalar_one_or_none():
            session.add(models.NotificationConfig(id=1))

        # Default schedule config (id=1)
        result = await session.execute(
            select(models.ScheduleConfig).where(models.ScheduleConfig.id == 1)
        )
        if not result.scalar_one_or_none():
            session.add(models.ScheduleConfig(id=1))

        # JWT secret: use env var if set, otherwise persist in DB so sessions
        # survive container restarts (the DB lives on a mounted volume).
        from backend.config import JWT_SECRET
        if JWT_SECRET:
            auth_module.init_jwt_secret(JWT_SECRET)
        else:
            result = await session.execute(
                select(models.AppConfig).where(models.AppConfig.key == "jwt_secret")
            )
            row = result.scalar_one_or_none()
            if row:
                auth_module.init_jwt_secret(row.value)
            else:
                new_secret = secrets.token_hex(32)
                session.add(models.AppConfig(key="jwt_secret", value=new_secret))
                auth_module.init_jwt_secret(new_secret)
                logger.info("Generated and stored new JWT secret in database.")

        await session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_defaults()

    from backend.scheduler import start_scheduler, stop_scheduler
    await start_scheduler()

    yield

    stop_scheduler()


app = FastAPI(title="Apt Dashboard", version=APP_VERSION, lifespan=lifespan)

# Routers
from backend.routers import auth as auth_router
from backend.routers import servers as servers_router
from backend.routers import groups as groups_router
from backend.routers import tags as tags_router
from backend.routers import updates as updates_router
from backend.routers import upgrades as upgrades_router
from backend.routers import stats as stats_router
from backend.routers import scheduler as scheduler_router
from backend.routers import notifications as notifications_router
from backend.routers import config_io as config_io_router
from backend.routers import templates as templates_router
from backend.routers import aptcache as aptcache_router

app.include_router(auth_router.router)
app.include_router(servers_router.router)
app.include_router(groups_router.router)
app.include_router(tags_router.router)
app.include_router(updates_router.router)
app.include_router(upgrades_router.router)
app.include_router(stats_router.router)
app.include_router(scheduler_router.router)
app.include_router(notifications_router.router)
app.include_router(config_io_router.router)
app.include_router(templates_router.router)
app.include_router(aptcache_router.router)


@app.get("/api/config/features")
async def features():
    from backend.config import ENABLE_TERMINAL
    return {"enable_terminal": ENABLE_TERMINAL}


@app.get("/health")
async def health():
    from sqlalchemy import text
    db_ok = False
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        pass
    return {"status": "ok", "version": APP_VERSION, "db_ok": db_ok}


# Mount static frontend (built by Docker stage 1)
_static_dir = Path(__file__).parent.parent / "static"
if _static_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(_static_dir / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        index = _static_dir / "index.html"
        return FileResponse(str(index))
