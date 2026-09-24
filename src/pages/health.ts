/**
 * /health: a status endpoint that checks its own claims rather than making them.
 *
 * WHY THIS EXISTS. The Neon Free compute cap took the whole site down on
 * 2026-09-20 (see docs/regression-strategy.md, "Neon Launch plan" in memory) and
 * nothing was watching for it: the first anyone knew was the site itself being
 * down. A health endpoint that just answers 200 because the process is running
 * would not have caught that outage either — the process was fine, the database
 * behind it was not. So every field below is a live check against the thing
 * that actually failed last time, not a hardcoded "ok".
 *
 * THE CONTRACT, taken from src/data/conformance-run.ts's own rule for a
 * self-checking claim: a verdict is 'pass', 'fail', or 'could-not-run', and
 * 'could-not-run' is never treated as a pass. A check that depends on the
 * database and finds the database unreachable reports itself as
 * could-not-run, not as a silent pass — the same reasoning
 * src/lib/data-contract.ts's assertDataContract applies to a missing key
 * versus an empty array: two different findings, never conflated.
 *
 * ANSWERS 200 ONLY WHEN EVERY INVARIANT HOLDS. Anything else is 503, and the
 * body names which invariant(s) failed and how, so this is a page a monitor can
 * page a human from rather than one that only says "something, somewhere".
 *
 * PUBLIC, AND DELIBERATELY THIN ON WHAT IT SAYS. No row contents, no counts
 * that describe a person (no account, session or waitlist numbers — those are
 * a population size a stranger has no reason to learn from this repository,
 * even though some of them are printed elsewhere on the site by owner choice).
 * No env values, and no raw driver error text: a Postgres connection error can
 * carry a hostname or a port in its message, and that is infrastructure detail
 * a public endpoint should not repeat. Every failure below is logged in full
 * server-side (console.error) and reported publicly as a fixed, generic
 * sentence.
 *
 * MIGRATION FILE COUNT VIA import.meta.glob, NOT fs.readdirSync. A Vercel
 * function only ships the files its build can prove it needs; a runtime
 * fs.readdirSync('db/') has no such proof and can end up reading an empty
 * directory in production even though it works locally. import.meta.glob is
 * resolved by Vite at build time (the same mechanism src/pages/colophon.astro
 * already uses to census its own pages directory), so the count baked into the
 * bundle is the count that shipped with it.
 */
import type { APIRoute } from 'astro';
import { db, isConfigured } from '../lib/db';
import { getBoardStats } from '../lib/job-store';
import { FRESH_WINDOW_HOURS } from '../lib/data-contract';
import { FLAGS, isOn, type FlagName } from '../lib/flags';

export const prerender = false;

/** Every db/*.sql file this build was made from, counted at build time. See the
 *  header above for why this is not a runtime directory read. */
const MIGRATION_FILE_COUNT = Object.keys(import.meta.glob('../../db/*.sql')).length;

/** How long a single check may take before it counts as could-not-run rather
 *  than hang the endpoint. A health check that can itself hang is exactly the
 *  self-fetch failure mode this repository's home page already had to guard
 *  against (src/lib/stats.ts's own TIMEOUT_MS). */
const CHECK_TIMEOUT_MS = 5_000;

type Verdict = 'pass' | 'fail' | 'could-not-run';

