/**
 * board-query.ts: the board's URL contract. Pure, so a page, a form and a test
 * all read and write the same parameters the same way.
 *
 * THE URL IS THE STATE (2026-09-11). The board used to ship every row and page
 * in the browser, so its page, filters and sort lived in script state and a
 * reload forgot them. Now each page is one server request, and everything a
 * reader has set is in the address: page, rows per page, the search, the
 * three facets and the sort. A bookmark, a shared link and the back button
 * all mean what they say.
 *
 * THE STATED FACTS (2026-10-02, docs/search-engine-design.md). The search box
 * turns what an employer actually STATED into filters, and each is a parameter
 * here: `place`, `remote`, `pay_min` and `company` (search-parse.ts
 * chipsToParams writes exactly these names). The old `location` and `comp` are
 * still READ, as the old names of `remote` and of a pay floor, so a bookmark from
 * either era means what it said; parseBoardQuery says how.
 *
 * EVERY VALUE IS ALLOWLISTED HERE, so nothing downstream ever sees a facet,
 * a sort key or a page size it did not expect: an unknown value reads as the
 * default, never as an error and never as a pass-through into SQL.
 */
import { FAMILY_IDS } from './job-family.mjs';
import { COMP_BANDS, SORT_KEYS, type SortKey } from './data';
// The pay bounds the search box clamps to, imported so the box and the address
// can never disagree about what a legal floor is.
import { PAY_MAX_K, PAY_MIN_K } from './search-parse';

/** 5 on arrival (the owner's call, 2026-09-11): a first page a person reads
    whole, then steps up to a hundred for scanning. */
export const PER_PAGE_OPTIONS = [5, 10, 25, 50, 100] as const;
export const DEFAULT_PER_PAGE = 5;
export const QUERY_MAX_CHARS = 120;

/** Where the work happens. `hybrid` and `unstated` were split out of `onsite`
    on 2026-09-28 (see facet_location in job-store.ts): hybrid was being folded
    into on-site by an explicit branch, and a row with no location at all was
    being called an office. Appending them is safe for every link already in the
    world — an address carrying `location=onsite` still reads as on-site, and
    parseBoardQuery falls back to `all` for anything it does not recognise. */
export const LOCATION_FACETS = ['all', 'remote', 'hybrid', 'onsite', 'unstated'] as const;
export const FRESHNESS_FACETS = ['all', 'fresh', 'older', 'unknown'] as const;
export const COMP_FACETS = ['all', ...COMP_BANDS.map((band) => band.key), 'not-listed'] as const;

export type LocationFacet = (typeof LOCATION_FACETS)[number];
export type FreshnessFacet = (typeof FRESHNESS_FACETS)[number];
export type CompFacet = string;

/**
 * The four answers to "where does the work happen", as the stated-facts model
 * names them (docs/search-engine-design.md). They are the LOCATION_FACETS minus
 * `all`: `all` is the absence of a choice, and a list with nothing in it says
 * that already. Spelled out as a type of its own because `remote=` takes a LIST
 * of them (`remote=remote,hybrid` is "either"), which the single-valued
 * `location=` select never could.
 *
 * search-parse.ts has a RemoteKind too, with three members: a reader can TYPE
 * remote, hybrid or on-site, but "not stated" is a state of the posting, not a
 * word anyone writes. The address is the superset, so a chip the parser makes is
 * always a legal value here.
 */
export const REMOTE_KINDS = ['remote', 'hybrid', 'onsite', 'unstated'] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

/**
 * The sorts the address accepts: the table's three, plus `best`, the order the
 * search words earn. `best` is a RANKING OF TEXT, so it only means something
 * while words are typed; see defaultSortFor for the rule that decides when it
 * is the default.
 */
export type BoardSort = SortKey | 'best';
export const BOARD_SORT_KEYS: readonly BoardSort[] = [...SORT_KEYS, 'best'];

/**
 * The sort an address means when it does not name one. Words typed: best match
 * (decision 4 in docs/search-engine-plan.md). No words: the table's own default,
 * which the owner set long before search ranked anything and which every
 * bookmark of the bare board relies on. `sort=best` with no words is not an
 * error and not a sort: it reads as this same default, because a ranking of
 * nothing has nothing to say.
 */
export function defaultSortFor(q: string): BoardSort {
  return q.trim() !== '' ? 'best' : 'fit';
}

