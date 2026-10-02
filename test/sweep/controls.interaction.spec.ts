import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page } from 'playwright/test';

/**
 * Interaction specs: the ones that only fail under a real browser engine, never
 * under a DOM shim. Kept to exactly three (docs/regression-strategy.md, Layer 1
 * vs Layer 2 vs here): a browser-behaviour bug, a client-side restore that has
 * fired on the wrong page twice, and an endpoint that has been silently
 * unreachable before. None of the three is caught by `astro check`, a unit
 * test, or an ARIA snapshot, because none of them is wrong-looking markup —
 * each one is a correct DOM in the wrong sequence of events.
 *
 * WHY THIS FILE, NOT MORE ROUTES.PUBLIC/SIGNEDIN ASSERTIONS. Those specs drive
 * Chromium and check "did the page load and stay quiet." These three need the
 * actual sequence of focus, blur and click events a specific engine produces,
 * which is exactly what a headless DOM (jsdom/happy-dom) and Chromium itself do
 * not reproduce for the first spec below (.claude/rules/dropdown-focus.md).
 */

test.describe('the come-ready title dropdown (.claude/rules/dropdown-focus.md)', () => {
  /**
   * StepTitles.astro's suggestion panel is the dropdown the rule file names:
   * `form.addEventListener('focusout', ...)` closes the panel, and a press on
   * a `role="option"` row moves focus before the click resolves in Safari and
   * Firefox on macOS, so the row is gone before mouseup and the click never
   * fires at all — the title is never added, silently. The component's own
   * `panel.addEventListener('mousedown', ...)` guard (StepTitles.astro:381-384)
   * is the fix already in place; this spec is what would have caught its
   * absence and what breaks the moment someone removes it.
   *
   * NEEDS A SESSION. /start is gated at the waitlisted rank
   * (src/lib/entitlement.ts:151) and the titles step needs a signed-in member
   * or paid account to render at all — see wire_in for the project change this
   * spec needs to actually run under webkit-interactions.
   */
  test('choosing a suggested title adds it and closes the panel', async ({ page }) => {
    // ?step=4 forces the free edition straight to the titles step
    // (src/lib/come-ready.ts:220, requestedStep against the allowed list),
    // so this does not depend on the fixture account's email-verified state.
    const response = await page.goto('/start?step=4', { waitUntil: 'domcontentloaded' });
    expect(response?.status(), '/start?step=4 as a signed-in member').toBeLessThan(400);
    expect(
      /\/(sign-in|waitlist)\b/.test(page.url()),
      `/start?step=4 redirected to ${page.url()} — the storageState this project loaded is not ` +
        'a valid signed-in member session. Re-run `npx playwright test --project=setup`.'
    ).toBe(false);

    const form = page.locator('form[data-cr-combo]').first();
    const input = form.locator('[data-cr-combo-input]');
    const panel = form.locator('[data-cr-combo-panel]');
    const rows = form.locator('[data-cr-combo-row]');

    await expect(input, 'the add-a-title field never rendered on the titles step').toBeVisible();

    // Focus the field, don't rely on the server's autofocus. A fixture
    // account that already has a core title from an earlier run of this
    // exact spec renders with autofocus={!hasTitle} = false and the panel
    // server-hidden (StepTitles.astro:109,118) — a real reader opens it by
    // clicking in, so this click is both the realistic interaction and what
    // makes the spec idempotent against its own prior runs.
    await input.click();
    await expect(panel, 'the suggestion panel never opened after focusing the field').toBeVisible();

    const rowCount = await rows.count();
    test.skip(rowCount === 0, 'the live title index is empty on this fixture, so there is no row to press');

    // Skip rows already on this account's core shelf (form's own
    // data-cr-have, StepTitles.astro:93) rather than always pressing the
    // first one: a title already on file is a legitimate "no-op, already
    // watched" answer from the app (see the submit guard a few lines below
    // in StepTitles.astro's script), and pressing one on a fixture this spec
    // itself populated on a previous run would produce that no-op instead of
    // the add this test is trying to observe.
    const have: string[] = JSON.parse((await form.getAttribute('data-cr-have')) ?? '[]');
    const haveLower = new Set(have.map((t) => t.toLowerCase()));
    let target = rows.first();
    let chosen: string | null = null;
    for (let i = 0; i < rowCount; i += 1) {
      const candidate = rows.nth(i);
      const title = await candidate.getAttribute('data-title');
      if (title && !haveLower.has(title.toLowerCase())) {
        target = candidate;
        chosen = title;
        break;
      }
    }
    test.skip(chosen === null, 'every suggested title is already on this account\'s core shelf');

    // The pointer-driven press the rule is about: mousedown then mouseup on the
    // row, exactly what a real click is built from. This is deliberately not
    // page.fill() + a separate button click, which would never exercise the
    // focusout race at all. The row's own click handler sets the field and
    // calls requestSubmit() synchronously, so the field's value is not a
    // reliable thing to assert on — by the time this line runs the POST below
    // may already have redirected the page out from under the old DOM, and a
    // value check racing that navigation is exactly the kind of flake that
    // teaches you to stop reading a gate. Waiting on the network request the
    // click has to produce is the non-racy version of "the click landed":
    // if Safari/Firefox eat the click (the bug), requestSubmit() is never
    // called and this wait times out instead of silently passing on a page
    // that never moved.
    const [watchResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/ledger/watch') && res.request().method() === 'POST', {
        timeout: 10_000
      }),
      target.click()
    ]);
    expect(
      watchResponse.status(),
      `POST /ledger/watch answered ${watchResponse.status()} for adding "${chosen}"`
    ).toBeLessThan(400);
    await page.waitForURL(/\/start(\?step=4)?$/, { timeout: 10_000, waitUntil: 'domcontentloaded' });

    const addedRow = page.locator('.cr-title-name', { hasText: chosen! });
    await expect(
      addedRow,
      `"${chosen}" never showed up in "Core, apply today" after the press. Either the click on the ` +
        'suggestion row never fired (StepTitles.astro\'s mousedown guard is gone) or the add itself failed.'
    ).toBeVisible();

    // The title is now on the shelf, so the fresh page renders hasTitle=true
    // and the panel's own `hidden={hasTitle}` (StepTitles.astro:118) keeps it
    // closed — the field this whole press was trying to change. `panel` now
    // resolves against the post-navigation DOM (Playwright locators re-query
    // lazily), so this is still the same element the rule cares about.
    await expect(panel).toBeHidden();
  });
});

