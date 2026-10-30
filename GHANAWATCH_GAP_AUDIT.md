# GhanaWatch — Gap Audit against the Platform Brief

Audited 26 October 2026 against the repository at `Desktop\THESIS\GHANAWATCH` (Next.js 16, Drizzle, PGlite/PostGIS, Docker on a Hostinger VPS; 15 migrations; pipeline with nine adapters). Companion to `GHANAWATCH_PLATFORM_BRIEF.md`.

**Verdict.** About two thirds of the product layer in the brief already exists, and several pieces (Ground view, Check this land, citizen case trail, radar dredger detection, the accuracy page) go beyond it. The brief's stack section is withdrawn: the site stays on Next.js and Postgres, and nothing is rebuilt. What is missing is concentrated in four places: **a frozen monthly index with history**, **a backfill**, **a release job with a press kit**, and **outbound alerts**. Everything else is an edit to a page that exists.

Build the twelve gaps below in order. Each names the files it touches.

---

## 1. What already exists (keep, do not rewrite)

| Brief section | Exists today | Where |
|---|---|---|
| 4 Module contract | `change_events` with `method_version`, `properties.signature`, `district_id`, `placement` (protected area, named mine, residential, nearby school/clinic/cemetery), stable `source_event_id` from the rounded centroid, `image_references` before/latest | `src/lib/db/schema.ts`, `src/pipeline/run.ts`, `src/pipeline/context/annotate.ts` |
| 5 Index (partial) | District scorecards: likely-mining hectares, sites, rank, share of district area, inside reserves, near people, muddy rivers, radar ponds, forest loss by year, fires by year | `src/lib/domain/scorecards.ts`, `src/lib/db/repo/scorecards.ts` |
| 5 Reserves | Reserve cards and pages | `src/app/[locale]/reserves/**` |
| 7 Rankings | `/districts` sortable ranking with region filter | `src/app/[locale]/districts/page.tsx` |
| 7 District page | Rank, stats, largest sites, forest-loss chart, fires chart, share bar, embed code, OG card | `src/app/[locale]/districts/[slug]/page.tsx` |
| 7 Evidence page | `/event/{id}`: dates, confidence, source, citation, GeoJSON, before/latest images, Ground view | `src/app/[locale]/event/[id]/page.tsx`, `src/components/domain/satellite-views.tsx` |
| 7 Reports | `/monthly/{month}` "State of Ghana's Environment" with PDF | `src/lib/server/scorecards/monthly.ts`, `monthly-pdf.ts` |
| 7 Methodology, data, API | `/data`, `/data/api`, `/data/methods`, `/data/sources`, `/data/accuracy` | `src/app/[locale]/data/**` |
| 7 Twi | next-intl `en` and `tw` catalogues | `messages/` |
| 8 Share cards | 1200×630 card via `next/og`, used as Open Graph image; WhatsApp, X, Facebook share; iframe embed | `src/app/api/v1/scorecards/[slug]/card/`, `src/components/scorecards/share-bar.tsx`, `src/app/[locale]/embed/district/[slug]/page.tsx` |
| 11 Open data | CSV/GeoJSON export with provenance, CC BY 4.0, public `/api/v1/*` | `src/lib/server/export.ts`, `src/app/api/v1/**` |
| 12 Credibility | Accuracy page with four dated random-sample checks, Wilson intervals, a measured miss rate, every miss explained | `src/app/[locale]/data/accuracy/page.tsx` |
| Beyond the brief | Ground view (3D, Wayback film, machinery tagging), Check this land (PDF), citizen reports with public case trail, Floods, Power, news signals triggering rescans, FIRMS archive, radar dredger targets on five rivers | `src/components/explore/**`, `src/lib/server/land/**`, `src/pipeline/s1/**`, `src/pipeline/adapters/news-signals.ts` |

## 2. Stack decision

Keep: Next.js 16 App Router, Drizzle, Postgres + PostGIS, Docker Compose on the VPS, the 3-hour pipeline container, pdf-lib, `next/og`. Withdraw from the brief: Astro, Cloudflare Pages/R2, PMTiles, WeasyPrint, Playwright cards. A monthly release becomes a database close plus static files written under `public/releases/{YYYY-MM}/` and served by Next.

## 3. The gaps, in build order

### G1 — Immutable first-seen date (small; blocks everything else)

`src/pipeline/run.ts` line ~463 overwrites `image_date` on every rescan, and `repo/scorecards.ts` derives `firstSeen` from it, so a site re-seen this month counts as new this month. Add `first_image_date date` to `change_events`, set only on insert (`coalesce(change_events.first_image_date, excluded.image_date)` in the upsert), backfill it from `image_references` where `role = 'before'` is absent and from the earliest `image_date` otherwise, and make `firstSeen` read it. Migration `0016_first_seen.sql`.

