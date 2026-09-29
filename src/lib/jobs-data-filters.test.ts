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
    const off = ['Healthcare & Medicine'].concat(Array.from({ length: 201 }, (_, i) => 't' + i)).join('\t');
    expect(() => parseFilters(q('watch=' + encodeURIComponent(off)))).toThrow(FilterError);
  });

  it('gives the same cache key whatever order the parameters arrived in', () => {
    const a = parseFilters(q('where=remote+only&level=Staff&floor=200'));
    const b = parseFilters(q('floor=200&where=remote+only&level=Staff'));
    expect(cacheKey(a)).toBe(cacheKey(b));
    expect(cacheKey(a)).not.toBe(cacheKey(parseFilters(q('where=remote+only&level=Lead&floor=200'))));
  });

  it('gives the same cache key for the same switched-off titles in any order', () => {
    const a = parseFilters(q('watch=' + encodeURIComponent('Healthcare & Medicine\tStaff Nurse\tWard Sister')));
    const b = parseFilters(q('watch=' + encodeURIComponent('Healthcare & Medicine\tWard Sister\tStaff Nurse')));
    expect(cacheKey(a)).toBe(cacheKey(b));
  });
});


describe('the ladder is declared once', () => {
  // It was declared four times — jobs-derived.mjs, jobs-data-agg.ts, data.ts's
  // RoleTier and a browser fallback — with nothing testing that the four
  // agreed. These pin the two that are now re-exports, and the one hand-typed
  // list left in the repo.
  it('jobs-data-agg LADDER IS jobs-derived SENIORITY_LADDER', async () => {
    const { LADDER } = await import('./jobs-data-agg');
    const { SENIORITY_LADDER } = await import('./jobs-derived.mjs');
    expect(LADDER).toBe(SENIORITY_LADDER);
  });

  it('every tier a watched group names is a real rung', async () => {
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    const { SENIORITY_LADDER } = await import('./jobs-derived.mjs');
    for (const group of GROUP_DEFS) {
      for (const tier of group.tiers ?? []) expect(SENIORITY_LADDER).toContain(tier);
    }
  });
});

describe('the watched groups name families that exist', () => {
  // The defect this replaced: three of five groups tested derived_fam against
  // 'design engineering', 'brand' and 'design systems' — names from a
  // TypeScript type no migration ever created — and matched zero rows for
  // months on a paid page. A fourth had no family test at all and matched
  // every Lead and Director on the board.
  it('every fam is a real FAMILY_ID', async () => {
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    const { FAMILY_IDS } = await import('./job-family.mjs');
    for (const g of GROUP_DEFS) {
      expect(g.fam, `${g.title} names a family that does not exist`).not.toBeNull();
      expect(FAMILY_IDS).toContain(g.fam);
    }
  });

  it('no group is defined by seniority alone', async () => {
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    for (const g of GROUP_DEFS) expect(g.fam).toBeTruthy();
  });

  it('groups sharing a family and tier are told apart by words', async () => {
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    const seen = new Map<string, number>();
    for (const g of GROUP_DEFS) {
      const key = `${g.fam}|${[...(g.tiers ?? ['any'])].sort().join(',')}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      // Only the single occupant of a (family, tiers) pair may go wordless;
      // otherwise boardFacts' first-match-wins gives one group every row.
      if ((seen.get(key) ?? 0) > 1) expect(g.words.length).toBeGreaterThan(0);
    }
    for (const [key, n] of seen) {
      if (n > 1) {
        const wordless = GROUP_DEFS.filter(
          (g) => `${g.fam}|${[...(g.tiers ?? ['any'])].sort().join(',')}` === key && g.words.length === 0
        );
        expect(wordless, `${key} has a wordless group beside ${n - 1} others`).toHaveLength(0);
      }
    }
  });

  it('the title words carry no regex metacharacter', async () => {
    // They are interpolated straight into SQL in boardFacts' groupCase, and
    // bound but used as a POSIX pattern in marks(). Holding them to [a-z ]
    // is what makes both safe.
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    for (const g of GROUP_DEFS) for (const w of g.words) expect(w).toMatch(/^[a-z ]+$/);
  });
});


describe('/jobs-data covers every field, not just design', () => {
  // It was five design titles — Product Designer, Design Engineer, Brand
  // Designer, Design Systems Designer, Design Leadership — on a board of
  // 37,286 postings across every kind of work. A nurse could pay for this page
  // and find nothing on it to watch.
  it('there is one group per family, and nothing else', async () => {
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    const { FAMILIES } = await import('./job-family.mjs');
    expect(GROUP_DEFS.map((g) => g.fam)).toEqual(FAMILIES.map((f) => f.id));
    expect(GROUP_DEFS.map((g) => g.title)).toEqual(FAMILIES.map((f) => f.label));
  });

  it('no group narrows by seniority', async () => {
    // derived_tier is NULL on 79.6% of the board, so a tier test would drop
    // four rows in five before looking at the field. Seniority is the `level`
    // filter's job, where a reader can see it and turn it off.
    const { GROUP_DEFS } = await import('./jobs-data-filters');
    for (const g of GROUP_DEFS) expect(g.tiers).toBeNull();
  });

  it('watching every group is inside the request cap', async () => {
    // "Watch all" sends one watch per group; a cap below the group count would
    // 400 the button.
    const { GROUP_DEFS, parseFilters } = await import('./jobs-data-filters');
    const params = new URLSearchParams();
    for (const g of GROUP_DEFS) params.append('watch', g.title);
    expect(() => parseFilters(params)).not.toThrow();
  });
});
