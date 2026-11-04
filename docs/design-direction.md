# GhanaWatch — Design Direction

Status: v0.1, 16 October 2026. Companion to `architecture.md`. This records the visual and information-architecture decisions, what each borrows from leading platforms in the domain, and what was deliberately not copied.

## 1. The brief, in one line

A calm, trustworthy national watch tool for phones first: show what changed, where, and exactly when the satellite saw it, so that a resident, a NADMO officer, a journalist and a researcher can each act on it without an account.

## 2. Reference sites surveyed

Fourteen public platforms were reviewed on 13 October 2026 (homepage, map/explorer and a data or methods page each): Copernicus Emergency Management Service with GloFAS, EFAS, EFFIS and the Drought Observatories; Copernicus Browser / Data Space Ecosystem; NASA Earthdata; NASA Worldview; NASA FIRMS; NOAA / National Weather Service; Global Forest Watch (now Global Nature Watch); Resource Watch; FEWS NET; Google Flood Hub; Digital Earth Africa Maps; Copernicus Global Flood Monitoring; Sentinel Hub EO Browser and Planet Explorer; and, as local institutional context, the Ghana Meteorological Agency (ClimWeb) and NADMO. Full notes per site are kept in the project session journal.

### Patterns that recur across the strongest sites, and how GhanaWatch applies them

| Pattern | Seen on | GhanaWatch |
|---|---|---|
| The map is the product; first screen already shows a dated, populated view, never an empty state | FIRMS ("FIRES: 2026-10-13 (24HRS)"), Copernicus Browser ("Show latest date"), Worldview | `/map` opens on the last 72 hours nationally; the freshness chip prints the detection count, "Data updated … ago" and the latest image date |
| Every view is a permalink | Worldview, Copernicus Browser, Resource Watch, Flood Hub, GFW | `/map?lat&lon&z&hours&type&sev&event` is written to the URL on every move; `/event/{id}` is the stable record page |
| Severity as a small fixed colour scale reused identically on markers, legend and charts | GloFAS (yellow/red/purple), GFW (loss pink), NWS hazard table | Four SRS levels (green, amber, orange, red) with word + dot everywhere; type is carried by icon, never by colour |
| Confidence and acquisition date on every record | GFW three-tier alerts, Flood Hub "Verified model", FIRMS CONFIDENCE + VERSION columns, Copernicus Browser cloud % | Two-date stamp ("Seen by satellite / Detected") and a confidence pill on every card, sheet, table row and export row |
| Plain-language names, technical name secondary | Avoided by Worldview and EO Browser (expert layer names) | "Vegetation loss", "Disturbed ground"; sensor and product id shown as secondary text in the image panel |
| Compare before/after | Worldview swipe, Copernicus Browser compare, DE Africa split map | Before/After dates shown now; swipe imagery arrives with the Sentinel adapter |
| First-party downloads with licence and citation beside the button | FEWS NET, DE Africa product pages, Resource Watch citation block, NWS "Get as KML" | `/data`: filters drive both the preview table and the CSV/GeoJSON link; licence and citation printed next to the buttons; `/api/v1/events/{id}?format=geojson` per record |
| One methods and limitations page with versioning | DE Africa specifications, GFW metadata cautions, NWS Forecast Discussion | `/data/methods` with method_version on every record |
| Provider registry page with cadence, resolution, licence and last fetch | Flood Hub data sources, DE Africa, Copernicus EWDS | `/data/sources` is generated from the `data_sources` table and `pipeline_runs` |
| Mobile bottom tab bar of five destinations | NADMO (Home, Alerts, Emergency, Map, Menu) | Map, Alerts, My area, Report, Data |
| Citizen report form tied to the map, moderated | NADMO "Report a Disaster", GFW field verification | `/report`: photo ≤ 5 MB, device location, 500 characters, offline queue, moderation queue in `/admin` |
| Permanent short disclaimer naming the official authorities | Flood Hub, Copernicus "not an official warning" | Footer and every detail sheet: a detected change, not a legal finding; NADMO, GMet and Forestry Commission remain the authorities |

### What was deliberately not copied

- Client-only shells (GloFAS, GFW, GMet map viewer, Flood Hub) that render a bare title without JavaScript. GhanaWatch server-renders every content page and the map shell; the map canvas is the only client-only element.
- Account walls before the map or downloads (GloFAS, EO Browser, Earthdata Login, Resource Watch areas). Everything public is readable without sign-in; accounts exist only for moderators and administrators.
- Dark "operations console" chrome (Worldview, FIRMS, DE Africa, EO Browser). It suits analysts on desktops; the SRS asks for a light, calm interface for people with varying literacy on phones, so the basemap is pale and colour is reserved for detections.
- Catalogue-first layer pickers with hundreds of raw products (Worldview, DE Africa). GhanaWatch curates five change types and one basemap.
- Federation across sub-domains with different navigation (Copernicus, NASA, NOAA, Sentinel Hub). One app shell carries map, feed, data, methods and admin.
- Hub homepages with no live state (Copernicus EMS, GMet). The home page opens with live counts and the latest detections.
- Formula-laden metadata in the default view (EO Browser evalscripts, Worldview layer ids). Kept behind the record's secondary text and the methods page.