### G2 — Frozen monthly index

New tables `district_months` and `national_months` (migration `0017_index.sql`):

`district_months(district_id, month, index_version, new_ha, cum_ha, index, rank, pct_forest, pct_river, pct_unlicensed, active_sites, ci_low, ci_high, closed_at)`.

New module `src/lib/domain/index.ts` (pure, unit-tested, same style as `scorecards.ts`): `new_ha` = likely-mining area with `first_image_date` in the month, outside named mines; `index` = `new_ha` per 100 km² of district area; rank by `index`; `cum_ha` = running sum from the first month of the series. New pipeline step `src/pipeline/index/close-month.ts` run by `npm run pipeline -- --only=index-close --month=YYYY-MM`; a closed month is never recomputed by the live scan, only by a versioned reprocess that writes a corrections entry (G11). `index_version` starts at `1.0`.

### G3 — Historical backfill

The live scan compares the last 120 days with imagery one to two years earlier; it cannot say what happened in 2021. `scanCell(c, now, …)` in `src/pipeline/adapters/sentinel2.ts` already takes `now` as a parameter, and `src/pipeline/s2/remote-scan.ts` already lets a scan run on another machine and be imported with `S2_IMPORT_DIR`. So:

- New command `npm run pipeline:history -- --from=2020-01 --to=2026-09 --priority=2` that calls `processCell` with `now` set to the last day of each month and writes results to a new table `history_events` (same columns as `change_events` plus `scan_month`), never to the live tables.
- Budget: 538 cells × 81 months is about 44,000 cell-scans. Run priority-2 cells (the gold belt, 20 m) monthly and priority-1 cells quarterly; split the months between the VPS and the lab PC with `remote-scan.ts`. Expect two to three weeks of unattended compute.
- Then G2 runs over `history_events` to fill `district_months` from 2020-01 (baseline 2019). The first month of the series carries the 2019 baseline, and the methodology page says so.
- Backfill is complete when every priority-2 cell has every month and every priority-1 cell has every quarter, and the 2026-10 history month agrees with the live scorecard within the confidence interval.

### G4 — Uncertainty from the accuracy checks

Move the checks typed into `data/accuracy/page.tsx` into a table `accuracy_checks(checked_on, region, kind, checked, correct, note)` with an admin form (`/admin` already has a moderation UI to copy). `src/lib/domain/uncertainty.ts` applies the Olofsson et al. (2014) area estimator using the latest precision per region (recall from the 48-square miss study) to give `ci_low`/`ci_high` on `new_ha`; every number on the site that comes from `district_months` shows its interval.

### G5 — Legality, river buffer, water intakes

- Minerals Commission cadastre polygons → `context_features` kind `licence`; `markLicensed` in `src/pipeline/context/licensed.ts` already marks named OSM mines, so extend it to set `properties.placement.licence` and a derived `legality` of `licensed` / `unlicensed` / `unknown`. If the cadastre cannot be obtained as a file, `unknown` stays honest and `pct_unlicensed` is withheld.
- `tagWaterways` (`src/pipeline/context/waterways.ts`) already tags detections near drains and wetlands; add a `within_100m_of_river` flag from `river_lines` for `pct_river`.
- New table `water_intakes(name, river, lon, lat, operator)` seeded with Daboase (Pra), Sekyere Hemang (Pra), Kyebi (Birim); complete from GWCL and the Water Resources Commission before launch. Each district card gains "nearest intake and distance to the newest site".

### G6 — Pages

- **Home** (`src/app/[locale]/page.tsx`): put the national headline first — hectares newly destroyed last month with its interval, cumulative since 2020, districts affected, the rank-1 district — then a 2020–now trend (SVG, server-rendered), the top-10 league table, "Find your district" search (reuse `place-search.tsx`), the latest report, and the alert sign-up. The map button and live feed move below. The home page must not load MapLibre.
- **District page**: add the monthly trend since 2020 from `district_months`, rank arrow against last month, three before/after pairs inline (reuse `satellite-views.tsx`), nearest intake. Keep everything already there.
- **Rivers**: new `/rivers` and `/rivers/{slug}` for Pra, Ankobra, Offin, Birim, Tano, Densu, Oda, Bonsa: reach-by-reach colour strip from the muddy-river detections and the `river_lines` 20 m samples, radar dredger sightings, intakes, kilometres discoloured per month. The home "River watch" panel links to it.
- **Reports hub**: `/monthly` becomes the list of every closed month with PDF and press release; `/monthly/{month}` keeps its layout but reads frozen `district_months`.
- **Methodology**: `/data/methods` gains the index definition, the version history and the corrections log (G11).
- Measure Lighthouse mobile on `/`, `/districts` and one district page under 3G throttling; the target is 90 and `docs/architecture.md` currently promises 85 for `/map`.

