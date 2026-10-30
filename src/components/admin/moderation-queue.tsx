"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { SatelliteCheck } from "@/lib/domain/cases";
import { SATELLITE_VERDICTS, type SatelliteVerdict } from "@/lib/domain/types";
import { groundViewHref } from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  lat: number;
  lon: number;
  description: string;
  createdAt: string;
  updatedAt: string;
  photoKey: string | null;
  category: string;
  satelliteCheck: SatelliteCheck | null;
}

const CATEGORY: Record<string, string> = { galamsey: "Galamsey", dumping: "Rubbish dumping", fire: "Fire or burning", flooding: "Flooding", other: "Something else" };
const VERDICT: Record<SatelliteVerdict, string> = {
  confirmed_by_satellite: "Confirmed by satellite",
  not_visible_yet: "Not visible from space yet",
  under_review: "Under review",
};

/**
 * Approve / reject / ask for more information, with optimistic-concurrency on
 * updatedAt. Each report shows its photo and the automatic satellite check;
 * the moderator sets the public satellite verdict when approving.
 */
export function ModerationQueue({ items }: { items: Item[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [verdicts, setVerdicts] = useState<Record<string, SatelliteVerdict>>({});

  const decide = async (item: Item, status: "approved" | "rejected" | "needs_info") => {
    setBusy(item.id);
    try {
      const verdict = verdicts[item.id] ?? item.satelliteCheck?.suggestion ?? "under_review";
      const res = await fetch(`/api/v1/admin/reports/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note: notes[item.id] || undefined, satelliteVerdict: verdict, expectedUpdatedAt: item.updatedAt }),
      });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) {
        toast.error(body.message ?? "Decision failed");
        return;
      }
      toast.success(`Report ${status.replace("_", " ")}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No reports waiting for review.</p>;

  return (
    <ul className="mt-3 space-y-4">
      {items.map((item) => {
        const check = item.satelliteCheck;
        const verdict = verdicts[item.id] ?? check?.suggestion ?? "under_review";
        return (
          <li key={item.id} className="rounded-lg border p-3 text-sm">
            <div className="flex gap-3">
              {item.photoKey && (
                <a href={`/api/v1/cases/${item.id}/photo`} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- moderator-only photo route */}
                  <img src={`/api/v1/cases/${item.id}/photo`} alt="Reported photo" className="size-24 rounded-md border object-cover" />
                </a>
              )}
              <div className="min-w-0">
                <p className="font-medium">{CATEGORY[item.category] ?? item.category}</p>
                <p className="text-xs text-muted-foreground">
                  {item.createdAt.slice(0, 16).replace("T", " ")} · {item.lat.toFixed(5)}, {item.lon.toFixed(5)}
                </p>
                <p className="mt-1">{item.description}</p>
              </div>
            </div>

            <div className="mt-3 rounded-md bg-muted/60 p-2.5 text-xs">
              {check ? (
                <>
                  <p className="font-medium text-foreground">
                    Satellite check: {check.detections.length > 0 ? `${check.detections.length} matching detection(s) within ${check.radiusM} m` : `nothing matching within ${check.radiusM} m`}
                    {check.closeUp?.capturedOn ? ` · newest close-up ${check.closeUp.capturedOn}` : ""}
                  </p>
                  {check.detections.slice(0, 3).map((d) => (
                    <p key={d.id}>
                      <a href={`/event/${d.id}`} target="_blank" rel="noopener noreferrer" className="text-link underline">
                        {d.title}
                      </a>{" "}
                      · {d.imageDate} · {d.distanceM} m
                    </p>
                  ))}
                </>
              ) : (
                <p>Satellite check still running; reload in a moment.</p>
              )}
              <a href={groundViewHref(item.lat, item.lon, check?.detections[0]?.id)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-link underline">
                Look at the spot in Ground view
              </a>
            </div>

            <fieldset className="mt-3">
              <legend className="text-xs font-medium text-muted-foreground">Satellite verdict shown on the public page</legend>
              <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup">
                {SATELLITE_VERDICTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={verdict === v}
                    onClick={() => setVerdicts({ ...verdicts, [item.id]: v })}
                    className={cn("rounded-full border px-2.5 py-1 text-xs hover:bg-accent/60", verdict === v && "border-primary bg-accent font-medium")}
                  >
                    {VERDICT[v]}
                    {check?.suggestion === v ? " (suggested)" : ""}
                  </button>
                ))}
              </div>
            </fieldset>

            <Textarea
              className="mt-2"
              rows={2}
              placeholder="Note to the reporter (optional, max 1000 characters)"
              maxLength={1000}
              value={notes[item.id] ?? ""}
              onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
              aria-label="Moderation note"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy === item.id} onClick={() => decide(item, "approved")}>
                Approve and publish
              </Button>
              <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => decide(item, "needs_info")}>
                Ask for more
              </Button>
              <Button size="sm" variant="destructive" disabled={busy === item.id} onClick={() => decide(item, "rejected")}>
                Reject
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
