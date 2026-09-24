import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup, expect } from 'playwright/test';

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
  { name: 'internal', tier: 'internal' }
] as const;

/** Fixed addresses and ids, so two runs produce the same accounts and a stray row
 *  is recognisable as the sweep's rather than a person's. .test is reserved by
 *  RFC 2606 and can never be a real domain. */
const EMAIL = (role: string) => `sweep-${role}@antialgo.test`;

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/antialgo_test';

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

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_URL_UNPOOLED = TEST_DATABASE_URL;
  // better-auth signs the session cookie with this. Any stable value works for a
  // disposable database; a missing one throws inside authOptions().
  process.env.BETTER_AUTH_SECRET ??= 'sweep-only-secret-not-a-real-one';
  process.env.BETTER_AUTH_URL ??= 'http://localhost:4321';

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
        secure: cookie.secure,
        sameSite: (cookie.sameSite ?? 'Lax') as 'Lax' | 'Strict' | 'None',
        expires: cookie.expires ? Math.floor(cookie.expires / 1000) : -1
      }))
    );
    await context.storageState({ path: `.sweep/auth/${role.name}.json` });
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
