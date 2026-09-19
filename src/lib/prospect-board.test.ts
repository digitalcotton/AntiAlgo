import { describe, expect, it } from 'vitest';
import { listProspectsFiltered } from './prospect-board';
import { DEFAULT_PER_PAGE, DEFAULT_QUERY } from './board-query';
import { prospectRows } from './data';

const ALL = prospectRows();
const query = (over: Partial<typeof DEFAULT_QUERY> = {}) => ({ ...DEFAULT_QUERY, ...over });

describe('listProspectsFiltered: one page, never the whole list', () => {
  it('returns a single page and the full total', () => {
    const page = listProspectsFiltered(ALL, query());
    expect(page.total).toBe(ALL.length);
    expect(page.rows).toHaveLength(DEFAULT_PER_PAGE);
    expect(ALL.length).toBeGreaterThan(DEFAULT_PER_PAGE); // the fix would be moot otherwise
  });

  it('pages without overlap, and runs off the end as an empty page', () => {
    const one = listProspectsFiltered(ALL, query({ page: 1, per: 25 }));
    const two = listProspectsFiltered(ALL, query({ page: 2, per: 25 }));
    expect(one.rows).toHaveLength(25);
    expect(two.rows).toHaveLength(25);
    expect(two.rows.map((j) => j.slug)).not.toEqual(one.rows.map((j) => j.slug));

    const past = listProspectsFiltered(ALL, query({ page: 9_999 }));
    expect(past.rows).toHaveLength(0);
    expect(past.total).toBe(ALL.length); // the caller clamps and redirects on this
  });

  it('sorts by fit before slicing, so page one is the best rows and not the first ones', () => {
    const { rows } = listProspectsFiltered(ALL, query({ sort: 'fit', per: 10 }));
    const totals = rows.map((job) => job.fit.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });
});

describe('listProspectsFiltered: the filters read the same rule the facets do', () => {
  it('searches the company name', () => {
    const target = ALL[0].company;
    const page = listProspectsFiltered(ALL, query({ q: target.toLowerCase() }));
    expect(page.total).toBeGreaterThan(0);
    expect(page.total).toBeLessThan(ALL.length);
    expect(page.rows.every((job) => job.company.toLowerCase().includes(target.toLowerCase()))).toBe(true);
  });

  it('does NOT empty the list when Location is set, because a pre-posting row has no workplace', () => {
    // The 2026-09-10 bug: a "Remote" filter chosen on the board travels in the
    // address and used to leave this page with zero rows and no explanation.
    const page = listProspectsFiltered(ALL, query({ location: 'remote' }));
    expect(page.total).toBe(ALL.length);
  });

  it('empties the list for any age range, because no prospect has a measurable age', () => {
    expect(listProspectsFiltered(ALL, query({ ageMin: 0, ageMax: 30 })).total).toBe(0);
  });

  it('counts every facet group over the searched set', () => {
    const { counts, total } = listProspectsFiltered(ALL, query());
    expect(counts.total).toBe(total);
    expect(counts.location.all).toBe(total);
    // Every prospect is a company before it posts: no workplace, no pay, no date.
    expect(counts.location.remote + counts.location.onsite).toBe(0);
    expect(counts.comp['not-listed']).toBe(total);
    expect(counts.freshness.unknown).toBe(total);
  });
});