/**
 * THE MEMBER'S SAVED SELECTION IS ONE ROW, AND EVERY TEST BELOW SHARES IT.
 * webkit-interactions and firefox-interactions both sign in as `member`, and
 * `routes.signedin.spec.ts` does too, so a test that saves a selection to the
 * account and a test that expects the account to be empty are talking about the
 * same row. They run in parallel, in two engines, so without a rule one of them
 * finds the other's selection where it expected none. The rule: the tests that
 * write the account take a lock (a directory is the one atomic thing the
 * filesystem offers every worker), start from nothing saved, and leave nothing
 * saved. `.sweep/` is where a run's own files go and is git-ignored.
 */
const SAVED_LOCK = join(process.cwd(), '.sweep', 'locks', 'member-saved-filters');
const SAVED_LOCK_STALE_MS = 90_000;
const NOTHING_SAVED = { place: 'all', remote: 'all', pay_min: 'all' };

async function saveSelection(page: Page, selection: unknown): Promise<unknown> {
  const response = await page.request.post('/settings/filters', { data: { selection } });
  expect(response.status(), 'POST /settings/filters').toBe(200);
  return ((await response.json()) as { selection: unknown }).selection;
}

async function savedSelection(page: Page): Promise<unknown> {
  const response = await page.request.get('/settings/filters');
  expect(response.status(), 'GET /settings/filters: the member is signed in').toBe(200);
  return ((await response.json()) as { selection: unknown }).selection;
}

