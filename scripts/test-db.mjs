#!/usr/bin/env node
/**
 * test-db.mjs: a disposable, deterministic Postgres for the journey tests
 * (docs/regression-strategy.md, Layer 4).
 *
 *   node scripts/test-db.mjs reset    drop and recreate antialgo_test, run
 *                                     every db/*.sql migration into it, seed
 *                                     the fixture rows
 *   node scripts/test-db.mjs seed     re-seed only: clear the fixture rows and
 *                                     re-insert them, no migration, no drop
 *   node scripts/test-db.mjs url      print antialgo_test's connection URL to
 *                                     stdout, for a test runner to consume
 *
 * WHY THIS EXISTS. Journeys need a real signed-in session against a real
 * database (better-auth's session/account/tier reads are not worth faking),
 * but a journey test that runs against antialgo_dev would leave hand-checked
 * local data full of "Test Member" rows, and a journey test that runs against
 * production would be a test suite with DROP TABLE in its call graph pointed
 * at a Vercel Marketplace Neon instance. Neither is acceptable, so journeys
 * get their own database, named once, asserted before every statement that
 * could destroy something, and thrown away and rebuilt on demand.
 *
 * THE THREE REFUSALS THIS SCRIPT EXISTS TO ENFORCE, IN ORDER OF HOW BADLY A
 * SLIP HERE WOULD HURT.
 *
 *   1. It touches antialgo_test and nothing else. The database name is a
 *      single literal constant (TEST_DB_NAME below), never a value built from
 *      a URL a caller supplied, and every destructive statement is preceded
 *      by a live check (current_database() against a fresh connection, or the
 *      literal in the DROP/CREATE/TRUNCATE text) that refuses instead of
 *      guessing when something doesn't match. This is the same shape as
 *      db/migrate.mjs's advisory lock: cheap insurance against a mistake that
 *      is expensive exactly once.
 *   2. It refuses anything that is not localhost. DATABASE_URL today points at
 *      Homebrew Postgres on this Mac, but the day it or a copy of it points at
 *      *.neon.tech (docs/regression-strategy.md section 6, item 1: preview
 *      branching is not confirmed yet, so a preview URL is the production
 *      database with a different label), a script that runs DROP DATABASE
 *      and TRUNCATE ... CASCADE against whatever hostname it finds is the
 *      incident. The host is checked once, here, before this script does
 *      anything else, and a non-local host is exit 2 with the reason spelled
 *      out, not a retry and not a "did you mean" guess.
 *   3. It never reports success it did not measure. Postgres unreachable,
 *      the maintenance connection refused, a migration failing partway: all
 *      of these are exit 2, "could not run", never 0 and never a caught
 *      error that gets logged and swallowed. The alternative is a CI-style
 *      green check that ran nothing, which is the exact failure this repo's
 *      own gates (test/gates.config.mjs, scripts/ingest-on-build.mjs) were
 *      written to refuse: a gate that could not run has measured nothing, and
 *      looking green while measuring nothing is the dangerous failure mode.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 *   - It does not mint sessions. better-auth 1.7.1's testUtils plugin does
 *     that, against the "user" rows this script writes, so a journey test
 *     never fills in a sign-in form or hand-rolls a cookie. This script's job
 *     stops at the schema and the rows; session is listed among "the tables
 *     the app reads" in this file's own comments only because middleware
 *     reads it at request time, not because this script writes to it.
 *   - It does not re-derive Jobs Data's computed columns in SQL. The seeded
 *     jobs rows call derivedFor() from src/lib/jobs-derived.mjs, the same
 *     function scripts/ingest-jobs.mjs and scripts/backfill-derived.mjs call,
 *     so a rule change to that file is picked up here with no edit, and this
 *     script never becomes a second copy of a rule that db/207's own header
 *     says must have exactly one owner.
 *   - It does not attempt to mirror every table the app can write to. The
 *     fixtures are the identity rows (better-auth's own four tables plus
 *     app_user_profile) and the board rows /board and /jobs-data read
 *     (jobs, board_kills, board_stats). A journey that needs a Profile Record
 *     entry, a draft, a watchlist row or a provider key writes that row
 *     itself as part of the journey it is proving, the same way a real
 *     account would create it, rather than finding it pre-seeded by a script
 *     that has never run the feature.
 *   - It is not a general-purpose migration or seeding tool. It knows exactly
 *     one target database. Pointing it at anything else is the one thing it
 *     is built to refuse.
 *
 * Plain Node ESM, Node 24, the `pg` dependency this repo already has. No new
 * npm dependencies.
 */

