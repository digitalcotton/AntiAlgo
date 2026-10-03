import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SQL the paged board sends, checked with no database: the facet rules
// are in the text, every value is bound, the heavy column stays home. The
// statements that need a real Postgres (the tsquery really parses, the counts
// really equal the rows) are in job-store.db.test.ts.
const query = vi.fn();
const release = vi.fn();
vi.mock('./db', () => ({
  // `connect` is the typo path's one connection: it runs inside a transaction
  // so the trigram threshold can be set for it. It shares `query` so the test
  // sees every statement in the order it was sent.
  db: () => ({ query, connect: async () => ({ query, release }) })
}));

import {
  FUZZY_MIN_WORD,
  FUZZY_WORD_THRESHOLD,
  PAY_FLOORS_K,
  SEARCH_MAX_WORDS,
  boardRowsLoadedAt,
  buildSearchQuery,
  compileMatch,
  countBoardTotals,
  foldForSearch,
  listBoardAgeHistogram,
  listBoardFiltered,
  listBoardTitleCandidates
} from './job-store';
import { ISO_COUNTRIES } from './jobs-derived.mjs';

/** A count row as the database returns it: totals, the text total, and the places JSON. */
const COUNT_ROW = { total: 3, text_total: 3, location_all: 3, location_remote: 1, location_onsite: 2, places: { US: 2, '': 1 }, place_all: 3 };

beforeEach(() => {
  query.mockReset();
  release.mockReset();
  query.mockResolvedValue({ rows: [COUNT_ROW] });
});

const FILTER = { q: 'design', location: 'remote', comp: 'all', freshness: 'all', sort: 'fit' as const, page: 2, perPage: 50, sweepDate: '2026-09-11', ageMin: null, ageMax: null };

/** The statements that are SQL about jobs, not the transaction's own: BEGIN, COMMIT, set_config. */
const statements = () =>
  query.mock.calls.filter(([sql]) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(sql)) && !String(sql).includes('set_config'));
/** Two kinds of transaction wrap a statement: the typo path's (the trigram threshold, one connection for
    every statement it runs) and a words statement's own (random_page_cost, one connection each, see
    runStatement). Each BEGINs once and gives its connection back once. */
const transactionsWith = (setting: string) => query.mock.calls.filter(([sql]) => String(sql).includes(`set_config('${setting}'`)).length;
const typoTransactions = () => transactionsWith('pg_trgm.word_similarity_threshold');
const begun = () => query.mock.calls.filter(([sql]) => String(sql) === 'BEGIN').length;

