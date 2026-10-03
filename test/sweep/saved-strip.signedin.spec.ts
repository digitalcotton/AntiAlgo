import { expect, test } from 'playwright/test';

/**
 * THE PRE-LIST MUST NOT ERASE THE BOARD'S SAVED SELECTION (2026-10-02).
 *
 * A member's saved selection is one record, the board's strip: Location, Remote
 * and Comp. The Pre-List draws a Comp select of its own (a list of bands, named
 * `comp`), and its script saved whatever its controls said on every visit that
 * carried a query string. A paid member who had saved a place, two arrangements
 * and a floor and then opened /prelist?sort=age found all three gone: the page
 * posted {comp: 'all'}, and a save replaces the whole record. Measured, not
 * assumed: the account read back as nothing after that one visit.
 *
 * The restore and the clearing of the board's own strip are proved, in both
 * engines, in controls.interaction.spec.ts. This is the one thing that spec cannot
 * reach: the Pre-List strip is drawn for the paid tier only (every other role sees
 * its wall), and the paid account has no other spec that writes its saved filters,
 * so the account is this test's alone and needs no lock.
 */

const SAVED = { place: 'US', remote: 'onsite', pay_min: '100' };

test('a visit to the Pre-List with a query string writes nothing to the saved selection', async ({ page }) => {
  test.skip(test.info().project.name !== 'paid', 'the Pre-List strip is drawn for the paid tier; every other role sees its wall');

  const seeded = await page.request.post('/settings/filters', { data: { selection: SAVED } });
  expect(seeded.status(), 'POST /settings/filters').toBe(200);
  try {
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/settings/filters') posts.push(request.postData() ?? '');
    });
    const probed = page.waitForResponse((response) => response.url().endsWith('/settings/filters') && response.request().method() === 'GET');

    const response = await page.goto('/prelist?sort=age', { waitUntil: 'domcontentloaded' });
    expect(response?.status(), '/prelist as paid').toBeLessThan(400);
    await expect(page.locator('[data-filters][data-js]')).toBeAttached();
    // The strip is really there and is the Pre-List's own, or this test would pass on a page with nothing to save.
    await expect(page.locator('[data-filter-group="comp"]')).toHaveCount(1);
    await expect(page.locator('[data-filter-group="place"], [data-filter-multi="remote"]')).toHaveCount(0);

    // The account probe is what a save waits on; give a (wrong) save the moment it needs after it answers.
    await probed;
    await page.waitForTimeout(700);

    expect(posts, 'the Pre-List saved its own controls over the board\'s selection').toEqual([]);
    const after = await page.request.get('/settings/filters');
    expect(((await after.json()) as { selection: unknown }).selection, 'the saved selection changed on a visit to the Pre-List').toEqual(SAVED);
    expect(await page.evaluate(() => window.localStorage.getItem('ti-index-filters:v1')), "the Pre-List wrote the browser's copy").toBeNull();
  } finally {
    await page.request.post('/settings/filters', { data: { selection: {} } }).catch(() => undefined);
  }
});
