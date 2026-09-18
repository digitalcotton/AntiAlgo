#!/usr/bin/env node
/**
 * Load the board into Postgres as the last step of a production build.
 *
 *   npm run build            runs this after astro build
 *   node scripts/ingest-on-build.mjs
 *
 * WHY THE INGEST MOVED FROM A GITHUB ACTION TO THE BUILD. The board's table was
 * loaded by .github/workflows/ingest.yml, triggered by the mini's nightly push
 * and by a daily schedule. On 2026-09-07 GitHub stopped starting jobs for this
 * account ("recent account payments have failed or your spending limit needs
 * to be increased"), every run failed in seconds with no runner assigned, and
 * the board silently kept the previous night's rows while the rest of the site
 * moved on to the new sweep. Two clocks on one site, which is the thing this
 * repository refuses, produced by a billing page nobody was looking at.
 *
 * The build already has everything the ingest needs: the crawl file is
 * committed beside the sweep files, and Vercel holds the database credentials
 * for the runtime. Running the load here ties the board to the same deploy
 * that publishes the sweep, so the two cannot come apart, and it takes GitHub
 * Actions out of the data path altogether. Actions remain for CI, which is a
 * check on the code and can be red without a reader seeing stale data.
 *
 * THREE THINGS THIS REFUSES TO DO.
 *
 *   1. Touch production from anything but a production deploy. A preview build
 *      of a branch has the same credentials in scope on Vercel and would
 *      TRUNCATE the live table with whatever that branch carried. VERCEL_ENV
 *      has to be exactly "production" or this does nothing.
 *   2. Run without credentials. A local `npm run build`, the data-contract
 *      proof's scratch build and the route census all build this site with no
 *      database in reach. Each says so in one line and moves on.
 *   3. Let a failed load look like a successful deploy. If the crawl is present,
 *      the environment is production and the load fails, the build fails with
 *      it. The site keeps its last good deploy, the staleness endpoint goes red
 *      within six hours, and nobody ships a fresh sweep stamp over a board that
 *      did not move. The alternative, a warning in a build log, is how the
 *      previous failure stayed invisible for a day.
 *
 * The load itself is unchanged: scripts/ingest-jobs.mjs, --replace, one
 * transaction, proven to roll back whole on a forced failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = join(REPO, 'src', 'data', 'board-latest.json.gz');
const NAME = 'ingest-on-build';

const env = process.env.VERCEL_ENV || '';
const hasCredentials = Boolean(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);

// Non-production builds touch nothing: no migrations, no load.
if (env !== 'production') {
  console.log(`${NAME}: VERCEL_ENV is ${JSON.stringify(env || '')}, not "production", so the live table is left alone.`);
  process.exit(0);
}
if (!hasCredentials) {
  // Production without credentials is a configuration fault, not a quiet
  // night: say so loudly and fail, because the alternative is a board that
  // never updates again with nothing in any log naming why.
  console.error(`${NAME}: this is a production build and neither DATABASE_URL_UNPOOLED nor DATABASE_URL is in the environment.`);
  console.error(`${NAME}: the board cannot be loaded. Check the Vercel project's environment variables.`);
  process.exit(1);
}

// MIGRATIONS FIRST, IN THE SAME DEPLOY, AND BEFORE THE CRAWL-FILE CHECK. The
// GitHub Action that used to apply db/*.sql is gone with the rest of the Actions
// data path, so the deploy that needs a column is the deploy that adds it. This
// runs on EVERY production build, not only the nights a fresh crawl file is
// present: a code-only deploy (a merge with no new board-latest.json.gz) still
// has to apply pending migrations, or a page that reads a new table 500s in
// production until a crawl happens to land. (That is exactly what shipped the
// Desk with ledger_watch/account_ledger_prefs missing: the old order bailed at
// the crawl-file check above before it ever reached this step.) migrate.mjs is
// idempotent (it records what it ran in schema_migrations, per file, in a
// transaction) and takes an advisory lock, so a second build the same night is a
// no-op. A migration that fails fails the build, for the same reason a load does.
console.log(`${NAME}: production build, applying db/*.sql that have not run yet`);
const migrate = spawnSync(process.execPath, [join(REPO, 'db', 'migrate.mjs')], {
  cwd: REPO,
  stdio: 'inherit',
  env: process.env
});
if (migrate.status !== 0) {
  console.error(`${NAME}: migrations failed (exit ${migrate.status ?? 'signal'}). Failing the build; the database is unchanged by the failed file.`);
  process.exit(migrate.status || 1);
}

// The crawl load is separate, and only runs when the mini has pushed a fresh
// file. A build with no crawl file has still applied the migrations above.
if (!existsSync(FILE)) {
  console.log(`${NAME}: no crawl file at src/data/board-latest.json.gz, nothing to load. Migrations applied; the board keeps its current rows.`);
  process.exit(0);
}

console.log(`${NAME}: loading the board from src/data/board-latest.json.gz`);
const run = spawnSync(process.execPath, [join(REPO, 'scripts', 'ingest-jobs.mjs'), '--file', FILE, '--replace'], {
  cwd: REPO,
  stdio: 'inherit',
  env: process.env
});

if (run.status !== 0) {
  console.error(`${NAME}: the load failed (exit ${run.status ?? 'signal'}). Failing the build so a fresh sweep is not published over a board that did not move.`);
  process.exit(run.status || 1);
}
console.log(`${NAME}: board loaded.`);
