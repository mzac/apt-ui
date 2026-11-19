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
- Passwords are hashed with bcrypt.
- There is no default password. The initial `admin` account gets the value of `ADMIN_PASSWORD`, or no usable password until one is set with `python -m backend.cli reset-password`; a password is never logged. An account that still has the legacy `admin` password (installs created before this was introduced) can log in but is refused everything except changing it.
- New installs enforce a minimum password length of 8 (configurable in Settings → Users). Installs created earlier keep their previous minimum (4 unless changed) — raising it is recommended.
- WebSocket endpoints validate the JWT from the cookie on handshake and close with code 1008 on failure.
- There is no multi-user RBAC — all authenticated users have full admin access.

### SSH access

- The dashboard connects to managed servers over SSH using a private key supplied via the `SSH_PRIVATE_KEY` environment variable or a forwarded SSH agent socket.
- Per-server SSH keys are stored encrypted in SQLite using Fernet (AES-128-CBC + HMAC-SHA256). The encryption key is derived from the `ENCRYPTION_KEY` env var, falling back to `JWT_SECRET`, and finally to a random key generated on first start and persisted in the `app_config` table (same SQLite file, on the mounted data volume). Set `ENCRYPTION_KEY` explicitly if you want the key held outside the database.
- Host key verification is disabled (`known_hosts=None`) — this is an intentional trade-off for fleet management on a trusted network. It is documented in the code.
- SSH connections are opened fresh per command; there is no persistent connection pool.

### Container

- The application process runs as an unprivileged user (uid/gid 10001). The image's entrypoint starts as root solely to transfer ownership of a root-owned data volume left by older releases, then drops privileges with `no_new_privs` set; started with `--user` / Kubernetes `runAsUser`, it is never root.
- The shipped Compose files and Kubernetes manifest use a read-only root filesystem, drop all capabilities (Compose keeps `CHOWN`/`SETUID`/`SETGID` for the start-up migration only — the app process itself has an empty effective set) and set `no-new-privileges` / `allowPrivilegeEscalation: false`.
- The Kubernetes manifest does not contain a `Secret` object; secrets are created out of band so re-applying the manifest cannot overwrite them.

### Outbound HTTP requests

The `.deb` URL validation endpoint (`POST /api/servers/{id}/validate-deb-url`) makes outbound HTTP requests from the dashboard container based on a user-supplied URL. The following mitigations are in place:

- The URL hostname is resolved and checked against private/loopback/link-local/reserved IP ranges before the request is made (SSRF protection).
- `follow_redirects` is disabled — redirects are rejected outright to prevent a redirect chain from bypassing the IP check.
- Only `http://` and `https://` schemes are accepted.

HTTP upgrade hooks (`hook_type: http`, admin-configured) POST to an arbitrary URL from the dashboard container. Because their purpose is to reach load balancers and alerting systems on the same network, private and loopback addresses are allowed. The hostname is resolved first and every resulting address is checked: link-local ranges (`169.254.0.0/16`, `fe80::/10`) and known cloud-metadata addresses are refused, including when reached through DNS names, IPv4-mapped IPv6 or alternative IP encodings. The request is then sent to the vetted address (with the original name as `Host` and TLS SNI), so a DNS answer that changes between check and connect cannot redirect it, and redirects are not followed.

### Remote command execution

The dashboard executes commands on managed servers over SSH. All commands are constructed server-side from validated parameters — no raw user input is passed directly to a shell. The apt repo management feature writes file content via `sudo tee` through stdin rather than shell-interpolated arguments to avoid injection.

### Data storage

- All persistent state is stored in a SQLite database at `/data/apt-ui.db` inside the container.
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
- Python: `backend/requirements.in` (direct dependencies) → `backend/requirements.txt` (full hash-locked resolution, installed with `pip --require-hashes`; regenerate with `make lock`)
- Node.js: `frontend/package-lock.json` (installed with `npm ci`)
- Base images in the `Dockerfile` are pinned by digest
- GitHub Actions in the release workflow are pinned to commit SHAs

Dependabot is enabled on this repository (`.github/dependabot.yml`: pip, npm, docker, github-actions) and will open pull requests for dependency updates, including security patches.
