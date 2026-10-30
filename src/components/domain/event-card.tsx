import { useTranslations } from "next-intl";
import { MapPin } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { ChangeEventSummary } from "@/lib/domain/types";
import { formatHectares } from "@/lib/domain/format";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "./severity-badge";
import { TypeIcon } from "./type-icon";
import { DateStamp } from "./date-stamp";

/**
 * One detection in a list. The whole card is a link; the type icon, risk
 * level and the two dates are always visible, nothing is hidden behind hover.
 */
export function EventCard({
  event,
  active = false,
  compact = false,
  href,
  onSelect,
}: {
  event: ChangeEventSummary;
  active?: boolean;
  compact?: boolean;
  href?: string;
  /** When given, a plain click selects in place; the href still works for new-tab and sharing. */
  onSelect?: (event: ChangeEventSummary) => void;
}) {
  const t = useTranslations("type");
  const place = [event.districtName, event.regionName].filter(Boolean).join(", ");
  return (
    <Link
      href={href ?? `/event/${event.id}`}
      onClick={
        onSelect
          ? (e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onSelect(event);
            }
          : undefined
      }
      aria-current={active ? "true" : undefined}
      className={cn(
        "group block rounded-lg border bg-card p-3 transition-colors hover:border-forest-300 focus-visible:outline-3",
        active && "border-forest-500 bg-forest-50",
        compact ? "p-2.5" : "p-3",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-ink-soft",
            event.type === "surface_disturbance" && "bg-laterite-100 text-laterite-700",
            event.type === "vegetation_loss" && "bg-forest-100 text-forest-700",
            (event.type === "water_change" || event.type === "flood_risk") && "bg-river-100 text-river-700",
            event.type === "fire" && "bg-sev-elevated-tint text-sev-elevated",
          )}
        >
          <TypeIcon type={event.type} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-muted-foreground">{t(event.type)}</span>
            <SeverityBadge severity={event.severity} size="sm" />
          </div>
          <h3 className={cn("mt-1 font-heading font-medium leading-snug text-foreground", compact ? "text-sm" : "text-base")}>
            {event.title}
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {place}
            {event.areaHa != null ? ` · ${formatHectares(event.areaHa)}` : ""}
          </p>
          {event.flags?.[0] && (
            <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-sev-elevated-tint px-1.5 py-0.5 text-xs font-medium text-sev-elevated">
              <MapPin className="size-3" aria-hidden />
              {event.flags[0]}
            </p>
          )}
          <DateStamp imageDate={event.imageDate} imageDateEnd={event.imageDateEnd} detectedAt={event.detectedAt} compact className="mt-1.5" />
        </div>
      </div>
    </Link>
  );
}
