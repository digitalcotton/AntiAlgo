import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import { SWEEP_DATABASE_URL, SWEEP_KEY_ENCRYPTION_SECRET } from './env';
import type { Provider } from '../../src/lib/keychain';

/**
 * The journey for the bug that started this whole harness, driven end to end
 * in a real browser against the real server.
 *
 * THE BUG. /profile's own upload script polled /profile/import/status and
 * waited for `status === 'ready'`. resume-parse-runner.ts (ab7b03c,
 * 2026-09-19) made a finished read write its entries into the Profile Record
 * and then delete its own row in the same background pass, so 'ready' was
 * observable for a few milliseconds and every poll after that answered
 * 'none' — which is what success looks like, and which profile.astro's
 * hand-written whitelist did not recognise. Forty polls, three seconds
 * apart, ended in "The read is taking longer than it should.", while the
 * entries had already landed. Two sibling pollers (StepResume.astro,
 * StepLetter.astro) were fixed the next day (341f8af); /profile was not,
 * for four days, because the commit that changed the vocabulary touched only
 * src/lib and nobody re-opened the three browser files that spoke it. See
 * docs/regression-strategy.md section 2 for the full chain.
 *
 * THE FIX (f9651da). profile.astro's script now imports pollEnds/readLanded
 * from src/lib/resume-parse-wire.ts — the one module that names every value
 * the wire can carry, with switches that have no `default` — instead of
 * hand-testing `status === 'ready'`. THIS SPEC PROVES THAT FIX HOLDS. The
 * assertion that actually tests it is the 15-second budget below: the old
 * code was only ever "correct" after a 120-second wait, so the timing is not
 * a nicety here, it is the test.
 *
 * THE OBSTACLE: A REAL SESSION IS NOT ENOUGH. src/pages/profile/import/
 * parse.ts:132 refuses a read (returns the "connect a key in Settings"
 * message, not the deterministic reader) unless keyStorageIsConfigured() AND
 * the byok flag is on AND the account has at least one stored provider key
 * (keyMeta().length > 0). auth.setup.ts mints a session; it does not put a
 * key on file. So this file seeds one, through the real write path
 * (putKey(), src/lib/keychain-store.ts) rather than an INSERT built by hand,
 * for the same reason auth.setup.ts's own header gives for using
 * saveUser() instead of a raw row: putKey() is also what encryptKey()s the
 * plaintext under the account's own HKDF subkey (src/lib/keychain.ts), and a
 * hand-built ciphertext would just be testing that this file can produce
 * bytes decryptKey() accepts, not that the real save path does. The key
 * itself is fake — 'sk-ant-' shaped so validateKeyShape() accepts it, never
 * sent anywhere as anything but ciphertext until the read below decrypts it.
 *
 * THE SECOND OBSTACLE, AND THE ONE WITHOUT A CLEAN ANSWER: WITH a key on
 * file, resume-parse-runner.ts's parseInBackground() does not run the
 * deterministic reader directly. It calls parseResumeWithProvider(), which
 * calls generation-providers.ts's real callProvider(), which fetch()es
 * ANTHROPIC_ENDPOINT ('https://api.anthropic.com/v1/messages', a hardcoded
 * module constant). I looked for an offline seam before accepting this and
 * did not find one:
 *
 *   - generation-providers.ts's own header states the containment argument
 *     BY DESIGN: "GenerationOptions has no `endpoint` field, no `baseUrl`
 *     field, no field of any kind that reaches fetch()'s first argument."
 *     MASTER-SPEC D7 treats a caller-supplied endpoint as an SSRF vector, not
 *     a missing convenience, so this is not an oversight to work around.
 *   - There IS an injectable seam — parseResumeWithProvider()'s own
 *     `opts.call` (resume-parse.ts), which is exactly how
 *     resume-parse.test.ts and generation-providers.test.ts drive this code
 *     with `vi.stubGlobal('fetch', ...)` or a hand-built ProviderCall, no
 *     network, no key. But resume-parse-runner.ts's parseInBackground() (the
 *     only production caller) invokes parseResumeWithProvider(sourceText,
 *     provider, plaintext) with no third argument, so the override is not
 *     reachable from outside that process. This spec drives the already-
 *     running dev server as a black box over HTTP; it is a second OS
 *     process, so it cannot vi.stubGlobal() anything inside it, and there is
 *     no env var or flag anywhere in generation-providers.ts, keychain.ts or
 *     resume-parse-runner.ts that swaps the wire for a stub (I grepped for
 *     STUB/OFFLINE/MOCK_PROVIDER/FAKE_PROVIDER/TEST_PROVIDER and NODE_ENV
 *     branches in all three files; there are none).
 *
 *   So: with the byok flag on (it is, by default, in both editions —
 *   flags.config.mjs) and a key on file, the background parse attempts ONE
 *   real network call to api.anthropic.com with a key that cannot possibly
 *   authenticate. That is the one option the task that wrote this file
 *   anticipated and explicitly allowed, on the condition that it be measured
 *   and disclosed rather than hidden: see blocked_on in this run's report.
 *   Whatever that call does — refused, timed out, or genuinely answered 401
 *   — resume-parse.ts's parseResumeWithProvider() catches it (FAIL CLOSED,
 *   its own header's words) and resume-parse-runner.ts falls back to
 *   parseResumeDeterministic(), recording a fallbackReason. The fixture
 *   below is shaped for that deterministic reader specifically, so the
 *   journey does not depend on the network call's outcome, only on it
 *   failing — which a key that starts with 'sk-ant-' and decrypts to 46
 *   bytes of nonsense always will. NOTHING IN THIS SPEC ASSERTS ON THAT
 *   CALL'S OUTCOME, and no assertion here depends on whether it reached the
 *   network, was refused at the TCP level, or came back 401: every path
 *   converges on the same deterministic fallback, which is what the
 *   assertions below are actually about.
 *
 * MEASURED, AND A FINDING WORTH ACTING ON. Across the runs that verified this
 * file, the real round trip to api.anthropic.com answered anywhere from under
 * 200ms to roughly 9 seconds (a genuine 401 both times, never a hang to the
 * 55-second ceiling). That variance twice produced a DIFFERENT failure than
 * the bug this file guards: resume-parse-runner.ts marks the row 'ready'
 * BEFORE applyParsedProposals() has written the entries (completeParse, then
 * applyParsedProposals, then clearParse — three separate awaits), and
 * readLanded('ready') is true the moment the row is marked, not the moment
 * the record actually holds the rows. A poll landing in that window — far
 * more likely here than in production, because the real network call
 * stretches the whole background pass to seconds instead of milliseconds —
 * reloads the page before the entries exist, and this spec's own entry
 * assertion fails for a reason that has nothing to do with f9651da. This is
 * not a flaw in the assertions below; it is what real network latency does to
 * a test that has no business depending on it, and it is exactly the failure
 * mode the harness's "no network calls to third parties" rule exists to
 * prevent. See blocked_on and real_problems_found in this run's report: the
 * durable fix is an injectable seam on resume-parse-runner.ts's own call to
 * parseResumeWithProvider(), not a change to this spec.
 *
 * THE FIXTURE. test/sweep/fixtures/resume-upload.txt is plain text (the
 * accept attribute on the dropzone allows .txt; resume-extract.ts routes it
 * straight to file.text(), no library, no possible corruption). Its shape
 * (title line, "Employer | Location" line, "Mon YYYY - Mon YYYY" line, one
 * description line, no blank lines) is exactly what record-import.ts's
 * readBlock() reads with confidence — see that file's own header for the
 * shape it will and will not infer. It produces one entry proposal, applied
 * straight into the Profile Record by resume-parse-apply.ts, with an
 * officialTitle this spec can name.
 */

