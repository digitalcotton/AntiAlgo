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
import { boardRowToJob, killPipelineLabel, type BoardRow } from './board-jobs';
import { sourceLabel } from './data';

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
    fit_total: 80,
    fit_components: { title_scope: 30, remote_geo: 25, comp: 0, freshness: 15, apply_friction: 10 },
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
        fit_total: 0,
        fit_components: null,
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
