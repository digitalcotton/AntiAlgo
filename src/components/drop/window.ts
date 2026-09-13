/**
 * window.ts: the weekly drop's own week boundary, and nothing else.
 *
 * WHY THIS IS SEPARATE FROM src/pages/drop.astro. data.ts owns every derived
 * observation on this site (see that file's own header), and it has no
 * concept of a week: `swept_at_utc` is the one clock, and "a week" is a
 * cadence choice a page makes, not a fact the sweep recorded. That is the
 * same reason emails/lib/content.mjs defines DIGEST_WINDOW_DAYS in its own
 * file rather than in data.ts. drop.astro needs the identical kind of rule,
 * independently: seven days back from the sweep's own calendar day. Pulling
 * it out of the page and into this file, rather than leaving it inline in
 * drop.astro's frontmatter, is what lets a plain vitest run exercise the one
 * piece of drop-specific logic that decides which published records a
 * reader sees, against the real fixtures in src/data/, with no Astro
 * renderer involved at all.
 *
 * EVERY FUNCTION HERE IS A FILTER, NEVER A COUNT. Nothing in this file
 * invents a number: each export takes the rows data.ts already returned
 * (verifiedJobs(), closedJobs(), killArchive(), loadKills()) and narrows them
 * by a date the record already carries (first_observed, closed_on,
 * killed_on). The count a reader sees on /drop is always
 * `someFilterHere(...).length`, read at render time, never typed.
 */

import type { Job, Kill } from '../../lib/data';

/** Seven days, because the drop is weekly. See this file's own header for
    why data.ts does not own this constant. */
export const DROP_WINDOW_DAYS = 7;

export interface DropWindow {
  /** The first calendar day inside the window, inclusive. */
  from: string;
  /** The sweep's own calendar day. Always sweepDate(). */
  to: string;
  days: number;
}

/**
 * The window, as two dates the page can print. `sweepDateISO` is always
 * `sweepDate()`'s own return value; it is passed in rather than read here so
 * this file never imports data.ts's mutable module state, only the plain
 * types it needs.
 */
export function dropWindow(sweepDateISO: string): DropWindow {
  const toMillis = Date.UTC(
    Number(sweepDateISO.slice(0, 4)),
    Number(sweepDateISO.slice(5, 7)) - 1,
    Number(sweepDateISO.slice(8, 10))
  );
  const from = new Date(toMillis - DROP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { from, to: sweepDateISO, days: DROP_WINDOW_DAYS };
}

/**
 * Whether a record's own date falls inside the window, `daysBetween` is the
 * caller's own (data.ts's), so this file never reimplements date arithmetic:
 * it only asks the question and reads the answer.
 */
export function insideDropWindow(
  isoDate: string | null | undefined,
  window: DropWindow,
  daysBetween: (fromISO: string | null, toISO: string | null) => number | null
): boolean {
  if (!isoDate) return false;
  const elapsed = daysBetween(isoDate, window.to);
  return elapsed !== null && elapsed >= 0 && elapsed <= window.days;
}

/** Verified postings first observed inside the window. "What entered." */
export function enteredInWindow(
  verified: readonly Job[],
  window: DropWindow,
  daysBetween: (fromISO: string | null, toISO: string | null) => number | null
): Job[] {
  return verified.filter((job) => insideDropWindow(job.first_observed, window, daysBetween));
}

/** Postings whose own status closed inside the window. "What changed." */
export function closedInWindow(
  closed: readonly Job[],
  window: DropWindow,
  daysBetween: (fromISO: string | null, toISO: string | null) => number | null
): Job[] {
  return closed.filter((job) => insideDropWindow(job.closed_on ?? null, window, daysBetween));
}

/** Kill records dated inside the window, archive or publishable alike:
    the caller passes whichever set (killArchive() or loadKills()) it means.
    "What died." */
export function killsInWindow(
  kills: readonly Kill[],
  window: DropWindow,
  daysBetween: (fromISO: string | null, toISO: string | null) => number | null
): Kill[] {
  return kills.filter((kill) => insideDropWindow(kill.killed_on, window, daysBetween));
}
