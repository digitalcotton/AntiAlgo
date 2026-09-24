/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { getViteConfig } from 'astro/config';

/** The instant src/data/stats.json says it was captured. Read from the file rather
 *  than typed here, so this can never drift out of step with the data on disk —
 *  test/gates.config.mjs's rule, which this repo learned by announcing six gates
 *  while seven ran: "a number worth trusting is derived, never typed." */
const sweptAt = (JSON.parse(readFileSync('src/data/stats.json', 'utf8')) as { swept_at_utc: string }).swept_at_utc;

/** Astro's own Vite config, so a .astro component could be tested the same way the index does. */
export default getViteConfig({
  test: {
    // emails/ was excluded from this list from the directory's own creation
    // until 2026-09-24 (regression-strategy.md Part Two calls this out by
    // name: "emails/ is excluded from vitest entirely"). In that window
    // emails/templates/confirm-nudge.test.mjs and
    // emails/templates/weekly-digest.test.mjs existed, were committed, and
    // never ran once, on any machine, including CI: `vitest run` reported
    // them as passing by never discovering them, which is the exact "green
    // because it measured nothing" failure the strategy doc names as the
    // worst mode a suite can be in.
    include: ['{src,test,emails}/**/*.test.{ts,mjs}'],

    /**
     * DATA FRESHNESS IS THE BUILD'S JOB, NOT THIS SUITE'S.
     *
     * src/lib/data-contract.ts refuses a build when src/data/stats.json is more
     * than 48 hours old, because publishing "verified last night" over a stale
     * push is the dishonesty this repository is built to refuse. That guard is
     * correct and it stays exactly as it is.
     *
     * But it is a wall-clock guard, and a unit test that renders a page does not
     * care how old the data is — it cares that the page renders. So as of
     * 2026-09-24, when the mini's nightly push was 55 hours behind,
     * test/prelist.render.test.ts started failing for a reason that had nothing
     * to do with any code: a test going red on the calendar teaches you to stop
     * reading the suite, which is how this project has already lost two
     * instruments.
     *
     * data-contract.ts anticipated this. Its now() is "wrapped in a function, and
     * overridable, so the should-fail fixture and any test can pin it", reading
     * DATA_CONTRACT_NOW from the environment. Pinned here to the sweep instant
     * that src/data/stats.json itself records, so "now" for a test is the moment
     * the data was captured — deterministic, and true of whatever data is on disk.
     *
     * WHAT THIS DOES NOT DO: hide a stalled sweep. `npm run build` still fails
     * loudly, which is where it matters, because that is the step that would
     * publish it. If the mini stops pushing, the deploy stops — not the suite.
     */
    env: { DATA_CONTRACT_NOW: sweptAt }
  }
});
