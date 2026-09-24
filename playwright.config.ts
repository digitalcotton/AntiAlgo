import { defineConfig, devices } from 'playwright/test';
import { SWEEP_ENV, SWEEP_ORIGIN } from './test/sweep/env';

/**
 * The browser half of `npm run conform`.
 *
 * WHY 'playwright/test' AND NOT '@playwright/test'. The runner is already here.
 * playwright@1.62.1 bundles it — node_modules/playwright/test.js re-exports the
 * whole thing, `npx playwright test` works, and Chromium and WebKit are already
 * downloaded in ~/Library/Caches/ms-playwright. Installing @playwright/test would
 * add a second copy of the same code, and a version skew between the two is a
 * documented way to get baselines that disagree with the browser that made them.
 * Zero new dependencies was a hard constraint and it is met.
 *
 * WHY astro dev AND NOT astro preview. `astro preview` does not work with
 * @astrojs/vercel — the adapter has no preview server. 74 of this app's 91
 * routes are `prerender = false` (measured by scripts/route-census.mjs), so a sweep that reads a built directory of
 * .html files would cover about a tenth of the app and would never once load the
 * board, the desk, drafting, profile, billing or /internal. That structural
 * blindness is what killed the Index's gate 5. So the sweep drives a real server.
 *
 * WHY THE DEV SERVER POINTS AT antialgo_test. The fixtures have to be the same on
 * every run or the assertions are about last night's crawl. site.config.mjs
 * imports load-local-env.mjs, which deliberately never overwrites a value
 * already in process.env, so the DATABASE_URL set here wins over .env.local.
 * scripts/test-db.mjs owns that database and refuses to touch any other.
 *
 * WHAT RUNS WHERE. Locally this is the whole gate. Against a Vercel preview
 * (E2E_BASE_URL set) the same specs run, with the protection bypass header
 * attached — but note that preview deployments are missing BETTER_AUTH_SECRET,
 * BETTER_AUTH_URL, SITE_ORIGIN and KEY_ENCRYPTION_SECRET today, so nothing
 * signed-in can pass there until those are added to the Preview environment. The
 * signed-in projects are skipped rather than failed in that case, and they say so.
 */

/** Where the sweep points. Unset means the local dev server this config starts. */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4321';

/** True when we are sweeping a deployment rather than a local dev server. */
const REMOTE = Boolean(process.env.E2E_BASE_URL);

/** Vercel's Deployment Protection bypass. Only meaningful against a deployment;
 *  src/lib/draft-run-dispatch.ts already reads the same variable for its own
 *  self-call, so this is the project's established name for it. */
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

/** The database the local dev server reads. Fixed, disposable, and never the
 *  dev or production one. */
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/antialgo_test';

