import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessions, users, auditLog } from "@/lib/db/schema";
import { uuidv7 } from "./ids";
import { env, isProduction } from "./env";
import { HttpError } from "./http";
import { openSecret, verifyTotp } from "./totp";

/**
 * Session-cookie authentication for administrators and moderators.
 * Opaque 256-bit tokens, stored hashed; HttpOnly, Secure (in production),
 * SameSite=Lax; 14-day sliding expiry. Passwords are argon2id.
 */
export const SESSION_COOKIE = "gw_session";
const SESSION_TTL_MS = 14 * 86_400_000;

export type Role = "citizen" | "moderator" | "admin";
export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  /** Two-step sign-in is on; staff need it before they can change anything. */
  twoFactor: boolean;
}

const hashToken = (token: string) => createHash("sha256").update(`${env().APP_SECRET}:${token}`).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const { hash } = await import("@node-rs/argon2");
  return hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const { verify } = await import("@node-rs/argon2");
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function login(email: string, password: string, meta: { ipHash: string; userAgent: string | null; code?: string }) {
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Always run a verification so timing does not reveal whether the email exists.
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, DUMMY_HASH).then(() => false);
  if (!user || !ok || user.disabledAt || user.role === "citizen") {
    await db.insert(auditLog).values({ id: uuidv7(), action: "login_failed", entity: "user", entityId: user?.id ?? null, ipHash: meta.ipHash });
    throw new HttpError(401, "Email or password is incorrect");
  }
  if (user.totpEnabledAt && user.totpSecret) {
    if (!meta.code) throw new HttpError(401, "Enter the 6-digit code from your authenticator app", { codeRequired: true });
    const step = verifyTotp(openSecret(user.totpSecret), meta.code, user.totpLastStep);
    if (step === null) {
      await db.insert(auditLog).values({ id: uuidv7(), action: "login_failed_code", entity: "user", entityId: user.id, ipHash: meta.ipHash });
      throw new HttpError(401, "That code is not right or has expired", { codeRequired: true });
    }
    await db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
  }
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipHash: meta.ipHash,
    userAgent: meta.userAgent?.slice(0, 200) ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await db.insert(auditLog).values({ id: uuidv7(), actorId: user.id, action: "login", entity: "user", entityId: user.id, ipHash: meta.ipHash });
  return { token, user: toSessionUser(user) };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function sessionFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length < 32) return null;
  const db = await getDb();
  const [row] = await db
    .select({ u: users, s: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.u.disabledAt) return null;
  // Sliding expiry, refreshed at most once a day.
  if (Date.now() - row.s.lastSeenAt.getTime() > 86_400_000) {
    await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(sessions.id, row.s.id));
  }
  return toSessionUser(row.u);
}

/** For route handlers. Staff must have two-step sign-in on before they can change anything. */
export async function requireRole(req: NextRequest, ...roles: Role[]): Promise<SessionUser> {
  const user = await requireSignedIn(req);
  if (!roles.includes(user.role)) throw new HttpError(403, "Not allowed");
  if (user.mustChangePassword) throw new HttpError(403, "Replace the initial password first");
  if ((user.role === "admin" || user.role === "moderator") && !user.twoFactor) throw new HttpError(403, "Turn on two-step sign-in first");
  return user;
}

/** Any signed-in user, two-step sign-in or not (used by the two-step setup itself). */
export async function requireSignedIn(req: NextRequest): Promise<SessionUser> {
  const user = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

/** For server components. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return sessionFromToken(store.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function toSessionUser(u: typeof users.$inferSelect): SessionUser {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role as Role, mustChangePassword: u.mustChangePassword, twoFactor: !!u.totpEnabledAt };
}

// A valid argon2id hash of a random string, used to equalise timing for unknown emails.
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$Q2hhbmdlTWVDaGFuZ2VNZUNoYW5nZU1lQ2hhbmdlTWU";
