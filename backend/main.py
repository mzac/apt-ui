import base64
import hashlib
import logging
from contextlib import asynccontextmanager
from html.parser import HTMLParser
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
        from backend.config import ADMIN_PASSWORD
        from backend.routers.auth import (
            NEW_INSTALL_PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_KEY,
        )

        users = (await session.execute(select(models.User))).scalars().all()
        if not users:
            # First start. There is no well-known default password any more:
            # take ADMIN_PASSWORD if the operator set one, otherwise generate a
            # random one and print it exactly once — it is not stored anywhere
            # but as a bcrypt hash, so `python -m backend.cli reset-password`
            # is the way back in if this log line is lost.
            generated = not ADMIN_PASSWORD
            initial_password = ADMIN_PASSWORD or secrets.token_urlsafe(18)
            is_default = initial_password == auth_module.DEFAULT_PASSWORD
            session.add(models.User(
                username="admin",
                password_hash=bcrypt.hashpw(initial_password.encode(), bcrypt.gensalt()).decode(),
                is_admin=True,
                must_change_password=is_default,
            ))
            if generated:
                banner = "=" * 68
                logger.warning(
                    "\n%s\n  apt-ui first start — initial admin account created\n"
                    "    username: admin\n    password: %s\n"
                    "  This password is shown only once. Change it after logging in\n"
                    "  (Settings → Account), or set ADMIN_PASSWORD before first start.\n%s",
                    banner, initial_password, banner,
                )
            elif is_default:
                logger.warning(
                    "ADMIN_PASSWORD is the old default ('admin'): the admin account was created, "
                    "but it can do nothing until that password is changed at first login."
                )
            else:
                logger.info("Initial admin account created with the password from ADMIN_PASSWORD.")
                if len(initial_password) < NEW_INSTALL_PASSWORD_MIN_LENGTH:
                    logger.warning(
                        "ADMIN_PASSWORD is shorter than the %d-character minimum new installs enforce "
                        "for every later password change.", NEW_INSTALL_PASSWORD_MIN_LENGTH,
                    )
            # New installs start with a stricter password policy. Existing
            # databases have no stored value and keep the old fallback (4)
            # until an admin raises it, so nobody is locked out by an upgrade.
            has_policy = (await session.execute(
                select(models.AppConfig).where(models.AppConfig.key == PASSWORD_MIN_LENGTH_KEY)
            )).scalar_one_or_none()
            if not has_policy:
                session.add(models.AppConfig(
                    key=PASSWORD_MIN_LENGTH_KEY, value=str(NEW_INSTALL_PASSWORD_MIN_LENGTH),
                ))
        else:
            # Existing install: flag any local account still on the old seeded
            # password. Login keeps working, but the session is confined to
            # changing the password (auth.enforce_password_change).
            default_pw = auth_module.DEFAULT_PASSWORD.encode()
            for u in users:
                if u.must_change_password or (u.auth_provider or "local") != "local":
                    continue
                try:
                    still_default = bcrypt.checkpw(default_pw, u.password_hash.encode())
                except ValueError:
                    still_default = False  # unusable / non-bcrypt hash
                if still_default:
                    u.must_change_password = True
                    logger.warning(
                        "User '%s' still has the default password — the account is restricted to "
                        "changing it until that is done.", u.username,
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

        # Encryption key for per-server SSH keys and TOTP secrets: env var if
        # set, otherwise persist in the DB (issue #77 — an ephemeral key made
        # stored SSH keys unusable after every container restart).
        from backend import crypto as crypto_module

        env_encryption_key = crypto_module.env_key()
        if env_encryption_key:
            crypto_module.init_encryption_key(env_encryption_key)
        else:
            result = await session.execute(
                select(models.AppConfig).where(models.AppConfig.key == "encryption_key")
            )
            row = result.scalar_one_or_none()
            if row:
                crypto_module.init_encryption_key(row.value)
            else:
                new_key = secrets.token_hex(32)
                session.add(models.AppConfig(key="encryption_key", value=new_key))
                crypto_module.init_encryption_key(new_key)
                logger.info(
                    "Generated and stored a new encryption key in the database. "
                    "Set ENCRYPTION_KEY to manage it outside the DB instead."
                )

        await session.commit()


async def warn_unreadable_ssh_keys():
    """Log a clear warning for stored per-server SSH keys we can no longer decrypt.

    Before the encryption key was persisted (issue #77) it was regenerated on
    every restart, leaving undecryptable blobs behind. Those servers silently
    fall back to global SSH auth, so surface them explicitly at startup.
    """
    from sqlalchemy import select
    from backend.crypto import decrypt

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(models.Server).where(models.Server.ssh_private_key_enc.isnot(None))
        )
        broken = []
        for server in result.scalars().all():
            try:
                decrypt(server.ssh_private_key_enc)
            except Exception:
                broken.append(server.name or server.hostname)

    if broken:
        logger.warning(
            "⚠️  Stored SSH key could not be decrypted for %d server(s): %s. "
            "The encryption key changed (or was ephemeral before this version). "
            "Re-enter the SSH key for these servers in Settings → Servers; "
            "until then they fall back to the global SSH_PRIVATE_KEY / agent.",
            len(broken), ", ".join(sorted(broken)),
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_defaults()
    await warn_unreadable_ssh_keys()

    # Any Task still marked running/queued belongs to a process that is gone —
    # mark it interrupted before the scheduler starts creating new ones (issue #62).
    from backend.task_queue import reconcile_interrupted_tasks
    interrupted = await reconcile_interrupted_tasks()
    if interrupted:
        logger.warning("Marked %d task(s) as interrupted after restart", interrupted)

    from backend.scheduler import start_scheduler, stop_scheduler
    await start_scheduler()

    # Staged rollouts are persisted, so steps that came due while this process was
    # down must be re-scheduled or run now — otherwise a restart silently strands
    # every pending ring (the bug the durable rollout work exists to fix). Runs
    # after the scheduler starts because it registers DateTrigger jobs on it.
    from backend.rollout import reconcile_rollouts
    try:
        rc = await reconcile_rollouts()
        if rc:
            logger.info("Rollout reconciliation: %s", rc)
    except Exception:
        logger.exception("Rollout reconciliation failed")

    yield

    stop_scheduler()


# The interactive API docs are off: they are served unauthenticated, disclose the
# whole REST/WebSocket surface, and pull their UI from a third-party CDN onto the
# app's own origin (which would also need a hole in the CSP below).
app = FastAPI(
    title="Apt Dashboard",
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_static_dir = Path(__file__).parent.parent / "static"


def _inline_script_hashes() -> str:
    """CSP hash sources for the inline <script> blocks in the built index.html.

    index.html carries one small inline script (it applies the saved theme before
    React mounts). Hashing whatever is actually in the built file keeps the policy
    free of 'unsafe-inline' without having to keep a hard-coded hash in sync.
    """
    try:
        html = (_static_dir / "index.html").read_text(encoding="utf-8")
    except OSError:
        return ""

    class _InlineScripts(HTMLParser):
        """Collects the exact text of every <script> that has no src attribute."""

        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.bodies: list[str] = []
            self._current: list[str] | None = None

        def handle_starttag(self, tag, attrs):
            if tag == "script" and not any(name == "src" for name, _ in attrs):
                self._current = []

        def handle_data(self, data):
            if self._current is not None:
                self._current.append(data)

        def handle_endtag(self, tag):
            if tag == "script" and self._current is not None:
                self.bodies.append("".join(self._current))
                self._current = None

    parser = _InlineScripts()
    parser.feed(html)
    parser.close()
    hashes = []
    for body in parser.bodies:
        digest = base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode()
        hashes.append(f"'sha256-{digest}'")
    return " ".join(hashes)


# Log output from managed hosts is rendered as HTML (ANSI colours), so the CSP is
# the second line of defence behind the escaping done in the frontend: no inline
# or third-party script can run even if something slips through. Inline *styles*
# stay allowed — React style props and xterm.js need them.
_CSP = "; ".join([
    "default-src 'self'",
    f"script-src 'self' {_inline_script_hashes()}".rstrip(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

_SECURITY_HEADERS = {
    "Content-Security-Policy": _CSP,
    # frame-ancestors covers modern browsers; X-Frame-Options covers the rest.
    # Either way the upgrade / reboot buttons can't be framed for clickjacking.
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    for name, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


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
from backend.routers import tailscale as tailscale_router
from backend.routers import dpkg_log as dpkg_log_router
from backend.routers import apt_repos as apt_repos_router
from backend.routers import metrics as metrics_router
from backend.routers import status_page as status_page_router
from backend.routers import maintenance as maintenance_router
from backend.routers import release_check as release_check_router
from backend.routers import hooks as hooks_router
from backend.routers import reports as reports_router
from backend.routers import calendar as calendar_router
from backend.routers import security as security_router
from backend.routers import api_v1 as api_v1_router
from backend.routers import tasks as tasks_router
from backend.routers import exports as exports_router
from backend.routers import rollouts as rollouts_router

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
app.include_router(tailscale_router.router)
app.include_router(dpkg_log_router.router)
app.include_router(apt_repos_router.router)
app.include_router(metrics_router.router)
app.include_router(status_page_router.router)
app.include_router(maintenance_router.router)
app.include_router(release_check_router.router)
app.include_router(hooks_router.router)
app.include_router(reports_router.router)
app.include_router(calendar_router.router)
app.include_router(security_router.router)
app.include_router(api_v1_router.router)
app.include_router(tasks_router.router)
app.include_router(exports_router.router)
app.include_router(rollouts_router.router)


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
if _static_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(_static_dir / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        index = _static_dir / "index.html"
        return FileResponse(str(index))
