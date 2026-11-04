import { Link } from "@/i18n/navigation";
import { districtShapes } from "@/lib/server/map/district-shapes";

/**
 * Ghana's districts drawn on the server as one SVG: shaded by a value (hectares newly mined) or with one
 * district picked out, each district a link to its page with its name and value in a native tooltip. No map
 * library, no tiles: it renders in the first response and prints.
 */

/** Ochre from pale to deep: the colour of freshly dug laterite and pit water. */
export const OCHRE = ["#f2e3c4", "#e2c07a", "#c9952f", "#a26812", "#6d4306"];
const NONE = "#e2e8e4";

/** Class breaks at the quintiles of the districts that have any value, rounded to readable numbers. */
export function breaks(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 5) return [0.01, 1, 5, 20, 50].slice(0, Math.max(1, v.length));
  const nice = (x: number) => (x < 1 ? Math.round(x * 10) / 10 : x < 10 ? Math.round(x) : x < 100 ? Math.round(x / 5) * 5 : Math.round(x / 10) * 10);
  const q = [0, 0.2, 0.4, 0.6, 0.8].map((p) => nice(v[Math.floor(p * (v.length - 1))]));
  return [...new Set(q)].sort((a, b) => a - b);
}

function classOf(x: number, b: number[]): number {
  if (!(x > 0)) return -1;
  let i = 0;
  while (i + 1 < b.length && x >= b[i + 1]) i++;
  return Math.min(i, OCHRE.length - 1);
}

const fmt = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-GB") : x >= 10 ? Math.round(x).toString() : x.toFixed(1));

export async function DistrictMap({
  values,
  unit,
  title,
  highlight,
  className,
  legend = true,
}: {
  /** District id to value; districts without one are drawn pale. */
  values?: Record<string, number>;
  unit?: string;
  title: string;
  /** A district to pick out (locator maps): drawn in forest green, the rest pale. */
  highlight?: string;
  className?: string;
  legend?: boolean;
}) {
  const shapes = await districtShapes();
  const b = values ? breaks(Object.values(values)) : [];
  const ordered = highlight ? [...shapes.districts.filter((d) => d.id !== highlight), ...shapes.districts.filter((d) => d.id === highlight)] : shapes.districts;
  return (
    <figure className={className}>
      <svg viewBox={`-2 -2 ${shapes.width + 4} ${shapes.height + 4}`} role="img" aria-label={title} className="h-auto w-full">
        <title>{title}</title>
        {ordered.map((d) => {
          const v = values?.[d.id] ?? 0;
          const c = classOf(v, b);
          const fill = highlight ? (d.id === highlight ? "var(--gw-forest-700)" : NONE) : c >= 0 ? OCHRE[c] : NONE;
          const label = values ? `${d.name}: ${v > 0 ? `${fmt(v)} ${unit ?? ""}` : "none"}` : d.name;
          return (
            <Link key={d.id} href={`/districts/${d.slug}`} aria-label={label}>
              <path d={d.d} fill={fill} stroke="#ffffff" strokeWidth={d.id === highlight ? 1.2 : 0.6} strokeLinejoin="round" className="transition-[fill-opacity] hover:fill-opacity-80">
                <title>{label}</title>
              </path>
            </Link>
          );
        })}
      </svg>
      {legend && values && b.length > 0 && (
        <figcaption className="mt-3 text-sm text-muted-foreground">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-3 border border-border" style={{ background: NONE }} />
              None
            </li>
            {b.map((lo, i) => (
              <li key={lo} className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden className="inline-block size-3" style={{ background: OCHRE[i] }} />
                {i + 1 < b.length ? `${fmt(lo)}–${fmt(b[i + 1])}` : `${fmt(lo)} or more`}
              </li>
            ))}
            {unit && <li>{unit}</li>}
          </ul>
        </figcaption>
      )}
    </figure>
  );
}
