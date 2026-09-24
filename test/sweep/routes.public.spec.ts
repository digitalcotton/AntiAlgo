import { expect, test } from 'playwright/test';
import { pageRoutes, browsableRoutes } from './manifest';

/**
 * THE LAYER THAT EARNS ITS KEEP: load every public route in a real browser and
 * fail on anything the browser complains about.
 *
 * No baselines. Nothing to re-record, nothing to accept, nothing that can rot. It
 * cannot go red because a font shifted or a crawl ran overnight. That matters more
 * than it sounds: the reason to build this before the pixel gate is that there is
 * no accept step to abandon, and abandoning the accept step is how the last visual
 * gate died.
 *
 * WHAT IT WOULD HAVE CAUGHT, from this repo's own history:
 *   edfc2ec  "Every board load threw a ReferenceError at the first save or probe."
 *            One `page.on('pageerror')` on /board, in under a second.
 *   the root api/ directory shadowing Astro's /api routes for a week — a status
 *            probe on the shadowed path.
 *   the /profile upload spinner — not this spec (it needs a session and a file),
 *            but its sibling below.
 *
 * WHY console errors ARE fatal here. A console error is the browser saying it could
 * not do something it was told to do. This repo's most expensive bugs have all been
 * silent in exactly that way: the page renders, the behaviour is gone. Tolerating
 * the noise means tolerating the signal. If a third party ever makes this noisy,
 * stub it with page.route rather than lowering the bar.
 */

const ROLE = 'signed-out' as const;

/** Routes whose job is to answer an error status. /404 answering 404 is the route
 *  working, not failing — the first run of this spec reported it as a failure,
 *  which is a good reminder that "status < 400" is an assumption and not a law. */
const EXPECTED_STATUS: Record<string, number> = {
  '/404': 404
};

/** Where a closed route is allowed to send a stranger.
 *
 *  `sign-up` is on this list because the first run of this spec flagged all 23
 *  gated routes as leaks: they redirect to /sign-up?from=sign-in, and the pattern
 *  only knew about /sign-in. The gate was right and the test was wrong. Worth
 *  recording, because the same mistake in the other direction — a door pattern so
 *  loose it matches anything — would turn this whole block into decoration. */
const DOORS = /\/(sign-in|sign-up|login|waitlist|start|upgrade|verify-email)\b/;

test.describe('every public page loads clean, signed out', () => {
  for (const { entry, path } of pageRoutes(ROLE).filter((r) => r.allowed)) {
    test(`${path}`, async ({ page }) => {
      const complaints: string[] = [];
      page.on('pageerror', (error) => complaints.push(`uncaught: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') complaints.push(`console.error: ${message.text()}`);
      });
      // A request that fails outright (not a 404 response — a connection that died)
      // is usually a script tag pointing at something that no longer exists.
      page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText ?? 'unknown';
        if (!failure.includes('ERR_ABORTED')) complaints.push(`request failed: ${request.url()} (${failure})`);
      });

      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });

      const expected = EXPECTED_STATUS[path];
      if (expected !== undefined) {
        expect(response?.status(), `${path} is meant to answer ${expected}`).toBe(expected);
      } else {
        expect(response?.status(), `${path} answered ${response?.status()}`).toBeLessThan(400);
      }

      // Not just "the HTML arrived" — an empty shell is this app's real failure
      // shape, and it answers 200. `main` exists in BaseLayout, so every page has
      // one; a page without a visible one has lost its content.
      await expect(
        page.locator('main, [role="main"]').first(),
        `${path} rendered no visible main landmark — an empty shell answers 200 just as happily as a page`
      ).toBeVisible();

      // A route that is MEANT to answer an error status makes the browser log a
      // console error about the document itself ("Failed to load resource: the
      // server responded with a status of 404"). That is the browser narrating the
      // expected answer, not a fault on the page, so it is dropped — and only for
      // the exact status this route is meant to give, so a genuinely broken
      // sub-resource on /404 still fails.
      const narration =
        expected !== undefined && expected >= 400
          ? new RegExp(`Failed to load resource.*status of ${expected}\\b`)
          : null;
      const real = narration ? complaints.filter((line) => !narration.test(line)) : complaints;

      expect(real, `${path} made the browser complain:\n  ${real.join('\n  ')}`).toEqual([]);
    });
  }
});

test.describe('and nothing gated leaks to a signed-out visitor', () => {
  // The other half, and the half that would actually matter if it broke. 43 routes
  // are meant to be closed to a stranger. A gate removed by accident does not throw
  // and does not look wrong — it just serves paid content to the world. The census
  // computes who may see what from src/lib/entitlement.ts and src/middleware.ts;
  // this asserts the app agrees with it.
  for (const { entry, path } of browsableRoutes(ROLE).filter((r) => !r.allowed)) {
    test(`${path} is closed (${entry.audienceDecisions['signed-out'].reason})`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 0;
      const url = page.url();

      // Three shapes of "no", all acceptable: a redirect that landed on the door,
      // a refusal status, or a 404 for something that must not admit it exists.
      const landedAtDoor = DOORS.test(url);
      const refused = status === 401 || status === 403 || status === 404;

      expect(
        landedAtDoor || refused,
        `${path} is supposed to be closed to a signed-out visitor (${entry.audienceDecisions['signed-out'].reason}, ` +
          `requires ${entry.requiredTier ?? entry.gate}) and instead answered ${status} at ${url}. ` +
          'If that is now intended, the change belongs in src/lib/entitlement.ts, not here.'
      ).toBe(true);
    });
  }
});
