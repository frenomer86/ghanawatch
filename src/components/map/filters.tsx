"use client";

import { useTranslations } from "next-intl";
import { SlidersHorizontal } from "lucide-react";
import { CHANGE_TYPES, SEVERITIES } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TypeIcon } from "@/components/domain/type-icon";
import { cn } from "@/lib/utils";

import { WINDOWS, type MapFilters } from "./map-params";

export type { MapFilters };

export function TimeWindow({ value, onChange, className }: { value: number; onChange: (h: number) => void; className?: string }) {
  const t = useTranslations("map");
  const label: Record<number, string> = { 72: t("last72h"), 168: t("last7d"), 720: t("last30d"), 2160: t("last90d") };
  return (
    <div role="radiogroup" aria-label={t("timeWindow")} className={cn("inline-flex rounded-lg border bg-card p-0.5 shadow-sm", className)}>
      {WINDOWS.map((h) => (
        <button
          key={h}
          type="button"
          role="radio"
          aria-checked={value === h}
          onClick={() => onChange(h)}
          className={cn(
            "h-9 rounded-md px-2.5 text-sm whitespace-nowrap",
            value === h ? "bg-forest-700 font-medium text-white dark:bg-forest-300 dark:text-forest-950" : "text-ink-soft hover:bg-accent",
          )}
        >
          {label[h] ?? `${h} h`}
        </button>
      ))}
    </div>
  );
}

export function FilterMenu({ value, onChange }: { value: MapFilters; onChange: (f: MapFilters) => void }) {
  const t = useTranslations("map");
  const tType = useTranslations("type");
  const tSev = useTranslations("severity");
  const activeCount = (value.type ? 1 : 0) + (value.severity ? 1 : 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 gap-2 bg-card shadow-sm md:h-10">
          <SlidersHorizontal className="size-4" aria-hidden />
          {t("layers")}
          {activeCount > 0 && (
            <span className="rounded-full bg-forest-700 px-1.5 text-xs font-medium text-white" aria-label={`${activeCount} active filters`}>
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{tType("label")}</legend>
          <div className="grid grid-cols-1 gap-1">
            <FilterChip selected={value.type === null} onClick={() => onChange({ ...value, type: null })}>
              All types
            </FilterChip>
            {CHANGE_TYPES.map((ty) => (
              <FilterChip key={ty} selected={value.type === ty} onClick={() => onChange({ ...value, type: value.type === ty ? null : ty })}>
                <TypeIcon type={ty} className="size-4 shrink-0" />
                {tType(ty)}
              </FilterChip>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{tSev("label")}</legend>
          <div className="flex flex-wrap gap-1">
            <FilterChip selected={value.severity === null} onClick={() => onChange({ ...value, severity: null })}>
              All
            </FilterChip>
            {SEVERITIES.map((s) => (
              <FilterChip key={s} selected={value.severity === s} onClick={() => onChange({ ...value, severity: value.severity === s ? null : s })}>
                {tSev(s)}
              </FilterChip>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <Label htmlFor="toggle-districts" className="text-sm">
            {t("boundaries")}
          </Label>
          <Switch id="toggle-districts" checked={value.districts} onCheckedChange={(v) => onChange({ ...value, districts: Boolean(v) })} />
        </div>
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor="toggle-flood" className="text-sm">
            <span>
              {t("floodProne")}
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{t("floodProneHint")}</span>
            </span>
          </Label>
          <Switch id="toggle-flood" checked={value.floodProne} onCheckedChange={(v) => onChange({ ...value, floodProne: Boolean(v) })} />
        </div>
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor="toggle-possible" className="text-sm">
            <span>
              {t("possible")}
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{t("possibleHint")}</span>
            </span>
          </Label>
          <Switch id="toggle-possible" checked={value.possible} onCheckedChange={(v) => onChange({ ...value, possible: Boolean(v) })} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm",
        selected ? "border-forest-500 bg-forest-50 text-forest-900 dark:bg-secondary dark:text-foreground" : "hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
