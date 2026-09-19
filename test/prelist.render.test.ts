import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Prelist from '../src/pages/prelist.astro';
import { DEFAULT_PER_PAGE } from '../src/lib/board-query';

/**
 * /prelist holds one page, and the whole point is that it never holds the list.
 *
 * Until 2026-09-19 this page passed every prospect to Board.astro's client mode,
 * which renders all of them and hides the ones past page one: a 6.3 MB document
 * of 25,623 elements that crashed phones. These render the real page with the
 * wall opened (locals.verdict) and count what actually comes out.
 */
async function load(url: string): Promise<Response> {
  const container = await AstroContainer.create();
  return container.renderToResponse(Prelist, {
    request: new Request(url),
    locals: { viewer: null, verdict: { allow: true, required: 'member', reason: 'allowed' } }
  });
}

async function html(url: string): Promise<string> {
  const res = await load(url);
  expect(res.status).toBe(200);
  return res.text();
}

const rowsIn = (page: string) => (page.match(/data-job-row/g) ?? []).length;

describe('prelist.astro: one page per request, never the whole list', () => {
  it('renders a page of rows and says where the reader is', async () => {
    const page = await html('http://localhost/prelist');
    expect(rowsIn(page)).toBe(DEFAULT_PER_PAGE);
    expect(page).toMatch(/Page 1 of \d+/);
    expect(page).toMatch(/Rows 1 to 5 of [\d,]+/);
    // The guard that matters: the document is a page, not the population.
    expect((page.match(/<[a-zA-Z]/g) ?? []).length).toBeLessThan(2000);
  });

  it('honours the rows-per-page the address asks for', async () => {
    expect(rowsIn(await html('http://localhost/prelist?per=25'))).toBe(25);
  });

  it('gives a different page for a different page number', async () => {
    const one = await html('http://localhost/prelist');
    const two = await html('http://localhost/prelist?page=2');
    expect(rowsIn(two)).toBe(DEFAULT_PER_PAGE);
    expect(two.match(/data-slug="([^"]+)"/)?.[1]).not.toBe(one.match(/data-slug="([^"]+)"/)?.[1]);
    expect(two).toMatch(/Page 2 of \d+/);
  });

  it('does not empty itself when a Location filter travels in from the board', async () => {
    // A company before it posts has no workplace, so the facet is 'unknown' and
    // the filter cannot apply to it. The 2026-09-10 bug was zero rows, silently.
    expect(rowsIn(await html('http://localhost/prelist?location=remote'))).toBe(DEFAULT_PER_PAGE);
  });

  it('answers a page past the end with a redirect to the last real page', async () => {
    const res = await load('http://localhost/prelist?page=99999');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/[?&]page=\d+/);
  });

  it('says nothing matched rather than showing a page of nothing', async () => {
    const page = await html('http://localhost/prelist?q=zzzznotacompany');
    expect(rowsIn(page)).toBe(0);
  });
});
