import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SQL the paged board sends, checked with no database: the facet rules
// are in the text, every value is bound, the heavy column stays home.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

import { likePattern, listBoardAges, listBoardFiltered } from './job-store';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ total: 3, location_all: 3, location_remote: 1, location_onsite: 2 }] });
});

const FILTER = { q: 'design', location: 'remote', comp: 'all', freshness: 'all', sort: 'fit' as const, page: 2, perPage: 50, sweepDate: '2026-09-11', ageMin: null, ageMax: null };

describe('listBoardFiltered', () => {
  it('asks twice over one CTE, binding every value, and pages with LIMIT and OFFSET', async () => {
    const result = await listBoardFiltered(FILTER);
    expect(query).toHaveBeenCalledTimes(2);
    const [countSql, countParams] = query.mock.calls[0];
    const [pageSql, pageParams] = query.mock.calls[1];
    expect(countParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null]);
    expect(pageParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, 50, 50]);
    expect(countSql).toContain('FILTER (WHERE match_age AND');
    expect(pageSql).toContain('LIMIT $9 OFFSET $10');
    expect(pageSql).toContain('ORDER BY fit_total DESC, company ASC, title ASC, id ASC');
    expect(result.total).toBe(3);
    expect(result.counts.location).toEqual({ all: 3, remote: 1, onsite: 2 });
  });
  it('mirrors the TypeScript facet rules in SQL', async () => {
    await listBoardFiltered(FILTER);
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toContain(String.raw`j.location ~* '\yhybrid\y' THEN 'onsite'`);
    expect(sql).toContain(String.raw`j.location ~* '\yremote\y' THEN 'remote'`);
    expect(sql).toContain("jsonb_typeof(j.comp_range->'min') IS DISTINCT FROM 'number'");
    expect(sql).toContain("(j.comp_range->>'min')::numeric < 150000 THEN 'under-150'");
    expect(sql).toContain("ELSE '300-plus'");
    expect(sql).toContain("(j.published AT TIME ZONE 'UTC')::date");
    expect(sql).toContain('j.first_seen < $1::date');
    expect(sql).toContain("age_days <= $2 THEN 'fresh'");
    expect(sql).toContain(String.raw`ILIKE $3 ESCAPE '\'`);
    expect(sql).toContain('NULL::text AS description');
    expect(sql).not.toMatch(/\bj\.description\b/);
    expect(sql).toContain('regexp_matches');
  });
  it('binds the age range in days and keeps undated rows out of any range that is set', async () => {
    await listBoardFiltered({ ...FILTER, ageMin: 2, ageMax: 7 });
    const [sql, params] = query.mock.calls[1];
    expect(params.slice(6, 8)).toEqual([2, 7]);
    expect(sql).toContain('age_days IS NOT NULL');
    expect(sql).toContain('($7::int IS NULL OR age_days >= $7::int)');
    expect(sql).toContain('($8::int IS NULL OR age_days <= $8::int)');
    expect(sql).toContain('WHERE match_age AND match_q');
  });
  it('orders by the allowlisted key for comp and age', async () => {
    await listBoardFiltered({ ...FILTER, sort: 'comp' });
    expect(query.mock.calls[1][0]).toContain('ORDER BY comp_top DESC NULLS LAST');
    await listBoardFiltered({ ...FILTER, sort: 'age' });
    expect(query.mock.calls[3][0]).toContain('ORDER BY age_days ASC NULLS LAST');
  });
  it('binds a wildcard the person typed as a literal', async () => {
    expect(likePattern('50%_x')).toBe(String.raw`%50\%\_x%`);
    expect(likePattern('   ')).toBeNull();
    await listBoardFiltered({ ...FILTER, q: '' });
    expect(query.mock.calls[0][1][2]).toBeNull();
  });
});

describe('listBoardAges', () => {
  it('reads dates for every row and never the description', async () => {
    query.mockResolvedValue({ rows: [] });
    await listBoardAges();
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/\bj\.description\b/);
    expect(sql).toContain('j.published');
    expect(sql).toContain('j.first_seen');
  });

  it('reads the whole set, because the plot is a claim about the whole set', async () => {
    // It used to default to LIMIT 5000 with no ORDER BY. Under 1,900 rows the
    // cap never bound; carrying the whole crawl it binds every time, and the
    // plot would describe an arbitrary subset while still printing "N roles".
    query.mockResolvedValue({ rows: [] });
    await listBoardAges();
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual([]);
  });

  it('bounds the read only when a caller asks for it', async () => {
    query.mockResolvedValue({ rows: [] });
    await listBoardAges(100);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([100]);
  });
});
