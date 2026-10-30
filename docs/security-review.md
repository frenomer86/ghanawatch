# GhanaWatch security review — 17 October 2026

Scope: the whole web app (pages, API, admin area, uploads, database access), the
Docker/VPS setup, dependencies, and what the site gives away. "Exposed titles" was
read as anything an attacker could learn: secrets in the browser bundle or repo,
server and framework headers, error details, source maps, guessable admin paths.

Tested against the production build (`next build` + `next start`) on the PC and
through the public preview link, with attack-style requests.

## What was already sound (checked, no change needed)

| Area | Finding |
|---|---|
| SQL injection | Every query goes through Drizzle or postgres.js tagged templates (parameters, never string concatenation). The only `sql.raw` builds CHECK constraints from constant lists in the schema. `' OR 1=1--` and `DROP TABLE` payloads in query strings are rejected by Zod validation (400) before any query runs. |
| XSS | React escapes all output; no `dangerouslySetInnerHTML`, `setHTML`, `eval`; the two `innerHTML` uses are fixed strings. Place names from OpenStreetMap (which anyone can edit) are only ever rendered as text. CSP limits scripts to the site itself, no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) except the embed card. `<script>` in a URL parameter is not reflected. |
| Admin area | Every `/api/v1/admin/*` route calls `requireRole` (401 without a session, 403 for the wrong role); the admin page checks the session on the server and redirects. Mutations also require a same-origin `Origin` header (CSRF). |
| Passwords | argon2id (64 MB memory, 3 passes); unknown emails run a dummy verification so timing does not reveal which accounts exist; failed sign-ins are written to the audit log; generic "email or password is incorrect". |
| Sessions | Random 256-bit token, only its SHA-256 stored; cookie HttpOnly, SameSite=Lax, Secure in production; 14-day sliding expiry; disabled users are logged out. |
| Uploads | Size checked from headers and body (5 MB), type detected from the file's bytes, then re-encoded with sharp (pixel limit 50 MP), which strips EXIF/GPS; stored under a generated name. |
| SSRF | Server-side fetches go only to fixed provider hosts; the photo proxy takes an id, not a URL. |
| Secrets | `.env.local`/`.env.production` are not in git (only the `.example` files); the production browser bundle was scanned for `APP_SECRET`, the admin password, database URLs and password hashes: none found; no source maps are shipped to browsers. |
| Headers | `X-Powered-By` off; no `Server` header from the app; `nosniff`, `Referrer-Policy`, `Permissions-Policy` on every page; API errors return a code and message only (stack traces stay in the server log). |
| Data exports | CSV cells starting with `= + - @` are prefixed so spreadsheets do not run them as formulas. |
| Paths | `/.env`, `/.git/config`, `..` traversal: 404. |

## Fixed in this review (commit e320a10)

1. **Rate limits could be dodged** by sending a fake `X-Forwarded-For` header (the app trusted the first entry). It now trusts only the last entry, which the proxy in front (Caddy, or the preview tunnel) sets. Tested: 5 wrong sign-ins with five forged addresses → the 6th is blocked (429).
2. **Per-account sign-in throttle**: at most 10 attempts per account per 15 minutes from any number of addresses, on top of 5 per minute per address.
3. **robots.txt**: the admin area, the API and embed cards are excluded from search engines (admin pages were already `noindex`).
4. **Photo proxy** checks the provider's address before fetching, not only after.
5. **Caddy** (VPS) removes `Server`/`Via` headers; HSTS with preload.
6. **Docker Compose**: the database is on a private network with no route to the internet and is never published; every container runs with `no-new-privileges`; only Caddy publishes ports 80/443. The app containers already run as a non-root user.
7. **Unused packages removed**: `@serwist/next`, `serwist`, `clsx`, `tailwind-merge`, `pmtiles`, `@testing-library/react`, `@vitejs/plugin-react`.

## Added after the review (on isaac's request)