describe('listBoardFiltered', () => {
  it('asks twice over one CTE, binding every value, and pages with LIMIT and OFFSET', async () => {
    const result = await listBoardFiltered(FILTER);
    expect(statements()).toHaveLength(2);
    const [countSql, countParams] = statements()[0];
    const [pageSql, pageParams] = statements()[1];
    // The nineteen shared params: sweep, fresh window, the search tsquery, the
    // three facets, the age range, then country/liveOnly/hasComp, the families
    // ($12, NULL for an unnarrowed board), the pipeline ($13), and the five new
    // filters: the arrangement list ($14), the pay floor ($15), the place's
    // country, region and city ($16 to $18) and the company ($19). liveOnly
    // defaults to TRUE (2026-09-20): a browsed list never carries a killed row.
    // No watched titles, so nothing binds past them. The words' own tsqueries
    // follow the nineteen (db/221): one per word and vector, here the prefix
    // (title and company) and the whole word (anywhere), as $20 and $21.
    const tsquery = "('design' | 'design':*AB)";
    const nineteen = ['2026-09-11', 4, tsquery, 'remote', 'all', 'all', null, null, null, true, false, null, 'all', null, null, null, null, null, null];
    const shared = [...nineteen, "'design':*", "'design'"];
    expect(countParams).toEqual(shared);
    // The page also binds the tier queries and the folded words, for the ladder, then LIMIT and OFFSET.
    expect(pageParams).toEqual([...shared, "'design':*A", "'design':*AB", "'design':*ABC", 'design', 50, 50]);
    expect(countSql).toContain('FILTER (WHERE keep_base AND');
    expect(pageSql).toContain('LIMIT $26 OFFSET $27');
    expect(pageSql).toContain('ORDER BY detail_total DESC, company ASC, title ASC, id ASC');
    expect(result.total).toBe(3);
    expect(result.fuzzy).toBe(false);
    expect(result.counts.location).toEqual({ all: 3, remote: 1, hybrid: 0, onsite: 2, unstated: 0 });
  });
  it('narrows to the watched titles by whole-phrase match, in count and page alike', async () => {
    await listBoardFiltered({ ...FILTER, titles: ['Product Designer'] });
    const [countSql, countParams] = statements()[0];
    const [pageSql, pageParams] = statements()[1];
    // The title normalises to ONE phrase param, bound after the nineteen shared
    // params and the two tsqueries the word "design" binds ($22; it was $20
    // before db/221, and $14 until the stated-facts filters were appended).
    expect(countParams.slice(0, 19)).toHaveLength(19);
    expect(countParams.slice(19, 21)).toEqual(["'design':*", "'design'"]);
    expect(countParams[21]).toBe('product designer');
    expect(countParams).toHaveLength(22);
    // The page binds the four tier values after it ($23 to $26), then LIMIT and OFFSET.
    expect(pageParams.slice(-2)).toEqual([50, 50]);
    expect(pageParams).toHaveLength(28);
    expect(pageSql).toContain('LIMIT $27 OFFSET $28');
    // A normalised, padded whole-phrase LIKE (mirroring ledger-titles.matchesTitle),
    // applied to the facet counts too, so the counts describe the narrowed board.
    expect(pageSql).toContain(String.raw`regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')`);
    expect(pageSql).toContain(`LIKE ('% ' || $22 || ' %')`);
    expect(countSql).toContain(`LIKE ('% ' || $22 || ' %')`);
  });
  it('leaves the board unnarrowed when no titles are watched', async () => {
    await listBoardFiltered({ ...FILTER, titles: [] });
    const [, countParams] = statements()[0];
    expect(countParams).toHaveLength(21);
    expect(statements()[1][0]).toContain('LIMIT $26 OFFSET $27');
    // With no words there are no tier queries to bind: two fewer, then four fewer.
    query.mockClear();
    await listBoardFiltered({ ...FILTER, q: '' });
    expect(statements()[1][0]).toContain('LIMIT $20 OFFSET $21');
  });
  it('narrows to the chosen families, and treats unplaced as the absence it is', async () => {
    await listBoardFiltered({ ...FILTER, families: ['design', 'unplaced'] });
    const [countSql, countParams] = statements()[0];
    // The families bind as ONE array param at $12, so the shape does not change
    // with how many are picked and nothing shifts behind them.
    expect(countParams[11]).toEqual(['design', 'unplaced']);
    expect(countParams).toHaveLength(21); // the nineteen, and the word's two tsqueries
    // 'unplaced' is not a family id: it is matched against a NULL derived_fam,
    // never looked up, so picking it alongside Design returns both.
    expect(countSql).toContain("derived_fam = ANY($12::text[])");
    expect(countSql).toContain("derived_fam IS NULL AND 'unplaced' = ANY($12::text[])");
  });

  it('leaves the board unnarrowed when no family is chosen', async () => {
    await listBoardFiltered({ ...FILTER, families: [] });
    const [, countParams] = statements()[0];
    expect(countParams[11]).toBeNull();
  });

  it('does not count the Field, the pay bands or freshness, and still counts every control the page draws, leave-one-out', async () => {
    await listBoardFiltered({ ...FILTER, families: ['design'] });
    const [countSql] = statements()[0];
    // NOT COMPUTED ANY MORE (2026-10-02, docs/board-speed-plan.md): a count per family, a count per pay band and
    // freshness's three answers were aggregates over every row that nothing read. The Field links under the table
    // were removed, COMP is floors, and freshness never had a control on the strip. This used to pin the family
    // columns; it pins their absence, so they cannot come back as work done for nobody.
    expect(countSql).not.toMatch(/family_/);
    expect(countSql).not.toMatch(/freshness_/);
    expect(countSql).not.toMatch(/"comp_(?:under|\d|300)/);
    expect(countSql).not.toContain("facet_freshness = '");
    // What the page draws is still counted: the pay control's two ends (the floors' Any and Not listed), every
    // floor, the arrangements and the places.
    for (const column of ['AS comp_all', 'AS "comp_not-listed"', 'AS pay_100', 'AS pay_300', 'AS location_remote', 'AS place_all', 'AS places']) {
      expect(countSql, column).toContain(column);
    }
    // The FILTERS they belonged to are untouched: fam=, comp= and freshness= still narrow the board, each as its
    // bit of `miss` (location, pay, freshness, family, place = 1, 2, 4, 8, 16), so the total still respects all
    // five (mask 31) and "every control but location" is still 30.
    expect(countSql).toContain('match_family');
    expect(countSql).toContain('match_freshness');
    const locLine = String(countSql).split('\n').find((l) => l.includes('AS location_remote')) ?? '';
    expect(locLine).toContain('(miss & 30) = 0');
    expect(String(countSql).split('\n').find((l) => l.includes('AS total'))).toContain('(miss & 31) = 0');
    // The flags carry what the counts read and no more: not the family or freshness a row has.
    const flagsBody = String(countSql).slice(String(countSql).indexOf(', flags AS')).split('FROM matched')[0];
    expect(flagsBody).toContain('SELECT facet_location, facet_comp, comp_min, place_countries,');
    expect(flagsBody).not.toContain('derived_fam');
    expect(flagsBody).not.toContain('facet_freshness');
  });

  it('mirrors the TypeScript facet rules in SQL', async () => {
    await listBoardFiltered(FILTER);
    const sql = statements()[1][0] as string;
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
    // The search words are a tsquery over the weighted vector now. `title ILIKE`
    // is gone from the board: it read every row and could not rank. A word is a
    // prefix of the title or company (search_tc, $20) or a whole word anywhere
    // (search, $21): see "TWO INDEXES, ONE PREDICATE".
    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain("search_tc @@ to_tsquery('simple', $20::text) OR j.search @@ to_tsquery('simple', $21::text)");
    expect(sql).toContain('NULL::text AS description');
    expect(sql).not.toMatch(/\bj\.description\b/);
    expect(sql).toContain('regexp_matches');
  });
  it('binds the age range in days and keeps undated rows out of any range that is set', async () => {
    await listBoardFiltered({ ...FILTER, ageMin: 2, ageMax: 7 });
    const [sql, params] = statements()[1];
    expect(params.slice(6, 8)).toEqual([2, 7]);
    expect(sql).toContain('age_days IS NOT NULL');
    expect(sql).toContain('($7::int IS NULL OR age_days >= $7::int)');
    expect(sql).toContain('($8::int IS NULL OR age_days <= $8::int)');
    expect(sql).toContain('WHERE match_q AND match_age');
  });
  it('orders by the allowlisted key for comp and age', async () => {
    await listBoardFiltered({ ...FILTER, sort: 'comp' });
    expect(statements()[1][0]).toContain('ORDER BY comp_top DESC NULLS LAST');
    await listBoardFiltered({ ...FILTER, sort: 'age' });
    expect(statements()[3][0]).toContain('ORDER BY age_days ASC NULLS LAST');
  });
  it('binds no text filter for blank words, and a wildcard a person typed never reaches SQL as a pattern', async () => {
    await listBoardFiltered({ ...FILTER, q: '' });
    expect(statements()[0][1][2]).toBeNull();
    expect(statements()[1][1]).toHaveLength(21);
    query.mockClear();
    await listBoardFiltered({ ...FILTER, q: '50%_x' });
    // `50%_x` is one chunk with punctuation inside it. It is offered as the
    // lexeme Postgres would index it as, QUOTED (so the percent sign and the
    // underscore are inert characters, not wildcards), or as its parts, of which
    // only the one of two letters or more is kept.
    expect(statements()[0][1][2]).toBe("('50%_x' | '50%_x':*AB | ('50'))");
    expect(statements().every(([sql]) => !String(sql).includes('LIKE ($3'))).toBe(true);
  });
});

describe('what the page does with the words', () => {
  it('writes the text predicate twice: as the index-friendly WHERE and as the authoritative flag', async () => {
    await listBoardFiltered(FILTER);
    const sql = statements()[0][0] as string;
    // Postgres can use jobs_search_idx only if the predicate is in base's WHERE
    // next to the literal `status <> 'killed'` the partial index needs; match_q
    // is the same predicate as a column, so deleting the WHERE would change no
    // count, only the time it takes.
    const where = sql.slice(sql.indexOf('WHERE (NOT $10::boolean OR j.status <> \'killed\')'));
    expect(where).toContain("(j.search_tc @@ to_tsquery('simple', $20::text) OR j.search @@ to_tsquery('simple', $21::text))");
    expect(sql).toMatch(/\(b\.search_tc @@ to_tsquery\('simple', \$20::text\) OR b\.search @@ to_tsquery\('simple', \$21::text\)\)\)\) AS match_q/);
    // The small vector is asked first in both, so the row whose title has the word never reads its posting.
    expect(sql.indexOf("j.search_tc @@ to_tsquery('simple', $20::text) OR")).toBeGreaterThan(-1);
  });
  it('materialises the narrow count flags when there are words or a control is set, and not on the bare board', async () => {
    await listBoardFiltered(FILTER);
    expect(statements()[0][0]).toContain('flags AS MATERIALIZED (');
    for (const over of [{ q: '', location: 'hybrid' }, { q: '', remote: ['remote'] }, { q: '', payMin: 150 }, { q: '', comp: '150-200' }, { q: '', freshness: 'fresh' }, { q: '', place: 'GB' }, { q: '', company: 'Figma' }, { q: '', families: ['design'] }, { q: '', ageMax: 7 }]) {
      query.mockClear();
      await listBoardFiltered({ ...FILTER, ...over });
      expect(statements()[0][0], JSON.stringify(over)).toContain('flags AS MATERIALIZED (');
    }
    // The bare board: no words, nothing chosen. Every flag is a constant and the CTE is cheaper inlined.
    query.mockClear();
    await listBoardFiltered({ ...FILTER, q: '', location: 'all' });
    expect(statements()[0][0]).toContain('flags AS NOT MATERIALIZED (');
    // Narrow either way: the count flags carry no row, no description and no search vector.
    const flags = String(statements()[0][0]);
    const select = flags.slice(flags.indexOf('flags AS NOT MATERIALIZED ('), flags.indexOf('FROM matched'));
    expect(select).not.toMatch(/\bsearch(_tc)?\b/);
    expect(select).not.toContain('description');
    expect(select).toContain('AS miss');
  });
  it('does not let a punctuation-only box show the whole board: it matches nothing', async () => {
    await listBoardFiltered({ ...FILTER, q: '!!!' });
    // '' is the bound value, and the predicate is false for it.
    expect(statements()[0][1][2]).toBe('');
    // No words, so no tsquery is bound or run: only $3 is named, and it is not NULL.
    expect(statements()[0][1]).toHaveLength(19);
    expect(statements()[0][0]).toContain('($3::text IS NULL)');
    expect(statements()[0][0]).not.toContain('to_tsquery');
    // ... and it is not a typo: no second pass is tried.
    expect(release).not.toHaveBeenCalled();
  });
  it('ranks every matching row first only for the best-match order', async () => {
    await listBoardFiltered({ ...FILTER, sort: 'best' });
    const best = statements()[1][0] as string;
    // tier, then ts_rank_cd, then Deets, then age, then id: the order IS the rank.
    expect(best).toContain('ranked AS (');
    expect(best).toContain('ts_rank_cd(m.search, tq.q_all) AS rank_n');
    expect(best).toContain('ORDER BY tier_n ASC, rank_n DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC');
    // The tsqueries are parsed once, in a one-row CTE, not once per row.
    expect(best).toContain('tq AS MATERIALIZED (');
    expect(best).toContain("to_tsquery('simple', $22::text) AS q_a");
    query.mockClear();
    // Any other order cuts the page first and asks only its rows which rung they are on.
    await listBoardFiltered({ ...FILTER, sort: 'age' });
    const age = statements()[1][0] as string;
    expect(age).not.toContain('ranked AS (');
    expect(age).toContain('ORDER BY age_days ASC NULLS LAST, company ASC, title ASC, id ASC');
    expect(age).toContain('AS match_tier');
  });
  it('reads best match with no words as the table order, and carries null facts', async () => {
    await listBoardFiltered({ ...FILTER, q: '', sort: 'best' });
    const sql = statements()[1][0] as string;
    expect(sql).toContain('ORDER BY detail_total DESC, company ASC, title ASC, id ASC');
    expect(sql).toContain('NULL::int AS match_tier, NULL::text AS match_field, NULL::float8 AS fuzzy_score');
    expect(sql).not.toContain('tq AS');
  });
  it('breaks a best-match tie on Deets for a reader who can see it, and on age for one who cannot', async () => {
    const orders = (sql: string) => sql.match(/ORDER BY [^\n]+/g) ?? [];
    const WITH = 'ORDER BY tier_n ASC, rank_n DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC';
    const WITHOUT = 'ORDER BY tier_n ASC, rank_n DESC, age_days ASC NULLS LAST, id ASC';
    // The flag left out is a reader who can see Deets: every caller that does not
    // render rows (the counts, the typeahead, the harness) and the signed-in board.
    await listBoardFiltered({ ...FILTER, sort: 'best' });
    const sighted = statements();
    expect(orders(sighted[1][0] as string)).toEqual([WITH, WITH]);
    query.mockClear();
    await listBoardFiltered({ ...FILTER, sort: 'best', deetsVisible: true });
    expect(orders(statements()[1][0] as string)).toEqual([WITH, WITH]);
    query.mockClear();
    // A reader who cannot see Deets (no column, no why panel) is not ordered by it:
    // the page's inner ORDER BY (which cuts the page) and its outer one both drop it.
    await listBoardFiltered({ ...FILTER, sort: 'best', deetsVisible: false });
    const blind = statements();
    expect(orders(blind[1][0] as string)).toEqual([WITHOUT, WITHOUT]);
    // Nothing else about the statement moved: the ranking still reads tier and ts_rank_cd,
    // the page still binds the same values, and the COUNTS are the same statement and the
    // same parameters, because the flag orders rows and counts none.
    expect(blind[1][1]).toEqual(sighted[1][1]);
    expect(blind[0][0]).toBe(sighted[0][0]);
    expect(blind[0][1]).toEqual(sighted[0][1]);
    expect(String(blind[1][0])).toContain('ts_rank_cd(m.search, tq.q_all) AS rank_n');
  });
  it('lets only best match read the flag: the reader\'s own sort is the sort they asked for, with or without Deets', async () => {
    for (const sort of ['age', 'comp'] as const) {
      query.mockClear();
      await listBoardFiltered({ ...FILTER, q: '', sort });
      const sighted = statements()[1][0] as string;
      query.mockClear();
      await listBoardFiltered({ ...FILTER, q: '', sort, deetsVisible: false });
      expect(statements()[1][0]).toBe(sighted);
    }
  });
  it('states the tier ladder in SQL: the title is the words, then every word by weight', async () => {
    await listBoardFiltered({ ...FILTER, sort: 'best' });
    const sql = statements()[1][0] as string;
    expect(sql).toContain("btrim(regexp_replace(lower(f_unaccent(page.title)), '[^[:alnum:]]+', ' ', 'g')) = $25::text THEN 0");
    expect(sql).toContain('page.search @@ tq.q_a THEN 1');
    expect(sql).toContain('page.search @@ tq.q_ab THEN 2');
    expect(sql).toContain('ELSE 3 END AS match_tier');
    // The field is the one that COMPLETES the match: department only when a weight-C check passes.
    expect(sql).toContain("page.search @@ tq.q_abc THEN 'department'");
    expect(sql).toContain("ELSE 'description' END AS match_field");
  });
  it('hands the facts a rank was decided on back on every row', async () => {
    const rows = [
      { id: 'a', match_tier: 0, match_field: 'title', fuzzy_score: null },
      { id: 'b', match_tier: 3, match_field: 'description', fuzzy_score: null }
    ];
    query.mockImplementation(async (sql: string) => ({ rows: String(sql).includes('flags AS') ? [COUNT_ROW] : rows }));
    const result = await listBoardFiltered({ ...FILTER, sort: 'best' });
    expect(result.rows).toEqual(rows);
  });
});

