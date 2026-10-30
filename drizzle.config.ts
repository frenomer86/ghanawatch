import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated against the Postgres dialect and applied by
 * src/lib/db/migrate.ts to either PGlite (dev) or Postgres (production).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/ghanawatch",
  },
  strict: true,
  verbose: true,
});
