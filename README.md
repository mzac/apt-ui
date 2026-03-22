# apt-dashboard

A lightweight, self-hosted alternative to AWX / Ansible Tower focused on `apt` package management across a fleet of Ubuntu / Debian / Raspbian servers. Runs as a single Docker container.

---

## Features

- **Fleet dashboard** — see all servers at a glance with update counts, security update highlights, reboot-required flags, and held packages
- **Live upgrade terminal** — stream `apt-get upgrade` output in real time via WebSocket
- **Scheduled checks** — configurable cron schedule for automatic update checks
- **Auto-upgrade** — optional hands-off mode to apply updates on a schedule
- **Notifications** — daily summary + event alerts via email (SMTP) and Telegram
- **Server groups** — colour-coded grouping and filtering
- **Dark industrial UI** — dense, information-rich dashboard designed for ops use

---

## Requirements

- Docker + Docker Compose v2
- An SSH private key (RSA or Ed25519, no passphrase) that is authorised on all target servers
- Passwordless sudo configured on target servers for `apt-get`:

```bash
# Run on each managed server
echo "youruser ALL=(ALL) NOPASSWD: /usr/bin/apt-get" | sudo tee /etc/sudoers.d/apt-dashboard
```

---

## Quick Start

### 1. Set up your `.env`

Create `.env` in the project root with your SSH private key. The key must be inside double quotes with literal newlines:

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

### 2. Build and run

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
| `SSH_PRIVATE_KEY` | — | **Required.** Full PEM content of the private key |
| `JWT_SECRET` | random | JWT signing secret. Set to persist sessions across restarts |
| `DATABASE_PATH` | `/data/apt-dashboard.db` | SQLite file path |
| `TZ` | `America/Montreal` | Timezone for scheduled jobs |
| `LOG_LEVEL` | `INFO` | Python log level |

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

```
Docker Container
┌─────────────────────────────────────────┐
│  FastAPI (backend.main:app)  :8000       │
│  ├── /api/*       REST + WebSocket       │
│  ├── /health      liveness probe         │
│  └── /*           React SPA (static/)    │
│                                          │
│  SQLite  ←→  /data/apt-dashboard.db      │
│  APScheduler  (cron jobs)                │
└──────────────┬──────────────────────────┘
               │ asyncssh (no host key verification)
               ▼
        Remote Ubuntu/Debian/Raspbian hosts
        (apt-get over SSH, passwordless sudo)
```

---

## Tech Stack

| Layer | Library |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn |
| Auth | passlib[bcrypt], PyJWT (httpOnly cookie) |
| SSH | asyncssh |
| Database | SQLite, SQLAlchemy (async + aiosqlite) |
| Scheduler | APScheduler 3.x (AsyncIOScheduler) |
| Email | aiosmtplib |
| Telegram | httpx (direct Bot API calls) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| State | Zustand |
| Charts | Recharts |
| Terminal | ansi-to-html |
| Container | Multi-stage Dockerfile (node:20-alpine → python:3.12-slim) |
