# ── Stage 1: build the React frontend ─────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./

# Bake the version into the frontend bundle at build time.
# Pass --build-arg APP_VERSION=v1.2.3 to set it; defaults to "dev".
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION

RUN npm run build
# Output: /app/frontend/dist/


# ── Stage 2: Python runtime ────────────────────────────────────────────────
FROM python:3.12-slim

# openssh-client is not required by asyncssh but useful for manual debugging
# inside the container (e.g. ssh -i ... user@host)
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Re-declare the build-arg so it's available in stage 2 too, then bake into env
# so the backend can report it (issue #13 — GitHub release check).
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend into static/ (FastAPI serves this as a SPA)
COPY --from=frontend-build /app/frontend/dist/ ./static/

# Ensure the backend package is importable from /app
ENV PYTHONPATH=/app

# Data volume mount point
VOLUME ["/data"]

EXPOSE 8000

# The CLI tool is accessible via:
#   docker exec -it <container> python -m backend.cli <command>
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
