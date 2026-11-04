import { useTranslations } from "next-intl";
import { MapPin } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { ChangeEventSummary } from "@/lib/domain/types";
import { formatHectares } from "@/lib/domain/format";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "./severity-badge";
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
        "group block border-l-[3px] py-2 pl-3 pr-2 transition-colors hover:bg-muted focus-visible:outline-3",
        event.type === "surface_disturbance" && "border-laterite-600",
        event.type === "vegetation_loss" && "border-forest-500",
        (event.type === "water_change" || event.type === "flood_risk") && "border-river-600",
        event.type === "fire" && "border-sev-elevated-fill",
        active && "bg-forest-50",
        compact ? "py-1.5" : "py-2",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm text-muted-foreground">{t(event.type)}</span>
            <SeverityBadge severity={event.severity} size="sm" />
          </div>
          <h3 className={cn("mt-0.5 font-sans font-semibold leading-snug text-foreground group-hover:underline", compact ? "text-sm" : "text-base")}>
            {event.title}
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {place}
            {event.areaHa != null ? `, ${formatHectares(event.areaHa)}` : ""}
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
