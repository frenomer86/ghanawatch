"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocateFixed, Zap, ZapOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PinPicker = dynamic(() => import("@/components/map/pin-picker").then((m) => m.PinPicker), {
  ssr: false,
  loading: () => <div className="h-[17.5rem] animate-pulse rounded-md border bg-muted" />,
});

const WHEN = [
  { label: "Just now", minutes: 0 },
  { label: "30 minutes ago", minutes: 30 },
  { label: "1 hour ago", minutes: 60 },
  { label: "2 hours ago", minutes: 120 },
  { label: "4 hours ago", minutes: 240 },
];

/**
 * "Lights off" / "lights back" in two taps: what happened, where (your location or a pin) and roughly when.
 * Anonymous; the place is rounded to about 300 m on the server.
 */
export function PowerReport({ styleUrl }: { styleUrl: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<"off" | "on" | null>(null);
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [minutes, setMinutes] = useState(0);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  const locate = () => {
    if (!navigator.geolocation) return setMessage("Your browser cannot share its location; drop a pin on the map instead.");
    navigator.geolocation.getCurrentPosition(
      (p) => setPoint({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => setMessage("Location was not shared; drop a pin on the map instead."),
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };

  const send = async () => {
    if (!kind || !point) return;
    setStatus("sending");
    setMessage("");
    try {
      const res = await fetch("/api/v1/power", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, lat: point.lat, lon: point.lon, minutesAgo: minutes }),
      });
      const data = (await res.json().catch(() => ({}))) as { district?: string | null; duplicate?: boolean; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? "The report could not be sent");
      setStatus("sent");
      setMessage(data.duplicate ? "You already reported this in the last 30 minutes; it is counted once." : `Thank you. Your report for ${data.district ?? "your area"} is on the map.`);
      router.refresh();
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "The report could not be sent");
    }
  };

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">What happened?</legend>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { k: "off", label: "Lights off", Icon: ZapOff, cls: "data-[on=true]:border-sev-urgent data-[on=true]:bg-sev-urgent-tint" },
              { k: "on", label: "Lights back", Icon: Zap, cls: "data-[on=true]:border-sev-normal data-[on=true]:bg-sev-normal-tint" },
            ] as const
          ).map(({ k, label, Icon, cls }) => (
            <button
              key={k}
              type="button"
              data-on={kind === k}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn("flex h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 bg-card text-base font-semibold", cls)}
            >
              <Icon className="size-6" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Where?</p>
          <Button type="button" variant="outline" size="sm" onClick={locate}>
            <LocateFixed className="size-4" aria-hidden />
            Use my location
          </Button>
        </div>
        <PinPicker
          value={point}
          onChange={setPoint}
          styleUrl={styleUrl}
          labels={{ map: "Map", satellite: "Satellite", hint: "Click the map to drop the pin, or use your location.", ariaLabel: "Where the power cut is" }}
        />
        <p className="mt-1 text-xs text-muted-foreground">The place is rounded to about 300 m. No name or account is asked for.</p>
      </div>

      <label className="block text-sm font-medium">
        When?
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm">
          {WHEN.map((w) => (
            <option key={w.minutes} value={w.minutes}>
              {w.label}
            </option>
          ))}
        </select>
      </label>

      <Button type="button" className="w-full" disabled={!kind || !point || status === "sending"} onClick={send}>
        {status === "sending" ? "Sending…" : "Send report"}
      </Button>
      {message && <p className={cn("text-sm", status === "error" ? "text-sev-urgent" : "text-foreground")} role="status">{message}</p>}
    </div>
  );
}
