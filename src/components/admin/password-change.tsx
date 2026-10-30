"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Replaces the account's password. Shown with a notice while the initial password from the server's
 * settings is still in use; staff cannot change anything else until it is replaced.
 */
export function PasswordChange({ required }: { required: boolean }) {
  const id = useId();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== again) {
      setError("The two new passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current, next }) });
      const data = (await res.json()) as { message?: string; details?: { message?: string }[] };
      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.message ?? "Something went wrong.");
        return;
      }
      setDone(true);
      setCurrent("");
      setNext("");
      setAgain("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={`mt-6 rounded-xl border p-5 ${required ? "border-sev-elevated-fill/40 bg-sev-elevated-tint" : "bg-card"}`} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="size-5" aria-hidden /> {required ? "Replace the initial password" : "Change password"}
      </h2>
      {required && (
        <p className="mt-1 text-sm">
          This account still uses the password from the server&apos;s settings file. Replace it now; until then the account can look but not change anything.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-sev-urgent-tint p-3 text-sm text-sev-urgent">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-3 rounded-md bg-forest-50 p-3 text-sm text-forest-900 dark:bg-secondary">
          Password changed. Other sessions of this account have been signed out.
        </p>
      )}
      <form onSubmit={submit} className="mt-4 grid max-w-md gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-cur`}>Current password</Label>
          <Input id={`${id}-cur`} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-new`}>New password (at least 12 characters)</Label>
          <Input id={`${id}-new`} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-again`}>New password again</Label>
          <Input id={`${id}-again`} type="password" autoComplete="new-password" minLength={12} value={again} onChange={(e) => setAgain(e.target.value)} required />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Change password"}
          </Button>
        </div>
      </form>
    </section>
  );
}
