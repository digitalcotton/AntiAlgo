import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup, expect } from 'playwright/test';
import { SWEEP_DATABASE_URL, SWEEP_ENV } from './env';

/**
 * One signed-in session per role, minted server-side, written as a storageState
 * file the other projects load.
 *
 * WHY THIS EXISTS AT ALL. 43 of this app's routes are behind a tier gate, and no
 * test in this repository has ever created a real session — 1,248 unit tests and
 * not one of them has been signed in. The Desk is the most-edited page in the
 * repo (21 commits in the first ten days) and nothing has ever loaded it.
 *
 * WHY NOT FILL THE SIGN-IN FORM. Three reasons, in order of how much they cost.
 * The password hash is scrypt (src/lib/password.ts), so every sign-in burns real
 * CPU for nothing. The form is rate-limited (30 requests a minute, auth.ts), so a
 * parallel sweep signs itself out of its own gate. And a form-driven login tests
 * the login form, which is one route, on every single run — the coverage is a
 * by-product, not the goal, and paying for it forty times is how a sweep becomes
 * something you skip.
 *
 * WHAT MINTS THEM. better-auth 1.7.1's own testUtils plugin (verified present at
 * node_modules/better-auth/dist/plugins/test-utils/). createUser builds a user
 * without touching the database, saveUser writes it THROUGH the app's real
 * databaseHooks — which is the part that matters: those hooks insert the
 * app_user_profile row and set emailVerified, and an account without them is
 * refused every gated route as 'email-unverified' before its tier is even read.
 * A raw INSERT would have produced a 403 storm that looked like a code failure.
 *
 * WHY THE TIER IS SET AFTERWARDS. signupTier() decides what a new account is
 * created as, and with the waitlist flag on that is 'waitlisted' for everyone.
 * The sweep needs one account at each of member, paid and internal, so the row is
 * updated directly after creation — the same thing /internal/tier.ts does through
 * the UI.
 *
 * NEVER AGAINST A REAL DATABASE. The guard below refuses anything that is not a
 * localhost antialgo_test. This file creates accounts and rewrites tiers; pointed
 * at production it would be writing real rows into the live people table.
 */

/** The roles the sweep signs in as. 'public' and 'waitlisted' need no session:
 *  signed-out covers public, and waitlisted is what a fresh account already is,
 *  so it is minted here too — it is the state every real new person is in, and
 *  the one most likely to be broken without anyone noticing. */
const ROLES = [
  { name: 'waitlisted', tier: 'waitlisted' },
  { name: 'member', tier: 'member' },
  { name: 'paid', tier: 'paid' },
  { name: 'internal', tier: 'internal' },

  // TWO MORE PAID ACCOUNTS, AND THE REASON IS WALL CLOCK.
  //
  // The journey specs mutate rows: the upload journey seeds a provider key and
  // writes record entries, the draft journey claims and completes renders. Both
  // ran as the SAME `paid` account, so with 4 workers they raced each other and
  // the draft journey failed intermittently — it passed every time it ran alone.
  // The gate was pinned to --workers=1 to make it honest, which cost 52s -> 146s.
  //
  // A lock would have been the wrong fix. The specs are not contending for a
  // resource, they are contending for a FIXTURE, and fixtures are cheap: one more
  // account each and there is nothing to contend over. Parallelism comes back for
  // free and no spec has to know another exists.
  { name: 'paid-upload', tier: 'paid' },
  { name: 'paid-draft', tier: 'paid' },

  // A PAID ACCOUNT THAT ALSO HOLDS A PROVIDER KEY, and it is not a test
  // fixture — it is what scripts/capture-screens.mjs signs in as to take the
  // step 03 capture on /how-it-works.
  //
  // WHY IT IS A ROLE OF ITS OWN rather than a key bolted onto `paid`. The
  // action rail on JobDetailV2 only renders its real form — the reason field
  // and the orange "Draft resumé and cover letter" button — for
  // `signedIn && hasKey`, one rung narrower than paid alone, so a capture of
  // the tailoring step needs a key on file. But draft.signedin.spec.ts's own
  // header rests on the opposite fact: `paid` has NO key, which is what keeps
  // its whole journey on the deterministic writer with no provider call and no
  // socket. Seeding a key onto `paid` would quietly turn that spec into
  // something else. Two accounts, no argument.
  { name: 'capture', tier: 'paid', key: 'anthropic' }
] as const;