describe('the new filters', () => {
  it('binds the arrangement list, and lets it win over the old single value', async () => {
    await listBoardFiltered({ ...FILTER, location: 'hybrid', remote: ['remote', 'onsite'] });
    let [, params] = statements()[0];
    // The list wins and the single value is bound as `all`: never an AND of two answers.
    expect(params[3]).toBe('all');
    expect(params[13]).toEqual(['remote', 'onsite']);
    expect(statements()[0][0]).toContain('($14::text[] IS NULL OR facet_location = ANY($14::text[]))');
    query.mockClear();
    await listBoardFiltered({ ...FILTER, location: 'hybrid', remote: [] });
    [, params] = statements()[0];
    expect(params[3]).toBe('hybrid');
    expect(params[13]).toBeNull();
    query.mockClear();
    // An unknown kind is dropped, and if nothing is left the old value stands.
    await listBoardFiltered({ ...FILTER, location: 'remote', remote: ['mars'] });
    [, params] = statements()[0];
    expect(params[3]).toBe('remote');
    expect(params[13]).toBeNull();
  });
  it('reads the pay floor the way the Desk does: comp_range.min, a number, at or above it', async () => {
    await listBoardFiltered({ ...FILTER, payMin: 150 });
    const [sql, params] = statements()[0];
    expect(params[14]).toBe(150);
    // The Desk (desk-agg.ts) keeps jsonb_typeof(min) = 'number' AND min >= floor. Here the
    // same figure is read once into comp_min, and a row with none fails any floor.
    expect(sql).toContain("CASE WHEN jsonb_typeof(j.comp_range->'min') = 'number' THEN (j.comp_range->>'min')::numeric END AS comp_min");
    expect(sql).toContain('COALESCE($15::numeric IS NULL OR comp_min >= $15::numeric * 1000, false) AS match_pay');
    // And it is NOT jobs.comp_min_k, which is that figure rounded.
    expect(sql).not.toContain('comp_min_k');
  });
  it('still reads the pay floor the way the Desk reads it, or this test says so', () => {
    // Two pages, one definition: the Desk filters on comp_range.min >= floor and the board adopted
    // that (docs/search-engine-plan.md, decision 3). If desk-agg.ts changes how it reads the floor,
    // this fails, and the board's comp_min (job-store.ts) has to change with it or the two pages
    // will count different things under one label.
    const desk = readFileSync(new URL('./desk-agg.ts', import.meta.url), 'utf8');
    expect(desk).toContain("jsonb_typeof(j.comp_range->'min') = 'number'");
    expect(desk).toContain("(j.comp_range->>'min')::numeric >= $6::numeric");
  });
  it('lets a band win over a floor, and not-listed win over both, so the pay control has one answer', async () => {
    await listBoardFiltered({ ...FILTER, comp: '200-250', payMin: 100 });
    let [, params] = statements()[0];
    expect(params[4]).toBe('200-250');
    expect(params[14]).toBeNull();
    query.mockClear();
    await listBoardFiltered({ ...FILTER, comp: 'all', payMin: 100, compNotListed: true });
    [, params] = statements()[0];
    expect(params[4]).toBe('not-listed');
    expect(params[14]).toBeNull();
    query.mockClear();
    await listBoardFiltered({ ...FILTER, comp: 'all', payMin: 100 });
    [, params] = statements()[0];
    expect(params[4]).toBe('all');
    expect(params[14]).toBe(100);
    query.mockClear();
    // A floor that is not a positive number is no floor.
    for (const bad of [0, -1, Number.NaN, null, undefined]) {
      await listBoardFiltered({ ...FILTER, payMin: bad as number });
      expect(statements().at(-2)![1][14]).toBeNull();
    }
  });
  it('takes a place key apart into country, region and city, and drops one that is not a key', async () => {
    await listBoardFiltered({ ...FILTER, place: 'US-MD/Baltimore' });
    expect(statements()[0][1].slice(15, 18)).toEqual(['US', 'MD', 'Baltimore']);
    query.mockClear();
    await listBoardFiltered({ ...FILTER, place: 'GB' });
    expect(statements()[0][1].slice(15, 18)).toEqual(['GB', null, null]);
    query.mockClear();
    await listBoardFiltered({ ...FILTER, place: "x'; DROP TABLE jobs; --" });
    expect(statements()[0][1].slice(15, 18)).toEqual([null, null, null]);
    const sql = statements()[0][0] as string;
    // The key the filter names, rebuilt from the three parameters in the grammar of place-key.ts, must
    // be among the keys the posting lists (db/222); none of the three is read from a column of its own.
    expect(sql).toContain(
      "$16::text IS NULL OR place_keys @> ARRAY[$16::text || COALESCE('-' || $17::text, '') || COALESCE('/' || $18::text, '')]::text[]"
    );
    expect(sql).not.toContain('place_country');
    expect(sql).not.toContain('place_admin1');
    expect(sql).not.toContain('place_city');
  });
  it('binds place=unstated as the country, as the literal the predicate tests for, in the count and the page alike', async () => {
    await listBoardFiltered({ ...FILTER, q: '', place: 'unstated' });
    for (const [, params] of statements()) expect((params as unknown[]).slice(15, 18)).toEqual(['unstated', null, null]);
    const sql = statements()[0][0] as string;
    // Rows that list NO place (an empty place_keys), and only when the keyword is bound: for every
    // other value the key is looked for in the list.
    expect(sql).toContain("CASE WHEN $16::text = 'unstated' THEN cardinality(place_keys) = 0");
    expect(sql).toContain('$16::text IS NULL OR place_keys @> ARRAY[');
    // A place that is set is a control that is set: the count statement stores its flags once.
    expect(sql).toContain('flags AS MATERIALIZED');
    // Near misses are no place at all, never the keyword.
    for (const near of ['Unstated', 'UNSTATED', 'unstated ', 'none', 'unstated/London']) {
      query.mockClear();
      await listBoardFiltered({ ...FILTER, q: '', place: near });
      expect(statements()[0][1].slice(15, 18), near).toEqual([null, null, null]);
    }
  });
  it('lists every country the live board holds, at zero where the filters left none, and never over a counted one', async () => {
    query.mockResolvedValue({ rows: [{ ...COUNT_ROW, places: { US: 5, '': 2 }, place_universe: ['DE', 'FR', 'GB', 'US'] }] });
    const result = await listBoardFiltered(FILTER);
    expect(result.counts.place).toEqual({ countries: { US: 5, DE: 0, FR: 0, GB: 0 }, notStated: 2, all: 3 });
    // A universe that holds a counted country leaves its count alone.
    expect(result.counts.place.countries.US).toBe(5);
    // The row set the words found may be empty, and still every country is listed.
    query.mockResolvedValue({ rows: [{ ...COUNT_ROW, total: 0, places: null, place_all: 0, place_universe: ['DE', 'GB'] }] });
    expect((await listBoardFiltered(FILTER)).counts.place).toEqual({ countries: { DE: 0, GB: 0 }, notStated: 0, all: 0 });
    // Nothing on the board, or a statement that returns no universe: the counted ones, as before.
    query.mockResolvedValue({ rows: [{ ...COUNT_ROW, places: { US: 2, '': 1 }, place_universe: null }] });
    expect((await listBoardFiltered(FILTER)).counts.place).toEqual({ countries: { US: 2 }, notStated: 1, all: 3 });
  });
  it('reads the list of countries off the live rows, as names and not as counts, beside the one CTE', async () => {
    await listBoardFiltered(FILTER);
    const sql = statements()[0][0] as string;
    // One probe of the GIN index on place_keys per ISO code, each ending at its first live row: the
    // literal predicate is what lets Postgres use the partial index. The codes are written from
    // jobs-derived.mjs's own list, all 250 of them, never from input.
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM jobs WHERE status <> 'killed' AND place_keys @> ARRAY[c])");
    const codes = /unnest\(ARRAY\[((?:'[A-Z]{2}',?)+)\]::text\[\]\) AS c/.exec(sql)?.[1].match(/[A-Z]{2}/g) ?? [];
    expect(codes).toHaveLength(250);
    expect(codes).toEqual([...ISO_COUNTRIES]);
    expect(sql).toContain('AS place_universe');
    // It takes no part in any number: the places are still counted from the CTE's flags, over every
    // control but the place, and the universe is read from `jobs`, never from them.
    // Grouped by the short place_countries string first and split after, so the flags carry that string
    // and not the array it is taken from (db/223): the flags select the string, and nothing counts keys.
    expect(sql).toContain('FROM (SELECT place_countries, count(*)::int AS n FROM flags WHERE keep_base AND (miss & 15) = 0 GROUP BY 1) g');
    expect(sql).toContain("LEFT JOIN LATERAL unnest(string_to_array(nullif(g.place_countries, ''), ' ')) AS u(c) ON true");
    expect(sql).not.toContain('unnest(f.place_keys)');
    const flagsBody = sql.slice(sql.indexOf(', flags AS')).split('FROM matched')[0];
    expect(flagsBody).toContain('place_countries');
    expect(flagsBody).not.toContain('place_keys');
    expect(sql.split('place_universe')[0].split('\n').at(-1)).not.toContain('flags');
    // It binds nothing, so the statement's parameters did not move.
    expect(statements()[0][1]).toHaveLength(21);
  });
  it('binds the company as an exact match, trimmed, and not at all when blank', async () => {
    await listBoardFiltered({ ...FILTER, company: ' Figma ' });
    expect(statements()[0][1][18]).toBe('Figma');
    expect(statements()[0][0]).toContain('($19::text IS NULL OR company = $19::text) AS match_company');
    query.mockClear();
    await listBoardFiltered({ ...FILTER, company: '   ' });
    expect(statements()[0][1][18]).toBeNull();
  });
  it('counts the new options leave-one-out over the same rows, and returns them beside the old ones', async () => {
    query.mockResolvedValue({
      rows: [
        {
          ...COUNT_ROW,
          location_hybrid: 4, location_unstated: 5,
          comp_all: 9, 'comp_not-listed': 6, pay_100: 3, pay_150: 2, pay_200: 1, pay_250: 1, pay_300: 0,
          places: { US: 5, GB: 3, '': 2 },
          // Nine, not ten: the posting that lists both the US and Britain is in both counts and once here.
          place_all: 9
        }
      ]
    });
    const result = await listBoardFiltered(FILTER);
    const sql = statements()[0][0] as string;
    // The arrangement counts are the same expression under two names.
    expect(result.counts.remote).toEqual(result.counts.location);
    expect(result.counts.remote).toEqual({ all: 3, remote: 1, hybrid: 4, onsite: 2, unstated: 5 });
    // The pay floors are cumulative, from comp_min, with the pay control left out (mask 29).
    for (const k of PAY_FLOORS_K) {
      const line = sql.split('\n').find((l) => l.includes(`AS pay_${k}`)) ?? '';
      expect(line).toContain(`comp_min >= ${k * 1000}`);
      expect(line).toContain('(miss & 29) = 0');
    }
    expect(result.counts.pay).toEqual({ any: 9, notListed: 6, floors: { '100': 3, '150': 2, '200': 1, '250': 1, '300': 0 } });
    // The places come from the same statement as one JSON object; '' is "no place listed". Worldwide
    // is counted on its own (the place control left out), not added up from the countries.
    expect(result.counts.place).toEqual({ countries: { US: 5, GB: 3 }, notStated: 2, all: 9 });
    expect(sql).toContain('WHERE keep_base AND (miss & 15) = 0 GROUP BY 1');
    expect(sql.split('\n').find((l) => l.includes('AS place_all'))).toContain('keep_base AND (miss & 15) = 0');
    // The age strip answers to the same words, pay, place and company: one keep clause.
    query.mockClear();
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram({ q: '', sweepDate: '2026-09-18', payMin: 150, place: 'GB', company: 'Figma', remote: ['remote'] });
    const strip = statements()[0];
    expect(String(strip[0])).toContain('match_pay');
    expect(String(strip[0])).toContain('match_place');
    expect(String(strip[0])).toContain('match_company');
    expect(strip[1]).toEqual(expect.arrayContaining([150, 'GB', 'Figma', ['remote']]));
  });
});

