import { Link } from "@/i18n/navigation";

/** What the scorecard numbers mean, shown under every ranking and scorecard. */
export function ScorecardNotes({ fireArchive, computedAt }: { fireArchive: boolean; computedAt: string }) {
  return (
    <div className="mt-6 space-y-2 text-sm text-muted-foreground">
      <p>
        <strong className="text-foreground">Likely mining</strong> is new mining pits and ponds seen from space over the last few months that passed
        GhanaWatch&apos;s checks, shown on the map by default. Work inside named large-scale mines is left out. Detections in the savannah north are fewer
        than the real picture, because farm clearing there looks similar.
      </p>
      <p>
        Fires are satellite fire detections (NASA){fireArchive ? "; “usually” is the average for the same seven days of the year in 2020–2025" : ""}. These are
        detections from public satellite data, not legal findings; see{" "}
        <Link href="/data/methods" className="text-link underline">
          how to read the map
        </Link>
        . Figures as of {new Date(computedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}.
      </p>
    </div>
  );
}
