import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Pagination from './Pagination.astro';

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Pagination, { props });
}

const PICKER = { action: '/jobs/board', hidden: [['location', 'remote']] as [string, string][], per: 50, perOptions: [25, 50, 100], span: 'Rows 51 to 100 of 1,913' };

describe('Pagination.astro: link mode with the picker', () => {
  it('renders prev and next as anchors, a page select, a per select, a number field, and the span', async () => {
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
    expect(html).toContain('Rows 51 to 100 of 1,913');
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
  it('carries no dashes', async () => {
    const html = await render({ current: 2, total: 3, prevHref: '/a', nextHref: '/b', picker: PICKER });
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
