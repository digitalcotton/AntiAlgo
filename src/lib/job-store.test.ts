import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SQL the paged board sends, checked with no database: the facet rules
// are in the text, every value is bound, the heavy column stays home.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

import { boardRowsLoadedAt, likePattern, listBoardAgeHistogram, listBoardFiltered } from './job-store';

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
    // The twelve shared params: sweep, fresh window, search, the three facets,
    // the age range, then country/liveOnly/hasComp, then the families ($12,
    // NULL for an unnarrowed board). liveOnly defaults to TRUE (2026-09-20): a
    // browsed list never carries a killed row. No watched titles, so nothing
    // binds past them.
    expect(countParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, true, false, null, 'all']);
    expect(pageParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, true, false, null, 'all', 50, 50]);
    expect(countSql).toContain('FILTER (WHERE match_age AND');
    expect(pageSql).toContain('LIMIT $14 OFFSET $15');   // +1 since db/218
    expect(pageSql).toContain('ORDER BY detail_total DESC, company ASC, title ASC, id ASC');
    expect(result.total).toBe(3);
    expect(result.counts.location).toEqual({ all: 3, remote: 1, hybrid: 0, onsite: 2, unstated: 0 });
  });
  it('narrows to the watched titles by whole-phrase match, in count and page alike', async () => {
    await listBoardFiltered({ ...FILTER, titles: ['Product Designer'] });
    const [countSql, countParams] = query.mock.calls[0];
    const [pageSql, pageParams] = query.mock.calls[1];
    // The title normalises to ONE phrase param, bound after the thirteen shared
    // params ($14 since db/218 appended the pipeline filter).
    expect(countParams).toEqual(['2026-09-11', 4, '%design%', 'remote', 'all', 'all', null, null, null, true, false, null, 'all', 'product designer']);
    // Then limit and offset shift past the phrase.
    expect(pageParams.slice(-2)).toEqual([50, 50]);
    expect(pageSql).toContain('LIMIT $15 OFFSET $16');   // +1 since db/218
    // A normalised, padded whole-phrase LIKE (mirroring ledger-titles.matchesTitle),
    // applied to the facet counts too, so the counts describe the narrowed board.
    expect(pageSql).toContain(String.raw`regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')`);
    expect(pageSql).toContain(`LIKE ('% ' || $14 || ' %')`);
    expect(countSql).toContain(`LIKE ('% ' || $14 || ' %')`);
  });
  it('leaves the board unnarrowed when no titles are watched', async () => {
    await listBoardFiltered({ ...FILTER, titles: [] });
    const [, countParams] = query.mock.calls[0];
    expect(countParams).toHaveLength(13);   // 13 since db/218 appended the pipeline filter
    expect(query.mock.calls[1][0]).toContain('LIMIT $14 OFFSET $15');   // +1 since db/218
  });
  it('narrows to the chosen families, and treats unplaced as the absence it is', async () => {
    await listBoardFiltered({ ...FILTER, families: ['design', 'unplaced'] });
    const [countSql, countParams] = query.mock.calls[0];
    // The families bind as ONE array param at $12, so the shape does not change
    // with how many are picked and nothing shifts behind them.
    expect(countParams[11]).toEqual(['design', 'unplaced']);
    expect(countParams).toHaveLength(13);   // 13 since db/218 appended the pipeline filter
    // 'unplaced' is not a family id: it is matched against a NULL derived_fam,
    // never looked up, so picking it alongside Design returns both.
    expect(countSql).toContain("derived_fam = ANY($12::text[])");
    expect(countSql).toContain("derived_fam IS NULL AND 'unplaced' = ANY($12::text[])");
  });

  it('leaves the board unnarrowed when no family is chosen', async () => {
    await listBoardFiltered({ ...FILTER, families: [] });
    const [, countParams] = query.mock.calls[0];
    expect(countParams[11]).toBeNull();
  });

  it('counts each family leave-one-out, so a count is what that option would leave', async () => {
    await listBoardFiltered({ ...FILTER, families: ['design'] });
    const [countSql] = query.mock.calls[0];
    // Every other facet count respects match_family; the family counts do not,
    // or picking Design would make every family count read as Design's own.
    // The identifier is quoted because a family id carries a hyphen
    // (social-care, public-safety, it-infra, data-ai).
    expect(countSql).toContain('AS "family_design"');
    expect(countSql).toContain('AS "family_social-care"');
    expect(countSql).toContain('AS family_unplaced');
    expect(countSql).toContain('AS family_all');
    const famLine = String(countSql).split('\n').find((l) => l.includes('AS "family_design"')) ?? '';
    expect(famLine).not.toContain('match_family');
  });

  it('mirrors the TypeScript facet rules in SQL', async () => {
    await listBoardFiltered(FILTER);
    const sql = query.mock.calls[1][0] as string;
    // Four answers, and the remote flag is READ. A regression here is the
    // 2,650-row hole this fixed: the text test alone filed every posting whose
    // applicant system flagged it remote while naming a city as on-site.
    expect(sql).toContain(String.raw`j.location ~* '\yhybrid\y' THEN 'hybrid'`);
    expect(sql).toContain(String.raw`j.remote OR j.location ~* '\yremote\y' THEN 'remote'`);
    expect(sql).toContain("btrim(j.location) = '' THEN 'unstated'");
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
  const AGE: Parameters<typeof listBoardAgeHistogram>[0] = {
    q: '',
    location: 'all',
    comp: 'all',
    freshness: 'all',
    sweepDate: '2026-09-18'
  };

  it('asks the database for the distribution, not the rows', async () => {
    // The plot is a histogram; the old query read every row (13,302 / 4.8 MB)
    // to build it. This asks Postgres to GROUP BY age and never selects a row's
    // heavy columns or, indeed, the rows.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('GROUP BY days');
    expect(sql).not.toMatch(/\bj\.description\b/);
    expect(sql).not.toContain('LIMIT');
    // The sweep day is the "to" end of every age, bound not interpolated.
    expect((params as unknown[])[0]).toBe('2026-09-18');
  });

  it('is drawn over the reader\'s board, not over the whole sweep', async () => {
    // The 2026-09-28 fix. The strip used to take the sweep date and nothing
    // else, so it said "36,457 of 36,457" above a Field dropdown counting
    // 1,463. Every narrowing the rows get, it gets.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram({ ...AGE, location: 'remote', families: ['design'], q: 'nurse' });
    const [sql, params] = query.mock.calls[0];
    for (const clause of ['match_q', 'match_location', 'match_comp', 'match_freshness', 'match_family', 'match_live']) {
      expect(sql).toContain(clause);
    }
    expect(params).toContain('remote');
    expect(params).toContainEqual(['design']);
    expect(params).toContain('%nurse%');
  });

  it('does NOT apply the age range, because the strip is what sets it', async () => {
    // Applying its own selection would collapse the plot to the chosen band
    // and leave no handle to widen it again.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql, params] = query.mock.calls[0];
    const measured = String(sql).slice(String(sql).indexOf(', measured AS ('));
    expect(measured).not.toContain('match_age');
    // $7 and $8 are the range, bound null.
    expect((params as unknown[])[6]).toBeNull();
    expect((params as unknown[])[7]).toBeNull();
  });

  it('mirrors ageOf: killed rows age to their kill date, and the strict first-seen guard', async () => {
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("j.status = 'killed'");
    expect(sql).toContain('k.killed_on::date');
    expect(sql).toContain('k.first_published::date');
    expect(sql).toContain('j.first_seen < $1::date');
    // Live rows only: it is the board's own match_live now, not a hard WHERE.
    expect(sql).toContain("NOT $10::boolean OR status = 'live'");
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
    const hist = await listBoardAgeHistogram(AGE);
    expect(hist.byDay).toHaveLength(2);
    expect(hist.byDay[0]).toMatchObject({ days: 2, rows: 3, repCompany: 'Acme', repTitle: 'Engineer' });
    expect(hist.axisMax).toBe(900);
    expect(hist.total).toBe(4);
  });
});

