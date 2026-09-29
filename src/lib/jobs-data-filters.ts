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
 * family, the title-derived seniority and, where a family alone cannot tell two
 * groups apart, a list of title words. The page's title search and its "titles
 * in the cut" shelf both read them.
 *
 * FIXED 2026-09-28. These were carried over from the browser unchanged and
 * tested `derived_fam` against `'product'`, `'design engineering'`, `'brand'`
 * and `'design systems'` — a vocabulary from data.ts's RoleFamily, which no
 * migration ever created and nothing ever wrote. The header here used to say
 * every group matched zero rows, that this was reproduced deliberately for a
 * parity check pinned to the old numbers, and that the fix was "a one-word
 * change (a lower() on both sides)". All three claims were wrong by the time
 * anyone read them:
 *
 *   - Not every group matched zero. db/212 changed derived_fam from the raw
 *     crawled department to the 22 closed ids, and 'product' happens to be one
 *     of them, so Product Designer silently went 0 -> 218 — a paid page's
 *     headline number moved because a migration did not know this column was
 *     read this way. Worse, those 218 were mostly product MANAGERS.
 *   - lower() would not have fixed the rest. 'brand', 'design engineering' and
 *     'design systems' are not family ids in any casing. The nearest real id is
 *     'design', which holds all four of these as one field.
 *   - And no baseline was pinned to the old numbers. jobs-data-agg.test.ts
 *     imports GROUP_DEFS and recomputes its oracle from it, so the parity check
 *     moves with this file. Nothing in the repo recorded a count.
 *
 * AND DESIGN LEADERSHIP HAD NO FAMILY TEST AT ALL, so on a page about design
 * titles it was matching every Lead or Director on the board in every field —
 * 2,830 rows, Directors of Nursing included.
 *
 * WHY `words` HAD TO BE ADDED. All four Senior/Staff groups live in one family,
 * `design`, so family plus tier cannot separate them: boardFacts assigns each
 * row to the FIRST matching group, and without a title test one group would
 * take all 80 rows and the other three would read zero — the same defect in a
 * new coat. Each is defined by the words its own titles actually use.
 *
 * ORDER IS MOST SPECIFIC FIRST, and that is load bearing for the same
 * first-match-wins reason: "Senior Brand Design Engineer" belongs to Design
 * Engineer, not Brand. It is also the order the page lists them in.
 *
 * A design role matching none of the four (motion, content, research,
 * copywriting — 29 rows) is in no group, which is honest. The board's own
 * Field filter still holds all of Design.
 */
export const GROUP_DEFS = [
  { title: 'Design Systems Designer', fam: 'design', tiers: ['Senior', 'Staff'], words: ['design system'] },
  {
    title: 'Design Engineer',
    fam: 'design',
    tiers: ['Senior', 'Staff'],
    words: ['design engineer', 'ux engineer', 'design technologist', 'creative technologist']
  },
  { title: 'Brand Designer', fam: 'design', tiers: ['Senior', 'Staff'], words: ['brand', 'visual identity', 'graphic'] },
  {
    title: 'Product Designer',
    fam: 'design',
    tiers: ['Senior', 'Staff'],
    words: ['product design', 'ux design', 'ui design', 'interaction design', 'experience design', 'digital design']
  },
  // Leadership needs no words: family and tier already separate it from the
  // four above, and design leadership titles vary too much to list (Director of
  // Design, Head of Design, Creative Director, VP Design).
  { title: 'Design Leadership', fam: 'design', tiers: ['Lead', 'Director'], words: [] }
] as const;

/**
 * A group's title words as one case-insensitive POSIX pattern, or null where a
 * group has none. The words are repo constants, never reader input, and
 * jobs-data-filters.test.ts pins them to [a-z ] so neither the bound use in
 * marks() nor the interpolated use in boardFacts can carry a metacharacter.
 */
export function groupTitlePattern(words: readonly string[]): string | null {
  return words.length === 0 ? null : `(${words.join('|')})`;
}

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
