/**
 * search-suggest.ts: what the search box's panel offers, and the visible redirect
 * a no-script submit gets. Everything the endpoint (src/pages/board/suggest.ts)
 * and the board page (src/pages/board.astro) decide about the reader's TEXT lives
 * here, so it can be tested without HTTP, and so the page and the endpoint can
 * never read one string two ways. The contract is "The suggest contract" in
 * docs/search-engine-plan.md.
 *
 * ONE RULE MAKES EVERY NUMBER TRUE: A COUNT IS THE TOTAL OF AN ADDRESS. Every row
 * the panel offers has an `href`, and its `count` is the total /board shows at
 * that href. So an item is never counted from a description of itself ("the
 * filters, plus this place, minus that fragment"). Its href is built first, by
 * boardHref() (the one writer of the board's address), then READ BACK through
 * parseBoardQuery() (the one reader), and that parsed query is what is counted,
 * by countBoardTotals(), which is the board's own CTE. Anything the address
 * normalises on the way (a backwards age range, a legacy `comp=` band, a title
 * the member does not hold) is therefore normalised the same way in the count,
 * because the count never saw the un-normalised version.
 *
 * WHAT TYPED TEXT MEANS. The box holds words and, mixed in, facts: `designer
 * london remote 150k`. parseSearch() reads the facts out as chips (the visible
 * parse: a no-script submit is redirected to the address that has them as
 * parameters, `canonicalSearchTarget` below) and leaves the rest as words. So
 * pressing Enter on any text lands on the filters, PLUS the chips the text
 * states, PLUS the words, and that is the `total` the panel prints: not the
 * words alone. A chip typed into the text replaces a chip of the same kind that
 * the address already had (the last stated wins, as it does inside the text).
 *
 * THE FOUR GROUPS.
 *   titles     Whole-query completions. The titles of the rows whose TITLE matches
 *              every word typed (buildSearchQuery's weight-A form, read from the
 *              small title-and-company vector, jobs.search_tc), under the
 *              filters, most rows first. Choosing one REPLACES the words with the
 *              title; the typed chips stay. Its count is the board's total for
 *              that title as the words, which is a search and so far larger than
 *              the rows that carry exactly that title.
 *   places     The last one to three typed tokens, completed by the lexicon's
 *              prefix lookup. Choosing one removes those tokens and adds the place
 *              as a chip. Its count is the board with the place REPLACED by it.
 *   companies  The same, for a company.
 *   facts      The pay, remote and age chips the text states, and the offers (a
 *              place or company the lexicon will not convert on its own, kept as
 *              words, which the reader may choose to make a chip). A stated chip
 *              is applied on Enter anyway, so its count is the `total`; an offer
 *              is counted with its words taken out and the chip put in.
 *
 * A ZERO IS RETURNED, DISABLED, AND SORTS LAST. Never dropped: a place the reader
 * typed that the filters leave empty should say so rather than vanish. At most
 * eight a group, chosen BEFORE counting (the lexicon's own ranking, by rows with
 * no filter), so a count never changes which eight are shown.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import {
  boardHref,
  hiddenFields,
  parseBoardQuery,
  parseCompany,
  parseTitles,
  QUERY_MAX_CHARS,
  type BoardQuery,
  type BoardSort,
  type RemoteKind
} from './board-query';
import { parsePlaceKey, placeKeyLabel } from './place-key';
import { buildSearchQuery, countBoardTotals, listBoardTitleCandidates, type BoardFilter, type TitleCandidate } from './job-store';
import {
  AGE_MAX_DAYS,
  AGE_MIN_DAYS,
  SEARCH_MAX_CHARS,
  chipsToParams,
  parseSearch,
  type Chip,
  type Lexicon,
  type ParseResult
} from './search-parse';
import type { BoardLexicon } from './search-lexicon';

// ---------------------------------------------------------------------------
// The contract's shapes
// ---------------------------------------------------------------------------

export type SuggestGroupType = 'titles' | 'places' | 'companies' | 'facts';

export interface SuggestItem {
  /** Stable across requests: `place:GB/London`, `company:Stripe`, `title:Product Designer`, `fact:pay:150`. */
  id: string;
  label: string;
  /** The `total` /board shows at `href`. */
  count: number;
  /** True exactly when `count` is zero. */
  disabled: boolean;
  /** What choosing it does to the text in the box. */
  apply: { chip: Chip } | { words: string };
  /** The canonical address choosing it lands on, through the route registry. */
  href: string;
}

