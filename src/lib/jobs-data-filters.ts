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

import { SENIORITY_LADDER } from './jobs-derived.mjs';
import { FAMILIES } from './job-family.mjs';

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
 * THE WATCHED GROUPS: one per occupational family, every field the board holds.
 *
 * THIS PAGE USED TO BE FIVE DESIGN TITLES. Product Designer, Design Engineer,
 * Brand Designer, Design Systems Designer, Design Leadership — a closed list
 * written when AntiAlgo was a design board, kept after the board grew to 37,286
 * postings across every kind of work. A nurse, a welder or a paralegal could pay
 * for this page and find nothing on it to watch. That is the pre-filtering this
 * product is named for refusing, applied to its own customers.
 *
 * So the groups ARE the families now (src/lib/job-family.mjs), derived from
 * FAMILIES rather than listed again, so a family added there appears here
 * without anyone remembering to. 22 groups, covering 92.9% of the board; the
 * rest carries no family and is watched by watching nothing.
 *
 * NO SENIORITY RESTRICTION, and that is the load-bearing half of this change.
 * The five design groups each demanded Senior/Staff or Lead/Director, and
 * derived_tier is NULL on 79.6% of the board because most postings do not print
 * a level word. A group that required a tier would have excluded four rows in
 * five before it looked at the field at all — it would have made "Healthcare &
 * Medicine" mean "the senior fifth of healthcare" without saying so. Seniority
 * is a filter this page already offers separately (`level`), where a reader can
 * see it and turn it off.
 *
 * `words` stays in the shape for the day two groups share a family and need
 * telling apart by title. Every group is wordless today because each family
 * appears exactly once, which jobs-data-filters.test.ts enforces.
 */
export const GROUP_DEFS = FAMILIES.map((family) => ({
  title: family.label,
  fam: family.id,
  /** Null means every seniority, including the rows that print no level word. */
  tiers: null as readonly string[] | null,
  words: [] as readonly string[]
}));

const GROUP_TITLES = GROUP_DEFS.map((g) => g.title) as readonly string[];

/**
 * A group's title words as one case-insensitive POSIX pattern, or null where a
 * group has none. The words are repo constants, never reader input, and
 * jobs-data-filters.test.ts pins them to [a-z ] so neither the bound use in
 * marks() nor the interpolated use in boardFacts can carry a metacharacter.
 */
export function groupTitlePattern(words: readonly string[]): string | null {
  return words.length === 0 ? null : `(${words.join('|')})`;
}


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
  /** A seniority from SENIORITY_LADDER, or 'any'. */
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

/**
 * The most watched groups one request may carry: every group there is, so
 * "watch all" cannot 400. It was 8 when the page offered five design titles.
 * The bound still matters — each watch is an OR arm carrying up to MAX_OFF
 * switched-off titles — so it tracks the group count rather than being removed.
 */
const MAX_WATCHES = GROUP_DEFS.length;
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
    if (raw === 'any' || (SENIORITY_LADDER as readonly string[]).includes(raw)) return raw;
    throw new FilterError('level', raw, ['any', ...SENIORITY_LADDER]);
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