/** Shaped, never real, and the same fixture string resume-upload.signedin.spec.ts
 *  uses. validateKeyShape() (src/lib/keychain.ts) wants the 'sk-ant-' prefix,
 *  20-512 characters and no whitespace — nothing about whether Anthropic would
 *  ever issue it. It exists to decrypt cleanly under this account's own subkey so
 *  that hasKey reads true; nothing in this repository ever calls a provider with
 *  it (the capture takes a picture of the form, it does not submit it). */
const FAKE_ANTHROPIC_KEY = 'sk-ant-sweep-fixture-fake-not-a-real-key-000000';

/** Fixed addresses and ids, so two runs produce the same accounts and a stray row
 *  is recognisable as the sweep's rather than a person's. .test is reserved by
 *  RFC 2606 and can never be a real domain. */
const EMAIL = (role: string) => `sweep-${role}@antialgo.test`;

const TEST_DATABASE_URL = SWEEP_DATABASE_URL;

/** Playwright wants an expiry in SECONDS since the epoch; better-auth's TestCookie
 *  does not document its unit, and the two libraries disagreeing silently is how
 *  the first version of this file produced an empty state. So: decide by
 *  magnitude rather than by assumption, and refuse to write a past expiry at all.
 *  -1 means a session cookie, which is what we actually want — the sweep's
 *  sessions should not outlive the run. */
function expiresInSeconds(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return -1;
  // Anything past the year 5138 in seconds is really milliseconds.
  const seconds = raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
  const now = Math.floor(Date.now() / 1000);
  return seconds > now ? seconds : -1;
}

/** better-auth spells these capitalised; Playwright accepts either case but is
 *  typed on the capitalised set. Anything unrecognised becomes 'Lax', which is
 *  what auth.ts configures. */
function normaliseSameSite(raw: string | undefined): 'Lax' | 'Strict' | 'None' {
  const value = String(raw ?? '').toLowerCase();
  if (value === 'strict') return 'Strict';
  if (value === 'none') return 'None';
  return 'Lax';
}

setup.describe.configure({ mode: 'serial' });

