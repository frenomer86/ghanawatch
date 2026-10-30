import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Geometry } from "geojson";
import { getDb, rows as toRows } from "@/lib/db/client";
import { confirmationSamples, releases } from "@/lib/db/schema";
import { INDEX_VERSION, monthLabel, monthOf } from "@/lib/domain/index";
import { env } from "@/lib/server/env";
import { uuidv7 } from "@/lib/server/ids";
import { renderEventImage } from "@/lib/server/events/image";
import { closeMonth } from "@/lib/server/index/close";
import { clearIndexCache } from "@/lib/server/index/read";
import { squareCardSvg, svgToPng, wideCardSvg } from "./cards";
import { releaseData } from "./data";
import { districtsGeoJson, indexCsv, nationalCsv, reservesCsv, riversCsv, sitesGeoJson, writeFile, type WrittenFile } from "./files";
import { releasePdf, type FeaturedImage } from "./pdf";
import { pressRelease } from "./press";
import { depositOnZenodo } from "./zenodo";

/**
 * One monthly release, start to finish: close the index, draw the confirmation sample, write the open
 * data, the PDF, the press release and the cards under public/releases/{month}/ (under DATA_DIR/releases-staging/
 * for a dry run), append the changelog, record the release and, when a token is set, deposit on Zenodo.
 *
 * The release refuses to publish while the month's confirmation sample has unchecked sites, unless
 * --skip-sample is passed; the sample is what keeps the numbers honest.
 */
export interface ReleaseOptions {
  month: string;
  dryRun?: boolean;
  skipSample?: boolean;
  /** Re-release a month already published (after a corrections entry). */
  force?: boolean;
  log?: (s: string) => void;
}

export interface ReleaseResult {
  month: string;
  dir: string;
  files: WrittenFile[];
  headline: string;
  doi: string | null;
  dryRun: boolean;
}

export const SAMPLE_SIZE = 30;

