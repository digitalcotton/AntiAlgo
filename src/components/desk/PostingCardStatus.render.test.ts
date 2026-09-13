import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import PostingCardStatus from './PostingCardStatus.astro';
import type { StoredPostingFetch } from '../../lib/posting-fetch-store';

const T0 = Date.parse('2026-09-10T10:00:00.000Z');
function row(over: Partial<StoredPostingFetch> = {}): StoredPostingFetch {
  return {
    id: 'x', applicationId: 42, url: 'https://jobs.lever.co/acme/1', urlKey: 'https://jobs.lever.co/acme/1',
    status: 'pending', origin: null, sourceKind: null, title: null, company: null, descriptionHtml: null,
    finalUrl: null, httpStatus: null, failureCode: null, fetchedAt: null, claimedAt: null, completedAt: null,
    createdAt: new Date(T0), machineNotes: {}, ...over
  };
}
async function render(r: StoredPostingFetch, draft: 'none' | 'pending' | 'ready' | 'failed', nowMs = T0 + 1000): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(PostingCardStatus, {
    props: { row: r, draft, detailHref: '/jobs/board/added-42', roomHref: '/jobs/desk/job-draft/added-42', nowMs }
  });
}

describe('PostingCardStatus.astro', () => {
  it('is one line with no form and no refresh, whatever the state', async () => {
    for (const r of [row(), row({ status: 'unreadable', failureCode: 'no_content' }), row({ status: 'ready', origin: 'machine', sourceKind: 'lever' })]) {
      const html = await render(r, 'none');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('http-equiv');
      expect(html.match(/<p /g)).toHaveLength(1);
    }
  });
  it('reading points at the posting page to watch it land', async () => {
    const html = await render(row(), 'none');
    expect(html).toContain('data-card-status="reading"');
    expect(html).toContain('Reading the posting from jobs.lever.co.');
    expect(html).toContain('href="/jobs/board/added-42"');
  });
  it('unreadable sends the person to paste on the posting', async () => {
    const html = await render(row({ status: 'unreadable', failureCode: 'no_content' }), 'none');
    expect(html).toContain('We could not read that page.');
    expect(html).toContain('Paste the text on the posting');
  });
  it('ready with no draft says where it was read and points at the posting to draft', async () => {
    const html = await render(row({ status: 'ready', origin: 'machine', sourceKind: 'lever' }), 'none');
    expect(html).toContain('Read from jobs.lever.co.');
    expect(html).toContain('Open the posting');
    expect(html).not.toContain('/jobs/desk/job-draft/added-42');
  });
  it('a ready draft is the only state that links the draft room', async () => {
    const ready = row({ status: 'ready', origin: 'machine', sourceKind: 'lever' });
    expect(await render(ready, 'pending')).toContain('Drafting your resume and cover letter.');
    expect(await render(ready, 'pending')).not.toContain('/jobs/desk/job-draft/added-42');
    const done = await render(ready, 'ready');
    expect(done).toContain('Your draft is ready.');
    expect(done).toContain('href="/jobs/desk/job-draft/added-42"');
    expect(await render(ready, 'failed')).toContain('Try again on the posting');
  });
  it('pasted says so, and unverified', async () => {
    const html = await render(row({ status: 'pasted', origin: 'pasted' }), 'ready');
    expect(html).toContain('From text you pasted. Unverified.');
  });
  it('carries no dashes', async () => {
    expect(await render(row(), 'none', T0 + 11 * 60 * 1000)).not.toMatch(/[\u2013\u2014]/);
  });
});