8. **Two-step sign-in for staff** (TOTP, any authenticator app). Moderators and admins sign in with password plus a 6-digit code once it is on; until they turn it on they can look but every change is refused (403), and pending photos, case details, radar crops and auto-confirmed tags are treated as public visitors would see them. Keys are stored encrypted (AES-256-GCM, key derived from APP_SECRET); a code is accepted once only; wrong codes are written to the audit log and count towards the sign-in limits. Tested end to end on a throwaway database: sign-in without code refused, wrong code refused, right code accepted, replayed code refused, admin changes refused before setup. RFC 6238 test vectors pass.
9. **Limited database account for the website** (VPS): `deploy/db-init/10-app-role.sh` creates `ghanawatch_app` on first start, with read/write on rows only (no CREATE/ALTER/DROP, no roles, no other databases); the website connects with it, while migrations and the data pipeline use the owner account. Not run yet (needs Docker on the VPS); it runs automatically on the first `docker compose up`.

## Open, with reasons

- **`npm audit`**: 13 findings (9 high, 4 moderate), all in build-time tools (`drizzle-kit`, `eslint-config-next`, the `shadcn` CLI and their file-matching libraries), none in code that runs in the live site. npm's suggested "fixes" are downgrades to old major versions, so they were not applied; update these tools when patched versions ship.
- **CSP allows inline scripts** (`'unsafe-inline'`), which Next.js needs for its bootstrap script. Moving to per-request nonces would close this further; it costs static rendering of every page, so it is left for later.
- **Admin password**: set a long, unique `ADMIN_INITIAL_PASSWORD` on the VPS and change it after first sign-in.

## Performance notes (measured on the production build, compressed)

Home 38 KB, map 28 KB, district ranking 52 KB, district page 31 KB, alerts 27 KB of HTML. The map library (1 MB) loads only on map pages. Server times on the PC were 0.1–0.3 s per page, higher while the national scan writes to the same local database; on the VPS Postgres this contention does not exist.

---

# Security and speed review — 30 October 2026

Scope: everything added since 17 October (subscriptions and their emails, RSS/JSON feeds, monthly releases and
Zenodo, embeds, the admin index tools, scorecard cards, land-check images/PDFs, the photo proxy, the service
worker, Caddy) plus a re-check of the 17 October fixes. Each fix below has a unit test in
`tests/unit/security-*.test.ts` that calls the real route handler or helper with a `Request` (database, mail
service and heavy renderers faked, so no database is needed), and the whole suite, `tsc` and a production build
were run after the changes. Page-level behaviour (menus, headers, offline copies) was also checked against the
production build with Playwright and curl.

Not audited: `src/app/api/v1/admin/reports/[id]/case/route.ts` could not be copied from the PC (path too
deep), so it was not reviewed.

## Fixed

