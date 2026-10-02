/**
 * board-jobs.test.ts: a board row the kill record names becomes the same closed
 * Job the design /role pages render, and a live row is untouched by the change.
 *
 * Since 2026-09-08 the ingest joins each board row to board_kills (db/030) and
 * writes status 'killed' with the kill of record. This proves the adapter maps
 * that to status 'closed' with closed_on and closed_reason read off the kill,
 * that last_verified is the crawl's own clock (last_seen) rather than the design
 * sweep's, and that the store's fallback row shape (a kill whose posting has
 * left the feed) renders closed with no fabricated facts.
 */
import { describe, expect, it } from 'vitest';
import { boardRowToJob, killPipelineLabel, matchFactsOf, rankFactsOf, type BoardMatchColumns, type BoardRow } from './board-jobs';
import { ageOf, sourceLabel, sweepDate } from './data';

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'greenhouse|123',
    slug: 'acme-senior-product-designer-abc123',
    company: 'Acme',
    title: 'Senior Product Designer',
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    location: 'Remote',
    country: 'US',
    remote: true,
    published: '2026-08-20T09:00:00.000Z',
    ats: 'greenhouse',
    posting_id: '123',
    department: 'Design',
    comp_posted: null,
    comp_range: null,
    days_up: 19,
    first_seen: '2026-08-30',
    last_seen: '2026-09-08',
    detail_total: 80,
    detail_components: { title_scope: 30, remote_geo: 25, comp: 0, freshness: 15, apply_friction: 10 },
    source: 'tracked',
    description: '<p>Own the design system.</p>',
    status: 'live',
    kill_id: null,
    kill_rule: null,
    kill_reason: null,
    killed_on: null,
    kill_first_published: null,
    kill_pipeline: null,
    ...over
  };
}

describe('boardRowToJob', () => {
  it('a live row is live, verified on the night the crawl last saw it', () => {
    const job = boardRowToJob(row());
    expect(job.status).toBe('live');
    expect(job.last_verified).toBe('2026-09-08');
    expect(job.closed_on).toBeUndefined();
    expect(job.closed_reason).toBeUndefined();
    expect(job.apply_url).toBe('https://boards.greenhouse.io/acme/jobs/123');
  });

  it('a row the record names is closed, with the kill\'s own date and reason', () => {
    const job = boardRowToJob(
      row({
        status: 'killed',
        kill_id: 'abc123def456',
        kill_rule: 'repost_churn',
        kill_reason: 'repost-churn: this posting is dated 2026-09-02 and its title, location ... identical',
        killed_on: '2026-09-06',
        kill_pipeline: 'sweep'
      })
    );
    expect(job.status).toBe('closed');
    expect(job.closed_on).toBe('2026-09-06');
    expect(job.closed_reason).toMatch(/^repost-churn:/);
    // Nothing else about the row is rewritten: the facts stay the employer's.
    expect(job.title).toBe('Senior Product Designer');
    expect(job.published_date).toBe('2026-08-20');
  });

  it('the store\'s fallback row (posting gone from the feed) renders closed with honest absences', () => {
    const job = boardRowToJob(
      row({
        id: null as unknown as string,
        url: 'https://boards.greenhouse.io/acme/jobs/999',
        location: null,
        country: null,
        remote: false,
        published: null,
        posting_id: null,
        department: null,
        days_up: null,
        first_seen: '2026-07-01',
        last_seen: '2026-09-07',
        detail_total: 0,
        detail_components: null,
        description: null,
        status: 'killed',
        kill_id: 'fedcba987654',
        kill_rule: 'phantom',
        kill_reason: 'phantom: the posting returns HTTP 404 at source, confirmed on a second request',
        killed_on: '2026-09-07',
        kill_first_published: '2026-07-01',
        kill_pipeline: 'crawl'
      })
    );
    expect(job.status).toBe('closed');
    expect(job.closed_on).toBe('2026-09-07');
    expect(job.published_date).toBe('2026-07-01');
    expect(job.location).toBe('Not stated');
    expect(job.description_html).toBeNull();
    expect(job.fit.total).toBe(0);
    expect(job.last_verified).toBe('2026-09-07');
  });

  it('a kill date the record does not hold leaves closed_on unset rather than invented', () => {
    const job = boardRowToJob(row({ status: 'killed', kill_id: 'x', kill_rule: 'zombie', kill_reason: 'zombie: ...', killed_on: null }));
    expect(job.status).toBe('closed');
    expect(job.closed_on).toBeUndefined();
    expect(job.closed_reason).toBe('zombie: ...');
  });
});

