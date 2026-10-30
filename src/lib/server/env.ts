import { z } from "zod";

if (typeof window !== "undefined") {
  throw new Error("src/lib/server/env.ts must never be imported into client code");
}

/**
 * All server configuration is parsed once, here. A missing required value
 * fails fast at startup instead of surfacing as an undefined deep in a request.
 * Nothing in this file may be imported by client components.
 */
/** `.env` files cannot express "unset", so an empty string means absent. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(blankToUndefined, inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Postgres connection string. When absent, the embedded PGlite database under DATA_DIR is used. */
  DATABASE_URL: optional(z.string().url()),
  /** Connections per server instance. Keep small on serverless hosts. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(3),
  /** Vercel Blob token for report photos in production; local disk is used when absent. */
  BLOB_READ_WRITE_TOKEN: optional(z.string().min(1)),
  /** Directory for the embedded database and local object storage. */
  DATA_DIR: z.string().min(1).default(".data"),
  /** 32+ byte secret used to hash session tokens and IP addresses and to seal authenticator keys. */
  APP_SECRET: z
    .string()
    .min(32)
    .refine((s) => !/change-?me|example|placeholder|secret|password/i.test(s) && new Set(s).size >= 12, "APP_SECRET must be a real random value: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""),
  /** Seeded administrator. The password must be changed at first login. */
  ADMIN_EMAIL: z.string().email().default("admin@ghanawatch.local"),
  ADMIN_INITIAL_PASSWORD: optional(z.string().min(12)),
  /** Public origin used for absolute URLs in exports and citations. */
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  // No provider keys: every data source GhanaWatch uses is public and needs no key or account.
  /** Basemap style URL exposed to the client. */
  NEXT_PUBLIC_MAP_STYLE_URL: z.string().url().default("https://tiles.openfreemap.org/styles/positron"),
  RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_REPORTS_PER_HOUR: z.coerce.number().int().positive().default(5),
  /** Machinery tags in Ground view: one tag can cover several machines, so a busy site needs a few. */
  RATE_LIMIT_SIGHTINGS_PER_HOUR: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(5),
  /** Land checks, change analyses and rendered images: each one fetches dozens of upstream tiles. */
  RATE_LIMIT_HEAVY_PER_MIN: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration. ${issues}. Copy .env.example to .env.local and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
