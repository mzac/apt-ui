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

# Run backend dev server (requires SSH key)
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
npm ci             # package-lock.json is committed; use npm ci for reproducible installs
npm run dev        # Vite dev server on :5173, proxies /api/* to :8000
npm run build      # tsc + vite build → dist/
```

### Docker
```bash
./build-run.sh                    # build + start + tail logs
docker compose up --build -d      # detached
docker compose logs -f            # follow logs
docker exec -it apt-dashboard python -m backend.cli reset-password
```

### Docker with Tailscale (production overlay)
```bash
# Requires TS_AUTHKEY (and optionally TS_HOSTNAME) in .env
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up --build -d
```

### Local dev with Tailscale (git-ignored)
```bash
# Requires TS_AUTHKEY in .env.local — see .env.local for full template
./build-run-local.sh   # builds app + starts tailscale sidecar, follows logs
```

### No test framework is configured. Testing is manual (see Testing Notes section below).

---

## Database Migrations

**This project does not use Alembic.** Schema changes are handled via a hand-maintained migrations list in `backend/database.py` inside `init_db()`. SQLite's `ALTER TABLE ADD COLUMN` is used; errors are silently swallowed so the same list is safe against both fresh and existing databases.

**Every time you add a column to a model in `backend/models.py` you must also add a corresponding `ALTER TABLE` statement to the `migrations` list in `backend/database.py`.** Failing to do this will cause `OperationalError: no such column` at runtime against any existing database that was created before the column was added.

Pattern:
```python
# In backend/database.py — migrations list inside init_db()
"ALTER TABLE <table> ADD COLUMN <column> <TYPE> DEFAULT <value>",
```

Examples from the codebase:
```python
"ALTER TABLE servers ADD COLUMN ssh_private_key_enc TEXT",
"ALTER TABLE schedule_config ADD COLUMN conffile_action TEXT DEFAULT 'confdef_confold'",
"ALTER TABLE server_stats ADD COLUMN auto_security_updates TEXT",
"ALTER TABLE schedule_config ADD COLUMN run_apt_update_before_upgrade BOOLEAN DEFAULT 0",
"ALTER TABLE server_stats ADD COLUMN eeprom_update_available TEXT",
"ALTER TABLE server_stats ADD COLUMN eeprom_current_version TEXT",
"ALTER TABLE server_stats ADD COLUMN eeprom_latest_version TEXT",
```

Nullable columns with no default use just the type (e.g. `TEXT`, `INTEGER`) with no `DEFAULT` clause — SQLite will fill existing rows with `NULL`.

---

## Architecture Overview

The app is a **single Docker container**: FastAPI serves both the REST/WebSocket API and the React SPA as static files.

**Key data flows:**
- Dashboard polling: frontend calls `GET /api/servers` every 30s via `usePolling` hook
- Live upgrade output: WebSocket at `/api/ws/upgrade/{id}` or `/api/ws/upgrade-all`; backend streams SSH stdout/stderr line-by-line over the socket
- Auth: JWT stored in httpOnly cookie named `apt_dashboard_token`; all `/api/` routes except login use `get_current_user` FastAPI dependency; 401 responses in `api/client.ts` redirect to `/login?expired=1`
- SSH: no connection pool — fresh connection per command; key loaded from `SSH_PRIVATE_KEY` env var via `asyncssh.import_private_key()`; `known_hosts=None` (trusted network)
- Scheduling: APScheduler `AsyncIOScheduler` with `CronTrigger`; config stored in `schedule_config` DB table and dynamically reconfigured (no restart needed) when changed via UI

**Per-server SSH keys:**
- `backend/crypto.py` — Fernet symmetric encryption (AES-128-CBC + HMAC). Key derived via SHA-256 from `ENCRYPTION_KEY` env var, falling back to `JWT_SECRET`. `encrypt()`/`decrypt()` helpers used by the servers router.
- `Server.ssh_private_key_enc` — encrypted PEM stored in DB; `ssh_key_configured: bool` in `ServerOut` (never returns the key itself).
- Auth priority in `ssh_manager._connect_options`: per-server key → SSH agent → global `SSH_PRIVATE_KEY`.
- UI: write-only textarea in add-server form (collapsible) and inline edit row; shows 🔑 badge when key is set; separate Set/Replace/Clear actions.

**Implemented beyond original spec:**
- `backend/routers/tags.py` — server tagging with auto-tag on check (OS + virt type)
- `backend/routers/templates.py` — package templates for bulk install
- `backend/routers/config_io.py` — JSON import/export of server config
- `backend/routers/aptcache.py` — apt-cacher-ng monitoring; fetches `/acng-report.html?output=plain`, parses hit/miss counts, traffic bytes, cache size; `GET /api/aptcache/stats/all` fetches all enabled servers in parallel
- `backend/upgrade_manager.py` — upgrade execution separated from `update_checker.py`
- `frontend/pages/Templates.tsx` — UI for template management
- `frontend/components/PackageInstallModal.tsx` — package installation modal (rendered via `createPortal` to avoid click-event bubbling from server cards)
- `schedule_config` has `auto_tag_os`, `auto_tag_virt`, `run_apt_update_before_upgrade`, `conffile_action`, `reachability_ttl_minutes` fields
- `reachability_ttl_minutes` — when a server fails to connect during check-all, it is skipped for subsequent check-all runs until the TTL expires, preventing SSH timeout delays from slowing the whole fleet check
- `AptCacheServer` model / `apt_cache_servers` table — new table, created automatically by `Base.metadata.create_all()` on startup (no ALTER TABLE migration needed for new tables, only for new columns on existing tables)
- Package descriptions stored in `packages_json` — `_parse_apt_cache_show()` in `update_checker.py` runs `apt-cache show --no-all-versions` for all upgradable packages during each check and stores short descriptions
- `likelyRequiresReboot()` in `ServerDetail.tsx` — client-side heuristic matching package names against patterns (linux-image*, libc6, libssl*, systemd, udev, etc.)
- Server groups are many-to-many via `server_group_memberships` junction table; legacy `servers.group_id` FK kept for backward compat
- `virt_type` stored in `server_stats`; OS detection uses `pveversion` (not `/etc/pve/pve-release`) for Proxmox VE detection since that file doesn't exist on modern PVE
- `.github/workflows/release.yml` — publishes multi-arch Docker image (`linux/amd64`, `linux/arm64`) to `ghcr.io/mzac/apt-ui` on GitHub release
- Per-server auto security updates: `server_stats.auto_security_updates` stores `not_installed`/`disabled`/`enabled`; detected during check via `unattended-upgrades` package state; enable/disable via WebSocket (`/api/ws/auto-security-updates/{id}`) which streams SSH output to an inline terminal in the server edit form; shield badge on dashboard cards (green=enabled, amber=disabled/not_installed); `sec_disabled` filter in fleet summary bar counts and filters servers without auto-sec
- **Raspberry Pi EEPROM firmware updates**: detected during check for Pi 4 / Pi 400 / Compute Module 4 / Pi 5 only (model gated via `/proc/device-tree/model`); `server_stats.eeprom_update_available` stores `up_to_date`/`update_available`/`update_staged`/`frozen`/`error`; `eeprom_current_version` and `eeprom_latest_version` are Unix timestamp strings from `rpi-eeprom-update` output; apply via WebSocket `/api/ws/eeprom-update/{id}` which runs `sudo rpi-eeprom-update -a` (stages update for next reboot); amber badge on dashboard cards when update available, blue badge when staged; EEPROM section in server edit form shows version dates and Apply Update button; Pi 3 explicitly excluded (command exists but doesn't work)
- apt-cacher-ng compact cards in fleet summary bar (right of Autoremove widget) showing hit rate %, mini hit bar, hits/misses counts, and data served; wider cards (~140px min)
- Server card two-column layout: left=identity (name, hostname, OS), right=group badges + update count + hardware stats; security update count shown large/bold in red when present (takes priority over total update count)
- Background job bell: all jobs (check-all, upgrade-all, single-host check, single-host upgrade) show in bell while running and auto-remove 3 s after completing; no persistent amber dot; page reload clears all stale jobs
- Terminal `\r` (carriage return) handling: `applyChunk()` helper in `ServerDetail.tsx` applies carriage-return semantics so apt progress lines (e.g. "Reading database ... 5% ... 100%") update in place instead of concatenating
- `autoremove_count` / `autoremove_packages` on `update_checks` — detected during check via `apt-get autoremove --dry-run`; shown in dashboard and server detail
- `frontend/pages/History.tsx` — fleet-wide upgrade history view; server dropdown + status dropdown filters pass `server_id`/`status` query params to `GET /api/history`; resets to page 1 on filter change
- Per-channel notification toggles in `notification_config` — individual email/Telegram toggles for each event type (daily summary, upgrade complete, error), allowing e.g. email-only for summaries and Telegram-only for errors
- **Outbound webhooks**: `notification_config.webhook_enabled`/`webhook_url`/`webhook_secret`; `_send_webhook()` in `notifier.py` POSTs JSON with optional HMAC-SHA256 `X-Hub-Signature-256` header; events: `daily_summary`, `upgrade_complete`, `upgrade_failed`, `upgrade_all_complete`; UI in Settings → Notifications
- **Dark/light theme toggle**: CSS custom properties in `index.css` (`:root` dark, `html.light` light); Tailwind colors reference `var(--color-*)` via `tailwind.config.js`; `useTheme` hook in `frontend/src/hooks/useTheme.ts` persists to `localStorage` key `apt:theme`; toggle button (☀/☾) in `Layout.tsx` header
- **Dashboard staleness indicator**: `isStale(iso, hours)` helper in `Dashboard.tsx`; server card timestamp turns amber with ⚠ when last check > 12 h old, deeper amber > 24 h
- **Fleet summary EEPROM counter**: `eepromCount` widget in fleet summary bar (only shown when > 0); clicking it filters cards to `eeprom_update_available === 'update_available'`
- **Server notes**: `servers.notes TEXT` column; displayed in server detail header when set; editable in the edit form textarea; passed through `ServerCreate`/`ServerUpdate`/`ServerOut`
- **Upgrade dry-run preview**: `/api/ws/dry-run/{server_id}` WebSocket endpoint in `backend/routers/upgrades.py`; runs `apt-get upgrade/dist-upgrade --dry-run`; collapsible output panel above the live terminal in `UpgradePanel` (ServerDetail.tsx); `createDryRunWebSocket()` helper in `api/client.ts`
- **`last_apt_update` in server detail**: already collected in `ServerStats`; now returned in `ServerOut` via `_build_server_out()`; shown in the stats bar in `ServerDetail.tsx`
- **Dashboard tag search fix**: search filter checks `(s.tags ?? []).some(t => t.name.toLowerCase().includes(search))` — was previously case-sensitive and ignored tags with spaces
- **Cron validation in ScheduleTab**: `describeCron()` helper parses 5-field cron into human-readable text (e.g. "Daily at 06:00"); `CronInput` component shows green preview when valid, red error when invalid; used for check cron and auto-upgrade cron fields
- **Reboot confirmation modal**: `RebootButton` in `Dashboard.tsx` uses `createPortal` modal overlay with backdrop blur and warning text instead of inline confirm buttons; also used in `ServerDetail.tsx`
- **Tailscale sidecar** — opt-in via compose overlay; NOT embedded in the app image (updates independently via `docker compose pull`):
  - `docker-compose.tailscale.yml` — production overlay; adds `tailscale/tailscale:latest` sidecar; app uses `network_mode: service:tailscale` to share the tailnet interface
  - `docker-compose.local.yml` + `build-run-local.sh` — git-ignored local dev equivalents; uses separate `tailscale-state-local` / `tailscale-socket-local` volumes to avoid conflicting with production
  - `tailscale-serve.json` — `TS_SERVE_CONFIG` template; proxies HTTPS `:443` → app `:8000`; uses `${TS_CERT_DOMAIN}` placeholder resolved at runtime to the node's tailnet DNS name
  - `backend/routers/tailscale.py` — `GET /api/tailscale/status`; connects to the daemon via httpx `AsyncHTTPTransport(uds=...)` against `/var/run/tailscale/tailscaled.sock` (shared named volume); returns available/backend_state/IPs/hostname/dns_name/online
  - Socket volume must NOT be mounted `:ro` — connecting to a Unix socket requires write permission even for read-only queries
  - `TS_SOCKET=/var/run/tailscale/tailscaled.sock` must be set on the tailscale container — without it, tailscaled creates the socket at `/tmp/tailscaled.sock` and only drops a symlink in `/var/run/tailscale/`; the symlink target doesn't exist in the app container, so the API calls fail silently
  - Status widget in Settings → Infrastructure tab polls every 30 s; shows inline enable command when sidecar is absent
  - `k8s/deployment.yaml` has a ready-to-uncomment sidecar block (k8s pods share network namespace natively, no `network_mode` needed)

**Frontend path alias:** `@/` resolves to `frontend/src/` (configured in both `vite.config.ts` and `tsconfig.json`).

**State management:** Zustand stores in `frontend/src/hooks/useAuth.ts` (auth state) and `frontend/src/hooks/useJobStore.ts` (background job tracking for the bell icon). Both are read by multiple components.

**Background job bell:** `Layout.tsx` reads `useJobStore` and renders a bell icon in the top nav. Jobs are registered via `addJob()` from Dashboard (`handleCheckAll`, `handleCheck`), `UpgradeAllModal` (`start()`), and `UpgradePanel` in ServerDetail. Jobs auto-remove 3 s after completion; no amber dot (unseenCount always 0).

**Dashboard sort persistence:** `sortBy` state is initialised from `sessionStorage` (`dashboard:sortBy`) so the chosen sort order survives navigation within the session.

**Terminal rendering:** `@xterm/xterm` is used for the terminal panel in ServerDetail (not just `ansi-to-html`).

**Settings tabs:** Servers, Schedule, Preferences (concurrency / log retention / auto-upgrade / auto-tagging), Notifications, Infrastructure (apt-cacher-ng), Account, Backup.

---

# Apt Update Dashboard — Project Specification

## Project Overview

Build a lightweight, self-hosted alternative to AWX / Ansible Tower focused specifically on apt package management across a fleet of ~20 Ubuntu/Debian/Raspbian servers. The goal is to replicate the "check and update servers" workflow of AWX without the complexity of a full Tower deployment.

The app connects to servers over SSH, checks for available apt updates, displays a dashboard for viewing and managing updates, runs scheduled checks at configurable times, and sends daily summary notifications via email and Telegram. It runs as a single Docker container suitable for deployment on Docker or k3s.

The app includes built-in authentication with bcrypt-hashed passwords stored in SQLite. A CLI tool is provided to reset the admin password from inside the container.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12+, FastAPI, Uvicorn |
| Auth | passlib[bcrypt] (password hashing), PyJWT (JSON Web Tokens) |
| SSH | asyncssh (async SSH library) |
| Database | SQLite via SQLAlchemy (async with aiosqlite) |
| Scheduler | APScheduler (AsyncIOScheduler) |
| WebSocket | FastAPI native WebSocket support |
| Notifications | aiosmtplib (async SMTP email), httpx (Telegram Bot API) |
| Frontend | React 18+ with TypeScript, Vite, Tailwind CSS |
| Container | Single multi-stage Dockerfile (Node build → Python runtime) |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Docker Container                            │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │  FastAPI     │◄──►│  React SPA          │  │
│  │  (backend)   │    │  (served as static) │  │
│  │  :8000       │    │                     │  │
│  └──────┬───────┘    └─────────────────────┘  │
│         │                                     │
│    ┌────┴────┐   ┌──────────┐                 │
│    │asyncssh │   │ SQLite   │ ← mounted vol   │
│    │sessions │   │ /data/   │                 │
│    └────┬────┘   └──────────┘                 │
│         │                                     │
└─────────┼─────────────────────────────────────┘
          │ SSH (key from env var)
          ▼
   ┌──────────────┐
   │ Remote hosts │
   │ (apt servers)│
   └──────────────┘
```

