"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Turns on two-step sign-in for the signed-in moderator or admin. Staff
 * cannot change anything until this is done: add the key to an authenticator
 * app, then confirm one code.
 */
export function TwoFactorSetup() {
  const id = useId();
  const router = useRouter();
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const call = async (path: string, body?: unknown) => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = (await res.json()) as { message?: string; secret?: string; uri?: string };
      if (!res.ok) {
        setError(data.message ?? "Something went wrong.");
        return null;
      }
      return data;
    } catch {
      setError("Could not reach the server. Check your connection.");
      return null;
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-sev-elevated-fill/40 bg-sev-elevated-tint p-5" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="flex items-center gap-2 text-lg font-semibold">
        <ShieldCheck className="size-5" aria-hidden /> Turn on two-step sign-in
      </h2>
      <p className="mt-1 text-sm">
        Moderator and admin accounts need a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy or 1Password) as well as
        the password. Until it is on, this account can look but not change anything.
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-sev-urgent-tint p-3 text-sm text-sev-urgent">
          {error}
        </p>
      )}
      {!secret ? (
        <Button
          className="mt-4"
          disabled={pending}
          onClick={async () => {
            const d = await call("/api/v1/auth/2fa/setup");
            if (d?.secret && d.uri) setSecret({ secret: d.secret, uri: d.uri });
          }}
        >
          Start
        </Button>
      ) : (
        <div className="mt-4 space-y-4">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              In your authenticator app, choose <strong>Add account</strong>, then <strong>Enter a setup key</strong>.
            </li>
            <li>
              Account name: <strong>GhanaWatch</strong>. Key (time-based):
              <code className="mt-1 block select-all break-all rounded bg-background p-2 font-mono text-base tracking-wider">{secret.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <span className="text-xs text-muted-foreground">
                On a phone you can instead open{" "}
                <a href={secret.uri} className="text-link underline">
                  this setup link
                </a>
                .
              </span>
            </li>
            <li>Type the 6-digit code the app now shows.</li>
          </ol>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const d = await call("/api/v1/auth/2fa/enable", { code });
              if (d) router.refresh();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-code`}>Code</Label>
              <Input
                id={`${id}-code`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="w-32"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
            <Button type="submit" disabled={pending || code.length !== 6}>
              Turn on
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
