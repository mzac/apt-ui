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
    import bcrypt
    from sqlalchemy import select

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
from backend.routers import updates as updates_router
from backend.routers import upgrades as upgrades_router
from backend.routers import stats as stats_router
from backend.routers import scheduler as scheduler_router
from backend.routers import notifications as notifications_router

app.include_router(auth_router.router)
app.include_router(servers_router.router)
app.include_router(groups_router.router)
app.include_router(updates_router.router)
app.include_router(upgrades_router.router)
app.include_router(stats_router.router)
app.include_router(scheduler_router.router)
app.include_router(notifications_router.router)


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