describe('the typo path', () => {
  const THRESHOLD = String(FUZZY_WORD_THRESHOLD);

  /** An exact miss and then whatever the typo path says. */
  function exactMissThen(fuzzyTotal: number) {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.includes('set_config')) return { rows: [] };
      const fuzzy = text.includes('<% j.title');
      if (text.includes('flags AS')) return { rows: [{ ...COUNT_ROW, total: fuzzy ? 7 : 0, text_total: fuzzy ? fuzzyTotal : 0, places: fuzzy ? { US: 7 } : null, place_all: fuzzy ? 7 : 0 }] };
      return { rows: [{ id: fuzzy ? 'close' : 'none', match_tier: null, match_field: fuzzy ? 'title' : null, fuzzy_score: fuzzy ? 0.524 : null }], params };
    });
  }

  it('runs when the words match nothing on the board, in one transaction, with the threshold set for it', async () => {
    exactMissThen(7);
    const result = await listBoardFiltered({ ...FILTER, q: 'prodct desiner', sort: 'best' });
    expect(result.fuzzy).toBe(true);
    expect(result.total).toBe(7);
    expect(result.counts.place).toEqual({ countries: { US: 7 }, notStated: 0, all: 7 });
    expect(result.rows[0]).toMatchObject({ id: 'close', match_tier: null, match_field: 'title', fuzzy_score: 0.524 });
    const sent = query.mock.calls.map(([sql]) => String(sql));
    // BEGIN, the threshold as a TRANSACTION-LOCAL setting (bound, not interpolated), the statements, COMMIT.
    expect(sent.indexOf('BEGIN')).toBeGreaterThan(-1);
    const config = query.mock.calls.find(([sql]) => String(sql).includes("set_config('pg_trgm.word_similarity_threshold'"))!;
    expect(String(config[0])).toContain("set_config('pg_trgm.word_similarity_threshold', $1, true)");
    expect(config[1]).toEqual([THRESHOLD]);
    expect(sent.at(-1)).toBe('COMMIT');
    expect(typoTransactions()).toBe(1);
    // Every transaction opened was closed and its connection given back: the typo path's and the exact attempts'.
    expect(release).toHaveBeenCalledTimes(begun());
    // Every long word must be similar to the title on its own; the phrase is only the score.
    const fuzzyCount = query.mock.calls.find(([sql]) => String(sql).includes('<% j.title'))!;
    expect(String(fuzzyCount[0])).toContain('$21::text <% j.title AND $22::text <% j.title');
    expect(fuzzyCount[1].slice(2, 3)).toEqual(['prodct desiner']);
    expect(fuzzyCount[1].slice(19)).toEqual([null, 'prodct', 'desiner']);
    expect(String(fuzzyCount[0])).toContain('word_similarity($3::text, b.title) + similarity($3::text, b.title)');
    // ... and the best-match order in this mode is the similarity.
    const fuzzyPage = query.mock.calls.filter(([sql]) => String(sql).includes('<% j.title') && !String(sql).includes('flags AS'))[0];
    expect(String(fuzzyPage[0])).toContain('ORDER BY text_sim DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC');
    expect(String(fuzzyPage[0])).toContain("NULL::int AS match_tier, 'title'::text AS match_field, page.text_sim AS fuzzy_score");
  });
  it('orders the typo path by similarity and then age, with no Deets, for a reader who cannot see Deets', async () => {
    exactMissThen(7);
    await listBoardFiltered({ ...FILTER, q: 'prodct desiner', sort: 'best', deetsVisible: false });
    const page = query.mock.calls.filter(([sql]) => String(sql).includes('<% j.title') && !String(sql).includes('flags AS'))[0];
    const orders = String(page[0]).match(/ORDER BY [^\n]+/g);
    expect(orders).toEqual(['ORDER BY text_sim DESC, age_days ASC NULLS LAST, id ASC', 'ORDER BY text_sim DESC, age_days ASC NULLS LAST, id ASC']);
    // Left at its default the same call is ordered as it always was.
    query.mockClear();
    exactMissThen(7);
    await listBoardFiltered({ ...FILTER, q: 'prodct desiner', sort: 'best' });
    const sighted = query.mock.calls.filter(([sql]) => String(sql).includes('<% j.title') && !String(sql).includes('flags AS'))[0];
    expect(String(sighted[0]).match(/ORDER BY [^\n]+/g)).toEqual([
      'ORDER BY text_sim DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC',
      'ORDER BY text_sim DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC'
    ]);
  });
  it('sends the words too short to misspell as exact title prefixes in the same statement', async () => {
    exactMissThen(1);
    await listBoardFiltered({ ...FILTER, q: 'sr prodct desiner' });
    const fuzzyCount = query.mock.calls.find(([sql]) => String(sql).includes('<% j.title'))!;
    expect(fuzzyCount[1].slice(19)).toEqual(["'sr':*A", 'prodct', 'desiner']);
    expect(String(fuzzyCount[0])).toContain("$20::text IS NULL OR j.search @@ to_tsquery('simple', $20::text)");
  });
  it('is not tried when the words matched something exactly', async () => {
    await listBoardFiltered({ ...FILTER, q: 'prodct desiner' });
    expect(typoTransactions()).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('<% j.title'))).toBe(false);
  });
  it('is not tried for words with nothing long enough to misspell, nor for no words', async () => {
    query.mockResolvedValue({ rows: [{ ...COUNT_ROW, text_total: 0 }] });
    for (const q of ['c++ r', 'sr dev', '', '!!!']) {
      await listBoardFiltered({ ...FILTER, q });
    }
    expect(typoTransactions()).toBe(0);
    expect(FUZZY_MIN_WORD).toBe(5);
  });
  it('gives the empty exact answer back, unflagged, when the typo path finds nothing either', async () => {
    exactMissThen(0);
    const result = await listBoardFiltered({ ...FILTER, q: 'xqzvw rkt' + 'abc' });
    expect(result.fuzzy).toBe(false);
    expect(result.rows[0]).toMatchObject({ id: 'none' });
    expect(result.total).toBe(0);
    // Its transaction still ended cleanly and gave its connection back.
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('COMMIT');
    expect(typoTransactions()).toBe(1);
    expect(release).toHaveBeenCalledTimes(begun());
  });
  it('rolls back and releases the connection when a statement fails, and the error is the caller\'s', async () => {
    query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('<% j.title')) throw new Error('boom');
      if (text.includes('flags AS')) return { rows: [{ ...COUNT_ROW, text_total: 0 }] };
      return { rows: [] };
    });
    await expect(listBoardFiltered({ ...FILTER, q: 'prodct desiner' })).rejects.toThrow('boom');
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(begun());
  });
  it('decides the age strip the same way, and draws it over the population the table shows', async () => {
    // The strip asks "did the words find anything" with the table's own test (text_total).
    query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text.includes('set_config')) return { rows: [] };
      if (text.includes('AS text_total')) return { rows: [{ text_total: text.includes('<% j.title') ? 5 : 0 }] };
      return { rows: [{ days: null, rows: 0, axis_max: 3 }] };
    });
    const hist = await listBoardAgeHistogram({ sweepDate: '2026-09-18', q: 'prodct desiner' });
    const strip = query.mock.calls.filter(([sql]) => String(sql).includes('GROUP BY days'));
    expect(strip).toHaveLength(1);
    expect(String(strip[0][0])).toContain('<% j.title');
    expect(hist.axisMax).toBe(3);
    // With exact matches, it stays exact and never opens a transaction.
    query.mockClear();
    release.mockClear();
    query.mockImplementation(async (sql: string) => (String(sql).includes('AS text_total') ? { rows: [{ text_total: 9 }] } : { rows: [] }));
    await listBoardAgeHistogram({ sweepDate: '2026-09-18', q: 'designer' });
    expect(typoTransactions()).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('<% j.title'))).toBe(false);
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

  /** The statement that draws the strip, whatever else was asked on the way to it. */
  const strip = () => query.mock.calls.find(([sql]) => String(sql).includes('GROUP BY days'))!;

  it('asks the database for the distribution, not the rows', async () => {
    // The plot is a histogram; the old query read every row (13,302 / 4.8 MB)
    // to build it. This asks Postgres to GROUP BY age and never selects a row's
    // heavy columns or, indeed, the rows.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql, params] = strip();
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
    const [sql, params] = strip();
    for (const clause of ['match_q', 'match_location', 'match_comp', 'match_freshness', 'match_family', 'match_live', 'match_pipeline']) {
      expect(sql).toContain(clause);
    }
    expect(params).toContain('remote');
    expect(params).toContainEqual(['design']);
    // The words reach it as the same tsquery the table's statements bind.
    expect(params).toContain("('nurse' | 'nurse':*AB)");
  });

  it('does NOT apply the age range, because the strip is what sets it', async () => {
    // Applying its own selection would collapse the plot to the chosen band
    // and leave no handle to widen it again.
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql, params] = strip();
    const measured = String(sql).slice(String(sql).indexOf(', measured AS ('));
    expect(measured).not.toContain('match_age');
    // $7 and $8 are the range, bound null.
    expect((params as unknown[])[6]).toBeNull();
    expect((params as unknown[])[7]).toBeNull();
  });

  it('mirrors ageOf: killed rows age to their kill date, and the strict first-seen guard', async () => {
    query.mockResolvedValue({ rows: [] });
    await listBoardAgeHistogram(AGE);
    const [sql] = strip();
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
    query.mockResolvedValue({ rows: [{ total: 0, text_total: 1, location_all: 0, location_remote: 0, location_onsite: 0 }] });
    await listBoardFiltered({ ...FILTER, ...(pipeline ? { pipeline } : {}) });
    return { sql: String(statements()[0][0]), params: statements()[0][1] as unknown[] };
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
    // The counts read it through `keep_base`, which folds every flag that is not
    // a control, match_pipeline among them.
    const { sql } = await run('only');
    expect(sql).toContain('match_pipeline');
    const keepBase = sql.match(/COALESCE\(([^]*?), false\) AS keep_base/)?.[1] ?? '';
    expect(keepBase).toContain('match_pipeline');
  });

  it('binds after the shared params, so the title and LIMIT slots still line up', async () => {
    // The watched-titles clause and LIMIT/OFFSET derive their indices from
    // shared.length. Appending is safe; inserting would silently renumber them.
    const { params } = await run('only');
    expect(params[12]).toBe('only');
    expect(params.length).toBeGreaterThanOrEqual(13);
  });
});

