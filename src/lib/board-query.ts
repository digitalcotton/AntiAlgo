/**
 * board-query.ts: the board's URL contract. Pure, so a page, a form and a test
 * all read and write the same seven parameters the same way.
 *
 * THE URL IS THE STATE (2026-09-11). The board used to ship every row and page
 * in the browser, so its page, filters and sort lived in script state and a
 * reload forgot them. Now each page is one server request, and everything a
 * reader has set is in the address: page, rows per page, the search, the
 * three facets and the sort. A bookmark, a shared link and the back button
 * all mean what they say.
 *
 * EVERY VALUE IS ALLOWLISTED HERE, so nothing downstream ever sees a facet,
 * a sort key or a page size it did not expect: an unknown value reads as the
 * default, never as an error and never as a pass-through into SQL.
 */
import { COMP_BANDS, SORT_KEYS, type SortKey } from './data';

/** 5 on arrival (the owner's call, 2026-09-11): a first page a person reads
    whole, then steps up to a hundred for scanning. */
export const PER_PAGE_OPTIONS = [5, 10, 25, 50, 100] as const;
export const DEFAULT_PER_PAGE = 5;
export const QUERY_MAX_CHARS = 120;

export const LOCATION_FACETS = ['all', 'remote', 'onsite'] as const;
export const FRESHNESS_FACETS = ['all', 'fresh', 'older', 'unknown'] as const;
export const COMP_FACETS = ['all', ...COMP_BANDS.map((band) => band.key), 'not-listed'] as const;

export type LocationFacet = (typeof LOCATION_FACETS)[number];
export type FreshnessFacet = (typeof FRESHNESS_FACETS)[number];
export type CompFacet = string;

export interface BoardQuery {
  page: number;
  per: number;
  q: string;
  location: LocationFacet;
  comp: CompFacet;
  freshness: FreshnessFacet;
  sort: SortKey;
  /**
   * The age strip's range, in whole days from the sweep, either end open
   * (null). `age_min=2&age_max=7` keeps rows aged two to seven days inclusive.
   * A row with no measurable age is outside any range that is set, because it
   * has no position on the axis to be inside of.
   */
  ageMin: number | null;
  ageMax: number | null;
  /**
   * The titles the reader picked from their own Desk list (`title=`, repeatable;
   * Filters.astro's title menu). Empty means no title narrowing. The page
   * keeps only the ones the member actually holds; the address is never
   * trusted to name a title on its own.
   */
  titles: readonly string[];
}

export const TITLES_MAX = 20;

export const DEFAULT_QUERY: Readonly<BoardQuery> = Object.freeze({
  page: 1,
  per: DEFAULT_PER_PAGE,
  q: '',
  location: 'all',
  comp: 'all',
  freshness: 'all',
  sort: 'fit',
  ageMin: null,
  ageMax: null,
  titles: []
});

/** The `title=` values from the address: trimmed, capped, de-duplicated, in order. */
export function parseTitles(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const title = raw.trim().slice(0, QUERY_MAX_CHARS);
    if (title.length === 0 || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
    if (out.length >= TITLES_MAX) break;
  }
  return out;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A day count from the address: a whole number of days up to five digits, or null. */
export function parseAgeDays(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  return Number(value);
}

/** A page number from the address: a positive integer, or 1. */
export function parsePage(value: string | null): number {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return 1;
  const page = Number(value);
  return page >= 1 ? page : 1;
}

/** The address, read through the allowlists. */
export function parseBoardQuery(params: URLSearchParams): BoardQuery {
  const perRaw = Number(params.get('per'));
  const per = (PER_PAGE_OPTIONS as readonly number[]).includes(perRaw) ? perRaw : DEFAULT_PER_PAGE;
  let ageMin = parseAgeDays(params.get('age_min'));
  let ageMax = parseAgeDays(params.get('age_max'));
  // A range written backwards is read the way round it can only have meant.
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];
  return {
    page: parsePage(params.get('page')),
    per,
    q: (params.get('q') ?? '').trim().slice(0, QUERY_MAX_CHARS),
    location: oneOf(params.get('location'), LOCATION_FACETS, 'all'),
    comp: oneOf(params.get('comp'), COMP_FACETS, 'all'),
    freshness: oneOf(params.get('freshness'), FRESHNESS_FACETS, 'all'),
    sort: oneOf(params.get('sort'), SORT_KEYS, 'fit'),
    ageMin,
    ageMax,
    titles: parseTitles(params.getAll('title'))
  };
}

