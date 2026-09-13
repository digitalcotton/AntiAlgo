import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Board from './Board.astro';
import type { FilterGroup, Job } from '../lib/data';
import { DEFAULT_QUERY } from '../lib/board-query';

/**
 * Board.astro's two modes, rendered against the real component. Server mode
 * (the board) holds one page the store sliced, and every control is a form or
 * a link; client mode (the Pre-List) is unchanged and keeps its island pager.
 * Neither mode carries the assurance band's count line or the insight strip.
 */
function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', slug: 'acme-staff-designer', company: 'Acme Corp', title: 'Staff Product Designer', kind: 'posted',
    prospect: null, comp_posted: '$150K - $180K', comp_range: null, published_at: null, location: 'Remote', remote: true,
    source_system: 'greenhouse', source_url: 'https://boards.example.com/acme/1', apply_url: 'https://boards.example.com/acme/1/apply',
    first_observed: '2026-08-01', last_verified: '2026-08-23T07:30:02Z', published_date: '2026-08-01', age_days: 22,
    status: 'live', window: null, risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: null, ...overrides
  };
}
const GROUPS: FilterGroup[] = [
  { key: 'location', label: 'Location', options: [{ value: 'all', label: 'All', count: 3 }, { value: 'remote', label: 'Remote', count: 2 }] }
];
const JOBS = [job(), job({ id: 'job-2', slug: 'acme-lead', title: 'Lead Designer' })];

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Board, { props: { active: 'board', prospectCount: 3, boards: 79, verifiedLive: 1913, ...props } });
}

describe('Board.astro in server mode', () => {
  it('holds one page, links the sort, forms the filters, and carries no band, no strip, no island', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', boardPath: '/jobs/board', groups: GROUPS,
      query: { ...DEFAULT_QUERY, location: 'remote', page: 2 },
      page: { total: 120, page: 2, pages: 3, per: 50 }, ageJobs: JOBS
    });
    expect(html).toContain('data-board-mode="server"');
    expect(html).toContain('data-paging="server"');
    expect(html).not.toContain('data-signature-moment');
    expect(html).not.toContain('Every posted row verified this sweep');
    expect(html).not.toContain('45% of applications');
    expect(html).not.toContain('data-page-step');
    expect(html).not.toContain('data-index-error');
    expect(html).toMatch(/<form class="filters-row"[^>]*method="get"/);
    expect(html).toMatch(/<a class="segment"[^>]*href="\/jobs\/board\?location=remote&(amp;|#38;)?sort=comp"[^>]*data-sort-key="comp"/);
    expect(html).toMatch(/href="\/jobs\/board\?location=remote" rel="prev"/);
    expect(html).toMatch(/href="\/jobs\/board\?location=remote&(amp;|#38;)?page=3" rel="next"/);
    expect(html).toContain('Rows 51 to 100 of 120');
    expect(html).toContain('Page 2 of 3');
  });
  it('an empty page offers a link that clears the filters', async () => {
    const html = await render({
      jobs: [], mode: 'server', boardPath: '/jobs/board', groups: GROUPS,
      query: { ...DEFAULT_QUERY, location: 'remote', q: 'zzz' },
      page: { total: 0, page: 1, pages: 1, per: 50 }, ageJobs: JOBS
    });
    expect(html).toMatch(/<a class="clear-filters"[^>]*href="\/jobs\/board"/);
    expect(html).toContain('No rows');
  });
});

describe('Board.astro in client mode (the Pre-List)', () => {
  it('still pages in the browser with the island pager, and carries no band or strip either', async () => {
    const html = await render({ jobs: JOBS });
    expect(html).toContain('data-board-mode="client"');
    expect(html).toContain('data-paging="client"');
    expect(html).toMatch(/<button class="step" type="button" data-page-step="-1"/);
    expect(html).toContain('data-index-error');
    expect(html).not.toContain('45% of applications');
    expect(html).not.toContain('Rows 1-');
  });
});