describe('boardRowToJob: source_system, a board this file does not flatten', () => {
  it('a Phase C adapter (breezy) maps to itself and labels as its brand, not "the company site"', () => {
    const job = boardRowToJob(row({ ats: 'breezy', url: 'https://alectrona-llc.breezy.hr/p/123' }));
    expect(job.source_system).toBe('breezy');
    expect(sourceLabel(job)).toBe('Breezy HR');
  });

  it('every Phase C adapter reads as its own brand', () => {
    const brands: Record<string, string> = {
      teamtailor: 'Teamtailor',
      personio: 'Personio',
      icims: 'iCIMS',
      recruitee: 'Recruitee',
      breezy: 'Breezy HR',
      bamboohr: 'BambooHR'
    };
    for (const [ats, brand] of Object.entries(brands)) {
      const job = boardRowToJob(row({ ats }));
      expect(job.source_system).toBe(ats);
      expect(sourceLabel(job)).toBe(brand);
    }
  });

  it('an ats this file has never named still passes through, title-cased, rather than becoming "the company site"', () => {
    const job = boardRowToJob(row({ ats: 'some_future_board' }));
    expect(job.source_system).toBe('some_future_board');
    expect(sourceLabel(job)).toBe('Some Future Board');
  });

  it('an empty ats still becomes \'custom\' and still labels "the company site"', () => {
    const job = boardRowToJob(row({ ats: '' }));
    expect(job.source_system).toBe('custom');
    expect(sourceLabel(job)).toBe('the company site');
  });

  it('a null-ish ats (the store\'s own shape allows it) becomes \'custom\' the same way', () => {
    const job = boardRowToJob(row({ ats: null as unknown as string }));
    expect(job.source_system).toBe('custom');
    expect(sourceLabel(job)).toBe('the company site');
  });
});

describe('killPipelineLabel', () => {
  it('names the two machines and defaults to the sweep', () => {
    expect(killPipelineLabel('crawl')).toBe('the wide crawl');
    expect(killPipelineLabel('sweep')).toBe('the verified sweep');
    expect(killPipelineLabel(null)).toBe('the verified sweep');
  });
});

/**
 * THE MATCH FACTS ride beside the Job, not on it. A text search adds three
 * columns to a row (job-store.ts BoardListRow); the Job type has no place for
 * them and every other consumer of boardRowToJob (the Desk, the draft room)
 * must keep getting exactly the Job it always got.
 */
describe('boardRowToJob: the match facts travel beside the Job', () => {
  const matched = (over: BoardMatchColumns = {}): BoardRow & BoardMatchColumns => ({
    ...row(),
    match_tier: 1,
    match_field: 'title',
    fuzzy_score: null,
    ...over
  });

  it('records the three columns a text search adds, readable from the Job', () => {
    const job = boardRowToJob(matched({ match_tier: 3, match_field: 'description' }));
    expect(matchFactsOf(job)).toEqual({ tier: 3, field: 'description', fuzzyScore: null });
    const typo = boardRowToJob(matched({ match_tier: null, match_field: 'title', fuzzy_score: 0.52 }));
    expect(matchFactsOf(typo)).toEqual({ tier: null, field: 'title', fuzzyScore: 0.52 });
  });

  it('records a row whose three columns are present but null (no words typed): it still has its sort to say', () => {
    const job = boardRowToJob({ ...row(), match_tier: null, match_field: null, fuzzy_score: null });
    expect(matchFactsOf(job)).toEqual({ tier: null, field: null, fuzzyScore: null });
  });

  it('a row that never carried the columns records nothing, so it draws no line', () => {
    expect(matchFactsOf(boardRowToJob(row()))).toBeNull();
  });

  it('leaves the Job exactly as it was: the same record with or without the columns', () => {
    expect(boardRowToJob(matched())).toEqual(boardRowToJob(row()));
    expect(Object.keys(boardRowToJob(matched()))).toEqual(Object.keys(boardRowToJob(row())));
    expect(JSON.stringify(boardRowToJob(matched()))).toBe(JSON.stringify(boardRowToJob(row())));
  });

  it('works as a bare Array.map callback, which hands it the index as a second argument', () => {
    const jobs = [matched({ match_tier: 0 }), matched({ match_tier: 2, match_field: 'company' })].map(boardRowToJob);
    expect(jobs.map((j) => matchFactsOf(j)?.tier)).toEqual([0, 2]);
  });

  it('keys the facts to the Job object, so two rows with one id do not share them', () => {
    const a = boardRowToJob(matched({ match_tier: 1 }));
    const b = boardRowToJob(matched({ match_tier: 3, match_field: 'description' }));
    expect(matchFactsOf(a)?.tier).toBe(1);
    expect(matchFactsOf(b)?.tier).toBe(3);
  });
});

