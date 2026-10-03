import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from 'playwright/test';

/**
 * The filter strip's three controls, under real WebKit and real Firefox
 * (src/components/Filters.astro, docs/search-engine-plan.md ticket G part 2):
 * LOCATION (geography), REMOTE (the arrangement, several at once) and COMP (a
 * pay floor), against the seeded antialgo_test board (scripts/test-db.mjs).
 *
 * THE FIXTURE BOARD IS SIX ROWS, AND THE NUMBERS BELOW ARE ITS OWN. Three are in
 * the United States and one each in Canada, India and the United Kingdom; one is
 * remote, five on-site and none hybrid; three state a pay and one of those is
 * $150k or more. So Hybrid, Not stated (Location and Remote) and the $200k, $250k
 * and $300k floors are all ZERO on the bare board, which is what lets this file
 * prove "a zero is drawn, muted and refused" on the real page without arranging
 * anything. If the seed changes, these are the numbers to change with it.
 *
 * THE FIXTURE HAS NO ROW WITH NO PLACE, SO "NOT STATED" IS A ZERO HERE, AND SAYS SO.
 * The tests of Location's Not stated row prove what the fixture can: it is drawn,
 * counted and refused while it has no rows; the address can still name it
 * (`place=unstated`) and then it is the chosen, live row, the Location control reads
 * "Not stated" (the box draws no chip for it), and Worldwide takes it off. That pressing the row returns exactly
 * its rows is proved where there are rows to return: job-store.db.test.ts on a
 * known spread of places, and the same menu driven by hand against the 6,712-row
 * board in antialgo_dev (see the report). Adding a seventh fixture row would move
 * every number in every spec that reads this board.
 *
 * WHAT A BROWSER ENGINE ADDS. The strip is a form the script enhances, and its
 * claims are sequences: a press on a row must not move focus off the control
 * (.claude/rules/dropdown-focus.md), one menu opens at a time across the strip
 * and the search box, a tick submits the form it belongs to. A DOM shim runs the
 * handlers and orders none of those events the way an engine does.
 *
 * SIGNED OUT, DELIBERATELY, for the reason the search spec gives: the strip
 * restores a member's saved selection onto a bare /board address, which would
 * navigate the page away from under a test that has just cleared a filter.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const NORMAL = readFileSync(join(process.cwd(), 'test/sweep/fixtures/suggest-normal.json'), 'utf8');

/** The strip's cells, by what each is called. The label is drawn in capitals by CSS; the text is as written. */
const cell = (page: Page, name: string): Locator =>
  page.locator('.filters-row > .filter').filter({ has: page.locator('.filter-label', { hasText: exactly(name) }) });
const trigger = (page: Page, name: string): Locator => cell(page, name).locator('.filter-value');
/** The one open strip menu: a direct child of .filters, which is where the script hangs them. */
const open = (page: Page): Locator => page.locator('.filters > .menu:not([hidden])');
const rowsIn = (menu: Locator): Locator => menu.locator('[role="option"]');
const exactly = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const row = (menu: Locator, label: string): Locator => menu.locator('[role="option"]', { has: menu.page().locator('.menu-label', { hasText: exactly(label) }) });
const searchField = (page: Page): Locator => page.locator('#board-search');
const panel = (page: Page): Locator => page.locator('[data-search-panel]');

/** The board with both scripts attached: a module script runs after first paint,
 *  and a click before this would land on a native control. */