---

## Directory Structure

```
apt-dashboard/
├── CLAUDE.md              ← this file
├── Dockerfile
├── docker-compose.yml
├── backend/
│   ├── main.py            ← FastAPI app entry point, mounts routes + static
│   ├── requirements.txt
│   ├── config.py          ← settings (env vars, paths)
│   ├── database.py        ← SQLAlchemy engine, session, Base
│   ├── models.py          ← ORM models (Server, UpdateCheck, UpdateHistory, etc.)
│   ├── schemas.py         ← Pydantic schemas for API request/response
│   ├── auth.py            ← JWT token creation/validation, password hashing, auth dependencies
│   ├── cli.py             ← CLI tool for admin password reset (python -m backend.cli)
│   ├── ssh_manager.py     ← async SSH connection pool & command execution
│   ├── update_checker.py  ← logic to parse apt output, check for updates
│   ├── scheduler.py       ← APScheduler setup for periodic checks
│   ├── notifier.py        ← email + Telegram notification logic
│   └── routers/
│       ├── auth.py        ← login/logout/me/change-password endpoints
│       ├── servers.py     ← CRUD endpoints for server management
│       ├── groups.py      ← CRUD endpoints for server groups
│       ├── updates.py     ← check/upgrade endpoints + WebSocket
│       ├── stats.py       ← dashboard stats & history endpoints
│       └── notifications.py ← notification config + test endpoints
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/           ← API client functions (fetch + WebSocket helpers)
│       ├── components/    ← reusable UI components
│       ├── pages/         ← Dashboard, ServerDetail, Settings
│       ├── hooks/         ← custom React hooks (useWebSocket, usePolling, etc.)
│       └── types/         ← TypeScript interfaces matching backend schemas
└── data/                  ← gitignored, SQLite DB lives here at runtime
    └── .gitkeep
```

