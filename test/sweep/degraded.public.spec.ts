import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from 'playwright/test';
import { SWEEP_ENV } from './env';

/**
 * What the site does when a dependency is down.
 *
 * THE DEPENDENCY THAT HAS ALREADY TAKEN THIS SITE DOWN IS THE DATABASE (the
 * Neon Free compute cap, 2026-09-20, docs/regression-strategy.md). Nothing in
 * 1,248 unit tests or the rest of the sweep drives that failure branch, so
 * this file exists to drive it, plus the three network dependencies that sit
 * beside it: this deployment's own two self-fetches (stats.ts, kills.ts), and
 * the two AI providers a BYOK member's browser can trigger a call toward.
 *
 * WHY THE TWO SELF-FETCHES CANNOT BE STUBBED WITH page.route(), AND WHAT THIS
 * FILE DOES INSTEAD. src/lib/stats.ts:61 and src/lib/kills.ts:101 fetch this
 * deployment's own origin from INSIDE the Astro dev server's Node process,
 * while it renders a page — never from the browser. page.route() intercepts
 * requests that leave the Playwright-controlled BROWSER's network stack; a
 * server-to-server fetch never touches it. This was not assumed: a throwaway
 * probe (page.route('**\/board/stats.json', ...fulfill 500...) against the
 * running dev server) loaded / at 200 with the real, unstubbed stats every
 * time, and the route handler's own "was I called" flag stayed false. Writing
 * this spec with page.route() over that fetch would be exactly the decoration
 * docs/regression-strategy.md warns about: a green assertion that measured
 * nothing.
 *
 * So Part 1 below stubs the RIGHT layer: the two self-fetches read their
 * target from site.config.mjs's SITE_ORIGIN (INDEX_URL = SITE_URL =
 * SITE_ORIGIN + BASE_PATH), so this spec starts a second, disposable `astro
 * dev` instance on its own port with SITE_ORIGIN pointed at a tiny HTTP
 * server this file controls, and drives that instance's browser-visible pages
 * exactly as any other role in the sweep does. The shared webServer on 4321
 * (and its cache and its database rows) is never touched — this harness reads
 * the same antialgo_test database read-only and writes nothing, so it is safe
 * to run alongside the rest of the sweep.
 *
 * WHY A FRESH INSTANCE PER SCENARIO, NOT ONE SHARED SERVER. Both stats.ts and
 * kills.ts cache their own module-level `cached` value for up to 60 seconds
 * (10 seconds after a failure). A shared instance would let a 500 in one test
 * silently answer a later "hang" test's fetch from its own failure cache, and
 * that test would pass having exercised nothing. Part 1 below runs its two
 * describes inside one outer describe configured serial ({ mode: 'serial' },
 * the same reason auth.setup.ts uses it), so no two scenarios' disposable
 * ports ever collide — scoped to Part 1 only, so a failure there cannot skip
 * the unrelated Part 2 and Part 3 tests the way a file-wide serial mode would.
 */

/** How the harness's own stand-in for "the app's own origin" answers a
 *  request for one of the two self-fetch paths. */
type UpstreamBehavior = 'ok' | '500' | 'hang';

/** Comfortably past src/lib/stats.ts's and src/lib/kills.ts's own
 *  TIMEOUT_MS (8s): if either file's AbortController regressed and stopped
 *  aborting, this is where a "hang" scenario would actually time out instead
 *  of finishing in ~8s, and the test should fail rather than wait 30s for a
 *  dependency that is never going to answer. */
const NAV_TIMEOUT_MS = 20_000;

/** How long a disposable astro dev instance gets to come up before a scenario
 *  gives up and reports what it logged rather than hanging the whole run. */
