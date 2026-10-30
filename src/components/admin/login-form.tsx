"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const id = useId();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(needCode ? { email, password, code } : { email, password }),
      });
      const body = (await res.json()) as { message?: string; details?: { codeRequired?: boolean } };
      if (!res.ok) {
        if (body.details?.codeRequired) {
          // Password accepted; the account has two-step sign-in, so ask for the code.
          if (needCode) setError(body.message ?? "That code is not right.");
          setNeedCode(true);
          return;
        }
        setError(body.message ?? "Sign in failed.");
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      {error && (
        <p role="alert" className="rounded-md bg-sev-urgent-tint p-3 text-sm text-sev-urgent">
          {error}
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input id={`${id}-email`} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-password`}
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => setShow((s) => !s)} aria-pressed={show}>
            {show ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {needCode && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-code`}>6-digit code from your authenticator app</Label>
          <Input
            id={`${id}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </div>
      )}
      <Button type="submit" disabled={pending || (needCode && code.length !== 6)} className="w-full">
        {pending ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}
