# ── Stage 1: build the React frontend ─────────────────────────────────────
# Pinned to BUILDPLATFORM: this stage only emits static JS/CSS, which is
# architecture-independent, so it must run natively on the builder rather than
# once per target arch. Without the pin the whole `npm ci` + vite build ran
# under QEMU emulation for the linux/arm64 image — invisible while the buildx
# layer cache was warm, but GitHub evicts that cache after 7 days, so the first
# release built more than a week after the last one took over an hour instead
# of ~4 minutes. The `dist/` output is copied into the final image below, which
# *is* built per target arch.
#
# Base images are pinned by digest (the tag is kept only for readability — the
# digest is what is pulled). Dependabot's `docker` ecosystem bumps both.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Bake the version into the frontend bundle at build time.
# Pass --build-arg APP_VERSION=v1.2.3 to set it; defaults to "dev".
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION

RUN npm run build
# Output: /app/frontend/dist/


# ── Stage 2: Python runtime ────────────────────────────────────────────────
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# openssh-client is not required by asyncssh but useful for manual debugging
# inside the container (e.g. ssh -i ... user@host)
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Re-declare the build-arg so it's available in stage 2 too, then bake into env
# so the backend can report it (issue #13 — GitHub release check).
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Install Python dependencies. requirements.txt is the hash-locked resolution of
# requirements.in; --require-hashes makes pip refuse anything that isn't in it
# byte-for-byte (a re-published or tampered release fails the build).
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# Unprivileged user the app runs as. Fixed numeric ids so volume ownership is
# predictable across image rebuilds and so Kubernetes can name them in
# runAsUser / fsGroup. /data is created and owned here so a *new* named volume
# inherits the right ownership; existing root-owned volumes are migrated by
# docker-entrypoint.sh.
RUN groupadd --system --gid 10001 apt-ui \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home \
        --shell /usr/sbin/nologin apt-ui \
    && mkdir -p /data && chown 10001:10001 /data

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend into static/ (FastAPI serves this as a SPA)
COPY --from=frontend-build /app/frontend/dist/ ./static/

# Ensure the backend package is importable from /app
ENV PYTHONPATH=/app

# Byte-compile at build time: the app user can't write __pycache__ into the
# root-owned /app (and the root filesystem may be read-only), so without this
# every start would recompile every module in memory.
ENV PYTHONDONTWRITEBYTECODE=1
RUN python -m compileall -q /app/backend

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Cap glibc malloc arenas (issue #92). glibc creates up to 8 x cores arenas and
# memory freed by one thread stays parked in that thread's arena, so with the
# ~20 threads this process runs (uvicorn, the aiosqlite worker, the default
# executor) RSS ratcheted from ~110 MiB to ~1.3 GiB over a week with no
# Python-level leak behind it. Two arenas costs a little allocator contention,
# which is irrelevant for an I/O-bound app. Override with -e MALLOC_ARENA_MAX=…
ENV MALLOC_ARENA_MAX=2

# Data volume mount point
VOLUME ["/data"]

EXPOSE 8000

# No `USER` instruction on purpose: the entrypoint starts as root only to hand
# a root-owned /data volume (from pre-2026.11 images) to uid 10001, then drops
# to that user with no-new-privs before exec'ing the app. Run with
# `--user 10001:10001` (or Kubernetes runAsUser) to never be root at all.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The CLI tool is accessible via:
#   docker exec -it <container> python -m backend.cli <command>
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
