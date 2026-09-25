import { readFileSync } from 'node:fs';
/**
 * The environment the sweep runs in, defined once and read by everything that
 * needs it.
 *
 * WHY THIS FILE IS .mjs AND env.ts IS A TYPED VIEW ONTO IT. Same split, and the
 * same reason, as flags.config.mjs / flags.ts: the values have to be readable by
 * plain Node as well as by TypeScript. scripts/capture-screens.mjs starts a dev
 * server on this database and then drives a minted session against it, and it is
 * a .mjs script with no TypeScript runner behind it. Copying the two secrets into
 * a third place to get them there would defeat the entire point of this file (see
 * the next paragraph) — a capture that signed with a different key would render
 * signed-OUT and nothing would fail.
 *
 * WHY THIS FILE EXISTS AT ALL, AND IT IS A GOOD STORY. The first working version
 * of the signed-in sweep failed every 'allowed' assertion and PASSED every
 * 'denied' one. The session cookie was minted correctly — right name, right
 * domain, right expiry, and a matching row in the session table — and the dev
 * server rejected it anyway, because the two processes were signing with
 * different secrets:
 *
 *   auth.setup.ts  set BETTER_AUTH_SECRET with ??= before importing src/lib/auth,
 *                  so its placeholder won, and load-local-env.mjs (which never
 *                  overwrites an existing value) left it alone.
 *   the dev server got the real secret out of .env.local.
 *
 * A signature mismatch reads exactly like "not signed in". And note what that did
 * to the suite: every denial test passed, because a rejected session is denied
 * everything. The sweep would have reported 29 passes and called the gates proven.
 * Only the explicit "this role is actually signed in" assertion caught it.
 *
 * So the secrets are pinned here, the same values are handed to the dev server
 * (playwright.config.ts's webServer.env, and capture-screens.mjs's own) and to the
 * minting process, and neither depends on .env.local. The sweep's database is
 * disposable and its sessions live for one run, so a fixed literal is the right
 * shape — it is not a secret in any meaningful sense, and writing it down is what
 * makes every side provably equal.
 *
 * NOT USABLE AGAINST ANYTHING REAL. These values only sign sessions in
 * antialgo_test. scripts/test-db.mjs refuses to touch any other database,
 * auth.setup.ts refuses to run against any other host, and capture-screens.mjs
 * refuses to take a signed-in capture from anywhere but localhost.
 */

/** Signs the sweep's session cookies. Both the minting process and the dev server
 *  must use this exact value or every signed-in assertion is meaningless. */
export const SWEEP_AUTH_SECRET = 'sweep-fixed-secret-antialgo-test-only-0e1f2a3b4c5d6e7f';

/** Encrypts stored provider keys (src/lib/keychain.ts). Needed for any page that
 *  reads whether the account has a BYOK key — /profile's upload band and
 *  /settings both branch on it, and so does JobDetailV2's action rail. */
export const SWEEP_KEY_ENCRYPTION_SECRET = 'sweep-fixed-keyenc-antialgo-test-only-a1b2c3d4e5f60718';

/** The instant src/data/stats.json says it was captured, read from the file so it can
 *  never drift out of step with the data on disk.
 *
 *  WHY THE SWEEP PINS THE DATA CLOCK. src/lib/data-contract.ts refuses to serve when
 *  stats.json is more than 48 hours old — at REQUEST time, not only at build time — so
 *  when the mini's nightly push fell 55 hours behind on 2026-09-24, every page on the
 *  dev server answered 500 and Playwright's webServer sat waiting for a URL that was
 *  never going to be ready. The whole browser gate timed out for a reason that had
 *  nothing to do with the browser, the app, or any code.
 *
 *  That guard is right and it stays: publishing "verified last night" over a stale push
 *  is the dishonesty this repository exists to refuse. But the sweep is asking "does
 *  this page work", not "did the mini run last night", and data-contract.ts's own now()
 *  is "overridable, so the should-fail fixture and any test can pin it".
 *
 *  `npm run build` still fails loudly on stale data, which is the step that would
 *  actually publish it. A stalled sweep stops the deploy — not the test suite. */
const SWEPT_AT = JSON.parse(
  readFileSync(new URL('../../src/data/stats.json', import.meta.url), 'utf8')
).swept_at_utc;

/** The one database the sweep is allowed to speak to. */
export const SWEEP_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/antialgo_test';

/** Where the dev server the sweep drives will be. */
export const SWEEP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:4321';

/** Everything the app needs in its environment to serve the sweep, as one object
 *  playwright.config.ts, auth.setup.ts and capture-screens.mjs all spread.
 *
 *  `origin` exists for the one caller that serves on a port of its own:
 *  capture-screens.mjs starts a dev server beside whatever the owner already has
 *  open on 4321, and BETTER_AUTH_URL / SITE_ORIGIN have to name the port the
 *  browser will actually ask for. Everyone else takes the default. */
export function sweepEnv(origin = SWEEP_ORIGIN) {
  return {
    DATA_CONTRACT_NOW: SWEPT_AT,
    DATABASE_URL: SWEEP_DATABASE_URL,
    DATABASE_URL_UNPOOLED: SWEEP_DATABASE_URL,
    BETTER_AUTH_SECRET: SWEEP_AUTH_SECRET,
    BETTER_AUTH_URL: origin,
    SITE_ORIGIN: origin,
    KEY_ENCRYPTION_SECRET: SWEEP_KEY_ENCRYPTION_SECRET
  };
}

/** The sweep's own environment, on the sweep's own origin. */
export const SWEEP_ENV = sweepEnv();
