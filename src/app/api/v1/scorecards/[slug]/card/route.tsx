import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { districtBySlug } from "@/lib/db/repo/scorecards";
import { shareOfArea } from "@/lib/domain/scorecards";
import { enforceRateLimit, handle, heavyWork, HttpError } from "@/lib/server/http";
import { TtlCache } from "@/lib/server/explore/cache";

/** A rendered card per district, kept for half an hour: link previews fetch the same card many times. */
const cards = new TtlCache<Uint8Array<ArrayBuffer>>(300, 30 * 60_000);

/**
 * GET /api/v1/scorecards/:slug/card
 * The district scorecard as a 1200 × 630 picture: the preview WhatsApp, X and
 * Facebook show when a scorecard link is shared, and the "Download card" file.
 */
export const GET = handle(async (req: NextRequest, ctx) => {
  enforceRateLimit(req, "heavy");
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new HttpError(404, "No such district");
  const d = await districtBySlug(slug);
  if (!d) throw new HttpError(404, "No such district");
  const png = await cards.get(slug, () => heavyWork(async () => new Uint8Array(await render(d).arrayBuffer()) as Uint8Array<ArrayBuffer>));
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=1800", "x-content-type-options": "nosniff" } });
});

function render(d: NonNullable<Awaited<ReturnType<typeof districtBySlug>>>): ImageResponse {
  const c = d.card;
  const ha = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const share = shareOfArea(c.miningHa, c.areaKm2);
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Accra" });
  const small = [
    { label: "inside forest reserves", value: `${ha(c.inReservesHa)} ha` },
    { label: "sites near homes, schools, clinics", value: String(c.nearPeople) },
    { label: "rivers turned muddy", value: String(c.muddyRivers) },
  ];
  const image = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0f2e22", color: "#f4efe6", padding: "56px 64px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, color: "#c9d8cf" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 34, height: 34, borderRadius: 34, border: "5px solid #e0a35b", display: "flex" }} />
            <span style={{ fontWeight: 700, color: "#f4efe6" }}>GhanaWatch</span>
          </div>
          <span>District scorecard · {date}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
          <span style={{ fontSize: 66, fontWeight: 700, lineHeight: 1.05 }}>{c.name}</span>
          <span style={{ fontSize: 30, color: "#c9d8cf", marginTop: 8 }}>{c.region}</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 28, marginTop: 40 }}>
          <span style={{ fontSize: 112, fontWeight: 800, color: "#f0b46a", lineHeight: 1 }}>{ha(c.miningHa)} ha</span>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 30, paddingBottom: 12 }}>
            <span>likely galamsey seen from space</span>
            <span style={{ color: "#c9d8cf" }}>
              {c.rank ? `number ${c.rank} of ${d.total} districts` : "none found in the current scan"}
              {share ? ` · ${share}% of the district` : ""}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 22, marginTop: "auto" }}>
          {small.map((s) => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", flex: 1, background: "rgba(255,255,255,0.07)", borderRadius: 14, padding: "16px 20px" }}>
              <span style={{ fontSize: 40, fontWeight: 700 }}>{s.value}</span>
              <span style={{ fontSize: 22, color: "#c9d8cf" }}>{s.label}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: 22, fontSize: 20, color: "#9fb5a8" }}>
          Contains modified Copernicus Sentinel data. Changes seen from space, not legal findings.
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
  return image;
}
