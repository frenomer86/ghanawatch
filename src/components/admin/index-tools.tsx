"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { groundViewHref } from "@/lib/explore/imagery";
import { Button } from "@/components/ui/button";

/**
 * The index's credibility tools for moderators: the monthly confirmation sample (30 random new sites to
 * confirm or reject before a release), the accuracy-check form, the corrections log and water intakes.
 * Every change goes through /api/v1/admin/* with the session check.
 */
export interface SampleItem {
  id: string;
  month: string;
  eventId: string;
  title: string;
  areaHa: number;
  lat: number;
  lon: number;
  imageDate: string | null;
  verdict: string | null;
}

async function post(url: string, method: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: res.ok, message: json.message };
}

export function SampleQueue({ items }: { items: SampleItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (item: SampleItem, verdict: "confirmed" | "rejected" | "unclear") => {
    setBusy(item.id);
    try {
      const r = await post(`/api/v1/admin/samples/${item.id}`, "PATCH", { verdict });
      if (!r.ok) toast.error(r.message ?? "Could not save");
      else {
        toast.success(`Site ${verdict}`);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };
  if (!items.length) return <p className="mt-3 text-sm text-muted-foreground">No sample waiting. One is drawn when a month is released.</p>;
  const unchecked = items.filter((i) => !i.verdict);
  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">
        {items[0].month}: {items.length - unchecked.length} of {items.length} checked. Open each in Ground view, compare the before and after pictures, and decide. Rejected sites leave the index when the month is released.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm">
            <div className="min-w-0">
              <a href={`/event/${it.eventId}`} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline-offset-2 hover:underline">
                {it.title}
              </a>
              <p className="text-xs text-muted-foreground">
                {it.areaHa.toFixed(1)} ha · seen {it.imageDate ?? "–"} ·{" "}
                <a href={groundViewHref(it.lat, it.lon, it.eventId)} target="_blank" rel="noopener noreferrer" className="underline">
                  Ground view
                </a>
                {it.verdict ? ` · ${it.verdict}` : ""}
              </p>
            </div>
            <div className="flex gap-1">
              {(["confirmed", "rejected", "unclear"] as const).map((v) => (
                <Button key={v} size="sm" variant={it.verdict === v ? "default" : "outline"} disabled={busy === it.id} onClick={() => decide(it, v)}>
                  {v === "confirmed" ? "Real" : v === "rejected" ? "Not mining" : "Unclear"}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AccuracyCheckForm() {
  const router = useRouter();
  const [f, setF] = useState({ checkedOn: new Date().toISOString().slice(0, 10), label: "", kind: "optical", region: "", checked: "30", correct: "", note: "", headline: false });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post("/api/v1/admin/accuracy-checks", "POST", {
        checkedOn: f.checkedOn,
        label: f.label,
        kind: f.kind,
        ...(f.region ? { region: f.region } : {}),
        checked: Number(f.checked),
        correct: Number(f.correct),
        ...(f.note ? { note: f.note } : {}),
        headline: f.headline,
      });
      if (!r.ok) toast.error(r.message ?? "Not saved");
      else {
        toast.success("Check recorded");
        setF({ ...f, label: "", correct: "", note: "" });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-2">
      <label className="text-xs">
        Date <input type="date" required value={f.checkedOn} onChange={(e) => setF({ ...f, checkedOn: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Kind{" "}
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={field}>
          <option value="optical">Optical galamsey sites</option>
          <option value="radar">Radar ponds</option>
          <option value="urgent">Urgent sites</option>
          <option value="cleared_near_pits">Cleared ground near pits</option>
          <option value="flood_south">Waterways, south</option>
          <option value="flood_north">Waterways, north</option>
          <option value="detection_rate">Detection rate (blind squares)</option>
        </select>
      </label>
      <label className="text-xs sm:col-span-2">
        Label <input required minLength={3} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Check across all of Ghana, November 2026" className={field} />
      </label>
      <label className="text-xs">
        Checked <input type="number" min={1} required value={f.checked} onChange={(e) => setF({ ...f, checked: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Correct (or found) <input type="number" min={0} required value={f.correct} onChange={(e) => setF({ ...f, correct: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Region (optional) <input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} className={field} />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={f.headline} onChange={(e) => setF({ ...f, headline: e.target.checked })} /> Whole-of-Ghana headline check (sets the index precision)
      </label>
      <label className="text-xs sm:col-span-2">
        Note <textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} className={field} />
      </label>
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          Record check
        </Button>
      </div>
    </form>
  );
}

export function CorrectionForm() {
  const router = useRouter();
  const [f, setF] = useState({ publishedOn: new Date().toISOString().slice(0, 10), month: "", indexVersion: "1.0", whatChanged: "", why: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post("/api/v1/admin/corrections", "POST", { publishedOn: f.publishedOn, ...(f.month ? { month: f.month } : {}), indexVersion: f.indexVersion, whatChanged: f.whatChanged, why: f.why });
      if (!r.ok) toast.error(r.message ?? "Not saved");
      else {
        toast.success("Correction published");
        setF({ ...f, whatChanged: "", why: "" });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-3">
      <label className="text-xs">
        Date <input type="date" required value={f.publishedOn} onChange={(e) => setF({ ...f, publishedOn: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Month affected (YYYY-MM, blank = all) <input value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} pattern="20\d\d-(0[1-9]|1[0-2])" className={field} />
      </label>
      <label className="text-xs">
        Index version <input required value={f.indexVersion} onChange={(e) => setF({ ...f, indexVersion: e.target.value })} className={field} />
      </label>
      <label className="text-xs sm:col-span-3">
        What changed <textarea required minLength={5} rows={2} value={f.whatChanged} onChange={(e) => setF({ ...f, whatChanged: e.target.value })} className={field} />
      </label>
      <label className="text-xs sm:col-span-3">
        Why <textarea required minLength={5} rows={2} value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} className={field} />
      </label>
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          Publish correction
        </Button>
      </div>
    </form>
  );
}

export function IntakeForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", river: "Pra", operator: "Ghana Water Ltd", lon: "", lat: "", source: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post("/api/v1/admin/intakes", "POST", { name: f.name, river: f.river, operator: f.operator, lon: Number(f.lon), lat: Number(f.lat), ...(f.source ? { source: f.source } : {}) });
      if (!r.ok) toast.error(r.message ?? "Not saved");
      else {
        toast.success("Intake saved");
        setF({ ...f, name: "", lon: "", lat: "", source: "" });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-3">
      <label className="text-xs sm:col-span-2">
        Name <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Osino water treatment plant" className={field} />
      </label>
      <label className="text-xs">
        River <input required value={f.river} onChange={(e) => setF({ ...f, river: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Longitude <input required type="number" step="any" value={f.lon} onChange={(e) => setF({ ...f, lon: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Latitude <input required type="number" step="any" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} className={field} />
      </label>
      <label className="text-xs">
        Source <input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="GWCL, 2026 list" className={field} />
      </label>
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          Save intake
        </Button>
      </div>
    </form>
  );
}
