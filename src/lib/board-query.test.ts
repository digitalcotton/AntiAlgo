import { describe, expect, it } from 'vitest';
import {
  BOARD_SORT_KEYS,
  DEFAULT_QUERY,
  boardHref,
  clampPage,
  defaultSortFor,
  formatPlaceKey,
  hiddenFields,
  isExplicit,
  pageSpan,
  parseBoardQuery,
  parseCompany,
  parsePage,
  parsePayMin,
  parsePlaceKey,
  parseRemote,
  payFloorOfBand,
  type BoardQuery
} from './board-query';
import { chipsToParams, type Chip } from './search-parse';

const params = (s: string) => new URLSearchParams(s);
const q = (over: Partial<BoardQuery> = {}): BoardQuery => ({ ...DEFAULT_QUERY, ...over });

describe('parseBoardQuery', () => {
  it('reads the defaults from an empty address', () => {
    expect(parseBoardQuery(params(''))).toEqual(DEFAULT_QUERY);
    expect(isExplicit(params(''))).toBe(false);
  });
  it('accepts only allowlisted values and falls back per field', () => {
    const parsed = parseBoardQuery(params('page=3&per=100&q=%20designer%20&location=remote&comp=200-250&freshness=fresh&sort=age'));
    // A legacy `location` and `comp` are read into the new fields as well as
    // kept: see the legacy describes below.
    expect(parsed).toEqual({
      ...DEFAULT_QUERY,
      page: 3,
      per: 100,
      q: 'designer',
      location: 'remote',
      remote: ['remote'],
      comp: '200-250',
      payMin: 200,
      freshness: 'fresh',
      sort: 'age'
    });
    const bad = parseBoardQuery(params('page=-2&per=7&location=mars&comp=nope&freshness=soon&sort=price&age_min=-1&age_max=soon'));
    expect(bad).toEqual(DEFAULT_QUERY);
  });
  it('reads the age range in whole days, either end open, and rights a backwards pair', () => {
    expect(parseBoardQuery(params('age_min=2&age_max=7'))).toMatchObject({ ageMin: 2, ageMax: 7 });
    expect(parseBoardQuery(params('age_max=7'))).toMatchObject({ ageMin: null, ageMax: 7 });
    expect(parseBoardQuery(params('age_min=30&age_max=4'))).toMatchObject({ ageMin: 4, ageMax: 30 });
    expect(parseBoardQuery(params('age_min=1.5'))).toMatchObject({ ageMin: null });
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, page: 4 }, { ageMin: 0, ageMax: 7 })).toBe('/jobs/board?age_min=0&age_max=7');
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, ageMin: 2, ageMax: 7 }, { ageMin: null, ageMax: null })).toBe('/jobs/board');
    expect(hiddenFields({ ...DEFAULT_QUERY, ageMin: 2, ageMax: 7 }, ['ageMin', 'ageMax'])).toEqual([]);
    expect(hiddenFields({ ...DEFAULT_QUERY, ageMin: 2 }, ['per'])).toEqual([['age_min', '2']]);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('12')).toBe(12);
    expect(parseBoardQuery(params('q=' + 'x'.repeat(300))).q).toHaveLength(120);
    expect(isExplicit(params('location=all'))).toBe(true);
  });
});

