import { sql } from "drizzle-orm";
import { getDb, rows as toRows } from "@/lib/db/client";
import { alertDigests } from "@/lib/db/schema";
import { FIRST_CONFIRMED } from "@/lib/server/index/first-confirmed";
import { scoreKind, slugify } from "@/lib/domain/scorecards";
import { env } from "@/lib/server/env";
import { uuidv7 } from "@/lib/server/ids";
import { mailConfigured, sendMail } from "@/lib/server/mail";

/**
 * The weekly digest: every likely galamsey site first seen in the last seven days (for the multi-sensor record,
 * first published: its onset is months earlier, when mining began), grouped by district,
 * each linking to its evidence page. Written once per week (alert_digests), posted to the WhatsApp
 * channel by hand from the text, served as RSS and JSON, and emailed to confirmed subscribers (the
 * national digest, or only their district).
 */
export interface DigestSite {
  id: string;
  title: string;
  areaHa: number;
  firstSeen: string;
  reserve: string | null;
  url: string;
}

export interface DigestDistrict {
  districtId: string;
  name: string;
  slug: string;
  region: string | null;
  sites: DigestSite[];
  ha: number;
}

export interface Digest {
  weekEnding: string;
  since: string;
  newSites: number;
  newHa: number;
  districts: DigestDistrict[];
  text: string;
}

const fmtHa = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

