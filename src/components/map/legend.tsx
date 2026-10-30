"use client";

import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { CHANGE_TYPES, SEVERITIES } from "@/lib/domain/types";
import { TypeIcon } from "@/components/domain/type-icon";
import { severityFill } from "@/components/domain/severity-badge";
import { cn } from "@/lib/utils";

/** Colour = risk level, icon = type of change, halo = new in the last 72 hours. */
export function Legend({ className }: { className?: string }) {
  const tSev = useTranslations("severity");
  const tType = useTranslations("type");
  const tMap = useTranslations("map");
  return (
    // Folds to its title so it never sits on top of the area being looked at.
    <details open className={cn("group rounded-lg border bg-card/95 p-3 text-sm shadow-sm backdrop-blur", className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-heading font-medium [&::-webkit-details-marker]:hidden">
        {tMap("legend")}
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ul className="mt-2 space-y-1.5" aria-label={tSev("label")}>
        {SEVERITIES.map((s) => (
          <li key={s} className="flex items-center gap-2">
            <span aria-hidden className="size-3.5 rounded-full border border-white" style={{ background: severityFill[s] }} />
            <span>{tSev(s)}</span>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3.5 rounded-full border border-white" style={{ background: "#8a9490" }} />
          <span>{tMap("licensedMine")}</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="relative flex size-3.5 items-center justify-center">
            <span className="absolute inset-[-3px] rounded-full bg-forest-500/25" />
            <span className="size-2.5 rounded-full bg-forest-500" />
          </span>
          <span>{tMap("last72h")}</span>
        </li>
      </ul>
      <p className="mt-2 max-w-52 text-xs text-muted-foreground">{tMap("urgentHint")}</p>
      <ul className="mt-3 grid grid-cols-1 gap-1 border-t pt-2.5 text-muted-foreground" aria-label={tType("label")}>
        {CHANGE_TYPES.map((t) => (
          <li key={t} className="flex items-center gap-2">
            <TypeIcon type={t} className="size-4" />
            <span>{tType(t)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
