# apt-dashboard

A lightweight, self-hosted alternative to AWX / Ansible Tower focused on `apt` package management across a fleet of Ubuntu / Debian / Raspbian servers. Runs as a single Docker container.

![Main Gui](images/main.png)

> **This project was entirely written by [Claude](https://claude.ai) (Anthropic's AI assistant) via [Claude Code](https://claude.ai/code).** All code, configuration, and documentation — from the FastAPI backend and asyncssh integration to the React frontend and Docker setup — was generated through an iterative, conversation-driven development process with no manual coding.

📐 [Architecture](ARCHITECTURE.md) · 🔒 [Security Policy](SECURITY.md)

---

## Features

- **Fleet dashboard** — see all servers at a glance with update counts, security update highlights, reboot-required flags, and held packages; server cards use a two-column layout with security update count shown prominently in red when present
- **Live upgrade terminal** — stream `apt-get upgrade` output in real time via WebSocket; carriage-return progress lines (e.g. "Reading database…") update in place rather than concatenating
- **Package info tooltips** — hover over any upgradable package to see its description, version delta, and whether it likely requires a reboot (kernel, libc, openssl, systemd, etc.)
- **Selective upgrades** — choose individual packages to upgrade rather than upgrading everything
- **Package install** — search `apt` cache and install new packages on any host directly from the UI
- **Templates** — define named package sets and apply them to one or more hosts at once (useful for provisioning)
- **Scheduled checks** — configurable cron schedule for automatic update checks
- **Auto-upgrade** — optional hands-off mode to apply updates on a schedule (disabled by default)
- **Notifications** — daily summary + per-event alerts via email (SMTP), Telegram, and outbound webhooks (HMAC-SHA256 signed); triggers: upgrade complete, error, security updates found (after each check), reboot required (after each check); per-channel and per-trigger toggles; daily summary includes reboot and EEPROM firmware status
- **Server groups** — colour-coded grouping; servers can belong to multiple groups
- **Tags** — freeform colour-coded tags per server; auto-tagging by OS and machine type supported
- **OS & virt detection** — detects Proxmox VE (via `pveversion`), Armbian, Ubuntu, Debian, Raspbian; detects bare-metal / VM / container via `systemd-detect-virt`
- **Auto security updates** — per-server toggle to enable/disable `unattended-upgrades`; current state detected on every check and shown as a shield badge on each server card (green=on, amber=off/not installed); enable/disable streams live SSH output to an inline terminal in the server edit form; fleet summary bar includes a "Sec off" filter to quickly find unprotected hosts
- **Raspberry Pi EEPROM firmware** — detects EEPROM firmware update availability for Pi 4 / Pi 400 / CM4 / Pi 5 during every check; amber badge on dashboard cards when update available; apply with one click from the server edit form (streams live output, stages update for next reboot)
- **apt-cacher-ng monitoring** — add your local apt cache server(s) in Settings → Infrastructure; compact cards in the fleet summary bar show hit rate %, mini hit bar, hits/misses counts, and data served
- **Tailscale integration** — optional sidecar that joins the container to your tailnet; supports `tailscale serve` for automatic HTTPS with a Let's Encrypt cert; connection status (IP, hostname, DNS name) visible in Settings → Infrastructure
- **Background job indicator** — bell icon in the top nav shows running/completed jobs (upgrades, checks) with a spinner; jobs auto-dismiss a few seconds after completion; click to return to a running job
- **Upgrade dry-run preview** — preview what `apt-get upgrade` would do (packages, version deltas) before committing, via a collapsible panel in the upgrade UI
- **Server notes** — free-text notes field per server, visible in the server detail header
- **History filtering** — filter the fleet-wide upgrade history by server and/or status
- **Docker host detection** — automatically detects when a managed server is the Docker host running the dashboard; shows a `🐳 docker host` badge on the server card; blocks the Run Upgrade button and shows an SSH command when container-runtime packages (Docker, containerd, Podman, runc, LXD, etc.) are in the upgrade list to prevent the container being killed mid-upgrade; detection works by hostname resolution and by comparing the Docker bridge gateway IP against the server's own IPs collected during check
- **Default dashboard sort** — configurable in Settings → Preferences → Display; persisted in `localStorage` so it survives browser restarts; changing the sort on the dashboard also updates the preference
- **Fleet summary security count** — shows number of hosts with security updates (not total package count), consistent with how the Updates counter works
- **dpkg log history** — new "dpkg Log" tab on each server detail page shows full install/upgrade/remove/purge history parsed from `/var/log/dpkg.log` and all rotated archives (including `.gz`); fetched on demand so it never slows down page load; filterable by package name, action type, and time window (7/30/90/365 days or all); colour-coded action badges
- **.deb package installation** — install local `.deb` files on any managed server directly from the UI; two modes: paste a URL (validated with a HEAD request, then `wget`'d on the remote) or upload a file from your browser (SFTP'd to `/tmp/` via asyncssh); both paths stream `dpkg -i` + `apt-get install -f` output in a live terminal; "+ Install .deb" button in the Packages tab
- **Apt repo management** — new "Apt Repos" tab on each server detail page reads all apt source files (`/etc/apt/sources.list` and all `/etc/apt/sources.list.d/*.list` / `*.sources` files) via SSH on demand; per-file tabbed editor with unsaved-changes indicator; save via `sudo tee`; delete files from `sources.list.d`; add new `.list` or `.sources` files; "Test with apt-get update" button streams live output to confirm sources are valid after changes
- **Dark/light theme** — toggle in the top nav; preference persisted in `localStorage`
- **Dark industrial UI** — dense, information-rich dashboard designed for ops use

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
echo "youruser ALL=(ALL) NOPASSWD: /usr/bin/apt-get" | sudo tee /etc/sudoers.d/apt-dashboard
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

All runtime configuration (SMTP, Telegram, schedules, server list) is managed through the web UI and stored in the SQLite database at `/data/apt-dashboard.db`. No restart required to change settings.

| Variable | Default | Description |
|---|---|---|
| `SSH_PRIVATE_KEY` | — | Full PEM content of the private key. Required unless using SSH agent. |
| `SSH_AUTH_SOCK` | — | Path to SSH agent socket inside the container (e.g. `/run/ssh-agent.sock`). Alternative to `SSH_PRIVATE_KEY` — allows passphrase-protected keys. See compose file for socket mount. |
| `JWT_SECRET` | random | JWT signing secret. Set to persist sessions across restarts |
| `ENCRYPTION_KEY` | — | Master key used to encrypt per-server SSH keys stored in the database. Falls back to `JWT_SECRET` if not set. Set explicitly to decouple the two secrets. |
| `DATABASE_PATH` | `/data/apt-dashboard.db` | SQLite file path |
| `TZ` | `America/Montreal` | Timezone for scheduled jobs |
| `LOG_LEVEL` | `INFO` | Python log level |
| `ENABLE_TERMINAL` | `false` | Set to `true` to enable the interactive SSH shell terminal in the UI. Only enable if you trust all dashboard users. |

---

## CLI Tool

Admin operations can be run from inside the container:

```bash
# Reset password (interactive prompt)
docker compose exec apt-dashboard python -m backend.cli reset-password

# Reset password inline
docker compose exec apt-dashboard python -m backend.cli reset-password --username admin --password newpass123

# Create a new user
docker compose exec apt-dashboard python -m backend.cli create-user --username zac --password mypass

# List all users
docker compose exec apt-dashboard python -m backend.cli list-users
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
TS_HOSTNAME=apt-dashboard     # how it appears on your tailnet
```

Then run with the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
```

**How updates work:** Tailscale is NOT baked into the app image. It runs as a separate `tailscale/tailscale:latest` container. Running `docker compose pull` updates it independently of the app — no rebuild needed.

### Enable tailscale serve (HTTPS on your tailnet)

`tailscale serve` proxies HTTPS `:443` → app `:8000` and provisions a Let's Encrypt cert automatically for your node's DNS name (e.g. `apt-dashboard.your-tailnet.ts.net`).

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
kubectl create secret generic apt-dashboard-secrets \
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
kubectl create secret generic apt-dashboard-secrets \
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
        SPA["React 18 SPA  —  Vite · TypeScript · Tailwind\n6 pages · 6 components · Zustand state"]
    end

    subgraph container["Docker Container  (:8000)"]
        direction TB
        API["FastAPI  —  14 routers · 50+ REST endpoints · 15 WebSocket streams\n/api/*  (JWT cookie auth)     /health  (liveness probe)     /*  (SPA static)"]
        BG["APScheduler  ·  Update Checker  ·  Upgrade Manager  ·  Notifier\ncron jobs · per-server asyncio.Lock · Email · Telegram · Webhook"]
        DB[("SQLite  /data/apt-dashboard.db\n13 tables · 38 migrations")]
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
