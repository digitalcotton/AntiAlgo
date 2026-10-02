/**
 * search-suggest.test.ts: the search box's suggestions and the visible parse.
 *
 * TWO HALVES. The first needs no database and always runs: the redirect a no-script
 * submit gets (canonicalSearchTarget), the words put back into an address
 * (queryText), the fragments a place or company is looked up by, the box's chips
 * and the address that removes each, the one-value-a-name form the box sends the
 * board's settings in, and the cache header. They run against a small lexicon
 * written out below, so a number here is arithmetic that can be read.
 *
 * The second reads the local board and is the contract's proof. Without a
 * connection string it skips rather than passing, so a green run on a machine with
 * no database cannot be mistaken for one (the rule job-store.db.test.ts states).
 * It checks the shape of the answer, and then the owner's hardest requirement:
 *
 *   EVERY COUNT EQUALS THE ROWS ITS ROW RETURNS. For 50 seeded random pairs of
 *   (text being typed, filters set), plus a list of cases that each broke
 *   something while this was built, every item of every group has a `count` that
 *   equals the `total` the BOARD returns at that item's address (the store's own
 *   listBoardFiltered, the same call board.astro makes), and the answer's `total`
 *   equals what the board shows for the text as typed, redirect and all. The board
 *   is never asked through the code under test: the oracle parses the address with
 *   parseBoardQuery and counts it with listBoardFiltered, and decides for itself
 *   whether the page would redirect. Zero tolerance.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseBoardQuery, type BoardQuery } from './board-query';
import { sweepDate } from './data';
import { boardRowsLoadedAt, buildSearchQuery, countBoardTotals, getBoardStats, listBoardFiltered, listBoardTitleCandidates, type BoardFilter } from './job-store';
import { placeKeyLabel } from './place-key';
import { buildLexicon, getLexicon, type BoardLexicon, type LexiconRows } from './search-lexicon';
import { chipsToParams, parseSearch, type Chip } from './search-parse';
import {
  NO_LEXICON,
  SUGGEST_GROUP_MAX,
  boardFilterFromQuery,
  canonicalSearchTarget,
  chipRemoveHrefs,
  chipsForQuery,
  factLabel,
  forgetSuggestMemo,
  queryText,
  suggest,
  suggestBaseParams,
  suggestBaseQuery,
  suggestCacheControl,
  trailingFragments,
  type SuggestBody,
  type SuggestItem
} from './search-suggest';
import { db } from './db';
import { routeFor } from '../data/nav';
import { GET } from '../pages/board/suggest';

const BOARD = routeFor('board');
const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const dbDescribe = HAVE_DB ? describe : describe.skip;

// ---------------------------------------------------------------------------
// A small board, written out
// ---------------------------------------------------------------------------

/**
 *   london     a place that is not a title word                     -> a chip
 *   berlin     the same, in another country, for the typeahead
 *   new york   a place whose first word is common in titles          -> a chip
 *   phoenix    a place the board uses as a title word more than as a place -> an offer
 *   stripe     a company that is not a title word                    -> a chip
 *   oracle     a company the board uses as a title word               -> an offer
 */
const FIXTURE: LexiconRows = {
  places: [
    { country: 'GB', admin1: null, city: 'London', label: 'London, United Kingdom', rows: 676 },
    { country: 'GB', admin1: null, city: null, label: 'United Kingdom', rows: 400 },
    { country: 'DE', admin1: null, city: 'Berlin', label: 'Berlin, Germany', rows: 420 },
    { country: 'US', admin1: 'NY', city: 'New York', label: 'New York, NY', rows: 848 },
    { country: 'US', admin1: 'AZ', city: 'Phoenix', label: 'Phoenix, AZ', rows: 5 }
  ],
  companies: [
    { company: 'Stripe', rows: 300 },
    { company: 'Oracle', rows: 10 }
  ],
  titles: [
    { title: 'Senior Designer', rows: 100 },
    { title: 'Phoenix Engineer', rows: 40 },
    { title: 'Oracle DBA', rows: 40 },
    { title: 'Product Designer', rows: 60 },
    { title: 'Support Engineer', rows: 30 }
  ]
};

let lex: BoardLexicon;
beforeAll(() => {
  lex = buildLexicon(FIXTURE, '2026-09-26T07:33:10.000Z');
});

const baseOf = (search = ''): BoardQuery => suggestBaseQuery(new URLSearchParams(search)).query;
const paramsOf = (href: string): URLSearchParams => new URL(href, 'https://board.invalid').searchParams;
const queryOf = (href: string): BoardQuery => parseBoardQuery(paramsOf(href));

// ---------------------------------------------------------------------------
// The visible parse
// ---------------------------------------------------------------------------