describe('foldForSearch: text the way the vector holds it', () => {
  it('lower-cases and folds accents like f_unaccent folds them, including the letters Unicode does not decompose', () => {
    expect(foldForSearch('Zürich')).toBe('zurich');
    expect(foldForSearch('Müller')).toBe('muller');
    expect(foldForSearch('Straße')).toBe('strasse');
    expect(foldForSearch('Ærø Øresund Łódź Đà Nẵng Þór')).toBe('aero oresund lodz da nang thor');
    expect(foldForSearch('Œuvre ŉ Ŋ ĳ')).toBe("oeuvre 'n n ij");
    expect(foldForSearch('İstanbul')).toBe('istanbul');
    // Full-width Latin letters and digits, which unaccent.rules maps to ASCII.
    expect(foldForSearch('ＩＴ２０２６')).toBe('it2026');
  });
  it('leaves alone what unaccent leaves alone: Cyrillic й, Hangul syllables, kana with a voicing mark', () => {
    // Postgres keeps these as written. Folding them would make a query that
    // can never match the vector it is run against (62 mismatches on the
    // board's own characters were found before this was written this way).
    expect(foldForSearch('Инженер й')).toBe('инженер й');
    expect(foldForSearch('개발자 용')).toBe('개발자 용');
    expect(foldForSearch('パート ダ')).toBe('パート ダ');
    expect(foldForSearch('工程师')).toBe('工程师');
    expect(foldForSearch('Ελληνικά')).toBe('ελληνικα');
  });
  it('turns control, format and half-broken characters into spaces and cuts at the cap', () => {
    expect(foldForSearch('a\u0000b')).toBe('a b');
    expect(foldForSearch('a\u200db')).toBe('a b');
    expect(foldForSearch('a\ud800b')).toBe('a b');
    expect(foldForSearch('x'.repeat(500))).toHaveLength(200);
    expect(foldForSearch(undefined as unknown as string)).toBe('');
  });
});

