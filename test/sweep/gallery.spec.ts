import { expect, test } from 'playwright/test';

/**
 * The pixel gate — the SECOND attempt, and deliberately much smaller than the
 * first.
 *
 * WHAT KILLED THE FIRST ONE. The Index's gate 5 photographed 15 routes at two
 * widths in two themes: 384 shots against 60 committed baselines. 85 of those
 * shots were one job-page template whose content came from a crawl that ran every
 * night. Every comparable baseline failed the day after it was recorded, the only
 * workable response was to accept everything, and on 2026-09-06 the gate and its
 * baselines were deleted. It had been red since 2026-08-19, hiding five real
 * failures behind it.
 *
 * THE RULE THAT FOLLOWS. Never photograph content this repository does not author.
 * /board, /board/[slug], /jobs-data, /desk, /opportunities and /kills render rows
 * from the nightly sweep; they get the console gate and the ARIA gate and no
 * pixels, ever. What is photographed here is /_states and /_specimen: the real
 * components against fixed fixtures written in the repo. A pixel in these two
 * routes changes when a component changes, and at no other time.
 *
 * THE BUDGET. Seven sections in the states gallery, two themes: 14 baselines. The
 * ceiling is 40 and it is a real ceiling — the retired gate's 60-against-384 ratio
 * is the documented shape of this failing. Before adding a shot, delete one.
 *
 * ACCEPTING A CHANGE. `npm run conform:accept` re-records, and the new PNG lands
 * in the same commit as the change that caused it, reviewed in a diff like any
 * other file. If a baseline moves for a page you did not touch, that is the
 * regression this whole harness exists to show you.
 *
 * WHERE PIXELS DO NOT REACH. A pixel comparison has no time axis, so it cannot
 * see a state machine that reaches a correct-looking state at the wrong moment —
 * which is exactly what the /profile upload bug was. That belongs to the wire
 * contract tests and the journey specs. Screenshots are for layout drift, and
 * layout drift only.
 */

/** The seven authored groups in src/review/states.astro, by the id its own
 *  aria-labelledby points at. Section by section rather than one full-page shot:
 *  a full-page image fails as a single unreadable blob when one card moves, and a
 *  designer cannot tell from it what changed. */
const GROUPS = [
  { id: 'kills-states', what: 'the kill list' },
  { id: 'report-states', what: 'the report figures' },
  { id: 'capture-states', what: 'the capture module' },
  { id: 'profile-states', what: 'the Profile Record and the import band' },
  { id: 'draft-states', what: 'the drafted documents' },
  { id: 'settings-states', what: 'models and keys' },
  { id: 'elsewhere', what: 'states reachable in the product' }
] as const;

const THEMES = ['light', 'dark'] as const;

/** Both galleries exist only under `astro dev` or SPECIMEN=1 (astro.config.mjs).
 *  A run that cannot reach them must FAIL, not skip: a silent skip here is how
 *  the Index's census found a conformance run reporting six passes for one route. */
async function openGallery(page: import('playwright/test').Page, path: string, theme: string) {
  // Seeded before any page script runs, so the pre-paint theme resolver in
  // BaseLayout picks it up and there is no flash of the other theme to catch.
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem('theme', value);
    } catch {
      /* private mode: the data-theme fallback below still applies */
    }
  }, theme);

  const response = await page.goto(path, { waitUntil: 'load' });
  expect(
    response?.status(),
    `${path} did not load. Both review galleries are injected by astro.config.mjs ` +
      'under `astro dev` or SPECIMEN=1; if this is 404 the integration is gone and ' +
      'the pixel gate is measuring nothing.'
  ).toBeLessThan(400);

  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

  // Web fonts change metrics when they land. Without this the first shot of a
  // cold run is the fallback face and every later one is not.
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  test.describe(`the states gallery, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await openGallery(page, '/_states', theme);
    });

    for (const group of GROUPS) {
      test(`${group.what} looks as recorded`, async ({ page }) => {
        const section = page.locator(`section.group[aria-labelledby="${group.id}"]`);
        await expect(
          section,
          `src/review/states.astro no longer has a section labelled ${group.id}. ` +
            'Either it was renamed (update GROUPS here) or the gallery lost a group, ' +
            'which means these states are no longer being watched by anything.'
        ).toBeVisible();

        await expect(section).toHaveScreenshot(`states-${group.id}-${theme}.png`, {
          stylePath: './test/sweep/freeze.css',
          animations: 'disabled',
          caret: 'hide',
          // Not zero. Sub-pixel text rasterisation varies between runs on one
          // machine, and a gate that goes red on that is a gate you stop reading.
          maxDiffPixelRatio: 0.002,
          threshold: 0.2
        });
      });
    }

    test('and the gallery still holds every group it claims', async ({ page }) => {
      // The count, asserted separately. A renamed section fails its own test
      // above; a DELETED section would otherwise pass everything silently, which
      // is the shape of failure this whole file is written against.
      const sections = page.locator('section.group[aria-labelledby]');
      await expect(sections).toHaveCount(GROUPS.length);
    });
  });
}

test.describe('the token specimen', () => {
  // The specimen is 1,876 lines and renders every token in every context the
  // product uses it in. It gets ARIA rather than pixels: it is one enormous page,
  // a full-page image of it would be unreadable as a diff, and its whole purpose
  // is that the VALUES are right — which the token resolution gate
  // (scripts/check-tokens.mjs) and the computed-style differ read directly.
  test('renders, and names the tokens it is sampling', async ({ page }) => {
    await openGallery(page, '/_specimen', 'light');
    const samples = page.locator('[data-token]');
    await expect(
      samples.first(),
      'The specimen renders no [data-token] samples. Those attributes are what any ' +
        'contrast or token audit reads the computed colour off; without them the ' +
        'page is a picture rather than an instrument.'
    ).toBeVisible();
    expect(await samples.count()).toBeGreaterThan(20);
  });
});
