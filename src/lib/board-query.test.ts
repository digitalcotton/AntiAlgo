import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY,
  boardHref,
  clampPage,
  hiddenFields,
  isExplicit,
  pageSpan,
  parseBoardQuery,
  parsePage
} from './board-query';

const params = (s: string) => new URLSearchParams(s);

describe('parseBoardQuery', () => {
  it('reads the defaults from an empty address', () => {
    expect(parseBoardQuery(params(''))).toEqual(DEFAULT_QUERY);
    expect(isExplicit(params(''))).toBe(false);
  });
  it('accepts only allowlisted values and falls back per field', () => {
    const q = parseBoardQuery(params('page=3&per=100&q=%20designer%20&location=remote&comp=200-250&freshness=fresh&sort=age'));
    expect(q).toEqual({ page: 3, per: 100, q: 'designer', location: 'remote', comp: '200-250', freshness: 'fresh', sort: 'age', ageMin: null, ageMax: null, titles: [] });
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

describe('boardHref', () => {
  it('omits defaults so the bare board stays bare', () => {
    expect(boardHref('/jobs/board', DEFAULT_QUERY)).toBe('/jobs/board');
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, page: 2 })).toBe('/jobs/board?page=2');
    expect(boardHref('/jobs/board', { ...DEFAULT_QUERY, per: 100, sort: 'age', q: 'a b' })).toBe('/jobs/board?q=a+b&sort=age&per=100');
    expect(parseBoardQuery(params('per=5'))).toEqual(DEFAULT_QUERY);
    expect(parseBoardQuery(params('per=10')).per).toBe(10);
  });
  it('drops the page whenever the set changes, and keeps it for a page step', () => {
    const q = { ...DEFAULT_QUERY, page: 9, location: 'remote' as const };
    expect(boardHref('/jobs/board', q, { comp: '150-200' })).toBe('/jobs/board?location=remote&comp=150-200');
    expect(boardHref('/jobs/board', q, { sort: 'comp' })).toBe('/jobs/board?location=remote&sort=comp');
    expect(boardHref('/jobs/board', q, { page: 10 })).toBe('/jobs/board?location=remote&page=10');
    expect(boardHref('/jobs/board', q, { location: 'all' })).toBe('/jobs/board');
  });
});

describe('hiddenFields', () => {
  it('carries every non-default setting except the ones the form owns, and never the page', () => {
    const q = { page: 4, per: 25, q: 'lead', location: 'remote' as const, comp: 'all', freshness: 'older' as const, sort: 'age' as const, ageMin: null, ageMax: null, titles: [] };
    expect(hiddenFields(q, ['location', 'comp', 'freshness', 'q'])).toEqual([['sort', 'age'], ['per', '25']]);
    expect(hiddenFields(q, ['per'])).toEqual([['q', 'lead'], ['location', 'remote'], ['freshness', 'older'], ['sort', 'age']]);
    expect(hiddenFields(q, []).some(([k]) => k === 'page')).toBe(false);
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
    const q = { ...DEFAULT_QUERY, titles: ['Product Designer', 'Design Lead'] };
    expect(boardHref('/jobs/board', q)).toBe('/jobs/board?title=Product+Designer&title=Design+Lead');
    // A title pick changes the set, so it starts at page one.
    expect(boardHref('/jobs/board', { ...q, page: 3 }, { titles: ['Design Lead'] })).toBe('/jobs/board?title=Design+Lead');
    expect(boardHref('/jobs/board', { ...q, page: 3 }, { page: 4 })).toBe('/jobs/board?title=Product+Designer&title=Design+Lead&page=4');
    expect(hiddenFields(q, [])).toEqual([['title', 'Product Designer'], ['title', 'Design Lead']]);
    expect(hiddenFields(q, ['titles'])).toEqual([]);
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
