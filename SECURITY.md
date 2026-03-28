# Security Policy

## Supported Versions

Only the latest release is actively maintained and receives security fixes.

| Version | Supported |
|---|---|
| latest | ✅ |
| older releases | ❌ |

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/mzac/apt-ui/security/advisories/new).

Include as much detail as you can:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected component (backend endpoint, frontend, SSH handling, etc.)
- Your suggested fix if you have one

You can expect an initial response within a few days. If the report is confirmed, a fix will be prioritised and released as soon as possible. You will be credited in the release notes unless you prefer otherwise.

---

## Security Model and Trust Assumptions

Understanding the intended deployment model helps assess what is and isn't in scope.

### Intended deployment

apt-ui is designed to run as a **single Docker container on a trusted private network** — a homelab, internal ops network, or behind a VPN. It is not designed to be exposed directly to the public internet.

### Authentication

- All API endpoints (except `/api/auth/login` and `/health`) require a valid JWT stored in an httpOnly, SameSite=Lax cookie.
- Passwords are hashed with bcrypt via passlib.
- WebSocket endpoints validate the JWT from the cookie on handshake and close with code 1008 on failure.
- There is no multi-user RBAC — all authenticated users have full admin access.

### SSH access

- The dashboard connects to managed servers over SSH using a private key supplied via the `SSH_PRIVATE_KEY` environment variable or a forwarded SSH agent socket.
- Per-server SSH keys are stored encrypted in SQLite using Fernet (AES-128-CBC + HMAC-SHA256). The encryption key is derived from the `ENCRYPTION_KEY` env var (falls back to `JWT_SECRET`).
- Host key verification is disabled (`known_hosts=None`) — this is an intentional trade-off for fleet management on a trusted network. It is documented in the code.
- SSH connections are opened fresh per command; there is no persistent connection pool.

### Outbound HTTP requests

The `.deb` URL validation endpoint (`POST /api/servers/{id}/validate-deb-url`) makes outbound HTTP requests from the dashboard container based on a user-supplied URL. The following mitigations are in place:

- The URL hostname is resolved and checked against private/loopback/link-local/reserved IP ranges before the request is made (SSRF protection).
- `follow_redirects` is disabled — redirects are rejected outright to prevent a redirect chain from bypassing the IP check.
- Only `http://` and `https://` schemes are accepted.

### Remote command execution

The dashboard executes commands on managed servers over SSH. All commands are constructed server-side from validated parameters — no raw user input is passed directly to a shell. The apt repo management feature writes file content via `sudo tee` through stdin rather than shell-interpolated arguments to avoid injection.

### Data storage

- All persistent state is stored in a SQLite database at `/data/apt-dashboard.db` inside the container.
- The database is mounted as a Docker volume — it is the operator's responsibility to secure volume access on the host.
- SMTP passwords and Telegram bot tokens are stored as plaintext in the database. The database should be protected at the filesystem level.
- Upgrade terminal output is capped at 1 MB per session before being written to the database.

---

## Known Limitations (by design)

These are accepted trade-offs given the intended deployment context, not bugs:

- **No host key verification** — SSH connects with `known_hosts=None`. Acceptable on a trusted LAN; not appropriate for connections over untrusted networks.
- **Single-role auth** — all users are effectively admins. There is no read-only role.
- **SSH terminal** — the interactive shell terminal (`ENABLE_TERMINAL=true`) gives full shell access to managed servers. It is disabled by default and should only be enabled when all dashboard users are trusted.
- **Plaintext secrets in DB** — SMTP and Telegram credentials are stored unencrypted. Encrypt the host volume if this is a concern.

---

## Dependency Security

Dependencies are tracked via:
- Python: `backend/requirements.txt`
- Node.js: `frontend/package-lock.json`

Dependabot is enabled on this repository and will open pull requests for dependency updates, including security patches.