export default defineConfig({
  testDir: './test/sweep',
  // Baselines and generated manifests live beside the specs; anything a run
  // produces goes to .sweep/ or test-results/, both git-ignored.
  outputDir: './test-results',

  // A gate that a person is waiting on. Fail the run rather than hanging.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalTimeout: 15 * 60_000,

  // One retry, and a trace kept only for the retry. Retries are here to tell a
  // flake from a failure, not to grind a red run green: a test that passes only
  // on retry still shows as flaky in the report, which is the signal worth having.
  retries: 1,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,

  // A .only left in a spec would silently shrink the sweep to one test and
  // report a pass. Refuse it outright where it matters most.
  forbidOnly: Boolean(process.env.CI),

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Same-origin only: the app's CSP is `connect-src 'self'` and nothing here
    // should be reaching a third party.
    ...(REMOTE && BYPASS ? { extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } } : {})
  },

  // Pixels are compared only on the two authored galleries (see the gallery
  // spec). These thresholds are deliberately not zero: sub-pixel text
  // rasterisation differs between runs on the same machine, and a gate that
  // fails on that teaches you to stop reading it.
  snapshotPathTemplate: '{testDir}/{testFileDir}/__screenshots__/{arg}-{projectName}{ext}',

  projects: [
    {
      // Mints one session per role and writes a storageState file for each.
      // Everything signed-in depends on this, so a failure here fails the run
      // rather than quietly producing signed-out screenshots of gated pages —
      // which is the single most likely way this harness could lie.
      name: 'setup',
      testMatch: /auth\.setup\.ts/
    },
    {
      name: 'signed-out',
      use: { ...devices['Desktop Chrome'] },
      // Explicit, not /\.spec\.ts$/ — that would also match *.signedin.spec.ts,
      // and this project has no storageState, so those specs would have run
      // signed-OUT while their names claimed otherwise. Every route they assert
      // as reachable would have been a redirect to sign-in, and the failures
      // would have looked like gate bugs.
      testMatch: [/gallery\.spec\.ts$/, /\.public\.spec\.ts$/]
    },
    {
      name: 'waitlisted',
      use: { ...devices['Desktop Chrome'], storageState: '.sweep/auth/waitlisted.json' },
      dependencies: ['setup'],
      testMatch: /\.signedin\.spec\.ts$/
    },
    {
      name: 'member',
      use: { ...devices['Desktop Chrome'], storageState: '.sweep/auth/member.json' },
      dependencies: ['setup'],
      testMatch: /\.signedin\.spec\.ts$/
    },
    {
      name: 'paid',
      use: { ...devices['Desktop Chrome'], storageState: '.sweep/auth/paid.json' },
      dependencies: ['setup'],
      testMatch: /\.signedin\.spec\.ts$/
    },
    {
      name: 'internal',
      use: { ...devices['Desktop Chrome'], storageState: '.sweep/auth/internal.json' },
      dependencies: ['setup'],
      testMatch: /\.signedin\.spec\.ts$/
    },
    {
      // The owner's dropdown bug was Safari AND Firefox, so both engines run the
      // interaction specs — and only those. Running the whole sweep twice more
      // would double the wait to re-prove what Chromium already proved.
      //
      // storageState because the Come-ready title dropdown sits behind /start's
      // rank gate: without a real member session these specs would assert against
      // a sign-in page and pass for the wrong reason.
      name: 'webkit-interactions',
      use: { ...devices['Desktop Safari'], storageState: '.sweep/auth/member.json' },
      dependencies: ['setup'],
      testMatch: /\.interaction\.spec\.ts$/
    },
    {
      // Firefox 1538 IS installed (this config's header said otherwise until
      // 2026-09-24; so did .claude/rules/dropdown-focus.md — both now corrected).
      //
      // AN HONEST LIMIT, measured rather than assumed: Playwright's Firefox
      // automation did NOT reproduce the focus-loss race even with the guard in
      // StepTitles.astro removed by hand — its synthetic input does not order
      // mousedown/focusout the way a real trackpad press does. So this project is
      // real coverage for the saved-filter and waitlist specs, and is NOT a
      // backstop for the dropdown one; that leans on WebKit. The dropdown in real
      // macOS Firefox still wants a human check, which is worth writing down
      // rather than implying a green run has covered it.
      name: 'firefox-interactions',
      use: { ...devices['Desktop Firefox'], storageState: '.sweep/auth/member.json' },
      dependencies: ['setup'],
      testMatch: /\.interaction\.spec\.ts$/
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
      testMatch: /\.responsive\.spec\.ts$/
    }
  ],

  // Not started when sweeping a deployment.
  ...(REMOTE
    ? {}
    : {
        webServer: {
          command: 'npm run dev',
          url: BASE_URL,
          // Reuse a server the owner already has open. In CI there is none, and
          // reusing one there would mean sweeping whatever it was serving.
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
          env: {
            // From test/sweep/env.ts, the SAME object auth.setup.ts uses. The two
            // must agree on BETTER_AUTH_SECRET or every minted session is rejected
            // as a bad signature, which reads as "not signed in" and makes every
            // denial assertion pass for the wrong reason.
            ...SWEEP_ENV,
            // The gated build's review routes are served under `astro dev`
            // unconditionally (astro.config.mjs), so /_states and /_specimen are
            // reachable here without SPECIMEN=1.
            NODE_ENV: 'development'
          }
        }
      })
});