export interface SuggestGroup {
  type: SuggestGroupType;
  label: string;
  items: SuggestItem[];
}

export interface SuggestBody {
  /** The crawl instant the counts are for. */
  v: string;
  /** The text as received, capped. */
  q: string;
  parsed: { words: string[]; chips: Chip[]; offers: ParseResult['offers'] };
  /** What pressing Enter on the text shows. */
  total: number;
  groups: SuggestGroup[];
}

/** At most this many rows a group. */
export const SUGGEST_GROUP_MAX = 8;
/** Candidate titles read, before the ones that fold to the same words are merged. */
const TITLE_CANDIDATES_READ = 12;
/**
 * Candidate places read, before the ones the reader's other filters leave empty
 * are dropped. A typed place with nothing behind it is not a choice worth a row
 * (owner, 2026-10-02: "product designer lon" listed seven dead places under London,
 * Long Prairie and Londonderry among them), so the group keeps the first eight that
 * count something, and reads three groups' worth to have eight to keep. The places
 * of one fragment share one counting statement (countBoardTotals groups them), so
 * the extra candidates are rows of a statement already made, not statements.
 * The strip's own Location list keeps its zeros: there the list is the whole
 * vocabulary, and a muted zero says the filters leave that country nothing.
 */
const PLACE_CANDIDATES_READ = 24;
/** Trailing tokens tried as a place or company name: the last one, two and three. */
export const FRAGMENT_MAX_TOKENS = 3;

const GROUP_LABELS: Record<SuggestGroupType, string> = {
  titles: 'Titles',
  places: 'Places',
  companies: 'Companies',
  facts: 'Facts'
};

// ---------------------------------------------------------------------------
// A lexicon that knows nothing
// ---------------------------------------------------------------------------

/**
 * The vocabulary of a board that cannot be read. With it parseSearch still turns
 * `150k`, `remote` and `this week` into chips (they are syntax, not vocabulary)
 * and never turns a place or a company into one. The page falls back to it when
 * the database will not answer, so a reader's no-script submit still redirects
 * the part of their text that can be read without data.
 */
export const NO_LEXICON: Lexicon = {
  place: () => null,
  company: () => null,
  isTitleTerm: () => true
};

// ---------------------------------------------------------------------------
// Text, chips and addresses
// ---------------------------------------------------------------------------