import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { derivedFor } from '../src/lib/jobs-derived.mjs';

const { Client } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const NAME = 'test-db';

/** The one database this script is allowed to drop, create, truncate or
 *  write to. A literal, never built from user input or a parsed URL, so a
 *  typo elsewhere in this file cannot widen what gets destroyed. */
const TEST_DB_NAME = 'antialgo_test';

function fail(message, code = 2) {
  console.error(`${NAME}: ${message}`);
  process.exit(code);
}

/**
 * The local Postgres URL this script copies its host, port and credentials
 * from. Read the same way every other script in this repo reads its database
 * URL (db/migrate.mjs, scripts/admit.mjs): DATABASE_URL_UNPOOLED, falling
 * back to DATABASE_URL.
 *
 * .env.local (via load-local-env.mjs) is consulted ONLY when NEITHER variable
 * is already present in the real process environment. This is deliberately
 * stricter than load-local-env.mjs's own per-key "never overwrite" rule,
 * because that rule is a trap for this specific script: if an operator or a
 * CI runner exports DATABASE_URL alone (say, pointed at a Neon branch) and
 * leaves DATABASE_URL_UNPOOLED unset, a plain import of load-local-env.mjs
 * would fill in DATABASE_URL_UNPOOLED from .env.local's *local* value, which
 * this script's own precedence then prefers — silently substituting the
 * local database for the one the caller actually set, and defeating the
 * non-local-host refusal below with the least suspicious-looking input
 * (nothing about it fails to parse; it just quietly targets the wrong host).
 * Loading .env.local only when both variables are actually absent closes
 * that gap: an explicit DATABASE_URL of any kind is trusted exactly as
 * given, never partially overridden.
 */
async function readSourceUrl() {
  let url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    await import('../load-local-env.mjs');
    url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  }
  if (!url) {
    fail(
      'no DATABASE_URL_UNPOOLED or DATABASE_URL in the environment or in .env.local.\n' +
        '  This script copies its host, port and user from that value; it does not invent one.\n' +
        '  Fix: add DATABASE_URL to .env.local (see .env.example), pointing at your local Postgres.'
    );
  }
  return url;
}

/**
 * Parses `sourceUrl` and refuses it outright unless the host is localhost or
 * 127.0.0.1. This is the single check that stands between this script and
 * ever running DROP DATABASE or TRUNCATE ... CASCADE against a real database.
 * Called before ANY of this script's three commands does anything else,
 * including `url`, which only prints a connection string but must never
 * print one a test runner could point at production by accident.
 */
function assertLocalHost(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    fail(
      `DATABASE_URL is not a valid connection URL: ${JSON.stringify(sourceUrl)}\n` +
        '  Expected something like postgres://user@localhost:5432/antialgo_dev.'
    );
  }
  const host = parsed.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    fail(
      `refusing to run: DATABASE_URL's host is ${JSON.stringify(host)}, not localhost or 127.0.0.1.\n` +
        '  The production database is a Vercel Marketplace Neon instance (docs/neon-launch-plan, ' +
        'and docs/regression-strategy.md section 6.1), and this script runs DROP DATABASE and\n' +
        '  TRUNCATE ... CASCADE. It will not run those against anything but a local Postgres.\n' +
        '  Fix: point DATABASE_URL (in .env.local or the environment) at your local Postgres, ' +
        'the same one antialgo_dev already lives on.'
    );
  }
  return parsed;
}

/** Clones `parsed` with the path swapped to /antialgo_test. Same host, port
 *  and credentials as the source URL; a different database entirely. */
function toTestUrl(parsed) {
  const testUrl = new URL(parsed.toString());
  testUrl.pathname = `/${TEST_DB_NAME}`;
  return testUrl.toString();
}

/** Same idea, pointed at Postgres's own always-present `postgres` database,
 *  used only to issue DROP DATABASE / CREATE DATABASE against antialgo_test
 *  (Postgres refuses to drop a database you are connected to). */
function toMaintenanceUrl(parsed) {
  const maintUrl = new URL(parsed.toString());
  maintUrl.pathname = '/postgres';
  return maintUrl.toString();
}

/**
 * Connects `client` and translates the connection failures a developer will
 * actually hit into one sentence with the fix, instead of a raw stack trace.
 * Exits 2 either way: a database that cannot be reached is "could not run",
 * never a pass and never a silent 0.
 */