describe('remote: the arrangements, as a list', () => {
  it('reads a comma list in canonical order, de-duplicated, with unknown kinds dropped', () => {
    expect(parseBoardQuery(params('remote=remote,hybrid')).remote).toEqual(['remote', 'hybrid']);
    // The order the reader wrote is not the order kept: the address cannot remember it.
    expect(parseBoardQuery(params('remote=unstated,onsite,hybrid,remote')).remote).toEqual(['remote', 'hybrid', 'onsite', 'unstated']);
    expect(parseBoardQuery(params('remote=hybrid,hybrid,%20HYBRID%20')).remote).toEqual(['hybrid']);
    expect(parseBoardQuery(params('remote=remote,mars,,')).remote).toEqual(['remote']);
    expect(parseBoardQuery(params('remote=mars')).remote).toEqual([]);
    expect(parseBoardQuery(params('remote=')).remote).toEqual([]);
    // A repeated parameter is the union, the same as chipsFromParams reads it.
    expect(parseBoardQuery(params('remote=remote&remote=onsite')).remote).toEqual(['remote', 'onsite']);
    expect(parseRemote(['hybrid, remote'])).toEqual(['remote', 'hybrid']);
  });
  it('mirrors a single kind into `location` for the strip that still has one select, and says all for a pair', () => {
    expect(parseBoardQuery(params('remote=hybrid')).location).toBe('hybrid');
    expect(parseBoardQuery(params('remote=remote,hybrid')).location).toBe('all');
    expect(parseBoardQuery(params('')).location).toBe('all');
  });
  it('LEGACY: reads a single `location=` as a one-item list when `remote` is absent', () => {
    expect(parseBoardQuery(params('location=hybrid'))).toMatchObject({ remote: ['hybrid'], location: 'hybrid' });
    expect(parseBoardQuery(params('location=unstated')).remote).toEqual(['unstated']);
    // `all` is no choice, and an unknown value is the same as none.
    expect(parseBoardQuery(params('location=all')).remote).toEqual([]);
    expect(parseBoardQuery(params('location=mars')).remote).toEqual([]);
  });
  it('lets `remote` win over `location`, and treats a present-but-empty `remote` as the reader\'s answer', () => {
    expect(parseBoardQuery(params('remote=onsite&location=hybrid')).remote).toEqual(['onsite']);
    // The legacy name is read only while the new one is ABSENT. `remote=mars`
    // is a stale or typed value that read as no choice, and it must not be
    // quietly replaced by an older parameter that happens to be beside it.
    expect(parseBoardQuery(params('remote=mars&location=hybrid')).remote).toEqual([]);
  });
});

describe('pay: a floor in thousands, and the legacy bands', () => {
  it('reads pay_min as a whole number of thousands in the box\'s own bounds', () => {
    expect(parseBoardQuery(params('pay_min=150'))).toMatchObject({ payMin: 150, comp: 'all', compNotListed: false });
    expect(parseBoardQuery(params('pay_min=1')).payMin).toBe(1);
    expect(parseBoardQuery(params('pay_min=2000')).payMin).toBe(2000);
    // Dropped, never clamped and never repaired: nobody typed these into the
    // box, so nobody is owed a guess at what they meant.
    for (const bad of ['0', '2001', '150.5', '-5', 'abc', '150k', '', '1e3', '123456', ' ']) {
      expect(parseBoardQuery(params(`pay_min=${encodeURIComponent(bad)}`)).payMin).toBeNull();
    }
    expect(parsePayMin(' 150 ')).toBe(150);
    expect(parsePayMin(null)).toBeNull();
    // The last valid value of a repeated parameter wins; a bad one after it does not undo it.
    expect(parseBoardQuery(params('pay_min=100&pay_min=250&pay_min=0')).payMin).toBe(250);
  });
  it('LEGACY: reads comp=<band> as that band\'s lower bound, and keeps the band for the strip that still shows bands', () => {
    expect(parseBoardQuery(params('comp=150-200'))).toMatchObject({ comp: '150-200', payMin: 150, compNotListed: false });
    expect(parseBoardQuery(params('comp=200-250'))).toMatchObject({ comp: '200-250', payMin: 200 });
    expect(parseBoardQuery(params('comp=250-300'))).toMatchObject({ payMin: 250 });
    expect(parseBoardQuery(params('comp=300-plus'))).toMatchObject({ payMin: 300 });
    // "Under $150K" is a ceiling and a floor cannot say it.
    expect(parseBoardQuery(params('comp=under-150'))).toMatchObject({ comp: 'under-150', payMin: null });
    expect(payFloorOfBand('under-150')).toBeNull();
    expect(payFloorOfBand('150-200')).toBe(150);
    expect(payFloorOfBand('nope')).toBeNull();
  });
  it('comp=not-listed is its own boolean, and it and a floor are mutually exclusive', () => {
    expect(parseBoardQuery(params('comp=not-listed'))).toMatchObject({ comp: 'not-listed', compNotListed: true, payMin: null });
    // The floor is DROPPED when not-listed is set, whichever order they came in.
    expect(parseBoardQuery(params('comp=not-listed&pay_min=150'))).toMatchObject({ compNotListed: true, payMin: null });
    expect(parseBoardQuery(params('pay_min=150&comp=not-listed'))).toMatchObject({ compNotListed: true, payMin: null });
  });
  it('lets an explicit pay_min win over a legacy band, and clears the band so the two never disagree', () => {
    expect(parseBoardQuery(params('comp=200-250&pay_min=100'))).toMatchObject({ payMin: 100, comp: 'all' });
    // But an invalid pay_min falls back to the band rather than to nothing.
    expect(parseBoardQuery(params('comp=200-250&pay_min=0'))).toMatchObject({ payMin: 200, comp: '200-250' });
  });
});

