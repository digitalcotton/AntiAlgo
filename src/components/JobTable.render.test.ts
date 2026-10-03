import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import JobTable from './JobTable.astro';
import type { Job } from '../lib/data';
import { boardRowToJob, type BoardMatchColumns, type BoardRow } from '../lib/board-jobs';
import type { BoardSort } from '../lib/board-query';

/**
 * A render test for JobTable.astro's duplicate-cluster collapse, MASTER-SPEC
 * F10's acceptance line: "Given duplicate postings across locations, When
 * the index renders, Then one clustered row appears with its count stated."
 *
 * Rendered against the real component and its real dependency graph
 * (clusterJobs(), FitBadge, Mark, JobRow, src/lib/data.ts), same technique
 * as JobRow.render.test.ts: nothing here is stubbed.
 */

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: '$150K - $180K',
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01',
    last_verified: '2026-08-23T07:30:02Z',
    published_date: '2026-08-01',
    age_days: 22,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: null,
    ...overrides
  };
}

async function renderTable(props: { jobs: readonly Job[] }): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(JobTable, { props });
}

describe('JobTable.astro: duplicate-cluster collapse renders one row with its count stated', () => {
  it('duplicate postings across locations collapse to one clustered row', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });

    const html = await renderTable({ jobs: [sf, ny] });

    // One row in the DOM, not two: a single <li data-job-row> that carries
    // the cluster class, and only one instance of the location list.
    expect(html).toContain('job-row-cluster');
    expect(html).toContain('San Francisco, New York');

    // The count is stated in plain language and both numbers are the
    // cluster's own derived lengths, never typed.
    expect(html).toMatch(/2\s+postings\s+in\s+2\s+locations/);
  });

  it('expands to a native, scriptless disclosure that contains every original posting and its own link', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco', apply_url: 'https://boards.example.com/acme/sf/apply' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York', apply_url: 'https://boards.example.com/acme/ny/apply' });

    const html = await renderTable({ jobs: [sf, ny] });

    // <details>/<summary>, not a scripted panel: it works with no click
    // listener attached, which is what makes it survive JavaScript being off.
    expect(html).toContain('<details');
    expect(html).toContain('<summary');

    // Every original posting is still in the markup, each with its own real
    // apply link: nothing is hidden or merged away.
    expect(html).toContain('acme-pd-sf');
    expect(html).toContain('acme-pd-ny');
    expect(html).toContain('https://boards.example.com/acme/sf/apply');
    expect(html).toContain('https://boards.example.com/acme/ny/apply');
  });

  it('a title at a different company does not join the cluster', async () => {
    const acme = job({ slug: 'acme-pd', title: 'Product Designer', company: 'Acme Corp', location: 'San Francisco' });
    const globex = job({ slug: 'globex-pd', title: 'Product Designer', company: 'Globex Inc', location: 'San Francisco' });

    const html = await renderTable({ jobs: [acme, globex] });

    expect(html).not.toContain('job-row-cluster');
    expect(html).toContain('acme-pd');
    expect(html).toContain('globex-pd');
  });

  it('a posting with no duplicate renders as an ordinary row with no expander', async () => {
    const html = await renderTable({ jobs: [job()] });

    expect(html).not.toContain('job-row-cluster');
    expect(html).not.toContain('cluster-disclosure');
  });

  it('carries no em dash or en dash anywhere in its output', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });
    const toronto = job({ slug: 'acme-pd-yyz', title: 'Product Designer', location: 'Toronto', comp_posted: null });

    const html = await renderTable({ jobs: [sf, ny, toronto] });

    // Built from code points in this test file for the same reason
    // hygiene.test.ts and record.test.ts do it: the copy gate hard fails on
    // the literal character appearing anywhere this repository authors.
    const emDash = String.fromCodePoint(0x2014);
    const enDash = String.fromCodePoint(0x2013);
    expect(html).not.toContain(emDash);
    expect(html).not.toContain(enDash);
  });
});