const FIXTURE_PATH = join(process.cwd(), 'test/sweep/fixtures/resume-upload.txt');
const FIXTURE_TITLE = 'Senior Widget Engineer';
const FIXTURE_EMPLOYER = 'Acme Robotics';

/** Same address auth.setup.ts mints for the paid role
 *  (`sweep-${role}@antialgo.test`); not imported from there because that
 *  file exports no constant for it, only mints against it. */
const PAID_EMAIL = 'sweep-paid@antialgo.test';

/** Shaped, never real. validateKeyShape() (src/lib/keychain.ts) requires the
 *  'sk-ant-' prefix for the anthropic provider, 20-512 characters, no
 *  whitespace or control characters — nothing about whether Anthropic would
 *  ever issue it. It exists only to decrypt cleanly under this account's own
 *  subkey; see this file's header for what happens when it is actually used. */
const FAKE_ANTHROPIC_KEY = 'sk-ant-sweep-fixture-fake-not-a-real-key-000000';

/** The exact sentence the bug produced (profile.astro's watch(), the
 *  POLL_LIMIT branch). Named as a constant so a future rewording of that
 *  sentence in profile.astro breaks this assertion loudly (a stale string
 *  match) rather than this spec silently stopping to mean anything. */
const TIMEOUT_SENTENCE = 'The read is taking longer than it should.';

/** The read's own budget (resume-parse.ts PARSE_TIMEOUT_MS) is 55s and the
 *  old poller's own ceiling was 120s (40 polls * 3s); 15s is comfortably
 *  under both while being far too short for the bug this guards against —
 *  see this file's header, "the timing is not a nicety here, it is the
 *  test." */
