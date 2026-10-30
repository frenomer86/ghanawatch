import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Link } from "@/i18n/navigation";
import { CitationYear } from "@/components/domain/citation-year";

export async function generateMetadata({ params }: PageProps<"/[locale]/data/api">): Promise<Metadata> {
  const locale = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "data" });
  return { title: t("apiDocs") };
}

const ENDPOINTS: Array<{ path: string; summary: string; params: string[]; example: string }> = [
  {
    path: "GET /api/v1/national",
    summary: "The frozen national Galamsey Index: the month asked for (default the latest closed month) and the whole series, with the likely range. Figures never change under the same index version.",
    params: ["month=YYYY-MM"],
    example: "/api/v1/national?month=2026-10",
  },
  {
    path: "GET /api/v1/index",
    summary: "The district league table for a closed month: rank, index (new hectares per 100 km²), new and cumulative hectares, likely range, movement since the month before.",
    params: ["month=YYYY-MM", "region=<name>", "limit=1..300"],
    example: "/api/v1/index?month=2026-10&limit=10",
  },
  {
    path: "GET /api/v1/scorecards/{district-slug}",
    summary: "One district: its live scorecard and its whole frozen monthly series.",
    params: [],
    example: "/api/v1/scorecards/amansie-central",
  },
  {
    path: "GET /api/v1/rivers",
    summary: "River scorecards: reaches discoloured this month, drinking-water intakes, dredger radar targets, monthly series.",
    params: ["month=YYYY-MM"],
    example: "/api/v1/rivers",
  },
  {
    path: "GET /releases/{month}/…",
    summary: "The open-data files of each monthly release (CSV, GeoJSON, PDF, press release, manifest with hashes), CC BY 4.0.",
    params: ["ghanawatch_index_{month}.csv", "ghanawatch_sites_{month}.geojson", "ghanawatch_districts_{month}.geojson", "manifest.json"],
    example: "/releases/2026-10/ghanawatch_index_2026-10.csv",
  },
  {
    path: "GET /api/v1/alerts/feed.xml · feed.json",
    summary: "The weekly digest of new sites as RSS and JSON Feed. Embeddable league table: /embed/rankings; district card: /embed/district/{slug}.",
    params: [],
    example: "/api/v1/alerts/feed.json",
  },
  {
    path: "GET /api/v1/events",
    summary: "Change events, newest first, keyset-paginated. Add format=csv or format=geojson to download up to 50 000 rows.",
    params: [
      "bbox=minLon,minLat,maxLon,maxLat (clamped to Ghana)",
      "since=ISO timestamp · from=YYYY-MM-DD · to=YYYY-MM-DD (image date)",
      "type=vegetation_loss|surface_disturbance|water_change|flood_risk|fire",
      "severity=normal|watch|elevated|urgent · confidence=low|medium|high",
      "region=<name> · district=<name> · limit=1..500 · cursor=<nextCursor> · lang=en|tw",
    ],
    example: "/api/v1/events?type=vegetation_loss&from=2026-09-01&region=Ashanti%20Region&format=csv",
  },
  {
    path: "GET /api/v1/events/{id}",
    summary: "One record with image references, source licence, attribution and a ready-made citation. format=geojson returns a Feature with the polygon.",
    params: ["lang=en|tw", "format=json|geojson"],
    example: "/api/v1/events/{id}?format=geojson",
  },
  {
    path: "GET /api/v1/hotspots",
    summary: "Events aggregated on a lon/lat grid, as GeoJSON points, for maps and dashboards.",
    params: ["hours=1..8760 (default 72)", "cell=0.005..1 degrees (default 0.1)", "bbox, type, severity as above"],
    example: "/api/v1/hotspots?hours=168&cell=0.1",
  },
  {
    path: "GET /api/v1/footprints",
    summary: "Detection polygons inside a bounding box (max 500).",
    params: ["bbox (required)", "hours, type, severity, limit"],
    example: "/api/v1/footprints?bbox=-2.2,5.8,-1.6,6.4&hours=720",
  },
  {
    path: "GET /api/v1/boundaries",
    summary: "Regions and districts (geoBoundaries) with centroid and bbox; q= searches by name.",
    params: ["level=region|district", "region=<region id>", "q=<text> (2–80 characters)"],
    example: "/api/v1/boundaries?q=amansie",
  },
  {
    path: "GET /api/v1/near",
    summary: "Detections within a radius of a point and the district containing it.",
    params: ["lon, lat (required)", "radiusKm=1..100 (default 25)", "limit=1..100"],
    example: "/api/v1/near?lon=-1.62&lat=6.69&radiusKm=20",
  },
  {
    path: "GET /api/v1/sources",
    summary: "The provider registry: licence, attribution, cadence, resolution and last successful fetch.",
    params: [],
    example: "/api/v1/sources",
  },
  {
    path: "GET /api/v1/freshness",
    summary: "When the data last updated, latest image date, stale flag and headline counts.",
    params: [],
    example: "/api/v1/freshness",
  },
  {
    path: "POST /api/v1/reports",
    summary: "Submit a ground report (multipart: photo, lat, lon, description). Reports are moderated before display.",
    params: ["photo (jpeg/png/webp ≤ 5 MB)", "lat, lon inside Ghana", "description ≤ 500 characters", "changeEventId (optional)"],
    example: "curl -F photo=@site.jpg -F lat=6.69 -F lon=-1.62 -F description='Fresh pits beside the river' /api/v1/reports",
  },
];

