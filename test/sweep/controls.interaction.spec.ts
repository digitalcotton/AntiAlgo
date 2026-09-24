import { expect, test } from 'playwright/test';

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
    // location=onsite, not =remote: the seeded test-db fixture
    // (scripts/test-db.mjs) has zero remote jobs, and src/lib/data.ts's group
    // builder drops a zero-count option from the list entirely once it is not
    // the current selection (the "stale save, retired band" case
    // Filters.astro's applySelection() comment names) — so a saved
    // location=remote would never be found among the bare board's own
    // <option> values and this spec would fail for a reason that has nothing
    // to do with the restore logic it exists to guard. onsite covers all six
    // fixture jobs and is never absent from the list.
    const setResponse = await page.goto('/board?location=onsite', { waitUntil: 'domcontentloaded' });
    expect(setResponse?.status(), '/board?location=onsite').toBeLessThan(400);
    await expect(page.locator('[data-filter-group="location"]')).toHaveValue('onsite');

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
      .toMatch(/\/board\?.*location=onsite/);
    await expect(page.locator('[data-filter-group="location"]')).toHaveValue('onsite');

    // 3. The regression itself: the SAME saved selection must NOT restore on
    //    the home page, which embeds the identical Board/Filters component in
    //    server mode with the same boardPath. Bare navigation, no query — if
    //    54435b9's guard (`here !== boardPath`) is ever lost, this is a
    //    window.location.replace to /board?location=onsite and the assertion
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
