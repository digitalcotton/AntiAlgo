#!/usr/bin/env node
/**
 * migrate.mjs: apply db/*.sql in order, once each.
 *
 * The same shape as the index's migrator: run the files nobody has run yet, in
 * name order, each inside a transaction, and write down which ones ran in
 * schema_migrations. Takes the unpooled connection, because DDL and advisory
 * locks need session state a transaction-mode pooler does not reliably carry.
 *
 * Run with:  npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import '../load-local-env.mjs';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED or DATABASE_URL in the environment. See .env.example.');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

// One migrator at a time. The lock is session scoped and released on disconnect.
await client.query('SELECT pg_advisory_lock(20260913)');

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const { rows } = await client.query('SELECT filename FROM schema_migrations');
const applied = new Set(rows.map((r) => r.filename));

const files = (await readdir(here)).filter((f) => f.endsWith('.sql')).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(join(here, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
    ran += 1;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`failed ${file}: ${error.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? 'nothing to apply' : `${ran} migration${ran === 1 ? '' : 's'} applied`);
await client.end();