/** True when the reader stated anything at all in the address. */
export function isExplicit(params: URLSearchParams): boolean {
  return params.toString() !== '';
}

const FILTER_KEYS: readonly (keyof BoardQuery)[] = ['q', 'location', 'comp', 'freshness', 'ageMin', 'ageMax', 'sort', 'per', 'titles'];

/**
 * The address for a query, with only the values that differ from the defaults
 * written out, so the bare board stays bare. Any override of a filter, the
 * sort, the size or the search drops the page: a changed question starts at
 * page one, never at page nine of a table that no longer exists.
 */
export function boardHref(base: string, query: BoardQuery, overrides: Partial<BoardQuery> = {}): string {
  const changesTheSet = FILTER_KEYS.some((key) => key in overrides);
  const next: BoardQuery = { ...query, ...overrides, page: changesTheSet ? 1 : (overrides.page ?? query.page) };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.location !== 'all') params.set('location', next.location);
  if (next.comp !== 'all') params.set('comp', next.comp);
  if (next.freshness !== 'all') params.set('freshness', next.freshness);
  // `!= null` on purpose: a query built without the range (an older caller, a
  // test fixture) reads as open at both ends, never as the string "undefined".
  if (next.ageMin != null) params.set('age_min', String(next.ageMin));
  if (next.ageMax != null) params.set('age_max', String(next.ageMax));
  if (next.sort !== 'fit') params.set('sort', next.sort);
  if (next.per !== DEFAULT_PER_PAGE) params.set('per', String(next.per));
  // Same guard as the age range: an older caller's query may carry no titles.
  for (const title of next.titles ?? []) params.append('title', title);
  if (next.page > 1) params.set('page', String(next.page));
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/**
 * The hidden inputs a GET form carries so it keeps every other setting when
 * it submits its own. Never `page`: a form that changes anything starts over.
 */
export function hiddenFields(query: BoardQuery, omit: readonly (keyof BoardQuery)[]): [string, string][] {
  const out: [string, string][] = [];
  const skip = new Set<keyof BoardQuery>([...omit, 'page']);
  if (!skip.has('q') && query.q) out.push(['q', query.q]);
  if (!skip.has('location') && query.location !== 'all') out.push(['location', query.location]);
  if (!skip.has('comp') && query.comp !== 'all') out.push(['comp', query.comp]);
  if (!skip.has('freshness') && query.freshness !== 'all') out.push(['freshness', query.freshness]);
  if (!skip.has('ageMin') && query.ageMin != null) out.push(['age_min', String(query.ageMin)]);
  if (!skip.has('ageMax') && query.ageMax != null) out.push(['age_max', String(query.ageMax)]);
  if (!skip.has('sort') && query.sort !== 'fit') out.push(['sort', query.sort]);
  if (!skip.has('per') && query.per !== DEFAULT_PER_PAGE) out.push(['per', String(query.per)]);
  if (!skip.has('titles')) for (const title of query.titles ?? []) out.push(['title', title]);
  return out;
}

/** The page that actually exists for a total, and how many there are. */
export function clampPage(page: number, total: number, per: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, per)));
  return { page: Math.min(Math.max(1, page), pages), pages };
}

/** The first and last row numbers on a page, 1 based, for the footer line. */
export function pageSpan(page: number, per: number, total: number): { first: number; last: number } {
  if (total === 0) return { first: 0, last: 0 };
  const first = (page - 1) * per + 1;
  return { first, last: Math.min(page * per, total) };
}
