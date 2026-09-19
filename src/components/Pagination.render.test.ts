import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Pagination from './Pagination.astro';

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Pagination, { props });
}

const PICKER = { action: '/jobs/board', hidden: [['location', 'remote']] as [string, string][], per: 50, perOptions: [25, 50, 100] };

describe('Pagination.astro: link mode with the picker', () => {
  it('renders prev and next as anchors, a page select, a per select, and a number field', async () => {
    const html = await render({ current: 2, total: 39, prevHref: '/jobs/board', nextHref: '/jobs/board?page=3', picker: PICKER });
    expect(html).toMatch(/<a class="step" href="\/jobs\/board" rel="prev"/);
    expect(html).toMatch(/<a class="step" href="\/jobs\/board\?page=3" rel="next"/);
    expect(html).toContain('Page 2 of 39');
    expect(html).toMatch(/<select[^>]*name="page"[^>]*data-autosubmit/);
    expect(html).toMatch(/<option value="2"[^>]*selected/);
    expect((html.match(/<option value="\d+"/g) ?? []).length).toBe(39 + 3);
    expect(html).toMatch(/<select[^>]*name="per"[^>]*data-autosubmit[^>]*data-resets-page/);
    expect(html).toMatch(/<option value="50"[^>]*selected/);
    expect(html).toMatch(/<input class="picker-number mono" type="number" name="page" min="1" max="39"/);
    // The row-count span moved out of Pagination onto the board footer's legend
    // baseline (Board.astro's page-span slot); Board.render.test.ts owns it now.
    expect(html).toContain('name="location" value="remote"');
    expect((html.match(/<form class="picker"/g) ?? []).length).toBe(2);
  });
  it('closes an end as a span, not a link', async () => {
    const html = await render({ current: 1, total: 1, prevHref: null, nextHref: null, picker: PICKER });
    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    expect((html.match(/class="step step-off"/g) ?? []).length).toBe(2);
  });
  it('island mode is unchanged: buttons, no forms', async () => {
    const html = await render({ current: 1, total: 5 });
    expect(html).toMatch(/<button class="step" type="button" data-page-step="-1"/);
    expect(html).not.toContain('<form');
  });
  it('windows the page list on a board too big to list, and keeps both ends', async () => {
    // The board carried 13,302 rows on 2026-09-19: 2,661 pages, and one option
    // each was 94 KB of markup, a third of the document, growing every night.
    const html = await render({ current: 500, total: 2661, prevHref: '/a', nextHref: '/b', picker: PICKER });
    // Only the page select's own options; the per select next to it offers 25/50/100.
    const block = html.match(/<select[^>]*name="page"[\s\S]*?<\/select>/)![0];
    const pages = [...block.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(pages.length).toBeLessThan(40);
    expect(pages).toContain(1);
    expect(pages).toContain(2661);
    expect(pages).toContain(500);
    expect(pages).toContain(490);
    expect(pages).toContain(510);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages); // still in order
    // The typed field still reaches every page, so nothing became unreachable.
    expect(html).toMatch(/<input class="picker-number mono" type="number" name="page" min="1" max="2661"/);
  });

  it('still lists every page on a small board, so the common case is unchanged', async () => {
    const html = await render({ current: 2, total: 39, prevHref: '/a', nextHref: '/b', picker: PICKER });
    expect((html.match(/<option value="\d+"/g) ?? []).length).toBe(39 + 3);
  });

  it('carries no dashes', async () => {
    const html = await render({ current: 2, total: 3, prevHref: '/a', nextHref: '/b', picker: PICKER });
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
