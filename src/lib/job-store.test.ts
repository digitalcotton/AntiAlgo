import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SQL the paged board sends, checked with no database: the facet rules
// are in the text, every value is bound, the heavy column stays home.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

import { likePattern, listBoardAgeHistogram, listBoardFiltered } from './job-store';

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
    // The eleven shared params: sweep, fresh window, search, the three facets,
    // the age range, then country/liveOnly/hasComp (the teaser's extra filters,
    // defaulted here). No watched titles, so nothing binds past them.
    expect(countParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, false, false]);
    expect(pageParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, false, false, 50, 50]);
    expect(countSql).toContain('FILTER (WHERE match_age AND');
    expect(pageSql).toContain('LIMIT $12 OFFSET $13');
    expect(pageSql).toContain('ORDER BY fit_total DESC, company ASC, title ASC, id ASC');
    expect(result.total).toBe(3);
    expect(result.counts.location).toEqual({ all: 3, remote: 1, onsite: 2 });
  });
  it('narrows to the watched titles by whole-phrase match, in count and page alike', async () => {
    await listBoardFiltered({ ...FILTER, titles: ['Product Designer'] });
    const [countSql, countParams] = query.mock.calls[0];
    const [pageSql, pageParams] = query.mock.calls[1];
    // The title normalises to ONE phrase param, bound after the eleven shared ($12).
    expect(countParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, false, false, 'product designer']);
    // Then limit and offset shift past the phrase.
    expect(pageParams.slice(-2)).toEqual([50, 50]);
    expect(pageSql).toContain('LIMIT $13 OFFSET $14');
    // A normalised, padded whole-phrase LIKE (mirroring ledger-titles.matchesTitle),
    // applied to the facet counts too, so the counts describe the narrowed board.
    expect(pageSql).toContain(String.raw`regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')`);
    expect(pageSql).toContain(`LIKE ('% ' || $12 || ' %')`);
    expect(countSql).toContain(`LIKE ('% ' || $12 || ' %')`);
  });
  it('leaves the board unnarrowed when no titles are watched', async () => {
    await listBoardFiltered({ ...FILTER, titles: [] });
    const [, countParams] = query.mock.calls[0];
    expect(countParams).toHaveLength(11);
    expect(query.mock.calls[1][0]).toContain('LIMIT $12 OFFSET $13');
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

describe('listBoardAgeHistogram', () => {
  it('asks the database for the distribution, not the rows', async () => {
    // The plot is a histogram; the old query read every row (13,302 / 4.8 MB)
    // to build it. This asks Postgres to GROUP BY age and never selects a row's
    // heavy columns or, indeed, the rows.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram('2026-09-18');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('GROUP BY days');
    expect(sql).not.toMatch(/\bj\.description\b/);
    expect(sql).not.toContain('LIMIT');
    // The sweep day is the "to" end of every age, bound not interpolated.
    expect(params).toEqual(['2026-09-18']);
  });

  it('mirrors ageOf: killed rows age to their kill date, and the strict first-seen guard', async () => {
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram('2026-09-18');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("j.status = 'killed'");
    expect(sql).toContain('k.killed_on::date');
    expect(sql).toContain('k.first_published::date');
    expect(sql).toContain('j.first_seen::date < $1::date');
  });

  it('reads the buckets and the axis max out of one result set', async () => {
    query.mockResolvedValue({
      rows: [
        { days: 2, rows: 3, rep_company: 'Acme', rep_title: 'Engineer', rep_published_at: null, axis_max: null },
        { days: 40, rows: 1, rep_company: 'Globex', rep_title: 'Designer', rep_published_at: null, axis_max: null },
        // The rollup row (days null) carries the axis max over every measured row.
        { days: null, rows: 0, rep_company: null, rep_title: null, rep_published_at: null, axis_max: 900 }
      ]
    });
    const hist = await listBoardAgeHistogram('2026-09-18');
    expect(hist.byDay).toHaveLength(2);
    expect(hist.byDay[0]).toMatchObject({ days: 2, rows: 3, repCompany: 'Acme', repTitle: 'Engineer' });
    expect(hist.axisMax).toBe(900);
    expect(hist.total).toBe(4);
  });
});
