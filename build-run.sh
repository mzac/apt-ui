#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Building and starting apt-ui..."
docker compose up --build -d

echo ""
echo "==> Container logs (Ctrl+C to stop following):"
docker compose logs -f
