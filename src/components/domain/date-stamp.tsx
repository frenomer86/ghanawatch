import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * The two-date stamp that appears on every detection: when the satellite saw
 * it and when the system detected it. Exact dates are a hard requirement of
 * the SRS (FR-03, §10.2) and the main trust signal of the platform.
 */
export function DateStamp({
  imageDate,
  imageDateEnd,
  detectedAt,
  className,
  compact = false,
}: {
  imageDate: string;
  imageDateEnd?: string | null;
  detectedAt: string;
  className?: string;
  compact?: boolean;
}) {
  const t = useTranslations("event");
  const f = useFormatter();
  const img = new Date(`${imageDate}T00:00:00Z`);
  const imgEnd = imageDateEnd ? new Date(`${imageDateEnd}T00:00:00Z`) : null;
  const det = new Date(detectedAt);
  const dayFmt = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" } as const;
  return (
    <p className={cn("datestamp", className)}>
      <span>
        {t("seenBySatellite")}{" "}
        <strong>
          <time dateTime={imageDate}>{f.dateTime(img, dayFmt)}</time>
          {imgEnd ? (
            <>
              {" – "}
              <time dateTime={imageDateEnd!}>{f.dateTime(imgEnd, dayFmt)}</time>
            </>
          ) : null}
        </strong>
      </span>
      {!compact && (
        <span>
          {t("detected")}{" "}
          <strong>
            <time dateTime={detectedAt}>{f.dateTime(det, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}</time>
          </strong>
        </span>
      )}
    </p>
  );
}
