import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import PostingProgress from './PostingProgress.astro';
import type { StoredPostingFetch } from '../../lib/posting-fetch-store';

const T0 = Date.parse('2026-09-10T10:00:00.000Z');
function row(over: Partial<StoredPostingFetch> = {}): StoredPostingFetch {
  return {
    id: 'x', applicationId: 42, url: 'https://jobs.ashbyhq.com/writer/1234', urlKey: 'https://jobs.ashbyhq.com/writer/1234',
    status: 'pending', origin: null, sourceKind: null, title: 'Designer', company: 'Writer', descriptionHtml: null,
    finalUrl: null, httpStatus: null, failureCode: null, fetchedAt: null, claimedAt: null, completedAt: null,
    createdAt: new Date(T0), machineNotes: {}, ...over
  };
}
async function render(r: StoredPostingFetch, nowMs = T0 + 1000): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(PostingProgress, {
    props: { row: r, nowMs, action: '/jobs/desk/posting', statusUrl: '/jobs/desk/job-draft/added-42/status' }
  });
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

describe('PostingProgress.astro', () => {
  it('reading, before the claim: names the host, the board, and the plan, with the ring on the wake line', async () => {
    const html = await render(row());
    expect(html).toContain('data-progress-state="reading"');
    expect(html).toContain('data-status-url="/jobs/desk/job-draft/added-42/status"');
    expect(html).toContain('Reading the posting from jobs.ashbyhq.com');
    expect(html).toContain('Waking the machine.');
    expect(html).toContain('This posting lives on Ashby. Asking Ashby for it directly');
    expect(html).toContain('Then this page fills in: the role, the company, and the description as published.');
    expect(html).toContain('class="spinner"');
    expect(html).not.toContain('data-step-state="active"');
  });
  it('reading, once claimed: the ring sits beside the first step', async () => {
    const html = await render(row({ status: 'claimed', claimedAt: new Date(T0) }));
    expect(html).toContain('data-step-state="active"');
    expect(html).not.toContain('Waking the machine.');
  });
  it('a plain careers page is read as a page, not asked as a board', async () => {
    const html = await render(row({ url: 'https://www.amazon.jobs/en/jobs/123/designer' }));
    expect(html).toContain('Reading the page itself: its structured data first, then the largest block of prose.');
    expect(html).not.toContain('lives on');
  });
  it('queued and slow append their lines', async () => {
    expect(await render(row(), T0 + 11 * 60 * 1000)).toContain('Still queued.');
    expect(await render(row({ status: 'claimed', claimedAt: new Date(T0) }), T0 + 6 * 60 * 1000)).toContain('taking longer than usual');
  });
  it('unreadable says what stopped it, in words', async () => {
    const html = await render(row({ status: 'unreadable', failureCode: 'timeout' }));
    expect(html).toContain('data-progress-state="unreadable"');
    expect(html).toContain('We could not read that page');
    expect(html).toContain('The page took too long to answer.');
    expect(html).not.toContain('class="spinner"');
  });
  it('ready says how it was read and how long it took, in words, with no ring', async () => {
    const html = await render(
      row({ status: 'ready', origin: 'machine', sourceKind: 'ashby', claimedAt: new Date(T0), completedAt: new Date(T0 + 1200), fetchedAt: new Date(T0 + 1000) })
    );
    expect(html).toContain('data-progress-state="ready"');
    expect(text(html)).toContain("Read from jobs.ashbyhq.com through Ashby's board in a moment.");
    expect(html).not.toContain('class="spinner"');
    expect(html).not.toContain('rename-form');
  });
  it('ready with a learned board says so, and the only numeral wears data-truth', async () => {
    const html = await render(
      row({ status: 'ready', origin: 'machine', sourceKind: 'ashby', machineNotes: { board: { verdict: 'added', name: 'Writer', ats: 'ashby', postingsSeen: 12 } } })
    );
    expect(text(html)).toContain("We had never read Writer's Ashby board before you pasted this. It is on the nightly crawl from tonight : 12 postings read on the first pass.");
    expect(html).toMatch(/<span data-truth="machine"[^>]*>12<\/span>/);
    expect(text(html).replace(/12/, '')).not.toMatch(/\d/);
  });
  it('ready on a known board says the crawl already reads it; other verdicts are silent', async () => {
    const known = await render(row({ status: 'ready', origin: 'machine', sourceKind: 'ashby', machineNotes: { board: { verdict: 'known', name: 'Writer', ats: 'ashby', postingsSeen: null } } }));
    expect(text(known)).toContain("We already read Writer's Ashby board every night.");
    const silent = await render(row({ status: 'ready', origin: 'machine', sourceKind: 'page', machineNotes: { board: { verdict: 'no-board', name: null, ats: null, postingsSeen: null } } }));
    expect(silent).not.toContain('board every night');
    expect(silent).not.toContain('nightly crawl');
  });
  it('pasted says nothing was read', async () => {
    const html = await render(row({ status: 'pasted', origin: 'pasted', sourceKind: 'pasted' }));
    expect(html).toContain('From text you pasted');
    expect(html).toContain('Nothing here was read by the machine');
  });
  it('a settled row missing a name offers the rename form for that name only', async () => {
    const html = await render(row({ status: 'ready', origin: 'machine', sourceKind: 'ashby', company: null }));
    expect(html).toContain('name="intent" value="rename"');
    expect(html).toContain('The page did not name the company.');
    expect(html).toContain('name="companyOverride"');
    expect(html).not.toContain('name="titleOverride"');
  });
  it('carries no dashes', async () => {
    const html = await render(row({ status: 'unreadable', failureCode: 'http_error' }));
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
