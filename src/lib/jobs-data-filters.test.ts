/**
 * jobs-data-filters.test.ts: the allowlist refuses what it does not know.
 *
 * These run without a database, because parsing is pure on purpose: a
 * parameter has to be rejected before anything reaches Postgres, and a test
 * that needed a connection could not prove that.
 */
import { describe, it, expect } from 'vitest';
import {
  parseFilters, assertAtsKnown, cacheKey, isUnfiltered, FilterError, NO_FILTERS
} from './jobs-data-filters';

const q = (s: string) => new URLSearchParams(s);

describe('the Jobs Data filter allowlist', () => {
  it('reads the unfiltered view from an empty query', () => {
    const f = parseFilters(q(''));
    expect(f).toEqual(NO_FILTERS);
    expect(isUnfiltered(f)).toBe(true);
  });

  it('accepts every value the page can actually set', () => {
    const f = parseFilters(q('where=remote+only&floor=200&priced=priced&age=7&level=Staff&friction=hard&record=clean&ats=ashby'));
    expect(f).toMatchObject({
      where: 'remote only', floor: 200, priced: 'priced', age: 7,
      level: 'Staff', friction: 'hard', record: 'clean', ats: 'ashby'
    });
    expect(isUnfiltered(f)).toBe(false);
  });

  for (const [name, bad] of [
    ['where', 'where=somewhere'],
    ['priced', 'priced=maybe'],
    ['friction', 'friction=medium'],
    ['record', 'record=dirty'],
    ['level', 'level=Junior'],
    ['floor', 'floor=175'],
    ['age', 'age=365'],
    ['watch', 'watch=Chief+Executive']
  ] as const) {
    it(`refuses an unknown ${name} and names the parameter`, () => {
      let err: unknown;
      try { parseFilters(q(bad)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(FilterError);
      expect((err as FilterError).param).toBe(name);
    });
  }

  it('refuses a floor that is a number but not one of the offered floors', () => {
    expect(() => parseFilters(q('floor=1'))).toThrow(FilterError);
    // And is not fooled by a value that coerces.
    expect(() => parseFilters(q('floor=200abc'))).toThrow(FilterError);
    expect(() => parseFilters(q('floor= 200 '))).not.toThrow();
  });

  it('refuses an applicant system the crawl does not hold', () => {
    const f = parseFilters(q('ats=nonesuch'));
    expect(() => assertAtsKnown(f, ['ashby', 'greenhouse'])).toThrow(FilterError);
    expect(() => assertAtsKnown(parseFilters(q('ats=ashby')), ['ashby'])).not.toThrow();
  });

  it('treats a SQL fragment as an unknown value, not as SQL', () => {
    // Nothing is interpolated anywhere, but the allowlist is the first refusal
    // and this pins that it happens at all.
    for (const attack of [
      "where=anywhere'; DROP TABLE jobs; --",
      'level=Senior UNION SELECT 1',
      "priced=any') OR ('1'='1"
    ]) {
      expect(() => parseFilters(q(attack)), attack).toThrow(FilterError);
    }
  });

  it('ignores a parameter it does not read rather than refusing the request', () => {
    // A stale bookmark carrying a retired filter should still render.
    expect(() => parseFilters(q('risk=LOW&sort=fit&page=3'))).not.toThrow();
  });

  it('caps how many groups and switched-off titles one request may carry', () => {
    const many = Array.from({ length: 9 }, () => 'watch=Design+Leadership').join('&');
    expect(() => parseFilters(q(many))).toThrow(FilterError);
    const off = ['Design Leadership'].concat(Array.from({ length: 201 }, (_, i) => 't' + i)).join('\t');
    expect(() => parseFilters(q('watch=' + encodeURIComponent(off)))).toThrow(FilterError);
  });

  it('gives the same cache key whatever order the parameters arrived in', () => {
    const a = parseFilters(q('where=remote+only&level=Staff&floor=200'));
    const b = parseFilters(q('floor=200&where=remote+only&level=Staff'));
    expect(cacheKey(a)).toBe(cacheKey(b));
    expect(cacheKey(a)).not.toBe(cacheKey(parseFilters(q('where=remote+only&level=Lead&floor=200'))));
  });

  it('gives the same cache key for the same switched-off titles in any order', () => {
    const a = parseFilters(q('watch=' + encodeURIComponent('Design Leadership\tHead of Design\tVP Design')));
    const b = parseFilters(q('watch=' + encodeURIComponent('Design Leadership\tVP Design\tHead of Design')));
    expect(cacheKey(a)).toBe(cacheKey(b));
  });
});
