import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/locale";
import { Suspense } from "react";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { AppShell } from "@/components/layout/app-shell";
import { Link } from "@/i18n/navigation";
import { getDb, rows as toRows } from "@/lib/db/client";
import { INDEX_VERSION } from "@/lib/domain/index";
import { latestRates } from "@/lib/server/index/close";

export const metadata: Metadata = { title: "Reading the map and the index" };

/**
 * What the map's records, colours and confidence levels mean, in plain words. How detections are made is
 * deliberately not described.
 */
export default async function ReadingTheMapPage({
  params,
}: PageProps<"/[locale]/data/methods">) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <nav
          aria-label="Data section"
          className="mb-6 flex flex-wrap gap-2 text-sm"
        >
          <Link
            href="/data"
            className="rounded-full border px-3 py-1 hover:bg-accent"
          >
            Data
          </Link>
          <span className="rounded-full bg-forest-50 px-3 py-1 font-medium text-forest-900">
            Reading the map
          </span>
          <Link
            href="/data/accuracy"
            className="rounded-full border px-3 py-1 hover:bg-accent"
          >
            Accuracy
          </Link>
          <Link
            href="/data/sources"
            className="rounded-full border px-3 py-1 hover:bg-accent"
          >
            Credits
          </Link>
        </nav>
        <h1 className="text-3xl font-semibold">
          Reading the map and the index
        </h1>
        <div className="prose-gw mt-6">
          <h2>The Galamsey Index</h2>
          <p>
            For every district and month, the index is the hectares of land
            first seen as likely galamsey in that month, per 100 km² of the
            district, so that a small district and a large one can be compared.
            Districts rank by it; rank 1 is the worst month. The report also
            gives the new hectares themselves, the running total since the start
            of the record, the share inside forest reserves and on the watched
            rivers, and a likely range.
          </p>
          <ul>
            <li>
              <strong>A site is counted once.</strong> A detection within about
              200 m of an earlier one is the same site, and a site counts in the
              month it was first seen; a rescan that confirms it does not make
              it new again.
            </li>
            <li>
              <strong>Named large-scale mines are left out.</strong> Work inside
              a mapped licensed mine is never counted as galamsey.
            </li>
            <li>
              <strong>The likely range</strong> corrects the mapped area for the
              latest measured precision (random detections checked by eye) and
              detection rate (blind squares), with 95% intervals on both; see
              the <Link href="/data/accuracy">accuracy page</Link>.
            </li>
            <li>
              <strong>Frozen numbers.</strong> A month is closed on the first
              Monday after it ends and never changes under the same index
              version. A method change creates a new version, reprocesses the
              whole series and is recorded below.
            </li>
            <li>
              <strong>History.</strong> Months before GhanaWatch went live come
              from the same method run on past imagery, cell by cell and month
              by month; the earliest months rest on 2019 baseline imagery and
              are marked where the baseline was thin.
            </li>
          </ul>
          <Suspense fallback={null}>
            <IndexStatus />
          </Suspense>

          <h2>What a detection is</h2>
          <p>
            A detection is a place where satellite images show a clear change:
            ground opened up for mining, trees cleared, new ponds or a river
            turning muddy, a fire, or a river forecast to flood. Each one shows
            the date it was seen, its size, how sure we are, and before and
            after images. It is not a finding that anything is lawful or
            unlawful.
          </p>

          <h2>Colours: risk level</h2>
          <ul>
            <li>
              <strong>Urgent</strong> (red): a mining site of 15 ha or more; 10
              ha or more of pits within 1 km; or a site of 2 ha or more inside a
              forest reserve, a town or near a school; or a river forecast above
              its 5-year flood level.
            </li>
            <li>
              <strong>Elevated</strong> (orange): a sizeable site, or a smaller
              one in a sensitive place.
            </li>
            <li>
              <strong>Watch</strong> (yellow) and <strong>Normal</strong>{" "}
              (green): smaller changes worth keeping an eye on.
            </li>
            <li>
              <strong>Inside a licensed mine</strong> (grey): work inside a
              large-scale mine. It is shown, but never counted as galamsey and
              never urgent. Licensed mine areas come from OpenStreetMap and are
              incomplete, so a site outside them is not proof that it is
              illegal.
            </li>
          </ul>

          <h2>Confidence: shown and possible</h2>
          <p>
            The map shows detections that passed GhanaWatch&apos;s checks.
            Detections that could not be confirmed are kept as{" "}
            <strong>possible</strong>: switch them on under Layers on the map,
            and they are in every download, labelled low confidence. The{" "}
            <Link href="/data/accuracy">accuracy page</Link> shows how often
            shown detections turned out to be real.
          </p>

          <h2>What the map cannot tell you</h2>
          <ul>
            <li>
              Whether a change is legal. Farms, roads and licensed mines can
              look like illegal mining from space.
            </li>
            <li>
              What happened under cloud. In the rainy season some areas have no
              clear image for weeks.
            </li>
            <li>
              Very small or slow changes, or who did something. People are never
              identified.
            </li>
            <li>
              In the savannah north, flooded fields and new farms look like
              mining, so fewer detections are shown there.
            </li>
            <li>
              A flood forecast is a forecast, not a report that flooding has
              happened.
            </li>
          </ul>

          <h2>Live data only</h2>
          <p>GhanaWatch never shows sample or simulated detections.</p>

          <Suspense fallback={null}>
            <Corrections />
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}

async function IndexStatus() {
  await connection();
  const rates = await latestRates();
  return (
    <p className="text-sm text-muted-foreground">
      Current index version: <strong>{INDEX_VERSION}</strong>. Precision in use:{" "}
      {rates.precision
        ? `${rates.precision.k} of ${rates.precision.n} checked detections were real`
        : "no check recorded yet"}
      ; detection rate in use:{" "}
      {rates.detection
        ? `${rates.detection.k} of ${rates.detection.n} blind squares with mining were found`
        : "no blind check recorded yet"}
      .
    </p>
  );
}

/** Every change to a published number, dated, with the reason. */
async function Corrections() {
  await connection();
  const db = await getDb();
  const rows = toRows<{
    published_on: string;
    month: string | null;
    index_version: string;
    what_changed: string;
    why: string;
  }>(
    await db.execute(
      sql`select published_on::text, month, index_version, what_changed, why from corrections order by published_on desc, created_at desc limit 100`,
    ),
  );
  return (
    <>
      <h2>Corrections log</h2>
      {rows.length === 0 ? (
        <p>
          No published figure has been changed yet. When one is, the date, the
          month affected, the index version and the reason appear here.
        </p>
      ) : (
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="region"
          aria-label="Corrections log"
        >
          <table className="gw-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Month</th>
                <th>Version</th>
                <th>What changed</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="tabular-nums">{String(r.published_on)}</td>
                  <td className="tabular-nums">{r.month ?? "all"}</td>
                  <td className="tabular-nums">{r.index_version}</td>
                  <td>{r.what_changed}</td>
                  <td>{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
