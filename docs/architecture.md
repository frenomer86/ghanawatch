# GhanaWatch — Architecture, Data Model and Engineering Plan

Status: v0.1 working draft, 13 October 2026. Source of requirements: *GhanaWatch Project Documentation v1.0* (SRS, September 2026). This document follows the output contract of the `website-engineering` skill: architecture, schema, security, injection defences, edge cases, test plan, performance.

## 1. Architecture

### 1.1 Shape

GhanaWatch is a **hybrid** web application: a server-rendered public site (fast first paint on slow mobile links, indexable content pages), a **client-side interactive map** (the primary interface, FR-06), a **REST API** that serves the same data to the map, to researchers and to partner systems, and a **scheduled ingestion pipeline** that pulls detections from open providers.

```
                 ┌───────────────────────── Providers (open data) ─────────────────────────┐
                 │ GFW integrated alerts · NASA FIRMS · GloFAS / Flood Hub · CDSE Sentinel │
                 │ Open-Meteo / CHIRPS · HDX boundaries · WDPA protected areas            │
                 └────────────────────────────────┬────────────────────────────────────────┘
                                                  │  scheduled fetch (cron / GitHub Action / Vercel cron)
                                                  ▼
 ┌─────────────────────┐   ┌──────────────────────────────────────┐   ┌─────────────────────────┐
 │ Pipeline (Node/TS)  │──▶│ Postgres (+PostGIS in production)    │◀──│ API routes (Next.js)    │
 │ adapters → normalise│   │ change_events · hotspots · alerts …  │   │ /api/v1/* JSON, GeoJSON │
 │ → score → upsert    │   └──────────────────────────────────────┘   │ CSV exports, OpenAPI    │
 └─────────────────────┘                     ▲                        └───────────┬─────────────┘
                                             │ server components                   │ fetch (SWR)
                                   ┌─────────┴───────────────────────────────────▼─────────────┐
                                   │ Next.js App Router PWA (RSC + client islands)              │
                                   │ map (MapLibre) · alerts feed · detail sheet · my area …    │
                                   │ service worker: app shell + last-viewed tiles & alerts     │
                                   └────────────────────────────────────────────────────────────┘
```

### 1.2 Layers and module boundaries

| Layer | Location | Owns | Must not |
|---|---|---|---|
| `app/` routes | `src/app/**` | Page composition, metadata, loading/error states | Contain business logic or SQL |
| UI components | `src/components/**` | Presentational and interactive components; map; design tokens | Fetch data directly except via hooks in `src/lib/client` |
| Domain | `src/lib/domain/**` | Types, Zod schemas, risk scoring, i18n copy for detection types, formatting of dates/confidence | Touch the DB or HTTP |
| Data access | `src/lib/db/**` | Drizzle schema, migrations, repository functions (parameterised queries only) | Know about HTTP |
| API handlers | `src/app/api/v1/**` | Validate input (Zod), call repositories, shape responses, set cache headers | Build SQL |
| Pipeline | `src/pipeline/**` | Provider adapters (one file per source), normalisation to `ChangeEvent`, dedupe, hotspot aggregation, alert generation | Be imported by UI code |
| Platform | `src/lib/server/**` | Env parsing, logging, rate limiting, auth helpers, security headers | — |

### 1.3 Request flows

*Public map load*: browser → edge/CDN (static shell cached) → `GET /map` server component renders shell + summary counts → client island mounts MapLibre → `GET /api/v1/hotspots?bbox=…&since=…` → repository bbox query → GeoJSON response (`Cache-Control: public, s-maxage=300, stale-while-revalidate=900`) → rendered as vector circles/heat layer.

*Hotspot detail*: tap → `GET /api/v1/events/:id` → event + image references + before/after thumbnails (object storage URLs, signed if needed) → bottom sheet.

*Researcher download*: `GET /api/v1/events?from=&to=&type=&region=&format=csv|geojson` → streamed response, max 50 000 rows per request, paginated with cursor; `?format=geojson` returns a FeatureCollection with provenance properties. Every export carries `source`, `source_image_date`, `confidence`, `method_version`, `licence`, `citation`.

*Community report*: client form → `POST /api/v1/reports` (multipart: photo ≤ 5 MB, lat/lon, text ≤ 500 chars) → Zod validation → EXIF strip and re-encode photo → object storage → row with `status='pending'` → moderator queue.