export async function buildDigest(weekEnding: Date): Promise<Digest> {
  const db = await getDb();
  const origin = env().PUBLIC_ORIGIN;
  const end = weekEnding.toISOString().slice(0, 10);
  const since = new Date(weekEnding.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = toRows<{ id: string; title: string; ha: number; first: string; reserve: string | null; district_id: string; district: string; region: string | null; type: string; method_version: string; sig: string | null; confidence: string }>(
    await db.execute(sql`
      with seen as (
        select e.*, case when e.method_version like 's2-galamsey-3.%' then e.created_at::date else coalesce(e.first_image_date, e.image_date) end as first_seen, fc.m as first_confirmed
        from change_events e
        left join ${FIRST_CONFIRMED} fc on fc.source_event_id = e.source_event_id and e.method_version like 's2-galamsey-3.%'
      )
      select e.id::text, e.title_en as title, coalesce(e.area_ha, 0)::float ha, e.first_seen::text as first,
        e.properties->'placement'->>'protectedArea' reserve, d.id::text as district_id, d.name as district, r.name as region,
        e.type, e.method_version, e.properties->>'signature' sig, e.confidence
      from seen e
      join admin_boundaries d on d.id = e.district_id
      left join admin_boundaries r on r.id = d.parent_id
      where e.status <> 'dismissed' and e.properties->'placement'->>'mine' is null and not (e.properties ? 'licensedMine')
        and e.first_seen > ${since}::date and e.first_seen <= ${end}::date
        -- A multi-sensor site is new when first published, unless its record confirmed it long before (a cell whose
        -- detections were published for the first time after its history was built).
        and (e.first_confirmed is null or e.first_confirmed >= to_char(e.created_at - interval '40 days', 'YYYY-MM'))
        and (e.method_version like 's2-galamsey-%' or e.method_version like 's1-water-%')
      order by e.area_ha desc nulls last`),
  );
  const by = new Map<string, DigestDistrict>();
  for (const r of rows) {
    if (!scoreKind({ type: r.type, methodVersion: r.method_version, signature: r.sig, confidence: r.confidence }).likely) continue;
    const d = by.get(r.district_id) ?? { districtId: r.district_id, name: r.district, slug: slugify(r.district), region: r.region, sites: [], ha: 0 };
    d.sites.push({ id: r.id, title: r.title, areaHa: Number(r.ha), firstSeen: r.first, reserve: r.reserve, url: `${origin}/event/${r.id}` });
    d.ha = Math.round((d.ha + Number(r.ha)) * 10) / 10;
    by.set(r.district_id, d);
  }
  const districts = [...by.values()].sort((a, b) => b.ha - a.ha);
  const newSites = districts.reduce((a, d) => a + d.sites.length, 0);
  const newHa = Math.round(districts.reduce((a, d) => a + d.ha, 0) * 10) / 10;
  return { weekEnding: end, since, newSites, newHa, districts, text: digestText({ weekEnding: end, since, newSites, newHa, districts }, origin) };
}

/** The WhatsApp post: under 1,000 characters, the worst districts first, one link to the rest. */
export function digestText(d: Omit<Digest, "text">, origin: string): string {
  const head = `*GhanaWatch weekly, ${d.weekEnding}*\n${d.newSites} new likely galamsey sites (${fmtHa(d.newHa)} ha) first seen from space in the last 7 days.`;
  if (!d.newSites) return `${head}\nNo new sites passed the checks this week; cloud may have hidden the ground.\n${origin}/alerts`;
  const lines: string[] = [];
  for (const dist of d.districts.slice(0, 6)) {
    const worst = dist.sites[0];
    lines.push(`• ${dist.name}: ${dist.sites.length} site${dist.sites.length === 1 ? "" : "s"}, ${fmtHa(dist.ha)} ha${worst?.reserve ? `, inside ${worst.reserve}` : ""} ${worst.url}`);
  }
  const more = d.districts.length > 6 ? `\n…and ${d.districts.length - 6} more districts.` : "";
  const text = `${head}\n${lines.join("\n")}${more}\nAll sites, with before/after pictures: ${origin}/alerts\nGhanaWatch, KNUST`;
  return text.length <= 1000 ? text : `${text.slice(0, 999)}…`;
}

/** Writes the week's digest once and emails it to confirmed subscribers. Idempotent per week. */
export async function publishDigest(weekEnding: Date, log: (s: string) => void): Promise<{ digest: Digest; emails: number; created: boolean }> {
  const db = await getDb();
  const digest = await buildDigest(weekEnding);
  const [existing] = toRows<{ id: string }>(await db.execute(sql`select id::text from alert_digests where week_ending = ${digest.weekEnding}::date`));
  if (existing) {
    log(`digest: ${digest.weekEnding} already published`);
    return { digest, emails: 0, created: false };
  }
  const summary = { districts: digest.districts.map((d) => ({ district: d.name, slug: d.slug, sites: d.sites.length, ha: d.ha, worst: d.sites[0]?.url ?? null })) };
  let emails = 0;
  if (mailConfigured()) {
    const subs = toRows<{ email: string; district_id: string | null; token: string }>(
      await db.execute(sql`select email, district_id::text, token from alert_subscriptions where confirmed_at is not null and unsubscribed_at is null`),
    );
    const origin = env().PUBLIC_ORIGIN;
    for (const s of subs) {
      const own = s.district_id ? digest.districts.find((d) => d.districtId === s.district_id) : null;
      if (s.district_id && !own) continue; // nothing new in their district this week
      const body = s.district_id && own ? districtText(own, digest, origin) : digest.text;
      const ok = await sendMail({
        to: s.email,
        subject: s.district_id && own ? `GhanaWatch: ${own.sites.length} new site${own.sites.length === 1 ? "" : "s"} in ${own.name} this week` : `GhanaWatch weekly: ${digest.newSites} new galamsey sites seen from space`,
        text: `${body.replace(/\*/g, "")}\n\nUnsubscribe: ${origin}/api/v1/subscriptions/unsubscribe?token=${s.token}`,
      });
      if (ok) emails++;
    }
    log(`digest: ${emails} emails sent to ${subs.length} subscribers`);
  } else log("digest: no mail service set (BREVO_API_KEY), emails skipped");
  await db.insert(alertDigests).values({ id: uuidv7(), weekEnding: digest.weekEnding, newSites: digest.newSites, newHa: digest.newHa, districts: digest.districts.length, summary, text: digest.text, emailsSent: emails });
  return { digest, emails, created: true };
}

function districtText(d: DigestDistrict, digest: Digest, origin: string): string {
  const lines = d.sites.slice(0, 8).map((s) => `• ${s.title} — ${fmtHa(s.areaHa)} ha, seen ${s.firstSeen}${s.reserve ? `, inside ${s.reserve}` : ""}\n  ${s.url}`);
  return `GhanaWatch weekly for ${d.name}, ${digest.weekEnding}\n${d.sites.length} new likely galamsey site${d.sites.length === 1 ? "" : "s"} (${fmtHa(d.ha)} ha) first seen from space in the last 7 days.\n${lines.join("\n")}${d.sites.length > 8 ? `\n…and ${d.sites.length - 8} more.` : ""}\nScorecard: ${origin}/districts/${d.slug}`;
}

export interface PastDigest {
  weekEnding: string;
  newSites: number;
  newHa: number;
  districts: number;
  text: string;
  createdAt: string;
}

export async function pastDigests(limit = 26): Promise<PastDigest[]> {
  const db = await getDb();
  return toRows<{ week_ending: string; new_sites: number; new_ha: number; districts: number; text: string; created_at: string }>(
    await db.execute(sql`select week_ending::text, new_sites, new_ha, districts, text, created_at::text from alert_digests order by week_ending desc limit ${limit}`),
  ).map((r) => ({ weekEnding: String(r.week_ending), newSites: Number(r.new_sites), newHa: Number(r.new_ha), districts: Number(r.districts), text: r.text, createdAt: String(r.created_at) }));
}
