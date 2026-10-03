import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from 'playwright/test';

/**
 * The search box's combobox, under real WebKit and real Firefox
 * (src/components/SearchBox.astro, docs/search-engine-plan.md ticket G).
 *
 * WHY THIS NEEDS A BROWSER ENGINE AND NOT A DOM SHIM. The panel's whole claim
 * is a sequence of events: a press on a row must not move focus off the field
 * (.claude/rules/dropdown-focus.md), a keystroke must abort the request it
 * replaces, a wait must end in a state and never in a spinner. A DOM shim runs
 * the handlers but orders none of those events the way an engine does, which is
 * the same reason controls.interaction.spec.ts exists beside the unit tests.
 *
 * THE ENDPOINT IS MOCKED, ON PURPOSE. /board/suggest is another ticket's route
 * and may not exist when this runs; either way a spec about the BOX must not
 * depend on how fast or how right the server's SQL is. Every answer below is a
 * fixture in the plan's contract shape (test/sweep/fixtures/suggest-*.json), so
 * the box is held to the contract and nothing else. What this file therefore
 * does NOT prove is that the real endpoint matches the contract: the counts
 * contract (ticket I) is where that is asserted, against the database.
 *
 * SIGNED OUT, DELIBERATELY. The strip restores a member's saved selection onto a
 * bare /board address (Filters.astro, applySelection), which would navigate the
 * page away from under a test that has just typed into it. A visitor with no
 * session has nothing saved, and the box does not behave differently for one.
 *
 * NOT COVERED HERE, AND SAID SO. The chips are drawn by the server from the
 * address, and /board does not pass them yet, so no page this spec can load
 * carries one. The Backspace test therefore puts the server's own chip markup
 * (a list of `.sb-chip` with an `.sb-chip-x` remove link) into the page and
 * checks the box's behaviour against it; SearchBox.render.test.ts pins that the
 * server really renders that markup. Once the board passes real chips, a
 * round trip through a real address belongs here too.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const fixture = (name: string): string => readFileSync(join(process.cwd(), 'test/sweep/fixtures', name), 'utf8');
const NORMAL = fixture('suggest-normal.json');
const EMPTY = fixture('suggest-empty.json');
const STALE = fixture('suggest-stale.json');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Respond = (route: Route, url: URL) => Promise<void> | void;
const answer = (body: string): Respond => (route) => route.fulfill({ status: 200, contentType: 'application/json', body });

/** Answers every call to the suggest endpoint and returns the list of addresses
 *  it was asked for, in order. A request the page aborts before we answer makes
 *  fulfill throw; that abort is the behaviour under test, so it is swallowed. */
async function mockSuggest(page: Page, respond: Respond): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route('**/board/suggest**', async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    try {
      await respond(route, url);
    } catch {
      /* aborted by the page */
    }
  });
  return seen;
}

/** The board, with both scripts attached. A module script runs after first
 *  paint, so typing before these markers would lose the first keystroke. */
async function openBoard(page: Page): Promise<void> {
  await page.goto('/board', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-search-box][data-wired]')).toBeAttached();
  await expect(page.locator('[data-filters][data-js]')).toBeAttached();
}

const field = (page: Page) => page.locator('#board-search');
const panel = (page: Page) => page.locator('[data-search-panel]');
const options = (page: Page) => panel(page).locator('[role="option"]');
/** The strip's own open dropdowns: direct children of .filters, which is where
 *  Filters.astro hangs them. The suggestion panel is not one of these. */
const stripMenus = (page: Page) => page.locator('.filters > .menu:not([hidden])');
/** The strip's dropdown buttons, in the order the strip draws them. By position,
 *  not by name, so a control renamed or reordered inside the strip does not turn
 *  a test about the one-menu rule into a failure about the strip. */
const stripTrigger = (page: Page, index: number) => page.locator('.filter-field > .filter-value').nth(index);

async function typeAndWaitForRows(page: Page, text = 'lon'): Promise<void> {
  await field(page).click();
  await field(page).pressSequentially(text);
  await expect(panel(page)).toHaveAttribute('data-state', 'results');
}

