import type { NextRequest } from "next/server";
import { loginBody } from "@/lib/domain/validation";
import { login, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/auth";
import { createHash } from "node:crypto";
import { assertSameOrigin, clientIpHash, enforceRateLimit, handle, HttpError, json, parseJson, rateLimit } from "@/lib/server/http";

/** POST /api/v1/auth/login { email, password } → sets the session cookie. 5 attempts per minute per address. */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  enforceRateLimit(req, "login");
  const body = await parseJson(req, loginBody, 4 * 1024);
  // Also throttle per account, so guessing one admin's password from many addresses stays slow.
  const perAccount = rateLimit(`login-account:${createHash("sha256").update(body.email.toLowerCase()).digest("hex")}`, 10, 15 * 60_000);
  if (!perAccount.ok) throw new HttpError(429, "Too many sign-in attempts for this account; try again later", { retryAfterSec: perAccount.retryAfterSec });
  const { token, user } = await login(body.email, body.password, { ipHash: clientIpHash(req), userAgent: req.headers.get("user-agent"), code: body.code });
  const res = json({ user });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
