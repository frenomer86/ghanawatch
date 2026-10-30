#!/usr/bin/env bash
# GhanaWatch scheduler: the monthly release and the weekly digest on fixed days, inside the pipeline image.
#
#   first Monday of the month, 06:00 GMT            → npm run release                 (last month; refuses while the sample is unchecked)
#   the Wednesday five days before that, 06:00 GMT  → npm run release -- --dry-run    (four days to fix anything)
#   every Monday, 07:00 GMT                         → npm run alerts:weekly
#
# A loop that checks the clock every ten minutes; each job runs at most once a day (marker files), and a
# failed job is retried at the next check.
set -u
MARK_DIR="${SCHEDULER_MARK_DIR:-/app/.data/scheduler}"
mkdir -p "$MARK_DIR"

once_per_day() {
  local name="$1"; shift
  local mark="$MARK_DIR/$name-$(date -u +%F)"
  [ -e "$mark" ] && return 0
  echo "[scheduler] $(date -u +%FT%TZ) $name: $*"
  if "$@"; then touch "$mark"; else echo "[scheduler] $name failed; retrying in ten minutes"; fi
}

# The first Monday (YYYY-MM-DD) of the month that starts on $1 (YYYY-MM-01).
first_monday_of() {
  local d="$1"
  local dow; dow="$(date -u -d "$d" +%u)"          # 1 = Monday
  local add=$(( (8 - dow) % 7 ))
  date -u -d "$d +$add days" +%F
}

while true; do
  today="$(date -u +%F)"
  hour="$(date -u +%-H)"
  dow="$(date -u +%u)"
  this_fm="$(first_monday_of "$(date -u +%Y-%m-01)")"
  next_fm="$(first_monday_of "$(date -u -d "$(date -u +%Y-%m-01) +1 month" +%Y-%m-01)")"
  dry_day="$(date -u -d "$next_fm -5 days" +%F)"

  if [ "$today" = "$this_fm" ] && [ "$hour" -ge 6 ]; then
    once_per_day release npm run release
  fi
  if [ "$today" = "$dry_day" ] && [ "$hour" -ge 6 ]; then
    once_per_day dryrun npm run release -- --dry-run --skip-sample
  fi
  if [ "$dow" = "1" ] && [ "$hour" -ge 7 ]; then
    once_per_day weekly npm run alerts:weekly
  fi
  sleep 600
done
