# Changelog

All notable changes to apt-ui are documented here.

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
