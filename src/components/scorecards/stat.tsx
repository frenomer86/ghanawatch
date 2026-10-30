import { cn } from "@/lib/utils";

/** A headline number on a scorecard. */
export function Stat({ label, value, sub, tone = "default" }: { label: string; value: string; sub?: string; tone?: "default" | "mining" | "alert" }) {
  return (
    <div
      className={cn(
        "rounded-lg p-3",
        tone === "mining" && "bg-laterite-100 text-laterite-700",
        tone === "alert" && "bg-sev-elevated-tint",
        tone === "default" && "bg-muted/60",
      )}
    >
      <dt className={cn("text-xs", tone === "alert" ? "text-sev-elevated" : "text-muted-foreground")}>{label}</dt>
      <dd className={cn("font-heading text-2xl font-semibold tabular-nums", tone === "alert" && "text-sev-elevated")}>{value}</dd>
      {sub && <dd className="mt-0.5 text-xs text-muted-foreground">{sub}</dd>}
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