| # | Severity | Where | What was wrong | Fix | Verified by |
|---|---|---|---|---|---|
| 1 | Medium | `public/sw.js`, `src/proxy.ts` | The service worker stored every page visited, the admin dashboard included (pending reports with exact spots and descriptions, news signals), and signing out cleared only the API cache. On a shared phone those copies stayed on the device and were served offline. | Pages under `/admin` and any page rendered for a signed-in user (the proxy marks them `X-GW-Offline: no-store`) are never kept; redirected responses are not kept; signing out also empties saved pages; cache version `gw-v2` deletes everything the old worker kept. | `security-pages`: "never keeps staff pages or pages marked by the proxy", "empties saved pages … on sign-out", proxy header tests |
| 2 | Medium | `src/app/api/v1/subscriptions/route.ts`, `src/lib/server/mail.ts` | Anyone could type a stranger's address into the sign-up form from many networks and send them unlimited confirmation emails (one per district too), and the same flood spends Brevo's 300-a-day quota so the weekly digest cannot go out. | At most 3 confirmation emails per address and 150 in all per day; when the address has had its share nothing changes (its last link keeps working). The answer and its timing stay identical either way. | `security-routes`: "cannot be used to flood one inbox…", "does not reveal whether an address is already confirmed"; `security-mail`: `allowConfirmationMail` |
| 3 | Medium | `src/lib/server/http.ts` | Rate limits counted single IP addresses. An IPv6 host normally has a whole /64, so it could start every request from a new address and never meet any limit (sign-in per address, reports, subscriptions, heavy endpoints). | Callers are counted per IPv6 /64 (IPv4 per address; IPv4-mapped and port forms normalised). The in-memory bucket map now has a hard cap. | `security-http`: "counts an IPv6 caller by its /64…", "gives every address of one /64 the same hash…" |
| 4 | Medium | `src/app/api/v1/monthly/[month]/pdf/route.ts` | The monthly PDF was drawn from scratch on every request under the public limit (120 a minute per address) with no queue: a few callers could keep the CPU busy. | Counts against the heavy limit, runs through the bounded heavy-work queue, and the bytes are shared per month for 10 minutes. | `security-routes`: "monthly PDF: drawn once and shared, and an 11th request in a minute gets 429" |
| 5 | Low–Medium | `src/app/api/v1/events/route.ts` | CSV/GeoJSON downloads (up to 50 000 / 20 000 rows) ran under the public limit. | Downloads count against the heavy limit; GeoJSON assembly runs in the heavy-work queue. A page of results is unchanged. | `security-routes`: "event downloads (csv/geojson) use the heavy limit…" |
| 6 | Low–Medium | `src/app/api/v1/explore/photo/route.ts`, `src/lib/server/explore/fetch.ts` | The street-photo proxy fetches an image URL listed by Panoramax's federated catalogue. It refused IP literals but not a public-looking host name that resolves to 127.0.0.1, a private network or the cloud metadata address (blind server-side requests); it also read bodies without a length whole before checking size. | Every hop's host is resolved and all its addresses must be public (loopback, private, CGNAT, link-local, multicast, reserved, ULA, NAT64 and mapped forms refused); the body is read through the 12 MB ceiling. | `security-ssrf`: "never fetches a photo whose host resolves to an internal address", "checks the redirect target too", `isPublicAddress` cases |
| 7 | Low | `src/lib/server/explore/cache.ts`, `passes.ts`, `explore/pass/route.ts` | Satellite-pass reads had 4 slots but an unbounded waiting line: a burst held hundreds of requests open. | The line holds 24; past that the answer is 503 with Retry-After. | `security-http`: "Semaphore … turns callers away once the line is full" |
| 8 | Low | `subscriptions/route.ts`, `subscriptions/confirm/route.ts`, `unsubscribe/route.ts` | Confirmation tokens never expired and the same token was mailed again on every request. | Each confirmation email carries a fresh token; unconfirmed tokens are refused after 7 days (the page then says the link expired); a token never confirms a subscription already ended; unsubscribing keeps the first time. | `security-routes`: "only confirms a live token less than 7 days old", "gives an unconfirmed request asked again a fresh token…" |
| 9 | Low | `src/lib/server/mail.ts` (`escapeHtml`) | Did not escape quotes but was used inside attribute values on the confirm/unsubscribe page (only the token's strict format kept it safe). | Escapes `"` and `'` too. | `security-mail`: "escapes quotes too…", `linkPage` test |
| 10 | Low | `src/lib/server/alerts/link-page.ts` | The confirm/unsubscribe POST read the whole body before checking its 4 KB limit. | Read through `readBody` with a 4 KB ceiling (413 past it). | `security-mail`: "cuts off a large body with 413…"; `security-routes` confirm test |
| 11 | Low | `src/app/api/v1/alerts/feed.xml/route.ts` | The RSS feed (text includes OpenStreetMap names) had no `nosniff` or CSP, and a control character in a name would make the XML invalid. | Values escaped and stripped of XML-invalid characters; served with `nosniff`, `default-src 'none'; sandbox` and `s-maxage`. | `security-routes`: "escapes digest text, drops characters XML forbids, and is served inert" |
| 12 | Low | `src/app/[locale]/admin/page.tsx` | Staff signed in with a password only (no two-step sign-in yet) were shown open cases with reporters' exact coordinates and the staff-only news signals, contrary to the rule that such an account sees no more than the public. | Both wait for two-step sign-in, like the queues. | Code review of the page; the API routes already enforced this |
| 13 | Low | `next.config.ts` | Files under `public/` bypass the proxy, so release files (`press-release.md`, `.txt`, `.geojson`, `.csv`, written from data that includes OSM names) and the digest text were served without `nosniff`, and release files had no cache policy. | `/releases/*` and `/alerts/*` files: `nosniff` + `default-src 'none'; sandbox` + cache lifetimes; boundaries and the map worker: `nosniff` + cache. | curl against the production build |
| 14 | Low | `src/lib/server/release/zenodo.ts` | The Zenodo token was sent to the upload URL taken from Zenodo's answer without checking its host. | Only https on Zenodo's own host; the deposition id must be an integer. | `security-ssrf`: "only sends the token to Zenodo's own host", "stops before uploading when the answer names another host" |
| 15 | Info | `deploy/Caddyfile` | `X-Middleware-Rewrite` (the internal `/en/...` path) reached visitors. | Removed at Caddy (`X-GW-Offline` is kept on purpose: the service worker reads it). | Config review |
| 16 | Info | `src/app/icons/[name]/route.ts` | The manifest's three icons did not exist: every page logged a 404 (Lighthouse best practices 96). | Icons drawn from the GhanaWatch mark at the same URLs. | `security-pages`: "serves each icon as a PNG of the right size and nothing else" |

Also on request from the detector work: the Docker deps stage sets `ONNXRUNTIME_NODE_INSTALL=skip` (so `npm ci`
keeps the optional onnxruntime-node without its GPU download) and `.dockerignore` leaves out
`research/**/results/cache` and `*.pt`.

## Checked and sound

| Area | What was checked |
|---|---|
| SQL injection | Still no string-built SQL: every query is Drizzle or a `sql` tagged template (values are parameters). `sql.raw` appears only in `schema.ts` CHECK constraints from constant lists. No ORDER BY or identifier comes from input (the district sort is a fixed map in code); place search is limited to letters, digits, spaces, hyphens and apostrophes, so no LIKE wildcards. |
| XSS | No `dangerouslySetInnerHTML`; the two `innerHTML` uses are constant strings. React escapes all output and React 19 blocks `javascript:` links (news-signal links in the admin page come from feeds). SVG cards, the DOCX press release, PDFs (`winAnsi`), the link page and the RSS feed escape their text; the JSON feed is JSON. |
| CSRF | Every POST/PATCH (auth, 2FA, password, reports, sightings, power, subscriptions, confirm, unsubscribe, all admin routes) calls `assertSameOrigin`; JSON routes require `application/json` (a cross-site form cannot send it without a preflight); the session cookie is `SameSite=Lax`. Confirm/unsubscribe also need the token. |
| Admin and IDOR | All seven admin routes call `requireRole("moderator","admin")`, which also requires two-step sign-in and a changed initial password; the admin page checks the session on the server. Pending reports, their photos and radar crops of unconfirmed tags answer 404 to anyone but staff with two-step sign-in; ids are UUIDv7 (74 random bits), so they cannot be enumerated. |
| Mass assignment | Every body is a `.strict()` Zod schema (unknown keys → 400, tested for subscriptions); updates set named columns only. |
| Tokens and email | Subscription tokens: 192 random bits; the emailed link only shows a button (mail scanners cannot confirm or unsubscribe). Mail goes through Brevo's JSON API (no raw headers); Zod's email check refuses CR/LF (tested); subjects are built from database names. |
| Open redirects | Confirm/unsubscribe redirect to fixed paths on `PUBLIC_ORIGIN`; `/districts/find` redirects to slugified internal paths. A crafted `/%2F%2Fevil.com/districts/find?q=x` answers 404 (the locale layout refuses unknown locales), checked on the build. |
| Path traversal | Report photos are read under `DATA_DIR/uploads` with a relative-path check; storage keys are generated and pattern-checked; the release manifest path uses a validated month; the icon route only knows three names (tested with `../etc/passwd`). |
| Other server-side requests | Detection images and radar crops fetch only COG URLs under fixed prefixes; land checks and Ground view build URLs from numbers on fixed hosts; Commons image hosts are allow-listed; the Wayback metadata URL comes from Esri's config over https. |
| Uploads | Unchanged and intact: 5 MB ceiling while streaming, type from magic bytes, re-encoded by sharp (50 MP limit, EXIF/GPS removed), random key. |
| Headers and CSP | Re-tested on the new pages: embed cards (`/embed/…`, `/tw/embed/…`) are framable (`frame-ancestors *`, no X-Frame-Options); every other page is `DENY` / `frame-ancestors 'none'`; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, HSTS and COOP present. |
| Cookies | `gw_session`: HttpOnly, Secure in production, SameSite=Lax, 14-day sliding expiry, hashed at rest. `gw_locale` holds only the language. |
| Errors | API errors return a code and message only; stack traces stay in the server log. |
| Service worker API cache | Never stores `near`, `cases`, `auth` or `admin` answers, nor anything marked `no-store`/`private`. |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities in runtime packages. |
| Sign-in and 2FA | Unchanged since 17 October and re-read: argon2id, dummy verification for unknown emails, per-address and per-account limits, TOTP replay protection. |

## Open, with reasons

- **Case route not audited**: `src/app/api/v1/admin/reports/[id]/case/route.ts` (see above).
- **Subscription tokens are stored as they are**: a leaked database would let someone unsubscribe readers.
  Storing only a SHA-256 of the token needs a schema change (a `token_hash` column, back-filled, looked up by
  hash), which is outside this review's files; proposed, not made.
- **DNS rebinding**: the photo proxy checks a host's addresses just before connecting; a host that changes its
  answer between the check and the connection is not covered. Closing it needs a fetch dispatcher that pins the
  checked address (undici is not a direct dependency).
- **CSP still allows inline scripts** (Next.js bootstrap); unchanged reason as on 17 October.
- **Moderators can record a headline accuracy check**, which sets the precision the next index close uses. A
  role decision, not a flaw; consider making it admin-only.
- **A correct password is confirmed before the code is asked for** (the usual two-step flow), so password
  guesses remain checkable; the per-account limit (10 per 15 minutes) bounds that.
- **Rate limits live in process memory**: right for the single web container; move to Redis if it is scaled out.
- Found while working, not changed: `drizzle/meta/_journal.json` was missing from the copy of the repository
  this review started from (the detector work has since committed one; the measurements below used a
  temporary journal outside the repo), and `src/components/map/map-screen.tsx` has one existing ESLint error
  (`react-hooks/set-state-in-effect`).

## Performance, 30 October 2026

### How it was measured

Two production builds (`next build` + `next start`) side by side: the baseline commit (`ed54f0a`) and the same
commit plus the changes below, both on one throwaway PGlite database (the 260 districts and 16 regions, 900
synthetic detections over four months and a closed index, made only for measuring and never committed).
First Load JS is every script the page's HTML loads (the `noModule` polyfill that modern browsers skip is left
out), gzip level 6 as Caddy would send it; Next 16 with Turbopack no longer prints per-route sizes. Lighthouse
12.8, mobile preset (simulated slow 4G, 4x CPU slowdown), headless Chromium; baseline and changed runs were
interleaved, 6 runs per content page and 3 for the map, medians reported.

The machine has 2 cores and a model-training job was using most of them throughout: Lighthouse's CPU benchmark
swung between 950 and 2150 from run to run, and the performance score of the same build varied by 10 to 20
points (ranges in brackets). Score and TBT differences smaller than that are noise; the byte and JS sizes are
exact.

### First Load JS (compressed) and HTML

| Page | JS before | JS after | Change | HTML before → after (raw / gzip) |
|---|---|---|---|---|
| `/` | 214.3 KB | 169.7 KB | −21 % | 218 → 215 KB / 44.4 → 44.1 KB |
| `/districts` | 214.3 KB | 169.7 KB | −21 % | 483 → 454 KB / 50.8 → 48.9 KB |
| `/districts/[slug]` | 215.7 KB | 171.0 KB | −21 % | 159 → 157 KB / 33.0 → 32.5 KB |
| `/map` | 243.5 KB | 231.1 KB | −5 % | unchanged (MapLibre, 279 KB, still loads after) |
| `/monthly` | 214.3 KB | 169.7 KB | −21 % | 89 → 88 KB / 25.4 → 25.1 KB |
| `/monthly/[month]` | 215.7 KB | 171.0 KB | −21 % | 283 → 273 KB / 42.0 → 41.0 KB |
| `/alerts` | 237.5 KB | 217.4 KB | −8 % | |
| `/data` | 231.4 KB | 211.3 KB | −9 % | |
| `/explore` | 238.0 KB | 218.8 KB | −8 % | |
| `/check` | 231.5 KB | 195.1 KB | −16 % | |
| `/report` | 259.9 KB | 226.6 KB | −13 % | |
| `/embed/rankings` | 192.6 KB | 151.7 KB | −21 % | |

Uncompressed, the shared first load fell from 690 KB to 550 KB of JavaScript that every phone parses.

### Lighthouse (mobile), medians

| Page | Perf before → after | A11y | Best practices | SEO | FCP | LCP | TBT | Transferred |
|---|---|---|---|---|---|---|---|---|
| `/` | 78 [77–92] → 77 [69–83] | 100 → 100 | 96 → 100 | 100 → 100 | 1.46 → 1.51 s | 2.29 → 2.26 s | 725 → 930 ms (both 180–1430) | 501 → 444 KB |
| `/districts` | 74 [69–81] → 78 [71–81] | 100 → 100 | 96 → 100 | 100 → 100 | 1.43 → 1.46 s | 2.49 → 2.42 s | 1022 → 932 ms | 521 → 488 KB |
| `/districts/tarkwa-nsuaem` | 78 [74–91] → 74 [62–81] | 100 → 100 | 96 → 96* | 100 → 100 | 1.44 → 1.36 s | 4.11 → 4.03 s | 351 → 535 ms | 465 → 439 KB |
| `/map` | 41 [39–42] → 39 [35–41] | 100 → 100 | 96 → 100 | 100 → 100 | 1.47 → 1.32 s | 6.7 → 8.6 s** | 10.5 → 11.3 s** | 473 → 761 KB*** |
| `/monthly` | 80 [68–88] → 82 [73–86] | 100 → 100 | 96 → 100 | 100 → 100 | 1.27 → 1.38 s | 2.99 → 2.60 s | 761 → 535 ms | 466 → 440 KB |

\* The synthetic detections have no satellite pictures, so their image requests 404; real records have them.
\*\* The map's LCP is the basemap attribution, which waits on the style file from tiles.openfreemap.org: through
this sandbox's network that one request took 2.4 s in one run and 5.3 s in the next. TBT on the map is almost
all WebGL drawing, done in software by headless Chromium (a phone's GPU does it); neither says much about
the code. \*\*\* MapLibre now starts downloading with the page, so Lighthouse counts it inside its window.

Best practices went from 96 to 100 everywhere (the manifest's missing icons logged a 404 on every page).
Accessibility and SEO stayed at 100 with the new menu buttons.

### What changed

- **No unused tooltip provider in the root layout.** No component uses a tooltip, but the provider pulled the
  tooltip and positioning code into every page.
- **Toast host mounted when the page is idle** (`src/components/ui/lazy-toaster.tsx`): the toast library
  (about 20 KB compressed) left the first load of pages that never show a toast.
- **Top-bar menus load on first use** (`top-bar.tsx`, `top-bar-menus.tsx`): the three drop-downs and the phone
  menu sheet are plain buttons until hovered, focused or pressed; about 40 KB of menu, dialog and positioning
  code left every page. Checked with Playwright: click, Escape (focus returns to the button), Enter then
  arrow keys, and touch on a phone viewport; no console errors.
- **Plain links in the 260-row district tables** (`/districts`, the league tables): each `<Link>` was a client
  component to hydrate and prefetched its scorecard when scrolled into view, which on a phone means up to 260
  background downloads. A district click is now an ordinary page load (the scorecard renders on the server
  in about 0.2 s).
- **Map:** the MapLibre download starts as soon as the map screen's code runs; the basemap host is
  preconnected from the static shell (sent as a `Link` header); labels no longer fade in over 300 ms, so fewer
  frames are redrawn while the map settles.
- **App icons** exist (drawn from the mark at the URLs the manifest names).
- **Cache lifetimes**: the 500 KB map worker is cached for a day (it was revalidated on every visit), release
  files for an hour, the RSS feed at the edge (`s-maxage`), the monthly PDF in memory for 10 minutes.
- Already in place and kept: public read-only API answers carry `max-age`/`s-maxage`/`stale-while-revalidate`
  (`json(..., { cache })`), boundaries are cached for a day, MapLibre loads only on map pages, fonts use
  `display: swap` with only the two Latin body weights preloaded, Caddy compresses with zstd and gzip.

### Not done, with reasons

- **Boundary GeoJSON left as it is** (`ghana-districts.geojson`, 206 KB, about 60 KB compressed by Caddy): the
  seed computes district areas from this file, and those areas are the index's denominators, so simplifying
  it would move published figures.
- **CSS stays external**: inlining (`experimental.inlineCss`) would remove one render-blocking request but
  sends the 19 KB stylesheet twice in every HTML page and loses caching for returning visitors.
- **Translations**: every page sends all English messages (22 KB) to the browser; trimming them to the client
  namespaces would save about 3 KB compressed and risks missing strings, so it was left.
- **Link prefetching in the navigation bars** downloads the code of the linked pages after load. Turning it
  off would save mobile data but make each navigation wait for a round trip; a decision for the owner.
