"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { groundViewHref, type Sighting } from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";

const KIND: Record<string, string> = { excavator: "Excavator", truck: "Truck", washing_plant: "Washing plant", dredger: "Dredger", other: "Other machine" };

/** Confirm or reject machinery tags from the public, after looking at the same close-up in Ground view. */
export function SightingQueue({ items }: { items: Sighting[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (item: Sighting, status: "confirmed" | "rejected") => {
    setBusy(item.id);
    try {
      const res = await fetch(`/api/v1/admin/sightings/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, expectedUpdatedAt: item.updatedAt }),
      });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) {
        toast.error(body.message ?? "Decision failed");
        return;
      }
      toast.success(`Tag ${status}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No machinery tags waiting for review.</p>;

  return (
    <ul className="mt-3 space-y-3">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {KIND[item.kind] ?? item.kind}
            {item.count > 1 ? ` ×${item.count}` : ""}
            <span className="font-normal text-muted-foreground">
              {" "}
              {item.source === "sentinel-1" ? `flagged by radar, ${item.capturedOn ?? ""}` : `on the ${item.capturedOn ?? "undated"} close-up`}
              {item.sensor ? ` (${item.sensor})` : ""}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {item.createdAt.slice(0, 16).replace("T", " ")} · {item.lat.toFixed(5)}, {item.lon.toFixed(5)}
          </p>
          {item.note && <p className="mt-1">{item.note}</p>}
          {item.source === "sentinel-1" && (
            <a href={`/api/v1/radar/target?sighting=${item.id}`} target="_blank" rel="noopener noreferrer" className="mt-2 block w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element -- radar crop rendered by our API */}
              <img src={`/api/v1/radar/target?sighting=${item.id}`} alt="Radar picture of the river at the flagged spot" className="h-40 w-40 rounded border object-cover" />
            </a>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href={groundViewHref(item.lat, item.lon, null, { mode: "machinery", release: item.release })} target="_blank" rel="noopener noreferrer">
                Check in Ground view
              </a>
            </Button>
            <Button size="sm" disabled={busy === item.id} onClick={() => decide(item, "confirmed")}>
              Confirm
            </Button>
            <Button size="sm" variant="destructive" disabled={busy === item.id} onClick={() => decide(item, "rejected")}>
              Reject
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