describe('place: a country, a region and a city, strictly', () => {
  it('accepts the four shapes', () => {
    for (const key of ['GB', 'US-MD', 'GB/London', 'US-MD/Baltimore', 'AU-NSW/Sydney', "US-NY/St. John's", 'BR/Rio de Janeiro', 'DE/Frankfurt am Main', 'XX/A/B']) {
      expect(parseBoardQuery(params(`place=${encodeURIComponent(key)}`)).place).toBe(key);
    }
  });
  it('takes the key apart at the first slash and puts it back together', () => {
    expect(parsePlaceKey('US-MD/Baltimore')).toEqual({ country: 'US', admin1: 'MD', city: 'Baltimore' });
    expect(parsePlaceKey('GB/London')).toEqual({ country: 'GB', admin1: null, city: 'London' });
    expect(parsePlaceKey('US-MD')).toEqual({ country: 'US', admin1: 'MD', city: null });
    expect(parsePlaceKey('GB')).toEqual({ country: 'GB', admin1: null, city: null });
    // A city may hold a slash of its own: the first one is the split.
    expect(parsePlaceKey('BR/Rio/Janeiro')).toEqual({ country: 'BR', admin1: null, city: 'Rio/Janeiro' });
    for (const key of ['GB', 'US-MD', 'GB/London', 'US-MD/Baltimore']) {
      expect(formatPlaceKey(parsePlaceKey(key)!)).toBe(key);
    }
  });
  it('drops every key that is not exactly one of them', () => {
    const bad = [
      'gb', 'Gb', 'GBR', 'G', '', ' ', '-MD', 'US-', 'US-MARY', 'us-md', 'US-md', 'US-M D', 'GB/', 'GB/ London', 'GB/London ',
      'GB//', 'US-MD/', '/London', 'GB-/London', 'GB\u0000/London', 'GB/Lon\ndon', 'GB/' + 'x'.repeat(81), 'U1', '12', 'GB London', 'GB,US'
    ];
    for (const key of bad) {
      expect(parsePlaceKey(key), JSON.stringify(key)).toBeNull();
      expect(parseBoardQuery(params(`place=${encodeURIComponent(key)}`)).place, JSON.stringify(key)).toBeNull();
    }
    expect(parsePlaceKey(null)).toBeNull();
    expect(parsePlaceKey(undefined)).toBeNull();
  });
  it('keeps the last valid key of a repeated parameter', () => {
    expect(parseBoardQuery(params('place=GB&place=US-MD&place=nope')).place).toBe('US-MD');
  });
});

describe('company: its exact name', () => {
  it('trims, drops the empty, the over-long and the control characters', () => {
    expect(parseBoardQuery(params('company=%20Figma%20')).company).toBe('Figma');
    expect(parseBoardQuery(params('company=')).company).toBeNull();
    expect(parseBoardQuery(params('company=%20%20')).company).toBeNull();
    expect(parseBoardQuery(params('company=' + 'x'.repeat(121))).company).toBeNull();
    expect(parseBoardQuery(params('company=' + 'x'.repeat(120))).company).toHaveLength(120);
    expect(parseCompany('Fig\u0000ma')).toBeNull();
    expect(parseCompany('A & B, Inc.')).toBe('A & B, Inc.');
    expect(parseBoardQuery(params('company=A&company=B')).company).toBe('B');
  });
});

