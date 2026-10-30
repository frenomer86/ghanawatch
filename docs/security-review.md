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