async function activeText(page: Page): Promise<string> {
  const id = await field(page).getAttribute('aria-activedescendant');
  expect(id, 'no option is active').toBeTruthy();
  return (await page.locator(`[id="${id}"]`).locator('.menu-label').textContent()) ?? '';
}

test.describe('the suggestion panel', () => {
  test('typing opens a grouped panel: label left, count right in mono, a zero row shown and disabled', async ({ page }) => {
    const seen = await mockSuggest(page, answer(NORMAL));
    await openBoard(page);

    // ARIA 1.2 combobox, closed.
    const input = field(page);
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toHaveAttribute('name', 'q');
    await expect(panel(page)).toBeHidden();

    await typeAndWaitForRows(page);

    // Open, and wired to its listbox.
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page)).toHaveAttribute('role', 'listbox');
    await expect(input).toHaveAttribute('aria-controls', (await panel(page).getAttribute('id'))!);
    await expect(panel(page)).toBeVisible();

    // Four groups, in the contract's order, each labelled for assistive tech.
    const groups = panel(page).locator('[role="group"]');
    await expect(groups).toHaveCount(4);
    expect(await groups.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
      'Titles',
      'Places',
      'Companies',
      'Facts'
    ]);

    // Every row is an option with its own unique id and a count beside the label.
    await expect(options(page)).toHaveCount(11);
    const ids = await options(page).evaluateAll((els) => els.map((el) => el.id));
    expect(new Set(ids).size, 'option ids must be unique').toBe(ids.length);
    expect(ids.every((id) => id !== '')).toBe(true);

    const remote = panel(page).locator('[role="option"]', { hasText: 'Remote' });
    await expect(remote.locator('.menu-label')).toHaveText('Remote');
    await expect(remote.locator('.menu-count')).toHaveText('4,169');
    await expect(panel(page).locator('[role="option"]', { hasText: 'London, United Kingdom' }).locator('.menu-count')).toHaveText('406');

    // The count sits at the row's right edge and the label at its left, in the
    // same face the strip's own value buttons use (the machine's mono voice).
    const row = await remote.boundingBox();
    const label = await remote.locator('.menu-label').boundingBox();
    const count = await remote.locator('.menu-count').boundingBox();
    expect(label!.x).toBeLessThan(count!.x);
    expect(row!.x + row!.width - (count!.x + count!.width)).toBeLessThan(40);
    const faces = await page.evaluate(() => {
      const mono = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : null);
      return {
        count: mono(document.querySelector('[data-search-panel] .menu-count')),
        strip: mono(document.querySelector('.filter-value'))
      };
    });
    expect(faces.count).toBeTruthy();
    expect(faces.count).toBe(faces.strip);

    // A zero is drawn and refused, never hidden.
    const dead = panel(page).locator('[role="option"]', { hasText: 'London, KY' });
    await expect(dead).toHaveAttribute('aria-disabled', 'true');
    await expect(dead.locator('.menu-count')).toHaveText('0');

    // One request, because three quick keystrokes inside the debounce make one.
    expect(seen).toHaveLength(1);
    expect(seen[0].pathname).toBe('/board/suggest');
    expect(seen[0].searchParams.get('q')).toBe('lon');
  });

  test('every request carries the board\'s params and the sweep instant, and its own q', async ({ page }) => {
    const seen = await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[data-search-box]')!;
      // `q` and `v` here are stale on purpose: the box's own always win.
      box.dataset.suggestParams = JSON.stringify({ location: 'remote', sort: 'age', q: 'old', v: 'old' });
      box.dataset.suggestV = '2026-10-02T04:00:00Z';
    });
    await typeAndWaitForRows(page);
    const params = seen[0].searchParams;
    expect(params.get('location')).toBe('remote');
    expect(params.get('sort')).toBe('age');
    expect(params.get('q')).toBe('lon');
    expect(params.get('v')).toBe('2026-10-02T04:00:00Z');
    expect(params.getAll('q')).toHaveLength(1);
  });

  test('a stale answer is aborted and never drawn over the newer one', async ({ page }) => {
    const seen = await mockSuggest(page, async (route, url) => {
      if (url.searchParams.get('q') === 'l') {
        await sleep(700);
        return route.fulfill({ status: 200, contentType: 'application/json', body: STALE });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: NORMAL });
    });
    await openBoard(page);
    await field(page).click();
    await field(page).press('l');
    await expect.poll(() => seen.length).toBe(1);
    await field(page).press('o');
    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    await expect(panel(page)).toContainText('Product Designer');
    // Long enough for the first answer to have landed had it been allowed to.
    await sleep(900);
    await expect(panel(page)).not.toContainText('STALE ANSWER');
    expect(seen.map((url) => url.searchParams.get('q'))).toEqual(['l', 'lo']);
  });

  test('emptying the field closes the panel and asks for nothing more', async ({ page }) => {
    const seen = await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).fill('');
    await expect(panel(page)).toBeHidden();
    await expect(field(page)).toHaveAttribute('aria-expanded', 'false');
    await sleep(300);
    expect(seen).toHaveLength(1);
  });
});