/** A straight or curly double quote, written as escapes so this file holds none. */
const QUOTE = /["\u201c\u201d]/;
const QUOTES_G = /["\u201c\u201d]/g;

/**
 * The query parameters a set of typed chips overrides, as the BoardQuery fields
 * boardHref writes them from. Built on chipsToParams, the one place a chip
 * becomes a parameter, so the names, the clamping and the last-one-wins rule are
 * the box's own.
 *
 * Each kind REPLACES what the address had. A typed pay replaces a floor and also
 * a legacy band or "not listed" (one pay filter, one answer). A typed age is a
 * window ending now, so it replaces both ends of any range. Remote kinds replace
 * the list: `remote hybrid` typed means "either", not "either, and also whatever
 * was chosen before". `location` is the old name of a one-kind list and is kept
 * in step, because boardHref reads it when the list is empty.
 */
function chipOverrides(chips: readonly Chip[]): Partial<BoardQuery> {
  const params = chipsToParams(chips);
  const over: Partial<BoardQuery> = {};
  if (params.place !== undefined) over.place = params.place;
  if (params.company !== undefined) over.company = params.company;
  if (params.remote !== undefined) {
    const kinds = params.remote.split(',') as RemoteKind[];
    over.remote = kinds;
    over.location = kinds.length === 1 ? (kinds[0] as RemoteKind) : 'all';
  }
  if (params.pay_min !== undefined) {
    over.payMin = Number(params.pay_min);
    over.comp = 'all';
    over.compNotListed = false;
  }
  if (params.age_max !== undefined) {
    over.ageMax = Number(params.age_max);
    over.ageMin = null;
  }
  return over;
}

/**
 * Words put back into one line for the address's `q`, SO THAT READING THEM AGAIN
 * FINDS THE SAME WORDS AND NO CHIPS. That is the property that makes the redirect
 * land once: the address a no-script submit is sent to must itself parse to
 * nothing the redirect would act on, or it would be sent again.
 *
 * Joining with spaces is right almost always. It is wrong in two cases, and both
 * are found by asking the parser rather than by guessing: a quoted phrase that was
 * kept whole (`"remote support"` is one word, and unquoted it is a chip and a
 * word), and words that only became neighbours because a chip between them was
 * taken out (`last remote 7 days` leaves `last 7 days`, which is an age). In
 * either case every word is quoted, since a quoted token is a wall no fact
 * spans. buildSearchQuery drops the quotes, so the search is unchanged.
 */
export function queryText(words: readonly string[], lex: Lexicon): string {
  const plain = words.join(' ');
  if (plain === '') return '';
  const again = parseSearch(plain, lex);
  if (again.chips.length === 0 && again.words.length === words.length && again.words.every((w, i) => w === words[i])) {
    return plain;
  }
  return words.map((w) => `"${w.replace(QUOTES_G, '')}"`).join(' ');
}

/**
 * Where the board should be, for these words and these chips, on top of the
 * address's own settings: the href (written by boardHref, the one writer) and
 * the query that href means (read by parseBoardQuery, the one reader). The query
 * is what gets counted; see the header.
 *
 * `base` is the address's settings. When it carries a `q` of its own (the board
 * page passes the query it just parsed) boardHref's rule for the sort applies
 * unchanged: a sort the reader did not move follows the words.
 */
export function targetFor(
  base: BoardQuery,
  words: readonly string[],
  chips: readonly Chip[],
  boardPath: string,
  lex: Lexicon
): { href: string; query: BoardQuery } {
  const href = boardHref(boardPath, base, { ...chipOverrides(chips), q: queryText(words, lex) });
  // The address is read back through the same door the board uses. The origin is
  // a placeholder: only the search string is read.
  const query = parseBoardQuery(new URL(href, 'https://board.invalid').searchParams);
  return { href, query };
}

/**
 * THE VISIBLE PARSE. The address a request for `text` should be redirected to
 * when the text states facts, or null when it does not.
 *
 * A reader without script types `designer london remote 150k` and presses Enter.
 * The form submits it as `q`. If it holds chips the board is not shown at that
 * address: the reader is sent to `?q=designer&place=GB%2FLondon&remote=remote&pay_min=150`,
 * where the facts are in the address and drawn as chips, and the words that are
 * left are in `q`. Words are never dropped. Nothing is converted silently either:
 * a place or company that is also a title word (`phoenix`, `oracle`) is not a
 * chip, so it is not redirected, it is searched as the word it is and offered.
 *
 * IT CANNOT LOOP. The target's `q` is queryText(), which parses to no chips by
 * construction, so asking again about the target's own text answers null. The
 * test pins that over a spread of inputs.
 *
 * `base` is the address the text arrived with, so every other setting survives
 * the redirect.
 */
export function canonicalSearchTarget(text: string, base: BoardQuery, lex: Lexicon, boardPath: string): string | null {
  const parse = parseSearch(text, lex);
  if (parse.chips.length === 0) return null;
  return targetFor(base, parse.words, parse.chips, boardPath, lex).href;
}

/** The trailing one to three tokens of the text, each as the fragment a place or
    company name is looked up by and the text that is left without it. */
export interface Fragment {
  tokens: number;
  fragment: string;
  /** The text with those tokens removed, whitespace collapsed. */
  rest: string;
}

/**
 * The trailing fragments of `text`, shortest first: the last token, the last two,
 * the last three. A fragment that holds a quote, or any fragment of text with an
 * unbalanced quote (the reader is part way through a phrase, which is words and
 * never a name), is not offered; and neither is one with nothing to look up
 * (punctuation).
 */
export function trailingFragments(text: string): Fragment[] {
  const clean = String(text ?? '').slice(0, SEARCH_MAX_CHARS).trim();
  if (clean === '') return [];
  const quotes = (clean.match(QUOTES_G) ?? []).length;
  if (quotes % 2 === 1) return [];
  const tokens = clean.split(/\s+/);
  const out: Fragment[] = [];
  for (let k = 1; k <= Math.min(FRAGMENT_MAX_TOKENS, tokens.length); k += 1) {
    const taken = tokens.slice(-k);
    if (taken.some((t) => QUOTE.test(t))) break;
    const fragment = taken.join(' ');
    if (!/[\p{L}\p{N}]/u.test(fragment)) continue;
    out.push({ tokens: k, fragment, rest: tokens.slice(0, tokens.length - k).join(' ') });
  }
  return out;
}

/** The text without one run of whole tokens, or null when the run is not there.
    Used to take an offered phrase out of the words it was kept in. */
function withoutSpan(text: string, span: string): string | null {
  const tokens = text.trim().split(/\s+/);
  const want = span.trim().split(/\s+/);
  for (let i = 0; i + want.length <= tokens.length; i += 1) {
    if (want.every((w, j) => tokens[i + j] === w)) {
      return [...tokens.slice(0, i), ...tokens.slice(i + want.length)].join(' ');
    }
  }
  return null;
}

/** What a stated fact reads as in the panel. */
export function factLabel(chip: Chip): string {
  switch (chip.kind) {
    case 'place':
      return chip.label;
    case 'company':
      return chip.name;
    case 'remote':
      return chip.value === 'onsite' ? 'On-site' : chip.value === 'hybrid' ? 'Hybrid' : 'Remote';
    case 'pay':
      return `$${chip.minK}k+`;
    case 'age':
      return chip.maxDays === 1 ? 'Today' : chip.maxDays === 7 ? 'This week' : `Last ${chip.maxDays} days`;
    default: {
      const exhaustive: never = chip;
      return String(exhaustive);
    }
  }
}

/** A stable id for a fact, built from what it is and never from its label. */
function chipId(prefix: string, chip: Chip): string {
  switch (chip.kind) {
    case 'place':
      return `${prefix}:place:${chip.key}`;
    case 'company':
      return `${prefix}:company:${chip.name}`;
    case 'remote':
      return `${prefix}:remote:${chip.value}`;
    case 'pay':
      return `${prefix}:pay:${chip.minK}`;
    case 'age':
      return `${prefix}:age:${chip.maxDays}`;
    default: {
      const exhaustive: never = chip;
      return String(exhaustive);
    }
  }
}

// ---------------------------------------------------------------------------
// The board's filter, from its query
// ---------------------------------------------------------------------------

/**
 * The store's filter for a query. The board page, the suggestion counts and the
 * contract test all build theirs here, so a count can differ from the table only
 * if the two disagree about what a query is, and there is one answer to that.
 *
 * `titles` is the member's watched titles the address named, already narrowed to
 * the ones they hold (a title in an address is never trusted on its own, see
 * board.astro). `sort` is the order the reader is shown, which is not always the
 * one the address names (a signed-out reader's Fit sort is served as Age).
 */
export function boardFilterFromQuery(
  query: BoardQuery,
  extra: { sweepDate: string; sort?: BoardSort; titles?: readonly string[] }
): BoardFilter {
  const titles = extra.titles ?? query.titles;
  return {
    q: query.q,
    location: query.location,
    comp: query.comp,
    freshness: query.freshness,
    remote: query.remote,
    payMin: query.payMin,
    compNotListed: query.compNotListed,
    place: query.place,
    company: query.company,
    ageMin: query.ageMin,
    ageMax: query.ageMax,
    sort: extra.sort ?? query.sort,
    page: query.page,
    perPage: query.per,
    sweepDate: extra.sweepDate,
    titles: titles.length > 0 ? [...titles] : undefined,
    families: query.families.length > 0 ? [...query.families] : undefined
  };
}

// ---------------------------------------------------------------------------
// The box's own props, from the address
// ---------------------------------------------------------------------------

/**
 * The chips the box draws for an address: the stated facts the address holds,
 * in the box's order (place, company, remote kinds, pay, age).
 *
 * A fact is drawn only when the box can also WRITE it back unchanged, because the
 * box carries each chip as a hidden field (chipsToParams) and a chip that said
 * less than the address did would change the filter on the next Enter. So: an
 * arrangement list that holds "not stated" is not a chip (a chip has no word
 * for it); a pay floor is a chip only while no legacy band or "not listed" is
 * chosen; an age is a chip only as "posted within N days", with no lower end and
 * within the 1 to 90 days a chip may say. The strip's own controls still show
 * whatever is not a chip.
 *
 * A place the lexicon does not know (a stale bookmark) is still drawn, labelled
 * by its key: a filter the reader cannot see is a filter they cannot remove.
 */
export function chipsForQuery(query: BoardQuery, lex: Pick<Lexicon, 'place'> | null): Chip[] {
  const chips: Chip[] = [];
  if (query.place !== null) {
    const known = lex?.place(query.place) ?? null;
    chips.push({ kind: 'place', key: query.place, label: known?.label ?? placeKeyLabel(query.place) });
  }
  if (query.company !== null) chips.push({ kind: 'company', name: query.company });
  const kinds = query.remote.filter((kind): kind is Exclude<RemoteKind, 'unstated'> => kind !== 'unstated');
  if (kinds.length > 0 && kinds.length === query.remote.length) {
    for (const value of kinds) chips.push({ kind: 'remote', value });
  }
  if (query.payMin !== null && query.comp === 'all' && !query.compNotListed) {
    chips.push({ kind: 'pay', minK: query.payMin });
  }
  if (query.ageMax !== null && query.ageMin === null && query.ageMax >= AGE_MIN_DAYS && query.ageMax <= AGE_MAX_DAYS) {
    chips.push({ kind: 'age', maxDays: query.ageMax });
  }
  return chips;
}

/** The address that removes ONE of those chips and nothing else: the board as it
    is, with that fact let go (and the page back at one, which boardHref does). */
export function chipRemoveHrefs(query: BoardQuery, chips: readonly Chip[], boardPath: string): string[] {
  return chips.map((chip) => {
    switch (chip.kind) {
      case 'place':
        return boardHref(boardPath, query, { place: null });
      case 'company':
        return boardHref(boardPath, query, { company: null });
      case 'remote': {
        const left = query.remote.filter((kind) => kind !== chip.value);
        return boardHref(boardPath, query, { remote: left, location: left.length === 1 ? (left[0] as RemoteKind) : 'all' });
      }
      case 'pay':
        return boardHref(boardPath, query, { payMin: null, comp: 'all', compNotListed: false });
      case 'age':
        return boardHref(boardPath, query, { ageMax: null });
      default: {
        const exhaustive: never = chip;
        return String(exhaustive);
      }
    }
  });
}

/** How a parameter that can hold several values travels in ONE value, which is all
    the box's request can carry (it sets each name once). Family ids never hold a
    comma. A title can, so titles are joined by a line break, which a title never
    holds. The endpoint reads both this form and the repeated one. */
export const SUGGEST_LIST_JOIN: Readonly<Record<'fam' | 'title', string>> = { fam: ',', title: '\n' };

/**
 * The board's current parameters minus the words and the page, as the one value
 * per name the box sends with every request (`data-suggest-params`). Written by
 * hiddenFields, the same list the strip's own form carries, so the endpoint is
 * asked about exactly the filters the table is showing.
 *
 * `query.titles` should already be the titles the member holds: a title the
 * address names and the member does not hold narrows nothing on the board and
 * must not narrow the counts.
 */
export function suggestBaseParams(query: BoardQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of hiddenFields(query, ['q'])) {
    const join = name === 'fam' || name === 'title' ? SUGGEST_LIST_JOIN[name] : null;
    out[name] = join !== null && name in out ? `${out[name]}${join}${value}` : value;
  }
  return out;
}

/**
 * The address's filters, as the endpoint reads them from the request: every
 * parameter the board reads, the words and the cache key left out, the two
 * list parameters accepted in both forms (repeated, or joined as above).
 * `titles` is the titles the member holds; whatever the address names is read
 * only to know whether the answer depends on who is asking.
 */
export function suggestBaseQuery(params: URLSearchParams): { query: BoardQuery; namedTitles: readonly string[] } {
  const own = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === 'q' || name === 'v' || name === 'page') continue;
    if (name === 'fam') for (const part of value.split(SUGGEST_LIST_JOIN.fam)) own.append(name, part);
    else if (name === 'title') for (const part of value.split(SUGGEST_LIST_JOIN.title)) own.append(name, part);
    else own.append(name, value);
  }
  return { query: parseBoardQuery(own), namedTitles: parseTitles(own.getAll('title')) };
}

