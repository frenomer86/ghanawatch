# GhanaWatch

Ghana's monthly satellite report on its land and rivers. Open satellite and environmental data turned into a national map of vegetation loss, disturbed ground, water changes and flood risk, with exact image dates, confidence and downloadable records; and, on the first Monday of every month, the **Galamsey Index**: a frozen number for every district (hectares newly mined for gold per 100 km²), a league table, river and reserve scorecards, an eight-page report, a press release and open data with a DOI.

Built from the project SRS (*GhanaWatch Project Documentation v1.0*). Design and engineering decisions are in [`docs/architecture.md`](docs/architecture.md) and [`docs/design-direction.md`](docs/design-direction.md).

## Run it locally

Requirements: Node.js 22+. No database install is needed; development uses PGlite (embedded Postgres) in `.data/`.

```bash
npm install
cp .env.example .env.local        # set APP_SECRET (32+ chars) and ADMIN_INITIAL_PASSWORD
npm run seed                      # boundaries, source registry, admin account (no detections)
npm run pipeline                  # fetch live data (satellite scans, fires, forest alerts, rain and river forecasts, news signals)
npm run dev                       # http://localhost:3000
```

Production build: `npm run build && npm run start`.

Keep data current with `npm run pipeline -- --every=180` (refreshes every 3 hours). No sample or simulated data is ever shown.

Sign in at `/admin/login` with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.

## What is here

- `/` the latest closed month of the Galamsey Index: the national figure with its likely range, the trend, the ten districts ranked highest, "find your district"
- `/districts` league table and `/districts/{slug}` scorecards with the frozen monthly series, before/after pairs and the nearest drinking-water intake
- `/rivers` and `/rivers/{slug}` river scorecards: reaches discoloured this month, intakes, dredger radar targets
- `/monthly` releases (PDF, press release, data files, manifest, DOI) and `/monthly/{month}` the frozen report
- `/map` national map (MapLibre, OpenFreeMap basemap), time window, filters, place search, near-me, list in view, detail sheet; every view is a shareable URL
- `/alerts` the weekly digest (email sign-up, WhatsApp channel, RSS and JSON feeds) and the reverse-chronological feed with type and region filters
- `/event/{id}` stand-alone record with dates, confidence, source, citation and GeoJSON download
- `/my-area` device-local watchlist of districts or points
- `/report` moderated ground report (photo, location, text), queued offline
- `/data` filter, preview and download CSV/GeoJSON; `/data/api`, `/data/sources`, `/data/methods` (index definition, versions, corrections log), `/data/accuracy` (every random-sample check)
- `/how-it-works`, `/about`, `/admin`
- `/api/v1/*` public read API (see `/data/api`)
- English and Twi (`/tw`), Twi strings machine-drafted and awaiting review

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js 16 app |
| `npm run seed` | Load boundaries (geoBoundaries), source registry and admin user; removes any non-live records |
| `npm run pipeline [-- --only=<slug>]` | Run provider adapters and rebuild hotspots |
| `npm run pipeline:history -- --from=2020-01 --to=2026-09` | The historical scan: the galamsey method run on past imagery, cell by cell and month by month, into `history_events` (resumes; `--out=dir` / `--import=dir` for another machine) |
| `npm run index:close [-- --month=YYYY-MM] [--dry-run]` | Freeze the Galamsey Index for a month and every earlier month still open |
| `npm run release [-- --month=YYYY-MM] [--dry-run] [--skip-sample] [--force]` | The monthly release: close the index, confirmation sample, data files, PDF, press release, cards, manifest, changelog, Zenodo |
| `npm run alerts:weekly` | The weekly digest: record it, email subscribers, write the WhatsApp text to `public/alerts/latest.txt` |
| `npm run scheduler` | The loop that runs the release (first Monday, 06:00 GMT; dry run the Wednesday before) and the digest (Mondays, 07:00 GMT) |
| `npm test` | Vitest unit tests (validation, geometry, export, pipeline) |
| `npm run e2e` | Playwright end-to-end and axe accessibility checks (starts the dev server) |
| `npm run typecheck` | Route type generation and `tsc` |
| `npm run db:generate` | Drizzle migration from `src/lib/db/schema.ts` |

## The Galamsey Index

For every district and month: the hectares first seen as likely galamsey (a site counts once, in the month it was first seen; sites inside named large-scale mines are left out), the running total, and the index, new hectares per 100 km². Each figure carries a likely range from the measured precision and detection rate (`/data/accuracy`). A closed month never changes under the same index version (`src/lib/domain/index.ts`, `INDEX_VERSION`); a method change creates a new version, reprocesses the series and is logged at `/data/methods`. The release job refuses to publish while the month's 30-site confirmation sample is unchecked at `/admin`.

History before GhanaWatch went live comes from the same scan run with a past "now" (`npm run pipeline:history`); priority-2 cells (the gold belt) monthly, the rest quarterly. Spread it across machines with `--out` and `--import`.

## Configuration

See `.env.example`. `DATABASE_URL` switches to Postgres (+PostGIS) for production. Every data source is public and needs no key, account or email. The release and digest work without `BREVO_API_KEY`, `WHATSAPP_CHANNEL_URL` and `ZENODO_TOKEN`; with them, email sign-up opens and subscribers get the digest, the channel link appears on `/alerts`, and each release gets a DOI.

## Layout

```
src/app/[locale]        pages (next-intl: en, tw)
src/app/api/v1          route handlers
src/components          ui (shadcn), domain, map, feed, data, report, admin, layout
src/lib/domain          types, Zod validation, formatting
src/lib/db              Drizzle schema, client (PGlite/Postgres), repositories
src/lib/server          env, http helpers, auth, export
src/lib/geo             pure geometry helpers
src/pipeline            seed, adapters (all keyless), run.ts; history/ (backfill), index/ (close), release/, alerts/
src/lib/domain/index.ts the Galamsey Index (pure); sites.ts (one site, many sightings); uncertainty.ts
src/lib/server/index    reading and closing the frozen index; intakes
src/lib/server/release  data files, cards, PDF, press release, Zenodo, the release run
src/lib/server/rivers   river scorecards
src/lib/server/alerts   the weekly digest
public/releases         one folder per released month (served as static files)
docs/launch             press kit templates, media and partner lists
public/boundaries       simplified geoBoundaries GeoJSON
public/sw.js            service worker (offline shell, cached API and tiles)
drizzle/                SQL migrations
tests/                  unit and e2e
```

## Licence of data

Derived records: CC BY 4.0. Upstream products keep their own licences; every record and `/data/sources` state them.
