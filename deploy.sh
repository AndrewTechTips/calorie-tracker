#!/usr/bin/env bash
# Iron Log — production deploy script for a bare-metal Ubuntu host.
#
# Run this ON THE SERVER (not locally). First-time setup:
#   1. Install Docker Engine + the Compose plugin (docs.docker.com/engine/install/ubuntu/)
#   2. Point your API domain's DNS A/AAAA record at this server
#   3. git clone <this-repo-url> ironlog && cd ironlog
#   4. cp .env.example .env && edit it with real values
#   5. ./deploy.sh
#
# Every subsequent deploy is just: cd ironlog && ./deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

if [ ! -f .env ]; then
    echo "error: .env not found. Run: cp .env.example .env, then fill it in." >&2
    exit 1
fi

echo "==> Pulling latest main"
git fetch origin
git checkout main
git pull --ff-only origin main

echo "==> Building backend image"
docker compose build backend

echo "==> Starting stack (detached)"
docker compose up -d

echo "==> Pruning dangling images from previous builds"
docker image prune -f

echo "==> Status"
docker compose ps

cat <<'EOF'

Deployed. Useful follow-ups:
  docker compose logs -f backend    # tail backend logs
  docker compose logs -f traefik    # tail proxy logs / ACME issuance
  docker compose ps                 # container health

Reminder: this stack has no database container — the app talks to Supabase
directly (see docker-compose.yml's own comment). There is nothing to
migrate/seed on this server; schema changes still go through the Supabase
SQL editor (sql/schema.sql), same as the Render deployment did.
EOF