describe('sort: best match is the default only when words are typed', () => {
  it('defaults to the table order with no words and to best match with words', () => {
    expect(parseBoardQuery(params('')).sort).toBe('fit');
    expect(parseBoardQuery(params('q=designer')).sort).toBe('best');
    expect(parseBoardQuery(params('q=%20%20')).sort).toBe('fit');
    expect(defaultSortFor('')).toBe('fit');
    expect(defaultSortFor('  ')).toBe('fit');
    expect(defaultSortFor('x')).toBe('best');
  });
  it('keeps a sort the address names, and reads sort=best with no words as the table default', () => {
    expect(parseBoardQuery(params('q=designer&sort=age')).sort).toBe('age');
    expect(parseBoardQuery(params('q=designer&sort=comp')).sort).toBe('comp');
    // Naming Detail while searching is a choice, not the default, and survives.
    expect(parseBoardQuery(params('q=designer&sort=fit')).sort).toBe('fit');
    expect(parseBoardQuery(params('q=designer&sort=best')).sort).toBe('best');
    expect(parseBoardQuery(params('sort=best')).sort).toBe('fit');
    expect(parseBoardQuery(params('sort=best&q=')).sort).toBe('fit');
    expect(parseBoardQuery(params('sort=age')).sort).toBe('age');
    expect(parseBoardQuery(params('q=designer&sort=nope')).sort).toBe('best');
    expect([...BOARD_SORT_KEYS]).toEqual(['fit', 'comp', 'age', 'best']);
  });
  it('writes a sort only when it differs from the default FOR THOSE WORDS', () => {
    expect(boardHref('/b', q({ q: 'design', sort: 'best' }))).toBe('/b?q=design');
    expect(boardHref('/b', q({ q: 'design', sort: 'fit' }))).toBe('/b?q=design&sort=fit');
    expect(boardHref('/b', q({ q: 'design', sort: 'age' }))).toBe('/b?q=design&sort=age');
    expect(boardHref('/b', q({ sort: 'fit' }))).toBe('/b');
    expect(boardHref('/b', q({ sort: 'age' }))).toBe('/b?sort=age');
    // A ranking of nothing is not a sort and is never written.
    expect(boardHref('/b', q({ sort: 'best' }))).toBe('/b');
  });
  it('moves the default with a new search, but never moves a sort the reader chose', () => {
    // From the bare board, typing words must start in best match, not carry the
    // old default across as an explicit sort=fit.
    expect(boardHref('/b', q(), { q: 'design' })).toBe('/b?q=design');
    expect(parseBoardQuery(params('q=design')).sort).toBe('best');
    // Clearing the words returns to the table default.
    expect(boardHref('/b', q({ q: 'design', sort: 'best' }), { q: '' })).toBe('/b');
    // A chosen sort stays chosen across a new search.
    expect(boardHref('/b', q({ q: 'design', sort: 'age' }), { q: 'lead' })).toBe('/b?q=lead&sort=age');
    expect(boardHref('/b', q({ q: 'design', sort: 'fit' }), { q: 'lead' })).toBe('/b?q=lead&sort=fit');
    // An explicit sort in the same call is never overridden.
    expect(boardHref('/b', q(), { q: 'design', sort: 'comp' })).toBe('/b?q=design&sort=comp');
  });
});

