import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import AgePlot from './AgePlot.astro';
import type { Job } from '../../lib/data';

/**
 * The age strip says "N roles" and calls itself "Age of every verified role".
 * These tests hold it to both words at the size the board is about to become.
 *
 * WHAT WENT WRONG. listBoardAges defaulted to LIMIT 5000 with no ORDER BY, and
 * board.astro called it with that default. Under the roughly 1,900 rows the
 * plot was built for the cap never bound, so the claim was true. Carrying the
 * whole crawl it binds every time: the strip would draw an arbitrary 38% of the
 * board while the count line, data-total and the aria-label all still said the
 * whole number. The query no longer caps, and these tests pin that the plot
 * counts every row it is given and still renders a bounded number of ticks.
 */

function job(i: number, daysOld: number): Job {
  // sweepDate() is the "to" end of every age, so the "from" end is measured back
  // from it; the exact calendar day does not matter, only the gap.
  const from = new Date(Date.parse('2026-09-14T00:00:00Z') - daysOld * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `job-${i}`,
    slug: `co-${i}-role`,
    company: `Company ${i % 90}`,
    title: `Role ${i}`,
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: `https://boards.example.invalid/${i}`,
    apply_url: `https://boards.example.invalid/${i}/apply`,
    first_observed: from,
    last_verified: '2026-09-14T07:30:02Z',
    published_date: from,
    age_days: daysOld,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'example.invalid' },
    fit: { total: 50, title_scope: 10, remote_geo: 10, comp: 10, freshness: 10, apply_friction: 10 },
    description_html: null
  };
}

async function render(jobs: Job[]): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(AgePlot, { props: { jobs } });
}

/** As the board mounts it: with a hrefFor, so the handles and count line render. */
async function renderInteractive(jobs: Job[]): Promise<string> {
  const container = await AstroContainer.create();
  const hrefFor = (min: number | null, max: number | null) =>
    `/board?age_min=${min ?? ''}&age_max=${max ?? ''}`;
  return container.renderToString(AgePlot, { props: { jobs, hrefFor } });
}

const countTicks = (html: string) => (html.match(/class="[^"]*\btick\b/g) ?? []).length;

describe('AgePlot at the size the everything board brings', () => {
  it('counts every row it was given, not every tick it drew', async () => {
    const jobs = Array.from({ length: 13_315 }, (_, i) => job(i, (i % 400) + 1));
    const html = await renderInteractive(jobs);
    expect(html).toContain('data-total="13315"');
    // The visible line the reader actually reads, not just the data attribute.
    expect(html).toContain('13,315');
    expect(html).toContain('roles,');
  });

  it('does not emit one DOM node per row', async () => {
    const jobs = Array.from({ length: 13_315 }, (_, i) => job(i, (i % 400) + 1));
    const ticks = countTicks(await render(jobs));
    expect(ticks).toBeGreaterThan(50);
    expect(ticks).toBeLessThan(4_000);
  });

  it('a tick standing for many rows says so instead of naming one of them', async () => {
    // Every row the same age: they all land on one position.
    const jobs = Array.from({ length: 500 }, (_, i) => job(i, 30));
    const html = await render(jobs);
    expect(html).toContain('500 roles at');
    expect(html).not.toContain('Company 0, Role 0');
  });

  it('still names the row when a tick stands for exactly one', async () => {
    const html = await render([job(0, 3), job(1, 200)]);
    expect(html).toContain('Company 0, Role 0');
    expect(html).toContain('data-total="2"');
  });

  it('keeps the youngest and oldest ends over the whole set', async () => {
    const jobs = [job(0, 1), ...Array.from({ length: 6_000 }, (_, i) => job(i + 1, 50)), job(9_999, 900)];
    const html = await render(jobs);
    expect(html).toContain('data-total="6002"');
    // The oldest row must be represented; it would be dropped by an arbitrary cap.
    expect(html).toMatch(/left: 100\.000%/);
  });
});