test.describe('keyboard', () => {
  test('down, down, Enter goes to that row\'s href, and aria-activedescendant follows', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    // Nothing is active until a key says so: Enter would submit what was typed.
    await expect(field(page)).not.toHaveAttribute('aria-activedescendant', /.+/);

    await field(page).press('ArrowDown');
    await field(page).press('ArrowDown');
    const id = (await field(page).getAttribute('aria-activedescendant'))!;
    const row = page.locator(`[id="${id}"]`);
    await expect(row).toHaveAttribute('role', 'option');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(row.locator('.menu-label')).toHaveText('Product Design Manager');

    await Promise.all([page.waitForURL(/\/board\?q=Product\+Design\+Manager$/), field(page).press('Enter')]);
  });

  test('arrow keys cross groups as one list and step over a disabled row', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    const walked: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await field(page).press('ArrowDown');
      walked.push(await activeText(page));
    }
    // Titles, then Places (London, KY is a zero and is skipped), then Companies,
    // then Facts, and the last row holds: the list does not wrap.
    expect(walked.slice(0, 11)).toEqual([
      'Product Designer',
      'Product Design Manager',
      'Product Design Lead',
      'Product Design Director',
      'Principal Product Designer, Platform and Growth Experience',
      'London, United Kingdom',
      'London, Ontario, Canada',
      'Londonderry Mills',
      'Remote',
      '$150k+',
      '$150k+'
    ]);
    expect(walked).not.toContain('London, KY');

    // And up again from the last row, back across the same gap.
    await field(page).press('ArrowUp');
    expect(await activeText(page)).toBe('Remote');
  });

  test('a disabled row cannot be chosen from the keyboard', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    // Six downs lands on London, United Kingdom; the seventh must pass London, KY.
    for (let step = 0; step < 7; step += 1) await field(page).press('ArrowDown');
    expect(await activeText(page)).toBe('London, Ontario, Canada');
    await Promise.all([page.waitForURL(/\/board\?place=CA-ON%2FLondon$/), field(page).press('Enter')]);
  });

  test('Up from the first row returns to the typed text, and Enter then submits it', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).press('ArrowDown');
    await field(page).press('ArrowUp');
    await expect(field(page)).not.toHaveAttribute('aria-activedescendant', /.+/);
    await Promise.all([page.waitForURL(/\/board\?(?:.*&)?q=lon(?:&|$)/), field(page).press('Enter')]);
  });

  test('Enter with no row active submits the form with the words as typed', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await Promise.all([page.waitForURL(/\/board\?(?:.*&)?q=lon(?:&|$)/), field(page).press('Enter')]);
    expect(new URL(page.url()).pathname).toBe('/board');
  });

  test('Tab commits the active row', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).press('ArrowDown');
    await Promise.all([page.waitForURL(/\/board\?q=Product\+Designer$/), field(page).press('Tab')]);
  });

  test('Tab with nothing active closes the panel and moves on', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).press('Tab');
    await expect(panel(page)).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/board');
    await expect(field(page)).not.toBeFocused();
  });

  test('Escape closes the panel, keeps the text and leaves focus in the field', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).press('ArrowDown');
    await field(page).press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(field(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(field(page)).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('lon');
  });

  test('Down reopens a closed panel for the text that is there', async ({ page }) => {
    const seen = await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await field(page).press('Escape');
    await expect(panel(page)).toBeHidden();
    await field(page).press('ArrowDown');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    expect(seen).toHaveLength(2);
  });

  test('Backspace in an empty field removes the last chip, and only when the field is empty', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    // The markup SearchBox.astro renders for two applied chips: each a label and
    // a remove link whose href is the board without that chip. The first links to
    // /board?per=5 and the last to /board?sort=age, so the target says which one
    // the key reached for.
    await page.evaluate(() => {
      const list = document.createElement('ul');
      list.className = 'sb-chips';
      for (const [label, href] of [
        ['Remote', '/board?per=5'],
        ['$150k+', '/board?sort=age']
      ]) {
        const item = document.createElement('li');
        item.className = 'sb-chip';
        const remove = document.createElement('a');
        remove.className = 'sb-chip-x';
        remove.href = href;
        remove.textContent = 'x';
        item.append(label, remove);
        list.append(item);
      }
      document.querySelector('.sb-field')!.prepend(list);
    });

    await field(page).click();
    // With a character in the field, Backspace edits the text and nothing else.
    await field(page).press('x');
    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    await field(page).press('Backspace');
    await expect(field(page)).toHaveValue('');
    expect(new URL(page.url()).pathname).toBe('/board');
    expect(new URL(page.url()).search).toBe('');

    // Now it is empty, and the next Backspace takes the last chip.
    await Promise.all([page.waitForURL(/\/board\?sort=age$/), field(page).press('Backspace')]);
  });
});