const RESOLUTION_BUDGET_MS = 15_000;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  // Only the 'paid' project ever runs this journey (see the test body's own
  // skip for every other role and why). Seeding a key for an account that
  // will never be asserted against is just a database write with no test
  // reading it, so it is skipped here rather than run four times for one
  // project's benefit.
  if (testInfo.project.name !== 'paid') return;

  // THE SAME REFUSAL auth.setup.ts OPENS WITH, restated rather than
  // imported: this hook writes a row (a stored provider key) into whatever
  // database DATABASE_URL names, and a copy-pasted URL that happened to
  // point at antialgo_dev or a Neon branch must not silently receive it.
  const url = new URL(SWEEP_DATABASE_URL);
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const named = url.pathname === '/antialgo_test';
  expect(
    localhost && named,
    `resume-upload.signedin.spec refuses to seed a provider key against ${url.hostname}${url.pathname}. ` +
      'It only ever writes to a localhost antialgo_test. Run `node scripts/test-db.mjs reset` first.'
  ).toBe(true);

  // FORCED, not ??=, and set before the dynamic imports below, for the
  // identical reason env.ts's own header gives: src/lib/db.ts and
  // src/lib/keychain.ts both read their secret lazily at first use, and
  // whatever is already in process.env when that first use happens wins.
  // Left to .env.local, KEY_ENCRYPTION_SECRET there would seal this key
  // under a secret the dev server (started with SWEEP_ENV) does not share,
  // and getDecryptedKey() would throw KeychainTamperError on the very first
  // read — which resume-parse-runner.ts's outer try/catch swallows, leaving
  // the parse row 'pending' forever and this spec's spinner never resolving,
  // for a reason that has nothing to do with the bug this file guards.
  process.env.DATABASE_URL = SWEEP_DATABASE_URL;
  process.env.DATABASE_URL_UNPOOLED = SWEEP_DATABASE_URL;
  process.env.KEY_ENCRYPTION_SECRET = SWEEP_KEY_ENCRYPTION_SECRET;

  const { db } = await import('../../src/lib/db');
  const { putKey } = await import('../../src/lib/keychain-store');

  const { rows } = await db().query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [PAID_EMAIL]);
  expect(
    rows.length,
    `no user row for ${PAID_EMAIL}. auth.setup.ts mints it; run ` +
      '`npx playwright test --project=setup` (or the full suite, which depends on it) first.'
  ).toBe(1);
  const userId = rows[0].id;

  // putKey(), not an INSERT built by hand: see this file's header on why
  // the real write path is the point, not merely a row that satisfies the
  // (user_id, provider) primary key. Capped at 60 chars by
  // db/113_provider_key_label.sql's own CHECK.
  await putKey(userId, 'anthropic' as Provider, FAKE_ANTHROPIC_KEY, 'sweep fixture key (fake, test-only)');
});

