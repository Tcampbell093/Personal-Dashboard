import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Neon serverless connection (HTTP driver — correct for Netlify Functions /
 * Next route handlers, where long-lived pooled connections are a liability).
 *
 * Lazily initialized: importing this module never throws, so `next build` can
 * bundle route handlers without DATABASE_URL present. The error only fires if
 * a query is actually attempted without a connection string configured.
 */
type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;

function getDb(): DB {
  if (_db) return _db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and add your Neon connection string.",
    );
  }
  _db = drizzle(neon(connectionString), { schema });
  return _db;
}

// Proxy so callers can `import { db }` and use it like a normal Drizzle client,
// while initialization stays deferred until the first property access.
export const db = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
