# Changelog

All notable changes to apt-ui are documented here.

---

## [2026.08.31-01] — 2026-08-31

**Security release — upgrade promptly if any non-administrator can log in.** Two privilege-escalation holes let *any* authenticated user, including a read-only account, execute arbitrary code as root on every managed host: installing a `.deb` (whose maintainer scripts run as root) and — with `ENABLE_TERMINAL=true` — opening an interactive shell. Neither required administrator rights. Two stored credentials were also exposed. Details in **Security** below.

Also fixes a second GUI flow audit ([#80](https://github.com/mzac/apt-ui/issues/80)) — 47 verified bugs across the React frontend and the backend endpoints behind it, headlined by **every timestamp in the UI being shifted by the viewer's UTC offset** — plus the next tranche of the enhancement roadmap ([#62](https://github.com/mzac/apt-ui/issues/62)), including a graceful stop for fleet operations and apt-repo edit safety rails.

### Security

- **Any authenticated user could gain root on every managed host by installing a `.deb`.** `POST /upload-deb`, `POST /validate-deb-url` and the `install-deb` WebSocket required only a valid session, not an administrator. A `.deb`'s maintainer scripts run as root on the target, so a read-only account could upload a crafted package and execute arbitrary code fleet-wide — with no `ENABLE_TERMINAL` involved. All three are now admin-only.
- **Any authenticated user could open an interactive root shell.** With `ENABLE_TERMINAL=true`, `ws_shell` checked only that the caller was logged in, so a read-only account could bypass the entire permission model. Now admin-only, and the Shell tab is hidden from non-admins.
- **The Slack webhook URL was returned in cleartext on every config read.** An incoming-webhook URL is itself a posting credential, but the masking helper covered only the SMTP password and Telegram bot token. Masked fields are now one shared list used by the read, persist and test paths, so echoing a mask back never overwrites the stored secret.
- **A Telegram bot token could travel in a URL query string.** The unsaved-config test work passed the candidate token as a GET parameter, where reverse proxies and access logs capture it, on an endpoint open to any authenticated user. It is now a POST body and admin-only, matching the other test endpoints.

### Added

- **Graceful stop for fleet operations** ([#62](https://github.com/mzac/apt-ui/issues/62)). "Upgrade All", "Autoremove All" and "Rolling Reboot" gain a *Stop after current* control. Cancellation is checked after the concurrency semaphore is acquired but before any work begins, so an in-flight apt transaction is never interrupted and `dpkg` is never left half-finished; servers that had not yet started are reported as cancelled, which renders as a distinct terminal state rather than a failure.
- **Apt repository safety rails** ([#62](https://github.com/mzac/apt-ui/issues/62)). Saving a source file now goes through a diff preview and a syntax lint (one-line and deb822 rules); definite errors block the save and warnings require an explicit override. The backend keeps a single-generation server-side backup so a bad edit can be reverted with *Restore Previous*, which routes through the same preview-and-lint gate rather than writing directly.
- **Configurable password policy** ([#62](https://github.com/mzac/apt-ui/issues/62)). The minimum password length is now an admin setting enforced consistently across self-service change, admin reset and user creation, with matching client-side hints and a strength meter. The default stays at 4, so no existing deployment is locked out.
- **Notification channels can be tested with unsaved form values** ([#62](https://github.com/mzac/apt-ui/issues/62)). The test endpoints accept an optional candidate config, so "Send Test" no longer has to silently persist the form first to try new credentials. A masked secret falls back to the stored value, and nothing is written to the database.
- **Post-reboot "back online" indicator** ([#62](https://github.com/mzac/apt-ui/issues/62)) on the server detail page, reusing the existing reboot check — reboots are no longer fire-and-forget.
- **Maintenance-window override in the upgrade UI** ([#62](https://github.com/mzac/apt-ui/issues/62)). The backend already accepted `override_window`, but nothing ever sent it, so administrators had no way to override a freeze from the interface.
- **Fleet ergonomics** ([#62](https://github.com/mzac/apt-ui/issues/62)): select/deselect all *filtered* servers from the bulk bar, with a warning when selected servers are hidden by the active filter; a downloadable transcript of a fleet run; saved command presets on the Run page with servers whose output changed since the previous run flagged; and command-palette entries for the Security and Run pages plus direct CVE lookup.

### Fixed

- **Every timestamp in the UI was shifted by the viewer's UTC offset.** The database stores *naive UTC* (`func.now()` is SQLite's `CURRENT_TIMESTAMP`; the checker uses `datetime.utcnow()`) and most endpoints serialized it without a zone designator. JavaScript parses an offset-less string like `2026-08-31T14:00:00` as **local** time, so with the default `TZ=America/Montreal` everything read ~4–5 hours in the future: the dashboard showed "just now" for hours, the 24-hour stale warning fired at ~28h, History printed literal negative ages such as `-14341s ago`, and Reports' SLA dates could be off by a full day. Outbound timestamps now go through `backend/timeutil.py`'s `utc_iso()` (hand-built dict responses) or the `UtcDateTime` alias in `backend/schemas.py` (Pydantic response models) — note `response_model` alone was *not* protection, since `_user_dict()` and the token / hook / maintenance-window / audit-log listings all hand-build their dicts and bypassed it. `frontend/src/utils/datetime.ts` parses defensively on the client so a missed endpoint or a cached response cannot reintroduce the shift. Timestamps read from a *remote host's* `/var/log/dpkg.log` are deliberately left alone — those are that host's local wall clock, not UTC.
- **"Test with apt-get update" on the Apt Repos tab had never worked.** `ws_apt_repos_test` called `get_current_user_ws(websocket)` while the function's signature is `(token, session)`, raising `TypeError` before `websocket.accept()` — so the socket never opened and the UI always reported "✗ Update failed — check sources above" with no output, making it look like the user's sources were broken. It now follows the same accept-then-authenticate pattern as every other WebSocket handler (cookie or `?token=`, close 1008 on failure) and reports the real `apt-get update` exit status.
- **Demoting or deleting an administrator returned HTTP 500 whenever three or more admins existed.** Both "last admin" guards ran `.scalar_one_or_none()` against a query selecting *all other admins*, and SQLAlchemy raises `MultipleResultsFound` as soon as two rows match — so the guard failed before it could ever protect anything.
- **The self-service password form accepted an empty password.** It only checked that the new password matched its confirmation, and the endpoint had no length validation (user creation and admin reset both enforced a minimum). Typing only the current password set the account password to the empty string and reported success.
- **`apt-get update` always reported success.** The stream sent `complete {success: true}` without consulting `proc.exit_status`, so a failed refresh (broken repo, DNS failure) still printed "✓ apt-get update finished" and the user believed the index had updated.
- **Bulk operations reported servers as failed that the backend had silently dropped.** `ws_upgrade_all` and `ws_reboot_all` filtered out disabled servers — and servers whose last check showed nothing pending — without emitting any message for them. The client then marked them "Stream ended without a completion message" and reddened the whole job even when every real upgrade succeeded. Dropped servers now receive an explicit `skipped` message naming the reason, which the modals render as a terminal *non-failure*. Disabled servers are still never upgraded; they are skipped inside the loop rather than silently filtered out.
- **The confirm dialog fired the destructive action when the user pressed Enter on Cancel.** A window-level `keydown` listener resolved the promise as *confirmed* on any Enter, beating the focused Cancel button's click (which then no-opped, because the pending dialog had already been cleared). Tabbing to Cancel and pressing Enter ran the action — on fleet-wide operations such as "Hold openssl across 12 servers". Enter is now handled natively by the autofocused confirm button, with a guard so a held-down Enter cannot activate a dialog the instant it appears.
- **"Upgrade All" flipped finished servers back to "running".** The `output` and `status` handlers overwrote any status with `running`, but the backend sends `complete` *before* post-hook output, the auto-reboot status, and the "Server is rebooting" line — so with "Reboot servers if required" enabled every ✓ reverted to ⚙️ and stayed there in the final summary, and failures were relabelled as running. Terminal statuses are no longer downgraded.
- **The .deb install modal could hang on "Installing…" forever.** Neither install path passed an `onClose` handler, so a dropped socket (network blip, proxy timeout on a long `dpkg` run) left the spinner running with no way to tell whether the install had finished.
- **CSV import reported failure as success.** `importCsv` never checked `res.ok`, so a 401/403/400 error body rendered as the green toast "Imported: undefined added, undefined skipped" while nothing had been imported. CSV *export* likewise saved a JSON error body as a `.csv` file.
- **The calendar subscribe flow minted a full-access API token.** It created the token with no scopes, which the backend treats as full admin access, and then embedded that raw token in the `?token=` feed URL handed to Google/Apple calendar servers. It now mints a least-privilege `calendar`-scoped token.
- **Enabling a scheduled job with a blank or invalid cron expression saved silently and never ran.** The scheduler caught the failure and only logged it. `PUT /api/scheduler/config` now validates the *effective* cron server-side and returns HTTP 422 naming the problem, before the row is modified.
- **Holds appeared to do nothing.** Holding or unholding a package updated the remote host but not the cached check row the packages view reads, so the package stayed listed as upgradable until the next full check — inviting repeated clicks. The cached row and its counts are now updated in place.
- **Server notes could not be cleared.** Both edit forms sent `notes: value || undefined`, and `JSON.stringify` drops undefined keys, so the backend never saw the field and kept the old text.
- **The Docker-host upgrade guard went stale.** The probe that detects whether the running container's own runtime is about to be upgraded depended only on the server id, not the check timestamp — so a "Check Now" that pulled `docker-ce` into the pending list left "Run Upgrade" enabled, and the upgrade could restart Docker and kill the apt-ui container mid-run.
- **Security's "To (inclusive)" CVE date filter was exclusive.** A bare date was parsed as midnight, so CVEs first seen during the chosen end day were excluded and `since = until = today` returned nothing.
- **Compare's "Diverged" filter ignored version differences.** Divergence was computed purely from presence, so a package installed on every selected server at *different versions* — the main thing the comparison view exists to surface — was classified as not diverged and never highlighted.
- **Failed requests left pages stuck on "Loading…" forever.** The Dashboard's initial load and all three Reports tabs swallowed errors and had no error state; a failed History page load left the previous page's rows under the new page number. Rapid filter changes on Reports, Security and History could also commit an out-of-order response that did not match the current selection.
- **CVE severity was always "unknown".** The matcher ranked severity by iterating a `cves_data` key that the published USN feed does not contain (it exposes only a flat list of CVE ids under `cves`), alongside a `for … : pass` no-op loop. Verified against the live feed — 7788 entries, no `cves_data` key. The feed is reachable and needs no `brotli`, so the Security page *is* populated; only severity was affected, contrary to the suspicion recorded in [#61](https://github.com/mzac/apt-ui/issues/61). The dead code is gone and the constraint is documented; restoring real severity needs a feed that carries it.
- **Assorted flow fixes.** Escape no longer closes a modal and the command palette in one keystroke; restoring a running "Upgrade All" from the job bell now works from any page, not just the Dashboard; the palette's "Check All" registers a job and surfaces errors instead of failing silently; the palette gained the Security and Run pages plus CVE jump entries; the "Upgrade All" button now restores a minimized run; the rolling-reboot countdown no longer leaks timers or double-counts a failed server; garbage `?group=`/`?tag=` URL values no longer produce an empty dashboard with no visible filter; card-view bulk selection is reachable by keyboard and touch; the SSH shell no longer writes to a disposed terminal or ignores an expired session; fleet terminals auto-scroll; and enable/disable, connection tests, bulk deletes and template package edits now report their failures instead of swallowing them.

---

## [2026.08.13-01] — 2026-08-13

Fixes per-server SSH keys and TOTP 2FA secrets being lost on every container restart ([#77](https://github.com/mzac/apt-ui/issues/77)) — the default `docker-compose.yml`, with `ENCRYPTION_KEY` and `JWT_SECRET` both commented out, encrypted them with a key that only existed in memory.

### Fixed

- **Per-server SSH keys (and TOTP 2FA secrets) stopped working after every container restart** ([#77](https://github.com/mzac/apt-ui/issues/77)). When neither `ENCRYPTION_KEY` nor `JWT_SECRET` was set — the default for `docker-compose.yml`, where both are commented out — `backend/crypto.py` fell back to a **random Fernet key generated in memory at startup**. Keys were encrypted correctly, but the next restart derived a different key, so every stored blob became undecryptable and every server with a custom key silently fell back to the global `SSH_PRIVATE_KEY` / agent auth (or failed to connect at all). The encryption key is now resolved once at startup by `seed_defaults()` and persisted in the `app_config` table alongside the JWT secret, which lives on the mounted data volume — the same pattern that already kept login sessions alive across restarts. `ENCRYPTION_KEY` and `JWT_SECRET` still take precedence, in that order, so existing deployments that set either keep deriving the same key and are unaffected.
- **Startup now names the servers whose stored SSH key can't be decrypted.** Keys written by an affected version are unrecoverable (the ephemeral key they were encrypted with is gone), and the fallback to global SSH auth was silent apart from a per-connection log line. A single warning at boot lists the affected servers and tells you to re-enter their keys in Settings → Servers.

---

## [2026.07.13-01] — 2026-07-13

Fixes upgrades for non-root SSH users, which failed outright on the passwordless-sudo setup documented in the README ([#74](https://github.com/mzac/apt-ui/issues/74)), and brings the whole dependency stack up to date — React 19, Tailwind CSS 4, TypeScript 7 ([#76](https://github.com/mzac/apt-ui/pull/76)). **Tailwind 4 visibly changes the UI**: it revives ~30 utility classes that silently emitted no CSS under v3 — see *Changed* below.

### Fixed

- **Upgrades failed for every non-root SSH user with a narrow sudoers rule: `sudo: sorry, you are not allowed to set the following environment variables: DEBIAN_FRONTEND`** ([#74](https://github.com/mzac/apt-ui/issues/74)). sudo only accepts `VAR=value` on its command line when the matching sudoers rule carries the `SETENV` tag. `SETENV` is implied by `ALL`, but **not** by the narrow `NOPASSWD: /usr/bin/apt-get` rule that README "Option B" documents — so `sudo DEBIAN_FRONTEND=noninteractive apt-get …` was rejected before apt ever ran. Privilege escalation is now built by `sudo_prefix()` / `apt_prefix()` in `backend/ssh_manager.py`, which probe sudo with the target binary and drop the variable when it is refused; apt still runs unattended via `-y` and the `--force-conf*` dpkg options. Users with full `NOPASSWD: ALL` sudo are unaffected.
- **`DEBIAN_FRONTEND` was silently stripped on the update-check and dry-run paths.** Roughly half the call sites placed the assignment *before* `sudo` (`DEBIAN_FRONTEND=noninteractive sudo apt-get …`), which never errors but is discarded by sudo's `env_reset` — so `check_server`'s `dist-upgrade --dry-run`, the upgrade preview, `pveupgrade`, and the apt-proxy / unattended-upgrades helpers were never actually running non-interactively for non-root users. All ~25 hand-rolled `sudo` prefixes across `upgrade_manager.py`, `update_checker.py`, `scheduler.py`, `routers/upgrades.py`, `routers/servers.py`, and `routers/apt_repos.py` now go through the shared helpers.
- **Apt repo editing broke for root SSH users.** `backend/routers/apt_repos.py` hardcoded `sudo tee` / `sudo rm` / `sudo apt-get update` regardless of the SSH username, so hosts logged into as `root` without sudo installed could not write, delete, or test source files.
- **Deleting an apt source file returned HTTP 500 after succeeding.** `backend/routers/apt_repos.py` read `cmd_result.exit_status`, but `run_command` returns a `CommandResult` whose field is `exit_code` — the `rm` ran, then the handler raised `AttributeError`.

### Changed

- **Dependencies brought up to date across the stack.** Frontend majors: React 18 → 19, Tailwind CSS 3 → 4, TypeScript 5.9 → 7, recharts 2 → 3, react-router-dom 6 → 7, `@xterm/xterm` 5 → 6; plus in-range refreshes (vite 8.1.4, postcss, zustand, `@vitejs/plugin-react`). Backend requirement floors were raised to the versions actually shipping in the image (fastapi 0.139, uvicorn 0.51, SQLAlchemy 2.0.51, bcrypt 5, cryptography 49, asyncssh 2.24, httpx 0.28.1, PyJWT 2.13, pyotp 2.10, qrcode 8.2). The Docker frontend build stage moves from `node:20-alpine` (end-of-life since April 2026) to `node:22-alpine`.
- **Tailwind 4 revives ~30 utility classes that silently emitted no CSS under v3.** v3 could not apply an alpha modifier to a bare `var()` colour, so `border-border/30`, `text-text-muted/70`, `divide-border/30` and `hover:bg-surface/50` produced *nothing*; and a flat `red: '#ef4444'` in the old config clobbered the entire `red-50…950` scale, so `text-red-400` / `bg-red-500` were dead too. These now render as originally intended — expect translucent borders and muted text where they were previously opaque or absent. `purple` (used in 5 places, never defined) is now defined. Theme configuration moves from `tailwind.config.js` into `src/index.css`; the palette moved to `--app-*` custom properties because Tailwind 4 owns the `--color-*` namespace.
- **README "Option B" now recommends `NOPASSWD:SETENV: /usr/bin/apt-get`.** The `SETENV:` tag is optional — it lets apt-ui pass `DEBIAN_FRONTEND=noninteractive` through sudo to suppress debconf prompts, and without it upgrades still run. The section also documents which additional binaries the optional features (reboot, package holds, `.deb` install, repo editing, health tab, snapshots) need in sudoers.

---

## [2026.06.06-02] — 2026-06-06

### Fixed

- **"Upgrade All" (and selective upgrade) failed on every server with `cannot access local variable 'select' where it is not associated with a value`.** `upgrade_server` and `upgrade_packages_selective` in `backend/upgrade_manager.py` each carried a redundant nested `from sqlalchemy import select`; per Python's static scoping rules that makes `select` a function-local name for the *entire* function, so the module-level `select` used earlier in `upgrade_server` (the pre-upgrade snapshot config lookup added in 2026.06.06-01) raised at runtime — even though the nested import line never executed during a batch upgrade (`skip_notify=True`). Removed the nested imports so the module-level `select` is used throughout. Regression introduced in 2026.06.06-01.

---

## [2026.06.06-01] — 2026-06-06

The largest release to date: the full enhancement roadmap ([#62](https://github.com/mzac/apt-ui/issues/62)) — 24 features across UX, security, automation, integrations, and observability — plus a frontend correctness sweep of 40 verified bugs ([#61](https://github.com/mzac/apt-ui/issues/61)). Both were produced by multi-agent reviews and landed across PRs [#63](https://github.com/mzac/apt-ui/pull/63)–[#71](https://github.com/mzac/apt-ui/pull/71).

### Added

#### Fleet UX

- **Dashboard bulk selection + sticky action bar** ([#62](https://github.com/mzac/apt-ui/issues/62)) — select any subset of servers (a themed checkbox on each card/row) and run Check / Upgrade / Reboot / Enable-Disable / Tag across them via parallel per-server calls that honour `upgrade_concurrency`. A sticky bar shows the selection count and the available actions.
- **Density / compact-list view toggle** — switch the dashboard between the card grid and a compact list; persisted to `localStorage` like the sort order.
- **App-wide toast + styled confirm system** — a Zustand toast store with `<ToastHost>` and a promise-based `confirmDialog()`, replacing ~27 native `alert()` / `confirm()` calls with themeable, non-blocking dialogs (opt-in undo for reversible actions).
- **Aggregate pending-updates modal** — the dashboard "updates available" modal reads one backend aggregate endpoint instead of a sequential per-server `/packages` loop, with in-modal filtering and CSV/copy export.

#### Security & audit

- **Actor attribution + auth-event log** ([#62](https://github.com/mzac/apt-ui/issues/62)) — the authenticated username is threaded through `run_command` / upgrade / WebSocket handlers (no more `initiated_by='system'` everywhere) via a `ContextVar` in `backend/actor.py`. A new `AuthEventLog` table records logins, failures, token use, and role changes, surfaced as a 4th **History** sub-tab.
- **Login brute-force lockout + TOTP replay protection** — per-(username, IP) backoff and lockout on repeated failures with a real-time alert on lockout, plus TOTP replay protection via a stored `totp_last_counter`.
- **Inbound automation API (`/api/v1`) + scoped, expiring tokens** — REST wrappers over the previously WebSocket-only operations returning a pollable `job_id` (`backend/routers/api_v1.py`); API tokens gain `scopes` (read / check / upgrade / calendar) and an optional `expires_at`.
- **Maintenance windows enforced as change-control gates** — window checks moved into the shared upgrade / reboot / template entry points with an audited admin `override_window`, plus an "allow-only" window mode. Freezes are no longer advisory.

#### Safer upgrades

- **Snapshot-and-rollback safety net** — btrfs/zfs hosts are auto-snapshotted before apt (capability was already detected but unused); the snapshot name is recorded on `UpdateHistory`, with an admin-gated "rollback to pre-upgrade snapshot" action.
- **Canary-first auto-upgrade with health verification** — after apt, the health probe (failed units / boot errors) runs and is compared against a pre-upgrade baseline; the ring's first server must pass before the rollout promotes. Success is no longer just the apt exit code.
- **Upgrade impact preview** — a pre-flight panel parses the dry-run plan and runs `needrestart -b` to show which services will restart and whether a reboot is *actually* required (replacing the hardcoded frontend regex with ground truth).
- **Dependency / anti-affinity-aware upgrade ordering** — optional ordering so HA pairs and DB primary/replica patch in a safe sequence within a ring.

#### Observability & reporting

- **Fleet snapshot history + trend charts** — a new `FleetSnapshot` table written by `_job_check_all` (excluded from log-purge), `GET /api/stats/trend`, and dashboard trend lines for pending packages, security debt, and % up-to-date over time.
- **Configuration drift detection** — each check counts and lists abandoned `.dpkg-dist` / `.ucf-dist` / `.dpkg-new` conffiles under `/etc`; the dashboard shows a `⚠ drift N` badge that opens a detail modal listing the files and the `diff` / `rm` commands to reconcile them.
- **Maintenance change-record / patch report** — the new **Reports** page brackets each maintenance window into an auditable change record (planned vs actual, packages, reboots, failures), exportable to Markdown/CSV.
- **Safe fleet command runner** — the new **Run** page executes an admin-allowlisted (raw mode admin-gated + audited) command across selected servers and groups identical outputs ("47 said X, 3 said Y").

#### Integrations & notifications

- **Multi-target notification destinations** — a `NotificationDestination` table with per-event routing and Discord / Mattermost / ntfy / PagerDuty / Opsgenie adapters, plus notification dedup to avoid alert storms.
- **HTTP/webhook hook type** — pre/post-upgrade hooks can now call *out* from apt-ui (drain a load balancer, open an Alertmanager silence, file a ticket) with the same SSRF guards as the `.deb` URL validator — not only run shell on the target.
- **Slack as a first-class weekly-digest channel** — Slack gains its own per-channel weekly-digest toggle (previously it only inherited the master enable).
- **Self-updating EOL data** — a daily sync from endoflife.date (ubuntu / debian / proxmox-ve …) with the bundled `backend/eol_data.py` table as offline fallback; picks up Debian 13, PVE 9 / PBS 4 / PMG 9, etc. without a code change.

#### Plumbing that unblocked the above

- **Per-package `is_security` / `is_kernel` / `is_new` flags persisted into upgrade history** — kills the substring heuristic in the digest and the dead `security:0` Stats series.
- **Template apply hardening** — `ws_template_apply` caps concurrency (`upgrade_concurrency`), respects maintenance windows and per-server locks, and records to upgrade history.
- **Scheduler self-heal** — jobs are reconciled against settings on startup/save, with a banner when an "enabled" job isn't actually scheduled and a scheduler-health surface.

### Changed

- **Performance: eliminated the per-server latest-row N+1** — `/stats/overview`, `/status.json`, `reports/*`, `/metrics`, and the server list now fetch the latest `UpdateCheck` + `ServerStats` per server in one query each (`backend/query_helpers.py`) instead of one query per server.
- **Bulk-select checkbox restyle** ([#71](https://github.com/mzac/apt-ui/pull/71)) — the selection control is now a themed checkbox that stands in for the status dot on hover / when selected, instead of a white native box overlapping the card's status badge.

### Fixed

- **40 verified frontend bugs** ([#61](https://github.com/mzac/apt-ui/issues/61), PR [#63](https://github.com/mzac/apt-ui/pull/63)) — a multi-agent audit (88 raw findings → 40 adversarially-verified: 1 critical, 7 high, 9 medium, 23 low). Highlights: the 2FA login submit path, WebSocket close-code handling and observer/listener leaks in ServerDetail, keying ServerDetail by route id so navigating between servers refreshes, "Upgrade All" honouring the active dashboard filter instead of the whole fleet, the apt-cacher-ng panel crash, NaN settings saves, deep-link tab restoration, cron validation + save-error surfacing, and command-palette focus/highlight correctness.
- **Config-drift count accuracy + hardened JSON parse** ([#71](https://github.com/mzac/apt-ui/pull/71)) — `drift_count` reports the true (uncapped) total while the stored path list stays bounded at 200; the `drift_files` JSON parse is guarded so malformed data can't 500 the server endpoint.
- **Roadmap review hardening** (PRs [#64](https://github.com/mzac/apt-ui/pull/64)–[#70](https://github.com/mzac/apt-ui/pull/70), commit `88f57a5`) — `X-Forwarded-For` is only trusted when the new `TRUST_PROXY_HEADERS` is set; admin-gating on the destinations list, rollback, and the Run page/nav; canary aborts only on *new* failed units; `/api/v1` upgrade actions allowlisted to `upgrade` / `dist-upgrade`; consistent `e instanceof Error` toast handling.

### Security

- **Brute-force lockout, TOTP replay protection, and auth-event logging** (see Added) close the previously-unbounded credential-stuffing surface on the login + 2FA flow.
- **Scoped, expiring API tokens** (see Added) — a leaked calendar-feed URL is no longer equivalent to a full-admin credential.
- **`TRUST_PROXY_HEADERS`** — `X-Forwarded-For` / `X-Real-IP` are ignored for client-IP attribution unless this flag is explicitly set, preventing spoofing of the audit log and lockout counters on non-proxied deployments.

---

## [2026.05.02-01] — 2026-05-02

### Fixed

- **`TypeError: tzinfo argument must be None or of a tzinfo subclass, not type 'str'`** when sending the daily summary, weekly digest, or hitting any maintenance-window endpoint. Same crash class as the earlier reboot-scheduling fix — `datetime.now(tz=)` requires a `tzinfo` subclass, not a string, and `TZ` from the environment is a string. Wrapped the three remaining call sites with `ZoneInfo()`.

### Changed

- **Single source of truth for "now in TZ"** — added `backend.config.now_local()` and routed every tz-aware `datetime.now()` callsite through it (scheduler, notifier daily summary, weekly digest, maintenance-window helpers). The `ZoneInfo` is constructed once at module import. Future code that needs the current local time should `from backend.config import now_local` rather than re-wrapping `TZ` at the callsite — eliminates the recurring class of bug above.

---

## [2026.05.01-03] — 2026-05-01

### Added

- **Slack notifications** ([#53](https://github.com/mzac/apt-ui/issues/53)) — first-class Slack channel via incoming-webhook URL, alongside the existing email/Telegram/webhook channels. Block Kit messages with header + section blocks; long upgrade output gets a code-fenced section truncated to ~2900 chars to stay within Slack's per-block limit. Settings → Notifications gains a Slack section (mirroring Telegram's UI) plus a Slack column in the per-event toggle matrix. Test endpoint at `POST /api/notifications/test/slack`.
- **Fleet-wide CVE inventory page** ([#54](https://github.com/mzac/apt-ui/issues/54)) — new `/security` page that pivots the CVE matcher (#37) data from per-package to CVE → servers. No new collection — reads existing `packages_json` annotations and the `cve_cache.json` index. Filters: severity multi-select chips, status segmented control (pending / fixed / partial), group / tag dropdown. Default view is CVE → servers with expandable rows that list affected hosts + jump-to-Packages buttons. Toggle to Server → CVEs alt view. Severity-coloured badges link out to `ubuntu.com/security/notices`. CSV export.
- **Rolling reboot orchestration** ([#56](https://github.com/mzac/apt-ui/issues/56)) — fleet-wide rolling reboot of servers with `reboot_required`. Mirrors the staged-rollout (#41) ring grouping: servers grouped by `ring:*` tag (alphabetical, `ring:default` for untagged), processed in batches of `reboot_batch_size` with `reboot_batch_wait_minutes` between batches. Aborts if any server in the previous batch failed to come back within `reboot_timeout_minutes`. New `/api/ws/reboot-all` WebSocket multiplexes per-server status with `rebooting` → `waiting` → `back` / `failed` phases. Dashboard fleet summary bar gains a "Reboot All Pending" button when ≥ 1 server has `reboot_required`.
- **Weekly patch digest email** ([#58](https://github.com/mzac/apt-ui/issues/58)) — closes the deferred portion of #51. Sent on a configurable cron (default Monday 09:00 in `TZ`) across email (HTML + text), Telegram (markdown, chunked), and webhook (structured JSON with `event="weekly_digest"` discriminator). Slack inherits the master enable but does not yet have a per-channel toggle. Sections: headline counters, by-server table, still-pending list, CVE summary, health flags (offline > 24 h, /boot < 10%, kernel > 180 d, EOL < 90 d). Test endpoint at `POST /api/notifications/test-weekly-digest`. New APScheduler `weekly_digest` job re-registered live when settings change.

### Changed

- **Top-nav layout** — Settings has moved from the end of the main nav to the right cluster, next to user info / logout. It's an admin/account-level page, not a daily-browse view, so it belongs with the user controls. New layout: `apt-ui · Dashboard · History · Templates · Compare · Search · Security · Reports` on the left; `bell · ⌘K · ☀ · GH · Settings · admin Logout` on the right.

### Fixed

- **GHCR image tagging** — the release workflow used `docker/metadata-action`'s `type=semver` rules, which require strict SemVer tags (`1.2.3`). Date-based tags like `2026.05.01-02` didn't match, so the workflow silently produced only `:latest` and never the per-version tag. Switched to `type=ref,event=tag` so any tag format produces both `:latest` and the literal version tag. Also added a `workflow_dispatch` trigger with a tag input so previously-misbuilt releases can be backfilled without recreating the GitHub release.

---

## [2026.05.01-02] — 2026-05-01

### Added

- **OS EOL countdown badges** ([#57](https://github.com/mzac/apt-ui/issues/57)) — server cards and the Settings → Servers table now show a 🕒 badge when the OS reaches end-of-life within 365 days (cyan ≥ 90d, amber 30–90d, red < 30d or expired). Hardcoded EOL table covers Ubuntu 20.04+, Debian 11+, Raspbian 11+, Proxmox VE 7+, Proxmox Backup Server 2+, and Proxmox Mail Gateway 7+. Tooltip on Ubuntu LTS hosts surfaces the "ESM available via Ubuntu Pro" note. Fleet summary bar gains a matching "EOL soon" filter chip. No new collection — reuses existing `os_info`.
- **iCal feed for maintenance windows** ([#59](https://github.com/mzac/apt-ui/issues/59)) — subscribable RFC 5545 calendar at `GET /api/calendar.ics?token=<api_token>`. One VEVENT per enabled MaintenanceWindow with weekly RRULE matching the days-of-week bitmask; per-server windows include the server name in SUMMARY. Auth via the existing API token system (#38) — query param because calendar clients can't carry bearer headers. Settings → Maintenance Windows gains a "Subscribe in Calendar" button with an inline token mint. No new dependencies — iCal is hand-rolled.
- **Command palette (Ctrl+K)** ([#55](https://github.com/mzac/apt-ui/issues/55)) — global fuzzy-search modal opened with Ctrl+K / Cmd+K. Searches servers (by name or hostname), pages, settings sub-tabs, recent jobs, recent servers (capped at 5, persisted to `localStorage`), and quick actions (Check All, Refresh All, New template, Add server, Logout). Self-contained matcher with prefix and word-start bonuses; no new npm deps. Keyboard-only navigation; Tab cycles category chips. A small ⌘K hint button sits in the top nav.

### Fixed

- **PBS / PMG hosts misidentified as Proxmox VE for EOL** — Proxmox Backup Server and Proxmox Mail Gateway hosts share the `-pve` kernel suffix with PVE, so the `os_info` detection script's kernel-fallback branch was labeling them "Proxmox VE" and matching them against the PVE EOL table (a PBS host got flagged as expired PVE 7). The script now probes `proxmox-backup-manager` and `pmgversion` before the kernel fallback, and the EOL table has separate `proxmox-ve` / `proxmox-pbs` / `proxmox-pmg` entries. Existing PBS/PMG hosts in the DB are corrected on the next Refresh All.

---

## [2026.05.01-01] — 2026-05-01

### Added

- **GitHub release check** ([#13](https://github.com/mzac/apt-ui/issues/13)) — backend polls `/repos/.../releases/latest` every 6 hours; a cyan dismissable banner appears in the app layout when a newer version of apt-ui is available.
- **TOTP two-factor authentication** ([#18](https://github.com/mzac/apt-ui/issues/18)) — time-based OTP with QR code enrolment in Settings → Account. Login flow requests a 6-digit code when 2FA is enabled; disable requires password confirmation. Secret stored Fernet-encrypted in DB. Requires `pyotp` + `qrcode`.
- **Held package management** ([#26](https://github.com/mzac/apt-ui/issues/26)) — per-package "📌 Hold" button in the Packages tab tooltip; ✕ unhold button on held-package chips. Backend wraps `apt-mark hold/unhold` with validated package names.
- **Pre/post-upgrade hooks** ([#29](https://github.com/mzac/apt-ui/issues/29)) — define shell commands to run before or after every upgrade; stored in a new `upgrade_hooks` table; managed in Settings → Schedule. Pre-hook failure aborts the upgrade; post-hooks always run. Scope: global or per-server.
- **SSH command audit log** ([#30](https://github.com/mzac/apt-ui/issues/30)) — every SSH command dispatched by the backend is recorded in a new `ssh_audit_log` table (command, exit code, duration, 4 KB output excerpt). Accessible as a sub-tab in the History page with server filter, expandable rows, and pagination. Pruned by the existing log-retention job.
- **Pre-upgrade snapshot banner** ([#35](https://github.com/mzac/apt-ui/issues/35)) — snapshot capability (BTRFS, ZFS, LXC) detected during stats collection; the Upgrade tab shows a 📸 cyan banner with a copy-pastable pre-hook command matched to the detected filesystem type.
- **Reboot-after-upgrade option** ([#36](https://github.com/mzac/apt-ui/issues/36)) — checkbox in Upgrade tab and Upgrade All modal that auto-reboots a server after a successful upgrade if `/var/run/reboot-required` exists. Triggers the existing post-reboot check job.
- **API tokens for automation** ([#38](https://github.com/mzac/apt-ui/issues/38)) — long-lived bearer tokens for `curl`/CI/scripts. Settings → Account → API Tokens lets you mint, list, and revoke tokens. Format: `aptui_<32 url-safe bytes>`. Stored as scrypt hash; raw value shown only on creation. Coexists with cookie auth.
- **Maintenance windows** ([#40](https://github.com/mzac/apt-ui/issues/40)) — `maintenance_windows` table + `/api/maintenance/*` CRUD endpoints. Global windows (server_id=NULL) and per-server overrides. Auto-upgrade scheduler skips servers inside a deny window. Bitmask days-of-week + minute-of-day start/end with midnight-wrap support. Settings form in Settings → Schedule.
- **Service health panel** ([#42](https://github.com/mzac/apt-ui/issues/42)) — new "Health" tab on Server Detail. On-demand SSH probe collects `systemctl --failed`, last 20 boot-priority `journalctl` errors, and recent reboot history. Restart-service button per failed unit.
- **Disk-space alerts for /boot** ([#43](https://github.com/mzac/apt-ui/issues/43)) — `/boot` free/total MB collected during checks; red dashboard badge when free < 100 MB or < 10%. Hidden for servers without a separate `/boot` partition.
- **Kernel age badge** ([#44](https://github.com/mzac/apt-ui/issues/44)) — install date of the running kernel (`mtime /lib/modules/$(uname -r)`) collected during checks. Dashboard card shows "🐧 87d" when older than 60 days; red tint when older than 180 days.
- **Prometheus /metrics endpoint** ([#45](https://github.com/mzac/apt-ui/issues/45)) — exposes fleet state (`apt_ui_pending_packages`, `apt_ui_servers_reachable`, `apt_ui_kernel_age_days`, `apt_ui_disk_usage_percent`, etc.) for Grafana / VictoriaMetrics scraping. Optional `METRICS_TOKEN` env var enables bearer-token auth.
- **Fleet-wide package search** ([#46](https://github.com/mzac/apt-ui/issues/46)) — new Search page. Type a package name to see which servers have it installed and at which version. Highlights diverging versions. Filter by installed/missing/all; exact and prefix search modes.
- **Saved filter views** ([#47](https://github.com/mzac/apt-ui/issues/47)) — dashboard filter state (search, group, tag, status, sort, view) syncs to URL query parameters. Bookmark or share specific views; filters survive reload.
- **Copy SSH command button** ([#48](https://github.com/mzac/apt-ui/issues/48)) — clipboard icon next to hostname on dashboard cards and Server Detail copies `ssh user@host -p port` to clipboard. Includes `execCommand` fallback for non-secure contexts.
- **Public status page** ([#50](https://github.com/mzac/apt-ui/issues/50)) — `/status.json` returns a compact fleet health snapshot for external dashboards. Disabled by default; enable with `STATUS_PAGE_PUBLIC=true`. Hostnames omitted unless `STATUS_PAGE_SHOW_NAMES=true`. Title configurable with `STATUS_PAGE_TITLE`.
- **RBAC: read-only vs admin roles** ([#39](https://github.com/mzac/apt-ui/issues/39)) — `require_admin` dependency 403s non-admin users on ~28 mutation endpoints (servers, groups, tags, templates, scheduler, notifications, maintenance, aptcache, apt_repos, config_io). New Users tab in Settings (admin-only) for user CRUD and role assignment. `cli create-user` gains `--readonly`. Frontend shows a "read-only" badge when `is_admin` is false.
- **CVE matcher** ([#37](https://github.com/mzac/apt-ui/issues/37)) — daily APScheduler job (04:15 local) fetches the Ubuntu USN database (capped at 5 most recent USNs/package). `check_server` annotates each pending package with matching USNs. Severity-coloured 🛡 badge in the Phased column; tooltip lists USN-IDs, CVE-IDs, with links to ubuntu.com/security/notices. New endpoints `GET /api/cve/status`, `POST /api/cve/refresh`.
- **Staged rollout / upgrade rings** ([#41](https://github.com/mzac/apt-ui/issues/41)) — auto-upgrade groups servers by their `ring:*` tag (alphabetical: `ring:test` → `ring:prod`); servers with no ring tag go in `ring:default`. Between rings, sleeps `ring_promotion_delay_hours` and aborts the rollout if any UpdateHistory error appeared during the previous ring's window. UI controls in Preferences → Auto-upgrade.
- **Bulk hold/unhold packages** ([#49](https://github.com/mzac/apt-ui/issues/49)) — `POST /api/servers/bulk-hold` takes a server_ids list + package + hold flag, runs `apt-mark` in parallel. Search page gains Hold/Unhold buttons on each result row (admin-only).
- **Compliance / SLA reports** ([#51](https://github.com/mzac/apt-ui/issues/51)) — new Reports page with three canned reports: **Patch Coverage** (% checked in 24h/7d/30d), **Upgrade Success Rate** (per-server tally over a window), **Security SLA** (days from first security update appearing to it being cleared, vs configurable SLA). Each exports as CSV.
- **Autoremove All fleet operation** — clicking the Autoremove badge in the fleet summary bar opens a modal to run `apt-get autoremove` across all eligible servers simultaneously; multiplexed output streamed live with per-server filter chips and background job tracking.
- **`make ci`** — new Makefile mirrors GitHub Actions checks (Python syntax, backend imports, frontend build). `make venv` bootstraps a Python venv. `make help` lists all targets.

### Changed

- **Project renamed** from apt-dashboard to apt-ui ([#7](https://github.com/mzac/apt-ui/issues/7)) — cookie name is now `apt_ui_token`, default DB path is `/data/apt-ui.db`, Docker service/volume names and export filenames updated throughout. Existing databases at the old path (`/data/apt-dashboard.db`) are automatically migrated on first start with no data loss.

### Fixed

- **Refresh now also detects reboot-required** ([#34](https://github.com/mzac/apt-ui/issues/34)) — closing as already-fixed: `check_server` runs the reboot-required test in the parallel batch regardless of `skip_apt_update`.
- **Reboot scheduling crash** — `TypeError: tzinfo argument must be None or of a tzinfo subclass` when rebooting a server; `TZ` env string is now wrapped with `ZoneInfo()` before being passed to `datetime.now()`.
- **Shell injection (CWE-78)** — added `_validate_package_names()` regex check applied to selective upgrade, autoremove, and template apply endpoints.
- **Telegram notification log false-success** — multi-chunk Telegram messages now correctly log `success=False` if any chunk is rejected by the API.
- **`_get_lock` race** — switched to `setdefault` for atomic creation of per-server upgrade locks.
- **`lock.locked()` fast-path race** — replaced check-then-acquire pattern with a `_upgrade_running` set, eliminating a TOCTOU race where two concurrent requests could both pass the "already running" check.
- **Dead `_do` function in `ws_upgrade_all`** — removed identical-but-uncalled function alongside `_do_tracked`.
- **Daily summary date inconsistency** — both subject and body now use the configured `TZ` instead of mixing local and UTC.

### Security

- **postcss** updated from 8.5.8 → 8.5.13 — fixes XSS via unescaped `</style>` tags in CSS output (Dependabot).
- **Regex injection hardening** — package filter input is now validated against a character allowlist and length cap before `re.compile()`, preventing ReDoS and injection via the package filter endpoint (CodeQL).
- **Stack trace exposure** — release check and server endpoints no longer return raw exception messages or third-party API status codes to the client; errors are logged internally and a generic message returned (CodeQL).
- **API token hashing** — switched from SHA-256 to `hashlib.scrypt` (memory-hard); tokens remain deterministically verifiable with no storage migration needed (CodeQL).

---

## [2026.04.13-01] — 2026-04-13

### Features

- **New dependency package detection** — the Packages tab now runs `apt-get dist-upgrade --dry-run` in parallel during every check to detect packages that will be installed as new dependencies (e.g. a new kernel version pulled in when upgrading `linux-generic`) ([#33](https://github.com/mzac/apt-ui/issues/33)). These do not appear in `apt list --upgradable` and were previously invisible in the UI. Changes:
  - A **New Packages** section appears below the upgradable packages table listing each new dependency with a 🐧 icon for kernel packages
  - An amber warning banner appears when new dependency packages are detected, explaining that `dist-upgrade` is required and that a reboot will be needed after a kernel install
  - Packages that `apt-get upgrade` leaves "kept back" (because they have new dependencies) are flagged with an amber **kept back** badge and amber row tint; the banner text adapts to explain the distinction

### Bug Fixes

- **Compare page**: fixed `object dict can't be used in 'await' expression` caused by incorrectly awaiting the synchronous `_connect_options()` helper
- **Compare page**: fixed `multiple values for keyword argument 'port'` caused by passing `port=` both explicitly and inside the dict returned by `_connect_options()`

---

## [2026.04.12-01] — 2026-04-12

### Features

- **Server reachability monitoring** — a lightweight TCP ping job runs every 5 minutes (independent of the hourly SSH check) to detect whether each server's SSH port is reachable ([#31](https://github.com/mzac/apt-ui/issues/31)). Reachability is stored in `servers.is_reachable` + `servers.last_seen`. Offline servers get a red left-border and an "offline — TCP unreachable" banner on their dashboard card; the card is dimmed to 60% opacity. An **Offline** counter appears in the fleet summary bar when any enabled server is unreachable.
- **Notification history log** — every outbound notification (email, Telegram, webhook) is now recorded in a new `notification_log` table ([#27](https://github.com/mzac/apt-ui/issues/27)). The **History** page now has two sub-tabs: **Upgrade History** (existing) and **Notification History** (new), showing time, channel, event type, summary, and success/failure for each notification sent.
- **Multi-server package comparison** — new **Compare** page lets you select any combination of servers and compare their full installed package inventories side-by-side ([#28](https://github.com/mzac/apt-ui/issues/28)). Packages are fetched on demand via `dpkg-query` over SSH. Three filter modes: **Diverged** (packages where versions differ across servers, default), **Common** (same version everywhere), and **All**. Package name search. Rows where versions diverge are amber-tinted; missing packages shown as "—".
- **Proxmox VE awareness** — servers running Proxmox VE are now detected automatically from `os_info` ([#32](https://github.com/mzac/apt-ui/issues/32)). In the Upgrade tab, a warning banner explains why `pveupgrade` is the safe upgrade path on PVE hosts, with a dedicated **Run pveupgrade** button that streams `apt-get update` + `pveupgrade --force` output live via WebSocket. In the Packages tab, PVE-managed packages (`pve-*`, `proxmox-*`, etc.) are highlighted with a 🔶 icon and an amber row background.

### Bug Fixes

- **Compare endpoint**: fixed `await` on a synchronous `_connect_options()` call that caused `object dict can't be used in 'await' expression` errors for all servers.
- **Compare endpoint**: fixed `multiple values for keyword argument 'port'` caused by passing `port=` both explicitly and inside the `_connect_options` dict.

---

## [2026.04.11-02] — 2026-04-11

### Features

- **apt proxy detection & management** — apt-ui now detects and displays the configured apt HTTP proxy on each managed server ([#16](https://github.com/mzac/apt-ui/issues/16)). The proxy URL (or `auto-apt-proxy`) is collected during check-all and shown as a `⚡ proxy` indicator on dashboard server cards. A new "apt HTTP Proxy" panel in the server edit form lets you enable/disable the proxy with two modes: **Manual URL** (writes `Acquire::http::Proxy` to `/etc/apt/apt.conf.d/01proxy`) or **auto-apt-proxy** (installs the `auto-apt-proxy` Debian package, which uses DNS SRV `_apt_proxy._tcp` for zero-config proxy discovery on networks with the appropriate DNS record). Disabling removes the config file and/or uninstalls the package. SSH terminal output is streamed live in the UI. Proxy state is stored in `server_stats.apt_proxy`.
- **Clickable apt-cacher-ng compact cards** — the apt-cacher-ng server cards in the fleet summary bar are now clickable ([#25](https://github.com/mzac/apt-ui/issues/25)). Clicking any card opens a full detail modal overlaying the dashboard, showing the complete `AptCacheWidget` view with hit rate chart and log analysis. The modal closes with Escape or a backdrop click. Cards also now correctly display data-served totals even when the daily log analysis table has no rows (i.e. on fresh instances before the first log rotation).
- **Bulk delete servers in Settings** — the server table in Settings now supports multi-select checkboxes ([#20](https://github.com/mzac/apt-ui/issues/20)). A header checkbox selects/deselects all (with indeterminate state when partially selected). A floating bulk-action bar appears above the table when any servers are selected, showing the count and a "Delete Selected" button with confirmation. Selected rows are highlighted. Individual delete still works as before.

### Improvements

- **Dashboard card visual hierarchy** — server cards now separate user-defined labels (groups and tags, shown as colour-coded badge boxes, capped at 4 with `+N` overflow) from actionable status indicators (plain coloured text: `⚡ proxy`, `🐳 docker`, `↻ reboot required`, `⬆ eeprom update`, `🛡 no-auto`, held-package count, removable-package count). Up-to-date indicators (eeprom current, auto-security enabled) are no longer shown — only items that require attention are surfaced. Tag overflow is capped to a single `flex-nowrap` row to keep card heights consistent across the fleet.

---

## [2026.04.11-01] — 2026-04-11

### Features

- **Refresh All** — new toolbar button that reads each server's existing local apt cache without running `apt-get update` ([#8](https://github.com/mzac/apt-ui/issues/8)). Much faster than Check All; useful when you want a quick status snapshot without pulling fresh package index data. Separate backend endpoint `POST /api/servers/refresh-all` (and single-server `POST /api/servers/{id}/refresh`).
- **Hover tooltips on Check All / Refresh All** — hovering either button shows a popover explaining what it does and when to use it ([#9](https://github.com/mzac/apt-ui/issues/9)).
- **Fleet-wide pending updates modal** — clicking the Updates or Security count in the fleet summary bar, or the "All Updates" toolbar button, opens a scrollable portal modal listing every pending package across all servers, grouped by server ([#10](https://github.com/mzac/apt-ui/issues/10)). Security packages appear first (🔒, red tinted row) with version deltas; phased updates are badged. Package data is fetched on demand when the modal opens.
- **GitHub repository link in nav** — GitHub icon in the top navigation bar links to the apt-ui repository ([#11](https://github.com/mzac/apt-ui/issues/11)).
- **Version in footer** — the running app version is displayed in the page footer ([#12](https://github.com/mzac/apt-ui/issues/12)). Baked in at Docker build time via `VITE_APP_VERSION` build arg (set from the Git tag in the release workflow); shows `dev` for local builds.
- **Phased column in packages table** — the packages table in Server Detail now has a dedicated Phased column with a styled badge, replacing the inline `[phased]` text appended to the package name ([#15](https://github.com/mzac/apt-ui/issues/15)).
- **Always show Reboot button preference** — new toggle in Settings → Preferences → Display (stored in `localStorage`) that makes the Reboot button always visible on server cards and in Server Detail, regardless of whether the server reports a reboot is required ([#17](https://github.com/mzac/apt-ui/issues/17)).
- **Add Server as scrollable modal** — the Add Server form is now a portal modal overlay instead of an inline panel; scrollable for mobile and small screens; dismissible via ✕, backdrop click, or Cancel ([#21](https://github.com/mzac/apt-ui/issues/21)).
- **Generate SSH key pair from dashboard** — new "⚡ Generate Key Pair" button inside the Add Server SSH key section ([#23](https://github.com/mzac/apt-ui/issues/23)). Calls the new `POST /api/servers/generate-ssh-key` backend endpoint (Ed25519 via the `cryptography` library), auto-populates the private key field, and displays the public key with a one-click Copy button and instructions to add it to `authorized_keys`.
- **More prominent per-server SSH key field** — the SSH key section in the Add Server form is now wrapped in a visible bordered card with a 🔑 icon and bolder label so it is no longer easy to miss ([#22](https://github.com/mzac/apt-ui/issues/22)).

### Bug Fixes

- **History page crash when expanding a row** — clicking a history row caused a blank page with React error #31 ([#24](https://github.com/mzac/apt-ui/issues/24)). Root cause: `packages_upgraded` is stored as `{name, from_version, to_version}` objects but was typed as `string[]` and rendered directly as React children. Fixed the TypeScript type in `types/index.ts` and updated the renderer in `History.tsx` to display `name: from → to`.

### CI/CD

- Docker release images are now also tagged with the semver version number in addition to `latest` (confirmed already implemented via `docker/metadata-action` — [#14](https://github.com/mzac/apt-ui/issues/14)).
- `APP_VERSION` Docker build arg added to `Dockerfile`; release workflow passes the Git tag via `build-args: APP_VERSION=${{ github.ref_name }}`.

---

## [2026.04.07-02] — 2026-04-07

### Dependencies
- Bumped `lodash` from 4.17.23 to 4.18.1 (Dependabot)

---

## [2026.04.07-01] — 2026-04-07

### Dependencies
- Bumped `vite` dev dependency (Dependabot)

---

## [2026.03.28-01] — 2026-03-28

### Features
- **Apt repo management** — new "Apt Repos" tab; read, edit, create, and delete apt source files directly from the UI; "Test with apt-get update" streams live output
- **dpkg log history** — new "dpkg Log" tab parses `/var/log/dpkg.log` and all rotated archives on demand; filterable by package name, action type, and time window
- **.deb package installation** — install `.deb` files by URL or browser upload; both paths stream `dpkg -i` + `apt-get install -f` output live

### Improvements
- Server detail tabs reordered into logical groups
- Added `ARCHITECTURE.md` with full Mermaid application and CI/CD pipeline diagrams
- Added `SECURITY.md` with vulnerability reporting process and security model documentation

### Security Fixes
- Fixed SSRF vulnerability in `.deb` URL validation endpoint (CodeQL `py/full-ssrf`)
- Fixed stack trace exposure in error responses (CodeQL `py/stack-trace-exposure`)

### CI/CD
- Updated all GitHub Actions to latest versions

---

## [2026.03.26-02] — 2026-03-26

### Features
- **Outbound webhooks** — HMAC-SHA256 signed POST to a configurable URL for all notification events
- **Per-trigger webhook toggles** — each of the 5 notification triggers has independent email/Telegram/webhook toggles
- **"Security updates found" notification** — fires after every check-all when any server has security packages pending
- **"Reboot required" notification** — fires after every check-all when any server requires a reboot
- **Daily summary enhancements** — includes reboot and EEPROM firmware status; per-channel guards enforced

---

## [2026.03.26-01] — 2026-03-26

### Features
- **Dark/light theme toggle** — CSS custom properties with `localStorage` persistence
- **Dashboard staleness indicator** — server card timestamp turns amber when last check is >12 h old
- **Fleet summary EEPROM counter** — shown when any Pi has a firmware update available
- **Server notes** — free-text notes field in server detail and edit form
- **Upgrade dry-run preview** — collapsible panel shows what `apt-get upgrade` would do before committing
- **Cron validation in Schedule tab** — human-readable description and live error feedback for cron expressions
- **Reboot confirmation modal** — portal overlay with backdrop blur replaces inline confirm buttons
- **Docker host detection** — detects when a managed server is the Docker host; blocks upgrades of container-runtime packages