describe('boardHref', () => {
  it('omits defaults so the bare board stays bare', () => {
    expect(boardHref('/jobs/board', DEFAULT_QUERY)).toBe('/jobs/board');
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, page: 2 })).toBe('/jobs/board?page=2');
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, per: 100, sort: 'age', q: 'a b' })).toBe('/jobs/board?q=a+b&sort=age&per=100');
    expect(parseBoardQuery(params('per=5'))).toEqual(DEFAULT_QUERY);
    expect(parseBoardQuery(params('per=10')).per).toBe(10);
  });
  it('drops the page whenever the set changes, and keeps it for a page step', () => {
    const base = q({ page: 9, location: 'remote', remote: ['remote'] });
    expect(boardHref('/jobs/board', base, { comp: '150-200' })).toBe('/jobs/board?remote=remote&comp=150-200');
    expect(boardHref('/jobs/board', base, { sort: 'comp' })).toBe('/jobs/board?remote=remote&sort=comp');
    expect(boardHref('/jobs/board', base, { page: 10 })).toBe('/jobs/board?remote=remote&page=10');
    expect(boardHref('/jobs/board', base, { location: 'all' })).toBe('/jobs/board');
    // Every new filter changes the set too.
    for (const over of [{ place: 'GB' }, { company: 'Figma' }, { payMin: 150 }, { remote: ['hybrid' as const] }, { compNotListed: true }]) {
      expect(boardHref('/jobs/board', base, over)).not.toContain('page=');
    }
  });
  it('writes the canonical new parameters, in a fixed order, and no legacy `location`', () => {
    const query = q({ q: 'designer', place: 'US-MD/Baltimore', company: 'Figma', remote: ['remote', 'hybrid'], payMin: 150, freshness: 'fresh', ageMax: 7, sort: 'age', per: 25 });
    expect(boardHref('/board', query)).toBe(
      '/board?q=designer&place=US-MD%2FBaltimore&company=Figma&remote=remote%2Chybrid&pay_min=150&freshness=fresh&age_max=7&sort=age&per=25'
    );
    expect(boardHref('/board', query)).not.toContain('location=');
    // A query built with only the old field (a fixture, an older caller) is written as the list it means.
    expect(boardHref('/board', q({ location: 'hybrid' }))).toBe('/board?remote=hybrid');
  });
  it('writes not-listed as comp=not-listed, a band as the band the strip still offers, and a floor as pay_min', () => {
    expect(boardHref('/board', q({ compNotListed: true }))).toBe('/board?comp=not-listed');
    expect(boardHref('/board', q({ comp: 'not-listed', compNotListed: true }))).toBe('/board?comp=not-listed');
    // A band is written as itself, NOT as its floor: "$200K to $250K" turned
    // into "$200K and up" on the next page would change the rows under a reader.
    expect(boardHref('/board', parseBoardQuery(params('comp=200-250')))).toBe('/board?comp=200-250');
    expect(boardHref('/board', q({ payMin: 150 }))).toBe('/board?pay_min=150');
  });
  it('translates an override of the old names the way the address would be read', () => {
    const on = q({ remote: ['remote'], location: 'remote', payMin: 150, company: 'Figma' });
    expect(boardHref('/b', on, { location: 'all' })).toBe('/b?company=Figma&pay_min=150');
    expect(boardHref('/b', on, { location: 'hybrid' })).toBe('/b?company=Figma&remote=hybrid&pay_min=150');
    expect(boardHref('/b', on, { comp: 'all' })).toBe('/b?company=Figma&remote=remote');
    expect(boardHref('/b', on, { comp: 'not-listed' })).toBe('/b?company=Figma&remote=remote&comp=not-listed');
    expect(boardHref('/b', on, { comp: '300-plus' })).toBe('/b?company=Figma&remote=remote&comp=300-plus');
    // Board.astro's clear link: every filter it knows resets, the sort and size stay.
    expect(
      boardHref('/b', q({ q: 'x', remote: ['remote'], payMin: 100, place: 'GB', company: 'Figma', sort: 'age' }), {
        q: '', location: 'all', comp: 'all', freshness: 'all', ageMin: null, ageMax: null, place: null, remote: [], payMin: null, compNotListed: false, company: null
      })
    ).toBe('/b?sort=age');
  });
  it('round-trips: reading what it wrote gives the query back', () => {
    const queries: BoardQuery[] = [
      q(),
      q({ q: 'senior designer', sort: 'best' }),
      q({ q: 'senior designer', sort: 'fit' }),
      q({ place: 'GB' }),
      q({ place: 'US-MD/Baltimore', remote: ['remote'], location: 'remote' }),
      q({ remote: ['remote', 'hybrid'], payMin: 150 }),
      q({ remote: ['hybrid', 'onsite', 'unstated'], company: 'A & B, Inc.' }),
      q({ compNotListed: true, comp: 'not-listed' }),
      q({ comp: '150-200', payMin: 150 }),
      q({ q: 'x', place: 'DE/Frankfurt am Main', payMin: 2000, ageMin: 1, ageMax: 30, freshness: 'older', per: 100, page: 3, titles: ['Product Designer'], families: ['design'] })
    ];
    for (const query of queries) {
      const href = boardHref('/board', query);
      const back = parseBoardQuery(new URL(href, 'https://x.test').searchParams);
      // `location` is derived from `remote`, and a query built by hand may name only one of them.
      const expected = { ...query, location: query.remote.length === 1 ? query.remote[0] : 'all' };
      expect(back, href).toEqual(expected);
      // And writing what was read changes nothing.
      expect(boardHref('/board', back), href).toBe(href);
    }
  });
});