describe('canonicalSearchTarget: what a no-script submit is sent to', () => {
  it('turns the facts in the text into parameters and keeps every word', () => {
    const target = canonicalSearchTarget('designer london remote 150k', baseOf(), lex, BOARD);
    expect(target).toBe(`${BOARD}?q=designer&place=GB%2FLondon&remote=remote&pay_min=150`);
  });

  it('keeps the words the facts were taken from between, in order', () => {
    const target = canonicalSearchTarget('senior remote designer', baseOf(), lex, BOARD) as string;
    expect(paramsOf(target).get('q')).toBe('senior designer');
    expect(paramsOf(target).get('remote')).toBe('remote');
  });

  it('turns a company into a chip too, and several remote kinds into one list', () => {
    const target = canonicalSearchTarget('stripe remote hybrid designer', baseOf(), lex, BOARD) as string;
    const q = queryOf(target);
    expect(q.company).toBe('Stripe');
    expect(q.remote).toEqual(['remote', 'hybrid']);
    expect(q.q).toBe('designer');
  });

  it('answers null, and redirects nothing, when the text states no fact', () => {
    for (const text of ['designer', '', '   ', 'senior engineer in test', 'product designer', '"remote support"', '3d artist', '401k administrator']) {
      expect(canonicalSearchTarget(text, baseOf(), lex, BOARD), JSON.stringify(text)).toBeNull();
    }
  });

  it('never converts a place or company that is also a title word: it stays words, and is offered', () => {
    for (const text of ['phoenix', 'oracle', 'phoenix engineer', 'oracle dba']) {
      expect(canonicalSearchTarget(text, baseOf(), lex, BOARD), text).toBeNull();
    }
    expect(parseSearch('phoenix', lex).offers).toHaveLength(1);
    expect(parseSearch('oracle dba', lex).offers).toHaveLength(1);
  });

  it('keeps every other setting the address had', () => {
    const base = baseOf('per=50&sort=age&fam=design&fam=software&freshness=fresh&title=Product+Designer');
    const target = canonicalSearchTarget('london designer', base, lex, BOARD) as string;
    const q = queryOf(target);
    expect(q.per).toBe(50);
    expect(q.sort).toBe('age');
    expect(q.families).toEqual(['design', 'software']);
    expect(q.freshness).toBe('fresh');
    expect(q.titles).toEqual(['Product Designer']);
    expect(q.place).toBe('GB/London');
    expect(q.q).toBe('designer');
  });

  it('lets the text replace a fact of the same kind the address had, and only that kind', () => {
    // One arrangement list: typed `remote` replaces a chosen `hybrid`.
    expect(queryOf(canonicalSearchTarget('remote designer', baseOf('remote=hybrid&place=DE%2FBerlin'), lex, BOARD) as string)).toMatchObject({
      remote: ['remote'],
      place: 'DE/Berlin'
    });
    // One pay filter: a typed floor replaces a legacy band, and "not listed".
    expect(queryOf(canonicalSearchTarget('200k designer', baseOf('comp=150-200'), lex, BOARD) as string)).toMatchObject({ payMin: 200, comp: 'all' });
    expect(queryOf(canonicalSearchTarget('200k designer', baseOf('comp=not-listed'), lex, BOARD) as string)).toMatchObject({ payMin: 200, compNotListed: false });
    // A typed age is a window ending now: it replaces both ends of a range.
    const aged = queryOf(canonicalSearchTarget('today designer', baseOf('age_min=3&age_max=10'), lex, BOARD) as string);
    expect(aged.ageMax).toBe(1);
    expect(aged.ageMin).toBeNull();
  });

  it('follows the board for the sort: words move it to best match, a sort the reader chose stays', () => {
    expect(paramsOf(canonicalSearchTarget('remote designer', baseOf(), lex, BOARD) as string).has('sort')).toBe(false);
    expect(queryOf(canonicalSearchTarget('remote designer', baseOf(), lex, BOARD) as string).sort).toBe('best');
    expect(paramsOf(canonicalSearchTarget('remote designer', baseOf('sort=comp'), lex, BOARD) as string).get('sort')).toBe('comp');
  });

  it('keeps a quoted phrase whole, and quotes words that a taken-out fact left next to each other', () => {
    const quoted = canonicalSearchTarget('"remote support" london', baseOf(), lex, BOARD) as string;
    expect(paramsOf(quoted).get('q')).toBe('"remote support"');
    expect(queryOf(quoted).place).toBe('GB/London');
    // `last remote 7 days` leaves `last 7 days`, which on its own is an age.
    const joined = canonicalSearchTarget('last remote 7 days', baseOf(), lex, BOARD) as string;
    expect(paramsOf(joined).get('q')).toBe('"last" "7" "days"');
    expect(paramsOf(joined).get('remote')).toBe('remote');
    expect(paramsOf(joined).has('age_max')).toBe(false);
  });

  it('cannot loop: the address it sends to is never sent anywhere again, over a spread of inputs', () => {
    const inputs = [
      'designer london remote 150k', 'london', 'remote', '150k', 'today', 'this week', 'hybrid designer', 'remote hybrid onsite', 'on site london',
      'designer, london; remote', 'last remote 7 days', 'past remote 2 weeks designer', 'remote remote remote', '150k 200k', 'london berlin remote', 'stripe remote',
      '"remote" designer', '"150k" london', 'designer "last" remote "7" days', 'new york remote 100-150k', 'senior engineer over 150k', 'engineer under 150k',
      'remote 24 hours', 'phoenix remote', 'oracle 150k', 'a b c remote d e', '$150,000 london', '150k+ remote', 'remote, remote', 'LONDON REMOTE', 'london  remote   designer'
    ];
    for (const text of inputs) {
      const base = baseOf('per=25');
      const target = canonicalSearchTarget(text, base, lex, BOARD);
      if (target === null) continue;
      const again = queryOf(target);
      // Asked again about the address's own q, with the address's own settings.
      expect(canonicalSearchTarget(again.q, again, lex, BOARD), `${JSON.stringify(text)} -> ${target}`).toBeNull();
      // And the words that were left are the words the reader typed.
      expect(parseSearch(again.q, lex).words, text).toEqual(parseSearch(text, lex).words);
      expect(parseSearch(again.q, lex).chips, text).toEqual([]);
    }
  });

  it('reads the text uncapped, to the parser\'s own 200 characters, and no further', () => {
    const filler = 'engineer '.repeat(14); // 126 characters, past the 120 the board keeps of q
    const target = canonicalSearchTarget(`${filler}london`, baseOf(), lex, BOARD) as string;
    expect(queryOf(target).place).toBe('GB/London');
    const past = canonicalSearchTarget(`${'engineer '.repeat(23)}london`, baseOf(), lex, BOARD); // london at character 207
    expect(past).toBeNull();
  });

  it('still reads syntax facts with no vocabulary at all, and never a place', () => {
    const target = canonicalSearchTarget('designer london remote 150k', baseOf(), NO_LEXICON, BOARD) as string;
    const q = queryOf(target);
    expect(q.place).toBeNull();
    expect(q.remote).toEqual(['remote']);
    expect(q.payMin).toBe(150);
    expect(q.q).toBe('designer london');
  });
});

describe('queryText: words put back into an address', () => {
  it('joins with spaces when reading them again gives the same words and no chips', () => {
    expect(queryText(['senior', 'designer'], lex)).toBe('senior designer');
    expect(queryText([], lex)).toBe('');
    expect(queryText(['phoenix', 'engineer'], lex)).toBe('phoenix engineer');
  });

  it('quotes every word when joining them would state a fact, or change the words', () => {
    expect(queryText(['remote support'], lex)).toBe('"remote support"');
    expect(queryText(['senior designer'], lex)).toBe('"senior designer"'); // a quoted phrase stays one word
    expect(queryText(['last', '7', 'days'], lex)).toBe('"last" "7" "days"');
    expect(queryText(['150k'], lex)).toBe('"150k"');
  });
});

