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
 * wall opened and count what actually comes out. The Pre-List is paid since
 * 2026-09-20, so opening the wall takes a paid viewer as well as an allowing
 * verdict; a member gets the shop window and no rows, which is its own case
 * below.
 */
async function load(url: string): Promise<Response> {
  const container = await AstroContainer.create();
  return container.renderToResponse(Prelist, {
    request: new Request(url),
    locals: {
      viewer: { userId: 'u1', tier: 'paid', emailVerified: true },
      verdict: { allow: true, required: 'member', reason: 'allowed' }
    }
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

describe('the Pre-List is paid', () => {
  // The tiers matrix marks the Pre-List paid-only, but ROUTE_POLICY asks for
  // member, so the page checks the tier itself. Held here because the wall is
  // in-page: middleware lets a member through and the page has to be the one
  // that refuses, and a null viewer with an allowing verdict must not open it.
  type Tier = 'public' | 'waitlisted' | 'member' | 'paid' | 'internal';
  async function renderAs(tier: Tier | null): Promise<string> {
    const container = await AstroContainer.create();
    const res = await container.renderToResponse(Prelist, {
      request: new Request('http://localhost/prelist'),
      locals: {
        viewer: tier === null ? null : { userId: 'u1', tier, emailVerified: true },
        verdict: { allow: true, required: 'member', reason: 'allowed' }
      }
    });
    return res.text();
  }

  it('shows a member the shop window and not one row', async () => {
    const page = await renderAs('member');
    expect(rowsIn(page)).toBe(0);
    expect(page).toContain('What the Pre-List is');
  });

  it('shows a signed-out reader the same shop window', async () => {
    const page = await renderAs(null);
    expect(rowsIn(page)).toBe(0);
    expect(page).toContain('What the Pre-List is');
  });

  it('opens the rows for paid and internal', async () => {
    for (const tier of ['paid', 'internal'] as const) {
      const page = await renderAs(tier);
      expect(rowsIn(page)).toBe(DEFAULT_PER_PAGE);
      expect(page).not.toContain('What the Pre-List is');
    }
  });

  it('still counts the whole list on the wall, so the tease stays true', async () => {
    // The count is a fact about the list, not about what is on screen, so it
    // is the one number a walled reader is still given.
    const page = await renderAs('member');
    expect(page).toMatch(/board-tab-count[^>]*>\s*\d+/);
  });
});