---

## Database Schema (SQLite)

### `users` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | auto-increment |
| username | TEXT NOT NULL UNIQUE | login username |
| password_hash | TEXT NOT NULL | bcrypt hash via passlib |
| is_admin | BOOLEAN DEFAULT true | reserved for future role expansion |
| created_at | DATETIME | |
| last_login | DATETIME | updated on each successful login |

On first startup, if the `users` table is empty, create a default admin account:
- Username: `admin`
- Password: `admin`
- Log a prominent warning to stdout: `⚠️  Default admin account created. Login with admin/admin and change the password immediately.`

### `server_groups` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | auto-increment |
| name | TEXT NOT NULL UNIQUE | e.g. "homelab", "proxmox", "k3s workers", "pis" |
| color | TEXT | hex color for UI badge (e.g. "#3b82f6") |
| sort_order | INTEGER DEFAULT 0 | for display ordering |

### `servers` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | auto-increment |
| name | TEXT NOT NULL | display name / label |
| hostname | TEXT NOT NULL UNIQUE | IP or FQDN |
| username | TEXT NOT NULL | SSH login user |
| ssh_port | INTEGER DEFAULT 22 | configurable per server |
| group_id | FK → server_groups | nullable, for grouping/filtering |
| os_info | TEXT | populated on first connect (lsb_release) |
| is_enabled | BOOLEAN DEFAULT true | soft-disable without deleting |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### `update_checks` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| server_id | FK → servers | |
| checked_at | DATETIME | |
| status | TEXT | success / error |
| error_message | TEXT | null if success |
| packages_available | INTEGER | count of upgradable packages |
| security_packages | INTEGER | count of updates from -security repos |
| regular_packages | INTEGER | count of updates from non-security repos |
| held_packages | INTEGER | count of packages held via apt-mark |
| held_packages_list | TEXT | JSON list of held package names |
| reboot_required | BOOLEAN | from /var/run/reboot-required |
| autoremove_count | INTEGER DEFAULT 0 | count of packages removable via apt autoremove |
| autoremove_packages | TEXT | JSON list of autoremovable package names |
| raw_output | TEXT | full `apt list --upgradable` output |
| packages_json | TEXT | JSON array of parsed packages with details (see below) |

The `packages_json` field stores a JSON array where each entry is:
```json
{
  "name": "libssl3",
  "current_version": "3.0.2-0ubuntu1.12",
  "available_version": "3.0.2-0ubuntu1.14",
  "repository": "jammy-security",
  "is_security": true,
  "is_phased": false,
  "description": "Secure Sockets Layer toolkit - shared libraries"
}
```
This avoids re-parsing the raw apt output every time the frontend requests the package list.

### `update_history` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| server_id | FK → servers | |
| started_at | DATETIME | |
| completed_at | DATETIME | |
| status | TEXT | running / success / error |
| action | TEXT | "upgrade" or "dist-upgrade" |
| phased_updates | BOOLEAN | whether --allow-phased-updates was used |
| packages_upgraded | TEXT | JSON list of package names + versions |
| log_output | TEXT | full terminal output captured |
| initiated_by | TEXT | "manual" or "scheduled" |

