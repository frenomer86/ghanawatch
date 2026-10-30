import { connection } from "next/server";
import { getFormatter } from "next-intl/server";
import { nationalScanStatus } from "@/lib/db/repo/sources";
import type { Locale } from "@/lib/domain/types";
import { Link } from "@/i18n/navigation";
import { Pickaxe } from "lucide-react";

/**
 * Galamsey watch: progress of the nationwide Sentinel-2 scan and what it has
 * found, including detections inside residential areas or forest reserves and
 * near schools, cemeteries or clinics.
 */
export async function GalamseyWatch({ locale }: { locale: Locale }) {
  await connection();
  const s = await nationalScanStatus();
  const f = await getFormatter({ locale });
  const pct = s.cellsTotal ? Math.round((s.cellsScanned / s.cellsTotal) * 100) : 0;
  const regions = s.byRegion.filter((r) => r.scanned > 0).slice(0, 8);
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="galamsey-watch-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="galamsey-watch-h" className="flex items-center gap-2 text-lg font-semibold">
          <Pickaxe className="size-5 text-laterite-600" aria-hidden />
          Galamsey watch
        </h2>
        {s.lastScanAt && (
          <p className="text-xs text-muted-foreground">
            Last scan {f.dateTime(new Date(s.lastScanAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}
          </p>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A satellite scan of all of Ghana for new mining pits and cleared land.
      </p>
      <div className="mt-3">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {s.cellsScanned} of {s.cellsTotal} areas scanned
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${pct}% of Ghana scanned`}>
          <div className="h-full rounded-full bg-laterite-600" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg bg-muted/60 p-2">
          <dt className="text-xs text-muted-foreground">Detections</dt>
          <dd className="font-heading text-xl font-semibold tabular-nums">{f.number(s.detections)}</dd>
        </div>
        <div className="rounded-lg bg-muted/60 p-2">
          <dt className="text-xs text-muted-foreground">With new pits</dt>
          <dd className="font-heading text-xl font-semibold tabular-nums">{f.number(s.withPits)}</dd>
        </div>
        <div className="rounded-lg bg-sev-elevated-tint p-2">
          <dt className="text-xs text-sev-elevated">Near people or reserves</dt>
          <dd className="font-heading text-xl font-semibold tabular-nums text-sev-elevated">{f.number(s.sensitive)}</dd>
        </div>
      </dl>
      {regions.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-medium">Region</th>
              <th className="py-1 text-right font-medium">Detections</th>
              <th className="py-1 text-right font-medium">Scanned</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.region} className="border-t">
                <td className="py-1.5">{r.region}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">{r.sites}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.scanned}/{r.cells}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        &quot;Near people or reserves&quot; means inside a residential area or forest reserve, or within 300 m of a school, cemetery or clinic (OpenStreetMap).{" "}
        <Link href="/map?type=surface_disturbance&hours=2160" className="text-link underline">
          Show on the map
        </Link>{" "}
        ·{" "}
        <Link href="/districts" className="text-link underline">
          District scorecards
        </Link>
      </p>
    </section>
  );
}
