# apt-ui

A lightweight, self-hosted alternative to AWX / Ansible Tower focused on `apt` package management across a fleet of Ubuntu / Debian / Raspbian servers. Runs as a single Docker container.

![Main Gui](images/main.png)

> **This project was entirely written by [Claude](https://claude.ai) (Anthropic's AI assistant) via [Claude Code](https://claude.ai/code).** All code, configuration, and documentation — from the FastAPI backend and asyncssh integration to the React frontend and Docker setup — was generated through an iterative, conversation-driven development process with no manual coding.

📐 [Architecture](ARCHITECTURE.md) · 🔒 [Security Policy](SECURITY.md) · 📋 [Changelog](CHANGELOG.md)

---

## Features

### Dashboard & Fleet View
- **Fleet overview** — server card grid with update counts, security update highlights (shown in red), reboot-required and held-package badges, staleness indicators, and hardware stats at a glance; cards show colour-coded group/tag labels (capped at 4) and a plain-text actionable status strip (proxy, docker host, reboot required, eeprom update, auto-security disabled, held/removable package counts)
- **Fleet summary bar** — counts for updates, security issues, reboots required, autoremove candidates, and unprotected hosts; clickable filters narrow the card grid instantly; clicking the Updates or Security count opens a fleet-wide pending updates modal
- **Fleet-wide pending updates modal** — lists every pending package across all servers grouped by server; security packages first (🔒) with version deltas; phased-update badges; fetched on demand
- **Check All / Refresh All** — Check All runs `apt-get update` then reports upgrades; Refresh All reads the existing local apt cache without hitting upstream repositories (faster); hover tooltips explain the difference
- **Server groups & tags** — colour-coded groups (servers can belong to multiple); freeform tags with auto-tagging by OS and virtualisation type
- **Sorting & search** — sort by name, update count, security count, or status; full-text search including tags; default sort persisted in `localStorage`
- **Server reachability monitoring** — lightweight TCP ping runs every 5 minutes (independent of SSH checks); offline servers show a red banner and dimmed card; Offline counter appears in the fleet summary bar
- **Docker host detection** — detects when a managed server is the Docker host running the dashboard; shows a badge and blocks upgrades of container-runtime packages (Docker, containerd, Podman, runc, LXD, etc.) to prevent killing the container mid-upgrade
- **Dark/light theme** — toggle in the top nav; preference persisted in `localStorage`
- **Version in footer** — running app version displayed in the page footer; baked in at Docker build time from the release tag
- **GitHub link in nav** — quick link to the repository from the top navigation bar

### Package Management
- **Upgradable packages** — full list with version deltas, repository source, security flag, and dedicated phased-update column; hover tooltips show package description and reboot likelihood
- **Selective upgrades** — choose individual packages to upgrade rather than upgrading everything
- **New dependency detection** — during every check, `apt-get dist-upgrade --dry-run` runs in parallel to detect packages that will be installed as new dependencies (e.g. a new kernel version triggered by upgrading `linux-generic`); these appear in a dedicated "New Packages" section with an amber banner directing to the dist-upgrade action; packages kept back by plain upgrade are flagged with a "kept back" badge
- **Upgrade dry-run** — preview exactly what `apt-get upgrade` would change before committing
- **Live upgrade terminal** — stream `apt-get upgrade` output in real time via WebSocket; carriage-return progress lines update in place
- **Package install** — search the `apt` cache and install new packages on any host directly from the UI
- **.deb installation** — install a `.deb` file by URL (validated then `wget`'d on the remote) or by uploading from your browser (SFTP'd via asyncssh); both paths stream `dpkg -i` + `apt-get install -f` output live
- **Multi-server package comparison** — Compare page lets you select any combination of servers and compare their full installed package inventories side-by-side; filter to diverged/common/all packages; amber-tinted rows highlight version differences
- **Templates** — define named package sets and apply them to one or more hosts at once; useful for provisioning identical server roles

### Apt Source Management
- **Apt repo editor** — "Apt Repos" tab reads all apt source files (`/etc/apt/sources.list` and `sources.list.d/*.{list,sources}`) on demand; per-file tabbed editor with unsaved-changes indicator; save, delete, and create new files; "Test with apt-get update" streams live output to validate changes

### History & Audit
- **Upgrade history** — per-server and fleet-wide log of every upgrade run; filterable by server and status; full terminal output expandable per run
- **Notification history** — every outbound notification (email, Telegram, webhook) is logged and visible in History → Notification History; shows channel, event type, summary, and success/failure
- **dpkg log** — "dpkg Log" tab parses `/var/log/dpkg.log` and all rotated archives (including `.gz`) on demand; filterable by package name, action type, and time window; colour-coded install / upgrade / remove / purge badges

### Server Detail
- **OS & virt detection** — detects Proxmox VE, Armbian, Ubuntu, Debian, Raspbian; detects bare-metal / VM / LXC / Docker via `systemd-detect-virt`
- **Proxmox VE awareness** — PVE servers get a dedicated **Run pveupgrade** button in the Upgrade tab that runs `pveupgrade --force` (the safe PVE upgrade path); PVE-managed packages are highlighted with a 🔶 icon in the Packages tab
- **Auto security updates** — per-server toggle for `unattended-upgrades`; state shown as a shield badge (green = enabled, amber = disabled/not installed); streams live SSH output when toggling
- **apt proxy management** — detects and displays the configured apt HTTP proxy per server; toggle panel lets you set a manual proxy URL (writes to `/etc/apt/apt.conf.d/01proxy`) or install `auto-apt-proxy` for zero-config DNS SRV discovery; disable removes the config and/or uninstalls the package; live SSH output streamed in the UI
- **Raspberry Pi EEPROM firmware** — detects firmware update availability for Pi 4 / Pi 400 / CM4 / Pi 5; apply with one click (stages update for next reboot)
- **Server notes** — free-text notes field visible in the server detail header
- **Interactive shell** — optional SSH terminal tab (disabled by default; enable via `ENABLE_TERMINAL=true`)
- **Always show Reboot button** — optional preference (Settings → Preferences → Display) to show the Reboot button at all times, not only when a reboot is flagged as required

### Server Management
- **Add Server modal** — Add Server form opens as a scrollable portal modal; works on mobile
- **SSH key generation** — generate a dedicated Ed25519 key pair for a server directly from the Add Server form; private key is auto-populated and the public key is displayed with a one-click Copy button
- **Per-server SSH key** — highlighted section with 🔑 icon makes it easy to spot when adding a server
- **Bulk delete servers** — multi-select checkboxes in Settings → Servers with a floating bulk-action bar for deleting multiple servers at once; header checkbox with indeterminate state for select-all

### Automation & Scheduling
- **Scheduled checks** — configurable cron schedule for automatic fleet-wide update checks
- **Auto-upgrade** — optional hands-off mode to apply updates on a schedule (disabled by default)
- **Background job indicator** — bell icon in the top nav tracks running and recently completed jobs; click to return to a running job

### Notifications
- **Channels** — email (SMTP), Telegram (Bot API), and outbound webhooks (HMAC-SHA256 signed)
- **Events** — upgrade complete, upgrade error, security updates found, reboot required, daily summary
- **Per-channel per-trigger toggles** — independently enable each event on each channel; daily summary includes reboot and EEPROM firmware status

### Infrastructure
- **apt-cacher-ng monitoring** — add local apt cache servers; compact cards in the fleet summary bar show hit rate, hits/misses, and data served; clicking a card opens a full detail modal with charts and log analysis
- **Tailscale integration** — optional sidecar joins the container to your tailnet; supports `tailscale serve` for automatic HTTPS; connection status visible in Settings → Infrastructure

---

## Requirements

- Docker + Docker Compose v2
- SSH access to target servers — see [SSH authentication](#ssh-authentication) below

---

## SSH authentication

Two approaches are supported. Pick whichever fits your setup.

### Option A — SSH directly as root (simplest)

If you set a root password during OS installation the root account is active and you can add your public key to it:

```bash
# Run on each managed server
sudo mkdir -p /root/.ssh
sudo cat ~/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
sudo chmod 600 /root/.ssh/authorized_keys
```

Then set `username = root` when adding each server in the dashboard. No sudo configuration required.

### Option B — Regular user with passwordless sudo for apt-get

```bash
# Run on each managed server
echo "youruser ALL=(ALL) NOPASSWD: /usr/bin/apt-get" | sudo tee /etc/sudoers.d/apt-ui
```

### SSH key options

**Option 1 — Inline key (simpler, key must have no passphrase)**

Set `SSH_PRIVATE_KEY` in your `.env` to the full PEM content of the key.

**Option 2 — SSH agent (key can be passphrase-protected)**

Forward your host SSH agent into the container instead of embedding the key:

1. Ensure your agent is running and has the key loaded (`ssh-add ~/.ssh/id_ed25519`)
2. In the compose file, comment out `SSH_PRIVATE_KEY` and uncomment the `SSH_AUTH_SOCK` lines
3. The container will authenticate via the agent — the private key never leaves your host

---

## Quick Start

### 1. Set up your `.env`

Create `.env` with your SSH private key. The key must be inside double quotes with literal newlines:

```
SSH_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEo...your key content...
-----END RSA PRIVATE KEY-----"

# Optional — fixes JWT secret so sessions survive restarts
# JWT_SECRET=change-me-to-a-long-random-string

# Optional overrides
# TZ=America/Montreal
# LOG_LEVEL=INFO
```

To populate it from a key file:

```bash
echo "SSH_PRIVATE_KEY=\"$(cat ~/.ssh/id_rsa)\"" > .env
```

### 2a. Run from pre-built image (recommended)

Images are published to the GitHub Container Registry on every release for both `linux/amd64` and `linux/arm64`.

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

To pin to a specific release instead of `latest`, edit `docker-compose.ghcr.yml` and change the image tag, e.g. `ghcr.io/mzac/apt-ui:1.0.0`.

### 2b. Build from source

```bash
./build-run.sh
```

The app will be available at **http://localhost:8111**.

Default login: `admin` / `admin` — **change this immediately** via Settings → Account.

---

## Configuration

All runtime configuration (SMTP, Telegram, schedules, server list) is managed through the web UI and stored in the SQLite database at `/data/apt-ui.db`. No restart required to change settings.

| Variable | Default | Description |
|---|---|---|
| `SSH_PRIVATE_KEY` | — | Full PEM content of the private key. Required unless using SSH agent. |
| `SSH_AUTH_SOCK` | — | Path to SSH agent socket inside the container (e.g. `/run/ssh-agent.sock`). Alternative to `SSH_PRIVATE_KEY` — allows passphrase-protected keys. See compose file for socket mount. |
| `JWT_SECRET` | random | JWT signing secret. Set to persist sessions across restarts |
| `ENCRYPTION_KEY` | — | Master key used to encrypt per-server SSH keys stored in the database. Falls back to `JWT_SECRET` if not set. Set explicitly to decouple the two secrets. |
| `DATABASE_PATH` | `/data/apt-ui.db` | SQLite file path |
| `TZ` | `America/Montreal` | Timezone for scheduled jobs |
| `LOG_LEVEL` | `INFO` | Python log level |
| `ENABLE_TERMINAL` | `false` | Set to `true` to enable the interactive SSH shell terminal in the UI. Only enable if you trust all dashboard users. |

---

## CLI Tool

Admin operations can be run from inside the container:

```bash
# Reset password (interactive prompt)
docker compose exec apt-ui python -m backend.cli reset-password

# Reset password inline
docker compose exec apt-ui python -m backend.cli reset-password --username admin --password newpass123

# Create a new user
docker compose exec apt-ui python -m backend.cli create-user --username zac --password mypass

# List all users
docker compose exec apt-ui python -m backend.cli list-users
```

---

## Tailscale

The dashboard can join your [Tailscale](https://tailscale.com) tailnet via an optional sidecar container. This gives you:

- Secure remote access without exposing a port to the internet
- Automatic HTTPS with a Let's Encrypt certificate via `tailscale serve`
- Connection status (tailnet IP, hostname, DNS name) visible in Settings → Infrastructure
- Works great in Kubernetes — the sidecar joins the pod to the tailnet

### Enable Tailscale (Docker Compose)

Add to your `.env`:

```
TS_AUTHKEY=tskey-client-...   # generate at tailscale.com/settings/keys
TS_HOSTNAME=apt-ui            # how it appears on your tailnet
```

Then run with the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
```

**How updates work:** Tailscale is NOT baked into the app image. It runs as a separate `tailscale/tailscale:latest` container. Running `docker compose pull` updates it independently of the app — no rebuild needed.

### Enable tailscale serve (HTTPS on your tailnet)

`tailscale serve` proxies HTTPS `:443` → app `:8000` and provisions a Let's Encrypt cert automatically for your node's DNS name (e.g. `apt-ui.your-tailnet.ts.net`).

In `docker-compose.tailscale.yml`, uncomment these two lines under the `tailscale` service:

```yaml
- TS_SERVE_CONFIG=/serve-config.json
- ./tailscale-serve.json:/serve-config.json:ro
```

The bundled `tailscale-serve.json` uses `${TS_CERT_DOMAIN}` which the Tailscale container resolves to your node's DNS name at runtime. No manual hostname configuration needed.

### Kubernetes sidecar

The manifest at [`k8s/deployment.yaml`](k8s/deployment.yaml) contains a ready-to-uncomment Tailscale sidecar block. In Kubernetes all containers in a pod share the same network namespace, so no `network_mode` tricks are needed — just uncomment the sidecar container and the associated volumes.

```bash
# Add the auth key to your existing secret
kubectl create secret generic apt-ui-secrets \
  --from-literal=ssh-private-key="$(cat ~/.ssh/id_rsa)" \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --from-literal=ts-authkey="tskey-client-..."
```

---

## Kubernetes (k3s)

A ready-to-use manifest is provided at [`k8s/deployment.yaml`](k8s/deployment.yaml). It includes:

- Deployment (1 replica)
- ClusterIP Service on port 8000
- PersistentVolumeClaim (Longhorn storage class — change if needed)
- Secret references for `SSH_PRIVATE_KEY` and `JWT_SECRET`
- Liveness + readiness probes against `GET /health`
- Resource limits: 128–256Mi RAM, 100m–500m CPU

```bash
# Create the secret first
kubectl create secret generic apt-ui-secrets \
  --from-literal=ssh-private-key="$(cat ~/.ssh/id_rsa)" \
  --from-literal=jwt-secret="$(openssl rand -hex 32)"

# Deploy
kubectl apply -f k8s/deployment.yaml
```

---

## Development

### Backend

```bash
export PYTHONPATH=/root/apt-ui
export SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"
export DATABASE_PATH="./data/dev.db"

python -m venv venv && source venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev   # Vite dev server on :5173, proxies /api/* to :8000
```

---

## Architecture

```mermaid
graph TB
    subgraph browser["Browser"]
        SPA["React 18 SPA  —  Vite · TypeScript · Tailwind\n7 pages · 6 components · Zustand state"]
    end

    subgraph container["Docker Container  (:8000)"]
        direction TB
        API["FastAPI  —  14 routers · 50+ REST endpoints · 17 WebSocket streams\n/api/*  (JWT cookie auth)     /health  (liveness probe)     /*  (SPA static)"]
        BG["APScheduler  ·  Update Checker  ·  Upgrade Manager  ·  Notifier\ncron jobs · per-server asyncio.Lock · Email · Telegram · Webhook · Notification Log"]
        DB[("SQLite  /data/apt-ui.db\n14 tables · 40 migrations")]
        SSH["asyncssh  —  fresh connection per command\nKey priority: per-server → agent → global SSH_PRIVATE_KEY"]
    end

    subgraph servers["Managed Servers  (SSH :22)"]
        S["Ubuntu · Debian · Raspbian · Armbian · Proxmox VE · Raspberry Pi"]
    end

    subgraph notif["Notifications  (optional)"]
        N["SMTP Email  ·  Telegram Bot API  ·  Outbound Webhook"]
    end

    SPA -- "REST + WebSocket" --> API
    API --> DB
    API --> SSH
    BG --> DB
    BG --> SSH
    BG --> N
    SSH --> S
```

> See [ARCHITECTURE.md](ARCHITECTURE.md) for full diagrams, request flow details, data model, and CI/CD pipeline documentation.

---

## Tech Stack

| Layer | Library / Tool |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn |
| Auth | passlib[bcrypt], PyJWT — httpOnly cookie (HS256, 24 h) |
| SSH | asyncssh — fresh connection per command, no host-key verification |
| Encryption | Fernet (AES-128-CBC + HMAC-SHA256) — per-server SSH keys in DB |
| Database | SQLite, SQLAlchemy async + aiosqlite |
| Scheduler | APScheduler 3.x AsyncIOScheduler — live reconfiguration, no restart needed |
| Notifications | aiosmtplib (email), httpx (Telegram Bot API), httpx (webhook + HMAC-SHA256) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| State | Zustand |
| Charts | Recharts |
| Terminal | ansi-to-html (apt output), @xterm/xterm (interactive shell) |
| Container | Multi-stage Dockerfile — node:20-alpine build → python:3.12-slim runtime |
| Registry | GitHub Container Registry (ghcr.io) — linux/amd64 + linux/arm64 |
| CI/CD | GitHub Actions — CodeQL scanning, Dependabot, multi-arch release pipeline |