describe('JobTable.astro: a clustered row also renders locationDisplay() and the applied tag', () => {
  it('drops a redundant United States from the joined location list, keeping every real location', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco, CA' });
    const us = job({ slug: 'acme-pd-us', title: 'Product Designer', location: 'United States' });

    const html = await renderTable({ jobs: [sf, us] });

    expect(html).toContain('San Francisco, CA');
    // Joined as "San Francisco, CA, United States" before display; the
    // trailing home country drops and leaves no dangling separator.
    expect(html).not.toContain('San Francisco, CA, United States');
  });

  it('gives a clustered row the same data-applied-tag markup an ordinary row carries, off by default', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });

    const html = await renderTable({ jobs: [sf, ny] });

    expect(html).toContain('data-applied-tag');
    const clusterOpenTag = html.match(/<li[^>]*job-row-cluster[^>]*>/)?.[0] ?? '';
    expect(clusterOpenTag).not.toContain('data-applied=');
  });
});

/**
 * THE RANKED-BECAUSE LINE, through the table. A row's rank is its place in the
 * rows the store returned plus the page's offset, never its place among the
 * clustered rows drawn, and the line is drawn only where the table is in a
 * server order and the reader can see Deets.
 */
function boardRow(over: Partial<BoardRow> & BoardMatchColumns = {}): BoardRow & BoardMatchColumns {
  return {
    id: 'greenhouse|1',
    slug: 'acme-product-designer-1',
    company: 'Acme',
    title: 'Product Designer',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    location: 'Remote',
    country: 'US',
    remote: true,
    published: '2026-08-20T09:00:00.000Z',
    ats: 'greenhouse',
    posting_id: '1',
    department: 'Design',
    comp_posted: null,
    comp_range: null,
    days_up: 5,
    first_seen: '2026-08-30',
    last_seen: '2026-09-08',
    detail_total: 80,
    detail_components: { title_scope: 30, remote_geo: 25, comp: 0, freshness: 15, apply_friction: 10 },
    source: 'tracked',
    description: null,
    status: 'live',
    kill_id: null,
    kill_rule: null,
    kill_reason: null,
    killed_on: null,
    kill_first_published: null,
    kill_pipeline: null,
    match_tier: 1,
    match_field: 'title',
    fuzzy_score: null,
    ...over
  };
}

const named = (company: string, title: string, over: Partial<BoardRow> & BoardMatchColumns = {}) =>
  boardRowToJob(boardRow({ id: `greenhouse|${company}|${title}`, slug: `${company}-${title}`.toLowerCase().replace(/\W+/g, '-'), company, title, ...over }));

async function renderRanked(props: {
  jobs: readonly Job[];
  orderedBy?: { sort: BoardSort; offset: number; query?: string };
  paging?: 'server' | 'client';
  fit?: boolean;
}): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(JobTable, { props: { paging: 'server', ...props } });
}