### `server_stats` table
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| server_id | FK → servers | |
| recorded_at | DATETIME | |
| uptime_seconds | INTEGER | from /proc/uptime |
| kernel_version | TEXT | uname -r |
| disk_usage_percent | FLOAT | root partition usage |
| last_apt_update | DATETIME | stat /var/cache/apt/pkgcache.bin |
| total_packages | INTEGER | dpkg --list count |
| virt_type | TEXT | detected virtualization type (kvm, lxc, docker, proxmox, etc.) |
| auto_security_updates | TEXT | `not_installed` / `disabled` / `enabled` — unattended-upgrades state |
| eeprom_update_available | TEXT | `up_to_date` / `update_available` / `update_staged` / `frozen` / `error` — Pi 4/400/CM4/5 only; null on non-Pi |
| eeprom_current_version | TEXT | Unix timestamp string from rpi-eeprom-update output |
| eeprom_latest_version | TEXT | Unix timestamp string from rpi-eeprom-update output |

### `notification_config` table (single row, app-wide settings)
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | always 1 |
| email_enabled | BOOLEAN DEFAULT false | |
| smtp_host | TEXT | e.g. smtp.gmail.com |
| smtp_port | INTEGER DEFAULT 587 | |
| smtp_use_tls | BOOLEAN DEFAULT true | |
| smtp_username | TEXT | |
| smtp_password | TEXT | stored as-is (app is behind auth, DB on private volume) |
| email_from | TEXT | sender address |
| email_to | TEXT | comma-separated recipient addresses |
| telegram_enabled | BOOLEAN DEFAULT false | |
| telegram_bot_token | TEXT | from @BotFather |
| telegram_chat_id | TEXT | target chat/group ID |
| daily_summary_enabled | BOOLEAN DEFAULT true | master toggle for the daily summary |
| daily_summary_time | TEXT DEFAULT '07:00' | 24h format, local time (server timezone) |
| notify_on_upgrade_complete | BOOLEAN DEFAULT true | send notification after each upgrade |
| notify_on_error | BOOLEAN DEFAULT true | send notification on check/upgrade failures |
| daily_summary_email | BOOLEAN DEFAULT true | send daily summary via email |
| daily_summary_telegram | BOOLEAN DEFAULT true | send daily summary via Telegram |
| notify_upgrade_email | BOOLEAN DEFAULT true | send upgrade notifications via email |
| notify_upgrade_telegram | BOOLEAN DEFAULT true | send upgrade notifications via Telegram |
| notify_error_email | BOOLEAN DEFAULT true | send error notifications via email |
| notify_error_telegram | BOOLEAN DEFAULT true | send error notifications via Telegram |

### `schedule_config` table (single row, scheduling settings)
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | always 1 |
| check_enabled | BOOLEAN DEFAULT true | enable/disable scheduled checks |
| check_cron | TEXT DEFAULT '0 6 * * *' | cron expression for when to run checks |
| auto_upgrade_enabled | BOOLEAN DEFAULT false | optionally auto-upgrade after check |
| auto_upgrade_cron | TEXT | cron expression for auto-upgrade (if enabled) |
| allow_phased_on_auto | BOOLEAN DEFAULT false | include phased updates in auto-upgrades |
| upgrade_concurrency | INTEGER DEFAULT 5 | max simultaneous server upgrades |
| log_retention_days | INTEGER DEFAULT 90 | auto-purge check/history records older than this (0 = keep forever) |
| auto_tag_os | BOOLEAN DEFAULT false | auto-create and assign OS tags on Check All |
| auto_tag_virt | BOOLEAN DEFAULT false | auto-create and assign virt-type tags on Check All |
| run_apt_update_before_upgrade | BOOLEAN DEFAULT false | run `apt-get update -q` before upgrading (disabled by default to avoid pulling in unreviewed updates) |
| conffile_action | TEXT DEFAULT 'confdef_confold' | how apt handles modified config files during upgrade: `confdef_confold` (keep old), `confold` (always old), `confnew` (always new) |
| reachability_ttl_minutes | INTEGER DEFAULT 5 | skip recently-unreachable servers in check-all for this many minutes to avoid SSH timeout delays |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SSH_PRIVATE_KEY` | Yes* | PEM-encoded SSH private key (the full key content, not a path). Required unless `SSH_AUTH_SOCK` is set. |
| `SSH_AUTH_SOCK` | No | Path to SSH agent socket — alternative to `SSH_PRIVATE_KEY`. One of the two must be set. |
| `ENCRYPTION_KEY` | No | Master key for Fernet-encrypting per-server SSH keys stored in the DB. Falls back to `JWT_SECRET` if not set. |
| `JWT_SECRET` | No | Secret key for signing JWT tokens. If not set, a random secret is generated at startup (tokens will invalidate on restart — fine for single-container deployments). |
| `DATABASE_PATH` | No | Default: `/data/apt-dashboard.db` |
| `LOG_LEVEL` | No | Default: `INFO` |
| `TZ` | No | Timezone for scheduled jobs. Default: `America/Montreal` |
| `ENABLE_TERMINAL` | No | Set to `true` to enable the interactive SSH shell terminal tab in the UI. Default: `false`. Only enable if all dashboard users are trusted. |

Note: Notification settings (SMTP, Telegram), schedule configuration, and user accounts are managed entirely through the GUI and stored in the database, not in environment variables. This keeps the container config simple and lets you change settings without redeploying.

---

## Backend Implementation Details

### Authentication (`auth.py`)

Simple session-based auth using JWT tokens stored in an httpOnly cookie.

- **Password hashing:** Use `passlib` with bcrypt. Hash on registration/password change, verify on login.
- **JWT tokens:** Issue a signed JWT on successful login. Store it in an httpOnly, Secure (if behind HTTPS), SameSite=Lax cookie named `apt_dashboard_token`. Token payload: `{"sub": username, "exp": expiry}`. Default expiry: 24 hours.
- **Auth dependency:** Create a FastAPI dependency `get_current_user` that extracts and validates the JWT from the cookie. All `/api/` routes except `/api/auth/login` must use this dependency. Return 401 if the token is missing, expired, or invalid.
- **Login endpoint:** `POST /api/auth/login` — accepts `{"username": "...", "password": "..."}`, returns the user info and sets the cookie. Return 401 with a generic "Invalid credentials" message on failure (don't reveal whether the username or password was wrong).
- **Logout endpoint:** `POST /api/auth/logout` — clears the cookie.
- **Current user:** `GET /api/auth/me` — returns the logged-in user's info (username, last_login). Used by the frontend to check if the session is still valid.
- **Change password:** `PUT /api/auth/password` — accepts `{"current_password": "...", "new_password": "..."}`. Requires the current password to change it.
- **WebSocket auth:** For WebSocket connections, the browser automatically sends cookies, so the JWT cookie is available. Validate it on the WebSocket handshake. Close with 1008 (Policy Violation) if invalid.
- **No signup endpoint.** New users are created only via the CLI tool or potentially a future admin panel. For now this is a single-user app.

### CLI Tool (`cli.py`)

A command-line utility for admin operations, primarily password reset. Invoked from inside the container:

```bash
# Reset admin password (interactive prompt)
docker exec -it apt-dashboard python -m backend.cli reset-password

# Reset with password inline (for scripting)
docker exec -it apt-dashboard python -m backend.cli reset-password --username admin --password newpass123

# Create a new user
docker exec -it apt-dashboard python -m backend.cli create-user --username zac --password mypass

