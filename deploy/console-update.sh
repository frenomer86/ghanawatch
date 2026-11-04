#!/usr/bin/env bash
# Bring the server up to the latest code on GitHub and restart, from the Hostinger Web Console:
#
#   bash /opt/ghanawatch/deploy/console-update.sh
#
# Pulls, builds the image on the server, applies migrations and the idempotent first-run setup, and restarts
# every container. Data (database, uploads, tracker state) lives in Docker volumes and is kept.
set -euo pipefail
cd /opt/ghanawatch
test -f .env.production || { echo "Missing /opt/ghanawatch/.env.production: run deploy/console-setup.sh first"; exit 1; }
git pull --ff-only
git rev-parse --short HEAD > REVISION
DC="docker compose --env-file .env.production"
$DC build
$DC up -d db
$DC run --rm pipeline npm run setup
$DC up -d
$DC ps
echo "GhanaWatch $(cat REVISION) is running: https://$(grep '^DOMAIN=' .env.production | cut -d= -f2)"
