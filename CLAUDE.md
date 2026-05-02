# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Development Commands

### Backend (Python/FastAPI)
```bash
# Set up environment (from repo root)
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

# Run backend dev server
export SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"
export DATABASE_PATH="./data/dev.db"
export PYTHONPATH=$(pwd)
uvicorn backend.main:app --reload --port 8000

# CLI tool (inside container or with venv active)
python -m backend.cli reset-password --username admin --password newpass
python -m backend.cli create-user --username zac --password mypass
python -m backend.cli list-users
```

### Frontend (React/TypeScript)
```bash
cd frontend
npm ci              # use npm ci (not npm install) — package-lock.json is committed
npm run dev         # Vite dev server on :5173, proxies /api/* to :8000
npm run build       # tsc type-check + vite build → dist/
```

There is no test framework configured. Testing is manual.

### Local CI runner
```bash
make ci          # Python syntax + import check + frontend build (mirrors GitHub Actions)
make venv        # Create ./venv and install backend/requirements.txt
make help        # List all targets
```
`make ci` auto-detects a venv at `./venv` or `./.venv`; falls back to system `python3` and skips the import check if FastAPI isn't installed.

### Docker
```bash
./build-run.sh                    # build + start + tail logs
docker compose up --build -d      # detached
docker compose logs -f
docker compose exec apt-ui python -m backend.cli reset-password
```

### Docker with Tailscale (production overlay)
```bash
# Requires TS_AUTHKEY (and optionally TS_HOSTNAME) in .env
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up --build -d

# Local dev with Tailscale (git-ignored overlay)
./build-run-local.sh   # uses docker-compose.local.yml
```

---

## Database Migrations

**No Alembic.** Schema changes are a hand-maintained list of `ALTER TABLE` statements in `backend/database.py` inside `init_db()`. Errors are silently swallowed, so the same list is safe for both fresh and existing databases.

**Rule: every new column in `backend/models.py` requires a matching entry in the migrations list in `backend/database.py`.** Skipping this causes `OperationalError: no such column` against existing databases.

```python
# Pattern (in backend/database.py — migrations list inside init_db())
"ALTER TABLE <table> ADD COLUMN <column> <TYPE> DEFAULT <value>",
```

- Nullable columns with no default: use bare type (`TEXT`, `INTEGER`) with no `DEFAULT` clause — SQLite fills existing rows with `NULL`.
- New **tables** do NOT need a migration entry — `Base.metadata.create_all()` handles them on startup. Only new columns on existing tables need entries.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full diagram and detailed breakdown. High-level:

- **Single Docker container**: FastAPI serves both the REST/WebSocket API and the React SPA as static files from `static/`.
- **23 backend routers** in `backend/routers/` — REST + 17 WebSocket streams.
- **SQLite** at `/data/apt-ui.db` (Docker volume). Async SQLAlchemy throughout the API; sync SQLAlchemy in the CLI only.
- **APScheduler** (`AsyncIOScheduler`) for cron-based checks, auto-upgrades, log purge, and daily summary. Reconfigured live from the DB without restart.
- **asyncssh**: fresh connection per command, no pool. `known_hosts=None` (trusted LAN). Auth priority: per-server encrypted key → SSH agent → global `SSH_PRIVATE_KEY`.
- **Per-server SSH keys**: Fernet-encrypted in DB (`backend/crypto.py`). Key derived from `ENCRYPTION_KEY` env var, falling back to `JWT_SECRET`.
- **Auth**: HS256 JWT in httpOnly cookie `apt_ui_token` (24h). All `/api/*` except `/api/auth/login` and `/health` require `get_current_user` dependency. WebSocket auth via `get_current_user_ws`; closes with code 1008 on failure.
- **Frontend path alias**: `@/` → `frontend/src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- **State**: Zustand stores in `frontend/src/hooks/useAuth.ts` (auth) and `frontend/src/hooks/useJobStore.ts` (background job bell).
- **TypeScript types**: `frontend/src/types/index.ts` — all interfaces matching backend Pydantic schemas live here.

### Key non-obvious decisions

- `upgrade_manager.py` uses an in-memory `dict[int, asyncio.Lock]` (`_upgrade_locks`) to prevent concurrent upgrades on the same server. Resets on container restart — intentional.
- `run_command_stream` in `ssh_manager.py` merges stderr into stdout (`stderr=asyncssh.STDOUT`) for clean terminal-style output.
- Log output is capped at 1 MB per upgrade session before DB storage; the WebSocket stream is unbounded.
- Server groups are many-to-many via `server_group_memberships` junction table. The legacy `servers.group_id` FK is kept for backward compat.
- `PackageInstallModal` and `RebootButton` are rendered via `createPortal` to avoid click-event bubbling from server cards.
- Proxmox VE detection uses `pveversion` (not `/etc/pve/pve-release`, which doesn't exist on modern PVE).
- Dashboard sort order persists to `localStorage` key `dashboard:sortBy`. Theme persists to `localStorage` key `apt:theme`.
- 401 responses anywhere in `api/client.ts` redirect to `/login?expired=1`.
- `reachability_ttl_minutes` in `schedule_config`: servers that fail to connect during check-all are skipped for subsequent runs until the TTL expires, preventing SSH timeouts from slowing the whole fleet.
- API token hashing uses `hashlib.scrypt` with a fixed salt (`b"apt-ui-api-token"`) for deterministic, memory-hard hashing. SHA-256 / HMAC-SHA256 are rejected by CodeQL as "insufficient" for credential storage.
- The iCal feed at `/api/calendar.ics` authenticates via a `?token=` query parameter, not the cookie or `Authorization` header — calendar clients (Apple Calendar, Google Calendar, Thunderbird) can't carry custom headers when subscribing. Reuses the existing API token system.
- EOL data lives in `backend/eol_data.py` as a hardcoded `{os_id: {version_id: ISO-date}}` table — no external API. Proxmox VE / Backup Server / Mail Gateway are tracked as separate keys (`proxmox-ve` / `proxmox-pbs` / `proxmox-pmg`) because they share the `-pve` kernel suffix but have distinct version cycles. The os_info detection in `backend/update_checker.py` probes `proxmox-backup-manager` and `pmgversion` before the kernel-fallback branch so PBS/PMG hosts are correctly labeled.
- Rolling reboot orchestration (`/api/ws/reboot-all`, `backend/routers/upgrades.py:ws_reboot_all`) reuses the same ring-grouping pattern as the auto-upgrade staged rollout (`backend/scheduler.py:_job_auto_upgrade`). Servers are grouped by their `ring:*` tag (alphabetical, `ring:default` for untagged). The ring helper is inlined in both spots — keep them in sync if the grouping logic changes.
- Slack notifications use an incoming-webhook URL (not a bot token); single channel pinned by the webhook URL itself. Block Kit messages built in `_send_slack` mirror `_send_telegram` shape so adding Mattermost/Discord later can share the abstraction.
- The release workflow (`.github/workflows/release.yml`) tags GHCR images using `type=ref,event=tag`, **not** `type=semver`. The date-based version scheme (`YYYY.MM.DD-NN`) is not strict SemVer, so `type=semver` rules silently produce no tags. The workflow also has a `workflow_dispatch` input so any existing git tag can be rebuilt manually (`gh workflow run release.yml -f tag=2026.05.01-02`).
- `check_server` runs `apt-get dist-upgrade --dry-run` in parallel alongside `apt list --upgradable`. This is necessary because new dependency packages (e.g. a new kernel version pulled in when upgrading `linux-generic`) do not appear in `apt list --upgradable` at all — they are only visible via dist-upgrade. The dry-run also detects "kept back" packages (upgradable but blocked by plain `apt-get upgrade`). Results stored as `is_new`, `is_kernel`, and `needs_dist_upgrade` flags in `packages_json`.

### Router → file mapping

| Concern | File |
|---|---|
| Auth + TOTP + API tokens | `backend/routers/auth.py` |
| Server CRUD + SSH test + reboot + hold/unhold | `backend/routers/servers.py` |
| Groups | `backend/routers/groups.py` |
| Tags | `backend/routers/tags.py` |
| Update checks | `backend/routers/updates.py` |
| Upgrade WebSockets (17 streams, incl. pveupgrade + autoremove-all + reboot-all) | `backend/routers/upgrades.py` |
| Fleet stats + history | `backend/routers/stats.py` |
| Schedule config | `backend/routers/scheduler.py` |
| Notification config + test + history log | `backend/routers/notifications.py` |
| JSON/CSV import-export | `backend/routers/config_io.py` |
| Package templates | `backend/routers/templates.py` |
| apt-cacher-ng monitoring | `backend/routers/aptcache.py` |
| Tailscale status (Unix socket) | `backend/routers/tailscale.py` |
| dpkg log history | `backend/routers/dpkg_log.py` |
| Apt source file management | `backend/routers/apt_repos.py` |
| Maintenance windows (CRUD) | `backend/routers/maintenance.py` |
| Pre/post-upgrade hooks (CRUD) | `backend/routers/hooks.py` |
| Prometheus /metrics endpoint | `backend/routers/metrics.py` |
| Public /status.json endpoint | `backend/routers/status_page.py` |
| GitHub release check (6h cache) | `backend/routers/release_check.py` |
| Upgrade activity reports + CSV | `backend/routers/reports.py` |
| iCal feed for maintenance windows | `backend/routers/calendar.py` |
| Fleet-wide CVE inventory aggregation | `backend/routers/security.py` |

### Frontend pages

| Page | File |
|---|---|
| Dashboard | `frontend/src/pages/Dashboard.tsx` |
| Server detail (Packages / Upgrade / Health / Apt Repos / dpkg Log / History / Stats / Shell) | `frontend/src/pages/ServerDetail.tsx` |
| Fleet-wide history (Upgrade History / Notification History / SSH Audit Log sub-tabs) | `frontend/src/pages/History.tsx` |
| Fleet-wide CVE inventory (CVE → servers / Server → CVEs views) | `frontend/src/pages/Security.tsx` |
| Settings (Schedule / Hooks / Maintenance / Notifications / Users / Servers / Account) | `frontend/src/pages/Settings.tsx` |
| Package templates | `frontend/src/pages/Templates.tsx` |
| Multi-server package comparison | `frontend/src/pages/Compare.tsx` |
| Login (+ 2FA code input) | `frontend/src/pages/Login.tsx` |
| Fleet-wide package search | `frontend/src/pages/Search.tsx` |
| Upgrade activity reports | `frontend/src/pages/Reports.tsx` |

---

## Known Issues / Planned Work

See [TODO.md](TODO.md) for the backlog.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SSH_PRIVATE_KEY` | Yes* | PEM-encoded SSH private key (full content, not a path). Required unless `SSH_AUTH_SOCK` is set. |
| `SSH_AUTH_SOCK` | No | SSH agent socket — alternative to `SSH_PRIVATE_KEY`. |
| `ENCRYPTION_KEY` | No | Master key for Fernet-encrypting per-server SSH keys. Falls back to `JWT_SECRET`. |
| `JWT_SECRET` | No | JWT signing secret. Random secret generated at startup if unset (tokens invalidate on restart). |
| `DATABASE_PATH` | No | Default: `/data/apt-ui.db` |
| `TZ` | No | Timezone for scheduled jobs. Default: `America/Montreal` |
| `ENABLE_TERMINAL` | No | Set `true` to enable the interactive SSH shell tab. Default: `false`. Only enable for trusted users. |
| `METRICS_TOKEN` | No | Optional bearer token to protect the `/metrics` endpoint. If unset, the endpoint is unauthenticated. |
| `STATUS_PAGE_PUBLIC` | No | Set `true` to enable the unauthenticated `/status.json` fleet health endpoint. Default: `false`. |
| `STATUS_PAGE_SHOW_NAMES` | No | Include server names (not hostnames) in `/status.json`. Default: `false`. |
| `STATUS_PAGE_TITLE` | No | Custom title for `/status.json`. Default: `apt-ui Fleet Status`. |

Notification settings, schedule config, and user accounts are managed entirely through the UI and stored in the DB — not environment variables.