async function withSavedSelection(page: Page, body: () => Promise<void>): Promise<void> {
  test.setTimeout(90_000);
  mkdirSync(dirname(SAVED_LOCK), { recursive: true });
  for (;;) {
    try {
      mkdirSync(SAVED_LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock a crashed run left behind is not worth waiting for.
      try {
        if (Date.now() - statSync(SAVED_LOCK).mtimeMs > SAVED_LOCK_STALE_MS) rmSync(SAVED_LOCK, { recursive: true, force: true });
      } catch {
        /* Released between the two calls: take it on the next turn. */
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  try {
    await saveSelection(page, {});
    await body();
  } finally {
    // Whatever the page was still saving has landed by now: every test below
    // waits for the account to say what it expects before it moves on.
    await saveSelection(page, {}).catch(() => undefined);
    rmSync(SAVED_LOCK, { recursive: true, force: true });
  }
}

const exactly = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const stripCell = (page: Page, name: string): Locator =>
  page.locator('.filters-row > .filter').filter({ has: page.locator('.filter-label', { hasText: exactly(name) }) });
const stripValue = (page: Page, name: string): Locator => stripCell(page, name).locator('.filter-value');

/** Open a strip control, press one of its rows, and wait for the form it submits to land on an address that matches. */
async function pick(page: Page, control: string, option: string, address: RegExp): Promise<void> {
  await stripValue(page, control).click();
  const menu = page.locator('.filters > .menu:not([hidden])');
  const row = menu.locator('[role="option"]', { has: page.locator('.menu-label', { hasText: exactly(option) }) });
  await Promise.all([page.waitForURL(address), row.click()]);
  await expect(page.locator('[data-filters][data-js]')).toBeAttached();
}

/** Forget what this browser kept, so only the account can bring a selection back. */
async function forgetBrowserCopy(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.localStorage.removeItem('ti-index-filters:v1'));
}

/** Arrive at the bare board from another page of the site, the way a link or the nav does. On Firefox this promise can
    reject with NS_BINDING_ABORTED when the restore navigates at once; the poll the caller makes reads the address instead. */
async function arriveAtTheBoard(page: Page): Promise<void> {
  await page.goto('/board', { waitUntil: 'domcontentloaded', referer: new URL('/', page.url()).href }).catch(() => undefined);
}

/** The strip's three facts the address is narrowed by, as the names that are not "all". The box draws no chip for any of
    them (owner, 2026-10-02: Location, Remote and Comp are shown, changed and cleared only through their controls), so a
    cleared board is read from the address and the controls, never from a chip. A form writes the default as `all` or
    leaves the name out, and both are no narrowing. */
const narrowing = (page: Page): string[] => {
  const address = new URL(page.url()).searchParams;
  return ['place', 'remote', 'pay_min'].filter((name) => address.getAll(name).some((value) => value !== 'all'));
};

/** The chips the search box draws: a company and a posted-within window only, each with its own remove link. */
const boxChips = (page: Page): Locator => page.locator('.sb-chip');

test.describe('a saved board filter (commit 54435b9)', () => {
  /**
   * src/components/Filters.astro's applySelection() only replaces the address
   * on a bare navigation to the board's OWN path (see its comment, lines
   * 498-518): a saved selection means "start me where I left off," and that
   * restore fired on the home page's embedded board section too, on
   * 2026-09-22, sending every visitor with a saved filter from / to
   * /board?... and making the home page's other sections "flip" away. Two
   * assertions, because the fix is the second one and a spec that only checks
   * the board would pass on a regression of exactly that line.
   */
  test('restores on /board and does not restore on /', async ({ page }) => {
    await withSavedSelection(page, async () => {
      // remote=onsite and place=US: the seeded test-db fixture (scripts/test-db.mjs)
      // has one remote job, no hybrid and five on-site, and three of its six are in
      // the United States. The strip draws every option now, zero ones muted, so
      // nothing here depends on an option surviving; these two are simply the ones
      // with rows, so the saved selection is a real narrowing of the board. The two
      // controls are different mechanisms (a checkbox group and a select), so both
      // have to come back.
      const setResponse = await page.goto('/board?remote=onsite&place=US', { waitUntil: 'domcontentloaded' });
      expect(setResponse?.status(), '/board?remote=onsite&place=US').toBeLessThan(400);
      await expect(page.locator('[data-filter-multi="remote"] input[value="onsite"]')).toBeChecked();
      await expect(page.locator('[data-filter-group="place"]')).toHaveValue('US');

      // 2. Reload the board's bare address. The saved selection must restore:
      //    this is the spec confirming a real saved-filter feature exists at
      //    all, not just that nothing crashes.
      //
      // Not page.goto() + page.waitForURL(): the redirect this is waiting for
      // is itself a same-tab client navigation the page's own script fires
      // almost immediately after DOMContentLoaded (Filters.astro's
      // applySelection()), and on Firefox that lands squarely on a known
      // Playwright/Gecko rough edge — the original navigation's own promise
      // (goto, or a waitForURL racing the 'load' event behind it) rejects with
      // NS_BINDING_ABORTED because Gecko tears down the first document before
      // it ever settles. Polling page.url() reads the frame's current address
      // without hooking into that per-navigation promise machinery at all, so
      // it has nothing to abort.
      await page.goto('/board').catch(() => {
        /* Ignore: on Firefox this promise itself can reject with
           NS_BINDING_ABORTED for the reason above, even though the
           navigation it started completes and the poll below observes it. */
      });
      await expect
        .poll(() => page.url(), {
          timeout: 5_000,
          message: 'the board never redirected to its own saved selection after a bare reload'
        })
        .toMatch(/\/board\?(?=.*remote=onsite)(?=.*place=US)/);
      await expect(page.locator('[data-filter-multi="remote"] input[value="onsite"]')).toBeChecked();
      await expect(page.locator('[data-filter-group="place"]')).toHaveValue('US');

      // 3. The regression itself: the SAME saved selection must NOT restore on
      //    the home page, which embeds the identical Board/Filters component in
      //    server mode with the same boardPath. Bare navigation, no query — if
      //    54435b9's guard (`here !== boardPath`) is ever lost, this is a
      //    window.location.replace to /board?remote=onsite&place=US and the assertion
      //    below is what catches it.
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      // Give the restore script a beat to run and (wrongly) navigate if the
      // guard is gone; a fixed wait rather than waitForURL because the pass
      // condition here is that nothing happens.
      await page.waitForTimeout(500);
      const url = new URL(page.url());
      expect(
        url.pathname === '/' && url.search === '',
        `/ ended up at ${page.url()} after loading with a saved board filter in localStorage. ` +
          'Filters.astro\'s applySelection() must only redirect on the board\'s own bare address ' +
          '(the guard commit 54435b9 added) — this is the home page "flip" bug, restored.'
      ).toBe(true);
    });
  });

  /**
   * THE ACCOUNT KEEPS THE STRIP (2026-10-02). The strip writes place, remote
   * (several) and a pay floor, and the account's saved selection used to keep
   * only the first strip's location, comp and freshness, so a member's new
   * choices lived in one browser's localStorage and nowhere else. Each test
   * below throws the browser's copy away before it comes back, so what restores
   * can only have come from the account.
   */
  test('the account brings back Location, two Remote kinds and a floor, with no browser memory of them', async ({ page }) => {
    await withSavedSelection(page, async () => {
      await page.goto('/board', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-filters][data-js]')).toBeAttached();

      // THE ORDER IS THE FIXTURE'S. Every option is counted under the OTHER filters and a zero is refused, so a
      // choice only works while it still leaves a row. The one remote posting is in Canada and every on-site one is
      // elsewhere: Location first would leave Remote at zero, and no country holds both. Arrangements first, then a
      // country that has some of either (the United States: three), then a floor one of those clears ($150k at Figma).
      await pick(page, 'Remote', 'Remote', /\/board\?(?=.*remote=remote)/);
      await pick(page, 'Remote', 'On-site', /\/board\?(?=.*remote=remote)(?=.*remote=onsite)/);
      await pick(page, 'Location', 'United States', /[?&]place=US(?:&|$)/);
      await pick(page, 'Comp', '$100k+', /[?&]pay_min=100(?:&|$)/);
      await expect(stripValue(page, 'Remote')).toHaveText('Remote + On-site');

      // The account says so, in the same three names the strip writes.
      await expect
        .poll(() => savedSelection(page), { message: 'the account never held the strip the member had just chosen' })
        .toEqual({ place: 'US', remote: 'remote,onsite', pay_min: '100' });

      // Leave, forget this browser's copy, and come back to the bare board from elsewhere.
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await expect
        .poll(() => page.url(), { timeout: 8_000, message: 'a bare arrival at the board never restored the selection the account holds' })
        .toMatch(/\/board\?(?=.*place=US)(?=.*remote=remote(?:%2C|,)onsite)(?=.*pay_min=100)/);
      await expect(stripValue(page, 'Location')).toHaveText('United States');
      await expect(stripValue(page, 'Remote')).toHaveText('Remote + On-site');
      await expect(stripValue(page, 'Comp')).toHaveText('$100k+');
    });
  });

  test('clearing the board from the board stays cleared, in the account as well as the browser', async ({ page }) => {
    // REWRITTEN 2026-10-02 (owner: the search box draws no chip for a fact a strip control shows). This used to take
    // Location, Remote and Comp off with their chips' x, the last of which landed on a bare /board. They have no chip
    // now, so the member clears them where they are shown and changed: through their controls. What it protects is
    // unchanged: a member who clears every filter from the board is not sent back to the selection the account held,
    // the account is told it is empty, and a fresh arrival with no browser memory is not narrowed. The address after
    // the last control is not bare (a form writes place=all and the like), so "cleared" is read as no narrowing,
    // not as an empty query string.
    await withSavedSelection(page, async () => {
      expect(await saveSelection(page, { place: 'US', remote: 'onsite', pay_min: '100' })).toEqual({ place: 'US', remote: 'onsite', pay_min: '100' });
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await expect
        .poll(() => page.url(), { timeout: 8_000, message: 'a bare arrival at the board never restored the selection the account holds' })
        .toMatch(/\/board\?(?=.*place=US)(?=.*remote=onsite)(?=.*pay_min=100)/);
      // The three show in their controls, and the box draws no chip for any of them.
      await expect(stripValue(page, 'Location')).toHaveText('United States');
      await expect(stripValue(page, 'Remote')).toHaveText('On-site');
      await expect(stripValue(page, 'Comp')).toHaveText('$100k+');
      await expect(boxChips(page)).toHaveCount(0);
      await expect(page.locator('[data-filters][data-js]')).toBeAttached();

      // Take every filter off through its own control. Worldwide, All and Any are always live, whatever the other
      // filters leave. Each lands on the board reached FROM the board, which is an emptied selection and not an
      // arrival: nothing restores, and the account is told.
      await pick(page, 'Location', 'Worldwide', /\/board\?(?!.*place=US)/);
      await pick(page, 'Remote', 'All', /\/board\?(?!.*remote=)/);
      await pick(page, 'Comp', 'Any', /\/board\?(?!.*pay_min=\d)/);
      // Give a (wrong) restore its moment: it is a client navigation the script fires at once.
      await page.waitForTimeout(700);
      expect(narrowing(page), 'the last filter was put back by the saved selection').toEqual([]);
      expect(new URL(page.url()).pathname).toBe('/board');
      await expect(boxChips(page)).toHaveCount(0);
      await expect(stripValue(page, 'Location')).toHaveText('Worldwide');
      await expect(stripValue(page, 'Remote')).toHaveText('All');
      await expect(stripValue(page, 'Comp')).toHaveText('Any');

      await expect
        .poll(() => savedSelection(page), { message: 'the account still held the selection the member had just cleared' })
        .toEqual(NOTHING_SAVED);

      // And it stays cleared for a fresh arrival with no browser memory at all. This one IS a bare address: nothing
      // was typed into it, and nothing the account holds may be added to it.
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await page.waitForTimeout(700);
      expect(new URL(page.url()).search, 'a cleared account selection came back on a fresh arrival').toBe('');
      expect(narrowing(page)).toEqual([]);
    });
  });

  test('a selection written in the first strip\'s names comes back as the strip it means', async ({ page }) => {
    await withSavedSelection(page, async () => {
      // location is the old name of remote, a band is its lower bound as a floor, and freshness is no longer offered.
      expect(await saveSelection(page, { location: 'onsite', comp: '150-200', freshness: 'fresh' })).toEqual({
        place: 'all',
        remote: 'onsite',
        pay_min: '150'
      });
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await expect
        .poll(() => page.url(), { timeout: 8_000, message: 'a bare arrival at the board never restored the selection the account holds' })
        .toMatch(/\/board\?(?=.*remote=onsite)(?=.*pay_min=150)/);
      const address = new URL(page.url()).searchParams;
      expect([...address.keys()].sort(), 'the restore carried an old name or a freshness to the address').toEqual(['pay_min', 'remote']);
      await expect(stripValue(page, 'Remote')).toHaveText('On-site');
      await expect(stripValue(page, 'Comp')).toHaveText('$150k+');
    });
  });

  test('a city and a floor the board does not list restore too: the address reads them, so the restore carries them', async ({ page }) => {
    await withSavedSelection(page, async () => {
      // The bare board lists countries and the standard floors. A city (the search box's suggestions write one) and
      // a typed floor are on no such list, and a restore that asked "is it an option?" would drop them and keep the
      // rest. The Location control names the city in full; the box draws no chip for it.
      expect(await saveSelection(page, { place: 'GB/London', remote: 'all', pay_min: '175' })).toEqual({ place: 'GB/London', remote: 'all', pay_min: '175' });
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await expect
        .poll(() => page.url(), { timeout: 8_000, message: 'a bare arrival at the board never restored the account\'s selection' })
        .toMatch(/\/board\?(?=.*place=GB%2FLondon)(?=.*pay_min=175)/);
      await expect(stripValue(page, 'Comp')).toHaveText('$175k+');
      await expect(stripValue(page, 'Location')).toHaveText('London, United Kingdom');
      await expect(boxChips(page)).toHaveCount(0);
    });
  });

  test('Not stated is a place the account can keep: saved as place=unstated, restored to the address, drawn as the chosen row', async ({ page }) => {
    await withSavedSelection(page, async () => {
      // The account validates a saved place through the address's own reader, and `unstated` is a value it reads now
      // (it was dropped to "all" while no key could name the rows with no resolved country).
      expect(await saveSelection(page, { place: 'unstated', remote: 'all', pay_min: 'all' })).toEqual({ place: 'unstated', remote: 'all', pay_min: 'all' });
      await forgetBrowserCopy(page);
      await arriveAtTheBoard(page);
      await expect
        .poll(() => page.url(), { timeout: 8_000, message: 'a bare arrival at the board never restored a saved Not stated' })
        .toMatch(/\/board\?(?=.*place=unstated)/);
      expect([...new URL(page.url()).searchParams.keys()], 'the restore carried more than the one place').toEqual(['place']);
      // The Location control is the only place Not stated is shown (owner, 2026-10-02): it reads "Not stated", and the
      // box draws no "Location not stated" chip beside it, which is what it used to do.
      await expect(stripValue(page, 'Location')).toHaveText('Not stated');
      await expect(boxChips(page)).toHaveCount(0);
      // Choosing Worldwide takes it off the address and out of the account.
      await pick(page, 'Location', 'Worldwide', /\/board\?(?!.*place=unstated)/);
      await expect
        .poll(() => savedSelection(page), { message: 'the account kept Not stated after the reader chose Worldwide' })
        .toEqual(NOTHING_SAVED);
    });
  });
});

test.describe('the waitlist form, signed out (dead 2026-09-13 to 2026-09-20)', () => {
  // Cleared, not inherited: once webkit-interactions carries a storageState
  // for test 1 above (see wire_in), every test in this FILE would otherwise
  // run signed in, and /sign-up redirects a signed-in viewer straight to
  // /account (src/pages/sign-up.astro:32) before the waitlist form ever
  // renders — which would silently turn "signed out" into "skipped" instead
  // of failing loudly. This is a per-describe override, not a config edit.
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * /waitlist/join used to live at /api/waitlist, where the repo-root api/
   * directory (still present — .claude/rules/no-pages-api.md) claimed the
   * path on Vercel before Astro ever saw the request, and the form's fetch
   * got a platform 404 that its own error path swallowed: no position, no
   * visible error, just silence. This drives the real, rendered form exactly
   * as a visitor would and requires a real, rendered answer — success or a
   * visible error, never nothing.
   */
  test('submitting a real address gets a visible answer, not silence', async ({ page }) => {
    const response = await page.goto('/sign-up', { waitUntil: 'domcontentloaded' });
    expect(response?.status(), '/sign-up').toBeLessThan(400);

    const form = page.locator('#wl-form');
    // flags.config.mjs: waitlist is on in the design edition, which is the
    // only one that deploys — if that ever flips, this is the form that goes
    // missing and the account-creation form takes its place instead.
    test.skip(
      (await form.count()) === 0,
      '#wl-form is not on /sign-up — the waitlist flag is off, so this is the account-creation ' +
        'form instead (flags.config.mjs, waitlist.editions.design)'
    );

    // RFC 2606: .test is reserved for exactly this, and this row lands in
    // antialgo_test, which scripts/test-db.mjs owns and throws away on every
    // reset. Unique per run so two CI machines racing this spec do not fight
    // over one email's position.
    const email = `sweep-${Date.now()}-${Math.floor(Math.random() * 1e6)}@controls-interaction.test`;

    const [joinResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/waitlist/join') && res.request().method() === 'POST'),
      form.locator('#wl-email').fill(email).then(() => form.locator('button[type="submit"]').click())
    ]);

    expect(
      joinResponse.status(),
      `/waitlist/join answered ${joinResponse.status()} for a well-formed email. A 404 here is the ` +
        'exact shape of the 2026-09-13 incident: the root api/ directory (or whatever replaces it) ' +
        'claiming this path before Astro\'s own route sees the request.'
    ).toBe(200);
    const body = (await joinResponse.json()) as { ok?: boolean; position?: number };
    expect(body.ok, `/waitlist/join answered ${JSON.stringify(body)}`).toBe(true);

    // The visible half of the same fact: a real reader has no console open.
    // The position line must actually appear, and the error line must not —
    // both silent is exactly the bug this spec exists to catch.
    await expect(
      page.locator('#wl-position'),
      'the form went quiet after submitting: no position shown and (checked below) no error either — ' +
        'the exact shape of the dead-waitlist incident, where the fetch failed and nothing told the reader'
    ).toBeVisible();
    await expect(page.locator('#wl-position')).toContainText(`#${body.position}`);
    await expect(page.locator('#wl-error')).toBeHidden();
  });
});
