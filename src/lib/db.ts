/**
 * db.ts: the one Postgres connection, and the one place a connection string is read.
 *
 * node-postgres over plain TCP, the same choice the index made after Neon's
 * WebSocket driver failed from a deployed Vercel function. DATABASE_URL from
 * the Neon integration is the pooled endpoint, so pooling happens at Neon,
 * which is the right place for it in a serverless model. Migrations take
 * DATABASE_URL_UNPOOLED, because DDL needs session state a transaction-mode
 * pooler does not reliably carry.
 *
 * The connection string is never read anywhere but here, never logged, and
 * never sent to the browser.
 */
import pg from 'pg';

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Set it in Vercel, Project, Settings, Environment Variables, or in .env.local.`);
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