export interface BoardQuery {
  page: number;
  per: number;
  q: string;
  /**
   * THE ARRANGEMENT, AS THE CURRENT STRIP READS IT. Kept because the Location
   * select in Filters.astro names it and facetGroupsFromCounts is handed it;
   * the value that matters is `remote` below. It mirrors it: the one kind when
   * exactly one is chosen, `all` otherwise (a two-kind choice has no single
   * value to show in a single-valued select). It is DERIVED by
   * parseBoardQuery, never read from the address on its own account: the
   * address's `location=` is only the old name for a one-item `remote=`.
   */
  location: LocationFacet;
  /**
   * The pay band as the current Comp select reads it, kept for the same reason
   * and with the same limit. `comp=<band>` and `comp=not-listed` are read into
   * it; `pay_min` is not (a floor is not a band). While this is anything but
   * `all` the store applies the band exactly, so the select's per-band counts
   * keep telling the truth until the strip moves to floors.
   */
  comp: CompFacet;
  freshness: FreshnessFacet;
  sort: BoardSort;
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
  /**
   * The occupational families the reader picked (`fam=`, repeatable). Empty
   * means every family. Unlike `titles`, these ARE trusted from the address: a
   * family is a public classification of a posting, not a fact about the
   * reader, so naming one in a URL reveals nothing and grants nothing. Unknown
   * ids are dropped rather than passed to SQL.
   */
  families: readonly string[];
  /**
   * WHERE THE POSTING IS, as a place key (`place=`): a country (`GB`), a
   * country and region (`US-MD`), or either followed by `/` and a city exactly
   * as the board spells it (`GB/London`, `US-MD/Baltimore`). Null is no place
   * chosen. Validated for shape here (parsePlaceKey) and nothing else: whether
   * a key names a place the board holds is the counts' business, and a key that
   * names nothing correctly returns nothing.
   */
  place: string | null;
  /**
   * Which arrangements to keep (`remote=remote,hybrid`), in canonical order and
   * de-duplicated. Empty is every arrangement. Read from `remote`, or, when the
   * address has none, from the old single `location=` value.
   */
  remote: readonly RemoteKind[];
  /**
   * THE PAY FLOOR, in thousands (`pay_min=150`): keep postings whose stated
   * minimum is at least $150,000. One definition across the site: the Desk
   * filters on comp_range.min >= floor and so does this (job-store.ts
   * boardFacetCte comp_min), so a number printed on one page is the number
   * the other page counts. A legacy `comp=<band>` reads as that band's lower
   * bound; `under-150` has no floor to read (it is a ceiling) and gives null.
   */
  payMin: number | null;
  /**
   * Keep only postings that state no pay (`comp=not-listed`). Exclusive with
   * `payMin`: a posting cannot both state a figure and not state one, so
   * when this is set the floor is dropped rather than letting the pair answer
   * with an empty board and no explanation.
   */
  compNotListed: boolean;
  /** The company, by its exact name on the board (`company=`). */
  company: string | null;
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
  titles: [],
  families: [],
  place: null,
  remote: [],
  payMin: null,
  compNotListed: false,
  company: null
});

/**
 * The `fam=` values from the address, kept only if they name a real family.
 *
 * An unknown id is DROPPED, not passed through and not an error. The list is a
 * closed set this repo owns (job-family.mjs), so anything else is a stale
 * bookmark or someone typing, and the honest answer to both is the board
 * without that narrowing rather than an error page or an empty result.
 * 'unplaced' is accepted as well: the rows the classifier could not place are a
 * real thing to ask for, not a hole.
 */