async function connectOrExplain(client, describedAs) {
  try {
    await client.connect();
  } catch (err) {
    if (err && err.code === 'ECONNREFUSED') {
      fail(
        `could not reach Postgres to connect to ${describedAs} (connection refused).\n` +
          '  Fix: start Homebrew Postgres — `brew services start postgresql@17` — then try again.'
      );
    }
    if (err && err.code === '3D000') {
      fail(
        `${describedAs} does not exist yet.\n` +
          '  Fix: run `node scripts/test-db.mjs reset` first — it creates and migrates it.'
      );
    }
    fail(`could not connect to ${describedAs}: ${err && err.message ? err.message : err}`);
  }
}

/**
 * The one check that runs immediately after every connection this script
 * opens to what it believes is antialgo_test, before any statement that
 * could change data. Asks Postgres itself, not the URL string this script
 * built, because a URL is a claim and current_database() is the fact.
 */
async function assertConnectedToTestDb(client) {
  const { rows } = await client.query('SELECT current_database() AS db');
  const actual = rows[0] && rows[0].db;
  if (actual !== TEST_DB_NAME) {
    fail(
      `refusing to run: connected to database ${JSON.stringify(actual)}, not ${JSON.stringify(TEST_DB_NAME)}.\n` +
        '  This should be unreachable — it means toTestUrl() built the wrong URL. Stopping rather ' +
        'than guessing which database was meant.'
    );
  }
}

/** Table + total-row counts for antialgo_dev, read-only, so `reset` can prove
 *  afterwards that nothing there moved. Never opened for anything but SELECT. */
