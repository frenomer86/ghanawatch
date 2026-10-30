/**
 * The monthly series as a server-rendered bar chart: mapped hectares as bars with the figure above each,
 * the likely range as a thin line through each bar (an arrowhead when its top is above the chart), the
 * current month in a stronger colour. No client JavaScript; the values are repeated in a visually hidden table.
 */
export function TrendChart({
  data,
  label,
  highlight,
  height = 170,
  unit = "ha",
}: {
  data: Array<{ month: string; value: number; low?: number | null; high?: number | null }>;
  label: string;
  highlight?: string;
  height?: number;
  unit?: string;
}) {
  if (!data.length) return null;
  const W = 640;
  const H = height;
  const padL = 46;
  const padB = 24;
  const padT = 10;
  // The axis follows the mapped bars so the months stay readable; the range line is clipped at the top
  // and marked with an arrowhead when the upper estimate goes beyond the chart.
  const max = Math.max(1, ...data.map((d) => d.value)) * 1.25;
  const nice = niceMax(max);
  const bw = (W - padL) / data.length;
  const every = Math.max(1, Math.ceil(data.length / 8));
  const fmt = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v >= 10 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString());
  const y = (v: number) => H - padB - ((H - padT - padB) * v) / nice;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W} y1={y(nice * f)} y2={y(nice * f)} className="stroke-border" strokeWidth={1} />
            <text x={padL - 6} y={y(nice * f) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {fmt(nice * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={d.month}>
              <rect x={x} y={y(d.value)} width={w} height={Math.max(0, H - padB - y(d.value))} rx={1.5} className={d.month === highlight ? "fill-forest-900" : "fill-laterite-600"}>
                <title>{`${d.month}: ${fmt(d.value)} ${unit}${d.low != null && d.high != null ? ` (likely ${fmt(d.low)} to ${fmt(d.high)})` : ""}`}</title>
              </rect>
              {d.low != null && d.high != null && (
                <>
                  <line x1={x + w / 2} x2={x + w / 2} y1={y(Math.min(d.low, nice))} y2={y(Math.min(d.high, nice))} className="stroke-foreground/60" strokeWidth={1.5} />
                  {d.high > nice && <path d={`M${x + w / 2 - 4},${padT + 6} L${x + w / 2},${padT} L${x + w / 2 + 4},${padT + 6}`} className="stroke-foreground/60" fill="none" strokeWidth={1.5} />}
                </>
              )}
              {data.length <= 24 && (
                <text x={x + w / 2} y={y(d.value) - 4} textAnchor="middle" className="fill-foreground text-[10px] font-medium">
                  {fmt(d.value)}
                </text>
              )}
              {(i % every === 0 || i === data.length - 1) && (
                <text x={x + w / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {d.month}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <th scope="row">{d.month}</th>
              <td>
                {fmt(d.value)} {unit}
                {d.low != null && d.high != null ? ` (${fmt(d.low)} to ${fmt(d.high)})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