describe('the parameters the search box writes', () => {
  // search-parse.ts chipsToParams and this file are two ends of one wire: the
  // box writes `place`, `company`, `remote`, `pay_min` and `age_max`, and the
  // board reads them. A name or a format that drifted on either side would turn
  // every chip into a filter that silently did nothing.
  const read = (chips: Chip[]) => parseBoardQuery(new URLSearchParams(chipsToParams(chips)));

  it('reads every chip the parser can make as the filter it stands for', () => {
    const query = read([
      { kind: 'place', key: 'US-MD/Baltimore', label: 'Baltimore, MD' },
      { kind: 'company', name: 'Figma' },
      { kind: 'remote', value: 'hybrid' },
      { kind: 'remote', value: 'remote' },
      { kind: 'pay', minK: 150 },
      { kind: 'age', maxDays: 7 }
    ]);
    expect(query).toMatchObject({ place: 'US-MD/Baltimore', company: 'Figma', remote: ['remote', 'hybrid'], payMin: 150, ageMax: 7, compNotListed: false });
    // The arrangement chips are a subset of what the address accepts, in the same order.
    expect(read([{ kind: 'remote', value: 'onsite' }]).remote).toEqual(['onsite']);
  });
  it('reads no chips as the bare board', () => {
    expect(read([])).toEqual(DEFAULT_QUERY);
  });
  it('writes a link the box can read back: the same chips again', () => {
    const href = boardHref('/board', parseBoardQuery(new URLSearchParams(chipsToParams([{ kind: 'place', key: 'GB/London', label: 'London' }, { kind: 'remote', value: 'remote' }, { kind: 'pay', minK: 100 }]))));
    expect(href).toBe('/board?place=GB%2FLondon&remote=remote&pay_min=100');
  });
});

