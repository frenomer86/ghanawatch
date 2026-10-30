"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AUTHORITIES, type Authority, type CaseStatus } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Item {
  id: string;
  category: string;
  caseStatus: CaseStatus;
  authority: Authority | null;
  district: string | null;
  createdAt: string;
  lat: number;
  lon: number;
}

const AUTHORITY: Record<Authority, string> = {
  minerals_commission: "Minerals Commission",
  epa: "Environmental Protection Agency",
  forestry_commission: "Forestry Commission",
  water_resources_commission: "Water Resources Commission",
  police: "Ghana Police Service",
  district_assembly: "District Assembly",
  other: "Other authority",
};
const STATUS: Record<CaseStatus, string> = {
  reported: "Reported",
  confirmed: "Confirmed",
  passed_to_authority: "Passed to an authority",
  action_seen: "Action seen",
  closed: "Closed",
};

/** Move approved cases along their public trail. Notes are public, so they must not name people. */
export function CaseActions({ items }: { items: Item[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [authorities, setAuthorities] = useState<Record<string, Authority>>({});

  const move = async (item: Item, caseStatus: "passed_to_authority" | "action_seen" | "closed") => {
    if (caseStatus === "passed_to_authority" && !authorities[item.id]) {
      toast.error("Choose the authority first.");
      return;
    }
    setBusy(item.id);
    try {
      const res = await fetch(`/api/v1/admin/reports/${item.id}/case`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseStatus,
          ...(caseStatus === "passed_to_authority" ? { authority: authorities[item.id] } : {}),
          ...(notes[item.id] ? { note: notes[item.id] } : {}),
        }),
      });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) {
        toast.error(body.message ?? "Update failed");
        return;
      }
      toast.success(`Case: ${STATUS[caseStatus].toLowerCase()}`);
      setNotes({ ...notes, [item.id]: "" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No open cases.</p>;

  return (
    <ul className="mt-3 grid gap-3 md:grid-cols-2">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">
            <a href={`/reports/${item.id}`} target="_blank" rel="noopener noreferrer" className="text-link underline">
              {item.category} {item.district ? `in ${item.district}` : ""}
            </a>
          </p>
          <p className="text-xs text-muted-foreground">
            {item.createdAt.slice(0, 10)} · now: {STATUS[item.caseStatus]}
            {item.authority ? ` (${AUTHORITY[item.authority]})` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select value={authorities[item.id]} onValueChange={(v) => setAuthorities({ ...authorities, [item.id]: v as Authority })}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label="Authority">
                <SelectValue placeholder="Authority" />
              </SelectTrigger>
              <SelectContent>
                {AUTHORITIES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {AUTHORITY[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => move(item, "passed_to_authority")}>
              Passed to authority
            </Button>
          </div>
          <Textarea
            className="mt-2"
            rows={2}
            maxLength={500}
            placeholder="Public note (optional): for example, 'Later images show the pits refilled.' Do not name people."
            value={notes[item.id] ?? ""}
            onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
            aria-label="Public note"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy === item.id} onClick={() => move(item, "action_seen")}>
              Action seen
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => move(item, "closed")}>
              Close case
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