test.describe('pointer', () => {
  test('pressing a row does not move focus off the field, and the release is a click', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    const row = panel(page).locator('[role="option"]', { hasText: 'Product Design Manager' });

    // The guard itself, in any engine: the row refuses the default of mousedown.
    // (Playwright's Firefox does not reproduce the focus race even with the guard
    // gone, so this is the half of the check that Firefox can carry.)
    expect(
      await row.evaluate((el) => {
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        el.dispatchEvent(press);
        return press.defaultPrevented;
      })
    ).toBe(true);

    // And the real press, which WebKit does order the way a trackpad does.
    await row.hover();
    await page.mouse.down();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-search');
    await expect(panel(page)).toBeVisible();
    await Promise.all([page.waitForURL(/\/board\?q=Product\+Design\+Manager$/), page.mouse.up()]);
  });

  test('clicking a disabled row does nothing: no navigation, panel still open, focus kept', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    const dead = panel(page).locator('[role="option"]', { hasText: 'London, KY' });
    await dead.hover();
    await page.mouse.down();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-search');
    await page.mouse.up();
    await sleep(400);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/board');
    await expect(panel(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
  });

  test('a press outside the box closes the panel', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await page.locator('.index-head').click();
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('one menu open at a time, across the box and the strip', () => {
  test('opening a strip dropdown closes the panel, and the field taking focus closes the strip', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await expect(panel(page)).toBeVisible();
    await expect(stripMenus(page)).toHaveCount(0);

    // Strip opens: the panel yields.
    await stripTrigger(page, 0).click();
    await expect(stripMenus(page)).toHaveCount(1);
    await expect(panel(page)).toBeHidden();
    await expect(field(page)).toHaveAttribute('aria-expanded', 'false');

    // The field takes focus, and a strip menu left open closes with no typing at
    // all: the strip's own click handler ignores a click inside a cell.
    await field(page).click();
    await expect(stripMenus(page)).toHaveCount(0);

    // Typing opens the panel again, and still only one menu is open.
    await field(page).pressSequentially('d');
    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    await expect(panel(page)).toBeVisible();
    await expect(stripMenus(page)).toHaveCount(0);

    // And the other strip dropdowns behave the same way.
    await stripTrigger(page, 1).click();
    await expect(stripMenus(page)).toHaveCount(1);
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('a wait always ends', () => {
  test('a fast answer never flashes "Searching..."', async ({ page }) => {
    await mockSuggest(page, async (route) => {
      await sleep(20);
      return answer(NORMAL)(route, new URL(route.request().url()));
    });
    await openBoard(page);
    await page.evaluate(() => {
      const w = window as unknown as { __sawStatus: boolean };
      w.__sawStatus = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-search-panel] .menu-status')) w.__sawStatus = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await typeAndWaitForRows(page);
    expect(await page.evaluate(() => (window as unknown as { __sawStatus: boolean }).__sawStatus)).toBe(false);
  });

  test('loading resolves to rows', async ({ page }) => {
    await mockSuggest(page, async (route, url) => {
      await sleep(700);
      return answer(NORMAL)(route, url);
    });
    await openBoard(page);
    await field(page).click();
    await field(page).pressSequentially('lon');

    // After 150 ms with no answer: one muted row, and nothing to choose.
    await expect(panel(page)).toHaveAttribute('data-state', 'loading');
    await expect(panel(page).locator('.menu-status')).toHaveText('Searching...');
    await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
    await expect(options(page)).toHaveCount(0);

    await expect(panel(page)).toHaveAttribute('data-state', 'results');
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    await expect(panel(page).locator('.menu-status')).toHaveCount(0);
    await expect(options(page)).toHaveCount(11);
  });

  test('loading resolves to an error, and that is where it stays', async ({ page }) => {
    await mockSuggest(page, async (route) => {
      await sleep(400);
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    });
    await openBoard(page);
    await field(page).click();
    await field(page).pressSequentially('lon');

    await expect(panel(page)).toHaveAttribute('data-state', 'loading');
    await expect(panel(page).locator('.menu-status')).toHaveText('Searching...');

    await expect(panel(page)).toHaveAttribute('data-state', 'error');
    await expect(panel(page).locator('.menu-status')).toHaveText('Suggestions are unavailable. Press Enter to search');
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');

    // Terminal: nothing changes it, and the box still searches.
    await sleep(700);
    await expect(panel(page)).toHaveAttribute('data-state', 'error');
    await expect(options(page)).toHaveCount(0);
    await field(page).press('ArrowDown');
    await expect(field(page)).not.toHaveAttribute('aria-activedescendant', /.+/);
  });

  test('after an error, Enter still submits the typed words', async ({ page }) => {
    await mockSuggest(page, (route) => route.fulfill({ status: 500, body: '{"error":"boom"}' }));
    await openBoard(page);
    await field(page).click();
    await field(page).pressSequentially('lon');
    await expect(panel(page)).toHaveAttribute('data-state', 'error');
    await Promise.all([page.waitForURL(/\/board\?(?:.*&)?q=lon(?:&|$)/), field(page).press('Enter')]);
  });

  test('loading resolves to "no suggestions", and that is where it stays', async ({ page }) => {
    await mockSuggest(page, async (route, url) => {
      await sleep(400);
      return answer(EMPTY)(route, url);
    });
    await openBoard(page);
    await field(page).click();
    await field(page).pressSequentially('zzzz');

    await expect(panel(page)).toHaveAttribute('data-state', 'loading');
    await expect(panel(page)).toHaveAttribute('data-state', 'empty');
    await expect(panel(page).locator('.menu-status')).toHaveText('No suggestions. Press Enter to search');
    await expect(panel(page)).toHaveAttribute('aria-busy', 'false');
    // Four empty groups are an empty answer, and none of them is drawn.
    await expect(panel(page).locator('[role="group"]')).toHaveCount(0);

    await sleep(700);
    await expect(panel(page)).toHaveAttribute('data-state', 'empty');
  });

  test('a request that never answers is cut off and ends in the error state', async ({ page }) => {
    await mockSuggest(page, () => new Promise<void>(() => {}));
    await openBoard(page);
    // The cutoff is six seconds for a person; a test lowers it, through the same
    // attribute the box reads at each request.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-search-box]')!.dataset.suggestTimeout = '700';
    });
    await field(page).click();
    await field(page).pressSequentially('lon');
    await expect(panel(page)).toHaveAttribute('data-state', 'loading');
    await expect(panel(page)).toHaveAttribute('data-state', 'error', { timeout: 4_000 });
    await expect(panel(page).locator('.menu-status')).toHaveText('Suggestions are unavailable. Press Enter to search');
  });

  test('an answer that is not the contract\'s shape, and a dropped connection, are both errors', async ({ page }) => {
    let mode: 'junk' | 'abort' = 'junk';
    await mockSuggest(page, (route) =>
      mode === 'junk'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"nope":1}' })
        : route.abort('failed')
    );
    await openBoard(page);
    await field(page).click();
    await field(page).pressSequentially('lon');
    await expect(panel(page)).toHaveAttribute('data-state', 'error');

    mode = 'abort';
    await field(page).pressSequentially('d');
    await expect(panel(page)).toHaveAttribute('data-state', 'error');
    await expect(panel(page).locator('.menu-status')).toHaveText('Suggestions are unavailable. Press Enter to search');
  });
});

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the panel is the box\'s full width, three rows a group, and More reveals the rest', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);

    // Full width under the box, and the page did not start to scroll sideways.
    const cell = await page.locator('[data-search-box]').boundingBox();
    const box = await panel(page).boundingBox();
    expect(Math.abs(box!.width - cell!.width)).toBeLessThanOrEqual(2);
    // The box is the strip's full width, and at 390 the page's own gutters take 66px of it.
    expect(box!.width).toBeGreaterThan(390 * 0.75);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // Titles has five rows: three, then a More row saying how many are held back.
    const titles = panel(page).locator('[role="group"][aria-label="Titles"]');
    await expect(titles.locator('[role="option"]')).toHaveCount(4);
    const more = titles.locator('[data-more="titles"]');
    await expect(more.locator('.menu-label')).toHaveText('More');
    await expect(more.locator('.menu-count')).toHaveText('+2');
    // Places has three rows, so it has no More.
    await expect(panel(page).locator('[data-more="places"]')).toHaveCount(0);

    // More is part of the keyboard list, and Enter on it opens the group instead
    // of leaving the page.
    for (let step = 0; step < 4; step += 1) await field(page).press('ArrowDown');
    expect(await field(page).getAttribute('aria-activedescendant')).toBe(await more.getAttribute('id'));
    await field(page).press('Enter');
    await expect(titles.locator('[role="option"]')).toHaveCount(5);
    await expect(titles.locator('[data-more]')).toHaveCount(0);
    expect(await activeText(page)).toBe('Product Design Director');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/board');
  });

  test('a press on More by pointer does the same and does not blur the field', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    const titles = panel(page).locator('[role="group"][aria-label="Titles"]');
    await titles.locator('[data-more="titles"]').hover();
    await page.mouse.down();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-search');
    await page.mouse.up();
    await expect(titles.locator('[role="option"]')).toHaveCount(5);
    await expect(panel(page)).toBeVisible();
  });
});

