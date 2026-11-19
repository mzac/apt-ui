#!/bin/sh
# apt-ui container entrypoint.
#
# The app runs as an unprivileged user (uid/gid 10001 by default). Images
# before 2026.11 ran as root, so an existing data volume is root-owned and the
# app could not open its own database after an upgrade. To keep `docker compose
# pull && up -d` a complete upgrade, the container *starts* as root, hands the
# data directory to the app user, and then drops privileges for good — the
# process tree that serves requests never has uid 0.
#
# Started as non-root already (Kubernetes `runAsUser`, `docker run --user`)?
# Then there is nothing to drop and nothing we may chown: the volume must
# already be writable (fsGroup / a one-off chown — see README).
set -eu

APP_UID="${APT_UI_UID:-10001}"
APP_GID="${APT_UI_GID:-10001}"
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/apt-ui.db}")"

fail_unwritable() {
    echo "apt-ui: FATAL: data directory $DATA_DIR is not writable by uid $1 (gid $2)." >&2
    echo "apt-ui: fix it once with, e.g.:" >&2
    echo "apt-ui:   docker run --rm -u 0 -v <your-volume>:/data --entrypoint chown <image> -R $1:$2 /data" >&2
    echo "apt-ui: or, on Kubernetes, set securityContext.fsGroup: $2 on the pod." >&2
    exit 1
}

# True when the directory itself and everything already in it is writable by
# the current user. The directory alone is not enough: a volume first created
# by this image is 10001-owned at the top but may hold a root-owned database
# written by an older release.
data_writable() {
    [ -w "$DATA_DIR" ] && [ -z "$(find "$DATA_DIR" ! -writable -print -quit 2>/dev/null)" ]
}

if [ "$(id -u)" != "0" ]; then
    data_writable || fail_unwritable "$(id -u)" "$(id -g)"
    exec "$@"
fi

case "$APP_UID$APP_GID" in
    *[!0-9]*|"") echo "apt-ui: FATAL: APT_UI_UID / APT_UI_GID must be numeric." >&2; exit 1 ;;
esac
if [ "$APP_UID" = "0" ]; then
    echo "apt-ui: WARNING: APT_UI_UID=0 — running as root, as images before 2026.11 did." >&2
    exec "$@"
fi

mkdir -p "$DATA_DIR" 2>/dev/null || true
# Only touch the volume when something in it is actually owned by someone
# else, so a normal start does no writes (and works on a read-only bind mount
# of an already-correct directory tree).
if [ -n "$(find "$DATA_DIR" ! -user "$APP_UID" -print -quit 2>/dev/null)" ]; then
    echo "apt-ui: handing $DATA_DIR to uid $APP_UID:$APP_GID (one-time migration from a root-owned volume)"
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null \
        || echo "apt-ui: WARNING: could not chown $DATA_DIR (root-squashed NFS? missing CAP_CHOWN?)" >&2
fi

# Check as the app user, not as root — root can write where 10001 cannot.
setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups sh -c \
    '[ -w "$1" ] && [ -z "$(find "$1" ! -writable -print -quit 2>/dev/null)" ]' sh "$DATA_DIR" \
    || fail_unwritable "$APP_UID" "$APP_GID"

# --no-new-privs: nothing exec'd from here on can regain privileges via
# setuid binaries or file capabilities.
exec setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups --no-new-privs "$@"
