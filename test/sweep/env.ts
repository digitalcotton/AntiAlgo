/**
 * The environment the sweep runs in, defined once and read by both halves.
 *
 * WHY THIS FILE EXISTS, AND IT IS A GOOD STORY. The first working version of the
 * signed-in sweep failed every 'allowed' assertion and PASSED every 'denied' one.
 * The session cookie was minted correctly — right name, right domain, right
 * expiry, and a matching row in the session table — and the dev server rejected it
 * anyway, because the two processes were signing with different secrets:
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
 * (playwright.config.ts's webServer.env) and to the minting process, and neither
 * depends on .env.local. The sweep's database is disposable and its sessions live
 * for one run, so a fixed literal is the right shape — it is not a secret in any
 * meaningful sense, and writing it down is what makes the two sides provably equal.
 *
 * NOT USABLE AGAINST ANYTHING REAL. These values only sign sessions in
 * antialgo_test. scripts/test-db.mjs refuses to touch any other database and
 * auth.setup.ts refuses to run against any other host.
 */

/** Signs the sweep's session cookies. Both the minting process and the dev server
 *  must use this exact value or every signed-in assertion is meaningless. */
export const SWEEP_AUTH_SECRET = 'sweep-fixed-secret-antialgo-test-only-0e1f2a3b4c5d6e7f';

/** Encrypts stored provider keys (src/lib/keychain.ts). Needed for any page that
 *  reads whether the account has a BYOK key — /profile's upload band and
 *  /settings both branch on it. */
export const SWEEP_KEY_ENCRYPTION_SECRET = 'sweep-fixed-keyenc-antialgo-test-only-a1b2c3d4e5f60718';

/** The one database the sweep is allowed to speak to. */
export const SWEEP_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/antialgo_test';

/** Where the dev server the sweep drives will be. */
export const SWEEP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:4321';

/** Everything the app needs in its environment to serve the sweep, as one object
 *  both playwright.config.ts and auth.setup.ts spread. */
export const SWEEP_ENV: Record<string, string> = {
  DATABASE_URL: SWEEP_DATABASE_URL,
  DATABASE_URL_UNPOOLED: SWEEP_DATABASE_URL,
  BETTER_AUTH_SECRET: SWEEP_AUTH_SECRET,
  BETTER_AUTH_URL: SWEEP_ORIGIN,
  SITE_ORIGIN: SWEEP_ORIGIN,
  KEY_ENCRYPTION_SECRET: SWEEP_KEY_ENCRYPTION_SECRET
};