setup('mint a session for every role', async ({ browser }) => {
  // THE REFUSAL, BEFORE ANYTHING IS IMPORTED. src/lib/db.ts reads
  // process.env.DATABASE_URL at first use, so this has to be set and checked
  // before the dynamic imports below pull it in.
  const url = new URL(TEST_DATABASE_URL);
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const named = url.pathname === '/antialgo_test';
  expect(
    localhost && named,
    `auth.setup refuses to run against ${url.hostname}${url.pathname}. It creates ` +
      'accounts and rewrites tiers, so it only ever speaks to a localhost database ' +
      'named antialgo_test. Run `node scripts/test-db.mjs reset` first.'
  ).toBe(true);

  // FORCED, not ??=. The whole point of test/sweep/env.ts is that this process and
  // the dev server sign with the same key; deferring to whatever .env.local holds
  // is precisely the bug that made every signed-in assertion meaningless. These
  // assignments must also happen BEFORE the dynamic imports below, because
  // src/lib/db.ts reads DATABASE_URL at first use and load-local-env.mjs (pulled in
  // by site.config.mjs) fills any key that is still empty.
  for (const [key, value] of Object.entries(SWEEP_ENV)) process.env[key] = value;

  // Dynamic, so the guard above runs first.
  const { betterAuth } = await import('better-auth');
  const { testUtils } = await import('better-auth/plugins');
  const { authOptions } = await import('../../src/lib/auth');
  const { db } = await import('../../src/lib/db');

  // A SEPARATE INSTANCE, as the plugin's own documentation requires: it exposes
  // privileged session-minting helpers and must never be on the production
  // config. Same options, so the same hooks run.
  const testAuth = betterAuth({ ...authOptions(), plugins: [testUtils()] });
  const ctx = await testAuth.$context;
  const helpers = ctx.test;
  expect(
    helpers,
    'better-auth exposed no ctx.test helpers. The testUtils plugin did not load, ' +
      'and without it this file cannot mint a session — it must not fall back to ' +
      'writing rows by hand, because the app\'s own hooks would not run.'
  ).toBeTruthy();

  mkdirSync('.sweep/auth', { recursive: true });

  for (const role of ROLES) {
    const email = EMAIL(role.name);

    // Idempotent: the same addresses every run, so clear any survivor first
    // rather than colliding on the unique index.
    const existing = await db().query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
    for (const row of existing.rows) await helpers.deleteUser(row.id);

    const user = await helpers.saveUser(
      helpers.createUser({ email, name: `Sweep ${role.name}` })
    );

    // The hooks ran, or every gated route will 403 for the wrong reason. Assert
    // it here, where the message can say what went wrong, rather than debugging
    // it as a mysterious 403 in forty specs.
    const profile = await db().query<{ tier: string }>(
      'SELECT tier FROM app_user_profile WHERE user_id = $1',
      [user.id]
    );
    expect(
      profile.rows.length,
      `saveUser did not run the app's user.create.after hook for ${email}: no ` +
        'app_user_profile row exists. Every gated route would answer 403 with ' +
        'reason email-unverified regardless of the code under test.'
    ).toBe(1);

    await db().query('UPDATE app_user_profile SET tier = $2 WHERE user_id = $1', [user.id, role.tier]);

    // putKey(), not an INSERT built by hand, for the reason
    // resume-upload.signedin.spec.ts already gives where it seeds one: the real
    // write path is the point. The key is sealed under this account's own HKDF
    // subkey using KEY_ENCRYPTION_SECRET, which is forced above out of
    // SWEEP_ENV — so the dev server, started with the same object, can read it
    // back. Sealed under a different secret it would throw KeychainTamperError
    // on the first read and the page would simply render as though there were
    // no key at all.
    if ('key' in role && role.key) {
      const { putKey } = await import('../../src/lib/keychain-store');
      await putKey(user.id, role.key, FAKE_ANTHROPIC_KEY, 'capture fixture key (fake, test-only)');
      const { keyMeta } = await import('../../src/lib/keychain-store');
      expect(
        (await keyMeta(user.id)).length,
        `no stored key landed for ${email}, so JobDetailV2's action rail would render ` +
          'the keyless link instead of the draft form and the capture would be of the ' +
          'wrong screen.'
      ).toBeGreaterThan(0);
    }

    const cookies = await helpers.getCookies({ userId: user.id, domain: 'localhost' });
    expect(cookies.length, `no session cookie was minted for ${email}`).toBeGreaterThan(0);

    const context = await browser.newContext();
    await context.addCookies(
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        // Not `secure: cookie.secure`. better-auth sets that from its own
        // environment, and a secure cookie is never sent over the http:// the
        // local dev server speaks — the session would simply not arrive, and the
        // page would render signed-out with nothing failing.
        secure: false,
        sameSite: (normaliseSameSite(cookie.sameSite)),
        expires: expiresInSeconds(cookie.expires)
      }))
    );

    // ASSERT THE STATE IS NOT EMPTY. The first version of this file wrote
    // {"cookies":[],"origins":[]} — 36 bytes — and passed: getCookies returned
    // cookies, addCookies accepted them, and every one was dropped for being
    // expired, because the expiry was converted twice. Nothing failed. The
    // signed-in projects would then have loaded gated pages as a signed-OUT
    // visitor and compared them against baselines recorded the same way, and the
    // whole harness would have agreed with itself about a lie. This is the single
    // most important assertion in the sweep.
    const state = await context.storageState({ path: `.sweep/auth/${role.name}.json` });
    expect(
      state.cookies.length,
      `.sweep/auth/${role.name}.json came back with no cookies, so this role would ` +
        'browse signed-out while claiming to be ' + role.tier + '. The cookies were ' +
        'minted (there were ' + cookies.length + ') and then dropped by the browser ' +
        'context — check the expiry conversion and the secure flag.'
    ).toBeGreaterThan(0);
    await context.close();
  }

  // A manifest of what was minted, so a failing spec can say which account it was
  // using and the owner can find the row.
  writeFileSync(
    '.sweep/auth/roles.json',
    JSON.stringify(
      ROLES.map((role) => ({ ...role, email: EMAIL(role.name) })),
      null,
      2
    )
  );
});
