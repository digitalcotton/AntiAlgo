/**
 * jobs-data-filters.ts: the allowlist. Every filter the Jobs Data page accepts,
 * what values it may take, and how a query string becomes a Filters object.
 *
 * WHY IT IS ITS OWN FILE. The parsing has to be testable without a database and
 * has to be the ONLY way a request reaches the query builder, so that "reject
 * unknown values" is a property of the code path rather than a habit. The
 * endpoint parses here and passes the result on; jobs-data-agg.ts accepts a
 * Filters object and nothing else, so an unvalidated string has no route to a
 * query.
 *
 * NOTHING HERE IS INTERPOLATED INTO SQL. Every value that reaches Postgres is a
 * bound parameter. The allowlist exists because a rejected value should be a
 * 400 the reader can see, not a silently empty cut, and because an enum that
 * lives in one place cannot drift from the buttons that set it.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

import { TIERS } from './jobs-derived.mjs';

/** Where the role sits. */
export const WHERES = ['anywhere', 'remote only', 'in office'] as const;
/** Whether a pay range was printed. */
export const PRICEDS = ['any', 'priced', 'unpriced'] as const;
/** Whether applying needs an account. See jobs-derived.mjs for the evidence. */
export const FRICTIONS = ['any', 'easy', 'hard'] as const;
/** The issuer's kill record. */
export const RECORDS = ['any', 'clean', 'lowchurn'] as const;
/** Pay floors, in thousands. */
export const FLOORS = [0, 150, 200, 250, 300] as const;
/** Age windows, in days. 0 is "any". */
export const AGES = [0, 2, 4, 7, 14] as const;

export type Where = (typeof WHERES)[number];
export type PricedFilter = (typeof PRICEDS)[number];
export type FrictionFilter = (typeof FRICTIONS)[number];
export type RecordFilter = (typeof RECORDS)[number];

/**
 * THE WATCHED TITLE GROUPS. A group is a named predicate over the measured
 * department and the title-derived seniority; the page's title search and its
 * "titles in the cut" shelf both read them.
 *
 * MOVED HERE FROM THE BROWSER UNCHANGED, CASE AND ALL. These lived in
 * public/scripts/ledger-v4-app.js as GROUP_TESTS, comparing the department
 * against lowercase words. The measured departments are capitalised at the
 * source ("Product", "Brand"), so every one of these groups matches zero rows
 * today. That is a defect, and it is reproduced here exactly rather than fixed,
 * because the parity check this build has to pass compares against the old
 * numbers. Fixing it is a one-word change (a lower() on both sides) and a
 * separate decision, since it would move counts on the page.
 */
export const GROUP_DEFS = [
  { title: 'Product Designer', fam: 'product', tiers: ['Senior', 'Staff'] },
  { title: 'Design Engineer', fam: 'design engineering', tiers: ['Senior', 'Staff'] },
  { title: 'Brand Designer', fam: 'brand', tiers: ['Senior', 'Staff'] },
  { title: 'Design Systems Designer', fam: 'design systems', tiers: ['Senior', 'Staff'] },
  { title: 'Design Leadership', fam: null, tiers: ['Lead', 'Director'] }
] as const;

const GROUP_TITLES = GROUP_DEFS.map((g) => g.title) as readonly string[];

/** One watched group, with the exact titles the reader switched off inside it. */
export interface Watch {
  title: string;
  off: string[];
}

/** Every filter the page may set. The shape jobs-data-agg.ts consumes. */
export interface Filters {
  watches: Watch[];
  where: Where;
  floor: number;
  priced: PricedFilter;
  age: number;
  /** A seniority from TIERS, or 'any'. */
  level: string;
  /** A raw applicant-system key as stored in jobs.ats, or 'any'. */
  ats: string;
  friction: FrictionFilter;
  record: RecordFilter;
}

/** The unfiltered view: what the page shows before a reader touches anything. */
export const NO_FILTERS: Filters = Object.freeze({
  watches: [],
  where: 'anywhere',
  floor: 0,
  priced: 'any',
  age: 0,
  level: 'any',
  ats: 'any',
  friction: 'any',
  record: 'any'
});

/** True when these filters are the unfiltered view (so the cached default
    can answer without building anything). */
export function isUnfiltered(f: Filters): boolean {
  return (
    f.watches.length === 0 && f.where === 'anywhere' && f.floor === 0 &&
    f.priced === 'any' && f.age === 0 && f.level === 'any' &&
    f.ats === 'any' && f.friction === 'any' && f.record === 'any'
  );
}

