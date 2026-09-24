import { expect, test } from 'playwright/test';
import { browsableRoutes, pageRoutes, type Role } from './manifest';

/**
 * The same sweep, signed in, once per role.
 *
 * NOTHING IN THIS REPOSITORY HAS EVER DONE THIS. 1,248 unit tests and not one of
 * them has held a session. 43 routes sit behind a tier gate, and the most-edited
 * file in the repo — src/pages/desk.astro, 21 commits in its first ten days — has
 * never been loaded by anything but a person clicking.
 *
 * The role comes from the Playwright project name, and each project supplies the
 * matching storageState (playwright.config.ts). So this one file is run four times
 * and asserts four different things, from one generated manifest.
 *
 * BOTH DIRECTIONS, and the second is the one that matters. A route a member may see
 * has to load; a route a member may NOT see has to refuse. The second is where a
 * silent regression is expensive: delete a gate by accident and nothing throws,
 * nothing looks wrong, and paid work is simply given away. `paid` routes denied to
 * `member` are the sharp edge — 15 of them.
 *
 * THE FIRST ASSERTION IS THAT THE SESSION IS REAL. If a storageState file is empty
 * or expired, every 'allowed' route redirects to the door and every 'denied' route
 * also redirects to the door, so the denial half passes for the wrong reason and
 * the suite agrees with itself about a lie. That is not hypothetical: the first
 * version of auth.setup.ts wrote 36 bytes of empty state and passed. So each role
 * proves it is signed in before asserting anything else.
 */

const ROLE = (): Role => {
  const name = test.info().project.name;
  if (name === 'member' || name === 'paid' || name === 'internal' || name === 'waitlisted') return name;
  throw new Error(
    `routes.signedin.spec.ts ran under project "${name}", which carries no storageState. ` +
      'It must only run under the member, paid, internal or waitlisted projects — check testMatch in playwright.config.ts.'
  );
};

const DOORS = /\/(sign-in|sign-up|login|waitlist|start|upgrade|verify-email)\b/;

/** Routes that ARE a door. Asserting "this did not land on a door" is meaningless
 *  for them: a signed-in reader visiting /waitlist either sees it or is sent
 *  somewhere else, and both are correct. The first run of this spec failed all
 *  five for exactly that reason — the test was wrong, not the app. */
const IS_A_DOOR = (path: string) => DOORS.test(path);

/** Routes whose job is to answer an error status; /404 answering 404 is the route
 *  working. Kept in step with routes.public.spec.ts. */
const EXPECTED_STATUS: Record<string, number> = { '/404': 404 };

test.describe('the session is real before anything is asserted about it', () => {
  test('this role is actually signed in', async ({ page }) => {
    const role = ROLE();
    // /account is the cheapest page that exists only for a signed-in reader and is
    // reachable by every tier from waitlisted upward.
    const target = role === 'waitlisted' ? '/waitlist' : '/account';
    const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `${target} as ${role}`).toBeLessThan(400);
    expect(
      DOORS.test(page.url()) && role !== 'waitlisted',
      `As ${role}, ${target} redirected to ${page.url()} — the session in .sweep/auth/${role}.json is not ` +
        'being accepted. Every other assertion in this file would pass or fail for the wrong reason. ' +
        'Re-run `npx playwright test --project=setup` and check the cookie is not empty or expired.'
    ).toBe(false);
  });
});

test.describe('every page this role may see, loads clean', () => {
  for (const { entry, path } of pageRoutes('member').concat()) {
    // The loop is built from the manifest for ALL roles and filtered at run time,
    // because the project name is only knowable inside a test body.
    test(`${path}`, async ({ page }) => {
      const role = ROLE();
      const decision = entry.audienceDecisions[role];
      test.skip(!decision?.allow, `${path} is not open to ${role} (${decision?.reason})`);

      const complaints: string[] = [];
      page.on('pageerror', (error) => complaints.push(`uncaught: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') complaints.push(`console.error: ${message.text()}`);
      });

      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const expected = EXPECTED_STATUS[path];
      if (expected !== undefined) {
        expect(response?.status(), `${path} as ${role} is meant to answer ${expected}`).toBe(expected);
      } else {
        expect(response?.status(), `${path} as ${role} answered ${response?.status()}`).toBeLessThan(400);
      }
      if (!IS_A_DOOR(path)) {
        expect(
          DOORS.test(page.url()),
          `${path} as ${role} redirected to the sign-in door at ${page.url()}, but the route census says ` +
            `this role may see it (${decision.reason}). Either the gate is wrong or entitlement.ts and ` +
            'middleware.ts disagree with each other.'
        ).toBe(false);
      }
      await expect(
        page.locator('main, [role="main"]').first(),
        `${path} as ${role} rendered no visible main landmark`
      ).toBeVisible();
      const narration =
        expected !== undefined && expected >= 400
          ? new RegExp(`Failed to load resource.*status of ${expected}\\b`)
          : null;
      const real = narration ? complaints.filter((line) => !narration.test(line)) : complaints;
      expect(real, `${path} as ${role} made the browser complain:\n  ${real.join('\n  ')}`).toEqual([]);
    });
  }
});

test.describe('and every route this role may NOT see, refuses', () => {
  for (const { entry, path } of browsableRoutes('member').concat()) {
    test(`${path} refuses`, async ({ page }) => {
      const role = ROLE();
      const decision = entry.audienceDecisions[role];
      test.skip(decision?.allow !== false, `${path} is open to ${role}`);

      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 0;
      const refused = status === 401 || status === 403 || status === 404;

      expect(
        refused || DOORS.test(page.url()),
        `${path} requires ${entry.requiredTier ?? entry.gate} and ${role} is not that ` +
          `(${decision.reason}), but it answered ${status} at ${page.url()}. This is the shape of a ` +
          'gate removed by accident: nothing throws, nothing looks wrong, and the content is simply given away.'
      ).toBe(true);
    });
  }
});
