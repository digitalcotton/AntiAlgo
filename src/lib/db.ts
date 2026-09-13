/**
 * db.ts: the one Postgres connection, and the one place a connection string is read.
 *
 * WHY THE NEON SERVERLESS DRIVER AND NOT `pg`. Better Auth's docs show a
 * node-postgres Pool, which assumes a long-lived process holding TCP
 * connections. A Vercel function is not that: it is a process that may exist
 * for one request, and a pool of TCP sockets opened per invocation exhausts
 * Postgres' connection limit long before it saves anything. Neon's driver
 * speaks the same Pool API over HTTP and WebSockets instead, so it is designed
 * for exactly the process model this runs in. The API is compatible, so Better
 * Auth accepts it wherever it accepts `pg`.
 *
 * WHICH URL. The Vercel Neon integration injects two. DATABASE_URL is pooled
 * through PgBouncer and is the right default for request handling. Migrations
 * want DATABASE_URL_UNPOOLED, because a pooler in transaction mode does not
 * reliably carry the session state that DDL and advisory locks need.
 *
 * The connection string is never read anywhere but here, never logged, and
 * never sent to the browser.
 */
import pg from 'pg';

/**
 * WHY node-postgres AND NOT NEON'S SERVERLESS DRIVER, WHICH WAS TRIED FIRST.
 *
 * The original choice here was @neondatabase/serverless, on the reasoning that
 * a Vercel function is short lived and a pool of TCP sockets per invocation
 * would exhaust Postgres' connection limit. That reasoning is sound and the
 * driver still did not work: every query from a deployed function failed with
 * "All attempts to open a WebSocket to connect to the database failed ...
 * TypeError: fetch failed". Neon's Pool tunnels the Postgres wire protocol over
 * a WebSocket, and that transport would not open from this runtime. Handing it
 * the global WebSocket that Node 24 provides did not change the result, so the
 * failure is the transport rather than a missing constructor.
 *
 * node-postgres speaks plain TCP, which Vercel's Node functions support, and
 * the connection-exhaustion worry is already answered upstream: DATABASE_URL
 * from the Neon integration is the POOLED endpoint, sitting behind PgBouncer.
 * The pooling happens at Neon rather than in this process, which is the right
 * place for it in a serverless model anyway.
 *
 * Kept: migrations still use the unpooled endpoint, because DDL needs session
 * state a transaction-mode pooler does not reliably carry.
 *
 * The connection string is never read anywhere but here, never logged, and
 * never sent to the browser.
 */
const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail loudly and name the variable. A missing connection string that
    // surfaces as a null pointer three layers down costs an afternoon.
    throw new Error(
      `${name} is not set. It is injected by the Vercel Neon integration. ` +
        `Check Vercel, Project, Settings, Environment Variables.`
    );
  }
  return value;
}

let pool: pg.Pool | null = null;

/** The pooled connection, for serving requests. */
export function db(): pg.Pool {
  if (!pool) pool = new Pool({ connectionString: required('DATABASE_URL') });
  return pool;
}

/** The direct connection, for migrations and DDL only. */
export function directUrl(): string {
  return process.env.DATABASE_URL_UNPOOLED || required('DATABASE_URL');
}

/** True when a database is configured at all, so callers can degrade rather than crash. */
export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