/** A rejected parameter, named, so the 400 says which one and what was allowed. */
export class FilterError extends Error {
  readonly param: string;
  constructor(param: string, value: string, allowed: readonly (string | number)[]) {
    super(`"${param}" does not accept ${JSON.stringify(value)}. Allowed: ${allowed.join(', ')}.`);
    this.param = param;
    this.name = 'FilterError';
  }
}

function oneOf<T extends string>(
  params: URLSearchParams, key: string, allowed: readonly T[], fallback: T
): T {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new FilterError(key, raw, allowed);
}

function oneNumberOf(
  params: URLSearchParams, key: string, allowed: readonly number[], fallback: number
): number {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && allowed.includes(n)) return n;
  throw new FilterError(key, raw, allowed);
}

/** The most watched groups one request may carry. The page offers five. */
const MAX_WATCHES = 8;
/** The most switched-off titles inside one group. A group's variant list is
    the distinct titles it matched, so this is generous, not tight. */
const MAX_OFF = 200;
/** The longest title string accepted in an off list. */
const MAX_TITLE_LEN = 200;

/**
 * Parse a query string into Filters, or throw FilterError naming the first
 * parameter that does not pass. Unknown parameters are ignored rather than
 * refused: a stale bookmark carrying a filter this page has retired should
 * still render, and every parameter that IS read is checked.
 *
 * Watched groups arrive as repeated `watch` parameters holding a group title,
 * optionally followed by titles to switch off after a tab:
 *   watch=Product+Designer
 *   watch=Design+Leadership%09Head+of+Design%09VP+Design
 */
export function parseFilters(params: URLSearchParams): Filters {
  const level = (() => {
    const raw = params.get('level');
    if (raw === null || raw === '') return 'any';
    if (raw === 'any' || (TIERS as readonly string[]).includes(raw)) return raw;
    throw new FilterError('level', raw, ['any', ...TIERS]);
  })();

  // ats is checked against the systems the crawl actually holds, which the
  // caller supplies, because the set grows every time an adapter ships and a
  // hand-written list here would go stale silently.
  const ats = params.get('ats');

  const watches: Watch[] = [];
  for (const raw of params.getAll('watch')) {
    if (watches.length >= MAX_WATCHES) {
      throw new FilterError('watch', String(watches.length + 1), [`at most ${MAX_WATCHES}`]);
    }
    const [title, ...off] = String(raw).split('\t');
    if (!GROUP_TITLES.includes(title)) throw new FilterError('watch', title, GROUP_TITLES);
    if (off.length > MAX_OFF) throw new FilterError('watch', `${off.length} off titles`, [`at most ${MAX_OFF}`]);
    for (const t of off) {
      if (t.length > MAX_TITLE_LEN) throw new FilterError('watch', t.slice(0, 40) + '...', [`at most ${MAX_TITLE_LEN} characters`]);
    }
    watches.push({ title, off });
  }

  return {
    watches,
    where: oneOf(params, 'where', WHERES, 'anywhere'),
    floor: oneNumberOf(params, 'floor', FLOORS, 0),
    priced: oneOf(params, 'priced', PRICEDS, 'any'),
    age: oneNumberOf(params, 'age', AGES, 0),
    level,
    ats: ats === null || ats === '' ? 'any' : ats,
    friction: oneOf(params, 'friction', FRICTIONS, 'any'),
    record: oneOf(params, 'record', RECORDS, 'any')
  };
}

/**
 * Check the ats value against the systems the crawl holds. Separate from
 * parseFilters because the allowed set is a database read, and parsing must
 * stay pure and testable.
 */
export function assertAtsKnown(f: Filters, known: readonly string[]): void {
  if (f.ats !== 'any' && !known.includes(f.ats)) {
    throw new FilterError('ats', f.ats, ['any', ...known]);
  }
}

/**
 * A stable cache key for one filter combination. Sorted and fully spelled out,
 * so two requests that mean the same cut hit the same cache entry whatever
 * order their parameters arrived in.
 */
export function cacheKey(f: Filters): string {
  const watches = f.watches
    .map((w) => w.title + ' ' + w.off.slice().sort().join(' '))
    .sort()
    .join('');
  return [
    watches, f.where, f.floor, f.priced, f.age, f.level, f.ats, f.friction, f.record
  ].join('|');
}
