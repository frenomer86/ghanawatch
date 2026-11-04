import { cn } from "@/lib/utils";

/** A headline figure on a scorecard: a rule above, the label, the figure in the heading face, a note below. */
export function Stat({ label, value, sub, tone = "default" }: { label: string; value: string; sub?: string; tone?: "default" | "mining" | "alert" }) {
  return (
    <div className={cn("border-t-2 pt-2.5", tone === "mining" ? "border-laterite-600" : tone === "alert" ? "border-sev-elevated-fill" : "border-foreground/70")}>
      <dt className="text-[0.9375rem] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 font-heading text-[1.75rem] font-semibold leading-tight tabular-nums", tone === "alert" && "text-sev-elevated", tone === "mining" && "text-laterite-700")}>{value}</dd>
      {sub && <dd className="mt-1 text-sm leading-snug text-muted-foreground">{sub}</dd>}
    </div>
  );
}

export const fmtHa = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString("en-GB") : v >= 10 ? v.toFixed(0) : v.toFixed(1));

/** "3 this week (usually 5)" for fires, honest when the archive is missing. */
export function firesText(now: number, usual: number | null): string {
  if (usual === null) return `${now} in the last 7 days`;
  const u = usual < 10 ? usual.toFixed(1) : Math.round(usual).toString();
  return `${now} in the last 7 days (usually ${u})`;
}
