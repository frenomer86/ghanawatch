import type { rankMovement } from "@/lib/domain/index";
import { cn } from "@/lib/utils";

/** A district's movement in the league table since last month, as an arrow with the words beside it. */
export function RankArrow({ movement, className }: { movement: ReturnType<typeof rankMovement>; className?: string }) {
  const glyph = movement.arrow === "up" ? "▲" : movement.arrow === "down" ? "▼" : movement.arrow === "new" ? "●" : movement.arrow === "same" ? "▬" : "";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", movement.arrow === "up" && "text-sev-elevated", movement.arrow === "down" && "text-forest-700", (movement.arrow === "same" || movement.arrow === "new" || movement.arrow === "none") && "text-muted-foreground", className)}>
      {glyph && <span aria-hidden>{glyph}</span>}
      <span>{movement.text}</span>
    </span>
  );
}