async function openBoard(page: Page, search = ''): Promise<void> {
  await page.goto(`/board${search}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-filters][data-js]')).toBeAttached();
  await expect(page.locator('[data-search-box][data-wired]')).toBeAttached();
}

/** What a menu draws, row by row: label, count, and whether the row is refused. */
async function readRows(menu: Locator): Promise<{ label: string; count: string; disabled: boolean }[]> {
  return menu.locator('[role="option"]').evaluateAll((rows) =>
    rows.map((r) => ({
      label: r.querySelector('.menu-label')?.textContent ?? '',
      count: r.querySelector('.menu-count')?.textContent ?? '',
      disabled: (r as HTMLButtonElement).disabled || r.getAttribute('aria-disabled') === 'true'
    }))
  );
}

/** Press a row and wait for the form it submits to land on an address that matches. */
async function choose(page: Page, menu: Locator, label: string, address: RegExp): Promise<void> {
  await Promise.all([page.waitForURL(address), row(menu, label).click()]);
  await expect(page.locator('[data-filters][data-js]')).toBeAttached();
}

/** The "Rows 1 to N of M" line: how many rows the board says it holds. */
const total = async (page: Page): Promise<number> => {
  const text = (await page.locator('.page-span').first().textContent()) ?? '';
  // An empty board says "No rows" and not "of 0".
  if (/No rows/.test(text)) return 0;
  return Number(/of ([\d,]+)/.exec(text)?.[1].replace(/,/g, '') ?? NaN);
};

const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

test.describe('Location: geography, one choice, and the only place the fact is shown', () => {
  test('opens at country level: Worldwide first, countries by count, Not stated last, drawn and refused', async ({ page }) => {
    await openBoard(page);
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
    await trigger(page, 'Location').click();
    const menu = open(page);
    await expect(menu).toHaveCount(1);

    expect(await readRows(menu)).toEqual([
      { label: 'Worldwide', count: '6', disabled: false },
      { label: 'United States', count: '3', disabled: false },
      // Three countries with one row each: ties are broken by name, so the order is the same every night.
      { label: 'Canada', count: '1', disabled: false },
      { label: 'India', count: '1', disabled: false },
      { label: 'United Kingdom', count: '1', disabled: false },
      // The largest absence on the real board; here it is zero. Present either way, and refused while it is.
      { label: 'Not stated', count: '0', disabled: true }
    ]);
    await expect(row(menu, 'Worldwide')).toHaveAttribute('aria-selected', 'true');
    await expect(row(menu, 'Not stated')).toBeDisabled();
  });

  test('choosing a country narrows the board and sets place=<ISO>; choosing Worldwide clears it', async ({ page }) => {
    await openBoard(page);
    expect(await total(page)).toBe(6);

    await trigger(page, 'Location').click();
    await choose(page, open(page), 'United States', /[?&]place=US(?:&|$)/);
    expect(params(page).getAll('place')).toEqual(['US']);
    expect(await total(page)).toBe(3);
    await expect(trigger(page, 'Location')).toHaveText('United States');

    // The counts are still what each country would leave with everything else as it is:
    // the place filter is the one thing left out of its own count.
    await trigger(page, 'Location').click();
    const menu = open(page);
    expect((await readRows(menu)).map((r) => [r.label, r.count])).toEqual([
      ['Worldwide', '6'], ['United States', '3'], ['Canada', '1'], ['India', '1'], ['United Kingdom', '1'], ['Not stated', '0']
    ]);
    await expect(row(menu, 'United States')).toHaveAttribute('aria-selected', 'true');

    // Worldwide takes it off again: either no place parameter, or the "all" a form
    // writes, which the address reads as none.
    await choose(page, menu, 'Worldwide', /\/board\?(?!.*place=US)/);
    expect(['all', null]).toContain(params(page).get('place'));
    expect(await total(page)).toBe(6);
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
  });

  test('a city the address names reads as its own label and is one state with the dropdown', async ({ page }) => {
    // GB/London is what a suggestion in the search box writes into the address. The
    // box draws no chip for a place (owner, 2026-10-02): the control names it from
    // its key, in full, and is the one handle on it.
    await openBoard(page, '?place=GB%2FLondon');
    await expect(trigger(page, 'Location')).toHaveText('London, United Kingdom');
    expect(await total(page)).toBe(1);

    await trigger(page, 'Location').click();
    const menu = open(page);
    const rows = await readRows(menu);
    expect(rows.slice(0, 3).map((r) => r.label)).toEqual(['Worldwide', 'London, United Kingdom', 'United States']);
    // The list still offers countries, and the chosen place is the selected row.
    await expect(row(menu, 'London, United Kingdom')).toHaveAttribute('aria-selected', 'true');
    expect(rows.map((r) => r.label)).toContain('United Kingdom');

    // Choosing a country REPLACES the city: one place, never two.
    await choose(page, menu, 'India', /[?&]place=IN(?:&|$)/);
    expect(params(page).getAll('place')).toEqual(['IN']);
    expect(await total(page)).toBe(1);
  });
});

test.describe('Location keeps every country the board holds: a zero is drawn and refused, never dropped', () => {
  test('under Remote the three countries with no remote posting are still listed, at zero, after the one that has it', async ({ page }) => {
    // The one remote posting is in Canada. The counts used to name only the countries that had rows under the
    // other filters, so choosing Remote took the United States, India and the United Kingdom out of the list and a
    // reader could not tell a country with nothing from a country the board never had.
    await openBoard(page, '?remote=remote');
    expect(await total(page)).toBe(1);
    await trigger(page, 'Location').click();
    const menu = open(page);
    expect(await readRows(menu)).toEqual([
      { label: 'Worldwide', count: '1', disabled: false },
      { label: 'Canada', count: '1', disabled: false },
      // Zeros sort after the countries with rows, and among themselves by name.
      { label: 'India', count: '0', disabled: true },
      { label: 'United Kingdom', count: '0', disabled: true },
      { label: 'United States', count: '0', disabled: true },
      { label: 'Not stated', count: '0', disabled: true }
    ]);
    // Refused for real: the row is a disabled button, it is muted by the menu's own dead voice, and a click that
    // reaches it changes nothing.
    const before = page.url();
    const dead = row(menu, 'India');
    await expect(dead).toBeDisabled();
    await expect(dead).toHaveAttribute('aria-disabled', 'true');
    const colours = await dead.evaluate((el) => ({ row: getComputedStyle(el).color, live: getComputedStyle(el.parentElement!.querySelector('[role="option"]:not(:disabled)')!).color }));
    expect(colours.row).not.toBe(colours.live);
    await dead.dispatchEvent('click');
    await page.waitForTimeout(250);
    expect(page.url()).toBe(before);
    // And the one that has a row still works.
    await choose(page, menu, 'Canada', /[?&]place=CA(?:&|$)/);
    expect(await total(page)).toBe(1);
  });

  test('a country the reader chose that the other filters leave empty stays live, so it can be undone, and its siblings stay listed', async ({ page }) => {
    await openBoard(page, '?remote=remote&place=IN');
    expect(await total(page)).toBe(0);
    await expect(trigger(page, 'Location')).toHaveText('India');
    await trigger(page, 'Location').click();
    const menu = open(page);
    expect(await readRows(menu)).toEqual([
      { label: 'Worldwide', count: '1', disabled: false },
      { label: 'Canada', count: '1', disabled: false },
      // India is zero under Remote and is the choice: refused would strand the reader on an empty board.
      { label: 'India', count: '0', disabled: false },
      { label: 'United Kingdom', count: '0', disabled: true },
      { label: 'United States', count: '0', disabled: true },
      { label: 'Not stated', count: '0', disabled: true }
    ]);
    await expect(row(menu, 'India')).toHaveAttribute('aria-selected', 'true');
    await choose(page, menu, 'Worldwide', /\/board\?(?!.*place=IN)/);
    expect(await total(page)).toBe(1);
  });

  test('words that match nothing leave every country in the list, every one at zero', async ({ page }) => {
    await openBoard(page, '?q=xqzvwk');
    expect(await total(page)).toBe(0);
    await trigger(page, 'Location').click();
    const rows = await readRows(open(page));
    // All at zero, so by name: Worldwide first, Not stated last, the four countries between.
    expect(rows.map((r) => r.label)).toEqual(['Worldwide', 'Canada', 'India', 'United Kingdom', 'United States', 'Not stated']);
    expect(rows.every((r) => r.count === '0')).toBe(true);
    // Every one is refused, but for Worldwide, which clears.
    expect(rows.filter((r) => r.disabled).map((r) => r.label)).toEqual(['Canada', 'India', 'United Kingdom', 'United States', 'Not stated']);
  });
});

test.describe('Not stated is a place the address can ask for (place=unstated)', () => {
  test('is refused while it has no rows; named by the address it is the chosen row, live, and the control is the only place that says so', async ({ page }) => {
    await openBoard(page);
    await trigger(page, 'Location').click();
    await expect(row(open(page), 'Not stated')).toBeDisabled();
    await page.keyboard.press('Escape');

    await openBoard(page, '?place=unstated');
    await expect(trigger(page, 'Location')).toHaveText('Not stated');
    expect(await total(page)).toBe(0);
    // The Location control is the one place this is shown (owner, 2026-10-02). The box used to draw a "Location not
    // stated" chip, worded in full because the box has no label, beside the control saying the same thing; it draws
    // none now, and keeps its own placeholder.
    await expect(page.locator('.sb-chip')).toHaveCount(0);
    await expect(searchField(page)).toHaveAttribute('placeholder', /^Try /);
    await trigger(page, 'Location').click();
    const menu = open(page);
    expect(await readRows(menu)).toEqual([
      // Counted over everything but the place, so each row says what choosing it would leave.
      { label: 'Worldwide', count: '6', disabled: false },
      { label: 'United States', count: '3', disabled: false },
      { label: 'Canada', count: '1', disabled: false },
      { label: 'India', count: '1', disabled: false },
      { label: 'United Kingdom', count: '1', disabled: false },
      // Zero, and chosen: live, so it can be undone, and the control keeps the row's own name.
      { label: 'Not stated', count: '0', disabled: false }
    ]);
    await expect(row(menu, 'Not stated')).toHaveAttribute('aria-selected', 'true');
    await expect(row(menu, 'Worldwide')).toHaveAttribute('aria-selected', 'false');
    // Worldwide takes it off again.
    await choose(page, menu, 'Worldwide', /\/board\?(?!.*place=unstated)/);
    expect(await total(page)).toBe(6);
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
    await expect(page.locator('.sb-chip')).toHaveCount(0);
  });

  test('Worldwide removes it and only it, and a choice of another place replaces it: one place, never two', async ({ page }) => {
    // The chip that used to remove it is gone (owner, 2026-10-02: a fact a strip control shows has no chip), so the
    // Location control is the only handle. The guarantee it carried stays: taking the place off takes off that
    // place and nothing else, and a new choice replaces it.
    await openBoard(page, '?q=designer&place=unstated&remote=remote');
    await expect(trigger(page, 'Location')).toHaveText('Not stated');
    await expect(page.locator('.sb-chip')).toHaveCount(0);
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'Worldwide', /\/board\?(?!.*place=unstated)/);
    // The words and the other filter stay, and the place is gone.
    expect(params(page).get('q')).toBe('designer');
    expect(params(page).getAll('remote')).toEqual(['remote']);
    expect(['all', null]).toContain(params(page).get('place'));
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
    await expect(trigger(page, 'Remote')).toHaveText('Remote');

    await openBoard(page, '?place=unstated');
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'United States', /[?&]place=US(?:&|$)/);
    expect(params(page).getAll('place')).toEqual(['US']);
    expect(await total(page)).toBe(3);
    await expect(trigger(page, 'Location')).toHaveText('United States');
  });

  test('is read through every link on the page: the sort and the pager keep it, and the clear link takes it off', async ({ page }) => {
    await openBoard(page, '?place=unstated&q=designer');
    const hrefs = await page.locator('a.segment').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain('place=unstated');
    // An empty board offers the way back, and it clears the place too.
    const clear = page.locator('a.clear-filters');
    await expect(clear).toHaveCount(1);
    expect(await clear.getAttribute('href')).not.toContain('place=');
  });

  test('without script, a stale unstated is a harmless address: the select holds it, Apply keeps it, no error', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const response = await page.goto('/board?place=unstated', { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      // The chosen option is live (a zero that is chosen can be undone); it is the select's value and Apply carries it.
      await expect(page.locator('select[name="place"]')).toHaveValue('unstated');
      await expect(page.locator('select[name="place"] option[value="unstated"]')).not.toHaveAttribute('disabled', '');
      await Promise.all([page.waitForURL(/\/board\?/), page.locator('.filter-apply').click()]);
      expect(new URL(page.url()).searchParams.getAll('place')).toEqual(['unstated']);
      // And Worldwide undoes it.
      await page.locator('select[name="place"]').selectOption('all');
      await Promise.all([page.waitForURL((url) => !url.searchParams.has('place') || url.searchParams.get('place') === 'all'), page.locator('.filter-apply').click()]);
      expect(await page.locator('.page-span').first().textContent()).toMatch(/of 6\b/);
    } finally {
      await context.close();
    }
  });
});

test.describe('Remote: several arrangements at once, counted one by one', () => {
  test('lists All, then each arrangement with the count that arrangement alone would leave; a zero is refused', async ({ page }) => {
    await openBoard(page);
    await expect(trigger(page, 'Remote')).toHaveText('All');
    await trigger(page, 'Remote').click();
    const menu = open(page);
    await expect(menu).toHaveAttribute('aria-multiselectable', 'true');
    expect(await readRows(menu)).toEqual([
      { label: 'All', count: '6', disabled: false },
      { label: 'Remote', count: '1', disabled: false },
      { label: 'Hybrid', count: '0', disabled: true },
      { label: 'On-site', count: '5', disabled: false },
      { label: 'Not stated', count: '0', disabled: true }
    ]);
    // Nothing is ticked, which is "All".
    await expect(row(menu, 'All')).toHaveAttribute('aria-selected', 'true');
    for (const label of ['Remote', 'Hybrid', 'On-site', 'Not stated']) await expect(row(menu, label)).toHaveAttribute('aria-selected', 'false');
  });

  test('toggles: one, then two (read as "Remote + On-site"), then one again, then All clears', async ({ page }) => {
    await openBoard(page);

    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'Remote', /[?&]remote=remote(?:&|$)/);
    expect(params(page).getAll('remote')).toEqual(['remote']);
    expect(await total(page)).toBe(1);
    await expect(trigger(page, 'Remote')).toHaveText('Remote');

    // A second tick joins the first: the form writes one field per ticked box.
    await trigger(page, 'Remote').click();
    let menu = open(page);
    await expect(row(menu, 'Remote')).toHaveAttribute('aria-selected', 'true');
    await choose(page, menu, 'On-site', /[?&]remote=onsite(?:&|$)/);
    expect(params(page).getAll('remote').sort()).toEqual(['onsite', 'remote']);
    expect(await total(page)).toBe(6);
    await expect(trigger(page, 'Remote')).toHaveText('Remote + On-site');

    // Pressing a ticked row takes it off.
    await trigger(page, 'Remote').click();
    menu = open(page);
    await expect(row(menu, 'On-site')).toHaveAttribute('aria-selected', 'true');
    await choose(page, menu, 'Remote', /\/board\?(?!.*remote=remote)/);
    expect(params(page).getAll('remote')).toEqual(['onsite']);
    expect(await total(page)).toBe(5);
    await expect(trigger(page, 'Remote')).toHaveText('On-site');

    // All clears the lot in one submit.
    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'All', /\/board\?(?!.*remote=)/);
    expect(params(page).getAll('remote')).toEqual([]);
    expect(await total(page)).toBe(6);
    await expect(trigger(page, 'Remote')).toHaveText('All');
  });

  test('after Back, the strip shows what the address says and not the choice that left the page', async ({ page }) => {
    // An engine can bring the earlier page back from memory as it was left: with
    // Remote ticked, and the menu open. The address is the earlier one, so the
    // strip has to be too, or it claims a filter the rows under it do not have.
    // (Not from the bare address: that one restores a reader's saved filters on
    // purpose, so Back to it would land somewhere else, and rightly.)
    await openBoard(page, '?per=5');
    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'On-site', /[?&]remote=onsite(?:&|$)/);
    expect(await total(page)).toBe(5);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-filters][data-js]')).toBeAttached();
    expect(params(page).getAll('remote')).toEqual([]);
    await expect(trigger(page, 'Remote')).toHaveText('All');
    await expect(page.locator('input[name="remote"][value="onsite"]')).not.toBeChecked();
    await expect(open(page)).toHaveCount(0);
    expect(await total(page)).toBe(6);
  });

  test('reads a comma list from a link exactly as it reads repeated fields from the form', async ({ page }) => {
    await openBoard(page, '?remote=remote,onsite');
    await expect(trigger(page, 'Remote')).toHaveText('Remote + On-site');
    expect(await total(page)).toBe(6);
    await openBoard(page, '?remote=remote&remote=onsite');
    await expect(trigger(page, 'Remote')).toHaveText('Remote + On-site');
  });

  test('keeps a ticked zero live, so it can be taken off', async ({ page }) => {
    await openBoard(page, '?remote=hybrid');
    expect(await total(page)).toBe(0);
    await trigger(page, 'Remote').click();
    const menu = open(page);
    // Hybrid has no rows and is chosen: it must not be refused, or the reader is stuck on an empty board.
    await expect(row(menu, 'Hybrid')).toBeEnabled();
    await expect(row(menu, 'Hybrid')).toHaveAttribute('aria-selected', 'true');
    await choose(page, menu, 'Hybrid', /\/board\?(?!.*remote=hybrid)/);
    expect(await total(page)).toBe(6);
  });
});

test.describe('Comp: a floor, not a band', () => {
  test('offers Any, the floors with their counts, and Not listed last; the floors with no rows are drawn and refused', async ({ page }) => {
    await openBoard(page);
    await expect(trigger(page, 'Comp')).toHaveText('Any');
    await trigger(page, 'Comp').click();
    const menu = open(page);
    expect(await readRows(menu)).toEqual([
      { label: 'Any', count: '6', disabled: false },
      { label: '$100k+', count: '3', disabled: false },
      { label: '$150k+', count: '1', disabled: false },
      { label: '$200k+', count: '0', disabled: true },
      { label: '$250k+', count: '0', disabled: true },
      { label: '$300k+', count: '0', disabled: true },
      { label: 'Not listed', count: '3', disabled: false }
    ]);
  });

  test('choosing a floor sets pay_min; Not listed sets comp=not-listed in every link; Any clears it', async ({ page }) => {
    await openBoard(page);

    await trigger(page, 'Comp').click();
    await choose(page, open(page), '$100k+', /[?&]pay_min=100(?:&|$)/);
    expect(await total(page)).toBe(3);
    await expect(trigger(page, 'Comp')).toHaveText('$100k+');

    await trigger(page, 'Comp').click();
    await choose(page, open(page), '$150k+', /[?&]pay_min=150(?:&|$)/);
    expect(await total(page)).toBe(1);

    // Not listed and a floor are mutually exclusive: the strip speaks one pay filter.
    await trigger(page, 'Comp').click();
    await choose(page, open(page), 'Not listed', /[?&]pay_min=not-listed(?:&|$)/);
    expect(await total(page)).toBe(3);
    await expect(trigger(page, 'Comp')).toHaveText('Not listed');
    // The links the page writes say it the way the address does, never as pay_min=not-listed.
    const hrefs = await page.locator('a.segment').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toContain('comp=not-listed');
      expect(href).not.toContain('pay_min');
    }

    await trigger(page, 'Comp').click();
    await choose(page, open(page), 'Any', /\/board\?(?!.*pay_min=\d)(?!.*comp=)/);
    expect(await total(page)).toBe(6);
    await expect(trigger(page, 'Comp')).toHaveText('Any');
  });

  test('an old band bookmark is a floor now, and the strip shows the floor', async ({ page }) => {
    await openBoard(page, '?comp=150-200');
    await expect(trigger(page, 'Comp')).toHaveText('$150k+');
    expect(await total(page)).toBe(1);
  });
});

test.describe('a zero is drawn, muted and refused, in every menu', () => {
  test('a zero row is a disabled button: pressing it, by force or by key, changes nothing', async ({ page }) => {
    await openBoard(page);
    const before = page.url();
    for (const [name, label] of [['Comp', '$200k+'], ['Remote', 'Hybrid'], ['Location', 'Not stated']] as const) {
      await trigger(page, name).click();
      const menu = open(page);
      const dead = row(menu, label);
      await expect(dead).toBeDisabled();
      await expect(dead).toHaveAttribute('aria-disabled', 'true');
      // It is muted by the menu's own dead voice.
      const colours = await dead.evaluate((el) => ({ row: getComputedStyle(el).color, live: getComputedStyle(el.parentElement!.querySelector('[role="option"]:not(:disabled)')!).color }));
      expect(colours.row).not.toBe(colours.live);
      // A click that reaches it does nothing: the browser does not deliver one to a disabled button,
      // and a dispatched one is ignored by the row.
      await dead.dispatchEvent('click');
      await page.waitForTimeout(250);
      expect(page.url()).toBe(before);
      await page.keyboard.press('Escape');
    }
  });

  test('the arrow keys step over a refused row, and Escape closes the menu and returns to its control', async ({ page }) => {
    await openBoard(page);
    await trigger(page, 'Comp').click();
    const menu = open(page);
    // Focus starts on the chosen row (Any); two steps down are the live floors.
    const active = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? null);
    expect(await active()).toBe('Any');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('$100k+');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('$150k+');
    // $200k+, $250k+ and $300k+ have no rows: the next live row is Not listed.
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('Not listed');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('Not listed');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('filter-value'))).toBe(true);
  });
});

test.describe('the dropdown-focus rule: a press on a row never moves focus', () => {
  test('every row of every strip menu refuses the default of mousedown', async ({ page }) => {
    await openBoard(page);
    for (const name of ['Location', 'Remote', 'Comp']) {
      await trigger(page, name).click();
      const menu = open(page);
      // A listener added now runs AFTER the page's own, so it sees whether the page refused.
      const refused = await menu.locator('[role="option"]').evaluateAll((rows) =>
        rows.map((r) => {
          let prevented = false;
          r.addEventListener('mousedown', (event) => { prevented = event.defaultPrevented; });
          r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          return prevented;
        })
      );
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.every(Boolean), `${name}: a row let a press move focus`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });

  test('a real press on a live row keeps focus where it was and still chooses it', async ({ page }) => {
    await openBoard(page);
    await trigger(page, 'Comp').click();
    // Opening puts focus on the chosen row (Any), so the menu can be driven by key.
    const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? null);
    expect(await focused()).toBe('Any');
    const target = row(open(page), '$100k+');
    await target.hover();
    await page.mouse.down();
    // The page refused the press, so focus did not move to the row under the pointer
    // (an engine that moves focus on press would have blurred the list first).
    expect(await focused()).toBe('Any');
    await Promise.all([page.waitForURL(/pay_min=100/), page.mouse.up()]);
    expect(await total(page)).toBe(3);
  });
});

test.describe('one menu open at a time, across the box and every strip control', () => {
  test('opening any strip menu closes the others and the suggestion panel; the search field closes them all', async ({ page }) => {
    await page.route('**/board/suggest**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: NORMAL }));
    await openBoard(page);

    // The panel is open, then each strip menu in turn takes the slot from it.
    await searchField(page).click();
    await searchField(page).pressSequentially('lon');
    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    await expect(panel(page)).toBeVisible();

    for (const name of ['Location', 'Remote', 'Comp']) {
      await trigger(page, name).click();
      await expect(open(page)).toHaveCount(1);
      await expect(cell(page, name)).toHaveAttribute('data-open', '');
      await expect(panel(page)).toBeHidden();
      await expect(searchField(page)).toHaveAttribute('aria-expanded', 'false');
      // Only this cell is outlined as open.
      await expect(page.locator('.filters-row [data-open]')).toHaveCount(1);
    }

    // Strip to strip: opening one closes the one that was open.
    await trigger(page, 'Location').click();
    await expect(open(page)).toHaveCount(1);
    await expect(cell(page, 'Location')).toHaveAttribute('data-open', '');
    await expect(cell(page, 'Comp')).not.toHaveAttribute('data-open', '');
    await trigger(page, 'Remote').click();
    await expect(open(page)).toHaveCount(1);
    await expect(cell(page, 'Remote')).toHaveAttribute('data-open', '');
    await expect(cell(page, 'Location')).not.toHaveAttribute('data-open', '');

    // The field takes focus: the strip menu that was open closes with no typing at all.
    await searchField(page).click();
    await expect(open(page)).toHaveCount(0);
    await expect(page.locator('.filters-row [data-open]:not([data-search-box])')).toHaveCount(0);

    // And the panel opens again, still alone.
    await searchField(page).pressSequentially('d');
    await expect(panel(page)).toBeVisible();
    await expect(open(page)).toHaveCount(0);
  });

  test('pressing the open control again closes it, and a press elsewhere on the page closes it too', async ({ page }) => {
    await openBoard(page);
    await trigger(page, 'Remote').click();
    await expect(open(page)).toHaveCount(1);
    await trigger(page, 'Remote').click();
    await expect(open(page)).toHaveCount(0);
    await trigger(page, 'Location').click();
    await expect(open(page)).toHaveCount(1);
    await page.locator('.index-head').click();
    await expect(open(page)).toHaveCount(0);
  });
});

test.describe('the strip owns Location, Remote and Comp; the box draws a chip only for what no control shows', () => {
  /**
   * THE RULE (owner, 2026-10-02). A fact a strip control already shows (place,
   * remote, pay_min) is shown, changed and cleared only through that control: the
   * search box draws NO chip for it. It used to, beside the control saying the same
   * words, and the two were pinned to be one state here. A chip is drawn only for a
   * fact no control carries, a company and a posted-within window (age_max), and
   * each has its own x, which is the only way to clear it.
   *
   * WHAT STAYS TRUE, AND IS ASSERTED. The address is the one state: changing a
   * control changes the address and nothing else. And the form never sends a second
   * copy of an owned field: the box carries no hidden input for place, remote or
   * pay_min (the control's own field is the one answer), where a chip's would have
   * made unticking Remote re-send remote=remote. The company and the window are
   * carried by the box, so a change in a control keeps them.
   */
  const chipLabels = (page: Page): Promise<string[]> => page.locator('.sb-chip .sb-chip-label').allTextContents();
  const OWNED = ['place', 'remote', 'pay_min'] as const;
  /** What the strip's form would send under a name, built the way the browser builds it for a submit. */
  const submitted = (page: Page, name: string): Promise<string[]> =>
    page.locator('form.filters-row').evaluate((form, field) => new FormData(form as HTMLFormElement).getAll(field).map(String), name);
  /** No hidden input stands in for a field a control owns: a second copy of the same answer. */
  async function expectNoSecondCopy(page: Page): Promise<void> {
    for (const name of OWNED) {
      await expect(page.locator(`form.filters-row input[type="hidden"][name="${name}"]`), `a hidden ${name} beside its control`).toHaveCount(0);
    }
    expect((await submitted(page, 'place')).length, 'the form would send place twice').toBeLessThanOrEqual(1);
    expect((await submitted(page, 'pay_min')).length, 'the form would send pay_min twice').toBeLessThanOrEqual(1);
  }

  test('a fact a control owns has no chip: each is shown, changed and cleared in its control, and the form sends one copy', async ({ page }) => {
    await openBoard(page, '?place=US&remote=remote&remote=onsite&pay_min=100');
    await expect(trigger(page, 'Location')).toHaveText('United States');
    await expect(trigger(page, 'Remote')).toHaveText('Remote + On-site');
    await expect(trigger(page, 'Comp')).toHaveText('$100k+');
    // The three facts are in the address and in their controls, and the box draws nothing for any of them.
    expect(await chipLabels(page)).toEqual([]);
    await expect(page.locator('.sb-chips')).toHaveCount(0);
    await expect(searchField(page)).toHaveAttribute('placeholder', /^Try /);
    await expectNoSecondCopy(page);
    expect((await submitted(page, 'remote')).sort()).toEqual(['onsite', 'remote']);
    expect(await submitted(page, 'place')).toEqual(['US']);
    expect(await submitted(page, 'pay_min')).toEqual(['100']);

    // Untick Remote in the strip: the address loses that kind and keeps the other. Nothing re-sends what was unticked.
    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'Remote', /\/board\?(?!.*remote=remote)/);
    expect(params(page).getAll('remote')).toEqual(['onsite']);
    await expect(trigger(page, 'Remote')).toHaveText('On-site');
    expect(await chipLabels(page)).toEqual([]);
    await expectNoSecondCopy(page);
    expect(await submitted(page, 'remote')).toEqual(['onsite']);

    // Choose another country: the address holds one place, never two, and the control reads it.
    // (United Kingdom, because it is on the list: Canada has no on-site rows at
    // $100k, so under these filters it has no rows and is not offered.)
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'United Kingdom', /[?&]place=GB(?:&|$)/);
    expect(params(page).getAll('place')).toEqual(['GB']);
    await expect(trigger(page, 'Location')).toHaveText('United Kingdom');
    expect(await chipLabels(page)).toEqual([]);
    await expectNoSecondCopy(page);
    expect(await submitted(page, 'place')).toEqual(['GB']);

    // Take the floor off in the strip: Comp reads Any and the address carries no floor.
    await trigger(page, 'Comp').click();
    await choose(page, open(page), 'Any', /\/board\?(?!.*pay_min=\d)/);
    await expect(trigger(page, 'Comp')).toHaveText('Any');
    expect(params(page).getAll('pay_min').filter((v) => v !== 'all')).toEqual([]);
    expect(await chipLabels(page)).toEqual([]);

    // Clear the rest where they are shown: Remote's All and Location's Worldwide. The address ends with no narrowing
    // (a form writes place=all and leaves remote out), and the box has drawn nothing at any step.
    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'All', /\/board\?(?!.*remote=)/);
    await expect(trigger(page, 'Remote')).toHaveText('All');
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'Worldwide', /\/board\?(?!.*place=GB)/);
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
    for (const name of OWNED) expect(params(page).getAll(name).filter((v) => v !== 'all'), name).toEqual([]);
    expect(await chipLabels(page)).toEqual([]);
    expect(await total(page)).toBe(6);
  });

  test('a company and a posted-within window are drawn as chips, each with an x that drops only its own parameter', async ({ page }) => {
    // The two facts no strip control shows. age_max=90 is the widest window a chip is drawn for (search-parse.ts
    // AGE_MAX_DAYS); the chips come in the order place, company, remote, pay, age, so company then window here, and
    // the place in the address (United States) is in its control with no chip. The fixture's rows are months older
    // than a 90 day window, so under it every option but the always-live ones is refused: the steps that need a
    // live country are taken with the company alone.
    await openBoard(page, '?company=Figma&age_max=90&place=US');
    expect(await chipLabels(page)).toEqual(['Figma', 'Last 90 days']);
    await expect(page.locator('.sb-chip .sb-chip-x')).toHaveCount(2);
    await expect(page.locator('.sb-chip-x[aria-label="Remove Figma"]')).toHaveCount(1);
    await expect(page.locator('.sb-chip-x[aria-label="Remove Last 90 days"]')).toHaveCount(1);
    await expect(trigger(page, 'Location')).toHaveText('United States');
    // With chips present the box keeps its placeholder: they never stack over the field, which stays a field.
    await expect(searchField(page)).toHaveAttribute('placeholder', 'Add a job title, company or skill');
    await expect(searchField(page)).toBeVisible();
    // The box carries the two it draws, so a change in a control keeps them; it carries nothing for the three it does not.
    expect(await submitted(page, 'company')).toEqual(['Figma']);
    expect(await submitted(page, 'age_max')).toEqual(['90']);
    await expectNoSecondCopy(page);

    // A change in a control keeps both chips and changes only its own parameter. (Worldwide is live whatever the
    // filters leave.)
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'Worldwide', /\/board\?(?!.*place=US)/);
    expect(params(page).get('company')).toBe('Figma');
    expect(params(page).get('age_max')).toBe('90');
    expect(['all', null]).toContain(params(page).get('place'));
    expect(await chipLabels(page)).toEqual(['Figma', 'Last 90 days']);
    await expectNoSecondCopy(page);

    // The window's x drops the window and only it: the company and the rest of the address stay.
    await Promise.all([page.waitForURL((url) => !url.searchParams.has('age_max')), page.locator('.sb-chip', { hasText: 'Last 90 days' }).locator('.sb-chip-x').click()]);
    expect(params(page).get('company')).toBe('Figma');
    expect(await chipLabels(page)).toEqual(['Figma']);

    // Without the window Figma's row is on the board, so a country is live: choosing one writes one place, keeps the
    // company chip, and draws no chip of its own.
    await trigger(page, 'Location').click();
    await choose(page, open(page), 'United States', /[?&]place=US(?:&|$)/);
    expect(params(page).get('company')).toBe('Figma');
    expect(params(page).getAll('place')).toEqual(['US']);
    expect(await chipLabels(page)).toEqual(['Figma']);
    await expectNoSecondCopy(page);

    // And the company's x drops the company and only it: the place stays, in its control, with no chip.
    await Promise.all([page.waitForURL((url) => !url.searchParams.has('company')), page.locator('.sb-chip', { hasText: 'Figma' }).locator('.sb-chip-x').click()]);
    expect(params(page).getAll('place')).toEqual(['US']);
    expect(await chipLabels(page)).toEqual([]);
    await expect(page.locator('.sb-chips')).toHaveCount(0);
    await expect(trigger(page, 'Location')).toHaveText('United States');
    await expect(searchField(page)).toHaveAttribute('placeholder', /^Try /);
  });

  test('emptying the board from the board is not undone by the saved selection', async ({ page }) => {
    // The strip saves what the reader last chose, and a bare /board address restores
    // it. "Clear the filters" (and the x of the last company or window chip) leads to a
    // bare address, so without a way to tell a reader who is emptying the board from
    // one who is arriving at it, the last filter could never be taken off. (Location,
    // Remote and Comp have no chip now; their controls clear them, and
    // controls.interaction.spec.ts proves that path against the account.)
    await openBoard(page, '?place=GB&pay_min=300');
    expect(await total(page)).toBe(0);
    await Promise.all([page.waitForURL((url) => url.pathname === '/board' && url.search === ''), page.locator('a.clear-filters').click()]);
    // Give a (wrong) restore its moment: it is a client navigation the script fires at once.
    await page.waitForTimeout(600);
    expect(new URL(page.url()).search).toBe('');
    await expect(trigger(page, 'Location')).toHaveText('Worldwide');
    await expect(trigger(page, 'Comp')).toHaveText('Any');
    expect(await total(page)).toBe(6);

    // And what was cleared stays cleared: a fresh arrival (no referrer, as a typed
    // address or a bookmark has none) finds nothing saved to restore.
    await page.goto('/board', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    expect(new URL(page.url()).search).toBe('');
  });

  test('a city the address names reads in full in the Location control, and the box draws no chip for it', async ({ page }) => {
    // This pinned the chip and the control to the same words. The chip is gone (owner, 2026-10-02), so the words
    // live in one place: the control reads the city in full, and the open list marks it as the chosen row.
    await openBoard(page, '?place=GB%2FLondon');
    await expect(trigger(page, 'Location')).toHaveText('London, United Kingdom');
    expect(await chipLabels(page)).toEqual([]);
    await expect(page.locator('.sb-chip')).toHaveCount(0);
    await expectNoSecondCopy(page);
    expect(await submitted(page, 'place')).toEqual(['GB/London']);
    await trigger(page, 'Location').click();
    // The chosen place is the selected row, whatever the list below it offers.
    await expect(open(page).locator('[role="option"][aria-selected="true"] .menu-label')).toHaveText('London, United Kingdom');
  });
});

test.describe('Best, and the order the rows are in', () => {
  test('with words typed Best is the pressed sort; moving it and moving back are links', async ({ page }) => {
    await openBoard(page, '?q=designer');
    const pressed = page.locator('a.segment[aria-current="true"]');
    await expect(page.locator('a.segment').first()).toHaveText('Best');
    await expect(pressed).toHaveCount(1);
    await expect(pressed).toHaveText('Best');

    await Promise.all([page.waitForURL(/sort=comp/), page.locator('a.segment', { hasText: 'Comp' }).click()]);
    await expect(pressed).toHaveText('Comp');

    // Best is the default for words, so pressing it writes no sort at all.
    await Promise.all([page.waitForURL((url) => !url.searchParams.has('sort')), page.locator('a.segment', { hasText: 'Best' }).click()]);
    await expect(pressed).toHaveText('Best');
    expect(params(page).get('q')).toBe('designer');
  });

  test('with no words there is no Best, and the table\'s own default is pressed', async ({ page }) => {
    await openBoard(page);
    const labels = await page.locator('a.segment').allTextContents();
    expect(labels.map((l) => l.trim())).not.toContain('Best');
    await expect(page.locator('a.segment[aria-current="true"]')).toHaveCount(1);
  });
});

test.describe('the Field is on no surface of the board', () => {
  // Owner, 2026-10-02: the "Fields these roles are filed under" links under the
  // table were removed. The Field had already left the strip (an inference, not a
  // stated fact). What still holds is the address: fam= narrows, and a strip change
  // carries it, because nothing in the form submits it.
  test('is not on the strip and not under the table; an address that names one still narrows, and a strip change carries it', async ({ page }) => {
    await openBoard(page);
    await expect(page.locator('[data-filter-group="fam"]')).toHaveCount(0);
    await expect(page.locator('.filters-row')).not.toContainText('Field');
    await expect(page.locator('[data-same-field]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Fields these roles are filed under');

    // Every row of the seeded board (scripts/test-db.mjs) is design.
    await openBoard(page, '?fam=design');
    expect(await total(page)).toBe(6);
    await trigger(page, 'Remote').click();
    await choose(page, open(page), 'On-site', /[?&]remote=onsite(?:&|$)/);
    expect(params(page).getAll('fam')).toEqual(['design']);
    expect(params(page).getAll('remote')).toEqual(['onsite']);
  });
});

test.describe('without JavaScript: the strip is real fields and the Apply button', () => {
  test('a select for Location and Comp, checkboxes for Remote, and Apply submits all of them', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/board', { waitUntil: 'domcontentloaded' });

      // The plain controls, drawn: no trigger, no menu, the Apply button visible.
      await expect(page.locator('.filter-value')).toHaveCount(0);
      await expect(page.locator('.filter-apply')).toBeVisible();
      const where = page.locator('select[name="place"]');
      const how = page.locator('input[type="checkbox"][name="remote"]');
      const pay = page.locator('select[name="pay_min"]');
      await expect(where).toBeVisible();
      await expect(pay).toBeVisible();
      await expect(how).toHaveCount(4);
      for (const box of await how.all()) await expect(box).toBeVisible();
      // The refused ones are refused in plain HTML too: Not stated is a zero on this board, so it is a
      // refused option like every other zero (it is a real choice whenever it has rows).
      // (An <option> is checked by its attribute: engines disagree on whether
      // toBeDisabled looks at the option itself or at the select that holds it.)
      await expect(page.locator('select[name="place"] option[value="unstated"]')).toHaveAttribute('disabled', '');
      await expect(page.locator('input[name="remote"][value="hybrid"]')).toBeDisabled();
      await expect(page.locator('select[name="pay_min"] option[value="200"]')).toHaveAttribute('disabled', '');
      // No Field control anywhere in the form.
      await expect(page.locator('select[name="fam"]')).toHaveCount(0);

      await where.selectOption('US');
      await page.locator('input[name="remote"][value="remote"]').check();
      await page.locator('input[name="remote"][value="onsite"]').check();
      await pay.selectOption('100');
      await Promise.all([page.waitForURL(/\/board\?/), page.locator('.filter-apply').click()]);

      const sent = new URL(page.url()).searchParams;
      expect(sent.getAll('place')).toEqual(['US']);
      expect(sent.getAll('remote').sort()).toEqual(['onsite', 'remote']);
      expect(sent.getAll('pay_min')).toEqual(['100']);
      // The board read all three: of the six rows, the one in the United States that states $100k or more.
      const shown = await page.locator('.page-span').first().textContent();
      expect(shown).toMatch(/of 1\b/);
      // And the same controls come back holding what was chosen.
      await expect(page.locator('select[name="place"]')).toHaveValue('US');
      await expect(page.locator('select[name="pay_min"]')).toHaveValue('100');
      await expect(page.locator('input[name="remote"][value="remote"]')).toBeChecked();
      await expect(page.locator('input[name="remote"][value="onsite"]')).toBeChecked();

      // Unticking everything is "All": no remote field is sent.
      await page.locator('input[name="remote"][value="remote"]').uncheck();
      await page.locator('input[name="remote"][value="onsite"]').uncheck();
      await Promise.all([page.waitForURL((url) => !url.searchParams.has('remote')), page.locator('.filter-apply').click()]);
      expect(new URL(page.url()).searchParams.getAll('remote')).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Not listed submits as the one name the select has, and the address reads it as comp=not-listed', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/board', { waitUntil: 'domcontentloaded' });
      await page.locator('select[name="pay_min"]').selectOption('not-listed');
      await Promise.all([page.waitForURL(/pay_min=not-listed/), page.locator('.filter-apply').click()]);
      const shown = await page.locator('.page-span').first().textContent();
      expect(shown).toMatch(/of 3\b/);
      await expect(page.locator('select[name="pay_min"]')).toHaveValue('not-listed');
      // The sort links write the address's own spelling.
      const href = await page.locator('a.segment').first().getAttribute('href');
      expect(href).toContain('comp=not-listed');
    } finally {
      await context.close();
    }
  });
});

test.describe('the order in force is said once, above the rows, for a reader with no why panel', () => {
  // This file is signed out, which is the reader this is for: no Deets column, no why panel, so the order
  // is told in one line above the rows instead of in a panel they do not have.
  const line = (page: Page): Locator => page.locator('[data-order-reason]');
  const ORDER_AGE = 'Ordered by age: newest first, roles with no date last, then company and title A to Z.';
  const ORDER_BEST =
    'Ordered by best match: where your words are found (the title, then the company name, then the rest of the posting), then the closer text match, then newer first.';

  test('the bare board says age, because a reader who cannot see Deets is served the age order', async ({ page }) => {
    await openBoard(page);
    await expect(line(page)).toHaveCount(1);
    await expect(line(page)).toHaveText(ORDER_AGE);
    // Above the first row, and on the table's top edge.
    const above = await line(page).boundingBox();
    const first = await page.locator('[data-job-row]').first().boundingBox();
    expect(above!.y + above!.height).toBeLessThanOrEqual(first!.y + 1);
    // The sort control says the same thing: Age is the one pressed, and there is no Deets segment.
    await expect(page.locator('a.segment[aria-current="true"]')).toHaveAttribute('data-sort-key', 'age');
    await expect(page.locator('a.segment[data-sort-key="fit"]')).toHaveCount(0);
    // And there is no per-row reason: no panel, no sentence in the markup.
    await expect(page.locator('[data-rank-reason]')).toHaveCount(0);
    await expect(page.locator('[data-why-toggle]')).toHaveCount(0);
  });

  test('words typed say best match, without the Deets they cannot see; a chosen sort is the one said', async ({ page }) => {
    await openBoard(page, '?q=designer');
    await expect(line(page)).toHaveText(ORDER_BEST);
    expect(await total(page)).toBeGreaterThan(1);
    await expect(line(page)).not.toContainText('Deets');
    await expect(page.locator('a.segment[aria-current="true"]')).toHaveAttribute('data-sort-key', 'best');

    await openBoard(page, '?q=designer&sort=comp');
    await expect(line(page)).toHaveText('Ordered by pay: highest posted figure first, roles that post none last, then company and title A to Z.');
    await openBoard(page, '?q=designer&sort=age');
    await expect(line(page)).toHaveText(ORDER_AGE);
    // Following the sort control changes the line with it.
    await Promise.all([page.waitForURL(/sort=comp/), page.locator('a.segment[data-sort-key="comp"]').click()]);
    await expect(line(page)).toHaveText(/^\s*Ordered by pay:/);
  });

  test('a close spelling says so first and then how it is ordered, and no word is ever the same twice', async ({ page }) => {
    await openBoard(page, '?q=prodct%20desiner');
    await expect(page.locator('[data-fuzzy-notice]')).toHaveText('No exact matches for "prodct desiner". Showing close spellings.');
    await expect(line(page)).toHaveText('Ordered by best match: the closest spelling of "prodct desiner" first, then newer first.');
    const [notice, order, first] = await Promise.all([
      page.locator('[data-fuzzy-notice]').boundingBox(),
      line(page).boundingBox(),
      page.locator('[data-job-row]').first().boundingBox()
    ]);
    expect(notice!.y).toBeLessThan(order!.y);
    expect(order!.y + order!.height).toBeLessThanOrEqual(first!.y + 1);
  });

  test('is not there when there is no row to be above, and uses no dash or curly quote', async ({ page }) => {
    await openBoard(page, '?q=xqzvwk');
    expect(await total(page)).toBe(0);
    await expect(line(page)).toHaveCount(0);
    await openBoard(page, '?q=designer');
    const text = (await line(page).textContent()) ?? '';
    for (const codePoint of [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d]) expect(text.includes(String.fromCodePoint(codePoint))).toBe(false);
  });

  test('is in the page the server sends: it is there with scripting off', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/board?q=designer', { waitUntil: 'domcontentloaded' });
      await expect(line(page)).toHaveText(ORDER_BEST);
    } finally {
      await context.close();
    }
  });

  test.describe('a signed-in reader has the per-row sentence and is not told twice', () => {
    test.use({ storageState: '.sweep/auth/member.json' });

    test('no line above the rows; each row carries its own "Ranked" sentence in its panel', async ({ page }) => {
      await openBoard(page, '?q=designer');
      await expect(page.locator('[data-job-table]')).toBeAttached();
      // A real signed-in session, or this passes for the wrong reason: the Deets segment is there and the table has a why toggle.
      await expect(page.locator('a.segment[data-sort-key="fit"]')).toHaveCount(1);
      await expect(page.locator('[data-why-toggle]').first()).toBeVisible();
      await expect(line(page)).toHaveCount(0);
      const sentences = await page.locator('[data-rank-reason]').allTextContents();
      expect(sentences.length).toBeGreaterThan(1);
      // The sentence they get does name Deets: they can read it.
      expect(sentences[0]).toMatch(/^Ranked 1st: .*then Deets \d+, then newer first\.$/);
    });
  });
});

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the strip stacks, every menu row is a 44pt target, and the page does not scroll sideways', async ({ page }) => {
    await openBoard(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const name of ['Location', 'Remote', 'Comp']) {
      const control = await trigger(page, name).boundingBox();
      const holder = await cell(page, name).boundingBox();
      // The cell is the target: full width of the strip and at least 44 tall.
      expect(holder!.height, `${name} cell`).toBeGreaterThanOrEqual(44);
      expect(control!.height).toBeGreaterThan(0);

      await trigger(page, name).click();
      const menu = open(page);
      await expect(menu).toHaveCount(1);
      const heights = await rowsIn(menu).evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
      expect(Math.min(...heights), `${name} rows`).toBeGreaterThanOrEqual(44);
      const box = await menu.boundingBox();
      // The panel is no wider than the screen, and the page still does not scroll.
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
    }
  });

});
