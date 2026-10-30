import { useFormatter, useTranslations } from "next-intl";
import { CheckCircle2, CircleDashed, Clock, Eye, Landmark, Satellite, ShieldCheck, XCircle } from "lucide-react";
import type { CaseEvent } from "@/lib/domain/cases";
import { CASE_STATUSES, type CaseStatus, type SatelliteVerdict } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

const VERDICT_STYLE: Record<SatelliteVerdict, string> = {
  confirmed_by_satellite: "border-sev-urgent/30 bg-sev-urgent-tint text-sev-urgent",
  not_visible_yet: "border-border bg-muted text-muted-foreground",
  under_review: "border-sev-watch/30 bg-sev-watch-tint text-foreground",
};

/** The moderator's reading of the satellite evidence, as a badge. */
export function VerdictBadge({ verdict, className }: { verdict: SatelliteVerdict; className?: string }) {
  const t = useTranslations("cases");
  const Icon = verdict === "confirmed_by_satellite" ? Satellite : verdict === "under_review" ? Clock : CircleDashed;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", VERDICT_STYLE[verdict], className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`verdict.${verdict}`)}
    </span>
  );
}

const STEP_ICON: Record<CaseStatus, typeof CheckCircle2> = {
  reported: Clock,
  confirmed: ShieldCheck,
  passed_to_authority: Landmark,
  action_seen: Eye,
  closed: XCircle,
};

/** Where the case trail has reached, as a short label. */
export function CaseStatusChip({ status }: { status: CaseStatus }) {
  const t = useTranslations("cases");
  const Icon = STEP_ICON[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs font-medium">
      <Icon className="size-3.5 text-primary" aria-hidden />
      {t(`statusShort.${status}`)}
    </span>
  );
}

/**
 * The public trail: every step that has happened, with its date and note,
 * then the steps still ahead, greyed out.
 */
export function CaseTimeline({ events, current }: { events: CaseEvent[]; current: CaseStatus }) {
  const t = useTranslations("cases");
  const f = useFormatter();
  const done = new Set(events.map((e) => e.status));
  const ahead = current === "closed" ? [] : CASE_STATUSES.filter((s) => s !== "closed" && !done.has(s));
  return (
    <ol className="relative space-y-4 border-l pl-6">
      {events.map((e, i) => {
        const Icon = STEP_ICON[e.status];
        return (
          <li key={`${e.status}-${i}`} className="relative">
            <span className="absolute -left-[33px] grid size-6 place-items-center rounded-full border bg-primary text-primary-foreground">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <p className="text-sm font-medium">{t(`status.${e.status}`, { authority: e.authority ? t(`authority.${e.authority}`) : t("authority.other") })}</p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={e.at}>{f.dateTime(new Date(e.at), { day: "numeric", month: "short", year: "numeric" })}</time>
            </p>
            {e.note && <p className="mt-1 text-sm text-foreground/90">{e.note}</p>}
          </li>
        );
      })}
      {ahead.map((s) => {
        const Icon = STEP_ICON[s];
        return (
          <li key={s} className="relative opacity-50">
            <span className="absolute -left-[33px] grid size-6 place-items-center rounded-full border bg-card text-muted-foreground">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <p className="text-sm">{t(`status.${s}`, { authority: t("authority.other") })}</p>
          </li>
        );
      })}
    </ol>
  );
}