/**
 * The Cache-Control for an answer. When the request's `v` is the crawl instant
 * the counts are for, the answer is a pure function of the address (the counts
 * only move when the crawl loads, and a new crawl is a new `v`, hence a new
 * address), so it may sit in a shared cache for the day. Anything else, a stale
 * page asking for an older crawl or a request that sent no `v`, is answered for
 * the current crawl and kept by nobody. An answer that depends on WHO asked (the
 * member's titles narrow the counts) is never shared.
 */
export function suggestCacheControl(requestV: string, currentV: string, dependsOnViewer: boolean): string {
  if (dependsOnViewer) return 'private, no-store';
  if (currentV !== '' && requestV === currentV) return 'public, max-age=60, s-maxage=86400, stale-while-revalidate=600';
  return 'no-store';
}

// ---------------------------------------------------------------------------
// What a crawl makes permanent
// ---------------------------------------------------------------------------

/**
 * A count is a function of the crawl, the filters and the words, and nothing
 * else: the rows change once a night, when a new crawl loads and `v` moves. So a
 * count already taken for this `v` is the count, for every reader, and is kept
 * for as long as this process lives. It is the same fact the endpoint's
 * `s-maxage=86400` states about a whole answer; this keeps it one level down,
 * where a different text reaches the same title or the same place. Typing
 * `des` and `desig` ask for different answers and for many of the same counts
 * (the board's own popular titles recur in every prefix that leads to them), and
 * a prefix like `des` was the expensive kind of count, because the index named
 * 17,000 rows and a vector was read out of every one to check the weights. A
 * prefix is matched in the small vector now (db/221), so a miss costs a few
 * milliseconds, and the memo is what makes the keystroke after it free.
 *
 * KEYED BY EVERYTHING THAT CHANGES A COUNT: `v`, and the whole filter except the
 * page, the page size and the sort (which no total depends on). A change of `v`
 * empties it, a process with no `v` (the board has no crawl stamp) keeps nothing,
 * and it is bounded: past MEMO_MAX entries it is emptied rather than trimmed,
 * because a miss costs one statement and a cleverer eviction costs a bug.
 * Nothing is kept for a call that failed.
 */