*Ground view (any spot in 3D)*: map click or detection → `/explore?lat=&lon=[&event=]` → client island mounts MapLibre with 3D terrain (Mapzen terrain tiles on AWS) and flies in. In parallel: `GET /api/v1/explore/imagery` (Esri World Imagery Wayback: distinct high-resolution captures at the point with capture dates, from each release's metadata layer; EOX yearly Sentinel-2 cloudless years), `GET /api/v1/explore/passes` (Earth Search STAC: clearest Sentinel-2 pass per month over ~13 months), `GET /api/v1/explore/ground` (OpenStreetMap places within 3 km and protected-area test from `context_features`; Wikimedia Commons photos within 10 km; Panoramax, and Mapillary / Google Street View when keyed). Each pass frame is `GET /api/v1/explore/pass?scene=&lat=&lon=`: a 4 km square read from the scene's TCI COG (URL built from the validated scene id), returned as JPEG with `X-GW-Cloud`/`X-GW-Nodata`; the client keeps only clear frames for the film. Upstream lookups are cached per process (TTL, in-flight de-duplication) and COG reads are capped at four concurrent per process. A provider that fails leaves its panel empty with a note; nothing is ever substituted. "Look for machinery" shows up to four dated close-ups side by side (synchronised 2D maps of the Wayback releases, each capped at the capture's published MaxMapLevel), links out to Google Earth / Google Maps / Bing / Apple Maps for newer pictures, and lets anyone tag a machine on a specific capture (`POST /api/v1/sightings`, same-origin, `RATE_LIMIT_SIGHTINGS_PER_HOUR`); confirmed tags (`GET /api/v1/sightings`) are drawn on the matching capture and in the 3D view.

*Citizen report → public case*: `POST /api/v1/reports` (category, photo stripped of EXIF, pin) → row `pending` + case event `reported` → after the response, `satelliteCheck()` stores matching GhanaWatch detections within 750 m in the past year and the newest close-up date → moderator approves with a satellite verdict (case `confirmed`) → passes it to an authority / records action seen (`POST /api/v1/admin/reports/:id/case`) → public trail at `/reports/:id` (coordinates rounded to ~100 m; pending reports show only their status).

*Check this land*: `/check?lat&lon&r` → `GET /api/v1/land-check` (in parallel: district, protected areas within 1 km, GhanaWatch detections on the plot and the nearest galamsey site; tree cover loss by year from GFW's public Hansen v1.13 tiles; GLAD/RADD integrated alerts since 2020 from GFW's public alert tiles, decoded per pixel; fires from `fire_points`; newest Wayback close-up) and `GET /api/v1/land-check/change` (Sentinel-2 composites of Dec 2019–Mar 2020 vs the last 150 days, national-scan rules, 20 m) → findings worded by `land-findings.ts` for both the page and `GET /api/v1/land-check/pdf` (pdf-lib, Helvetica, with three stitched pictures: EOX 2020, EOX latest year, Esri close-up). Cached per plot.

*Mapped mines*: `context_features` kind `mine` holds OSM `landuse=quarry` / `industrial=mine` areas that have a name or operator (not those named as galamsey); `ContextIndex.place` marks detections inside one (title "inside Subika Pit (Newmont)", risk not raised) or within 300 m of its edge (flag only). The seed fetches them on their own when missing.

*Radar (Sentinel-1)*: adapter `cdse-sentinel-1` every 12 h → Planetary Computer STAC (`sentinel-1-rtc`, keyless SAS token) → (1) river watch on the two newest unprocessed passes: OSM river centre lines (Pra, Ankobra, Offin, Birim, Tano; `river_lines`, with bridges/dams/weirs) resampled every 20 m into 3 km windows; per window VV is read at 10 m and `findTargets` keeps small bright peaks (≥ +3 dB) with water around them on stretches that show as water and are not roughened; every hit goes to `radar_targets`; a hit repeated within ~120 m on another day within 30 days creates a pending dredger `machinery_sightings` row for moderators (with a radar crop at `/api/v1/radar/target`); (2) ponds through cloud: scan cells with < 40% optical cover, mining-priority cells first, (bookkept in `radar_cells`) compare per-pixel VV medians (last 48 days vs same weeks two years earlier, same orbit direction where possible); new water ≥ 0.5 ha becomes `water_change` events (`s1-water-1.0`) whose images are radar crops from `/api/v1/events/:id/image`.

*Scorecards*: `/districts` (ranking, region filter, sortable), `/districts/:slug`, `/reserves`, `/reserves/:slug` and `/monthly/:yyyy-mm` read `lib/db/repo/scorecards.ts`, which loads every non-dismissed detection once (10-minute in-process cache) and aggregates in `lib/domain/scorecards.ts` (pure, unit-tested): "likely mining" = Sentinel-2 `cleared_with_pits`/`new_pits` at medium/high confidence plus radar ponds of 2 ha or more, excluding detections inside named large-scale mines; districts rank by it. Extras per district: `district_forest_loss` (adapter `gfw-tree-cover-loss`: GFW Hansen tiles at z12 summed inside each district outline, refreshed every 180 days) and `fire_points.district_id` (set at insert by both FIRMS adapters; the 2020–2025 archive was backfilled once). Share card: `GET /api/v1/scorecards/:slug/card` (`next/og` ImageResponse, 1200×630, also the Open Graph image). Embeddable card: `/embed/district/:slug`, the only path served with `frame-ancestors *` (proxy.ts). Monthly PDF: `GET /api/v1/monthly/:month/pdf` (pdf-lib). Emailing the monthly report needs a mail service account (not set up).

*False-positive guards in the Sentinel-2 scan (`s2-galamsey-2.1`)*: (1) a pixel must show the change on two different clear dates; neighbouring tiles overlap, so a date reached through two tiles counts once (cloud shadows otherwise looked like two agreeing passes); (2) cleared and new-pond pixels where the JRC Global Surface Water occurrence layer (public tiles, z13) shows water in ≥ 10% of 1984–2021 observations are dropped (Lake Volta's shores, reservoirs, floodplains), also for radar ponds; (3) north of 8°N every detection is low confidence. Detections from the earlier method were hidden (`status = 'dismissed'`, `properties.autoDismissed`), not deleted; the upsert brings an auto-dismissed detection back if a newer scan finds it again.

*Detector 3.0 (`s2-galamsey-3.0`, source `gw-multisensor`, October 2026)*: replaces the two-date scan for land. Every cell, every month since 2017: a composite of all ten Sentinel-2 bands (two-pass haze and shadow screen), Landsat 8/9 where Sentinel-2 saw nothing (HLS cross-calibrated), Sentinel-1 VV/VH and terrain (`src/pipeline/ts/composite.ts`); a U-Net trained on SmallMinesDS gives P(mining) per pixel (`ts/model.ts`, ONNX); a per-pixel hidden Markov tracker dates onset and marks spreading and regrown ground (`ts/tracker.ts`); sites carry an onset month and area by month; `history_events` rows (`properties.cohort`) hold the area each site added per finished month, which Galamsey Index 2.0 counts. Land galamsey moves to 3.0 cell by cell, as each cell's record reaches the present (`ts/handover.ts`); the 2.x scan keeps muddy rivers and cleared land outside mining sites everywhere, and its pits (and radar ponds) where the record is not yet current; `GW_DETECTOR=legacy`, or a machine without the model files, runs 2.x everywhere. For 3.0 sites, "first seen" (digest, district cards, confirmation sample) is the month the record first confirmed the site (`lib/server/index/first-confirmed.ts`), not its onset. Full method, data, compute and results: `docs/detector.md` and `docs/detector-results.md`.

*Flooding seen by radar (`s1-flood-1.0`, source `s1-flood`, October 2026)*: after a GloFAS forecast at the two-year level or above, a very heavy or extreme rain forecast, or an approved public flood report, every Sentinel-1 pass over a 30 km square in the following six days is compared with the same weeks a year earlier (`src/pipeline/s1/flood.ts`, VV, 40 m): land that was dry and is now open water (below −18 dB, at least 5 dB darker) is outlined. Outlines of 10 ha or more are published as `flood_risk` records with `properties.signature = 'radar_flood'` (flood map, district flood counts, the floods page), outlines inside known mining sites are dropped (new ponds look the same), and a flood report inside an outline is confirmed by the satellite check whatever its distance from the outline's centre (`src/pipeline/adapters/radar-flood.ts`, state in `.data/s1-flood/`).

*The Galamsey Index (frozen monthly figures)*: `lib/domain/sites.ts` folds sightings (live `change_events`, counted in the month of their immutable `first_image_date`, and `history_events` from the historical scan) into sites (within ~200 m = the same site); `lib/domain/index.ts` (pure, versioned by `INDEX_VERSION`) computes per district and month `new_ha` (sites first seen that month, outside named mines), `cum_ha`, the index (`new_ha` per 100 km²), rank, the shares inside reserves and on the watched rivers, and a likely range from `lib/domain/uncertainty.ts` (mapped area corrected by the latest headline precision and the blind detection rate from `accuracy_checks`, Wilson 95% intervals). `lib/server/index/close.ts` writes `district_months` and `national_months` for every open month of the series and never rewrites a closed month under the same version; `lib/server/index/read.ts` is what every public page, card, API route and report reads. The historical scan (`pipeline/history/scan.ts`) runs `scanCell` with a past "now" per cell and month into `history_events` / `history_progress`, resumable and splittable across machines.

*The monthly release* (`lib/server/release/run.ts`, `npm run release`): refuse a published month without `--force`; draw or re-read the 30-site confirmation sample (`confirmation_samples`, decided at `/admin`; rejected sites are dismissed); close the index with the month forced; write `public/releases/{month}/` (index, national, districts and sites files, rivers, reserves, the eight-page PDF from `release/pdf.ts` with before/after chips from `lib/server/events/image.ts`, the press release from `release/press.ts` as Markdown and a dependency-free DOCX from `lib/server/docx.ts`, WhatsApp text, thread, cards from `release/cards.ts` rendered by sharp from SVG, `manifest.json` with SHA-256 of every file); append `public/releases/CHANGELOG.md`; deposit on Zenodo (`release/zenodo.ts`) when `ZENODO_TOKEN` is set; record `releases`. `deploy/scheduler.sh` runs it on the first Monday at 06:00 GMT with a dry run (to `DATA_DIR/releases-staging/`) the Wednesday before.

*Weekly alerts* (`lib/server/alerts/digest.ts`, `npm run alerts:weekly`): likely galamsey sites first seen in the last seven days, by district, each with its evidence page; recorded once per week in `alert_digests`; emailed through Brevo to confirmed `alert_subscriptions` (national, or one district); served as RSS and JSON Feed at `/api/v1/alerts/feed.*`; the WhatsApp post written to `public/alerts/latest.txt`.

*River scorecards* (`lib/server/rivers/score.ts`): each watched river (Pra, Ankobra, Offin, Birim, Tano, Densu, Oda, Bonsa) cut into ~10 km reaches of its `river_lines`; a reach is discoloured in a month when a Sentinel-2 turbid-water detection first seen that month lies within 1 km, heavily when those cover ≥ 5 ha; dredger radar targets per reach; GWCL intakes (`water_intakes`, seeded with Daboase, Sekyere Hemang and Kyebi, completed at `/admin`) marked on their reach.

*Pipeline run*: scheduler → `pipeline/run.ts` → for each adapter: fetch since last watermark → normalise → dedupe by `(source_id, source_event_id)` → upsert `change_events` → recompute `hotspots` (72-hour window) → generate `alerts` for matching `areas_of_interest` → write `pipeline_runs` row. Idempotent; safe to re-run.

### 1.4 State ownership

| State | Lives in |
|---|---|
| Map viewport, active layers, time window, selected event | URL search params (`/map?lat=&lon=&z=&layers=&since=&event=`) so every view is shareable and deep-linkable |
| Language | Route segment `/en`, `/tw` + cookie fallback |
| Watchlist (anonymous) | IndexedDB on device; optional sync to account later |
| Detections, hotspots, alerts | Postgres, read-through HTTP cache |
| Last-viewed tiles and alerts for offline | Service worker cache (Serwist), bounded to ~50 MB |
| Session (admin/moderator) | HttpOnly, Secure, SameSite=Lax cookie; server-side session table |

### 1.5 Stack (one-line justifications)

- **Next.js 15 (App Router, TypeScript)** — one codebase for SSR pages, API routes and the PWA; RSC keeps client JS small for low-bandwidth users.
- **Tailwind CSS v4 + shadcn/ui (Radix)** — accessible primitives (dialog, sheet, tabs, combobox) with our own tokens; no runtime CSS cost.
- **MapLibre GL JS** — open-source vector maps, works offline with PMTiles, GPU-rendered hotspots at national scale; the SRS names it.
- **Drizzle ORM + Postgres** — typed, parameterised SQL with reviewable migrations; PostGIS in production for spatial joins. Local dev uses **PGlite** (embedded Postgres, no install) with geometry held as GeoJSON + bbox columns so the project runs on a fresh laptop.
- **Zod** — one schema per input surface, shared between client forms and API.
- **Serwist** — service worker for app-shell caching and offline alerts (FR-09).
- **next-intl** — English + Twi message catalogues, locale routing (FR-12).
- **Vitest + Playwright** — unit/integration and real-browser E2E.
- Pipeline in the same TypeScript repo (`src/pipeline`) runnable as a CLI (`npm run pipeline`) and as a scheduled job; heavy raster work (NDVI/SAR change) delegated to Google Earth Engine or Copernicus openEO jobs that return vectors.

### 1.6 Failure planning at each boundary

| Boundary | Failure | Behaviour |
|---|---|---|
| Provider API down / slow | timeout 30 s, 3 retries with backoff | Adapter marks run `partial`, other adapters continue; UI shows "Last updated … ago" banner when data is older than 48 h |
| Provider schema change | Zod parse fails | Run fails loudly for that source, nothing is written, alert in `pipeline_runs.error` |
| DB unavailable | API 503 with `Retry-After` | Map shows cached last data from service worker with a stale notice |
| Tile server quota exceeded | 429 | Fallback basemap style (self-hosted PMTiles of Ghana) |
| Photo upload too large / wrong type | 413 / 415 | Inline field error, nothing stored |
| Offline | fetch fails | Cached shell + last alerts; forms queue in IndexedDB and submit on reconnect (Background Sync where available) |

## 2. Data model

Conventions: every table has `id` (UUID v7, time-ordered), `created_at`, `updated_at` (trigger-maintained). Foreign keys declare `ON DELETE`. Geometry is stored as `geom geometry(Geometry,4326)` with GIST index in production; in PGlite dev mode as `geom_json jsonb` plus `bbox_min_lon/min_lat/max_lon/max_lat` numeric columns with a composite B-tree index, which is what the bbox API filter uses. Centroid is always materialised (`centroid_lon`, `centroid_lat`) for clustering and sorting.

```
data_sources            1 ──< image_references        >── 1 change_events
admin_boundaries        1 ──< change_events (district_id)
change_events           >──< hotspot_events >──  hotspots
change_events           1 ──< alerts  >── 1 areas_of_interest  >── 1 users
users                   1 ──< community_reports  >── change_events (optional link)
users                   1 ──< sessions
pipeline_runs           1 ──< change_events (run_id)
```

### 2.1 Tables

**data_sources** — registry of providers (also rendered on the public Data Sources page).
`id`, `slug` UNIQUE, `name`, `provider`, `url`, `category` CHECK IN (imagery, alerts, fire, flood, weather, water, boundaries, protected-areas, basemap), `licence`, `attribution_text`, `cadence`, `resolution_m` int NULL, `doc_url`, `is_active` bool default true.

**admin_boundaries** — regions and districts (HDX/OCHA COD-AB, 16 regions / 261 districts).
`id`, `level` CHECK IN (region, district), `code` UNIQUE (COD-AB pcode), `name`, `parent_id` FK → admin_boundaries ON DELETE RESTRICT, `geom`, bbox columns, `centroid_*`, `area_km2`, `population` NULL.
Indexes: `(level, name)`, GIST(`geom`), bbox composite.

**change_events** — the core entity (FR-03).
`id`, `source_id` FK → data_sources ON DELETE RESTRICT, `source_event_id` text, `run_id` FK → pipeline_runs ON DELETE SET NULL,
`type` CHECK IN (vegetation_loss, surface_disturbance, water_change, flood_risk, fire),
`detected_at` timestamptz NOT NULL, `image_date` date NOT NULL (acquisition date shown to users), `image_date_end` date NULL (for composites),
`confidence` CHECK IN (low, medium, high), `confidence_score` numeric(4,3) CHECK 0–1 NULL,
`severity` CHECK IN (normal, watch, elevated, urgent) — maps to the SRS colour levels,
`area_ha` numeric(12,3) CHECK ≥ 0, `district_id` FK → admin_boundaries ON DELETE SET NULL,
`geom`, bbox columns, `centroid_lon/lat`, `title_en`, `title_tw`, `description_en`, `description_tw`,
`status` CHECK IN (new, reviewed, dismissed, verified) default new, `reviewed_by` FK → users ON DELETE SET NULL, `reviewed_at`,
`method_version` text, `properties` jsonb (provider-specific extras, never trusted for rendering HTML).
Constraints: UNIQUE(`source_id`, `source_event_id`) — idempotent upserts; CHECK(`image_date` ≤ `detected_at`::date).
Indexes: `(detected_at DESC)`, `(type, detected_at DESC)`, `(district_id, detected_at DESC)`, `(severity, detected_at DESC)`, GIST(`geom`) / bbox composite, `(status)` partial WHERE status = 'new'.

**image_references** — satellite product metadata (FR-08, §13 transparency).
`id`, `change_event_id` FK ON DELETE CASCADE, `role` CHECK IN (latest, before, after), `source_id` FK, `product_id` text (e.g. S2B_MSIL2A_…), `sensor` text, `acquired_at` timestamptz NOT NULL, `cloud_cover_pct` numeric(5,2) NULL, `thumbnail_url` text, `tile_url_template` text NULL, `bbox` columns, `licence` text.
Index: `(change_event_id, role)`.

**hotspots** — aggregated clusters shown on the national map (FR-06).
`id`, `window_start`, `window_end` (72 h rolling), `type`, `severity`, `event_count` int CHECK > 0, `area_ha_total`, `district_id` FK, `centroid_*`, `geom` (convex hull), bbox, `is_new` bool (any event < 72 h), `label_en`, `label_tw`.
Indexes: `(window_end DESC)`, bbox composite, `(district_id)`.

**hotspot_events** — `hotspot_id` FK CASCADE, `change_event_id` FK CASCADE, PK(`hotspot_id`,`change_event_id`).

**users** — optional accounts (SRS §9). `id`, `email` UNIQUE NULL (citext), `phone` UNIQUE NULL (E.164), `display_name`, `role` CHECK IN (citizen, moderator, admin) default citizen, `locale` CHECK IN (en, tw) default en, `password_hash` (argon2id) NULL, `email_verified_at`, `last_login_at`, `disabled_at`.

**sessions** — `id` (opaque 256-bit token hash), `user_id` FK CASCADE, `expires_at`, `ip_hash`, `user_agent`. Index `(user_id)`, `(expires_at)`.

**areas_of_interest** — watchlist (FR-10, FR-14). `id`, `user_id` FK CASCADE NULL (anonymous device entries stay client-side), `device_id` text NULL, `name`, `kind` CHECK IN (district, point_radius, polygon), `district_id` FK SET NULL, `geom`, bbox, `radius_m` int NULL, `channels` jsonb (in_app, sms, whatsapp flags), `min_severity`, `is_active`.
Indexes: `(user_id)`, bbox composite. CHECK: exactly one of district_id / geom populated.

**alerts** — user-facing notifications (FR-11, FR-13). `id`, `change_event_id` FK CASCADE, `area_of_interest_id` FK CASCADE NULL (NULL = public feed item), `severity`, `title_en`, `title_tw`, `body_en`, `body_tw`, `channel` CHECK IN (in_app, sms, whatsapp, push), `status` CHECK IN (queued, sent, failed, read), `sent_at`, `read_at`, `dedupe_key` UNIQUE.
Indexes: `(area_of_interest_id, created_at DESC)`, `(created_at DESC)` partial WHERE area_of_interest_id IS NULL (public feed), `(status)` partial WHERE status='queued'.

**community_reports** — moderated ground reports (FR-15, FR-18). `id`, `user_id` FK SET NULL, `change_event_id` FK SET NULL, `lat`, `lon` CHECK in Ghana bbox (−3.3 ≤ lon ≤ 1.3, 4.5 ≤ lat ≤ 11.2), `accuracy_m`, `description` text CHECK length ≤ 500, `photo_key` text (object storage), `photo_sha256`, `status` CHECK IN (pending, approved, rejected, needs_info) default pending, `moderator_id` FK SET NULL, `moderation_note`, `moderated_at`, `submitted_ip_hash`.
Indexes: `(status, created_at)`, bbox on lat/lon.

**machinery_sightings** — machines people tagged on a dated close-up in Ground view (excavator, truck, washing plant, dredger, other). `id`, `kind` CHECK, `count` 1–50, `lon`, `lat` (Ghana bbox), `imagery_source`, `imagery_release` (Esri Wayback release), `imagery_captured_on` date, `imagery_sensor`, `change_event_id` FK SET NULL, `note` ≤ 280, `status` CHECK IN (pending, confirmed, rejected), `submitted_by` FK SET NULL (NULL = anonymous public), `submitted_ip_hash`, `reviewed_by`, `reviewed_at`.
Public tags enter as pending and appear only after a moderator confirms them (admin page, optimistic `updated_at` check, audit log); moderators' own tags are confirmed at once. Indexes: `(status, created_at)`, `(lon, lat)`. Esri's World Imagery terms permit tracing features to create vector data; Google, Bing and Apple imagery is only ever linked to, never shown, stored or analysed.

**fire_points** — every NASA FIRMS VIIRS (Suomi NPP) detection in Ghana since 2020 that FIRMS classes as a presumed vegetation fire with nominal/high confidence: `lon`, `lat`, `acq_date`, `acq_time`, `confidence`, `frp`, `source` (firms-archive | firms-live); PK (lat, lon, acq_date, acq_time). Loaded once per finished year by the `nasa-firms-archive` adapter from the keyless country files (~1M rows for 2020–2025) and extended by the live adapter.

**report_case_events** — the public trail of a citizen report: `report_id` FK CASCADE, `case_status` (reported, confirmed, passed_to_authority, action_seen, closed), `authority`, public `note` ≤ 1000, `actor_id`, `created_at`. `community_reports` also gained `category`, `satellite_check` jsonb, `satellite_verdict`, `case_status`, `authority` and `district_id`.

**pipeline_runs** — `id`, `source_id` FK, `started_at`, `finished_at`, `status` CHECK IN (running, ok, partial, failed), `watermark` timestamptz (last provider timestamp processed), `fetched`, `inserted`, `updated`, `skipped` ints, `error` text. Index `(source_id, started_at DESC)`.

**audit_log** — `id`, `actor_id` FK SET NULL, `action`, `entity`, `entity_id`, `diff` jsonb, `ip_hash`, `created_at`. Append-only; index `(entity, entity_id)`.

### 2.2 Migrations
Drizzle Kit, versioned SQL under `drizzle/`. Rules: additive by default; destructive changes need a two-step (deprecate → drop) with a backup noted in the migration header; every migration has a down.

## 3. Security decisions

- **Default deny**: all `/api/v1/*` mutations and `/admin/*` require a session with role check (`requireRole('moderator'|'admin')`). Read endpoints are public and rate-limited.
- **Secrets** only in `.env.local` (git-ignored) parsed once by `src/lib/server/env.ts` (Zod) — the build fails if a required secret is missing; nothing secret is bundled to the client (`NEXT_PUBLIC_` only for tile style URL and public map key).
- **Passwords** argon2id (memory 64 MB, iterations 3). Accounts are optional; MVP ships admin/moderator accounts only, seeded from env on first run, forced password change.
- **Sessions**: opaque random token, stored hashed, HttpOnly + Secure + SameSite=Lax cookie, 14-day sliding expiry, rotation on privilege change, server-side revocation.
- **CSRF**: SameSite=Lax plus Origin/Referer check on every state-changing route; non-browser clients use bearer API keys (future) and are exempt from the cookie path.
- **Headers** (middleware): CSP with nonce (`default-src 'self'; img-src 'self' data: blob: https://<tiles> https://<object-storage>; connect-src 'self' https://<tiles>; worker-src 'self' blob:; frame-ancestors 'none'`), HSTS preload, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), camera=(self)`.
- **Rate limits**: login 5/min/IP, report submission 5/hour/IP, public API 120/min/IP with `429` + `Retry-After`; auth failures logged to `audit_log`.
- **Uploads**: accept image/jpeg, image/png, image/webp only, sniff magic bytes, ≤ 5 MB, re-encode with `sharp` (strips EXIF incl. GPS of the photographer's home), store under random key, serve from a separate origin.
- **PII minimisation**: IPs stored only as salted hashes; reporter identity never shown publicly; the platform never identifies individuals (SRS §3.2).
- **Dependencies**: `npm audit` in CI, Renovate, lockfile committed.

## 4. Injection defences per input surface

| Surface | Threat | Defence |
|---|---|---|
| Query params (`bbox`, `since`, `type`, `region`, `q`, cursor) | SQLi, DoS via huge bbox/limit | Zod: numeric ranges clamped to Ghana bbox, `limit ≤ 500`, enums for `type`/`severity`, cursor is signed/base64 UUID; Drizzle parameterises everything, no template SQL |
| Place search `q` | SQLi, ReDoS | Length ≤ 80, Unicode letters/digits/space/hyphen/apostrophe only, ILIKE with escaped `%`/`_`, trigram index |
| Path params `:id` | Traversal, enumeration | UUID regex; 404 for unknown; no sequential ids |
| JSON bodies | Prototype pollution, type confusion | `Zod.strict()` schemas, body size ≤ 64 KB, reject unknown keys |
| Report form (text, lat/lon, photo) | Stored XSS, path traversal in filename, polyglot files | Text rendered via React (auto-escaped), never `dangerouslySetInnerHTML`; filename discarded, server generates key; MIME sniff + re-encode |
| Provider API responses | Malicious strings/geometry from a compromised upstream | Zod-parsed; geometry validated (ring closure, ≤ 10 000 vertices, inside Ghana bbox ± 1°); `properties` jsonb displayed only via allow-listed keys |
| Headers / cookies | Header injection, session fixation | Session cookie regenerated at login; outgoing header values stripped of `\r\n`; Host header allow-list |
| URL building for tiles / thumbnails | SSRF / open redirect | Only allow-listed hosts from `data_sources.url`; no user-supplied URLs are fetched server-side. Ground view: satellite passes take a scene id (strict regex) and the COG URL is built on the fixed open-data bucket; street photos take a provider enum + id and the image URL is looked up from the provider's API, then fetched only if it is a public https host (no IP literals, ports or credentials), image/* and ≤ 12 MB |
| Shell | Command injection | Pipeline never shells out; GDAL use (if any) via `execFile` with array args and fixed binaries |
| i18n messages | Template injection | ICU messages come from repo files only; user content is never interpolated as a message template |
| Admin notes / moderation | XSS | Plain text, React-escaped, ≤ 1 000 chars |

## 5. Edge cases handled

- **Empty states**: no detections in window → map shows "No new changes in the last 72 hours" with last pipeline time; empty watchlist invites adding a district.
- **Stale data**: `pipeline_runs` newer than 48 h missing → banner on map and feed; API adds `X-Data-Freshness` header.
- **Cloud cover**: optical detection suppressed when `cloud_cover_pct > 60`; shown as "no clear image since <date>" rather than "no change".
- **Dates**: all stored UTC; displayed in Africa/Accra (UTC+0, no DST) with explicit day-month-year; image date vs detection date never conflated.
- **Geometry**: antimeridian irrelevant; degenerate polygons rejected; MultiPolygons supported; huge event (> 10 000 ha) still renders via hull + count.
- **Unicode / Twi**: Twi uses ɛ, ɔ — fonts selected must include them; `lang` attribute per locale; no `toUpperCase()` on user strings.
- **Concurrency**: pipeline runs hold an advisory lock per source; upserts are `ON CONFLICT (source_id, source_event_id) DO UPDATE`; moderation uses optimistic `updated_at` check to avoid double decisions.
- **Double submit**: report form button disabled while pending; server dedupes on `photo_sha256 + lat/lon + 10 min`.
- **Network**: offline queue for reports; SWR revalidation on reconnect; tile requests abort on viewport change.
- **Boundaries**: first/last page cursors, `limit=0` rejected, `since` in the future rejected, bbox crossing Ghana border clipped.
- **Permissions**: moderator cannot promote roles; disabled users' sessions revoked immediately; expired session → 401 JSON for API, redirect for pages.
- **Files**: 0-byte, HEIC (rejected with explanation), 20 MP photos downscaled to 2048 px, filename with `..` ignored.
- **Low literacy**: every severity level has icon + colour + word; alert copy uses plain verbs.

## 6. Test plan

| Level | What | How | Against |
|---|---|---|---|
| Unit | Zod schemas, risk scoring, hotspot clustering, date formatting, bbox clamp | Vitest | pure functions |
| Integration | Repositories and API routes | Vitest + PGlite in-memory (CI) and Postgres+PostGIS container (nightly) | real SQL, real HTTP via `next` test server |
| Adversarial | Payload corpus: `' OR 1=1`, `../../etc/passwd`, `<img onerror>`, polyglot PNG, 10 MB body, bbox of the whole world, 100 000-vertex polygon | Vitest table tests asserting 4xx and no writes | API routes |
| E2E | Load map, tap hotspot, read dates, filter feed, add district to watchlist, submit report offline then online, moderator approves | Playwright (Chromium + mobile WebKit emulation, 3G throttling) | running app with seeded DB |
| Accessibility | axe-core on every page; keyboard-only run of the map detail flow; contrast checks | Playwright + `@axe-core/playwright` | running app |
| Load | `/api/v1/hotspots` at 200 rps, p95 < 300 ms; map page LCP on throttled 3G < 4 s | k6 + Lighthouse CI | staging |
| Chaos | Kill DB mid-request; provider returns 500/garbage; tile host 429 | Integration tests with fault-injecting fetch mock | pipeline + API |
| Pipeline | Each adapter has a recorded fixture; replaying must produce identical rows (snapshot) | Vitest | fixtures |

Done means: CI green on unit + integration + adversarial + axe; E2E green against a seeded local DB; Lighthouse mobile performance ≥ 85 on `/map`.

## 7. Performance

Budgets (SRS: 3–5 s on typical Ghanaian mobile):
- `/` and `/map` HTML < 30 KB gzipped; initial JS for map route < 250 KB gzipped (MapLibre is ~200 KB; everything else is RSC or lazy).
- Hotspot payload for national view < 100 KB (hotspots, not raw events; events load per cluster on zoom ≥ 9).
- Vector basemap from PMTiles (Ghana extract ≈ 60–120 MB hosted once) or OpenFreeMap; raster imagery thumbnails ≤ 60 KB WebP/AVIF.
- Fonts: two weights, `font-display: swap`, subset to Latin + Twi glyphs; preload the body face only.
- Caching: API `s-maxage=300` with `stale-while-revalidate`; boundaries `max-age=86400, immutable` per version; service worker precaches shell, caches tiles with LRU cap.
- DB: every filter column indexed (§2); `EXPLAIN ANALYZE` on the three hot queries (bbox+since, feed by district, event by id) committed to `docs/perf/`.
- Expected: hotspot bbox query < 20 ms at 100 000 events; map interactive ≈ 3.5 s on 3G Fast emulation.

## 8. Information architecture (first cut; refined after the reference-site survey)

Public: Map (home) · Alerts (recent changes feed) · My Area (watchlist) · Report · More → How it works, Data & Downloads, Data sources, About/Partners, Language.
Research: `/data` — filterable table + CSV/GeoJSON export, `/data/api` — OpenAPI docs and examples, `/data/sources` — provenance and licences, `/data/methods` — detection methods, limitations, versioning, citation.
Admin: `/admin` — pipeline health, detection review, moderation queue, audit log.

## 9. Phase mapping

Phase 1 (this build): schema, pipeline with GFW integrated alerts + FIRMS + GloFAS adapters and seeded sample data, map, feed, detail sheet, watchlist (device-local), How it works, Data & Downloads, admin login + moderation queue skeleton, EN + TW scaffolding.
Phase 2: Sentinel-1/2 change detection via GEE/openEO, SMS/WhatsApp, accounts, community reports live, more languages.
Phase 3: national raster coverage, institutional feeds (GMet, NADMO), sustainability.