export async function runRelease(opts: ReleaseOptions): Promise<ReleaseResult> {
  const log = opts.log ?? (() => undefined);
  const { month } = opts;
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Not a month: ${month}`);
  if (month >= monthOf(new Date())) throw new Error(`${month} has not ended yet`);
  const origin = env().PUBLIC_ORIGIN;
  const db = await getDb();
  const dryRun = Boolean(opts.dryRun);
  const releaseDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Accra" });

  // 1. A month already released is never rewritten by accident.
  const [published] = toRows<{ n: number }>(await db.execute(sql`select count(*)::int n from releases where month = ${month} and index_version = ${INDEX_VERSION} and not dry_run`));
  const alreadyPublished = Number(published?.n ?? 0) > 0;
  if (!dryRun && alreadyPublished && !opts.force) {
    throw new Error(`${month} was already released under index ${INDEX_VERSION}; a change needs a corrections entry and --force`);
  }

  // 2. The confirmation sample: draw it if it does not exist, dismiss what was rejected, refuse to publish
  //    while sites are unchecked.
  const sample = await ensureSample(month, log);
  if (!dryRun && !opts.skipSample && sample.unchecked > 0) {
    throw new Error(`${sample.unchecked} of ${sample.total} sampled sites for ${month} are unchecked; review them at /admin (or pass --skip-sample)`);
  }
  if (sample.rejected > 0) log(`sample: ${sample.rejected} sites rejected and left out of the index`);

  // 3. Close the index for the month (and any earlier months still open). The month being released is
  //    recomputed so the sample's rejections count; months already published are left as they are, so a
  //    dry run of a published month never moves its figures. The Wednesday dry run therefore closes the
  //    month provisionally and the Monday release recomputes it with the sample's verdicts in.
  await closeMonth(month, { log, force: alreadyPublished && !opts.force ? [] : [month] });

  // 4. Everything the files are made of.
  const d = await releaseData(month);
  // A dry run never lands under public/, so nothing half-made can be served.
  const dir = dryRun ? join(process.cwd(), env().DATA_DIR, "releases-staging", month) : join(process.cwd(), "public", "releases", month);
  if (dryRun && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: WrittenFile[] = [];
  const outlines = new Map<string, Geometry>(
    toRows<{ id: string; geom: Geometry }>(await db.execute(sql`select id::text, geom from admin_boundaries where level = 'district' and geom is not null`)).map((r) => [r.id, r.geom]),
  );
  files.push(writeFile(dir, `ghanawatch_index_${month}.csv`, indexCsv(d)));
  files.push(writeFile(dir, `ghanawatch_national_${month}.csv`, nationalCsv(d)));
  files.push(writeFile(dir, `ghanawatch_districts_${month}.geojson`, districtsGeoJson(d, outlines)));
  files.push(writeFile(dir, `ghanawatch_sites_${month}.geojson`, sitesGeoJson(d, origin)));
  files.push(writeFile(dir, `ghanawatch_rivers_${month}.csv`, riversCsv(d)));
  files.push(writeFile(dir, `ghanawatch_reserves_${month}.csv`, reservesCsv(d)));
  log(`files: ${files.length} data files written`);

  // 5. Pictures for the featured sites, then the PDF.
  const images: FeaturedImage[] = [];
  for (const s of d.featured) {
    if (!s.eventId) continue;
    try {
      const [before, after] = await Promise.all([renderEventImage(s.eventId, "before"), renderEventImage(s.eventId, "latest")]);
      images.push({ siteId: s.id, before, after });
    } catch (e) {
      log(`images: ${s.eventId} skipped (${e instanceof Error ? e.message : String(e)})`);
      images.push({ siteId: s.id, before: null, after: null });
    }
  }
  files.push(writeFile(dir, `ghanawatch_report_${month}.pdf`, Buffer.from(await releasePdf(d, origin, images))));
  log("pdf: written");

  // 6. Press release, WhatsApp post and thread.
  const press = pressRelease(d, origin, releaseDate);
  files.push(writeFile(dir, "press-release.md", press.markdown));
  files.push(writeFile(dir, "press-release.docx", press.docx));
  files.push(writeFile(dir, "whatsapp.txt", press.whatsapp));
  files.push(writeFile(dir, "thread.txt", press.thread.join("\n\n")));

  // 7. Cards for every ranked district, both sizes.
  const cardDir = join(dir, "cards");
  let cards = 0;
  for (const r of d.rankings.filter((x) => x.rank != null)) {
    const input = { d: r, total: d.rankings.length, label: d.label, releaseDate, outline: outlines.get(r.districtId) ?? null };
    writeFile(cardDir, `${r.slug}.png`, await svgToPng(wideCardSvg(input)));
    writeFile(cardDir, `${r.slug}-square.png`, await svgToPng(squareCardSvg(input)));
    cards += 2;
  }
  log(`cards: ${cards} written`);

  // 8. Manifest and changelog.
  const manifest = {
    month,
    label: d.label,
    indexVersion: INDEX_VERSION,
    detectionMethod: process.env.GW_DETECTOR === "legacy" ? "s2-galamsey-2.3 + s1-water-1.0" : "s2-galamsey-3.0 (monthly multi-sensor record)",
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    headline: press.headline,
    national: { newHa: d.national.newHa, ciLow: d.national.ciLow, ciHigh: d.national.ciHigh, cumHa: d.national.cumHa, districtsAffected: d.national.districtsAffected, topDistrict: d.national.topDistrict?.name ?? null },
    sample: { total: sample.total, confirmed: sample.confirmed, rejected: sample.rejected, unclear: sample.unclear, unchecked: sample.unchecked },
    files,
    licence: "CC BY 4.0",
    attribution: "GhanaWatch, KNUST. Contains modified Copernicus Sentinel data.",
    doi: null as string | null,
  };
  if (!dryRun) {
    const changelog = join(process.cwd(), "public", "releases", "CHANGELOG.md");
    const line = `\n## ${monthLabel(month)} (${month}) — released ${releaseDate}\n\n- ${press.headline}\n- Index version ${INDEX_VERSION}; ${d.rankings.filter((r) => r.rank != null).length} districts ranked; ${d.sites.length} sites first seen.\n- Confirmation sample: ${sample.confirmed} confirmed, ${sample.rejected} rejected, ${sample.unclear} unclear of ${sample.total}.\n`;
    if (!existsSync(changelog)) writeFileSync(changelog, "# GhanaWatch releases\n");
    appendFileSync(changelog, line);
  }

  // 9. Zenodo, then the record of the release.
  let doi: string | null = null;
  if (!dryRun) {
    try {
      const dep = await depositOnZenodo({
        dir,
        files: files.filter((f) => !f.name.endsWith(".docx") && !f.name.endsWith(".txt")).map((f) => f.name),
        title: `GhanaWatch Galamsey Index, ${d.label}`,
        description: `${press.headline}. Monthly open-data release of the GhanaWatch Galamsey Index (index version ${INDEX_VERSION}): per-district index, national series, sites first seen in the month, rivers and forest reserves. Contains modified Copernicus Sentinel data.`,
        month,
        version: INDEX_VERSION,
        log,
      });
      doi = dep?.doi ?? null;
    } catch (e) {
      log(`zenodo: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  manifest.doi = doi;
  files.push(writeFile(dir, "manifest.json", JSON.stringify(manifest, null, 2)));
  await db
    .insert(releases)
    .values({ month, indexVersion: INDEX_VERSION, publishedAt: new Date(), dryRun, doi, manifest, headline: press.headline })
    .onConflictDoUpdate({ target: [releases.month, releases.indexVersion], set: { publishedAt: sql`excluded.published_at`, dryRun: sql`excluded.dry_run`, doi: sql`excluded.doi`, manifest: sql`excluded.manifest`, headline: sql`excluded.headline` } });
  clearIndexCache();
  log(`${dryRun ? "dry run" : "release"} ${month}: ${press.headline}`);
  return { month, dir, files, headline: press.headline, doi, dryRun };
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Draws SAMPLE_SIZE sites first seen in the month at random (once), reports its state, and dismisses the
 * sites a moderator rejected so the index close that follows leaves them out.
 */
export async function ensureSample(month: string, log: (s: string) => void) {
  const db = await getDb();
  const [have] = toRows<{ n: number }>(await db.execute(sql`select count(*)::int n from confirmation_samples where month = ${month}`));
  if (Number(have?.n ?? 0) === 0) {
    const picks = toRows<{ id: string }>(
      await db.execute(sql`
        select id::text from change_events
        where status <> 'dismissed' and confidence in ('medium', 'high') and properties->'placement'->>'mine' is null and not (properties ? 'licensedMine')
          and to_char(coalesce(first_image_date, image_date), 'YYYY-MM') = ${month}
          and ((method_version like 's2-galamsey-%' and properties->>'signature' in ('new_pits', 'cleared_with_pits', 'mining')) or method_version like 's1-water-%')
        order by md5(id::text || ${month}) limit ${SAMPLE_SIZE}`),
    );
    if (picks.length) await db.insert(confirmationSamples).values(picks.map((p) => ({ id: uuidv7(), month, changeEventId: p.id })));
    log(`sample: ${picks.length} sites drawn for ${month}`);
  }
  // Rejected sites leave the index.
  await db.execute(sql`
    update change_events e set status = 'dismissed', properties = coalesce(e.properties, '{}'::jsonb) || jsonb_build_object('autoDismissed', 'rejected in the monthly confirmation sample')
    from confirmation_samples s where s.change_event_id = e.id and s.month = ${month} and s.verdict = 'rejected' and e.status <> 'dismissed'`);
  const [c] = toRows<{ total: number; confirmed: number; rejected: number; unclear: number; unchecked: number }>(
    await db.execute(sql`
      select count(*)::int total, count(*) filter (where verdict = 'confirmed')::int confirmed, count(*) filter (where verdict = 'rejected')::int rejected,
        count(*) filter (where verdict = 'unclear')::int unclear, count(*) filter (where verdict is null)::int unchecked
      from confirmation_samples where month = ${month}`),
  );
  return { total: Number(c?.total ?? 0), confirmed: Number(c?.confirmed ?? 0), rejected: Number(c?.rejected ?? 0), unclear: Number(c?.unclear ?? 0), unchecked: Number(c?.unchecked ?? 0) };
}

/** Re-read the manifest of a published release, for pages that list what was released. */
export function readManifest(month: string): Record<string, unknown> | null {
  const f = join(process.cwd(), "public", "releases", month, "manifest.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : null;
}
