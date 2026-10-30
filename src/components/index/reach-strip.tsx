import type { ReachScore } from "@/lib/server/rivers/score";
import { cn } from "@/lib/utils";

/** A river as a strip of reaches, coloured by this month's class, with intakes marked. */
export function ReachStrip({ reaches, tall = false }: { reaches: ReachScore[]; tall?: boolean }) {
  if (!reaches.length) return null;
  return (
    <div className="mt-3">
      <ol className={cn("flex w-full overflow-hidden rounded-md", tall ? "h-6" : "h-3")} aria-label="Reaches from upstream to downstream">
        {reaches.map((r) => (
          <li
            key={r.n}
            className={cn("relative flex-1 border-r border-background last:border-r-0", r.class === "heavy" ? "bg-laterite-700" : r.class === "discoloured" ? "bg-laterite-600" : "bg-river-100")}
            title={`Reach ${r.n}, ${r.startKm}–${r.endKm} km: ${r.class === "heavy" ? "heavily discoloured" : r.class}${r.intakes.length ? `; intake: ${r.intakes.map((i) => i.name).join(", ")}` : ""}`}
          >
            {r.intakes.length > 0 && <span aria-hidden className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-river-700" />}
            <span className="sr-only">
              Reach {r.n}: {r.class}
              {r.intakes.length ? `, intake ${r.intakes.map((i) => i.name).join(", ")}` : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-river-100" aria-hidden /> clear
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-laterite-600" aria-hidden /> discoloured
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-sm bg-laterite-700" aria-hidden /> heavily discoloured
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-full border-2 border-background bg-river-700" aria-hidden /> drinking-water intake
        </span>
      </p>
    </div>
  );
}
