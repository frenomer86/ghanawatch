#!/usr/bin/env bash
# Build detector 3.0's monthly record back in time, in the background, from the Hostinger Web Console:
#
#   bash /opt/ghanawatch/deploy/console-backfill.sh 2     # the mining belt first (about 9 TB, two weeks)
#   bash /opt/ghanawatch/deploy/console-backfill.sh 1     # then the rest of Ghana
#   docker logs -f --tail 50 gw-backfill                  # watch it (Ctrl+C stops watching, not the job)
#
# Resumable: run it again after a reboot and it continues each cell where it stopped. While it runs, the live
# pipeline keeps the two-date scan going (GW_DETECTOR=legacy in .env.production); once it has finished, set
# GW_DETECTOR=multisensor there and run deploy/console-update.sh, and the monthly record takes over cell by cell.
set -euo pipefail
PRIORITY="${1:-2}"
cd /opt/ghanawatch
LAST="$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"
docker rm -f gw-backfill >/dev/null 2>&1 || true
docker compose --env-file .env.production run -d --name gw-backfill pipeline \
  npm run pipeline:history-ts -- --to="${LAST}" --priority="${PRIORITY}" --concurrency=4
echo "Backfill started up to ${LAST} for cells of priority ${PRIORITY} and above. Watch it: docker logs -f --tail 50 gw-backfill"
