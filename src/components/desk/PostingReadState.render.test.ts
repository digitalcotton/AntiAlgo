import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import PostingReadState from './PostingReadState.astro';
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
async function render(r: StoredPostingFetch, nowMs = T0 + 1000): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(PostingReadState, { props: { row: r, action: '/jobs/desk/posting', nowMs } });
}

describe('PostingReadState.astro', () => {
  it('reading: offers the paste box closed, and no retry', async () => {
    const html = await render(row());
    expect(html).toContain('data-read-state="reading"');
    expect(html).toContain('Paste the text instead');
    expect(html).not.toContain('<details class="paste-box" open');
    expect(html).toContain('name="intent" value="paste"');
    expect(html).toContain('name="applicationId" value="42"');
    expect(html).not.toContain('name="intent" value="retry"');
  });
  it('queued after ten minutes still offers the paste box', async () => {
    const html = await render(row(), T0 + 11 * 60 * 1000);
    expect(html).toContain('data-read-state="queued"');
    expect(html).toContain('name="intent" value="paste"');
  });
  it('unreadable opens the paste box and offers a retry', async () => {
    const html = await render(row({ status: 'unreadable', failureCode: 'no_content' }));
    expect(html).toContain('<details class="paste-box" open');
    expect(html).toContain('name="intent" value="retry"');
    expect(html).toContain('name="companyOverride"');
    expect(html).toContain('required');
  });
  it('renders nothing for a settled row: the page already has the text', async () => {
    expect((await render(row({ status: 'ready', origin: 'machine', sourceKind: 'lever' }))).trim()).toBe('');
    expect((await render(row({ status: 'pasted', origin: 'pasted' }))).trim()).toBe('');
  });
  it('carries no dashes in its copy', async () => {
    const html = await render(row(), T0 + 11 * 60 * 1000);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
