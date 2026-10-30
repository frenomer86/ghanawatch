#!/usr/bin/env bash
# Deploy the committed code from this PC to the VPS and (re)start the stack.
#   deploy/deploy.sh root@<VPS_IP>
# Requires: the SSH key ~/.ssh/ghanawatch_deploy added to the VPS, and
# /opt/ghanawatch/.env.production present on the server (see .env.production.example).
set -euo pipefail
HOST="${1:?usage: deploy/deploy.sh root@<VPS_IP>}"
KEY="${GW_SSH_KEY:-$HOME/.ssh/ghanawatch_deploy}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
REV="$(git rev-parse --short HEAD)"

echo "Packaging commit $REV"
git archive --format=tar.gz -o /tmp/ghanawatch-$REV.tar.gz HEAD
scp -i "$KEY" -o StrictHostKeyChecking=accept-new /tmp/ghanawatch-$REV.tar.gz "$HOST:/tmp/"

$SSH "$HOST" bash -s <<REMOTE
set -euo pipefail
cd /opt/ghanawatch
test -f .env.production || { echo "Missing /opt/ghanawatch/.env.production"; exit 1; }
find . -mindepth 1 -maxdepth 1 ! -name .env.production -exec rm -rf {} +
tar -xzf /tmp/ghanawatch-$REV.tar.gz
echo "$REV" > REVISION
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d db
docker compose --env-file .env.production run --rm pipeline npm run setup
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
REMOTE
echo "Deployed $REV to $HOST"
