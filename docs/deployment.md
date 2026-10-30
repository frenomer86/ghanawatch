# Deploying GhanaWatch on a Hostinger VPS

GhanaWatch is a live system: a web server, a PostGIS database and a data job that refreshes every 3 hours. It cannot be uploaded as a zip to shared hosting (Hostinger web hosting plans offer only MySQL). It runs on a Hostinger **VPS** with Docker.

## What runs on the server

| Container | Role |
|---|---|
| `db` | PostgreSQL 16 + PostGIS 3.4, data on a Docker volume, not exposed to the internet |
| `web` | The Next.js site and `/api/v1`, port 3000 inside the server |
| `pipeline` | Every 3 hours: the national Sentinel-2 galamsey scan and Sentinel-1 radar (a time budget per run, continuing where it stopped), forest-loss alerts, fires, river flood forecasts, the 3-day rain forecast for every district, and the news-signal reader that queues satellite re-checks. Then the confidence rules, licensed-mine marking, waterway tagging and the 72-hour hotspots |
| `scheduler` | The monthly release on the first Monday at 06:00 GMT (dry run the Wednesday before) and the weekly digest on Mondays at 07:00 GMT; writes `public/releases` and `public/alerts` on volumes the website serves |
| `caddy` | HTTPS on ports 80/443 with automatic Let's Encrypt certificates |

Report photos are kept on the `uploads` volume. The firewall allows only SSH, HTTP and HTTPS.

## Plan

Hostinger **KVM 2** (2 vCPU, 8 GB RAM, 100 GB NVMe) with **Ubuntu 24.04** (the "Ubuntu 24.04 with Docker" template if offered). KVM 1 (4 GB) works for the current data, but KVM 2 leaves room for Phase 2 Sentinel processing.

## What the owner does (once)

1. Buy the VPS in hPanel and choose Ubuntu 24.04.
2. In hPanel → VPS → Settings → SSH keys, add the deploy public key:
   `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINfc+xG1fESFTKzTDTjGOB0q7gRMSrWem8rNqkSsbotp ghanawatch-deploy@isaac-pc`
3. Point the domain: an **A record** for the domain (and `www`) to the VPS IP address.
4. Send the VPS IP address and the domain name.

## What the deployer does

```bash
# 1. Prepare the server (once)
ssh -i ~/.ssh/ghanawatch_deploy root@<VPS_IP> 'bash -s' < deploy/bootstrap-server.sh

# 2. Create the production settings on the server (once); secrets never leave the server
scp -i ~/.ssh/ghanawatch_deploy .env.production.example root@<VPS_IP>:/opt/ghanawatch/.env.production
ssh -i ~/.ssh/ghanawatch_deploy root@<VPS_IP>   # edit /opt/ghanawatch/.env.production

# 3. Deploy (first time and every update)
deploy/deploy.sh root@<VPS_IP>
```

`deploy.sh` packages the committed code (about 16 MB uploaded from the PC), uploads it, builds the image, runs migrations and the first-run setup (`npm run setup`: boundaries, source registry, OpenStreetMap context, rivers, drains and wetlands, the scan grid, administrator), and starts all containers. All satellite and map data are then downloaded by the server itself, not the PC. The pipeline container fetches live data immediately and then every 3 hours. Its first run also loads NASA's 2020–2025 fire archive for Ghana (about 100 MB of downloads, about a million rows; a few minutes) for Check this land, then each new year once it is published. The first full pass of the national scan over all 538 areas takes about a day on the server (it runs in time-budgeted steps every 3 hours); the site fills in as areas finish.

No data source needs a key, account or email. The only external services are public downloads (Copernicus Sentinel via Earth Search and the Planetary Computer, NASA FIRMS files, Global Forest Watch tiles, Open-Meteo, JRC water and forest maps, OpenStreetMap via Overpass, public news RSS feeds and GDACS).

## Settings (`.env.production`)

