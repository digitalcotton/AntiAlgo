/**
 * health.ts: the site's own invariants, checked live.
 *
 * WHY THIS IS A LIBRARY AND NOT A ROUTE. It began as a public /health endpoint,
 * the ordinary shape for a thing a monitor polls. The owner's call on 2026-09-24
 * was no: the site is being stabilised, and a new public surface — however thin —
 * is the wrong thing to add in the middle of that. It also, in its first version,
 * published the flag roster on a justification that turned out to be false.
 *
 * So the checks live here and are rendered on /internal, behind the internal tier
 * gate, beside the account controls the owner already opens. One page, everything
 * on it. The day an external monitor is actually wanted, this module is what that
 * route would call — the logic does not have to be written again.
 *
 * WHY THESE FOUR CHECKS. Each is a thing that has actually failed, not a thing
 * that might. Neon's compute cap took the whole site down on 2026-09-20 and the
 * first anyone knew was the site being down; a check that answers "the process is
 * running" would have said everything was fine, because the process WAS fine.
 *
 * THE CONTRACT, from src/data/conformance-run.ts's rule for a self-checking claim:
 * a verdict is 'pass', 'fail' or 'could-not-run', and 'could-not-run' is never
 * treated as a pass. A check that needs the database and cannot reach it has
 * measured nothing, which is a different fact from measuring a failure.
 */
import { db, isConfigured } from './db';
import { getBoardStats } from './job-store';
import { FRESH_WINDOW_HOURS } from './data-contract';
import { FLAGS, isOn, type FlagName } from './flags';


/** Every db/*.sql file this build was made from, counted at build time. See the
 *  header above for why this is not a runtime directory read. */
const MIGRATION_FILE_COUNT = Object.keys(import.meta.glob('../../db/*.sql')).length;

/** How long a single check may take before it counts as could-not-run rather
 *  than hang the endpoint. A health check that can itself hang is exactly the
 *  self-fetch failure mode this repository's home page already had to guard
 *  against (src/lib/stats.ts's own TIMEOUT_MS). */
const CHECK_TIMEOUT_MS = 5_000;

export type Verdict = 'pass' | 'fail' | 'could-not-run';

export interface Invariant {
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

/**
 * Every invariant, checked now. Returns the list and whether all of them hold.
 *
 * Called from src/pages/internal/index.astro, which is behind the internal gate.
 * NOT a route: see this file's header for why it stopped being one.
 */
export async function healthNow(): Promise<{ allPass: boolean; invariants: Invariant[] }> {
  const database = await checkDatabase();
  const invariants: Invariant[] =
    database.verdict === 'pass'
      ? [database, await checkMigrations(), ...(await checkBoard())]
      : [database, SKIPPED('migrations_applied'), SKIPPED('board_has_rows'), SKIPPED('board_sweep_fresh')];

  return { allPass: invariants.every((invariant) => invariant.verdict === 'pass'), invariants };
}
