/**
 * A small server-rendered bar chart (no client JavaScript) with the values
 * repeated in a visually hidden table for screen readers.
 */
export function BarChart({
  data,
  label,
  unit,
  className = "fill-laterite-600",
  highlight,
  height = 150,
}: {
  data: Array<{ x: number | string; y: number }>;
  label: string;
  unit: string;
  className?: string;
  /** x value to draw in a stronger colour (for example the latest year). */
  highlight?: number | string;
  height?: number;
}) {
  if (!data.length) return null;
  const W = 640;
  const H = height;
  const padL = 44;
  const padB = 22;
  const padT = 10;
  const max = Math.max(...data.map((d) => d.y), 1);
  const nice = niceMax(max);
  const bw = (W - padL) / data.length;
  const every = Math.ceil(data.length / 9);
  const fmt = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v >= 10 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString());
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => {
          const y = padT + (H - padT - padB) * (1 - f);
          return (
            <g key={f}>
              <line x1={padL} x2={W} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
              <text x={padL - 6} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
                {fmt(nice * f)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = ((H - padT - padB) * d.y) / nice;
          const x = padL + i * bw + bw * 0.15;
          return (
            <g key={String(d.x)}>
              <rect x={x} y={H - padB - h} width={bw * 0.7} height={Math.max(0, h)} rx={1.5} className={d.x === highlight ? "fill-forest-900" : className}>
                <title>{`${d.x}: ${fmt(d.y)} ${unit}`}</title>
              </rect>
              {i % every === 0 && (
                <text x={x + bw * 0.35} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {d.x}
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
            <tr key={String(d.x)}>
              <th scope="row">{d.x}</th>
              <td>
                {fmt(d.y)} {unit}
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