const MEMO_MAX = 4000;
let memoV: string | null = null;
const countMemo = new Map<string, number>();
const titleMemo = new Map<string, TitleCandidate[]>();

/** Forget what has been kept. For a test; nothing on the site calls it. */
export function forgetSuggestMemo(): void {
  memoV = null;
  countMemo.clear();
  titleMemo.clear();
}

function memoKey(filter: BoardFilter): string {
  const { page: _page, perPage: _perPage, sort: _sort, ...counted } = filter;
  return JSON.stringify(counted);
}

/** Is there a crawl to key the memo on? If so, the memo is for it: a different `v`
    from the one it holds empties it first. */
function keptFor(v: string): boolean {
  if (v === '') return false;
  if (memoV !== v || countMemo.size + titleMemo.size > MEMO_MAX) {
    countMemo.clear();
    titleMemo.clear();
    memoV = v;
  }
  return true;
}

/** countBoardTotals, asking only for the filters not already counted for this crawl. */
async function countKept(v: string, filters: readonly BoardFilter[]): Promise<number[]> {
  if (!keptFor(v)) return countBoardTotals(filters);
  const keys = filters.map(memoKey);
  const out: Array<number | undefined> = keys.map((key) => countMemo.get(key));
  const missing = out.map((n, at) => (n === undefined ? at : -1)).filter((at) => at >= 0);
  if (missing.length > 0) {
    const fresh = await countBoardTotals(missing.map((at) => filters[at] as BoardFilter));
    missing.forEach((at, n) => {
      out[at] = fresh[n] ?? 0;
    });
    // A new crawl may have loaded while this was counting. What was counted
    // belongs to the one it started under, and is not kept under the new.
    if (memoV === v) missing.forEach((at) => countMemo.set(keys[at] as string, out[at] as number));
  }
  return out as number[];
}