interface Invariant {
  id: string;
  verdict: Verdict;
  /** What was checked, in its own numbers or a fixed sentence. Never an env
   *  value, a row's contents, or a raw driver error. */
  detail: string;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${CHECK_TIMEOUT_MS}ms`)),
      CHECK_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const SKIPPED = (id: string): Invariant => ({
  id,
  verdict: 'could-not-run',
  detail: 'skipped: the database is not reachable, checked above'
});

/**
 * Invariant 1: the database answers at all. Every other check below depends on
 * it, so a failure here short-circuits the rest as could-not-run rather than
 * three more confusing "fail" lines that all have the same one cause.
 */
async function checkDatabase(): Promise<Invariant> {
  if (!isConfigured()) {
    return { id: 'database_reachable', verdict: 'fail', detail: 'DATABASE_URL is not set.' };
  }
  try {
    await withTimeout(db().query('SELECT 1'), 'the database');
    return { id: 'database_reachable', verdict: 'pass', detail: 'reachable' };
  } catch (error) {
    console.error('health: the database did not answer:', error);
    return { id: 'database_reachable', verdict: 'fail', detail: 'the database did not answer' };
  }
}

/**
 * Invariant 2: every migration this build shipped with has actually been
 * applied. db/migrate.mjs is the only writer of schema_migrations, and it is
 * an at-most-once ledger — one row per filename, never a filename it has not
 * run. Comparing its count against the build's own file count is the same
 * check ingest-on-build.mjs's header describes needing ("a page that reads a
 * new table 500s in production until a crawl happens to land"), just made
 * answerable from outside a deploy log.
 */
async function checkMigrations(): Promise<Invariant> {
  try {
    const { rows } = await withTimeout(
      db().query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations'),
      'the migrations ledger'
    );
    const applied = rows[0]?.n ?? 0;
    return {
      id: 'migrations_applied',
      verdict: applied === MIGRATION_FILE_COUNT ? 'pass' : 'fail',
      detail: `${applied} of ${MIGRATION_FILE_COUNT} migration files applied`
    };
  } catch (error) {
    console.error('health: could not read schema_migrations:', error);
    return { id: 'migrations_applied', verdict: 'could-not-run', detail: 'schema_migrations could not be read' };
  }
}

/**
 * Invariants 3 and 4: the board is not silently empty, and its sweep is not
 * silently old. FRESH_WINDOW_HOURS is the exact number src/lib/data-contract.ts
 * defines as "the window the READER is promised" and board.astro already reads
 * it for the same board_stats row — this endpoint asks the question that
 * board.astro's own reader-facing staleness note answers visually, so a
 * monitor learns about a missed sweep the same moment a visitor would start to.
 */
async function checkBoard(): Promise<Invariant[]> {
  try {
    const { rows } = await withTimeout(
      db().query<{ n: number }>('SELECT count(*)::int AS n FROM jobs'),
      'the board'
    );
    const rowCount = rows[0]?.n ?? 0;
    const hasRows: Invariant = {
      id: 'board_has_rows',
      verdict: rowCount > 0 ? 'pass' : 'fail',
      detail: rowCount > 0 ? 'the board holds at least one row' : 'the jobs table is empty'
    };

    const stats = await withTimeout(getBoardStats(), 'the board stats row');
    if (!stats || !stats.swept_at) {
      return [
        hasRows,
        { id: 'board_sweep_fresh', verdict: 'fail', detail: 'board_stats has no swept_at stamp' }
      ];
    }
    const sweptMs = new Date(stats.swept_at).getTime();
    if (Number.isNaN(sweptMs)) {
      return [
        hasRows,
        { id: 'board_sweep_fresh', verdict: 'fail', detail: 'board_stats.swept_at is not a parseable date' }
      ];
    }
    const ageHours = (Date.now() - sweptMs) / 3_600_000;
    const fresh = ageHours >= -1 && ageHours <= FRESH_WINDOW_HOURS;
    return [
      hasRows,
      {
        id: 'board_sweep_fresh',
        verdict: fresh ? 'pass' : 'fail',
        detail: fresh
          ? `last swept ${ageHours.toFixed(1)}h ago, within the ${FRESH_WINDOW_HOURS}h window`
          : `last swept ${ageHours.toFixed(1)}h ago, past the ${FRESH_WINDOW_HOURS}h window`
      }
    ];
  } catch (error) {
    console.error('health: could not read the board:', error);
    return [
      { id: 'board_has_rows', verdict: 'could-not-run', detail: 'the board could not be read' },
      { id: 'board_sweep_fresh', verdict: 'could-not-run', detail: 'the board could not be read' }
    ];
  }
}

/** How MANY flags are on, and nothing more.
 *
 *  THE NAMES USED TO BE HERE, on the reasoning that flags.config.mjs "ships in the
 *  built bundle" and so the roster was already public. That reasoning was checked
 *  on 2026-09-24 and is false: grepping the served HTML for sponsor_slot,
 *  digest_personal, add_posting and analytics returns nothing, and nothing in
 *  dist/client carries them either. flags.config.mjs is read server-side only.
 *
 *  So listing them here would have made this endpoint the FIRST thing to publish
 *  the roster — that a 'stripe' flag exists and is dark, that a 'sponsor_slot'
 *  exists at all. That is unshipped product, and a monitoring endpoint has no
 *  business being where it leaks from. This file's own header says "PUBLIC, AND
 *  DELIBERATELY THIN ON WHAT IT SAYS"; a count honours that and a monitor loses
 *  nothing, because no flag state is an invariant anyway — both states are legal. */
function flagsOnCount(): number {
  return (Object.keys(FLAGS) as FlagName[]).filter((flag) => isOn(flag)).length;
}

export const GET: APIRoute = async () => {
  const checkedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const database = await checkDatabase();
  const invariants: Invariant[] =
    database.verdict === 'pass'
      ? [database, await checkMigrations(), ...(await checkBoard())]
      : [database, SKIPPED('migrations_applied'), SKIPPED('board_has_rows'), SKIPPED('board_sweep_fresh')];

  const allPass = invariants.every((invariant) => invariant.verdict === 'pass');

  const body = {
    status: allPass ? 'ok' : 'degraded',
    checked_at_utc: checkedAtUtc,
    invariants,
    flags_on_count: flagsOnCount()
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: allPass ? 200 : 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
};
