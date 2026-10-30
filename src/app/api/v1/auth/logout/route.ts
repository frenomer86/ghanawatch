import type { NextRequest } from "next/server";
import { logout, SESSION_COOKIE } from "@/lib/server/auth";
import { assertSameOrigin, handle, json } from "@/lib/server/http";

export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  await logout(req.cookies.get(SESSION_COOKIE)?.value);
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
});