export function parseFamilies(values: readonly string[]): readonly string[] {
  const allowed = new Set<string>([...FAMILY_IDS, 'unplaced']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!allowed.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

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

/**
 * The `remote=` values from the address: a comma list, any number of times,
 * de-duplicated and put in canonical order. An unknown kind is dropped, never
 * repaired: `remote=remote,mars` is "remote", and `remote=mars` is the board
 * with no arrangement chosen.
 */
export function parseRemote(values: readonly string[]): RemoteKind[] {
  const seen = new Set<RemoteKind>();
  for (const value of values) {
    for (const part of String(value ?? '').split(',')) {
      const kind = REMOTE_KINDS.find((candidate) => candidate === part.trim().toLowerCase());
      if (kind !== undefined) seen.add(kind);
    }
  }
  return REMOTE_KINDS.filter((kind) => seen.has(kind));
}

/** A place key taken apart. `admin1` and `city` are null where the key stops short of them. */
export interface PlaceKey {
  country: string;
  admin1: string | null;
  city: string | null;
}

/**
 * A place key read strictly, or null.
 *
 *   GB                 a country (ISO 3166-1 alpha-2, upper case)
 *   US-MD              a country and one of its regions (1 to 3 upper case
 *                      letters or digits: MD, ON, NSW)
 *   GB/London          either of those, a slash, and a city
 *   US-MD/Baltimore    exactly as the board spells it in place_city
 *
 * The part left of the FIRST slash is the country or country and region; what
 * is right of it is the city, taken whole and case-sensitively, because it is
 * compared with place_city for equality and a "repaired" spelling would match
 * nothing. A city may itself contain a slash or a dot ("St. John's",
 * "Rio/Janeiro" would both survive); what it may not do is carry a control
 * character, run longer than 80 characters, or start or end with a space.
 *
 * Strict means a lower-case `gb`, a region with no country (`-MD`), `US-`, a
 * trailing slash and a four-letter region are all null. The caller drops a null
 * and the board runs unnarrowed: a stale bookmark is the board without that
 * narrowing, never an error and never a guess at what was meant.
 */
export function parsePlaceKey(key: string | null | undefined): PlaceKey | null {
  if (typeof key !== 'string') return null;
  const match = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?(?:\/([^\p{C}]{1,80}))?$/u.exec(key);
  if (!match) return null;
  const city = match[3] ?? null;
  // A city is a name: it starts and ends on a non-space and holds at least one
  // letter or digit ("GB//" is not a city called slash).
  if (city !== null && (city !== city.trim() || !/[\p{L}\p{N}]/u.test(city))) return null;
  return { country: match[1], admin1: match[2] ?? null, city };
}

/** A place key written back out: the inverse of parsePlaceKey. */
export function formatPlaceKey(place: PlaceKey): string {
  return `${place.country}${place.admin1 ? `-${place.admin1}` : ''}${place.city ? `/${place.city}` : ''}`;
}

/** A pay floor from the address: a whole number of thousands in the box's own bounds, or null. */
export function parsePayMin(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= PAY_MIN_K && n <= PAY_MAX_K ? n : null;
}

/** A company name from the address: trimmed, not empty, not past the search's own cap, no control characters. */
export function parseCompany(value: string | null): string | null {
  if (value === null) return null;
  const name = value.trim();
  if (name === '' || name.length > QUERY_MAX_CHARS || /\p{C}/u.test(name)) return null;
  return name;
}

/**
 * The pay band a legacy `comp=<band>` stands for, as a floor in thousands.
 * The band's lower bound IS its floor (COMP_BANDS says so), and `under-150` has
 * none worth the name: its lower bound is zero and what it asks for is a
 * ceiling, which a floor cannot say.
 */
export function payFloorOfBand(comp: string): number | null {
  const band = COMP_BANDS.find((candidate) => candidate.key === comp);
  const thousands = band ? Math.round(band.floor / 1000) : 0;
  return thousands >= PAY_MIN_K ? thousands : null;
}

/** The pay fields a legacy `comp` value means, the one place that translation is written. */
function payFromComp(comp: CompFacet): Pick<BoardQuery, 'comp' | 'payMin' | 'compNotListed'> {
  if (comp === 'not-listed') return { comp, payMin: null, compNotListed: true };
  return { comp, payMin: comp === 'all' ? null : payFloorOfBand(comp), compNotListed: false };
}

/** The arrangements an old single `location` value means. */
function remoteFromLocation(location: LocationFacet): RemoteKind[] {
  return location === 'all' ? [] : [location];
}

/** The single value the Location select can show for a list of arrangements. */
function locationOf(remote: readonly RemoteKind[]): LocationFacet {
  return remote.length === 1 ? remote[0] : 'all';
}

/**
 * The address, read through the allowlists.
 *
 * TWO GENERATIONS OF ONE QUESTION. The stated-facts search names its filters
 * `remote`, `pay_min`, `place` and `company`; the table's own controls named
 * two of them `location` and `comp` before that. Both are read, the new name
 * first, so a bookmark from either era still means what it said:
 *
 *   remote   `remote=` wins. Absent, a single arrangement in `location=` is
 *            read as a one-item list. (`location=all` and anything unknown are
 *            no choice.)
 *   pay      `comp=not-listed` wins over everything: no stated pay and a pay
 *            floor cannot both be true, so the floor is dropped. Otherwise an
 *            explicit `pay_min=` wins over a legacy band. Otherwise a band
 *            reads as its lower bound.
 *
 * Only the value that decides the pay filter is kept: an explicit floor clears
 * `comp`, so the two never disagree about what is applied.
 */
export function parseBoardQuery(params: URLSearchParams): BoardQuery {
  const perRaw = Number(params.get('per'));
  const per = (PER_PAGE_OPTIONS as readonly number[]).includes(perRaw) ? perRaw : DEFAULT_PER_PAGE;
  let ageMin = parseAgeDays(params.get('age_min'));
  let ageMax = parseAgeDays(params.get('age_max'));
  // A range written backwards is read the way round it can only have meant.
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];

  const q = (params.get('q') ?? '').trim().slice(0, QUERY_MAX_CHARS);
  const remote: RemoteKind[] = params.has('remote')
    ? parseRemote(params.getAll('remote'))
    : remoteFromLocation(oneOf(params.get('location'), LOCATION_FACETS, 'all'));

  // The last valid value of a repeated parameter wins, the rule chipsFromParams
  // applies to the same names, so the box and the table cannot read one address
  // two ways.
  let payMin: number | null = null;
  for (const value of params.getAll('pay_min')) payMin = parsePayMin(value) ?? payMin;
  let company: string | null = null;
  for (const value of params.getAll('company')) company = parseCompany(value) ?? company;
  let place: string | null = null;
  for (const value of params.getAll('place')) place = parsePlaceKey(value) ? value : place;

  // `best` ranks words, so with none typed it reads as the table's own default.
  const named = oneOf(params.get('sort'), BOARD_SORT_KEYS, defaultSortFor(q));
  const sort: BoardSort = named === 'best' && q === '' ? defaultSortFor(q) : named;

  const legacyComp = oneOf(params.get('comp'), COMP_FACETS, 'all');
  const pay =
    legacyComp === 'not-listed'
      ? payFromComp('not-listed')
      : payMin !== null
        ? { comp: 'all', payMin, compNotListed: false }
        : payFromComp(legacyComp);

  return {
    page: parsePage(params.get('page')),
    per,
    q,
    location: locationOf(remote),
    comp: pay.comp,
    freshness: oneOf(params.get('freshness'), FRESHNESS_FACETS, 'all'),
    sort,
    ageMin,
    ageMax,
    titles: parseTitles(params.getAll('title')),
    families: parseFamilies(params.getAll('fam')),
    place,
    remote,
    payMin: pay.payMin,
    compNotListed: pay.compNotListed,
    company
  };
}

/** True when the reader stated anything at all in the address. */
export function isExplicit(params: URLSearchParams): boolean {
  return params.toString() !== '';
}

const FILTER_KEYS: readonly (keyof BoardQuery)[] = [
  'q', 'location', 'comp', 'freshness', 'ageMin', 'ageMax', 'sort', 'per', 'titles', 'families',
  'place', 'remote', 'payMin', 'compNotListed', 'company'
];

/**
 * The address parameters a query writes, in the order they are written, each
 * tagged with the BoardQuery keys that OWN it. One list, read by both writers
 * below, so the link a reader follows and the hidden fields a form carries can
 * never write the same setting two ways.
 *
 * ONLY WHAT DIFFERS FROM THE DEFAULT is written, so the bare board stays bare.
 *
 * The owners matter to hiddenFields. A form that owns the Location select owns
 * `remote` too: this list writes the arrangement as `remote=`, the select
 * submits `location=`, and a form that carried the first while submitting the
 * second would be silently overruled by its own hidden field (`remote=` wins in
 * parseBoardQuery), so a change in the select would never take. The same goes
 * for the Comp select and the pay fields.
 *
 * `location` is never written (the old name for a one-item `remote`). The pay
 * filter is written by whichever generation of control set it: a band or
 * not-listed as `comp=` (the Comp select is still a band picker, and writing a
 * band as its floor would widen "$200K to $250K" into "$200K and up" on the
 * very next page), a floor as `pay_min=`. Once the strip offers floors nothing
 * sets a band and `comp=` is written only for not-listed.
 */
function writtenParams(next: BoardQuery): [string, string, readonly (keyof BoardQuery)[]][] {
  const out: [string, string, readonly (keyof BoardQuery)[]][] = [];
  if (next.q) out.push(['q', next.q, ['q']]);
  if (next.place) out.push(['place', next.place, ['place']]);
  if (next.company) out.push(['company', next.company, ['company']]);
  // `?? []` throughout: a query built without these fields (an older caller, a
  // test fixture) reads as no choice, never as the string "undefined". A query
  // built with only the old `location` (the fixtures and callers that predate
  // `remote`) is written as the one-item list it means.
  const remote = (next.remote ?? []).length > 0 ? next.remote : remoteFromLocation(next.location ?? 'all');
  if (remote.length > 0) out.push(['remote', remote.join(','), ['remote', 'location']]);
  if (next.compNotListed || next.comp === 'not-listed') out.push(['comp', 'not-listed', ['comp', 'payMin', 'compNotListed']]);
  else if (next.comp !== 'all') out.push(['comp', next.comp, ['comp', 'payMin', 'compNotListed']]);
  else if (next.payMin != null) out.push(['pay_min', String(next.payMin), ['comp', 'payMin', 'compNotListed']]);
  if (next.freshness !== 'all') out.push(['freshness', next.freshness, ['freshness']]);
  // `!= null` on purpose: a query built without the range (an older caller, a
  // test fixture) reads as open at both ends, never as the string "undefined".
  if (next.ageMin != null) out.push(['age_min', String(next.ageMin), ['ageMin']]);
  if (next.ageMax != null) out.push(['age_max', String(next.ageMax), ['ageMax']]);
  if (next.sort !== defaultSortFor(next.q) && !(next.sort === 'best' && !next.q)) out.push(['sort', next.sort, ['sort']]);
  if (next.per !== DEFAULT_PER_PAGE) out.push(['per', String(next.per), ['per']]);
  // Same guard as the age range: an older caller's query may carry no titles.
  for (const title of next.titles ?? []) out.push(['title', title, ['titles']]);
  for (const fam of next.families ?? []) out.push(['fam', fam, ['families']]);
  return out;
}

/**
 * The address for a query, with only the values that differ from the defaults
 * written out, so the bare board stays bare. Any override of a filter, the
 * sort, the size or the search drops the page: a changed question starts at
 * page one, never at page nine of a table that no longer exists.
 *
 * THREE OVERRIDES THAT MEAN MORE THAN THEY SAY, each one a caller written
 * before the field it now implies existed:
 *   - `location` overrides `remote` (Board.astro's clear link says
 *     `location: 'all'`), and `comp` overrides the floor and the not-listed
 *     flag, through the same translation parseBoardQuery applies to an address.
 *     Without this an override of the old name would be silently ignored, and
 *     "Clear the filters" would leave the arrangement on.
 *   - A new search moves the sort with it. The sort is `best` for words and the
 *     table's default for none, and a reader who has not moved it expects the
 *     default to follow them: typing into the box from the bare board must
 *     start in best-match order, not carry the old default across as an
 *     explicit `sort=fit`. A sort the reader chose (anything but the default
 *     for the OLD words) stays chosen.
 */
export function boardHref(base: string, query: BoardQuery, overrides: Partial<BoardQuery> = {}): string {
  const changesTheSet = FILTER_KEYS.some((key) => key in overrides);
  const next: BoardQuery = { ...query, ...overrides, page: changesTheSet ? 1 : (overrides.page ?? query.page) };
  if (overrides.location !== undefined && !('remote' in overrides)) next.remote = remoteFromLocation(overrides.location);
  if (overrides.comp !== undefined && !('payMin' in overrides) && !('compNotListed' in overrides)) {
    Object.assign(next, payFromComp(overrides.comp));
  }
  if ('q' in overrides && !('sort' in overrides) && query.sort === defaultSortFor(query.q)) {
    next.sort = defaultSortFor(next.q);
  }
  const params = new URLSearchParams();
  for (const [name, value] of writtenParams(next)) params.append(name, value);
  if (next.page > 1) params.set('page', String(next.page));
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/**
 * The hidden inputs a GET form carries so it keeps every other setting when
 * it submits its own. Never `page`: a form that changes anything starts over.
 * `omit` names the BoardQuery keys the form owns; a setting is dropped when any
 * of the keys that own it is named (see writtenParams).
 */
export function hiddenFields(query: BoardQuery, omit: readonly (keyof BoardQuery)[]): [string, string][] {
  const skip = new Set<keyof BoardQuery>([...omit, 'page']);
  return writtenParams(query)
    .filter(([, , owners]) => !owners.some((key) => skip.has(key)))
    .map(([name, value]) => [name, value]);
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