describe('boardRowsLoadedAt', () => {
  // The board's rows and the nightly sweep are two different clocks, and the
  // stamp above the table has to be the rows' one. See the function's own
  // header; these are the shapes that actually reach it.
  const row = (swept_at: unknown) =>
    ({ boards_swept: 1666, verified_live: 37306, killed: 0, killed_by_rule: 0, postings_observed: 39306, swept_at }) as never;

  it('hands back an ISO instant when the driver returns a Date', () => {
    // node-postgres maps a timestamp column to a Date. Left alone it
    // stringifies into the attribute as "Mon Sep 28 2026 13:43:00 GMT+0000
    // (Coordinated Universal Time)", which is what the home page shipped.
    expect(boardRowsLoadedAt(row(new Date('2026-09-28T13:43:00Z')))).toBe('2026-09-28T13:43:00.000Z');
  });

  it('passes an ISO string through unchanged', () => {
    expect(boardRowsLoadedAt(row('2026-09-28T13:43:00Z'))).toBe('2026-09-28T13:43:00Z');
  });

  it('is null when there is no row, no stamp, or an unparseable one', () => {
    // Null rather than a fallback instant: the caller decides what to do
    // without an answer, and this function never invents one. A wrong
    // timestamp here reads as fresh, which is the failure being prevented.
    expect(boardRowsLoadedAt(null)).toBeNull();
    expect(boardRowsLoadedAt(row(null))).toBeNull();
    expect(boardRowsLoadedAt(row(''))).toBeNull();
    expect(boardRowsLoadedAt(row('not a date'))).toBeNull();
  });

  it('never returns the sweep instant in place of the rows instant', () => {
    // The regression in one line: these two are both real and both parse, and
    // for part of 2026-09-30 the pages printed the sweep's over the crawl's.
    const rowsInstant = '2026-09-28T13:43:00Z';
    const sweepInstant = '2026-09-30T01:23:55Z';
    expect(boardRowsLoadedAt(row(rowsInstant))).toBe(rowsInstant);
    expect(boardRowsLoadedAt(row(rowsInstant))).not.toBe(sweepInstant);
  });
});