describe('buildSearchQuery: the words, as a tsquery nobody can inject into', () => {
  it('writes every word as a whole word anywhere or a prefix of a title or company word, ANDed', () => {
    const sq = buildSearchQuery('senior product designer')!;
    expect(sq.all).toBe("('senior' | 'senior':*AB) & ('product' | 'product':*AB) & ('designer' | 'designer':*AB)");
    // The ladder: the same words, each alternative held to a weight.
    expect(sq.a).toBe("'senior':*A & 'product':*A & 'designer':*A");
    expect(sq.ab).toBe("'senior':*AB & 'product':*AB & 'designer':*AB");
    expect(sq.abc).toBe("'senior':*ABC & 'product':*ABC & 'designer':*ABC");
    expect(sq.phrase).toBe('senior product designer');
  });
  it('never lets a prefix reach the description: `:*AB`, not a bare `:*`', () => {
    // `desi:*` alone matched 12,644 live rows through "desired" in descriptions.
    const sq = buildSearchQuery('desi')!;
    expect(sq.all).toBe("('desi' | 'desi':*AB)");
    for (const form of [sq.all, sq.a, sq.ab, sq.abc]) expect(form).not.toMatch(/:\*(?![ABC])/);
  });
  it('matches a word of two letters whole, and drops a word of one unless it is all there is', () => {
    expect(buildSearchQuery('hr manager')!.all).toBe("'hr' & ('manager' | 'manager':*AB)");
    expect(buildSearchQuery('hr')!.a).toBe("'hr':A");
    // "a designer" is "designer"; "c" and "r" are languages and are searched.
    expect(buildSearchQuery('a designer')!.all).toBe("('designer' | 'designer':*AB)");
    expect(buildSearchQuery('c')!.all).toBe("'c'");
    expect(buildSearchQuery('c r')!.all).toBe("'c' & 'r'");
    expect(buildSearchQuery('c')!.fuzzy).toBeNull();
  });
  it('keeps what Postgres keeps whole: node.js, ai/ml, u.s, v2.0, and the hyphen as both', () => {
    // 3,947 of 37,286 live titles have a dot or slash between letters; the vector
    // holds `ai/ml`, so a query split on every non-letter looks for `ai` and `ml`
    // and the title typed in full would not find itself.
    expect(buildSearchQuery('ai/ml')!.all).toBe("('ai/ml' | 'ai/ml':*AB | ('ai' & 'ml'))");
    expect(buildSearchQuery('node.js')!.all).toBe("('node.js' | 'node.js':*AB | (('node' | 'node':*AB) & 'js'))");
    expect(buildSearchQuery('u.s.')!.all).toBe("('u.s' | 'u.s':*AB)");
    expect(buildSearchQuery('R&D')!.all).toBe("('r&d' | 'r&d':*AB)");
    expect(buildSearchQuery('full-stack')!.all).toBe("('full-stack' | 'full-stack':*AB | (('full' | 'full':*AB) & ('stack' | 'stack':*AB)))");
    expect(buildSearchQuery('ai/ml')!.a).toBe("('ai/ml':*A | ('ai':A & 'ml':A))");
  });
  it('folds accents and case, and says so in the phrase the title is compared with', () => {
    const sq = buildSearchQuery('Zürich STRAßE')!;
    expect(sq.all).toBe("('zurich' | 'zurich':*AB) & ('strasse' | 'strasse':*AB)");
    expect(sq.phrase).toBe('zurich strasse');
    expect(buildSearchQuery('C++ Developer')!.phrase).toBe('c developer');
  });
  it('reads each word once, and at most SEARCH_MAX_WORDS of them', () => {
    expect(buildSearchQuery('designer Designer DESIGNER')!.all).toBe("('designer' | 'designer':*AB)");
    const many = Array.from({ length: 25 }, (_, i) => `word${String.fromCharCode(97 + i)}x`).join(' ');
    expect((buildSearchQuery(many)!.all.match(/ & /g) ?? []).length + 1).toBe(SEARCH_MAX_WORDS);
  });
  it('is null when there is no word to search', () => {
    for (const text of ['', '   ', '!!!', '- + &', '()', '***', '\u0000', '\u200d']) {
      expect(buildSearchQuery(text), JSON.stringify(text)).toBeNull();
    }
  });
  it('quotes every lexeme: a quote is doubled and a backslash is escaped', () => {
    expect(buildSearchQuery("d'angelo")!.all).toBe("('d''angelo' | 'd''angelo':*AB | (('angelo' | 'angelo':*AB)))");
    expect(buildSearchQuery('ab\\cd')!.all).toBe("('ab\\\\cd' | 'ab\\\\cd':*AB | ('ab' & 'cd'))");
  });
  it('turns the operators a person might type into words, never into tsquery syntax', () => {
    // Take out every quoted lexeme (a quote opens one; the quote doubled and the
    // backslash escape stay inside it) and what is left may be only the structure
    // this file writes: brackets, & and |, the weights and the prefix star.
    const quoted = /'(?:[^'\\]|''|\\.)*'/gu;
    const structure = (text: string) => text.replace(quoted, 'Q');
    const hostile = [
      'a & b', 'a | b', '!a', '!!', '(a)', '((', '))', 'a:*', ':*', 'a:A', 'a<->b', 'a <2> b', "a'b", "'", "''", "'''", '\\', '\\\\', "\\'",
      'foo:*bar & (baz | !qux)', "'; DROP TABLE jobs; --", '" OR 1=1', 'a\u0000b', '\ud800', '\udc00x', 'x\u202ey', '%_', '$1', '${x}', '`', '<script>',
      'ab&cd', 'ab|cd', 'ab!cd', 'ab(cd)ef', 'ab:*cd', "ab'cd", 'ab\\cd', 'ab<->cd', 'u.s.a.', 'e-mail', 'a--b', '+++a', '1/2', '24/7', '🚀 rocket 🚀', '　全角　スペース'
    ];
    // Plus 400 seeded strings drawn from the characters that mean something to tsquery.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = "ab AB 12 &|!():*'\\\"<>-./_@#$%^+=[]{}~`\t\n,;?é字";
    for (let i = 0; i < 400; i++) hostile.push(Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
    let built = 0;
    for (const text of hostile) {
      const sq = buildSearchQuery(text);
      if (sq === null) continue;
      built += 1;
      for (const form of [sq.all, sq.a, sq.ab, sq.abc]) {
        const bare = structure(form);
        // Outside the quotes there is only structure, and the brackets balance.
        expect(bare.replace(/[Q()&|:*ABC\s]/g, ''), `${JSON.stringify(text)} -> ${form}`).toBe('');
        expect((bare.match(/\(/g) ?? []).length, form).toBe((bare.match(/\)/g) ?? []).length);
        // Every quoted lexeme holds something, and nothing is left unquoted that should be: no stray quote.
        for (const lexeme of form.matchAll(quoted)) expect(lexeme[0].length).toBeGreaterThan(2);
        expect(bare).not.toContain("'");
      }
      // A NUL cannot be sent to Postgres at all.
      expect(JSON.stringify(sq)).not.toContain('\\u0000');
    }
    expect(built).toBeGreaterThan(300);
  });
  it('hands the typo path the words long enough to misspell, and the short ones as title prefixes', () => {
    expect(buildSearchQuery('prodct desiner')!.fuzzy).toEqual({ tokens: ['prodct', 'desiner'], short: null });
    expect(buildSearchQuery('sr prodct')!.fuzzy).toEqual({ tokens: ['prodct'], short: "'sr':*A" });
    // Nothing of five letters or more: nothing to correct.
    expect(buildSearchQuery('hr it ops')!.fuzzy).toBeNull();
    expect(buildSearchQuery('full-stak dev')!.fuzzy).toBeNull();
    // The typo path reads words, not chunks: a hyphenated word is its parts.
    expect(buildSearchQuery('full-stack')!.fuzzy).toEqual({ tokens: ['stack'], short: "'full':*A" });
  });
});