# List users
docker exec -it apt-dashboard python -m backend.cli list-users
```

Use Python's `argparse` or `click` for the CLI. The tool directly accesses the SQLite database using the same `DATABASE_PATH` config as the app (synchronous access is fine for a CLI tool — use plain SQLAlchemy without async).

When `reset-password` is called without `--password`, it should prompt interactively with masked input (using `getpass`).

### SSH Manager (`ssh_manager.py`)

- Load the SSH private key from `SSH_PRIVATE_KEY` env var at startup. Write it to a temporary in-memory key object using `asyncssh.import_private_key()`. The key has no passphrase.
- Create an async function `run_command(server, command, timeout=60)` that opens an SSH connection to the server, executes the command, and returns stdout/stderr/exit_code.
- Create an async function `run_command_stream(server, command, websocket)` that streams stdout/stderr line by line over a WebSocket connection in real time.
- Use `known_hosts=None` for SSH (we trust the key, and host key verification would be impractical across a fleet — the app is on a trusted network). Document this tradeoff in a code comment.
- Handle connection failures gracefully — timeout after 15 seconds, return a clear error status.
- Do NOT maintain a persistent connection pool. Open a fresh connection per command execution. These are short-lived operations on a small fleet.

### Update Checker (`update_checker.py`)

- **Check for updates:** Run `apt update` (quiet) then `apt list --upgradable 2>/dev/null` on the remote server. Parse the output to extract package name, current version, available version, and repository.
- **Classify security vs regular updates:** Parse the repository field from `apt list --upgradable` output. Packages from repositories containing `-security` (e.g., `jammy-security`, `bookworm/updates`) are security updates. All others are regular updates. Store both counts and a per-package `is_security` flag in the `packages_json` field.
- **Parse phased updates:** Phased updates show in the apt output. Parse and flag them in the response so the UI can distinguish them.
- **Detect held packages:** Run `apt-mark showhold` to get the list of packages held back from upgrading. Store the count and list. These should be displayed separately in the UI as "intentionally held" — not treated as errors.
- **Check reboot required:** Check if `/var/run/reboot-required` exists on the remote. Also read `/var/run/reboot-required.pkgs` if present for the list of packages requiring reboot.
- **Gather server stats:** In parallel with the update check, gather uptime, kernel version, disk usage (df -h /), total installed package count, and distro info (lsb_release -ds or cat /etc/os-release).
- **Concurrency:** When checking all servers, use `asyncio.Semaphore` to limit concurrent SSH connections to the `upgrade_concurrency` value from schedule_config (default 5). This applies to both checks and upgrades.

### Upgrade Execution

- **Two upgrade modes** available in the UI:
  - **upgrade** (default): `sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y` — safe, never removes packages.
  - **dist-upgrade**: `sudo DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y` — handles changed dependencies, may install or remove packages. Needed for some kernel updates. Show a clear warning in the UI when this option is selected ("dist-upgrade may remove or install packages to resolve dependencies").
- Use `apt-get` not `apt` for scripting reliability.
- When phased updates is toggled on, append the phased updates option (specifically: `-o APT::Get::Always-Include-Phased-Updates=true`).
- Running `apt-get update -q` before upgrade is **opt-in** via the `run_apt_update_before_upgrade` preference (default: false). When disabled, the upgrade only installs packages already known from the last "Check", avoiding surprise updates. When enabled, it fetches the latest package index first.
- The SSH user must have passwordless sudo configured on the remote servers (document this as a prerequisite).
- A single SSH key (no passphrase) is used for all servers. Only the username varies per server.
- Stream the full output over WebSocket in real time.
- On completion, re-run the update check to refresh the dashboard state.
- Log the complete session (command, full output, timestamps, exit code) to the `update_history` table.
- After a completed upgrade (success or failure), trigger notifications if `notify_on_upgrade_complete` or `notify_on_error` is enabled.
- **Concurrency:** When upgrading multiple servers ("upgrade all"), use `asyncio.Semaphore` with the `upgrade_concurrency` value (default 5) to limit how many servers are upgrading simultaneously. This prevents overwhelming the network or having too many servers potentially rebooting at once.

### Scheduler (`scheduler.py`)

Use APScheduler's `AsyncIOScheduler` with `CronTrigger` (not interval-based). All schedule configuration lives in the `schedule_config` DB table and is editable from the UI.

- **Scheduled update checks:** Run `check all servers` on a cron schedule (default: `0 6 * * *` = 6:00 AM daily). Uses the `TZ` environment variable for timezone (defaults to `America/Montreal`).
- **Optional auto-upgrade:** If enabled, run `upgrade all` on a separate cron schedule after the check completes. This is off by default — it's a safety net for people who want fully hands-off operation, but most users will want to review before upgrading.
- **Daily summary notification:** Triggered after each scheduled check completes. Sends the summary via all enabled notification channels (email and/or Telegram).
- **Dynamic reconfiguration:** When the user changes schedule settings in the UI, the backend should remove the old APScheduler jobs and re-add them with the new cron expressions. No restart required.
- On app startup, load schedule_config from DB (create default row if table is empty) and register the APScheduler jobs accordingly.
- **Log retention purge:** Run daily (e.g., at 3:00 AM) to delete `update_checks`, `update_history`, and `server_stats` records older than `log_retention_days`. If set to 0, skip purging. Log how many records were purged.

### Notification System (`notifier.py`)

A unified notification module that sends messages through configured channels. Both email and Telegram are optional — either, both, or neither can be enabled.

#### Daily Summary Content

The daily summary (sent after each scheduled check) should include:

**Subject/title:** `Apt Dashboard — Daily Summary — {date}`

**Body (structured for both email HTML and Telegram markdown):**
- Fleet overview: X servers checked, Y up to date, Z with updates available, W with errors
- **Servers with updates available** (grouped list):
  - Server name (hostname) — N updates available (M security, P regular)
    - Security updates listed first, marked with a 🔒 or `[SECURITY]` tag
    - List each package: `package_name: current_version → available_version`
    - Flag phased updates with a marker like `[phased]`
  - Repeat for each server with pending updates
- **Servers with held packages** (list with held package names — informational)
- **Servers needing reboot** (list)
- **Servers with errors** (list with error message)
- **Servers up to date** (just the names, collapsed/brief)
- Timestamp of check completion

Keep the email formatted as clean HTML (not fancy — think plain styled HTML that renders well in any mail client, including mobile). Use a simple table layout for the package lists. Include the server name prominently.

For Telegram, use Markdown formatting. If the message exceeds Telegram's 4096 char limit, split it into multiple messages or truncate the package details and add "See dashboard for full details."

#### Email Implementation
- Use `aiosmtplib` for async SMTP.
- Support STARTTLS (port 587) and SSL (port 465).
- Send as HTML email with a plain-text fallback.
- SMTP settings come from the `notification_config` DB table.
- Handle SMTP errors gracefully — log the error, don't crash the scheduler.

#### Telegram Implementation
- Use `httpx` (async HTTP client, already a FastAPI dependency) to call the Telegram Bot API directly. No need for a Telegram library.
- Endpoint: `https://api.telegram.org/bot{token}/sendMessage`
- Send with `parse_mode: "Markdown"` for formatting.
- Bot token and chat_id come from the `notification_config` DB table.
- To get the chat_id, document in the Settings UI that the user needs to: (1) create a bot via @BotFather, (2) send a message to the bot, (3) use the `getUpdates` API or a helper to find the chat_id. Optionally, add a "Detect Chat ID" button in the UI that calls `getUpdates` and shows the result.

