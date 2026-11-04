import { cn } from "@/lib/utils";

/**
 * GhanaWatch mark: a canopy-green disc with a thin outer ring (the "watch")
 * and a single bright point where change is detected. Drawn inline so it
 * inherits the current colour and needs no asset request.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <circle cx="16" cy="16" r="9.5" fill="currentColor" />
      <circle cx="21" cy="11.5" r="2.6" fill="var(--sev-watch-fill)" stroke="var(--background)" strokeWidth="1.2" />
    </svg>
  );
}

export function Wordmark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-forest-700 dark:text-forest-300", className)}>
      <Mark />
      {!compact && (
        <span className="whitespace-nowrap font-heading text-lg font-semibold tracking-tight">
          Ghana<span className="font-medium">Watch</span>
        </span>
      )}
    </span>
  );
}
