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
 * FOUR THINGS THIS REFUSES TO DO.
 *
 *   1. Touch production from anything but a production deploy. A preview build
 *      of a branch has the same credentials in scope on Vercel and would
 *      replace the live board with whatever that branch carried. VERCEL_ENV
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
 *   4. Load a board file belonging to a different site. Added 2026-10-01, see
 *      below: one crawl is exported twice, and only one of the two editions is
 *      this site's board.
 *
 * THE EDITION CHECK, AND THE NIGHT THAT BOUGHT IT. One crawl a night is exported
 * once per edition (jobmachine/editions.py): "everything", every role the crawl
 * read, which is antialgo.ai's board, and "curated", design, AI and UX research
 * only, which is tokenstoagents.ai's. On 2026-10-01 the curated file was written
 * into THIS repo and a production build loaded it: 4,330 rows replaced 57,852, a
 * 92.5% collapse, and it survived only because `jm publish everything` committed
 * the full board two seconds later. Had the two commits landed the other way
 * round the site would have served a twentieth of its board under a fresh
 * timestamp, and a reader would have read that as companies having stopped
 * hiring.
 *
 * So the file now has to say which edition it is, and it has to say this one. The
 * exporter already writes that: _meta.source carries the edition's own `source`
 * string, verbatim, from editions.py. The check is one string against one string,
 * which is the point; there is nothing to infer and nothing to guess at. A file
 * that will not say which edition it is is refused too, because "either of these
 * two" is not an answer when one of them is thirteen times the other.
 *
 * The load itself is unchanged: scripts/ingest-jobs.mjs, --replace, one
 * transaction, proven to roll back whole on a forced failure. That script now
 * carries a row-count floor of its own (src/lib/ingest-floor.mjs), so these two
 * guards are independent: this one refuses the wrong edition by name, the floor
 * refuses a collapse by size, whatever wrote the file and whoever called it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Reading the edition out of a board file is real logic with real ways to be
// wrong, and this file cannot be imported, so that part lives where a test can
// reach it. What stays here is the policy: which edition THIS site serves, and
// what a build does about a file that is not it.
import { EVERYTHING_EDITION, readBoardMeta } from '../src/lib/board-edition.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = join(REPO, 'src', 'data', 'board-latest.json.gz');
const NAME = 'ingest-on-build';

/** antialgo.ai serves the everything edition. This is the one line that says so. */
const BOARD_EDITION = EVERYTHING_EDITION;

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

// WHICH EDITION IS THIS, AND IS IT OURS. Read before the load, so a file from
// the wrong exporter never reaches the replace at all.
//
// This fails the build rather than skipping the load quietly, for the same reason
// refusal 2 above fails on missing credentials: the curated file being in this
// repo means something in the publish path is pointed at the wrong site, that
// will be just as true tomorrow night, and a skipped load with a green build is
// how this kind of fault stays invisible until a reader finds it. The board
// itself is not at risk from the red build: the full edition is loaded straight
// into Postgres by `jm publish everything`, so the rows a reader sees are the
// rows they already had.
const { meta, why } = await readBoardMeta(FILE);
if (!meta) {
  console.error(`${NAME}: src/data/board-latest.json.gz will not say which edition it is (${why}).`);
  console.error(`${NAME}: this site loads the "${BOARD_EDITION}" edition only, and an unidentified board file is not loaded over a known one.`);
  process.exit(1);
}
if (meta.source !== BOARD_EDITION) {
  console.error(`${NAME}: src/data/board-latest.json.gz is the wrong edition for this site.`);
  console.error(`${NAME}: it says it is ${JSON.stringify(meta.source ?? null)}; this site serves ${JSON.stringify(BOARD_EDITION)}.`);
  console.error(`${NAME}: the file declares ${meta.count ?? 'an unstated number of'} row(s), generated from ${meta.generated_from ?? 'an unstated crawl'}.`);
  console.error(`${NAME}: refusing to load it. Whatever wrote this file into the site repo is pointed at the wrong site; fix that, do not relax this check.`);
  process.exit(1);
}
console.log(`${NAME}: the board file is the ${JSON.stringify(meta.source)} edition, declaring ${meta.count ?? 'an unstated number of'} row(s). That is this site's edition.`);

// NO --allow-shrink HERE, EVER. That flag is how a person publishes a real
// contraction, with their own judgement behind it; a build has no judgement, so
// an unattended deploy must be refused by the floor rather than wave past it.
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