describe('the pipeline filter (db/218)', () => {
  // Evergreen talent pools. Nothing reads this off the URL yet; these tests are
  // what make it safe to start.
  const run = async (pipeline?: 'all' | 'only' | 'exclude') => {
    query.mockReset();
    query.mockResolvedValue({ rows: [{ total: 0, location_all: 0, location_remote: 0, location_onsite: 0 }] });
    await listBoardFiltered({ ...FILTER, ...(pipeline ? { pipeline } : {}) });
    return { sql: String(query.mock.calls[0][0]), params: query.mock.calls[0][1] as unknown[] };
  };

  it('binds all as the default, so a caller that says nothing changes nothing', async () => {
    const { params } = await run();
    expect(params[12]).toBe('all');
  });

  it('keeps only pooled rows for only, and everything else for exclude', async () => {
    const { sql } = await run('only');
    expect(sql).toContain("$13::text = 'only' AND pipeline IS TRUE");
    expect(sql).toContain("$13::text = 'exclude' AND pipeline IS NOT TRUE");
  });

  it('treats a feed that never said as NOT a pool, so exclude keeps it', async () => {
    // IS NOT TRUE and not <> TRUE: in SQL, NULL <> true is NULL, which filters
    // the row out. Every board except Apple stores null here, so the wrong
    // operator would empty the board down to Apple's non-pool rows.
    const { sql } = await run('exclude');
    expect(sql).toContain('pipeline IS NOT TRUE');
    expect(sql).not.toMatch(/pipeline\s*<>\s*TRUE/i);
  });

  it('is respected by the facet counts, not just the page', async () => {
    // A count that ignored it would offer a reader a filter combination that
    // returns nothing, which is the defect the age range was already fixed for.
    const { sql } = await run('only');
    expect(sql).toContain('match_pipeline');
    const counts = sql.slice(sql.indexOf('count(*)'));
    expect(counts).toContain('match_pipeline');
  });

  it('binds after the shared params, so the title and LIMIT slots still line up', async () => {
    // The watched-titles clause and LIMIT/OFFSET derive their indices from
    // shared.length. Appending is safe; inserting would silently renumber them.
    const { params } = await run('only');
    expect(params[12]).toBe('only');
    expect(params.length).toBeGreaterThanOrEqual(13);
  });
});