async function titlesKept(v: string, filter: BoardFilter, limit: number): Promise<TitleCandidate[]> {
  if (!keptFor(v)) return listBoardTitleCandidates(filter, limit);
  const key = `${limit}|${memoKey(filter)}`;
  const held = titleMemo.get(key);
  if (held !== undefined) return held;
  const fresh = await listBoardTitleCandidates(filter, limit);
  if (memoV === v) titleMemo.set(key, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface SuggestInput {
  /** The text being typed. */
  text: string;
  /** The address's filters (suggestBaseQuery), with `titles` the member's held ones. */
  base: BoardQuery;
  lex: BoardLexicon;
  /** The board's path, from routeFor('board'). */
  boardPath: string;
  sweepDate: string;
  /** The crawl instant, echoed back. */
  v: string;
}

interface Planned {
  group: SuggestGroupType;
  id: string;
  label: string;
  apply: SuggestItem['apply'];
  href: string;
  /** Which round of counting it is in, and its index in that round's filters. */
  stage: 1 | 2;
  at: number;
}

/**
 * The panel's answer for a piece of text: four groups, each row counted as the
 * board counts it. See the header for what each group is.
 *
 * THE ROUNDS. The text and its facts are read first (no database). Then, at the
 * same time, the titles are read (one statement) and everything that does not
 * depend on them is counted: the total, the places, the companies and the offers.
 * The titles' own counts are a second round, because only now are the titles
 * known. Each round is countBoardTotals, which makes one statement per distinct
 * words and runs them side by side (see job-store.ts), so a panel is two rounds
 * of the slowest count in each and not thirty counts one after another. A count
 * already taken for this crawl is not taken again (the memo above).
 */
export async function suggest(input: SuggestInput): Promise<SuggestBody> {
  const { base, lex, boardPath, sweepDate } = input;
  const text = String(input.text ?? '').slice(0, SEARCH_MAX_CHARS);
  const parse = parseSearch(text, lex);

  const filterOf = (query: BoardQuery): BoardFilter => boardFilterFromQuery(query, { sweepDate });
  const aim = (words: readonly string[], chips: readonly Chip[]) => targetFor(base, words, chips, boardPath, lex);

  // What pressing Enter shows. Every count below is a total of its own address;
  // this is the first of them and the one `total` reports.
  const cur = aim(parse.words, parse.chips);
  const first: BoardFilter[] = [filterOf(cur.query)];
  const second: BoardFilter[] = [];
  const planned: Planned[] = [];
  const plan = (p: Omit<Planned, 'at' | 'stage'>, query: BoardQuery, stage: 1 | 2 = 1): void => {
    const into = stage === 1 ? first : second;
    into.push(filterOf(query));
    planned.push({ ...p, stage, at: into.length - 1 });
  };

  // The titles are read at the same time as everything else is counted, and are
  // the one thing the second round waits on. With no words there is nothing to
  // complete.
  const titlesRead =
    parse.words.length > 0 ? titlesKept(input.v, filterOf(cur.query), TITLE_CANDIDATES_READ) : Promise.resolve([]);

  // Places and companies: the trailing fragments, longest first so a longer
  // typed name wins a candidate both a long and a short fragment find.
  const fragments = trailingFragments(text).reverse();
  const seen = new Set<string>();
  let places = 0;
  for (const f of fragments) {
    const rest = parseSearch(f.rest, lex);
    for (const hit of lex.placesByPrefix(f.fragment, PLACE_CANDIDATES_READ)) {
      // A key the board would not read, as one it would, is not offered: its href
      // would show the board with no place, under a label that says London.
      if (places >= PLACE_CANDIDATES_READ || seen.has(`place:${hit.key}`) || parsePlaceKey(hit.key) === null) continue;
      seen.add(`place:${hit.key}`);
      places += 1;
      const chip: Chip = { kind: 'place', key: hit.key, label: hit.label };
      const t = aim(rest.words, [...rest.chips, chip]);
      plan({ group: 'places', id: `place:${hit.key}`, label: hit.label, apply: { chip }, href: t.href }, t.query);
    }
  }
  let companies = 0;
  for (const f of fragments) {
    const rest = parseSearch(f.rest, lex);
    for (const hit of lex.companiesByPrefix(f.fragment, SUGGEST_GROUP_MAX)) {
      // Likewise a name the board would refuse (over its cap, or with a control character in it).
      if (companies >= SUGGEST_GROUP_MAX || seen.has(`company:${hit.name}`) || parseCompany(hit.name) !== hit.name) continue;
      seen.add(`company:${hit.name}`);
      companies += 1;
      const chip: Chip = { kind: 'company', name: hit.name };
      const t = aim(rest.words, [...rest.chips, chip]);
      plan({ group: 'companies', id: `company:${hit.name}`, label: hit.label, apply: { chip }, href: t.href }, t.query);
    }
  }

  // Facts. A chip the text states is applied on Enter, so choosing it lands where
  // Enter does: it is `cur`, counted once, and listed so the reader sees what
  // their text means. An offer is a different board (its words out, its chip in).
  const stated: Array<{ chip: Chip }> = parse.chips
    .filter((chip) => chip.kind === 'pay' || chip.kind === 'remote' || chip.kind === 'age')
    .map((chip) => ({ chip }));
  if (!QUOTE.test(text)) {
    for (const offer of parse.offers) {
      const left = withoutSpan(text, offer.span);
      if (left === null) continue;
      const rest = parseSearch(left, lex);
      const t = aim(rest.words, [...rest.chips, offer.chip]);
      plan(
        { group: 'facts', id: chipId('offer', offer.chip), label: factLabel(offer.chip), apply: { chip: offer.chip }, href: t.href },
        t.query
      );
    }
  }

  const [firstTotals, titleRows] = await Promise.all([countKept(input.v, first), titlesRead]);

  // Titles: the candidates, folded together where their words are the same, and
  // counted in a second round because only now are they known.
  const titleSeen = new Set<string>();
  let titles = 0;
  for (const candidate of titleRows) {
    if (titles >= SUGGEST_GROUP_MAX) break;
    const sq = buildSearchQuery(candidate.title);
    // A title the address would cut (the board reads 120 characters of `q`) is not
    // offered: its count would be the count of some other, shorter, phrase.
    if (sq === null || titleSeen.has(sq.all) || candidate.title.length > QUERY_MAX_CHARS) continue;
    titleSeen.add(sq.all);
    titles += 1;
    const t = aim([candidate.title], parse.chips);
    plan(
      { group: 'titles', id: `title:${candidate.title}`, label: candidate.title, apply: { words: candidate.title }, href: t.href },
      t.query,
      2
    );
  }
  const secondTotals = second.length > 0 ? await countKept(input.v, second) : [];

  const total = firstTotals[0] ?? 0;
  const countOf = (p: Planned): number => ((p.stage === 1 ? firstTotals : secondTotals)[p.at] ?? 0);
  const item = (p: Pick<Planned, 'id' | 'label' | 'apply' | 'href'>, count: number): SuggestItem => ({
    id: p.id,
    label: p.label,
    count,
    disabled: count === 0,
    apply: p.apply,
    href: p.href
  });
  const itemsOf = (group: SuggestGroupType): SuggestItem[] => {
    const rows =
      group === 'facts'
        ? [
            ...stated.map(({ chip }) => item({ id: chipId('fact', chip), label: factLabel(chip), apply: { chip }, href: cur.href }, total)),
            ...planned.filter((p) => p.group === 'facts').map((p) => item(p, countOf(p)))
          ]
        : planned.filter((p) => p.group === group).map((p) => item(p, countOf(p)));
    // A place that counts nothing is not listed (PLACE_CANDIDATES_READ says why).
    if (group === 'places') return rows.filter((r) => !r.disabled).slice(0, SUGGEST_GROUP_MAX);
    // Elsewhere rows that count something first, the order within each kept.
    return [...rows.filter((r) => !r.disabled), ...rows.filter((r) => r.disabled)].slice(0, SUGGEST_GROUP_MAX);
  };

  return {
    v: input.v,
    q: text,
    parsed: { words: parse.words, chips: parse.chips, offers: parse.offers },
    total,
    groups: (['titles', 'places', 'companies', 'facts'] as const).map((type) => ({ type, label: GROUP_LABELS[type], items: itemsOf(type) }))
  };
}
