#!/usr/bin/env bash
# Nationwide pass: one long scan run; each finished cell is saved immediately.
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/postgres" DB_POOL_MAX=1 S2_BUDGET_MINUTES=600 S2_CONCURRENCY=4
npm run pipeline -- --only=cdse-sentinel-2 2>&1 | grep --line-buffered "\[pipeline\]" | grep --line-buffered -v skipped