describe('rankFactsOf: the facts the ranked-because line is worded from', () => {
  const ctx = { sort: 'best' as const, position: 28, query: 'product designer' };
  const matched = (over: Partial<BoardRow> & BoardMatchColumns = {}) => ({
    ...row(),
    match_tier: 1,
    match_field: 'title' as const,
    fuzzy_score: null,
    ...over
  });

  it('carries the position, the sort, the words, the rung and the Deets', () => {
    const job = boardRowToJob(matched({ detail_total: 91 }));
    expect(rankFactsOf(job, ctx)).toMatchObject({
      position: 28,
      sort: 'best',
      query: 'product designer',
      tier: 1,
      field: 'title',
      fuzzy: false,
      fuzzyScore: null,
      deets: 91
    });
  });

  it('is on the typo path exactly when the row carries a similarity', () => {
    const typo = rankFactsOf(boardRowToJob(matched({ match_tier: null, fuzzy_score: 0.44 })), ctx);
    expect(typo).toMatchObject({ fuzzy: true, fuzzyScore: 0.44, tier: null });
    expect(rankFactsOf(boardRowToJob(matched()), ctx)?.fuzzy).toBe(false);
  });

  it('reads the age the Age cell reads, and says whether it was posted or first seen', () => {
    const posted = boardRowToJob(matched({ published: '2026-08-20T09:00:00.000Z' }));
    expect(rankFactsOf(posted, ctx)).toMatchObject({ ageDays: ageOf(posted)?.days, ageBasis: 'posted' });
    const seen = boardRowToJob(matched({ published: null, first_seen: '2000-01-01' }));
    expect(rankFactsOf(seen, ctx)).toMatchObject({ ageDays: ageOf(seen)?.days, ageBasis: 'first_seen' });
    expect(ageOf(seen)?.days).toBeGreaterThan(1000);
  });

  it('a row with no date to count from has no age', () => {
    const undated = boardRowToJob(matched({ published: null, first_seen: sweepDate() }));
    expect(ageOf(undated)).toBeNull();
    expect(rankFactsOf(undated, ctx)?.ageDays).toBeNull();
  });

  it('pay is stated when the pay SORT can read a figure (comp_top), not when a range merely exists', () => {
    expect(rankFactsOf(boardRowToJob(matched({ comp_posted: '$150k-$180k' })), ctx)?.payStated).toBe(true);
    expect(rankFactsOf(boardRowToJob(matched({ comp_posted: null })), ctx)?.payStated).toBe(false);
    expect(rankFactsOf(boardRowToJob(matched({ comp_posted: 'Competitive' })), ctx)?.payStated).toBe(false);
    // A structured range with no posted text: the cell shows a figure, but the
    // pay sort's key (comp_top) is null, so the row really does sort last.
    const rangeOnly = matched({ comp_posted: null, comp_range: { min: 120000, max: 150000, currency: 'USD', interval: 'year', source: 'ats' } });
    expect(rankFactsOf(boardRowToJob(rangeOnly), ctx)?.payStated).toBe(false);
  });

  it('is null for a Job that never carried match facts', () => {
    expect(rankFactsOf(boardRowToJob(row()), ctx)).toBeNull();
  });
});
