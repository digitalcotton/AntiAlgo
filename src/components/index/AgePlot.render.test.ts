import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import AgePlot from './AgePlot.astro';
import { ageHistogramFromJobs, agePosition, AGE_TICK_SLOTS, type Job } from '../../lib/data';

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

// The store hands the plot a distribution, not rows; ageHistogramFromJobs is the
// in-memory twin of that GROUP BY, so these fixtures still read as "given jobs".
async function render(jobs: Job[]): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(AgePlot, { props: { histogram: ageHistogramFromJobs(jobs) } });
}

/** As the board mounts it: with a hrefFor, so the handles and count line render. */
async function renderInteractive(jobs: Job[]): Promise<string> {
  const container = await AstroContainer.create();
  const hrefFor = (min: number | null, max: number | null) =>
    `/board?age_min=${min ?? ''}&age_max=${max ?? ''}`;
  return container.renderToString(AgePlot, { props: { histogram: ageHistogramFromJobs(jobs), hrefFor } });
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
    expect(ticks).toBeLessThan(2 * (AGE_TICK_SLOTS + 1));
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
    expect(html).toMatch(/left: 100\.00%/);
  });

  it('never renders two ticks of the same band in the same slot', async () => {
    const jobs = Array.from({ length: 13_315 }, (_, i) => job(i, (i % 400) + 1));
    const html = await render(jobs);
    const axisMaxMatch = html.match(/data-axis-max="(\d+)"/);
    const axisMax = Number(axisMaxMatch?.[1]);
    expect(Number.isNaN(axisMax)).toBe(false);
    const step = 100 / AGE_TICK_SLOTS;
    const seen = new Set<string>();
    // Recompute each tick's slot from its exact age and the true axis position
    // (not the rendered, rounded `left`), since two adjacent slots can share a
    // displayed percentage at two decimal places without ever having shared a
    // bucket.
    for (const m of html.matchAll(/class="([^"]*\btick\b[^"]*)"[^>]*data-age="(\d+)"/g)) {
      const past = m[1].includes('tick-past') ? 1 : 0;
      const days = Number(m[2]);
      const at = agePosition(days, axisMax);
      const slot = Math.floor(at / step);
      const key = `${past}:${slot}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('every tick declares how many rows stand behind it, and they sum to the total', async () => {
    // The browser script recomputes the kept figure while a handle moves. It
    // used to count tick elements, which was the same thing when every row had
    // its own tick. Now a tick is a position, so it must sum data-rows instead;
    // if this contract breaks the line above the strip disagrees with the board
    // underneath it, which is how it read "Showing 508 of 12,966".
    const jobs = Array.from({ length: 13_315 }, (_, i) => job(i, (i % 400) + 1));
    const html = await renderInteractive(jobs);
    const rows = [...html.matchAll(/data-rows="(\d+)"/g)].map((m) => Number(m[1]));
    const ticks = (html.match(/class="[^"]*\btick\b/g) ?? []).length;
    expect(rows).toHaveLength(ticks);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(13_315);
  });
});