describe('trailingFragments: what a place or a company is looked up by', () => {
  it('offers the last one, two and three tokens, with the text left over', () => {
    expect(trailingFragments('senior designer lon')).toEqual([
      { tokens: 1, fragment: 'lon', rest: 'senior designer' },
      { tokens: 2, fragment: 'designer lon', rest: 'senior' },
      { tokens: 3, fragment: 'senior designer lon', rest: '' }
    ]);
    expect(trailingFragments('lon')).toEqual([{ tokens: 1, fragment: 'lon', rest: '' }]);
    expect(trailingFragments('  new   yo ')).toEqual([
      { tokens: 1, fragment: 'yo', rest: 'new' },
      { tokens: 2, fragment: 'new yo', rest: '' }
    ]);
  });

  it('offers nothing for empty text or a phrase still being typed in quotes', () => {
    expect(trailingFragments('')).toEqual([]);
    expect(trailingFragments('   ')).toEqual([]);
    expect(trailingFragments('"remote supp')).toEqual([]);
  });

  it('stops at a token with a quote in it, and skips one with nothing to look up', () => {
    // A closed phrase before the fragment is fine; a fragment that reaches into it is not.
    expect(trailingFragments('"remote support" lon')).toEqual([{ tokens: 1, fragment: 'lon', rest: '"remote support"' }]);
    // A lone symbol has nothing to look up, but the two tokens it ends can be.
    expect(trailingFragments('designer &')).toEqual([{ tokens: 2, fragment: 'designer &', rest: '' }]);
    expect(trailingFragments('&')).toEqual([]);
  });

  it('never reads past the parser\'s limit', () => {
    const long = `${'a'.repeat(250)} lon`;
    expect(trailingFragments(long).every((f) => f.fragment.length <= 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The box's props
// ---------------------------------------------------------------------------

describe('chipsForQuery and chipRemoveHrefs: the facts an address holds, and the way to let each go', () => {
  const address = 'q=designer&place=GB%2FLondon&company=Stripe&remote=remote,hybrid&pay_min=150&age_max=7&per=25&fam=design';

  it('draws every stated fact in the box\'s order, labelled by the vocabulary', () => {
    const query = baseOf(address);
    expect(chipsForQuery(query, lex)).toEqual([
      { kind: 'place', key: 'GB/London', label: 'London, United Kingdom' },
      { kind: 'company', name: 'Stripe' },
      { kind: 'remote', value: 'remote' },
      { kind: 'remote', value: 'hybrid' },
      { kind: 'pay', minK: 150 },
      { kind: 'age', maxDays: 7 }
    ]);
  });

  it('writes back, through chipsToParams, exactly the parameters the address had', () => {
    const query = baseOf(address);
    expect(chipsToParams(chipsForQuery(query, lex))).toEqual({
      place: 'GB/London',
      company: 'Stripe',
      remote: 'remote,hybrid',
      pay_min: '150',
      age_max: '7'
    });
  });

  it('each remove address lets go of that one fact and keeps everything else', () => {
    const query = baseOf(address);
    const chips = chipsForQuery(query, lex);
    const hrefs = chipRemoveHrefs(query, chips, BOARD);
    expect(hrefs).toHaveLength(chips.length);
    chips.forEach((chip, at) => {
      const after = queryOf(hrefs[at] as string);
      expect(after.per, factLabel(chip)).toBe(25);
      expect(after.families, factLabel(chip)).toEqual(['design']);
      expect(after.place, factLabel(chip)).toBe(chip.kind === 'place' ? null : 'GB/London');
      expect(after.company, factLabel(chip)).toBe(chip.kind === 'company' ? null : 'Stripe');
      expect(after.payMin, factLabel(chip)).toBe(chip.kind === 'pay' ? null : 150);
      expect(after.ageMax, factLabel(chip)).toBe(chip.kind === 'age' ? null : 7);
      const kinds = chip.kind === 'remote' ? ['remote', 'hybrid'].filter((k) => k !== chip.value) : ['remote', 'hybrid'];
      expect(after.remote, factLabel(chip)).toEqual(kinds);
    });
  });

  it('removes the last remote kind cleanly, with no `remote=` left behind', () => {
    const query = baseOf('remote=remote&place=GB%2FLondon');
    const [place, remote] = chipsForQuery(query, lex);
    expect(place?.kind).toBe('place');
    const href = chipRemoveHrefs(query, [remote as Chip], BOARD)[0] as string;
    expect(paramsOf(href).has('remote')).toBe(false);
    expect(paramsOf(href).has('location')).toBe(false);
    expect(paramsOf(href).get('place')).toBe('GB/London');
  });

  it('draws only what it can write back unchanged', () => {
    // A legacy band is read as the floor it starts at (board-query.ts payFromComp), and a chip says exactly that.
    expect(chipsForQuery(baseOf('comp=150-200'), lex)).toEqual([{ kind: 'pay', minK: 150 }]);
    // "Not listed" is the Comp control's own, and a chip has no word for it.
    expect(chipsForQuery(baseOf('comp=not-listed'), lex)).toEqual([]);
    expect(chipsForQuery(baseOf('pay_min=not-listed'), lex)).toEqual([]);
    // An arrangement that includes "not stated" has no word for a chip to say.
    expect(chipsForQuery(baseOf('remote=remote,unstated'), lex)).toEqual([]);
    // An age range with a lower end is the strip's, and past 90 days is not a window a chip may say.
    expect(chipsForQuery(baseOf('age_min=2&age_max=7'), lex)).toEqual([]);
    expect(chipsForQuery(baseOf('age_max=120'), lex)).toEqual([]);
    expect(chipsForQuery(baseOf('age_max=90'), lex)).toEqual([{ kind: 'age', maxDays: 90 }]);
  });

  it('draws a place the vocabulary does not know, labelled by its key: a filter the reader cannot see cannot be removed', () => {
    const chips = chipsForQuery(baseOf('place=FR%2FParis'), lex);
    expect(chips).toEqual([{ kind: 'place', key: 'FR/Paris', label: placeKeyLabel('FR/Paris') }]);
    expect(chipsForQuery(baseOf('place=GB%2FLondon'), null)).toEqual([{ kind: 'place', key: 'GB/London', label: 'London, United Kingdom' }]);
  });
});

describe('suggestBaseParams and suggestBaseQuery: the settings, one value a name, there and back', () => {
  it('writes every setting but the words and the page, joining the two list parameters', () => {
    const titles = ['Product Designer', 'Software Engineer, Backend'];
    const query = { ...baseOf('q=x&page=3&per=50&sort=age&place=GB%2FLondon&fam=design&fam=software&remote=remote&pay_min=100'), titles };
    expect(suggestBaseParams(query)).toEqual({
      place: 'GB/London',
      remote: 'remote',
      pay_min: '100',
      sort: 'age',
      per: '50',
      title: 'Product Designer\nSoftware Engineer, Backend',
      fam: 'design,software'
    });
  });

  it('reads that form back to the same settings, and the repeated form as well', () => {
    const titles = ['Product Designer', 'Software Engineer, Backend'];
    const query = { ...baseOf('per=50&sort=age&place=GB%2FLondon&fam=design&fam=software&remote=remote&pay_min=100&age_max=7'), titles };
    const joined = suggestBaseQuery(new URLSearchParams(suggestBaseParams(query)));
    const repeated = new URLSearchParams('per=50&sort=age&place=GB%2FLondon&fam=design&fam=software&remote=remote&pay_min=100&age_max=7&title=Product+Designer');
    repeated.append('title', 'Software Engineer, Backend');
    expect(joined.query).toEqual({ ...query, titles });
    expect(joined.namedTitles).toEqual(titles);
    expect(suggestBaseQuery(repeated).query).toEqual({ ...query, titles });
  });

  it('drops the words, the cache key and the page, and reads the rest the board\'s way', () => {
    const { query } = suggestBaseQuery(new URLSearchParams('q=anything&v=2026&page=9&pay_min=0&remote=mars&place=gb&fam=nonsense'));
    expect(query.q).toBe('');
    expect(query.page).toBe(1);
    expect(query.payMin).toBeNull();
    expect(query.remote).toEqual([]);
    expect(query.place).toBeNull();
    expect(query.families).toEqual([]);
  });
});

describe('suggestCacheControl', () => {
  const NOW = '2026-09-26T07:33:10.000Z';
  it('shares an answer for the crawl it is for, and keeps no other', () => {
    expect(suggestCacheControl(NOW, NOW, false)).toBe('public, max-age=60, s-maxage=86400, stale-while-revalidate=600');
    expect(suggestCacheControl('2026-09-25T07:00:00.000Z', NOW, false)).toBe('no-store');
    expect(suggestCacheControl('', NOW, false)).toBe('no-store');
    expect(suggestCacheControl('', '', false)).toBe('no-store'); // no crawl stamp: nothing to key a shared copy on
  });

  it('never shares an answer that depends on who asked', () => {
    expect(suggestCacheControl(NOW, NOW, true)).toBe('private, no-store');
  });
});

describe('boardFilterFromQuery: the store\'s filter for a query', () => {
  it('carries every field the board passes, leaves out an empty list, and takes the served sort', () => {
    const query = parseBoardQuery(new URLSearchParams('place=GB%2FLondon&company=Stripe&remote=remote,hybrid&pay_min=150&age_min=1&age_max=9&freshness=fresh&fam=design&per=25&page=2'));
    expect(boardFilterFromQuery(query, { sweepDate: '2026-09-26', sort: 'age', titles: [] })).toEqual({
      q: '',
      location: 'all',
      comp: 'all',
      freshness: 'fresh',
      remote: ['remote', 'hybrid'],
      payMin: 150,
      compNotListed: false,
      place: 'GB/London',
      company: 'Stripe',
      ageMin: 1,
      ageMax: 9,
      sort: 'age',
      page: 2,
      perPage: 25,
      sweepDate: '2026-09-26',
      titles: undefined,
      families: ['design']
    });
  });

  it('is the filter board.astro asks the store for', () => {
    const page = readFileSync(new URL('../pages/board.astro', import.meta.url), 'utf8');
    // The shared function builds it; the one thing the page adds is whether the reader can see Deets
    // (which only an ordering reads), as a spread over it, never a second reading of the address.
    expect(page).toContain('listBoardFiltered({ ...boardFilterFromQuery(');
  });
});

// ---------------------------------------------------------------------------
// Against the board
// ---------------------------------------------------------------------------

/** A seeded generator, so a failing case names itself and can be replayed. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T };
}

dbDescribe('the suggestions, against the local board', () => {
  let board: BoardLexicon;
  let v = '';
  const SWEEP = sweepDate();

  beforeAll(async () => {
    const stamp = boardRowsLoadedAt(await getBoardStats());
    v = stamp ?? '';
    board = await getLexicon(stamp);
    forgetSuggestMemo();
  }, 120_000);

  const ask = (text: string, search = ''): Promise<SuggestBody> =>
    suggest({ text, base: baseOf(search), lex: board, boardPath: BOARD, sweepDate: SWEEP, v });

  /** What the BOARD shows at an address: the address read by the board's reader and
      counted by the store, with nothing from the code under test in between. */
  async function boardTotalAt(href: string): Promise<number> {
    const query = queryOf(href);
    return (await listBoardFiltered(boardFilterFromQuery(query, { sweepDate: SWEEP }))).total;
  }

  /** What the board shows for text typed into the box and submitted: the page's own
      decision about a redirect (it asks the parser, and follows what it is told),
      then the total at wherever that lands. */
  async function boardTotalForTyped(text: string, search: string): Promise<number> {
    const params = new URLSearchParams(search);
    params.set('q', text);
    const parsed = parseBoardQuery(params);
    const target = canonicalSearchTarget(text.trim(), parsed, board, BOARD);
    return boardTotalAt(target ?? `${BOARD}?${params.toString()}`);
  }

  describe('the shape of the answer', () => {
    it('is the contract: four groups in order, each with at most eight items of the contract\'s fields', async () => {
      for (const text of ['des', 'product des', 'lon', 'ama', '150k', 'designer london remote 150k', 'phoenix', 'new yo', 'nurse mar']) {
        const body = await ask(text);
        expect(Object.keys(body).sort(), text).toEqual(['groups', 'parsed', 'q', 'total', 'v']);
        expect(body.v).toBe(v);
        expect(body.q).toBe(text);
        expect(typeof body.total).toBe('number');
        expect(body.groups.map((g) => g.type), text).toEqual(['titles', 'places', 'companies', 'facts']);
        expect(body.groups.map((g) => g.label), text).toEqual(['Titles', 'Places', 'Companies', 'Facts']);
        for (const group of body.groups) {
          expect(group.items.length, `${text} ${group.type}`).toBeLessThanOrEqual(SUGGEST_GROUP_MAX);
          expect(new Set(group.items.map((i) => i.id)).size, `${text} ${group.type} ids`).toBe(group.items.length);
          for (const item of group.items) {
            expect(Object.keys(item).sort()).toEqual(['apply', 'count', 'disabled', 'href', 'id', 'label']);
            expect(Number.isInteger(item.count) && item.count >= 0, `${item.id} count`).toBe(true);
            expect(item.disabled, item.id).toBe(item.count === 0);
            expect(item.href.startsWith(`${BOARD}?`) || item.href === BOARD, item.href).toBe(true);
            expect(item.label, item.id).not.toBe('');
          }
        }
        const read = parseSearch(text, board);
        expect(body.parsed).toEqual({ words: read.words, chips: read.chips, offers: read.offers });
      }
    });

    it('returns an empty group empty, never missing', async () => {
      const body = await ask('150k');
      expect(body.groups.map((g) => g.items.length)).toEqual([0, 0, 0, 1]);
      expect(body.parsed.chips).toEqual([{ kind: 'pay', minK: 150 }]);
      const none = await ask('xqzvwkrt');
      expect(none.groups).toHaveLength(4);
      expect(none.total).toBe(0);
    });

    it('returns a place that counts zero, disabled and after the ones that count, never dropped', async () => {
      const body = await ask('nurse mar');
      const places = body.groups[1]?.items ?? [];
      expect(places.length).toBeGreaterThan(1);
      expect(places.some((p) => p.count > 0)).toBe(true);
      const zeros = places.filter((p) => p.disabled);
      expect(zeros.length).toBeGreaterThan(0);
      expect(zeros.every((p) => p.count === 0)).toBe(true);
      // The enabled rows come first.
      const firstZero = places.findIndex((p) => p.disabled);
      expect(places.slice(firstZero).every((p) => p.disabled)).toBe(true);
    });

    it('counts a title as the board counts it when it becomes the words, which is a search and not the rows that carry it', async () => {
      const body = await ask('software eng');
      const titles = body.groups[0]?.items ?? [];
      expect(titles.length).toBeGreaterThan(3);
      let wider = 0;
      for (const item of titles) {
        const { rows } = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'live' AND title = $1`, [item.label]);
        expect(item.count, item.label).toBeGreaterThanOrEqual(rows[0]?.n ?? 0);
        if (item.count > (rows[0]?.n ?? 0)) wider += 1;
        expect('words' in item.apply && item.apply.words === item.label, item.label).toBe(true);
        expect((await db().query(`SELECT 1 FROM jobs WHERE title = $1 LIMIT 1`, [item.label])).rows.length, item.label).toBe(1);
      }
      expect(wider).toBeGreaterThan(0);
    });

    it('offers a place as a chip that removes the fragment, and a company the same', async () => {
      const body = await ask('designer lon');
      const london = (body.groups[1]?.items ?? []).find((i) => i.id === 'place:GB/London');
      expect(london).toBeTruthy();
      expect(london?.apply).toEqual({ chip: { kind: 'place', key: 'GB/London', label: 'London, United Kingdom' } });
      const q = queryOf(london?.href as string);
      expect(q.place).toBe('GB/London');
      expect(q.q).toBe('designer');
      const amazon = (await ask('ama')).groups[2]?.items.find((i) => i.label === 'Amazon');
      expect(amazon?.apply).toEqual({ chip: { kind: 'company', name: 'Amazon' } });
      expect(queryOf(amazon?.href as string).company).toBe('Amazon');
    });

    it('lists the facts the text states and the offers it holds, each counted', async () => {
      const stated = await ask('designer remote 150k');
      const facts = stated.groups[3]?.items ?? [];
      expect(facts.map((f) => f.label).sort()).toEqual(['$150k+', 'Remote']);
      // A stated fact is applied on Enter, so it counts what Enter shows.
      expect(facts.every((f) => f.count === stated.total)).toBe(true);
      const offered = await ask('phoenix');
      // `phoenix` is a place on this board and a title word as well: if it is offered, its count is the place's.
      for (const item of offered.groups[3]?.items ?? []) {
        expect('chip' in item.apply).toBe(true);
        expect(item.count).toBe(await boardTotalAt(item.href));
      }
    });
  });

  describe('the two reads the counts are built on', () => {
    const BASE: BoardFilter = { q: '', location: 'all', comp: 'all', freshness: 'all', sort: 'fit', page: 1, perPage: 1, sweepDate: SWEEP, ageMin: null, ageMax: null };

    it('countBoardTotals answers listBoardFiltered\'s total for each filter, and shares a statement among filters that share words', async () => {
      const filters: BoardFilter[] = [
        { ...BASE, q: 'designer' },
        { ...BASE, q: 'designer', place: 'GB/London' },
        { ...BASE, q: 'designer', place: 'US' },
        { ...BASE, q: 'designer', company: 'Stripe' },
        { ...BASE, q: 'engineer' },
        { ...BASE, q: '', place: 'GB/London' },
        { ...BASE, q: '', place: 'US-NY' },
        { ...BASE, q: '', company: 'Amazon' },
        { ...BASE, q: '!!!' },
        { ...BASE, q: 'designer', remote: ['remote'] },
        { ...BASE, q: 'desginer' }
      ];
      // A statement that carries words runs on its own connection, in its own transaction (job-store.ts
      // runStatement), so it is seen through connect() and not through the pool's query().
      // (pg's own pool.query calls this.connect(callback), so only the promise form is wrapped.)
      type Client = { query: (sql: string, params?: unknown[]) => Promise<unknown>; release: () => void };
      const pool = db() as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown>; connect: (...args: unknown[]) => Promise<Client> };
      const original = pool.query.bind(pool);
      const originalConnect = pool.connect.bind(pool);
      const sent: string[] = [];
      pool.query = (sql: string, params?: unknown[]) => {
        sent.push(sql);
        return original(sql, params);
      };
      pool.connect = (...args: unknown[]) =>
        args.length > 0
          ? originalConnect(...args)
          : originalConnect().then((client) => ({
              query: (sql: string, params?: unknown[]) => {
                sent.push(sql);
                return client.query(sql, params);
              },
              release: () => client.release()
            }));
      let totals: number[];
      try {
        totals = await countBoardTotals(filters);
      } finally {
        pool.query = original;
        pool.connect = originalConnect;
      }
      for (const [at, f] of filters.entries()) {
        expect(totals[at], JSON.stringify([f.q, f.place, f.company, f.remote])).toBe((await listBoardFiltered(f)).total);
      }
      expect(totals[8]).toBe(0); // text with no word in it matches nothing
      // Two signatures (the arrangement differs for one filter); the first signature has three distinct
      // texts (designer, engineer, none) so three statements, the second one, and the typo path adds its own.
      const counting = sent.filter((sql) => /AS t0\b/.test(sql));
      expect(counting.length).toBe(5);
      expect(sent.some((sql) => /EXISTS \(SELECT 1 FROM matched/.test(sql))).toBe(true);
    }, 60_000);

    it('listBoardTitleCandidates names the titles the words complete, folded, most rows first', async () => {
      const found = await listBoardTitleCandidates({ ...BASE, q: 'product des' }, 12);
      expect(found.length).toBeGreaterThan(3);
      expect(found.length).toBeLessThanOrEqual(12);
      const folded = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (const c of found) {
        // Every word typed begins some word of the title.
        const words = folded(c.title);
        expect(words.some((w) => w.startsWith('product')), c.title).toBe(true);
        expect(words.some((w) => w.startsWith('des')), c.title).toBe(true);
      }
      for (let i = 1; i < found.length; i += 1) expect((found[i - 1] as { rows: number }).rows).toBeGreaterThanOrEqual((found[i] as { rows: number }).rows);
      // `rows` is the rows that carry that title among the ones whose title matches.
      const sq = buildSearchQuery('product des');
      const top = found[0] as { title: string; rows: number };
      const { rows } = await db().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs
          WHERE status = 'live' AND search @@ to_tsquery('simple', $1)
            AND btrim(regexp_replace(lower(f_unaccent(title)), '[^[:alnum:]]+', ' ', 'g')) = btrim(regexp_replace(lower(f_unaccent($2::text)), '[^[:alnum:]]+', ' ', 'g'))`,
        [sq?.a, top.title]
      );
      expect(rows[0]?.n).toBe(top.rows);
      // No words, or nothing searchable in them, completes to nothing.
      expect(await listBoardTitleCandidates({ ...BASE, q: '' }, 12)).toEqual([]);
      expect(await listBoardTitleCandidates({ ...BASE, q: '!!!' }, 12)).toEqual([]);
    }, 60_000);

    it('applies the filters to the candidates: only titles with a row in the place, and none where there is no such place', async () => {
      const open = await listBoardTitleCandidates({ ...BASE, q: 'designer' }, 12);
      const london = await listBoardTitleCandidates({ ...BASE, q: 'designer', place: 'GB/London' }, 12);
      const nowhere = await listBoardTitleCandidates({ ...BASE, q: 'designer', place: 'GB/Nowhereville' }, 12);
      expect(london.length).toBeGreaterThan(0);
      expect(london.map((c) => c.title)).not.toEqual(open.map((c) => c.title));
      for (const c of london) {
        const { rows } = await db().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM jobs WHERE status = 'live' AND title = $1 AND place_country = 'GB' AND place_city = 'London'`,
          [c.title]
        );
        expect(rows[0]?.n, c.title).toBeGreaterThan(0);
      }
      expect(nowhere).toEqual([]);
    }, 60_000);
  });

  describe('the endpoint: GET /board/suggest', () => {
    const SUGGEST = routeFor('board-suggest');
    afterEach(() => vi.restoreAllMocks());

    /** Call the route's own handler the way Astro does, with the parts of the context it reads. */
    async function get(search: string, viewer: unknown = null): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
      const response = await GET({ url: new URL(`https://antialgo.test${SUGGEST}?${search}`), locals: { viewer } } as never);
      return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
    }

    it('is registered, beside /board/[slug] and never under /api', () => {
      expect(SUGGEST).toBe('/board/suggest');
      expect(SUGGEST.startsWith('/api')).toBe(false);
    });

    it('answers the contract, shared for a day when the request names the current crawl', async () => {
      const res = await get(`q=des&v=${encodeURIComponent(v)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=86400, stale-while-revalidate=600');
      expect(res.body.v).toBe(v);
      expect(res.body.q).toBe('des');
      expect((res.body.groups as Array<{ type: string }>).map((g) => g.type)).toEqual(['titles', 'places', 'companies', 'facts']);
      expect(res.body.total).toBe((await ask('des')).total);
    });

    it('answers for the current crawl and keeps nothing when the request names another, or none', async () => {
      for (const asked of ['v=2020-01-01T00%3A00%3A00.000Z', '', 'v=']) {
        const res = await get(`q=des&${asked}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control'), asked).toBe('no-store');
        expect(res.body.v, asked).toBe(v);
      }
    });

    it('truncates text past 200 characters instead of refusing it, and parses the part it keeps', async () => {
      const long = `${'engineer '.repeat(30)}london`;
      const res = await get(`q=${encodeURIComponent(long)}`);
      expect(res.status).toBe(200);
      expect((res.body.q as string).length).toBe(200);
      const none = await get('');
      expect(none.status).toBe(200);
      expect(none.body.q).toBe('');
    });

    it('reads the filters the board\'s way: the two list parameters in either form, a value the board ignores ignored', async () => {
      const joined = await get('q=des&fam=design,software&pay_min=100');
      const repeated = await get('q=des&fam=design&fam=software&pay_min=100');
      expect(joined.body).toEqual(repeated.body);
      expect(joined.body.total).toBe((await ask('des', 'fam=design&fam=software&pay_min=100')).total);
      const junk = await get('q=des&pay_min=0&remote=mars&place=gb&fam=nonsense&page=9&per=7');
      expect(junk.body.total).toBe((await ask('des')).total);
    });

    it('never shares an answer that depends on the session, and counts without titles a signed-out reader does not hold', async () => {
      const titled = await get(`q=des&title=${encodeURIComponent('Product Designer')}&v=${encodeURIComponent(v)}`);
      expect(titled.status).toBe(200);
      expect(titled.headers.get('Cache-Control')).toBe('private, no-store');
      expect(titled.body.total).toBe((await ask('des')).total);
    });

    it('answers 500 with a JSON error and no cache when the store will not answer, and does not say why', async () => {
      const pool = db() as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      vi.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await get(`q=des&v=${encodeURIComponent(v)}`);
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.body).toEqual({ error: 'Suggestions are unavailable.' });
    });
  });

  describe('the board page: the visible parse and what the box is handed', () => {
    const SUGGEST = routeFor('board-suggest');
    /** The page rendered in process, with the board in the local database and no server and no browser. */
    let render: (search: string) => Promise<{ status: number; location: string | null; html: string }>;
    beforeAll(async () => {
      const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
      const { default: BoardPage } = await import('../pages/board.astro');
      const container = await AstroContainer.create();
      render = async (search) => {
        const response = await container.renderToResponse(BoardPage, { request: new Request(`https://antialgo.test${BOARD}?${search}`), locals: { viewer: null } as never });
        return { status: response.status, location: response.headers.get('location'), html: response.status === 200 ? await response.text() : '' };
      };
    }, 120_000);

    it('sends text that states facts to the address that holds them, with every word kept', async () => {
      const res = await render('q=designer+london+remote+150k');
      expect(res.status).toBe(302);
      expect(res.location).toBe(`${BOARD}?q=designer&place=GB%2FLondon&remote=remote&pay_min=150`);
      // And that address is the board, not another redirect.
      const landed = await render(new URL(res.location as string, 'https://antialgo.test').searchParams.toString());
      expect(landed.status).toBe(200);
    }, 60_000);

    it('keeps the other settings across the redirect, and reads the text past the 120 characters the board keeps of q', async () => {
      const res = await render(`per=50&sort=age&fam=design&q=${encodeURIComponent(`${'engineer '.repeat(14)}london`)}`);
      expect(res.status).toBe(302);
      const q = queryOf(res.location as string);
      expect(q).toMatchObject({ per: 50, sort: 'age', families: ['design'], place: 'GB/London' });
    }, 60_000);

    it('searches a field name as words and sends the reader nowhere', async () => {
      for (const text of ['Healthcare & Medicine', 'Customer Support & Success', 'design', 'senior engineer in test']) {
        const res = await render(`q=${encodeURIComponent(text)}`);
        expect(res.status, text).toBe(200);
        expect(res.html, text).toContain(`value="${text.replace(/&/g, '&#38;')}"`);
      }
    }, 120_000);

    it('hands the box the chips the address holds, the address that removes each, and what its suggestions need', async () => {
      const res = await render('place=GB%2FLondon&company=Stripe&remote=remote,hybrid&pay_min=150&age_max=7&q=designer&per=25&fam=design');
      expect(res.status).toBe(200);
      const html = res.html;
      expect([...html.matchAll(/data-chip-kind="(\w+)"/g)].map((m) => m[1])).toEqual(['place', 'company', 'remote', 'remote', 'pay', 'age']);
      expect(html).toContain('London, United Kingdom');
      const unescape = (text: string) => text.replace(/&#38;/g, '&').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
      const removes = [...html.matchAll(/class="sb-chip-x[^"]*" href="([^"]*)"/g)].map((m) => queryOf(unescape(m[1] as string)));
      expect(removes).toHaveLength(6);
      expect(removes[0]).toMatchObject({ place: null, company: 'Stripe', payMin: 150, q: 'designer', per: 25, families: ['design'] });
      expect(removes[4]).toMatchObject({ place: 'GB/London', payMin: null, ageMax: 7 });
      expect(html).toContain(`data-suggest-path="${SUGGEST}"`);
      expect(html).toContain(`data-suggest-v="${v}"`);
      const params = JSON.parse(unescape(html.match(/data-suggest-params="([^"]*)"/)?.[1] ?? '{}')) as Record<string, string>;
      expect(params).toEqual({ place: 'GB/London', company: 'Stripe', remote: 'remote,hybrid', pay_min: '150', age_max: '7', per: '25', fam: 'design' });
      // The box sends exactly this, and the endpoint reads it as the address the page was drawn for.
      const asked = suggestBaseQuery(new URLSearchParams(params)).query;
      expect(asked).toMatchObject({ place: 'GB/London', company: 'Stripe', remote: ['remote', 'hybrid'], payMin: 150, ageMax: 7, per: 25, families: ['design'] });
    }, 60_000);

    it('draws no chips and sends the box the bare settings on the bare board', async () => {
      const res = await render('');
      expect(res.status).toBe(200);
      expect(res.html).not.toContain('data-chip-kind');
      expect(res.html).toContain(`data-suggest-path="${SUGGEST}"`);
      expect(res.html).toContain('data-suggest-params="{}"');
    }, 60_000);

  });

  describe('the memo keeps nothing that changes the answer', () => {
    it('answers the same from the memo as from the store, and the same again after it is emptied', async () => {
      forgetSuggestMemo();
      const cold = await ask('product des', 'remote=remote');
      const warm = await ask('product des', 'remote=remote');
      forgetSuggestMemo();
      const again = await ask('product des', 'remote=remote');
      expect(warm).toEqual(cold);
      expect(again).toEqual(cold);
    }, 60_000);

    it('keys a count by the filter: the same words under another filter are another count', async () => {
      forgetSuggestMemo();
      const open = await ask('engineer');
      const remote = await ask('engineer', 'remote=remote');
      expect(remote.total).toBeLessThan(open.total);
      expect(remote.total).toBe(await boardTotalForTyped('engineer', 'remote=remote'));
      expect(open.total).toBe(await boardTotalForTyped('engineer', ''));
    }, 60_000);
  });

  describe('THE INVARIANT: every count is the rows its row returns', () => {
    /** What a run of checks covered, so a green run says how much it looked at. */
    interface Tally {
      items: number;
      disabled: number;
      byGroup: Record<string, number>;
    }
    const emptyTally = (): Tally => ({ items: 0, disabled: 0, byGroup: {} });
    const add = (into: Tally, from: Tally): void => {
      into.items += from.items;
      into.disabled += from.disabled;
      for (const [group, n] of Object.entries(from.byGroup)) into.byGroup[group] = (into.byGroup[group] ?? 0) + n;
    };

    /** Every item of an answer, checked against the board. */
    async function check(label: string, text: string, search: string, memo: boolean): Promise<Tally> {
      if (!memo) forgetSuggestMemo();
      const body = await ask(text, search);
      expect(body.total, `${label}: total for ${JSON.stringify(text)} with ${search}`).toBe(await boardTotalForTyped(text, search));

      const items: Array<{ group: string; item: SuggestItem }> = body.groups.flatMap((g) => g.items.map((item) => ({ group: g.type, item })));
      const tally = emptyTally();
      // A few at a time: each is one count on the board.
      for (let at = 0; at < items.length; at += 5) {
        await Promise.all(
          items.slice(at, at + 5).map(async ({ group, item }) => {
            const where = `${label}: ${group} "${item.label}" (${item.id}) for ${JSON.stringify(text)} with ${search}`;
            expect(item.count, where).toBe(await boardTotalAt(item.href));
            expect(item.disabled, where).toBe(item.count === 0);
            // The address is canonical: the page would not send the reader anywhere else.
            const landed = queryOf(item.href);
            expect(canonicalSearchTarget(landed.q, landed, board, BOARD), `${where}: address is not canonical`).toBeNull();
            // And the address does what the row says.
            if ('chip' in item.apply) {
              const chip = item.apply.chip;
              if (chip.kind === 'place') expect(landed.place, where).toBe(chip.key);
              if (chip.kind === 'company') expect(landed.company, where).toBe(chip.name);
              if (chip.kind === 'pay') expect(landed.payMin, where).toBe(chip.minK);
              if (chip.kind === 'age') expect(landed.ageMax, where).toBe(chip.maxDays);
              if (chip.kind === 'remote') expect(landed.remote, where).toContain(chip.value);
            } else {
              const words = buildSearchQuery(landed.q);
              expect(words?.all, where).toBe(buildSearchQuery(item.apply.words)?.all);
            }
            tally.items += 1;
            if (item.disabled) tally.disabled += 1;
            tally.byGroup[group] = (tally.byGroup[group] ?? 0) + 1;
          })
        );
      }
      return tally;
    }

    it('holds for cases that each broke something while this was built', { timeout: 600_000 }, async () => {
      const cases: Array<[string, string]> = [
        ['des', ''], ['product des', ''], ['nurse mar', ''], ['engineer ber', ''], ['lon', ''], ['ama', ''], ['150k', ''], ['remote nu', ''],
        ['designer london remote 150k', ''], ['phoenix', ''], ['oracle', ''], ['new yo', ''], ['"remote support"', ''], ['last remote 7 days', ''],
        // Typo path: the words match nothing exactly, so the board counts close spellings, and so must a row.
        ['desginer', ''], ['desginer lon', ''], ['marketng man', ''], ['xqzvw rkt', ''],
        // Offers: a place or company the board uses as a word more than as a name is kept as words and offered.
        ['mobile developer', ''], ['senior mobile engineer remote', ''], ['float', ''], ['mobile developer', 'place=GB'],
        // Filters that act on every count.
        ['des', 'remote=remote'], ['engineer', 'pay_min=150'], ['lon', 'fam=design'], ['des', 'place=GB%2FLondon'], ['ama', 'age_max=30'],
        ['des', 'comp=not-listed'], ['des', 'comp=150-200'], ['des', 'remote=remote,hybrid&pay_min=100&fam=software'], ['sales', 'company=Amazon'],
        ['', 'remote=remote'], ['london', 'per=50&sort=age'], ['senior eng', 'age_min=2&age_max=20'], ['designer', 'location=remote']
      ];
      const tally = emptyTally();
      for (const [text, search] of cases) add(tally, await check('fixed', text, search, false));
      expect(tally.items).toBeGreaterThan(200);
      expect(tally.disabled).toBeGreaterThan(20);
      for (const group of ['titles', 'places', 'companies', 'facts']) expect(tally.byGroup[group] ?? 0, group).toBeGreaterThan(0);
      console.info(`search-suggest invariant, fixed: ${cases.length} cases, ${tally.items} items (${tally.disabled} disabled) ${JSON.stringify(tally.byGroup)}, 0 mismatches.`);
    });

    it('offers a place the board uses as a word, as a fact with its words taken out and the chip put in', async () => {
      const body = await ask('mobile developer');
      expect(body.parsed.chips).toEqual([]);
      expect(body.parsed.offers.map((o) => o.chip.kind)).toEqual(['place']);
      const offer = (body.groups[3]?.items ?? []).find((i) => i.id.startsWith('offer:place:'));
      expect(offer, 'the offer is in the facts group').toBeTruthy();
      expect(queryOf(offer?.href as string)).toMatchObject({ q: 'developer', place: (offer?.apply as { chip: { key: string } }).chip.key });
      expect(offer?.count).toBe(await boardTotalAt(offer?.href as string));
      // The words stay words on Enter: nothing was converted.
      expect(canonicalSearchTarget('mobile developer', baseOf(), board, BOARD)).toBeNull();
    }, 60_000);

    it('reaches the typo path, where the board counts close spellings, and agrees with it there', { timeout: 120_000 }, async () => {
      let fuzzy = 0;
      for (const text of ['desginer', 'desginer lon', 'marketng man', 'prodct designr']) {
        const shown = queryOf(`${BOARD}?q=${encodeURIComponent(text)}`);
        const page = await listBoardFiltered(boardFilterFromQuery(shown, { sweepDate: SWEEP }));
        if (page.fuzzy) fuzzy += 1;
        const body = await ask(text);
        expect(body.total, text).toBe(page.total);
        for (const group of body.groups) {
          for (const item of group.items) expect(item.count, `${text}: ${item.id}`).toBe(await boardTotalAt(item.href));
        }
      }
      // Not a test of the board's spelling, only of this one: that it was the typo path being compared.
      expect(fuzzy).toBeGreaterThanOrEqual(3);
    });

    it('holds for 50 seeded random pairs of text and filters, cold and then from the memo', { timeout: 1_800_000 }, async () => {
      const rnd = seeded(20261002);
      const sample = async (sqlText: string): Promise<string[]> => (await db().query(sqlText)).rows.map((r) => String(Object.values(r)[0]));
      const titles = await sample(`SELECT title FROM jobs WHERE status = 'live' ORDER BY md5(id || 'inv-title') LIMIT 400`);
      const companies = await sample(`SELECT company FROM jobs WHERE status = 'live' ORDER BY md5(id || 'inv-company') LIMIT 200`);
      const cities = await sample(`SELECT place_city FROM jobs WHERE status = 'live' AND place_city IS NOT NULL ORDER BY md5(id || 'inv-city') LIMIT 200`);
      const cut = (word: string, lo: number, hi: number): string => word.slice(0, Math.min(word.length, lo + rnd.int(hi - lo + 1)));
      const words = (title: string): string[] => title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

      const fragment = (): string => {
        const title = words(rnd.pick(titles));
        const first = title[0] ?? 'engineer';
        switch (rnd.int(10)) {
          case 0: return cut(first, 2, 5);
          case 1: return `${first} ${cut(title[1] ?? 'manager', 2, 5)}`;
          case 2: return cut(rnd.pick(companies), 2, 4);
          case 3: return cut(rnd.pick(cities), 2, 4);
          case 4: return `${first} ${cut(rnd.pick(cities), 2, 4)}`;
          case 5: return `${first} remote`;
          case 6: return `${rnd.pick(['150k', 'remote', 'hybrid', 'today', 'this week', '100-200k'])} ${cut(first, 3, 5)}`;
          case 7: return title.slice(0, 3).join(' ');
          case 8: return first.length >= 6 ? first.slice(0, 2) + first.slice(3) : first; // one letter out: a typo
          default: return `${title.slice(0, 2).join(' ')} ${cut(rnd.pick(cities), 3, 4)} ${rnd.pick(['', 'remote', '150k'])}`.trim();
        }
      };
      // At most two filters a case. Stacked, five filters leave nothing on a board of this size and the
      // case would check a wall of zeros, which agree with the board but prove little.
      const options: Array<() => string> = [
        () => `remote=${rnd.pick(['remote', 'remote,hybrid', 'onsite', 'hybrid'])}`,
        () => `pay_min=${rnd.pick([50, 100, 150, 200])}`,
        () => `place=${encodeURIComponent(rnd.pick(['GB/London', 'US', 'GB', 'DE', 'CA', 'US-NY/New York', 'US-CA']))}`,
        () => `company=${encodeURIComponent(rnd.pick(companies))}`,
        () => `fam=${rnd.pick(['software', 'design', 'sales', 'health', 'data-ai'])}`,
        () => `age_max=${rnd.pick([7, 30, 90])}`,
        () => `age_min=${rnd.pick([1, 3])}&age_max=${rnd.pick([10, 45])}`,
        () => 'freshness=fresh',
        () => `comp=${rnd.pick(['not-listed', '150-200', '200-250'])}`,
        () => `per=${rnd.pick([25, 50])}&sort=${rnd.pick(['age', 'comp'])}`
      ];
      const filters = (): string => {
        const parts: string[] = [];
        for (let k = rnd.pick([0, 0, 1, 1, 2]); k > 0; k -= 1) parts.push(rnd.pick(options)());
        return parts.join('&');
      };

      const tally = emptyTally();
      let cases = 0;
      for (let i = 0; i < 50; i += 1) {
        const text = fragment();
        const search = filters();
        add(tally, await check(`random ${i}`, text, search, false));
        // The same case again, now from the memo the first call filled: the same items, each still right.
        add(tally, await check(`random ${i} (memo)`, text, search, true));
        cases += 1;
      }
      expect(cases).toBe(50);
      expect(tally.items).toBeGreaterThan(500);
      expect(tally.items - tally.disabled, 'items that count something').toBeGreaterThan(300);
      expect(tally.disabled, 'items that count zero').toBeGreaterThan(10);
      for (const group of ['titles', 'places', 'companies', 'facts']) expect(tally.byGroup[group] ?? 0, group).toBeGreaterThan(0);
      console.info(`search-suggest invariant, random: ${cases} cases x 2 passes (cold, then memo), ${tally.items} items (${tally.disabled} disabled) ${JSON.stringify(tally.byGroup)} checked against the board, 0 mismatches.`);
    });
  });
});