test.describe('a wide screen', () => {
  test('shows every row of every group and no More row', async ({ page }) => {
    await mockSuggest(page, answer(NORMAL));
    await openBoard(page);
    await typeAndWaitForRows(page);
    await expect(panel(page).locator('[data-more]')).toHaveCount(0);
    await expect(panel(page).locator('[role="group"][aria-label="Titles"] [role="option"]')).toHaveCount(5);
  });
});

test.describe('without JavaScript', () => {
  test('the box is a real q field in a GET form, and Enter searches', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/board', { waitUntil: 'domcontentloaded' });

      const input = page.locator('input[name="q"]');
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('type', 'search');
      // The form is the strip, it is a GET, and the Apply button script would
      // have hidden is the way through for a reader who has no Enter key.
      await expect(page.locator('form.filters-row')).toHaveAttribute('method', 'get');
      await expect(page.locator('.filter-apply')).toBeVisible();
      // No native datalist left behind, and the panel is shut.
      await expect(page.locator('datalist')).toHaveCount(0);
      await expect(input).not.toHaveAttribute('list', /.*/);
      await expect(page.locator('[data-search-panel]')).toBeHidden();

      await input.fill('analyst');
      await Promise.all([page.waitForURL(/\/board\?(?:.*&)?q=analyst(?:&|$)/), input.press('Enter')]);
      expect(new URL(page.url()).pathname).toBe('/board');
    } finally {
      await context.close();
    }
  });
});