## 3. Visual system

Grounded in the landscape the platform watches rather than in a government template: forest canopy, river water, laterite earth and paper-light surfaces, so that colour on the map always means change.

**Colour tokens** (`src/app/globals.css`)

| Token | Hex | Role |
|---|---|---|
| forest-700 | #0F3D2E | Primary: navigation, primary buttons, headings on light |
| forest-500 | #1F6F50 | Primary hover, focus ring, "new" halo |
| river-700 / river-600 | #245A82 / #2F6F9F | Links and water-type accents |
| laterite-600 | #A8512A | Surface-disturbance accent only, never decoration |
| paper / surface | #F5F7F4 / #FFFFFF | Background and cards |
| ink | #15201B | Text |
| Severity text / fill | normal #22663F / #2E8B57, watch #7A5300 / #E2A92B, elevated #8F3F0C / #E4731F, urgent #9B1C1C / #D13B3B | Chips use the dark text on a tint; map markers use the fill |

All text colours meet WCAG AA (≥ 4.5:1) on their backgrounds; severity is never conveyed by colour alone (word + dot, icon for type). A dark theme exists for imagery viewing but light is the default per SRS §10.3.

**Type** (revised 4 November 2026): Source Serif 4 for headings and published figures, Source Sans 3 for the interface and body: one family designed to work together, in the register of a statistical bulletin rather than an app (the earlier Lexend headings read as a generic app kit). Both carry the Twi glyphs ɛ ɔ Ɛ Ɔ. Body 17 px / 1.6, measure 68 ch on content pages, tabular figures everywhere numbers align.

**Revision of 4 November 2026**: a forest-green masthead with a serif wordmark and a gold rule under the current section; white pages; headline figures set as a rule, a label, the figure in the serif and a note, instead of tinted tiles; no decorative icons beside headings, no all-caps labels, no arrows appended to links; event lists as entries with a left rule coloured by type; a site footer with the record, data and licence; and one memorable element, the map of Ghana's districts drawn on the server, shaded in ochre by the land newly dug for gold (home page) or picking out the district (district pages).

**Shape and motion**: 4 px radius, one shadow level for sheets and popovers, no decorative animation; motion only answers an action (sheet open, map fly-to) and respects `prefers-reduced-motion`.

**The one memorable element**: the two-date stamp. Every detection, everywhere it appears, carries "Seen by satellite 9 Oct 2026 · Detected 11 Oct 2026" in the same typographic treatment. It is the SRS's central trust requirement and the thing no reference site does consistently.

## 4. Information architecture

Public: Map (home of the product) · Alerts · My area · Report · Data (Downloads, API, Sources, Methods) · How it works · About.
Research: `/data`, `/data/api`, `/data/sources`, `/data/methods`, plus GeoJSON/CSV on every record and list.
Admin: `/admin` (pipeline health, moderation queue, unreviewed detections), `/admin/login`.

Desktop: a 24 rem rail beside a full-height map; the rail holds the list in view and swaps to the detail on selection with a back button. Phone: full-screen map, a collapsed bottom panel with the count that expands into the list, and a bottom sheet for the detail; search, time window and filters float at the top.

## 5. Skills applied

- website-engineering: the output contract in `architecture.md` (architecture, schema, security, injection defences, edge cases, tests, performance) and the default-deny, parameterised-query and header rules implemented in `src/lib/server`.
- frontend-design: two-pass plan (tokens then critique) and the explicit avoidance of generated-page tells: no cream-and-serif hero, no all-caps eyebrows, no middle-dot meta strings in copy, no arrows appended to buttons, boldness spent on one element.
- ui-ux-pro-max: `--design-system` search returned the "Accessible & Ethical" government style and a navy/blue public-service palette; the government palette's contrast discipline was kept while the hue moved to the SRS's forest green; the Lexend + Source Sans 3 pairing came from its typography search; its checklist (44 px targets, 16 px+ body, visible focus, reduced motion, no emoji icons) is applied throughout.
- design-system, ui-styling: three-layer tokens (primitive → semantic → component) in `globals.css`; shadcn/ui on Radix for accessible primitives.
