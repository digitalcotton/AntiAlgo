import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import PostingBiography from './PostingBiography.astro';
import type { Job } from '../../lib/data';

/**
 * A render test for PostingBiography.astro, MASTER-SPEC F10's "posting
 * biography on the detail page: first seen, published date with basis,
 * lifecycle to date. Repost count renders ONLY when the machine exports it
 * ... until then the slot ships dark behind a flag."
 *
 * The four properties this task's own verification section asks for:
 *
 *   1. The biography renders only fields the data actually holds.
 *   2. A posting missing a first-observed date renders the absence honestly
 *      rather than a guess.
 *   3. The repost slot renders nothing while its flag is dark.
 *   4. (The markdown twin's parity is covered in
 *      test/pages/role-slug-md.render.test.ts, against the same fixture.)
 */

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: '$150k-$180k',
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

async function renderBiography(props: { job: Job }): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(PostingBiography, { props });
}

describe('PostingBiography.astro: only what the record holds, in the recorded shape', () => {
  it('a fully-dated live posting prints its published date, its first-seen date and a live lifecycle line', async () => {
    const html = await renderBiography({ job: job() });
    expect(html).toContain('Posting biography');
    expect(html).toContain('First seen');
    expect(html).toContain('Aug 1, 2026');
    expect(html).toContain('Published date');
    expect(html).toContain('as posted at source');
    expect(html).toContain('Lifecycle to date');
    expect(html).toContain('Live, verified against Greenhouse');
  });

  it('a posting with no published date honestly names first-observed as the basis instead, never a guessed publish date', async () => {
    const html = await renderBiography({
      job: job({ published_date: null, first_observed: '2026-08-01' })
    });
    expect(html).toContain('Not shown at source. Dated from First seen Aug 1, 2026 instead');
  });

  it('a posting missing a first-observed date renders the absence honestly, not a guessed date', async () => {
    const html = await renderBiography({ job: job({ first_observed: null }) });
    expect(html).toContain('Not recorded for this posting');
  });

  it('a closed posting states the closure date, the reason of record, and the confirmed stamp, never an apply-side lifecycle', async () => {
    const html = await renderBiography({
      job: job({
        status: 'closed',
        closed_on: '2026-08-22',
        closed_reason: 'Not on the board in the sweep of 2026-08-23.'
      })
    });
    expect(html).toContain('Closed Aug 22, 2026');
    expect(html).toContain('Not on the board in the sweep of 2026-08-23.');
    expect(html).toContain('confirmed archived');
    expect(html).not.toContain('Live, verified');
  });

  it('a re-verified posting names itself as re-verified, not plain verified', async () => {
    const html = await renderBiography({ job: job({ status: 're_verified' }) });
    expect(html).toContain('Live, re-verified against Greenhouse');
  });

  it('the repost slot renders zero trace while repost_biography stays dark', async () => {
    const html = await renderBiography({ job: job() });
    expect(html).not.toContain('Repost history');
    expect(html).not.toContain('MACHINE-ASKS');
  });

  it('carries no em dash, en dash, or curly quote', async () => {
    const html = await renderBiography({ job: job({ status: 'closed', closed_on: '2026-08-22' }) });
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});