describe('the match: a tree of tsqueries over two vectors, so two indexes can answer it (db/221)', () => {
  const VECTORS = { search: 'search', tc: 'search_tc' };
  const compiled = (text: string, first = 20) => {
    const match = compileMatch(buildSearchQuery(text)!.match, first);
    return { params: match.params, sql: match.sql(VECTORS).replace(/\n\s*/g, ' ') };
  };
  const atom = (vector: string, n: number) => `${vector} @@ to_tsquery('simple', $${n}::text)`;

  it('writes a long word as its prefix in the small vector OR itself in the whole one, the cheap probe first', () => {
    const { params, sql } = compiled('designer');
    expect(params).toEqual(["'designer':*", "'designer'"]);
    expect(sql).toBe(`(${atom('search_tc', 20)} OR ${atom('search', 21)})`);
  });
  it('ANDs the words, each its own pair, numbered from where the caller says', () => {
    const { params, sql } = compiled('product des', 22);
    expect(params).toEqual(["'product':*", "'product'", "'des':*", "'des'"]);
    expect(sql).toBe(`((${atom('search_tc', 22)} OR ${atom('search', 23)}) AND (${atom('search_tc', 24)} OR ${atom('search', 25)}))`);
  });
  it('searches a word of two letters, or the one letter of "c", as a whole word only: a prefix of that length is almost any word', () => {
    expect(compiled('ab')).toEqual({ params: ["'ab'"], sql: `(${atom('search', 20)})`.slice(1, -1) });
    expect(compiled('c').params).toEqual(["'c'"]);
    expect(compiled('a designer').params).toEqual(["'designer':*", "'designer'"]);
  });
  it('offers a chunk with punctuation as its whole lexeme, that as a prefix, or all of its parts', () => {
    const { params, sql } = compiled('ai/ml');
    expect(params).toEqual(["'ai/ml':*", "'ai/ml'", "'ai'", "'ml'"]);
    expect(sql).toBe(`(${atom('search_tc', 20)} OR ${atom('search', 21)} OR (${atom('search', 22)} AND ${atom('search', 23)}))`);
  });
  it('binds a tsquery once however many places name it', () => {
    const { params } = compiled('node.js node');
    expect(params).toEqual(["'node.js':*", "'node.js'", "'node':*", "'node'", "'js'"]);
    expect(new Set(params).size).toBe(params.length);
  });
  it('is the same words as `all`: every lexeme `all` names is a lexeme the tree names, and the other way round', () => {
    for (const text of ['senior product designer', 'ai/ml', 'node.js node', 'full-stack', "d'angelo a\\b", 'r&d u.s. v2.0', '50%_x', 'c', 'ab cd']) {
      const sq = buildSearchQuery(text)!;
      const named = (q: string) => new Set([...q.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]));
      const inAll = named(sq.all);
      const inTree = named(compileMatch(sq.match, 1).params.join(' '));
      expect([...inTree].sort(), text).toEqual([...inAll].sort());
    }
  });
});