async function snapshotDevDb(sourceUrl) {
  const client = new Client({ connectionString: sourceUrl });
  await connectOrExplain(client, 'antialgo_dev (to record its before/after counts)');
  try {
    const { rows: dbRow } = await client.query('SELECT current_database() AS db');
    const dbName = dbRow[0].db;
    const { rows: tableRows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    let totalRows = 0;
    for (const { table_name: table } of tableRows) {
      const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM "${table}"`);
      totalRows += Number(rows[0].n);
    }
    return { dbName, tableCount: tableRows.length, totalRows };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Fixtures. Fixed ids and fixed timestamps throughout, so two runs of `reset`
// or `seed` produce byte-identical rows.
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-01-01T00:00:00.000Z';

/**
 * One account per role the sweep needs. Signed-out needs no row at all.
 * Tiers match app_user_profile's CHECK constraint (db/134_paid_tier.sql) and
 * src/lib/entitlement.ts's ladder. `waitlisted` is not seeded: no journey in
 * docs/regression-strategy.md's build order exercises it, and the vocabulary
 * lives entirely in tiers.config.mjs if a later journey needs it.
 */
const USERS = [
  { id: 'usr_test_member', email: 'member@test.antialgo.local', tier: 'member', firstName: 'Test', lastName: 'Member' },
  { id: 'usr_test_paid', email: 'paid@test.antialgo.local', tier: 'paid', firstName: 'Test', lastName: 'Paid' },
  { id: 'usr_test_internal', email: 'internal@test.antialgo.local', tier: 'internal', firstName: 'Test', lastName: 'Internal' }
];

/**
 * Six tracker rows (db/117_jobs.sql), picked to spread across the dimensions
 * /board and /jobs-data actually filter on: a seniority word present and
 * absent, a department present and absent, five different applicant systems
 * split across both friction classes, five different regions, and a
 * structured pay range present and absent. Shapes copied from the fields
 * src/data/jobs.json actually carries (id, company, title, comp_range,
 * location, ats, ...); values are invented, not real postings.
 *
 * country is left null and location carries the full text on purpose:
 * regionOf() (src/lib/jobs-derived.mjs) reads country first and only falls
 * back to location when country is absent, so a row meant to prove the
 * location fallback has to actually omit country, not just leave it thin.
 */
const JOB_RAWS = [
  {
    id: 'greenhouse|fixture-001',
    company: 'Figma',
    title: 'Senior Product Designer',
    url: 'https://boards.greenhouse.io/figma/jobs/fixture-001',
    location: 'San Francisco, CA',
    country: null,
    remote: false,
    published: '2026-01-05T00:00:00.000Z',
    ats: 'greenhouse',
    posting_id: 'fixture-001',
    department: 'Design',
    comp_posted: '$150,000 - $210,000',
    comp_range: { min: 150000, max: 210000, currency: 'USD' },
    days_up: 1,
    first_seen: '2026-01-05',
    last_seen: '2026-01-06',
    fit_total: 92,
    fit_components: { title_scope: 28, remote_geo: 22, comp: 20, freshness: 12, apply_friction: 10 }
  },
  {
    id: 'ashby|fixture-002',
    company: 'Notion',
    title: 'Staff Product Designer',
    url: 'https://jobs.ashbyhq.com/notion/fixture-002',
    location: 'Toronto, Canada',
    country: null,
    remote: true,
    published: '2026-01-04T00:00:00.000Z',
    ats: 'ashby',
    posting_id: 'fixture-002',
    department: 'Product Design',
    comp_posted: '$140,000 - $190,000',
    comp_range: { min: 140000, max: 190000, currency: 'USD' },
    days_up: 2,
    first_seen: '2026-01-04',
    last_seen: '2026-01-06',
    fit_total: 85,
    fit_components: { title_scope: 26, remote_geo: 20, comp: 18, freshness: 11, apply_friction: 10 }
  },
  {
    id: 'amazon|fixture-003',
    company: 'Amazon',
    title: 'Staff UX Researcher',
    url: 'https://amazon.jobs/fixture-003',
    location: 'New York, NY',
    country: null,
    remote: false,
    published: '2026-01-01T00:00:00.000Z',
    ats: 'amazon',
    posting_id: 'fixture-003',
    department: 'UX Research',
    comp_posted: null,
    comp_range: null,
    days_up: 5,
    first_seen: '2026-01-01',
    last_seen: '2026-01-06',
    fit_total: 55,
    fit_components: { title_scope: 20, remote_geo: 15, comp: 10, freshness: 8, apply_friction: 2 }
  },
  {
    id: 'workday|fixture-004',
    company: 'TechCorp',
    title: 'Lead Content Designer',
    url: 'https://techcorp.wd1.myworkdayjobs.com/fixture-004',
    location: 'Austin, TX',
    country: null,
    remote: false,
    published: '2025-12-28T00:00:00.000Z',
    ats: 'workday',
    posting_id: 'fixture-004',
    department: null,
    comp_posted: null,
    comp_range: null,
    days_up: 9,
    first_seen: '2025-12-28',
    last_seen: '2026-01-06',
    fit_total: 40,
    fit_components: { title_scope: 15, remote_geo: 10, comp: 5, freshness: 8, apply_friction: 2 }
  },
  {
    id: 'lever|fixture-005',
    company: 'Monzo',
    title: 'Director of Design',
    url: 'https://jobs.lever.co/monzo/fixture-005',
    location: 'London, UK',
    country: null,
    remote: false,
    published: '2026-01-03T00:00:00.000Z',
    ats: 'lever',
    posting_id: 'fixture-005',
    department: 'Design',
    comp_posted: '£120,000 - £160,000',
    comp_range: { min: 120000, max: 160000, currency: 'GBP' },
    days_up: 3,
    first_seen: '2026-01-03',
    last_seen: '2026-01-06',
    fit_total: 78,
    fit_components: { title_scope: 24, remote_geo: 18, comp: 16, freshness: 10, apply_friction: 10 }
  },
  {
    id: 'greenhouse|fixture-006',
    company: 'ExampleCo',
    title: 'Product Designer',
    url: 'https://boards.greenhouse.io/exampleco/jobs/fixture-006',
    location: 'Bangalore, India',
    country: null,
    remote: false,
    published: '2026-01-02T00:00:00.000Z',
    ats: 'greenhouse',
    posting_id: 'fixture-006',
    department: 'Design',
    comp_posted: null,
    comp_range: null,
    days_up: 4,
    first_seen: '2026-01-02',
    last_seen: '2026-01-06',
    fit_total: 60,
    fit_components: { title_scope: 20, remote_geo: 15, comp: 10, freshness: 10, apply_friction: 5 }
  }
];

// Internal consistency check: catches a typo in the hand-written
// fit_components above before it reaches the database. Not a rule this file
// owns — the real rubric is src/lib/board-jobs.ts — just a guard that the
// invented fixture numbers actually add up the way real ones would.
for (const raw of JOB_RAWS) {
  const sum = Object.values(raw.fit_components).reduce((a, b) => a + b, 0);
  if (sum !== raw.fit_total) {
    throw new Error(
      `test-db: fixture bug, not a database problem — ${raw.id}'s fit_components sum to ${sum}, ` +
        `not fit_total ${raw.fit_total}. Fix the numbers in scripts/test-db.mjs.`
    );
  }
}

/**
 * Clears exactly the fixture rows and re-inserts them, inside one
 * transaction. Safe to call on a freshly migrated, empty database (that's
 * what `reset` does) or on a database `seed` has already run against before.
 *
 * TRUNCATE "user" CASCADE also clears session, account, app_user_profile and
 * every other table with an ON DELETE CASCADE foreign key to "user" (the
 * repo's own convention — see db/101_app_user_profile.sql's header) —
 * including any session row better-auth's testUtils plugin minted for these
 * fixture users in an earlier run. That is intended: `seed` promises a clean
 * slate, and a test run that needs a session mints a fresh one against the
 * freshly-seeded user row, every time.
 */
async function seedFixtures(client) {
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE TABLE "user" CASCADE');
    await client.query('TRUNCATE TABLE verification');
    await client.query('TRUNCATE TABLE jobs, board_kills, board_stats CASCADE');

    for (const u of USERS) {
      await client.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, true, NULL, $4, $4)`,
        [u.id, `${u.firstName} ${u.lastName}`, u.email, FIXED_TS]
      );
      await client.query(
        `INSERT INTO account (id, issuer, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, 'credential', $2, 'credential', $2, NULL, $3, $3)`,
        [`acc_${u.id}`, u.id, FIXED_TS]
      );
      await client.query(
        `INSERT INTO app_user_profile (user_id, tier, signup_source, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, 'fixture', $3, $4, $5, $5)`,
        [u.id, u.tier, u.firstName, u.lastName, FIXED_TS]
      );
    }

    for (const raw of JOB_RAWS) {
      const slug = `${raw.company}-${raw.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      // The one definition (src/lib/jobs-derived.mjs), the same call
      // scripts/ingest-jobs.mjs and scripts/backfill-derived.mjs make. No
      // rule from db/207's derivation is restated here.
      const d = derivedFor(raw);
      await client.query(
        `INSERT INTO jobs (
           id, company, title, url, location, country, remote, published, ats, posting_id,
           department, comp_posted, comp_range, days_up, ghost, first_seen, last_seen,
           slug, fit_total, fit_components, source, status, description,
           derived_tier, derived_fam, derived_region, derived_friction,
           priced, comp_min_k, comp_max_k, comp_mid_k
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, false, $15, $16,
           $17, $18, $19, 'tracked', 'live', NULL,
           $20, $21, $22, $23,
           $24, $25, $26, $27
         )`,
        [
          raw.id, raw.company, raw.title, raw.url, raw.location, raw.country, raw.remote,
          raw.published, raw.ats, raw.posting_id,
          raw.department, raw.comp_posted, raw.comp_range ? JSON.stringify(raw.comp_range) : null,
          raw.days_up, raw.first_seen, raw.last_seen,
          slug, raw.fit_total, JSON.stringify(raw.fit_components),
          d.derived_tier, d.derived_fam, d.derived_region, d.derived_friction,
          d.priced, d.comp_min_k, d.comp_max_k, d.comp_mid_k
        ]
      );
    }

    await client.query(
      `INSERT INTO board_stats (
         id, boards_swept, verified_live, killed, killed_by_rule, swept_at,
         postings_observed, kills_by_rule, killed_all_time, kills_exported_at, stage_log
       ) VALUES (1, $1, $2, 0, 0, $3, $4, '{}'::jsonb, 0, $3, $5::jsonb)`,
      [
        6,
        JOB_RAWS.length,
        FIXED_TS,
        14,
        JSON.stringify({ read: FIXED_TS, verify: FIXED_TS, kill: FIXED_TS, save: FIXED_TS })
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** The counts printed after a successful reset or seed, so a run that wrote
 *  nothing cannot look identical to one that worked. */
async function proofCounts(client) {
  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables,
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM app_user_profile) AS profiles,
      (SELECT count(*)::int FROM jobs) AS jobs,
      (SELECT count(*)::int FROM board_stats) AS board_stats
  `);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdUrl() {
  const sourceUrl = await readSourceUrl();
  const parsed = assertLocalHost(sourceUrl);
  // Only the URL goes to stdout, so `DATABASE_URL=$(node scripts/test-db.mjs url)`
  // works cleanly. Nothing else is printed here.
  console.log(toTestUrl(parsed));
}

async function cmdReset() {
  const sourceUrl = await readSourceUrl();
  const parsed = assertLocalHost(sourceUrl);
  const testUrl = toTestUrl(parsed);
  const maintUrl = toMaintenanceUrl(parsed);

  console.log(`${NAME}: recording antialgo_dev's table and row counts before touching anything`);
  const before = await snapshotDevDb(sourceUrl);
  if (before.dbName !== 'antialgo_dev') {
    fail(
      `DATABASE_URL points at a database named ${JSON.stringify(before.dbName)}, not antialgo_dev. ` +
        'Not proceeding until that is explained: this script assumes DATABASE_URL is your normal local ' +
        'development database, and asserts it stays untouched.'
    );
  }
  console.log(`${NAME}: antialgo_dev has ${before.tableCount} tables and ${before.totalRows} rows total`);

  console.log(`${NAME}: dropping and recreating ${TEST_DB_NAME}`);
  const maint = new Client({ connectionString: maintUrl });
  await connectOrExplain(maint, "Postgres's maintenance database (to drop/create antialgo_test)");
  try {
    // WITH (FORCE) (Postgres 13+; this repo runs 17) disconnects any lingering
    // session on antialgo_test itself, so a crashed previous run or a stray
    // `psql antialgo_test` left open does not block the drop.
    await maint.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
    await maint.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await maint.end();
  }

  console.log(`${NAME}: applying db/*.sql to ${TEST_DB_NAME} via db/migrate.mjs`);
  const migrate = spawnSync(process.execPath, [join(REPO, 'db', 'migrate.mjs')], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl, DATABASE_URL_UNPOOLED: testUrl }
  });
  if (migrate.status !== 0) {
    fail(
      `db/migrate.mjs failed against ${TEST_DB_NAME} (exit ${migrate.status ?? 'signal'}). ` +
        'See its output above for which file. antialgo_test is left half-migrated; re-run `reset` ' +
        'once the migration file is fixed.'
    );
  }

  console.log(`${NAME}: seeding fixtures`);
  const client = new Client({ connectionString: testUrl });
  await connectOrExplain(client, TEST_DB_NAME);
  try {
    await assertConnectedToTestDb(client);
    await seedFixtures(client);
    const proof = await proofCounts(client);
    console.log(
      `${NAME}: ${TEST_DB_NAME} ready — ${proof.tables} tables, ${proof.users} users, ` +
        `${proof.profiles} profiles, ${proof.jobs} jobs, ${proof.board_stats} board_stats row`
    );
  } finally {
    await client.end();
  }

  console.log(`${NAME}: re-checking antialgo_dev`);
  const after = await snapshotDevDb(sourceUrl);
  if (after.tableCount !== before.tableCount || after.totalRows !== before.totalRows) {
    fail(
      `antialgo_dev changed during this run: was ${before.tableCount} tables / ${before.totalRows} rows, ` +
        `is now ${after.tableCount} tables / ${after.totalRows} rows. This script never issues a ` +
        'statement against antialgo_dev, so this means something else touched it while reset was ' +
        'running (a dev server, a migration, a manual psql session), not this script itself. It is ' +
        'still reported as a failure because "measured nothing changed" is the whole point of this check.',
      1
    );
  }
  console.log(
    `${NAME}: confirmed — antialgo_dev is unchanged (${after.tableCount} tables, ${after.totalRows} rows, ` +
      'same as before this run)'
  );
}

async function cmdSeed() {
  const sourceUrl = await readSourceUrl();
  const parsed = assertLocalHost(sourceUrl);
  const testUrl = toTestUrl(parsed);

  const client = new Client({ connectionString: testUrl });
  await connectOrExplain(client, TEST_DB_NAME);
  try {
    await assertConnectedToTestDb(client);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user'`
    );
    if (rows[0].n === 0) {
      fail(
        `${TEST_DB_NAME} has no "user" table yet — it has never been migrated.\n` +
          '  Fix: run `node scripts/test-db.mjs reset` once, then `seed` can re-run on its own.'
      );
    }
    await seedFixtures(client);
    const proof = await proofCounts(client);
    console.log(
      `${NAME}: re-seeded — ${proof.users} users, ${proof.profiles} profiles, ${proof.jobs} jobs, ` +
        `${proof.board_stats} board_stats row`
    );
  } finally {
    await client.end();
  }
}

const COMMANDS = { reset: cmdReset, seed: cmdSeed, url: cmdUrl };
const command = process.argv[2];

if (!command || !(command in COMMANDS)) {
  console.error(`Usage: node scripts/test-db.mjs <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}

try {
  await COMMANDS[command]();
} catch (err) {
  console.error(`${NAME}: unexpected error — ${err && err.stack ? err.stack : err}`);
  process.exit(2);
}