describe('hiddenFields', () => {
  it('carries every non-default setting except the ones the form owns, and never the page', () => {
    const full = q({ page: 4, per: 25, q: 'lead', location: 'remote', remote: ['remote'], comp: 'all', freshness: 'older', sort: 'age' });
    expect(hiddenFields(full, ['location', 'comp', 'freshness', 'q'])).toEqual([['sort', 'age'], ['per', '25']]);
    expect(hiddenFields(full, ['per'])).toEqual([['q', 'lead'], ['remote', 'remote'], ['freshness', 'older'], ['sort', 'age']]);
    expect(hiddenFields(full, []).some(([k]) => k === 'page')).toBe(false);
  });
  it('carries the new filters, and drops a pair of parameters together when the form owns either name', () => {
    const full = q({ q: 'x', sort: 'best', place: 'GB/London', company: 'Figma', remote: ['remote', 'hybrid'], payMin: 150 });
    expect(hiddenFields(full, [])).toEqual([
      ['q', 'x'], ['place', 'GB/London'], ['company', 'Figma'], ['remote', 'remote,hybrid'], ['pay_min', '150']
    ]);
    // The Location select owns `location`, which this list writes as `remote`: if both
    // were submitted `remote=` would win and the select could never change anything.
    expect(hiddenFields(full, ['location']).map(([k]) => k)).toEqual(['q', 'place', 'company', 'pay_min']);
    expect(hiddenFields(full, ['remote']).map(([k]) => k)).toEqual(['q', 'place', 'company', 'pay_min']);
    // The Comp select owns `comp`, and with it the floor and the not-listed flag.
    expect(hiddenFields(full, ['comp']).map(([k]) => k)).toEqual(['q', 'place', 'company', 'remote']);
    expect(hiddenFields(q({ compNotListed: true, comp: 'not-listed' }), ['comp'])).toEqual([]);
    expect(hiddenFields(q({ compNotListed: true, comp: 'not-listed' }), [])).toEqual([['comp', 'not-listed']]);
    expect(hiddenFields(full, ['place', 'company', 'payMin', 'remote', 'q'])).toEqual([]);
  });
  it('writes the sort relative to the words, so a form that owns the box lets the default follow it', () => {
    // The strip's form owns `q`. With words and the default sort, nothing is carried and a new search starts in best match.
    expect(hiddenFields(q({ q: 'design', sort: 'best' }), ['q'])).toEqual([]);
    // A sort the reader chose is carried.
    expect(hiddenFields(q({ q: 'design', sort: 'fit' }), ['q'])).toEqual([['sort', 'fit']]);
    expect(hiddenFields(q({ sort: 'age' }), ['q'])).toEqual([['sort', 'age']]);
  });
});

describe('titles: the Desk-title picks in the address', () => {
  it('reads title= repeated, trimmed, de-duplicated, capped, and writes it back the same way', () => {
    expect(parseBoardQuery(params('title=Product+Designer&title=%20Design+Lead%20&title=Product+Designer&title=')).titles).toEqual([
      'Product Designer',
      'Design Lead'
    ]);
    const many = Array.from({ length: 25 }, (_, i) => `title=T${i}`).join('&');
    expect(parseBoardQuery(params(many)).titles).toHaveLength(20);
    const withTitles = { ...DEFAULT_QUERY, titles: ['Product Designer', 'Design Lead'] };
    expect(boardHref('/jobs/board', withTitles)).toBe('/jobs/board?title=Product+Designer&title=Design+Lead');
    // A title pick changes the set, so it starts at page one.
    expect(boardHref('/jobs/board', { ...withTitles, page: 3 }, { titles: ['Design Lead'] })).toBe('/jobs/board?title=Design+Lead');
    expect(boardHref('/jobs/board', { ...withTitles, page: 3 }, { page: 4 })).toBe('/jobs/board?title=Product+Designer&title=Design+Lead&page=4');
    expect(hiddenFields(withTitles, [])).toEqual([['title', 'Product Designer'], ['title', 'Design Lead']]);
    expect(hiddenFields(withTitles, ['titles'])).toEqual([]);
  });
});

describe('clampPage and pageSpan', () => {
  it('holds the page to what exists', () => {
    expect(clampPage(1, 0, 50)).toEqual({ page: 1, pages: 1 });
    expect(clampPage(3, 100, 50)).toEqual({ page: 2, pages: 2 });
    expect(clampPage(2, 101, 50)).toEqual({ page: 2, pages: 3 });
    expect(clampPage(0, 10, 50)).toEqual({ page: 1, pages: 1 });
  });
  it('names the rows on a page', () => {
    expect(pageSpan(1, 50, 1913)).toEqual({ first: 1, last: 50 });
    expect(pageSpan(39, 50, 1913)).toEqual({ first: 1901, last: 1913 });
    expect(pageSpan(1, 50, 0)).toEqual({ first: 0, last: 0 });
  });
});