/** Human-readable API reference. Every endpoint is public, read-only and rate-limited to 120 requests per minute per address. */
export default async function ApiDocsPage({ params }: PageProps<"/[locale]/data/api">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  const td = await getTranslations({ locale, namespace: "data" });
  const tn = await getTranslations({ locale, namespace: "nav" });
  return (
    <AppShell>
      <div className="mx-auto max-w-4xl">
        <nav aria-label="Data section" className="mb-6 flex flex-wrap gap-2 text-sm">
          <Link href="/data" className="rounded-full border px-3 py-1 hover:bg-accent">
            {td("title")}
          </Link>
          <span className="rounded-full bg-forest-50 px-3 py-1 font-medium text-forest-900">{td("apiDocs")}</span>
          <Link href="/data/sources" className="rounded-full border px-3 py-1 hover:bg-accent">
            {tn("sources")}
          </Link>
          <Link href="/data/methods" className="rounded-full border px-3 py-1 hover:bg-accent">
            {tn("methods")}
          </Link>
        </nav>
        <h1 className="text-3xl font-semibold">{td("apiDocs")}</h1>
        <div className="prose-gw mt-3">
          <p>
            The same API that powers the map is open for research and institutional use. All endpoints are read-only unless stated, return JSON
            (or GeoJSON / CSV where noted), and allow 120 requests per minute per address. Responses include <code>Cache-Control</code> so a
            caching proxy can be placed in front for heavier use. There is no key for read access; please identify your project in the{" "}
            <code>User-Agent</code> header so usage can be understood.
          </p>
          <p>
            Every record carries <code>image_date</code> (the satellite acquisition date), <code>detected_at</code>, <code>confidence</code>,{" "}
            <code>source</code> and <code>status</code>. Records with status <code>dismissed</code> are excluded from all public responses.
          </p>
        </div>
        <ul className="mt-8 space-y-6">
          {ENDPOINTS.map((e) => (
            <li key={e.path} className="rounded-xl border bg-card p-5">
              <h2 className="font-mono text-base font-semibold">{e.path}</h2>
              <p className="mt-2 text-sm text-foreground/90">{e.summary}</p>
              {e.params.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {e.params.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0}>
                <code>{e.example}</code>
              </pre>
            </li>
          ))}
        </ul>
        <div className="prose-gw mt-10">
          <h2>Errors</h2>
          <p>
            Errors are JSON with <code>error</code>, <code>message</code> and optional <code>details</code>. <code>400</code> invalid parameters,{" "}
            <code>404</code> unknown record, <code>413</code>/<code>415</code> bad upload, <code>429</code> rate limited (see{" "}
            <code>Retry-After</code>), <code>503</code> data store unavailable.
          </p>
          <h2>Licence and citation</h2>
          <p>
            Derived records are CC BY 4.0. Source products keep their own licences, listed on the <Link href="/data/sources">data sources</Link>{" "}
            page and in each record. Cite as: GhanaWatch (<CitationYear />). Environmental change detections for Ghana [data set].
          </p>
        </div>
      </div>
    </AppShell>
  );
}
