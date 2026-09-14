/**
 * stats.ts: the sweep totals, read from the index, never typed.
 *
 * The index publishes its board's counts at /board/stats.json (site.config's
 * INDEX_STATS_URL), rebuilt from its own store on every request. This site
 * reads that endpoint per request and keeps one short in-memory copy so a
 * burst of visitors costs the index one fetch a minute, not one per visitor.
 * A fetch that fails returns null, and every surface that reads it renders
 * the absence in the human voice rather than a number it did not observe.
 */
import { INDEX_STATS_URL, WAITLIST_BASELINE } from '../../site.config.mjs';
import { db, isConfigured } from './db';

export interface SweepStats {
  boards_swept: number;
  verified_live: number;
  killed: number;
  killed_by_rule: number;
  postings_observed: number;
  swept_at: string;
  kills_by_rule: Record<string, number>;
  killed_all_time: number;
  board_rows: number;
  sample_killed_slug: string | null;
}

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 8 * 1000;

let cached: { at: number; value: SweepStats | null } | null = null;

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parse(raw: unknown): SweepStats | null {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object') return null;
  if (!isNumber(o.boards_swept) || !isNumber(o.verified_live) || typeof o.swept_at !== 'string') return null;
  return {
    boards_swept: o.boards_swept,
    verified_live: o.verified_live,
    killed: isNumber(o.killed) ? o.killed : 0,
    killed_by_rule: isNumber(o.killed_by_rule) ? o.killed_by_rule : 0,
    postings_observed: isNumber(o.postings_observed) ? o.postings_observed : 0,
    swept_at: o.swept_at,
    kills_by_rule: (o.kills_by_rule as Record<string, number>) ?? {},
    killed_all_time: isNumber(o.killed_all_time) ? o.killed_all_time : 0,
    board_rows: isNumber(o.board_rows) ? o.board_rows : 0,
    sample_killed_slug: typeof o.sample_killed_slug === 'string' ? o.sample_killed_slug : null
  };
}

export async function loadStats(): Promise<SweepStats | null> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let value: SweepStats | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(INDEX_STATS_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (response.ok) value = parse(await response.json());
  } catch (error) {
    console.error("stats: could not read the index's sweep totals:", error);
  }
  // A failed read is remembered for ten seconds, not a minute, so one bad
  // moment is not a minute of absences.
  cached = { at: value ? now : now - (CACHE_MS - 10 * 1000), value };
  return value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The sweep instant as the index prints it: "Sep 13, 2026, 07:32 UTC".
 * Derived by slicing the ISO string, never by formatting a Date, so it cannot
 * drift by a day depending on which machine rendered it.
 */
export function sweptStamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}, ${hh}:${mm} UTC`;
}

/** A calendar day as the index prints it: "Sep 13, 2026". */
export function dayStamp(date: Date | string): string {
  const iso = typeof date === 'string' ? date : date.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
}

/** A count as the index prints it: grouped, tabular, never abbreviated. */
export const count = (n: number): string => n.toLocaleString('en-US');

/**
 * How many accounts are on the waitlist right now, plus the display baseline
 * (site.config's WAITLIST_BASELINE). Reads our own table. Returns null when the
 * database is not configured or the read fails, so the caller can hide the
 * "in line" line rather than print a number it did not count. This is the one
 * queue figure the home page shows, and it is the real one: no invented count.
 */
export async function waitlistInLine(): Promise<number | null> {
  if (!isConfigured()) return null;
  try {
    const { rows } = await db().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app_user_profile WHERE tier = 'waitlisted'"
    );
    return (rows[0]?.n ?? 0) + WAITLIST_BASELINE;
  } catch (error) {
    console.error('stats: could not count the waitlist:', error);
    return null;
  }
}

/**
 * How many rows are on the email waitlist: a plain count(*) of waitlist_email,
 * the table the "Save my spot" page writes to. This is the "in line" figure
 * that page's eyebrow reads, and the home page reads it too (see
 * src/pages/index.astro), so both pages count the same list. No baseline is
 * added here, unlike waitlistInLine: this is the number a new, smaller list
 * starts at, not the account-tier waitlist the canvas seeded a display
 * baseline for.
 *
 * Unlike waitlistInLine, this never returns null: it returns 0 when the
 * database is not configured or the read fails. That is a deliberate
 * difference. waitlistInLine's caller hides the "in line" line entirely on a
 * failed read; the eyebrow this feeds is one clause of a sentence that is
 * always on screen, so there is no "hide this part" branch for a null to
 * signal into, and a landing page eyebrow that could not count for a moment
 * should read as zero, not disappear.
 */
export async function waitlistEmailCount(): Promise<number> {
  if (!isConfigured()) return 0;
  try {
    const { rows } = await db().query<{ n: number }>('SELECT count(*)::int AS n FROM waitlist_email');
    return rows[0]?.n ?? 0;
  } catch (error) {
    console.error('stats: could not count the email waitlist:', error);
    return 0;
  }
}