#### Event-Driven Notifications (beyond daily summary)
- **Upgrade complete:** Send a brief notification: "Upgrade completed on {server}: {N} packages upgraded successfully" or "Upgrade FAILED on {server}: {error}". Controlled by `notify_on_upgrade_complete` toggle.
- **Error notifications:** Send when a scheduled check fails to reach a server. Controlled by `notify_on_error` toggle. Debounce these — don't spam if a server is down for multiple consecutive checks. Only notify on the first failure and again when it recovers.

### API Endpoints

All endpoints except auth and health require a valid JWT cookie.

#### Authentication
- `POST /api/auth/login` — accepts `{"username": "...", "password": "..."}`, sets httpOnly JWT cookie, returns user info
- `POST /api/auth/logout` — clears the JWT cookie
- `GET /api/auth/me` — returns current user info (username, last_login). Returns 401 if not authenticated.
- `PUT /api/auth/password` — change password: `{"current_password": "...", "new_password": "..."}`

#### Server Management
- `GET /api/servers` — list all servers with latest check status. Optional query params: `?group_id=X`, `?status=updates_available`
- `POST /api/servers` — add a server (validate SSH connectivity immediately)
- `PUT /api/servers/{id}` — update server config
- `DELETE /api/servers/{id}` — remove server (cascade delete history)
- `POST /api/servers/{id}/test` — test SSH connectivity, return success/error

#### Server Groups
- `GET /api/groups` — list all groups with server count
- `POST /api/groups` — create a group (name, color)
- `PUT /api/groups/{id}` — update group
- `DELETE /api/groups/{id}` — delete group (unassigns servers, does not delete them)

#### Update Operations
- `POST /api/servers/{id}/check` — trigger update check on one server
- `POST /api/servers/check-all` — trigger update check on all enabled servers (concurrent, respects concurrency limit)
- `POST /api/servers/{id}/upgrade` — start upgrade on one server. Body: `{"action": "upgrade"|"dist-upgrade", "allow_phased": false}`. Returns immediately, work happens async.
- `POST /api/servers/upgrade-all` — start upgrade on all servers with available updates. Same body options. Respects concurrency limit.
- `GET /api/servers/{id}/packages` — get detailed package list from last check (parsed JSON with security/phased flags)
- `WebSocket /api/ws/upgrade/{id}` — live stream of upgrade output for a specific server

#### Stats & History
- `GET /api/servers/{id}/history` — paginated upgrade history for a server
- `GET /api/stats/overview` — fleet-wide stats (total servers, total pending updates, security update count, servers needing reboot, held packages count, last check time)

#### Scheduler
- `GET /api/scheduler/status` — current schedule config, next run times for check and auto-upgrade
- `PUT /api/scheduler/config` — update schedule_config (cron expressions, enable/disable, auto-upgrade settings, concurrency cap, log retention)

#### Notifications
- `GET /api/notifications/config` — get current notification settings (mask smtp_password in response)
- `PUT /api/notifications/config` — update notification settings
- `POST /api/notifications/test/email` — send a test email with sample summary
- `POST /api/notifications/test/telegram` — send a test Telegram message

#### System
- `GET /health` — simple health check returning `{"status": "ok", "version": "...", "db_ok": true}`. Use for k3s liveness/readiness probes.

### WebSocket Protocol

The WebSocket at `/api/ws/upgrade/{server_id}` should send JSON messages:

```json
{"type": "status", "data": "connecting"}
{"type": "status", "data": "running_update"}
{"type": "output", "data": "Reading package lists...\n"}
{"type": "output", "data": "Building dependency tree...\n"}
{"type": "status", "data": "running_upgrade"}
{"type": "output", "data": "The following packages will be upgraded:\n"}
{"type": "output", "data": "  libssl3 openssl\n"}
{"type": "complete", "data": {"success": true, "packages_upgraded": 2}}
{"type": "error", "data": "Connection timed out"}
```

For "upgrade all", use `/api/ws/upgrade-all` — multiplexes output from all servers:
```json
{"type": "output", "server_id": 3, "server_name": "pi-node1", "data": "..."}
{"type": "complete", "server_id": 3, "server_name": "pi-node1", "data": {...}}
```

---

## Frontend Implementation Details

### Design Direction

Use an **industrial/utilitarian** aesthetic — this is a sysadmin tool, not a marketing dashboard. Think terminal-inspired but modern.