| Variable | Required | Notes |
|---|---|---|
| `DOMAIN` | yes | e.g. `ghanawatch.gov.gh`, no `https://` |
| `PUBLIC_ORIGIN` | yes | `https://` + domain; used in citations and exports |
| `POSTGRES_PASSWORD` | yes | `openssl rand -hex 32` (database owner: migrations and the pipeline) |
| `APP_DB_PASSWORD` | yes | `openssl rand -hex 32` (limited account the website uses: read/write rows, no schema changes) |
| `APP_SECRET` | yes | 32+ random characters (`openssl rand -hex 32`); hashes sessions and IP addresses and seals authenticator keys. The app refuses a placeholder. |
| `RATE_LIMIT_HEAVY_PER_MIN` | no | Land checks, satellite comparisons and rendered pictures per address per minute (default 10); a bounded queue answers 503 when the server is busy |
| `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` | yes | First administrator; password must be changed at first login |
| `NEXT_PUBLIC_MAP_STYLE_URL` | no | Basemap style; default OpenFreeMap |
| `FOREST_LOSS_BUDGET_MINUTES` | no | Time limit for the per-district forest loss job (default 20 minutes; it continues on the next run) |
| `S1_BUDGET_MINUTES`, `S1_MAX_SCENES`, `S1_MAX_CELLS` | no | Radar run limits per pipeline run (defaults 30 minutes, 2 river passes, 40 cloudy cells; the run stops at the time budget) |
| `S2_BUDGET_MINUTES`, `S2_CONCURRENCY` | no | Galamsey scan time limit and parallel cells per pipeline run (defaults 40 minutes, 2). `S2_MIN_AFTER_OBS` is set to 1 in `docker-compose.yml` (the rule measured on 18 Oct 2026) |
| `GFW_ALERTS_BUDGET_MINUTES` | no | Time limit for the forest-loss alert reader (default 30 minutes) |
| `RATE_LIMIT_*` | no | Public API, reports, machinery tags (`RATE_LIMIT_SIGHTINGS_PER_HOUR`, default 30) and login limits |
| `BREVO_API_KEY`, `MAIL_FROM` | no | Brevo transactional email for the weekly digest and subscription confirmations; without it the email sign-up form says alerts are not available yet (the WhatsApp text, RSS and JSON feeds still work) |
| `WHATSAPP_CHANNEL_URL` | no | The channel link shown on `/alerts`; the post text is written to `public/alerts/latest.txt` every Monday |
| `ZENODO_TOKEN` | no | Deposits each release's data files on Zenodo and records the DOI |

`DATABASE_URL` and `DB_POOL_MAX` are set by `docker-compose.yml`.

Ground view's close-up imagery comes from Esri World Imagery (Wayback archive) under Esri's terms of use, with the "Powered by Esri" credit shown on the map; the yearly Sentinel-2 views come from EOX Sentinel-2 cloudless under CC BY-NC-SA 4.0 (non-commercial). Both suit a free public government service; a commercial deployment would need its own licences.

## The historical scan

The index's series before launch is built once with `docker compose run --rm pipeline npm run pipeline:history -- --from=2020-01 --to=2026-09` (resumable; stop and restart freely). It is two to three weeks of compute for the gold belt monthly and the rest quarterly. To spread it, run `npm run pipeline:history -- --out=history-out` on the lab PC and bring the folder back with `--import=history-out`. Then `npm run index:close -- --month=<last full month>` writes every month of the series.

## Operations

- Logs: `docker compose logs -f web` / `pipeline`.
- Status: `/api/v1/freshness` and the admin page show the last pipeline run per source.
- Backups: `docker compose exec db pg_dump -U ghanawatch ghanawatch | gzip > backup-$(date +%F).sql.gz` (schedule daily with cron; also enable Hostinger VPS snapshots).
- Update: commit, then `deploy/deploy.sh root@<VPS_IP>`.
- First sign-in: the seeded administrator must replace `ADMIN_INITIAL_PASSWORD` (the admin page asks) and turn on two-step sign-in before any change is accepted; after that, remove `ADMIN_INITIAL_PASSWORD` from `.env.production`.
- Rate limiting counts per address using the last `X-Forwarded-For` entry, which Caddy sets. Never publish port 3000 directly; only Caddy publishes ports. Caddy also refuses request bodies over 6 MB. The limiter is in-process memory, so it resets on restart and is per container, which is right for one VPS.

## Security posture, in one paragraph

Every input is validated with strict schemas, every SQL statement is parameterised, every admin change needs a same-origin request from a signed-in moderator or administrator with two-step sign-in on and their own password, request bodies are capped at Caddy and again in the app, expensive endpoints have their own rate limit and a bounded queue, and the page policy pins scripts, frames, forms and base URIs to this origin. The one allowance is inline scripts, which Next.js needs for its prerendered pages; the alternative (a per-request nonce) was measured to break every prerendered page, and the site has no place where untrusted HTML is rendered. Dependency audit: `npm audit --omit=dev` must report 0 before a deploy.

## Verified before deployment

The production build, migrations, seed, live pipeline and all 20 browser tests were run against a real PostgreSQL network connection on the development PC, not only the embedded database. This caught and fixed a date-parameter bug that would have left the live map empty on standard Postgres.