describe('the planner is told the heap is cheap for a statement that carries words, and for no other', () => {
  const settingCalls = () => query.mock.calls.filter(([sql]) => String(sql).includes("set_config('random_page_cost'"));

  it('brackets the count and the page, each on its own connection, in BEGIN, a bound transaction-local setting, and COMMIT', async () => {
    await listBoardFiltered(FILTER);
    expect(settingCalls()).toHaveLength(2);
    for (const [sql, params] of settingCalls()) {
      expect(String(sql)).toBe("SELECT set_config('random_page_cost', $1, true)");
      expect(params).toEqual(['1.1']);
    }
    const sent = query.mock.calls.map(([sql]) => String(sql));
    // Each statement is preceded by its BEGIN and setting and followed by its COMMIT; the two overlap, so only the counts are fixed.
    expect(sent.filter((x) => x === 'BEGIN')).toHaveLength(2);
    expect(sent.filter((x) => x === 'COMMIT')).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
    const firstSetting = sent.findIndex((x) => x.includes("set_config('random_page_cost'"));
    expect(sent.indexOf('BEGIN')).toBeLessThan(firstSetting);
    expect(sent.findIndex((x) => x.includes('flags AS'))).toBeGreaterThan(firstSetting);
    expect(sent.lastIndexOf('COMMIT')).toBe(sent.length - 1);
  });
  it('leaves a board with no words, and the words that are only punctuation, to plan as they always did', async () => {
    for (const q of ['', '!!!']) {
      query.mockClear();
      release.mockClear();
      await listBoardFiltered({ ...FILTER, q });
      expect(query.mock.calls.map(([sql]) => String(sql)).filter((x) => x === 'BEGIN' || x.includes('set_config')), JSON.stringify(q)).toEqual([]);
      expect(release).not.toHaveBeenCalled();
    }
  });
  it('sets it for the age strip, the title completions and the suggestion counts, which carry the same words', async () => {
    await listBoardAgeHistogram({ sweepDate: '2026-09-18', q: 'designer' });
    expect(settingCalls().length).toBeGreaterThanOrEqual(1);
    query.mockClear();
    await listBoardTitleCandidates({ ...FILTER, q: 'des' }, 8);
    expect(settingCalls()).toHaveLength(1);
    query.mockClear();
    query.mockResolvedValue({ rows: [{ t0: 3 }] });
    await countBoardTotals([{ ...FILTER, q: 'designer' }]);
    expect(settingCalls()).toHaveLength(1);
    // Filters with no words at all share a statement that has none of this.
    query.mockClear();
    await countBoardTotals([{ ...FILTER, q: '', place: 'GB' }]);
    expect(settingCalls()).toHaveLength(0);
  });
  it('counts place=unstated with the same predicate the board applies, and narrows to the rows that list no place', async () => {
    query.mockResolvedValue({ rows: [{ t0: 4, t1: 9 }] });
    const totals = await countBoardTotals([
      { ...FILTER, q: '', place: 'unstated' },
      { ...FILTER, q: '', place: 'GB' }
    ]);
    expect(totals).toEqual([4, 9]);
    const [sql, params] = statements()[0];
    // The suggestion's own predicate is the board's (placeMatchSql), so its count cannot drift from the table's.
    expect(String(sql)).toContain("CASE WHEN $20::text = 'unstated' THEN cardinality(place_keys) = 0");
    expect(params).toEqual(expect.arrayContaining(['unstated', 'GB']));
    // Bound after the nineteen shared parameters, three a place: the first filter's, then the second's.
    expect((params as unknown[]).slice(19, 25)).toEqual(['unstated', null, null, 'GB', null, null]);
    // Without words the statement reads only the rows the places can match: an empty-array test for this
    // one, and for the other the array-contains probe the GIN index on place_keys answers.
    expect(String(sql)).toContain("(place_keys = '{}') OR (place_keys @> ARRAY[$23::text || COALESCE('-' || $24::text, '') || COALESCE('/' || $25::text, '')]::text[])");
  });
  it('does not set it for the typo path, whose predicate is a trigram one on its own connection', async () => {
    query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text.includes('set_config')) return { rows: [] };
      return { rows: [{ ...COUNT_ROW, text_total: text.includes('<% j.title') ? 5 : 0 }] };
    });
    await listBoardFiltered({ ...FILTER, q: 'prodct desiner' });
    const fuzzyStarts = query.mock.calls.map(([sql], at) => [String(sql), at] as const).filter(([sql]) => sql.includes('pg_trgm'));
    expect(fuzzyStarts).toHaveLength(1);
    // After the typo path's own setting, no planner setting is sent on that connection.
    const after = query.mock.calls.slice(fuzzyStarts[0][1] + 1).map(([sql]) => String(sql));
    expect(after.some((x) => x.includes('random_page_cost'))).toBe(false);
  });
  it('rolls back and gives the connection back when the statement fails, and the error is the caller\'s', async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('flags AS')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(listBoardFiltered(FILTER)).rejects.toThrow('boom');
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(begun());
  });
});