- **Color scheme:** Dark theme as default. Use a dark charcoal/near-black background (#0f1117 or similar) with muted grays for surfaces. Use a single strong accent color (green #22c55e or cyan #06b6d4) for "healthy" / "up to date" states. Use amber/yellow for "updates available" and red for errors/failures. Keep it high-contrast and scannable.
- **Typography:** Use a monospace font (JetBrains Mono or IBM Plex Mono via Google Fonts) for server names, package lists, and terminal output. Use a clean sans-serif (IBM Plex Sans or similar) for headings and labels. Font choices should feel like they belong in a NOC or ops center.
- **Layout:** Dense, information-rich. No gratuitous whitespace. The dashboard should feel like a control panel — multiple servers visible at a glance in a card grid. Every pixel should convey useful information.
- **Terminal output panel:** The live upgrade output should render in a component that looks and feels like a real terminal. Dark background, monospace font, auto-scrolling, with ANSI color support if feasible (e.g. using ansi-to-html library or similar).
- **Animations:** Minimal and purposeful. A subtle pulse or spinner on "checking" status. A smooth transition when update counts change. No flashy page transitions — speed and clarity over flair.
- **Status indicators:** Use small colored dots/badges (green/amber/red) next to each server name. Make the status immediately obvious from across the room.

### Pages

#### Login page (`/login`)
- Clean, centered login form matching the dark industrial aesthetic. Username and password fields, "Sign In" button.
- On success, redirect to the dashboard. On failure, show an inline error message ("Invalid credentials").
- If the user is already authenticated (valid cookie), redirect to dashboard immediately.
- After login, if this is the default `admin`/`admin` account and the password hasn't been changed, show a prominent banner on the dashboard: "You're using the default password. Change it in Settings."

#### Dashboard (main page, `/`)
- **Fleet summary bar** at top: total servers, servers up to date (green count), servers with updates (amber count, with separate security update count highlighted), servers with errors (red count), servers needing reboot (icon + count), servers with held packages (info count), last fleet-wide check timestamp, next scheduled check.
- **Group filter tabs/chips** below the summary bar: "All" plus one tab per server group. Clicking a group filters the card grid to only show servers in that group. If no groups exist, this row is hidden.
- **Server card grid** below: Each server gets a card showing:
  - Server display name + hostname
  - Group badge (colored chip matching the group color)
  - OS badge (Ubuntu 22.04, Debian 12, Raspbian, etc.)
  - Status dot (green = up to date, amber = updates available, red = error/unreachable, blue = checking/upgrading, gray = disabled)
  - Number of available updates (large, prominent number if > 0), with a smaller secondary count for security updates (e.g., "12 updates · 3 security")
  - Held packages indicator (small info badge, e.g., "2 held")
  - Reboot required indicator (small icon/badge)
  - Quick stats: uptime, disk usage %, kernel version
  - Last checked timestamp (relative, like "12 min ago")
  - Action buttons: "Check" and "Upgrade" (upgrade only shown when updates > 0)
- **Bulk actions toolbar**: "Check All", "Upgrade All" buttons (operate on filtered group if a group filter is active). "Upgrade All" should show a confirmation dialog listing which servers will be upgraded and how many packages, with a toggle for "Use dist-upgrade" and "Allow phased updates".
- Cards should be sortable/filterable: by name, by group, by update count, by security update count, by status. A search/filter bar is useful.

#### Server Detail page (`/servers/{id}`)
- Full server info (editable inline or via modal)
- **Packages tab:** Table listing every upgradable package: name, current version, available version, repository, security flag (highlighted row or badge), phased update flag. Sortable columns. Security updates should visually stand out (e.g., row highlight or a shield icon). A separate section or collapsed panel below for "Held Packages" showing packages held by apt-mark with their currently installed version.
- **Terminal tab:** Live output panel for upgrades. Shows the current or most recent upgrade session. Looks like a terminal emulator.
- **History tab:** Table of past upgrade runs with timestamps, package counts, upgrade type (upgrade vs dist-upgrade), status, and expandable rows to view full log output.
- **Stats tab:** Charts/graphs showing update trends over time (e.g., pending updates per check over last 30 days, security vs regular breakdown). Keep it simple — a line chart using Recharts is fine.
- Prominent "Upgrade" button with: a dropdown or toggle to select "upgrade" vs "dist-upgrade", and a checkbox for "Allow phased updates".

#### Settings page (`/settings`)

Organized into tabs or sections:

- **Servers tab:**
  - **Server groups:** Manage groups (add, rename, recolor, reorder, delete). Drag-and-drop reordering is nice-to-have. Each group has a name and a color.
  - **Server management table:** Add, edit, remove servers. Each row: name, hostname, username, SSH port, group (dropdown), enabled toggle, test connection button, delete button. Filterable by group.
  - Add server form: name, hostname, username, port (default 22), group (dropdown, optional). On submit, test SSH connectivity and report success/error before saving.
  - Import/export server list (JSON, including group assignments) — useful for backup/migration.

- **Schedule tab:**
  - **Update check schedule:** Enable/disable toggle. Cron expression input with a human-readable preview (e.g., "Every day at 6:00 AM"). Provide quick presets: "Daily at 6 AM", "Every 6 hours", "Every 12 hours", "Weekly Monday 6 AM". Show next scheduled run time.
  - **Auto-upgrade schedule:** Enable/disable toggle (off by default, with a warning that this will upgrade packages automatically). Separate cron expression. Toggle for "Allow phased updates during auto-upgrade."
  - **Concurrency limit:** Number input for max simultaneous upgrades (default 5). Applies to both manual "Upgrade All" and auto-upgrades.
  - **Log retention:** Number input for days to keep check/upgrade history (default 90, 0 = keep forever). Shows approximate current DB size.
  - Display the container's timezone (from `TZ` env var) so the user knows what "6:00 AM" means.

- **Notifications tab:**
  - **Email configuration:** Enable/disable toggle. SMTP host, port, TLS toggle, username, password (masked input), from address, to addresses (comma-separated). "Send Test Email" button that sends a sample daily summary.
  - **Telegram configuration:** Enable/disable toggle. Bot token input (masked), chat ID input. Brief inline instructions for creating a bot via @BotFather and finding the chat ID. "Detect Chat ID" button that calls the bot's `getUpdates` endpoint and displays found chats. "Send Test Message" button.
  - **Notification triggers:** Toggles for: daily summary after scheduled check, notification on upgrade complete, notification on server errors. All on by default.
  - Show a preview of what the daily summary looks like (render a sample based on current server data).

- **Account tab:**
  - Change password form: current password, new password, confirm new password. Validate that new passwords match before submitting.
  - Display username and last login timestamp.
  - Logout button (also accessible from the top nav bar at all times).

### State Management

Use React context or Zustand (lightweight state library) for global state:
- Auth state (current user, logged-in status)
- Server list with latest status
- Active upgrade sessions (which servers are currently upgrading)
- WebSocket connection state

All routes except `/login` should be wrapped in a route guard that checks auth state. If the `/api/auth/me` call returns 401, redirect to `/login`. On any 401 response from the API during normal use (expired token), redirect to `/login` with a flash message "Session expired, please log in again."

Poll `GET /api/servers` every 30 seconds to keep the dashboard fresh (or use a lightweight SSE/WebSocket for push updates on status changes — implementer's choice, polling is simpler and fine for a small fleet).

### API Client

Create a typed API client in `frontend/src/api/client.ts` using fetch. Include:
- Generic request wrapper with error handling
- Typed functions matching each backend endpoint
- WebSocket helper that returns a managed connection with reconnect logic

---

## Dockerfile

Use a multi-stage build:

1. **Stage 1 — Frontend build:**
   - `node:20-alpine`
   - Copy `frontend/package.json`, run `npm install && npm run build`
   - Uses `npm ci` because `package-lock.json` is committed in `frontend/`.
   - Output goes to `/app/frontend/dist/`

2. **Stage 2 — Python runtime:**
   - `python:3.12-slim`
   - Install system deps: `openssh-client` (not strictly required since we use asyncssh, but useful for debugging)
   - Copy `backend/`, install Python deps from `requirements.txt`
   - Copy built frontend from stage 1 into `static/` at `/app/static/`
   - FastAPI serves the React SPA as static files from `static/` with a catch-all route for client-side routing
   - `PYTHONPATH=/app` is set so `python -m backend.cli` works from any directory
   - Volume mount point: `/data/`
   - Expose port `8000`
   - CMD: `uvicorn backend.main:app --host 0.0.0.0 --port 8000`

### docker-compose.yml

```yaml
services:
  apt-dashboard:
    build: .
    ports:
      - "8111:8000"
    environment:
      - SSH_PRIVATE_KEY=${SSH_PRIVATE_KEY}
      - TZ=America/Montreal
    volumes:
      - apt-dashboard-data:/data
    restart: unless-stopped

volumes:
  apt-dashboard-data:
```

Also provide a sample k3s manifest (`k8s/deployment.yaml`) with:
- Deployment (1 replica)
- Service (ClusterIP on port 8000)
- PersistentVolumeClaim for `/data/` (use default storage class — Longhorn in Zac's case)
- Secret reference for SSH_PRIVATE_KEY
- Resource requests/limits (128Mi-256Mi RAM, 100m-500m CPU is probably fine)
- Liveness probe: `GET /health` every 30s
- Readiness probe: `GET /health` every 10s

---

## Error Handling & Edge Cases

- **SSH connection refused/timeout:** Mark server status as "error", store error message, show clearly in UI. Don't let one failing server block the fleet check.
- **sudo not available or requires password:** Detect "sudo: a password is required" in stderr. Show a clear error telling the user to configure passwordless sudo for that user.
- **apt lock:** Detect "Could not get lock /var/lib/dpkg/lock" errors. Show message that another package operation is running on that server.
- **Large output:** Cap stored log output at 1MB per upgrade session. The WebSocket stream can deliver unlimited output but DB storage should be bounded.
- **Concurrent upgrades:** Prevent running two upgrades simultaneously on the same server (backend should enforce this with an in-memory lock per server_id).
- **SSH key format:** Support both RSA and Ed25519 keys. The env var should contain the raw PEM content including the `-----BEGIN/END-----` lines.

---

## Development Workflow

### Prerequisites
- Python 3.12+
- Node.js 20+
- A test server you can SSH into (even localhost with an SSH key works)

### Quick start (Docker)

```bash
# 1. Copy your SSH private key into .env
echo "SSH_PRIVATE_KEY=\"$(cat ~/.ssh/id_rsa)\"" > .env

# 2. Build and start
./build-run.sh
# App available at http://localhost:8111
# Default login: admin / admin  (change immediately)
```

### Backend development
```bash
cd /root/apt-ui
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

export SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"
export DATABASE_PATH="./data/dev.db"
export PYTHONPATH=/root/apt-ui
uvicorn backend.main:app --reload --port 8000
```

### Frontend development
```bash
cd frontend
npm install
npm run dev   # Vite dev server on :5173, proxies /api/* to :8000
```

Vite is pre-configured in `vite.config.ts` to proxy `/api/` (including WebSockets) to `http://localhost:8000`.

---

## Build Order

Implement in this order to maintain a working app at each step:

1. **Database + models** — SQLAlchemy models, create tables on startup (including users with default admin account, notification_config, and schedule_config with default rows), Alembic not needed for now
2. **Authentication** — auth.py with bcrypt hashing, JWT token creation/validation, login/logout/me/change-password endpoints, FastAPI auth dependency. CLI tool (cli.py) for password reset and user management.
3. **SSH manager** — async SSH execution, key loading, basic connectivity test
4. **Server CRUD API** — add/edit/delete/list servers, test connection endpoint (all behind auth dependency)
5. **Server groups API** — CRUD for groups, assign servers to groups
6. **Update checker** — apt update + parse upgradable packages (security/regular/phased/held), store results
7. **Dashboard API** — fleet overview stats, server detail with packages
8. **Scheduler** — APScheduler with cron triggers, dynamic reconfiguration from DB config, log retention purge job
9. **Upgrade execution** — apt-get upgrade/dist-upgrade with WebSocket streaming, concurrency semaphore
10. **Notification system** — email (aiosmtplib) + Telegram (httpx) notifier, daily summary generation, event-driven notifications
11. **Notification API** — config CRUD, test endpoints for email and Telegram
12. **Health endpoint** — `GET /health` for k3s probes
13. **Frontend: shell + routing + auth** — React app with pages, navigation, dark theme, login page, auth context, route guards, 401 handling
14. **Frontend: settings page** — server management CRUD with groups, schedule config, notification config with test buttons, account/password tab
15. **Frontend: dashboard** — server cards with group filters, fleet summary, status indicators, security update counts, held packages
16. **Frontend: server detail** — packages table (security flagged, held section), upgrade button (upgrade/dist-upgrade), terminal output, history
17. **Frontend: upgrade all** — bulk operations with concurrency, multiplexed WebSocket output
18. **Dockerfile + compose** — containerize, test end to end, verify CLI works via docker exec
19. **k8s manifests** — deployment, service, PVC, secret, liveness/readiness probes

---

## Testing Notes

- On first startup, verify the default admin/admin account is created and the warning is logged.
- Test the CLI password reset: `docker exec -it apt-dashboard python -m backend.cli reset-password --username admin --password newpass`. Verify login works with the new password and fails with the old one.
- Test session expiry: set a short JWT expiry (e.g., 1 minute) temporarily and verify the frontend redirects to login with a "session expired" message.
- Test WebSocket auth: verify that unauthenticated WebSocket connections are rejected.
- Use at least one real server for integration testing during development. If no remote servers are available, test against localhost (install openssh-server locally).
- The SSH key in the env var must correspond to an authorized key on the remote servers.
- Test with a server that has phased updates held back to verify that flag works.
- Test the error path: try adding a server with a wrong hostname or port to ensure the UI handles it gracefully.
- Test email notifications with a real SMTP server. For development, you can use a service like Mailtrap or a local Mailhog container.
- Test Telegram notifications with a real bot. Create a test bot via @BotFather and a private chat/group for testing.
- Verify scheduled jobs fire correctly by temporarily setting a cron like `*/2 * * * *` (every 2 minutes) during development.
- Test the daily summary content by using the "Send Test" buttons in the notification settings — these should generate a real summary from current data.

---

## Implementation Notes (actual code decisions)

### Backend
- `PYTHONPATH=/app` is set in the Dockerfile and must also be set manually for local dev (`export PYTHONPATH=/root/apt-ui`). The uvicorn command is `uvicorn backend.main:app` (not `uvicorn main:app`).
- The scheduler's daily summary fires automatically after each `_job_check_all` run — no separate cron entry is needed.
- `upgrade_manager.py` uses an in-memory `dict[int, asyncio.Lock]` (`_upgrade_locks`) to prevent concurrent upgrades on the same server. This resets on container restart, which is acceptable.
- WebSocket upgrade endpoints (`/api/ws/upgrade/{id}` and `/api/ws/upgrade-all`) read the auth cookie directly from the WebSocket handshake headers — no token-in-URL needed since browsers send cookies automatically.
- `run_command_stream` in `ssh_manager.py` merges stderr into stdout (`stderr=asyncssh.STDOUT`) for a clean terminal-style output. This is intentional.
- Log output is capped at 1 MB per upgrade session before storing in the DB. The WebSocket stream is unbounded.
- `cli.py` uses `argparse` (not `click`). Sync SQLAlchemy is used in the CLI — no async needed.

### Frontend
- State management uses **Zustand** (not React Context) for auth state.
- `ansi-to-html` is used to render ANSI escape codes in the terminal output panels.
- The 401 redirect logic lives in `api/client.ts` — any `401` response triggers `window.location.href = '/login?expired=1'`.
- Dashboard polls `GET /api/servers` every 30 seconds via the `usePolling` hook.
- The "Upgrade All" modal uses the `/api/ws/upgrade-all` WebSocket and multiplexes output per server with `server_id`/`server_name` fields.

### `.env` file format
The SSH private key must be placed inside double quotes with literal newlines preserved:
```
SSH_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEo...
-----END RSA PRIVATE KEY-----"
```
Docker Compose v2 handles multiline quoted values in `.env` files natively.

---

## Non-Goals (Out of Scope)

- Multi-user RBAC (the app supports user accounts but no role-based permissions — all users are admins)
- Managing non-Debian-based servers (RHEL/dnf/yum)
- Automated unattended-upgrades configuration
- Ansible or configuration management features — this is view + update only