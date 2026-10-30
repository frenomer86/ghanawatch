"use client";

import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Email sign-up for the weekly digest: the whole country, or one district. */
export function SubscribeForm({ districts }: { districts: Array<{ slug: string; name: string }> }) {
  const [email, setEmail] = useState("");
  const [district, setDistrict] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; message?: string }>({ kind: "idle" });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ kind: "busy" });
    try {
      const res = await fetch("/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, ...(district ? { district } : {}) }),
      });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) setState({ kind: "error", message: body.message ?? "Could not subscribe." });
      else setState({ kind: "done", message: body.message });
    } catch {
      setState({ kind: "error", message: "No connection. Try again when you are online." });
    }
  };
  if (state.kind === "done")
    return (
      <p className="flex items-center gap-2 rounded-md bg-forest-50 p-3 text-sm text-forest-900" role="status">
        <Check className="size-4" aria-hidden /> {state.message}
      </p>
    );
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label htmlFor="sub-email" className="text-xs text-muted-foreground">
          Email
        </label>
        <input id="sub-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
      </div>
      <div className="sm:w-64">
        <label htmlFor="sub-district" className="text-xs text-muted-foreground">
          District (or all of Ghana)
        </label>
        <select id="sub-district" value={district} onChange={(e) => setDistrict(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
          <option value="">All of Ghana</option>
          {districts.map((d) => (
            <option key={d.slug} value={d.slug}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={state.kind === "busy"}>
        <Bell className="size-4" aria-hidden /> Subscribe
      </Button>
      {state.kind === "error" && (
        <p className="text-sm text-sev-urgent" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
