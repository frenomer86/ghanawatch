import { useLocale } from "next-intl";
import { getPathname } from "@/i18n/navigation";
import type { Locale } from "@/lib/domain/types";
import type { DistrictMonth } from "@/lib/server/index/read";
import { fmtHa } from "@/components/scorecards/stat";
import { RankArrow } from "./rank-arrow";

/**
 * The league table of a closed month: the districts with new mining, by index. District names are plain
 * links, not client-side <Link>s: a table of up to 260 rows would otherwise hydrate a client component
 * per row and prefetch every scorecard that scrolls into view, which is a lot of mobile data.
 */
export function LeagueTable({ rows, compact = false }: { rows: DistrictMonth[]; compact?: boolean }) {
  const locale = useLocale() as Locale;
  const ranked = rows.filter((r) => r.rank != null);
  if (!ranked.length) return <p className="text-sm text-muted-foreground">No district had new likely mining first seen this month.</p>;
  return (
    <div className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="District league table">
      <table className="gw-table">
        <thead>
          <tr>
            <th>#</th>
            <th>District</th>
            <th>Index</th>
            <th>New this month</th>
            {!compact && <th>Likely range</th>}
            <th>Since start</th>
            {!compact && <th>In reserves</th>}
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => (
            <tr key={r.districtId}>
              <td className="tabular-nums">{r.rank}</td>
              <td>
                <a href={getPathname({ href: `/districts/${r.slug}`, locale })} className="font-medium text-link underline-offset-2 hover:underline">
                  {r.name}
                </a>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{r.region?.replace(/ Region$/, "")}</span>
                  <RankArrow movement={r.movement} />
                </div>
              </td>
              <td className="tabular-nums">
                {r.index.toFixed(1)}
                <div className="text-xs text-muted-foreground">ha per 100 km²</div>
              </td>
              <td className="tabular-nums">
                {fmtHa(r.newHa)} ha<div className="text-xs text-muted-foreground">{r.newSites} sites</div>
              </td>
              {!compact && <td className="tabular-nums">{r.ciLow != null && r.ciHigh != null ? `${fmtHa(r.ciLow)}–${fmtHa(r.ciHigh)} ha` : "–"}</td>}
              <td className="tabular-nums">{fmtHa(r.cumHa)} ha</td>
              {!compact && <td className="tabular-nums">{r.pctForest != null ? `${r.pctForest}%` : "–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
