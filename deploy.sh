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

# --- Verify the new container actually came up ------------------------------
# `docker compose up -d` returns as soon as the container is STARTED, not when
# the app inside it is serving. Without this gate a deploy that crashes on boot
# — a typo'd or missing env var is the realistic cause, and config.py's
# extra="ignore" means only a MISSING required setting fails loudly — exits 0
# here, which makes the GitHub Actions deploy job go green while the API is
# down. That is the worst possible combination: broken in production, and
# nothing telling you.
#
# Polls the image's own HEALTHCHECK (see backend/Dockerfile: GET / , which is
# the dependency-free liveness ping and never touches Supabase). On failure it
# prints the logs that explain why and exits non-zero, so CI goes red.
echo "==> Waiting for backend to report healthy"
for attempt in $(seq 1 30); do
    status="$(docker inspect --format '{{.State.Health.Status}}' ironlog-backend 2>/dev/null || echo missing)"
    case "$status" in
        healthy)
            echo "    backend healthy after ${attempt} check(s)"
            break
            ;;
        unhealthy)
            echo "error: backend container reported unhealthy. Recent logs:" >&2
            docker compose logs --tail 60 backend >&2
            exit 1
            ;;
    esac
    if [ "$attempt" -eq 30 ]; then
        echo "error: backend did not become healthy within ~60s (last status: ${status}). Recent logs:" >&2
        docker compose logs --tail 60 backend >&2
        exit 1
    fi
    sleep 2
done

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
SQL editor (sql/schema.sql).
EOF
