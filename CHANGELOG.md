# Changelog

All notable changes to apt-ui are documented here.

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
