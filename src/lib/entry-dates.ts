/**
 * entry-dates.ts: the one way this codebase writes a record entry's dates as
 * a reader sees them, "March 2021 to Present".
 *
 * It used to live inside pdf-resume.ts, the only caller. The cover letter's
 * proof and fit paragraphs open on a core sentence ("Staff Designer at Acme,
 * March 2021 to Present"), so cover-letter.ts is now a second caller, and the
 * date format a bullet's meta line shows and the date format a letter's core
 * sentence shows must be one rule, not two. So it lives here, imported by
 * both, and pdf-resume.ts re-exports it so its own callers are unmoved.
 *
 * A PLAIN "to", NEVER A DASH. The no-dash house rule (CLAUDE.md rule 1) is
 * kept here the same as everywhere: a range reads "start to end", never with
 * an en dash between the years.
 *
 * These functions read a core's own numbers (start.year, start.month, end)
 * and interpolate them; no string-transforming call is ever chained onto a
 * core field name, so gate 8 (test/gates/provenance.mjs) stays satisfied when
 * it scans this file the same as it scanned pdf-resume.ts before the move.
 */

import type { ImmutableCore } from './record';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
] as const;

export function formatMonthYear(year: number, month: number | null): string {
  return month === null ? String(year) : `${MONTH_NAMES[month - 1]} ${year}`;
}

/** The dates as a document shows them: "March 2021 to Present". A plain "to",
    never a dash, matching the no-dash rule the rest of the site keeps.

    null when the core has no start: an undated skill, artifact or recognition
    (db/204) has no range to print, and every caller prints nothing for it
    rather than a "Present" that would claim a date nobody gave. The schema
    rules out an end with no start, so a null start is the whole test. */
export function dateRange(core: ImmutableCore): string | null {
  if (core.start === null) return null;
  const start = formatMonthYear(core.start.year, core.start.month);
  const end = core.end === null ? 'Present' : formatMonthYear(core.end.year, core.end.month);
  return `${start} to ${end}`;
}
