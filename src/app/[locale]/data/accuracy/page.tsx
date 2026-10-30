import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { sql } from "drizzle-orm";
import { resolveLocale } from "@/i18n/locale";
import { AppShell } from "@/components/layout/app-shell";
import { Link } from "@/i18n/navigation";
import { getDb, rows as toRows } from "@/lib/db/client";
import { wilson } from "@/lib/domain/uncertainty";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Accuracy" };

/**
 * Measured accuracy of what the site shows by default, from checks of random samples against
 * before/after satellite imagery. Every check is a row in accuracy_checks, entered by a moderator from
 * the review sheets, never computed from the detections themselves. The latest headline optical check
 * also sets the precision the index's likely range uses.
 */
const KIND_LABEL: Record<string, string> = {
  optical: "Galamsey sites seen in optical images (pits, ponds, cleared ground)",
  radar: "New ponds seen by radar (through cloud)",
  urgent: "Urgent sites (red on the map)",
  cleared_near_pits: "Cleared ground within about 1 km of mining pits, shown as medium confidence",
  flood_south: "Clearing and landfill in waterways, south of 8°N",
  flood_north: "Clearing and landfill in waterways, north of 8°N (left out)",
  detection_rate: "Blind squares with new mining that the map showed",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

interface CheckRow {
  checked_on: string;
  label: string;
  kind: string;
  region: string | null;
  checked: number;
  correct: number;
  note: string | null;
  headline: boolean;
}

export default async function AccuracyPage({ params }: PageProps<"/[locale]/data/accuracy">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <nav aria-label="Data section" className="mb-6 flex flex-wrap gap-2 text-sm">
          <Link href="/data" className="rounded-full border px-3 py-1 hover:bg-accent">
            Data
          </Link>
          <Link href="/data/methods" className="rounded-full border px-3 py-1 hover:bg-accent">
            Reading the map
          </Link>
          <span className="rounded-full bg-forest-50 px-3 py-1 font-medium text-forest-900">Accuracy</span>
        </nav>
        <h1 className="text-3xl font-semibold">How accurate is GhanaWatch?</h1>
        <Suspense fallback={<Skeleton className="mt-6 h-96 w-full" />}>
          <Checks />
        </Suspense>
      </div>
    </AppShell>
  );
}

async function Checks() {
  await connection();
  const db = await getDb();
  const rows = toRows<CheckRow>(await db.execute(sql`select checked_on::text, label, kind, region, checked, correct, note, headline from accuracy_checks order by checked_on desc, created_at desc`));
  const latestHeadline = rows.filter((r) => r.headline && r.kind !== "detection_rate");
  const headlineDate = latestHeadline[0]?.checked_on;
  const head = latestHeadline.filter((r) => r.checked_on === headlineDate);
  const k = head.reduce((a, r) => a + Number(r.correct), 0);
  const n = head.reduce((a, r) => a + Number(r.checked), 0);
  const [lo, hi] = n ? wilson(k, n) : [0, 1];
  const detection = rows.find((r) => r.kind === "detection_rate");
  // Group rows into checks by date and label, newest first.
  const groups = new Map<string, CheckRow[]>();
  for (const r of rows) {
    const key = `${r.checked_on}|${r.label}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return (
    <>
      {n > 0 ? (
        <p className="mt-3 max-w-[65ch] text-lg text-ink-soft">
          In the latest check across Ghana, {k} of {n} randomly chosen detections shown on the map were real ({pct(k / n)}; with a sample this size the true
          figure is likely between {pct(lo)} and {pct(hi)}).{" "}
          {detection ? `At the same time the map still misses most new mining: in ${Number(detection.checked)} blind squares with new mining, it showed a detection in ${Number(detection.correct)}.` : ""}{" "}
          These two rates set the likely range on every index figure.
        </p>
      ) : (
        <p className="mt-3 text-lg text-ink-soft">No check has been recorded yet.</p>
      )}

      <div className="prose-gw mt-8">
        <h2>How it is measured</h2>
        <p>
          Detections are drawn at random from everything the map shows by default. Each one is compared by eye with satellite images from before and
          after the change, with the detection outlined. It counts as correct when the change is real and is what the detection says (mining pits,
          ponds or cleared ground; not a new road, building site or shadow). Licensed mines count as correct, since they are labelled. Every check is
          listed below with its misses, and the next check uses a new sample. Each monthly release also checks 30 of the month&apos;s new sites before it is
          published; sites that fail are left out of the index.
        </p>
      </div>

      {[...groups.entries()].map(([key, items]) => (
        <section key={key} className="mt-8">
          <h2 className="text-xl font-semibold">
            {items[0].label} <span className="text-base font-normal text-muted-foreground">· {new Date(`${items[0].checked_on}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</span>
          </h2>
          <div className="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Accuracy checks">
            <table className="gw-table">
              <thead>
                <tr>
                  <th>{items[0].kind === "detection_rate" ? "Blind squares with mining" : "Detection"}</th>
                  <th>{items[0].kind === "detection_rate" ? "Squares" : "Checked"}</th>
                  <th>{items[0].kind === "detection_rate" ? "Map showed it" : "Correct"}</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {KIND_LABEL[r.kind] ?? r.kind}
                      {r.region ? ` (${r.region})` : ""}
                    </td>
                    <td className="tabular-nums">{Number(r.checked)}</td>
                    <td className="tabular-nums">{Number(r.correct)}</td>
                    <td className="tabular-nums">{pct(Number(r.correct) / Number(r.checked))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.filter((r) => r.note).map((r, i) => (
            <p key={i} className="mt-2 max-w-[75ch] text-sm text-muted-foreground">
              {r.note}
            </p>
          ))}
        </section>
      ))}

      <div className="prose-gw mt-10">
        <h2>What happens to detections that fail the checks</h2>
        <p>
          Nothing is deleted. Detections that could not be confirmed stay available through the &quot;Show possible detections&quot; switch on the map and in
          every download, labelled low confidence. A site rejected in a monthly confirmation sample is left out of that month&apos;s index.
        </p>
        <h2>What is not measured well yet</h2>
        <ul>
          <li>Fires are not part of this check, since a fire cannot be confirmed afterwards from these images.</li>
          <li>Each check is one reviewer judging the images by eye. Very small pits and logging under the canopy cannot be judged this way.</li>
          <li>The detection rate rests on a small number of blind squares; it is re-measured after every change to the method.</li>
        </ul>
      </div>
    </>
  );
}
