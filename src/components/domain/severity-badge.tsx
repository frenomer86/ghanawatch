import { useTranslations } from "next-intl";
import type { Severity } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

const TONE: Record<Severity, { chip: string; dot: string }> = {
  normal: { chip: "bg-sev-normal-tint text-sev-normal", dot: "bg-sev-normal-fill" },
  watch: { chip: "bg-sev-watch-tint text-sev-watch", dot: "bg-sev-watch-fill" },
  elevated: { chip: "bg-sev-elevated-tint text-sev-elevated", dot: "bg-sev-elevated-fill" },
  urgent: { chip: "bg-sev-urgent-tint text-sev-urgent", dot: "bg-sev-urgent-fill" },
};

/** Risk level as colour + word + dot, so it is never conveyed by colour alone. */
export function SeverityBadge({ severity, className, size = "md" }: { severity: Severity; className?: string; size?: "sm" | "md" }) {
  const t = useTranslations("severity");
  const tone = TONE[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        tone.chip,
        className,
      )}
    >
      <span aria-hidden className={cn("size-2 rounded-full", tone.dot)} />
      {t(severity)}
    </span>
  );
}

export const severityFill: Record<Severity, string> = {
  normal: "var(--sev-normal-fill)",
  watch: "var(--sev-watch-fill)",
  elevated: "var(--sev-elevated-fill)",
  urgent: "var(--sev-urgent-fill)",
};
