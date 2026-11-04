#!/usr/bin/env bash
# First-time setup from the Hostinger Web Console (hPanel → VPS → Manage → Web Console), after the code has been
# cloned to /opt/ghanawatch (docs/deployment.md, "From the Hostinger Web Console").
#
#   bash /opt/ghanawatch/deploy/console-setup.sh <domain> <administrator email>
#
# Prepares the server (Docker, firewall, security updates, swap), writes .env.production with fresh random secrets
# (they never leave the server), then builds and starts everything. Safe to run again: an existing
# .env.production is kept.
set -euo pipefail
DOMAIN="${1:?usage: console-setup.sh <domain> <administrator email>}"
ADMIN_EMAIL="${2:?usage: console-setup.sh <domain> <administrator email>}"
cd /opt/ghanawatch
bash deploy/bootstrap-server.sh
if [ ! -f .env.production ]; then
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  sed -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
      -e "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://${DOMAIN}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" \
      -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(openssl rand -hex 32)|" \
      -e "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${ADMIN_EMAIL}|" \
      -e "s|^ADMIN_INITIAL_PASSWORD=.*|ADMIN_INITIAL_PASSWORD=${ADMIN_PW}|" \
      .env.production.example > .env.production
  chmod 600 .env.production
  echo
  echo "Administrator: ${ADMIN_EMAIL}"
  echo "Temporary password: ${ADMIN_PW}   (write it down; you must change it at the first sign-in)"
  echo
fi
bash deploy/console-update.sh