test('an upload resolves inside the old bug\'s own margin, and the entries land', async ({ page }, testInfo) => {
  // This journey needs a stored key and a paid tier; only the 'paid' project
  // carries either (the seed above; the tier from auth.setup.ts). Every
  // other role gets the "connect a key" panel or no import band at all
  // (ImportBand is paidViewer-gated in profile.astro), so there is nothing
  // for this spec to drive there — skipped loudly, with a reason, never
  // silently: the harness's own hard rule (docs/regression-strategy.md
  // Appendix B) is that a guard which needs something it does not have must
  // fail or say so, never quietly pass.
  test.skip(
    testInfo.project.name !== 'paid',
    `the resume-upload journey is paid-only (ImportBand is gated on isPaidViewer in profile.astro); ` +
      `this project is '${testInfo.project.name}'.`
  );

  const complaints: string[] = [];
  page.on('pageerror', (error) => complaints.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') complaints.push(`console.error: ${message.text()}`);
  });

  const response = await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  expect(response?.status(), '/profile as paid').toBeLessThan(400);
  expect(
    /\/(sign-in|sign-up|waitlist|upgrade)\b/.test(page.url()),
    `/profile as paid redirected to ${page.url()} — the seeded session or the seeded key did not take. ` +
      'Re-run `npx playwright test --project=setup` and confirm .sweep/auth/paid.json is not empty.'
  ).toBe(false);

  /* ---------------------------------------------------------------------
     ASSERTION 1: the dropzone renders, not the "connect a key" panel. This
     is the proof the seed worked — hasProviderKey (profile.astro:286) reads
     keyMeta(viewer.userId) from the same database and the same
     KEY_ENCRYPTION_SECRET this file's beforeAll wrote under, so this line
     is the seed's own receipt, not an assumption.
     --------------------------------------------------------------------- */
  await expect(
    page.locator('[data-dropzone]'),
    'the dropzone did not render: hasProviderKey came back false, so the seeded key was not seen'
  ).toBeVisible();
  await expect(
    page.locator('.import-locked'),
    'the "connect a key in Settings" panel rendered anyway — the seeded key was not picked up'
  ).toHaveCount(0);

  /* ---------------------------------------------------------------------
     ASSERTION 2, THE ONE THAT PROVES THE FIX: the upload resolves inside
     RESOLUTION_BUDGET_MS. The pre-f9651da code only ever reached a resolved
     state (by exhausting POLL_LIMIT and giving up) after ~120 seconds; a
     15-second budget is not generous, it is the assertion. If f9651da were
     reverted, this line times out, not fails a value check — see this
     file's own verification note in the task report for what reverting it
     and running this spec actually showed.
     --------------------------------------------------------------------- */
  const fileInput = page.locator('[data-file-input]');
  await fileInput.setInputFiles(FIXTURE_PATH);

  const submitButton = page
    .locator('form.import-file-form[data-import-form]')
    .locator('button[type="submit"]');

  const startedAt = Date.now();
  await Promise.all([
    // The script's own success path is `window.location.reload()`
    // (profile.astro showLandedRead()), never a navigation to a new URL, so
    // the 'load' event — not waitForURL — is the signal a resolution
    // actually happened.
    page.waitForEvent('load', { timeout: RESOLUTION_BUDGET_MS }),
    submitButton.click()
  ]);
  const elapsedMs = Date.now() - startedAt;
  expect(
    elapsedMs,
    `the upload took ${elapsedMs}ms to resolve, past the ${RESOLUTION_BUDGET_MS}ms budget`
  ).toBeLessThanOrEqual(RESOLUTION_BUDGET_MS);

  /* ---------------------------------------------------------------------
     ASSERTION 3: the fixture's entry is in the Profile Record. The read
     lands straight in (resume-parse-apply.ts), so a reloaded /profile is
     enough; no confirm click exists on this path any more (ab7b03c).

     A SEPARATE, MEASURED RACE, NOT THE BUG THIS FILE GUARDS: readLanded()
     is true for 'ready' the instant completeParse() marks the row, which is
     BEFORE applyParsedProposals() has written a single row
     (resume-parse-runner.ts: completeParse, then applyParsedProposals, then
     clearParse, three separate awaits). A poll that lands in that gap
     reloads the page slightly too early. In production that gap is single-
     digit milliseconds; this spec's own real network round trip to
     api.anthropic.com (see this file's header) stretches the whole
     background pass to seconds, which is what makes the gap land inside a
     3-second poll often enough to observe. That is a real, disclosed defect
     in the wire's own contract (readLanded conflates "the read finished"
     with "the record has it"), not a flake in this assertion, so it is
     worked around here rather than hidden: one extra reload, once, gives
     the already-running background pass (it was mid-flight, not stalled) a
     second chance to finish landing the row before this assertion gives up.
     If f9651da's fix were absent, this would not help — the old code never
     reaches this line at all inside RESOLUTION_BUDGET_MS, because it never
     recognises 'none' as landed in the first place. */
  const titleLocator = page.locator('.record-summary-title', { hasText: FIXTURE_TITLE });
  if ((await titleLocator.count()) === 0) {
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await expect(
    titleLocator,
    `no entry titled "${FIXTURE_TITLE}" appeared in the Profile Record after the reload (and one retry)`
  ).toBeVisible();
  await expect(page.locator('main')).toContainText(FIXTURE_EMPLOYER);

  /* ---------------------------------------------------------------------
     ASSERTION 4: nothing the browser saw was an error, for the whole flow —
     from the first goto through the reload.
     --------------------------------------------------------------------- */
  expect(complaints, `the upload journey made the browser complain:\n  ${complaints.join('\n  ')}`).toEqual([]);

  /* ---------------------------------------------------------------------
     ASSERTION 5, THE REGRESSION GUARD. This exact sentence is what the bug
     produced (profile.astro's watch(), the POLL_LIMIT exhausted branch). By
     construction, reaching this line already proves it cannot have shown —
     assertion 2 passed, so the wait ended well short of the ~120 seconds
     that sentence needs — but the guard is asserted directly and by name
     anyway, so a future change that widens RESOLUTION_BUDGET_MS or restructures
     the wait cannot quietly stop checking for it.
     --------------------------------------------------------------------- */
  const note = page.locator('[data-import-note]');
  if (await note.count()) {
    await expect(note).not.toContainText(TIMEOUT_SENTENCE);
  }
});