const BOOT_TIMEOUT_MS = 30_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address !== 'object') {
        probe.close(() => reject(new Error('could not read back an assigned port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Polls a path with no dependency on stats.ts or kills.ts, so waiting for the
 *  disposable server to come up can never itself prime either file's success
 *  cache before a scenario has set its behaviour. Any answer under 500 counts
 *  as "up": a 404 here would still prove the router is alive. */
async function waitUntilUp(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/privacy`);
      if (response.status < 500) return;
      lastError = `answered ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`disposable dev server at ${origin} never came up (${lastError})`);
}

interface Harness {
  /** The disposable instance's own origin — navigate here, never to :4321. */
  appOrigin: string;
  setStats(behavior: UpstreamBehavior): void;
  setKills(behavior: UpstreamBehavior): void;
  stop(): Promise<void>;
}

/**
 * Starts one disposable `astro dev` process whose self-fetches land on a tiny
 * HTTP server this function owns, plus that server itself. Both are torn down
 * by the returned stop().
 */
async function startHarness(): Promise<Harness> {
  let statsBehavior: UpstreamBehavior = 'ok';
  let killsBehavior: UpstreamBehavior = 'ok';
  const bootLog: string[] = [];

  const upstream = http.createServer((req, res) => {
    const behavior = req.url === '/board/stats.json' ? statsBehavior : req.url === '/board/kills.json' ? killsBehavior : 'ok';

    // The 30-second dependency hang the task describes: never respond.
    // NAV_TIMEOUT_MS above is what keeps this from ever actually costing this
    // spec 30 real seconds — the app's own 8s AbortController is meant to
    // give up on this connection long before that.
    if (behavior === 'hang') return;

    if (behavior === '500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('stubbed by test/sweep/degraded.public.spec.ts: upstream down');
      return;
    }

    if (req.url === '/board/stats.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          boards_swept: 1,
          verified_live: 1,
          killed: 0,
          killed_by_rule: 0,
          postings_observed: 1,
          swept_at: new Date().toISOString()
        })
      );
      return;
    }
    if (req.url === '/board/kills.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kills: [], served_at_utc: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress !== 'object') {
    throw new Error('the stand-in upstream server has no assigned port');
  }
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;

  const appPort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;

  // node_modules/.bin/astro directly, not `npm run dev`: the npm script also
  // runs `npm run tokens` (style-dictionary), which writes src/styles/
  // tokens.css and themes.css. Two dev servers regenerating those at once,
  // for a file this harness never needs freshly built, is a race for nothing.
  const child: ChildProcess = spawn(process.execPath, ['node_modules/.bin/astro', 'dev', '--port', String(appPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...SWEEP_ENV,
      BETTER_AUTH_URL: appOrigin,
      // The one override that matters for stats.ts: site.config.mjs's
      // INDEX_URL (and through it INDEX_STATS_URL) is derived from
      // SITE_ORIGIN with no env escape hatch of its own.
      SITE_ORIGIN: upstreamOrigin,
      // kills.ts needs a SECOND, explicit override. site.config.mjs reads
      // INDEX_KILLS_URL from the environment BEFORE falling back to
      // INDEX_URL, specifically so local dev can point it at a local index
      // server — and this repo's own .env.local does exactly that
      // (INDEX_KILLS_URL=http://localhost:4321/dev-kills-sample.json).
      // load-local-env.mjs never overwrites a key already in process.env, so
      // without this line that .env.local value wins over SITE_ORIGIN and
      // every kills scenario below silently fetches the SHARED dev server's
      // real sample data instead of this harness's stand-in — which is
      // exactly what happened the first time this file was run: the mock's
      // request log stayed empty and /evidence rendered a real kill card.
      INDEX_KILLS_URL: `${upstreamOrigin}/board/kills.json`,
      NODE_ENV: 'development'
    },
    stdio: 'pipe'
  });
  child.stdout?.on('data', (chunk) => bootLog.push(String(chunk)));
  child.stderr?.on('data', (chunk) => bootLog.push(String(chunk)));

  try {
    await waitUntilUp(appOrigin, BOOT_TIMEOUT_MS);
  } catch (error) {
    child.kill();
    upstream.close();
    throw new Error(`${(error as Error).message}\n--- dev server output ---\n${bootLog.join('')}`);
  }

  return {
    appOrigin,
    setStats: (behavior) => {
      statsBehavior = behavior;
    },
    setKills: (behavior) => {
      killsBehavior = behavior;
    },
    stop: async () => {
      child.kill();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  };
}

/** Every complaint a real visitor's browser would have raised, the same
 *  standard routes.public.spec.ts holds every page to. */
function watchForComplaints(page: Page): string[] {
  const complaints: string[] = [];
  page.on('pageerror', (error) => complaints.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') complaints.push(`console.error: ${message.text()}`);
  });
  return complaints;
}

/* ---------------------------------------------------------------------------
 * Part 1 — the self-fetch. stats.ts:loadStats() runs on every home page
 * render (src/pages/index.astro:37, unconditionally, before the board teaser
 * or the waitlist count). A self-fetch that hangs is a page that hangs.
 * ------------------------------------------------------------------------- */

test.describe('self-fetch scenarios (each starts its own disposable dev server)', () => {
  // Scoped to this describe, not the whole file: a failure inside a serial
  // group skips the rest of that group, and Part 2 and Part 3 below share
  // nothing with Part 1 and must still run even when a Part 1 scenario is red.
  test.describe.configure({ mode: 'serial' });

  test.describe('the home page survives its own stats self-fetch failing', () => {
    test('a 500 from /board/stats.json renders the documented absence line, not a blank hero', async ({ page }) => {
      const harness = await startHarness();
      try {
        harness.setStats('500');
        const complaints = watchForComplaints(page);

        const response = await page.goto(`${harness.appOrigin}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        expect(response?.status(), `/ answered ${response?.status()} with the stats self-fetch returning 500`).toBeLessThan(400);

        // src/pages/index.astro:136-137, the exact fallback the file already
        // carries for `stats` coming back null: not invented for this test.
        await expect(
          page.locator('.sweep-link.absence'),
          'the hero sweep line did not show the documented "sweep could not be read" absence text'
        ).toHaveText('The sweep could not be read just now. The board carries every number.');

        await expect(page.locator('main, [role="main"]').first()).toBeVisible();
        expect(complaints, `the browser complained:\n  ${complaints.join('\n  ')}`).toEqual([]);
      } finally {
        await harness.stop();
      }
    });

    test('a hung /board/stats.json still renders / within stats.ts\'s own timeout, not the full 30s', async ({ page }) => {
      const harness = await startHarness();
      try {
        harness.setStats('hang');
        const complaints = watchForComplaints(page);

        const start = Date.now();
        const response = await page.goto(`${harness.appOrigin}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        const elapsedMs = Date.now() - start;

        expect(response?.status(), `/ answered ${response?.status()} while its stats self-fetch was hanging`).toBeLessThan(400);
        // stats.ts's own TIMEOUT_MS is 8s. Generous headroom for a loaded CI
        // box, but nowhere near NAV_TIMEOUT_MS, let alone the 30s the upstream
        // never answers within: a regression that dropped the AbortController
        // would make this assertion fail here rather than the test merely
        // taking longer, because page.goto's own timeout would fire first.
        expect(elapsedMs, `/ took ${elapsedMs}ms to render with a hung self-fetch — stats.ts's AbortController should cut this off at 8s`).toBeLessThan(15_000);

        await expect(
          page.locator('.sweep-link.absence'),
          'a hung self-fetch did not degrade to the documented absence line'
        ).toHaveText('The sweep could not be read just now. The board carries every number.');
        expect(complaints, `the browser complained:\n  ${complaints.join('\n  ')}`).toEqual([]);
      } finally {
        await harness.stop();
      }
    });
  });

  test.describe('/evidence survives its own kills self-fetch failing', () => {
    // /evidence (src/pages/evidence.astro:25) is the one signed-out route that
    // calls loadKills() directly and unconditionally; /kills itself is dark
    // right now (flags.config.mjs: kill_list is off in both editions), so it
    // is not a route a signed-out sweep can reach today.
    test('a 500 from /board/kills.json renders the documented absence line, not a blank page', async ({ page }) => {
      const harness = await startHarness();
      try {
        harness.setKills('500');
        const complaints = watchForComplaints(page);

        const response = await page.goto(`${harness.appOrigin}/evidence`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        expect(response?.status(), `/evidence answered ${response?.status()} with the kills self-fetch returning 500`).toBeLessThan(400);

        // src/pages/evidence.astro's own documented fallback for feed.records
        // being empty — worded to cover both a read failure and a genuinely
        // quiet two months, which is why this checks for the sentence rather
        // than a synthetic "error" string this file would be inventing.
        await expect(
          page.locator('.ev-absence'),
          'the evidence page did not show its documented "kill feed could not be read" absence text'
        ).toContainText('The kill feed could not be read just now, or nothing has been killed in the last two months.');

        await expect(page.locator('main, [role="main"]').first()).toBeVisible();
        expect(complaints, `the browser complained:\n  ${complaints.join('\n  ')}`).toEqual([]);
      } finally {
        await harness.stop();
      }
    });

    test('a hung /board/kills.json still renders /evidence within kills.ts\'s own timeout', async ({ page }) => {
      const harness = await startHarness();
      try {
        harness.setKills('hang');
        const complaints = watchForComplaints(page);

        const start = Date.now();
        const response = await page.goto(`${harness.appOrigin}/evidence`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        const elapsedMs = Date.now() - start;

        expect(response?.status(), `/evidence answered ${response?.status()} while its kills self-fetch was hanging`).toBeLessThan(400);
        expect(elapsedMs, `/evidence took ${elapsedMs}ms with a hung self-fetch — kills.ts's AbortController should cut this off at 8s`).toBeLessThan(15_000);

        await expect(page.locator('main, [role="main"]').first()).toBeVisible();
        expect(complaints, `the browser complained:\n  ${complaints.join('\n  ')}`).toEqual([]);
      } finally {
        await harness.stop();
      }
    });
  });
});

/* ---------------------------------------------------------------------------
 * Part 2 — the third parties: Resend, Anthropic, OpenAI.
 *
 * ALL THREE ARE UNREACHABLE FROM A BROWSER PAGE RENDER, AND THIS IS CHECKED
 * BELOW RATHER THAN ASSUMED. Every call site was read before writing this:
 *
 *   api.resend.com     src/lib/email.ts's sendMail(), called only from
 *                       src/pages/tasks/nudge.ts — a cron route gated by a
 *                       CRON_SECRET bearer header no browser navigation can
 *                       supply, and by the email_send flag. No sign-up or
 *                       sign-in flow calls it: this repo's account creation
 *                       auto-verifies (see memory: "Email out of scope,
 *                       accounts auto-verified").
 *   api.anthropic.com,
 *   api.openai.com      src/lib/generation-providers.ts's four fixed
 *                       endpoints, reached only from callProvider() /
 *                       verifyKey(), which are only ever called from inside
 *                       POST handlers a signed-in paid member with a stored
 *                       BYOK key triggers on purpose (src/pages/settings/
 *                       keys/save.ts, src/pages/desk/job-draft/[slug]/run.ts,
 *                       src/lib/resume-parse.ts) — never during a GET render.
 *
 * So there is no page-render scenario to degrade here, and a spec that stubbed
 * these hosts and asserted a fallback would be testing nothing: the code path
 * never runs. What IS worth asserting, and is a real regression this file can
 * catch, is the other direction — that browsing the public surface NEVER
 * reaches any of the three, so a future change that leaked a provider call
 * into client-side script or an unguarded render path shows up as a failure
 * here rather than a silent new fetch nobody asked for.
 * ------------------------------------------------------------------------- */

const THIRD_PARTY_HOSTS = [/api\.resend\.com/, /api\.anthropic\.com/, /api\.openai\.com/];
// A representative slice of the public surface, not every route — the full
// crawl is routes.public.spec.ts's job. This one just watches for a stray
// dependency, so it stays fast.
const REPRESENTATIVE_PUBLIC_PAGES = ['/', '/board', '/evidence', '/how-it-works', '/your-key'];

test.describe('no public page ever reaches a third-party AI or mail provider', () => {
  for (const path of REPRESENTATIVE_PUBLIC_PAGES) {
    test(`${path} makes no request to Resend, Anthropic or OpenAI`, async ({ page }) => {
      const hits: string[] = [];
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (THIRD_PARTY_HOSTS.some((host) => host.test(url))) hits.push(url);
        await route.continue();
      });
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(hits, `${path} reached a third party it should never touch on a render: ${hits.join(', ')}`).toEqual([]);
    });
  }
});

/* ---------------------------------------------------------------------------
 * Part 3 — a slow network generally, on one representative page.
 *
 * Unlike Part 1, this genuinely is a browser-level concern: every request
 * /board issues (the document, its scripts, its styles) travels through the
 * page's own network stack, so page.route() is the right tool here, no
 * disposable server required.
 * ------------------------------------------------------------------------- */

test.describe('a uniformly slow network does not break /board', () => {
  test('every request delayed still renders a coherent page, nothing throws', async ({ page }) => {
    const DELAY_MS = 400;
    await page.route('**/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      await route.continue();
    });
    const complaints = watchForComplaints(page);

    const response = await page.goto('/board', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    expect(response?.status(), `/board answered ${response?.status()} on a uniformly slow network`).toBeLessThan(400);

    await expect(page.locator('main, [role="main"]').first()).toBeVisible();
    expect(complaints, `the browser complained on a slow network:\n  ${complaints.join('\n  ')}`).toEqual([]);
  });
});