const linesOf = (html: string): string[] =>
  [...html.matchAll(/<p[^>]*data-rank-reason[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/&quot;/g, '"'));

describe('JobTable.astro: each row says why it sits where it sits', () => {
  it('numbers rows by their place in the whole result: the page offset plus their place on the page', async () => {
    const jobs = [
      named('Acme', 'Product Designer', { match_tier: 0 }),
      named('Bolt', 'Senior Product Designer', { match_tier: 1 }),
      named('Cargo', 'Designer', { match_tier: 2, match_field: 'company' })
    ];
    const lines = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'best', offset: 50, query: 'product designer' } }));
    expect(lines).toEqual([
      'Ranked 51st: the title is exactly what you typed, then the closer text match, then Deets 80, then newer first.',
      'Ranked 52nd: every word you typed is in the title, then the closer text match, then Deets 80, then newer first.',
      'Ranked 53rd: every word you typed is in the title or the company name, then the closer text match, then Deets 80, then newer first.'
    ]);
  });

  it('a cluster takes one row but its members keep their own ranks, and the next row is ranked after all of them', async () => {
    const jobs = [
      named('Acme', 'Product Designer'),
      boardRowToJob(boardRow({ id: 'g|b1', slug: 'bolt-pd-sf', company: 'Bolt', title: 'Product Designer', location: 'San Francisco' })),
      boardRowToJob(boardRow({ id: 'g|b2', slug: 'bolt-pd-ny', company: 'Bolt', title: 'Product Designer', location: 'New York' })),
      named('Cargo', 'Product Designer')
    ];
    const html = await renderRanked({ jobs, orderedBy: { sort: 'best', offset: 0, query: 'product designer' } });
    expect(html).toContain('job-row-cluster');
    const places = linesOf(html).map((line) => line.match(/^Ranked (\S+):/)?.[1]);
    // Acme 1st; Bolt's two postings 2nd and 3rd inside their disclosure; Cargo
    // is the fourth row of the result although it is the third row drawn.
    expect(places).toEqual(['1st', '2nd', '3rd', '4th']);
  });

  it('words the sort in force: Deets, pay and age each get their own sentence', async () => {
    const jobs = [named('Acme', 'Product Designer', { comp_posted: '$150k-$180k' })];
    const fit = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'fit', offset: 0 } }));
    expect(fit).toEqual(['Ranked 1st by Deets: 80 of 100, highest first, then company and title A to Z.']);
    const comp = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'comp', offset: 0 } }));
    expect(comp).toEqual(['Ranked 1st by pay: highest posted figure first, then company and title A to Z.']);
    const age = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'age', offset: 0 } }));
    expect(age).toHaveLength(1);
    expect(age[0]).toMatch(/^Ranked 1st by age: posted \d+ days? ago, newest first, then company and title A to Z\.$/);
  });

  it('words a close-spelling row as one', async () => {
    const jobs = [named('Acme', 'Product Designer', { match_tier: null, fuzzy_score: 0.52 })];
    const lines = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'best', offset: 0, query: 'prodct desiner' } }));
    expect(lines).toEqual(['Ranked 1st: a close spelling of "prodct desiner" (similarity 0.52), then Deets 80, then newer first.']);
  });

  it('says its sort when no words were typed (the store reports null for all three columns)', async () => {
    const jobs = [named('Acme', 'Product Designer', { match_tier: null, match_field: null, fuzzy_score: null })];
    const lines = linesOf(await renderRanked({ jobs, orderedBy: { sort: 'best', offset: 25 } }));
    expect(lines).toEqual(['Ranked 26th by Deets: 80 of 100, highest first, then company and title A to Z.']);
  });

  it('draws no line unless the caller says what order the rows are in', async () => {
    const html = await renderRanked({ jobs: [named('Acme', 'Product Designer')] });
    expect(html).not.toContain('rank-reason');
    // The panel element is still there with its Deets breakdown. (Matched as an
    // element: the table's own noscript rule and script also name the attribute.)
    expect(html).toMatch(/<div[^>]*data-why-panel/);
  });

  it('draws no line in a client-paged table, which the browser re-sorts', async () => {
    const html = await renderRanked({ jobs: [named('Acme', 'Product Designer')], paging: 'client', orderedBy: { sort: 'best', offset: 0 } });
    expect(html).not.toContain('rank-reason');
  });

  it('draws no line for a reader who does not see Deets: there is no panel to hold it', async () => {
    const html = await renderRanked({ jobs: [named('Acme', 'Product Designer')], fit: false, orderedBy: { sort: 'best', offset: 0 } });
    expect(html).not.toMatch(/<div[^>]*data-why-panel/);
    expect(html).not.toContain('rank-reason');
  });

  it('draws no line for a Job that did not come from the text-aware read', async () => {
    const html = await renderRanked({ jobs: [job()], orderedBy: { sort: 'best', offset: 0, query: 'designer' } });
    expect(html).not.toContain('rank-reason');
  });

  it('carries no em dash, en dash or curly quote with the lines in', async () => {
    const jobs = [named('Acme', 'Product Designer', { match_tier: null, fuzzy_score: 0.4 }), named('Bolt', 'Designer')];
    const html = await renderRanked({ jobs, orderedBy: { sort: 'best', offset: 0, query: 'prodct desiner' } });
    expect(html).toContain('data-rank-reason');
    for (const codePoint of [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d]) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});