### G7 — Cards per month

The card route is live and changes with every scan. Add a frozen variant written at month close: `public/cards/{slug}/{YYYY-MM}.png` (1200×630) and `{YYYY-MM}-square.png` (1080×1080) rendered with the same `next/og` template, with the index, rank, rank arrow, cumulative hectares, a small district outline, and "GhanaWatch, KNUST" with the release date. District pages link the current month's frozen card as their Open Graph image once a month is closed.

### G8 — Release job

`npm run release -- --month=YYYY-MM [--dry-run]` in `src/pipeline/release/`: close the month (G2), uncertainty (G4), cards (G7), then write `public/releases/{month}/` with `ghanawatch_index_{month}.csv`, `ghanawatch_districts_{month}.geojson`, `ghanawatch_sites_{month}.geojson`, `ghanawatch_rivers_{month}.csv`, `ghanawatch_reserves_{month}.csv`, the PDF (extend `monthly-pdf.ts` to eight pages: headline, national trend, league table, river scorecard, reserves, six featured sites with before/after, methodology summary, data links), `press-release.md` and `.docx` (lead paragraph names the national figure, the rank-1 district and the worst river), `manifest.json` (input hashes, method and index versions, git commit), and an appended `CHANGELOG.md`. `--dry-run` writes to `public/releases/_staging/`. A `release` service in `docker-compose.yml` with a cron line for the first Monday at 06:00 GMT and a dry run the preceding Wednesday.

### G9 — Weekly alerts

The schema already has `areas_of_interest` and `alerts` with `in_app`, `sms`, `whatsapp`, `push` channels, but nothing sends. Build `src/pipeline/alerts/weekly.ts` (Monday 07:00 GMT): sites with `first_image_date` in the last seven days grouped by district, each linking to its `/event/{id}` page. Outputs: a WhatsApp Channel post under 1,000 characters plus the top card (posted by hand at first), `/alerts/feed.xml` (RSS) and `/alerts/feed.json`, and an email digest through Brevo (`BREVO_API_KEY`, lists `officials`, `journalists`, `public` in config). `/alerts` gains the WhatsApp channel link and an email sign-up that writes to `areas_of_interest` with `kind = district`.

### G10 — Open data and embeds

- `GET /api/v1/scorecards/{slug}` (JSON, the full `district_months` series), `GET /api/v1/national/{month}`, `GET /api/v1/latest`; document them on `/data/api`.
- `/embed/rankings` beside the existing `/embed/district/{slug}`; both listed with copy-paste snippets on `/data`.
- Zenodo deposit of each release folder (`ZENODO_TOKEN`); the DOI is written back into `manifest.json` and shown on the report page.

### G11 — Corrections log and routine confirmation sample

Table `corrections(published_on, month, what_changed, why, index_version)` rendered on `/data/methods`. At each month close the release job draws 30 random new sites and opens them as an admin queue (reuse `sighting-queue.tsx`); the moderator's verdicts write to `accuracy_checks`, rejected sites are dismissed, and the index is recomputed before the release is published. Draft the methodology note from `docs/architecture.md` §1.3 and the accuracy page and deposit it with the first release.

### G12 — Launch package

`docs/launch/`: press release template, media list (Joy News, Citi Newsroom, TV3, MyJoyOnline/GhanaWeb data desks, Daily Graphic), partner list (Media Coalition Against Galamsey, A Rocha Ghana, Ghana Water Ltd, Water Resources Commission, Forestry Commission, EPA, OccupyGhana, KNUST University Relations), an X thread, a 90-second explainer script, and an embargo note. "GhanaWatch, KNUST" in `wordmark.tsx`, the PDF header and every card.

## 4. What is cut from the brief

Astro, Cloudflare, PMTiles, WeasyPrint, Playwright cards (replaced by the existing stack); a separate `/rankings` route (`/districts` is it); a separate `/site/{id}` route (`/event/{id}` is it); the Twi toggle as a config list (next-intl already does it).

## 5. Acceptance (adapted)

- `district_months` for a closed month is reproducible from `history_events` + `change_events` byte for byte, and a closed month never changes without a `corrections` row.
- Backfill complete as defined in G3; the 2020–now national trend renders on the home page.
- `npm run release` runs end to end in under two hours on the VPS and `--dry-run` leaves production untouched.
- Lighthouse mobile ≥ 90 on `/`, `/districts` and a district page.
- The weekly job runs for four consecutive Mondays unattended.
- Every number on the home page and a district page links to a file under `public/releases/`.
