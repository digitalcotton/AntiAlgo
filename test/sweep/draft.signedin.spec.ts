import { readFileSync } from 'node:fs';
import { test, expect } from 'playwright/test';
import { SWEEP_DATABASE_URL, SWEEP_ENV } from './env';
import { FUNCTION_MAX_DURATION_S } from '../../site.config.mjs';

/**
 * draft.signedin.spec.ts: the money path, board -> job detail -> draft -> DOCX.
 *
 * WHAT THIS DOES NOT DO, AND WHY. The drafting pipeline's live path calls
 * generation-providers.ts against a real key. This spec never has one: the
 * paid sweep account (test/sweep/auth.setup.ts's sweep-paid@antialgo.test) has
 * no row in the keychain, and this file never adds one, so
 * generation-preference-store.ts's triggerJobDraft() always reads `provider =
 * null` and renderOneDocument() takes its deterministic branch (the built-in
 * writer, status 'fallback', no key read, no fetch). That is not a workaround
 * to dodge the network — it is the honest state of a paid account that has
 * never connected a provider, and draft-run-dispatch.ts's own header names the
 * other reason this is where the browser journey has to stop: DRAFT_RUN_SECRET
 * is not in SWEEP_ENV (test/sweep/env.ts), so dispatchJobDraftRuns() logs that
 * and hands every document back for renderInProcess() to render in THIS dev
 * server's own process — never a POST to /run, never VERCEL_AUTOMATION_BYPASS_
 * SECRET, never a self-call across the network. So the real, non-mocked
 * pipeline runs end to end (beginJobDraft -> dispatch's in-process fallback ->
 * renderOneDocument -> completeDraft), and the one thing that would need a key
 * and a socket (a generative provider call) never fires because the account
 * genuinely has nothing to call it with. If BYOK ever seeds a provider key for
 * a sweep account, this stops being true and this file must gate on hasKey
 * again rather than assume it.
 *
 * THE FOUR SEEDED JOBS. scripts/test-db.mjs's own header says a journey that
 * needs a Profile Record entry, a draft, or a key "writes that row itself...
 * rather than finding it pre-seeded by a script that has never run the
 * feature." This file follows that rule for the Profile Record (below) and
 * borrows, rather than reinvents, the jobs table: JOB_RAWS fixtures 001-004,
 * whose slug is `${company}-${title}` lowercased and hyphenated
 * (scripts/test-db.mjs:465-468). Four separate jobs, one per assertion, so a
 * version written by one test is never read by another.
 *
 * STORE-LEVEL VS BROWSER, MARKED AT EACH ASSERTION. Per-assertion below.
 */

type Role = 'waitlisted' | 'member' | 'paid' | 'internal';

const ROLE = (): Role => {
  const name = test.info().project.name;
  if (name === 'member' || name === 'paid' || name === 'internal' || name === 'waitlisted') return name;
  throw new Error(
    `draft.signedin.spec.ts ran under project "${name}", which carries no storageState. ` +
      'It must only run under the member, paid, internal or waitlisted projects — check testMatch in playwright.config.ts.'
  );
};

/** Skips everything but the paid project: this file is the paid money path,
 *  and the other three projects exist only so the manifest-driven specs can
 *  assert paid content is refused to them (routes.signedin.spec.ts already
 *  does that for every route). Running this file's setup four times over
 *  would buy nothing and would quadruple its DB writes for no assertion. */
function paidOnly(): void {
  test.skip(ROLE() !== 'paid', 'draft.signedin.spec.ts is the paid money path; nothing here is asserted for other roles.');
}

/** auth.setup.ts's own EMAIL('paid'); not exported from that file, so pinned
 *  here to the one email that account is minted under. */
const PAID_EMAIL = 'sweep-paid@antialgo.test';
const MEMBER_STORAGE_STATE = '.sweep/auth/member.json';

/** company-title fixtures from scripts/test-db.mjs's JOB_RAWS, one job per
 *  assertion so no two tests share a (user, job) row. */
const READY_JOB_SLUG = 'figma-senior-product-designer'; // fixture-001
const READY_JOB_SOURCE = 'Greenhouse'; // SOURCE_LABELS['greenhouse'], src/lib/data.ts
const FAILED_JOB_SLUG = 'notion-staff-product-designer'; // fixture-002
const IDEMPOTENCE_JOB_SLUG = 'amazon-staff-ux-researcher'; // fixture-003
const CLAIM_JOB_SLUG = 'techcorp-lead-content-designer'; // fixture-004

/**
 * Refuses to open a database connection anywhere but antialgo_test, the same
 * refusal scripts/test-db.mjs and auth.setup.ts each make on their own before
 * doing anything destructive. This file writes generated_render and
 * record_entry rows directly (store-level assertions, below) and must never
 * be able to point that at antialgo_dev because a stray env var changed.
 */
function assertLocalTestDb(): void {
  const url = new URL(SWEEP_DATABASE_URL);
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const named = url.pathname === '/antialgo_test';
  if (!localhost || !named) {
    throw new Error(
      `draft.signedin.spec refuses to touch ${url.hostname}${url.pathname}. It writes generated_render and ` +
        'record_entry rows directly; it only ever speaks to a localhost database named antialgo_test.'
    );
  }
}

/**
 * Opens the store modules this file calls directly, never through a route:
 * generated-render-store.ts for the claim/complete/fail functions the task
 * names, record-store.ts to seed a Profile Record the same way a real account
 * would build one. FORCED env, not ??=, and set before the dynamic imports —
 * the same shape auth.setup.ts uses and for the same reason its own header
 * gives: this test process has no DATABASE_URL of its own, and a plain ??=
 * would let .env.local's real credentials win by accident.
 */
async function storeModules() {
  assertLocalTestDb();
  for (const [key, value] of Object.entries(SWEEP_ENV)) process.env[key] = value;
  const dbModule = await import('../../src/lib/db');
  const renderStore = await import('../../src/lib/generated-render-store');
  const recordStore = await import('../../src/lib/record-store');
  return { dbModule, renderStore, recordStore };
}

/** The paid sweep account's id, read back from the row auth.setup.ts minted.
 *  Never hand-rolled: if this comes back empty, the fix is `npx playwright
 *  test --project=setup`, not a fallback id this file invents. */
async function paidUserId(dbModule: typeof import('../../src/lib/db')): Promise<string> {
  const { rows } = await dbModule.db().query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [PAID_EMAIL]);
  if (!rows[0]) {
    throw new Error(
      `draft.signedin.spec: no user row for ${PAID_EMAIL}. Run \`npx playwright test --project=setup\` first ` +
        '(or the whole suite, which runs it as a dependency).'
    );
  }
  return rows[0].id;
}

/**
 * Makes sure the paid account's Profile Record is not empty, the same way a
 * real person's would not be by the time they draft. renderOneDocument() fails
 * every draft honestly, before any provider work, when listEntries() comes
 * back empty (generation-preference-store.ts's own guard, added after a blank
 * "just a name" resume shipped as 'ready') — so a fresh sweep account with no
 * entries would only ever prove the FAILED-draft path, never the ready one.
 * Idempotent: only writes when nothing is there yet, so re-running this file
 * against a database that was not reset does not pile up entries.
 */
async function ensureProfileRecord(
  recordStore: typeof import('../../src/lib/record-store'),
  userId: string
): Promise<void> {
  const existing = await recordStore.listEntries(userId);
  if (existing.length > 0) return;
  await recordStore.createEntry(userId, {
    kind: 'role_held',
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Senior Product Designer',
    start: { year: 2021, month: 1 },
    end: null,
    location: 'Remote',
    description:
      'Led the redesign of the core onboarding flow, cutting signup drop-off by a third. ' +
      'Partnered with engineering to ship a design system used across four product surfaces.',
    classification: 'private',
    artifacts: []
  });
}

/** True when `bytes` starts with a zip local-file-header signature and
 *  contains `entryPath` somewhere in its raw bytes. A full central-directory
 *  parse would be more rigorous, but a byte search for the literal path is
 *  already enough to catch the failure this assertion exists for: a
 *  hand-rolled writer that emits a corrupt or truncated archive, which is a
 *  silent failure because the browser never opens what it downloads. */
function looksLikeDocx(bytes: Buffer): { isZip: boolean; hasDocumentXml: boolean } {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const hasDocumentXml = bytes.includes(Buffer.from('word/document.xml', 'ascii'));
  return { isZip, hasDocumentXml };
}

test.describe('the money path: board -> job detail -> draft -> DOCX', () => {
  test('1/2/4: renders, gates by tier, drafts, and the DOCX is a real one', async ({ page, browser }) => {
    paidOnly();
    test.setTimeout(60_000);

    const { dbModule, renderStore, recordStore } = await storeModules();
    const paidId = await paidUserId(dbModule);
    await ensureProfileRecord(recordStore, paidId);

    // ---------------------------------------------------------------------
    // 1. BROWSER: the job detail page renders for a real seeded job, with its
    // Apply control, and the draft entry point present for paid...
    // ---------------------------------------------------------------------
    const complaints: string[] = [];
    page.on('pageerror', (error) => complaints.push(`uncaught: ${error.message}`));

    const response = await page.goto(`/board/${READY_JOB_SLUG}`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `/board/${READY_JOB_SLUG} as paid`).toBeLessThan(400);
    // Scoped to #jd-actions (the action rail): the same text also appears in
    // the sticky mini bar (hidden until scroll) and in the record's "Apply
    // on" stat line, and a bare getByText would be ambiguous between all three.
    await expect(
      page.locator('#jd-actions').getByText(new RegExp(`Apply on ${READY_JOB_SOURCE}`, 'i')),
      'the Apply control (JobDetailV2.astro) must be on the page'
    ).toBeVisible();

    // THE ENTRY POINT, NOT NECESSARILY A SUBMITTABLE FORM. This sweep account
    // is paid but (deliberately, see this file's header) has no provider key,
    // and JobDetailV2's own gate for the actual `<textarea>` + submit form is
    // `signedIn && hasKey`, one rung narrower than `paid` alone: with no key
    // the control paid still sees is the link to key setup ("a signed-in
    // reader with no key is routed to key setup", JobDetailV2's own header).
    // Both shapes carry the same label, so asserting on the label is the
    // faithful "is the draft entry point here" check regardless of which
    // shape renders; the earlier attempt at this line, expecting `#jd-reason`
    // unconditionally, failed here first — a real product behaviour this file
    // would otherwise have missed by assuming a key that does not exist.
    const draftEntryPoint = page.locator('#jd-actions').getByText('Draft resumé and cover letter', { exact: true });
    await expect(draftEntryPoint, 'paid must see the draft entry point').toBeVisible();
    expect(complaints, `paid /board/${READY_JOB_SLUG} made the browser complain:\n  ${complaints.join('\n  ')}`).toEqual([]);

    // ...and ABSENT for member (read JobDetailV2 for the gating): the whole
    // block, keyed or not, is behind `paid &&`, so a member gets none of it.
    const memberContext = await browser.newContext({ storageState: MEMBER_STORAGE_STATE });
    try {
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`/board/${READY_JOB_SLUG}`, { waitUntil: 'domcontentloaded' });
      await expect(
        memberPage.locator('#jd-actions').getByText('Draft resumé and cover letter', { exact: true }),
        'member must not get the draft entry point'
      ).toHaveCount(0);
    } finally {
      await memberContext.close();
    }

    // ---------------------------------------------------------------------
    // 2. Starting a draft moves the state out of idle, and the rail's own
    // terminal condition is the safe kind.
    // ---------------------------------------------------------------------
    const statusUrl = `/desk/job-draft/${READY_JOB_SLUG}/status`;

    // No key means the entry point above is a link to Settings, not a form —
    // so the click that actually starts drafting is the one
    // desk/job-draft.ts's POST handler itself always accepts regardless of a
    // key (its own header: "IT ALWAYS DRAFTS... does not gate on a provider
    // key"). page.request shares this page's session cookie, so this is the
    // same request DraftRail's own fetch() makes (Accept: application/json),
    // against the real route, not a stand-in for it.
    const startForm = new URLSearchParams({ slug: READY_JOB_SLUG, reason: 'safety-net regression test: the money path' });
    const startResponse = await page.request.post('/desk/job-draft', {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      data: startForm.toString()
    });
    expect(startResponse.ok(), `POST /desk/job-draft answered ${startResponse.status()}`).toBe(true);
    expect((await startResponse.json()).drafting).toBe('started');

    // BROWSER: the pair state left 'none' the moment the click landed.
    // beginJobDraft()'s two INSERTs happen before triggerJobDraft() returns,
    // so this is true regardless of how far the (fast, deterministic) render
    // has gotten by the time this fetch lands — never a race.
    const afterClick = await (await page.request.get(statusUrl)).json();
    expect(afterClick.status, 'starting a draft must leave the pair state out of "none"').not.toBe('none');

    // The draft room is where the empty/idle state ("No draft yet") would be
    // showing if nothing had started; land here to prove it is gone.
    await page.goto(`/desk/job-draft/${READY_JOB_SLUG}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('No draft yet'), 'the empty/idle state must be gone').toHaveCount(0);

    // STATIC: DraftRail.astro's own poll loop ends its wait on NOT-pending,
    // never on an enumerated list of success values — the exact shape
    // resume-parse-wire.ts's header says three browser surfaces had to be
    // rewritten to match (docs/regression-strategy.md section 2; ab7b03c /
    // 341f8af). This is a source check, not a live interaction: JobDetailV2's
    // button is the plain form above, and DraftRail's own script is the
    // surface that runs elsewhere (board/[slug].astro's non-JobDetailV2
    // branches, role/[slug].astro). The property under test is the same
    // wherever the script runs, because it is one file.
    const railSource = readFileSync('src/components/job-detail/DraftRail.astro', 'utf8');
    expect(railSource, 'stillPending() must read state.status alongside both per-document statuses').toMatch(
      /stillPending[\s\S]{0,220}state\.status === 'pending'[\s\S]{0,220}docStatus\(state, 'resume'\) === 'pending'/
    );
    expect(railSource, "the watch() loop must exit on `if (!stillPending(state))`, not a hand-kept success list").toMatch(
      /if \(!stillPending\(state\)\) \{/
    );
    // The unsafe shape this guards against — an enumerated exit test that a
    // new status value (a 'failed', once, was exactly this) would silently
    // fall outside of, hanging the poll for its full six-minute ceiling.
    expect(railSource, 'the loop must not gate its own exit on an enumerated status list').not.toMatch(
      /if \(\s*(status|state\.status)\s*===\s*'ready'\s*\|\|\s*(status|state\.status)\s*===\s*'failed'\s*\)/
    );

    // Let the deterministic writer settle (no key on this account, no
    // network — see this file's header). expect.poll rather than a fixed
    // sleep: the render is a handful of in-memory awaits, typically done in
    // well under a second, but the assertion should hold on a loaded machine.
    await expect
      .poll(async () => (await (await page.request.get(statusUrl)).json()).status, {
        timeout: 20_000,
        message: 'the deterministic draft never left pending'
      })
      .not.toBe('pending');

    const settled = await (await page.request.get(statusUrl)).json();
    expect(settled.status, `job-draft status for ${READY_JOB_SLUG}: ${JSON.stringify(settled)}`).toBe('ready');

    // ---------------------------------------------------------------------
    // 4. THE DOCX.
    // ---------------------------------------------------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Download DOCX' }).first()).toBeVisible();

    const docxResponse = await page.request.get(`/desk/job-draft/${READY_JOB_SLUG}/resume?format=docx`);
    expect(docxResponse.ok(), `GET .../resume?format=docx answered ${docxResponse.status()}`).toBe(true);
    expect(docxResponse.headers()['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const bytes = await docxResponse.body();
    expect(bytes.length, 'a real DOCX is not a handful of bytes').toBeGreaterThan(2000);
    const { isZip, hasDocumentXml } = looksLikeDocx(bytes);
    expect(isZip, 'the file must open with a zip local-file-header, PK\\x03\\x04').toBe(true);
    expect(hasDocumentXml, 'the zip must contain word/document.xml or no Word reader can open it').toBe(true);

    // The cover letter's DOCX gets the same two checks, cheaply, since a
    // hand-rolled writer failing on one document type and not the other is
    // exactly the kind of thing a single spot-check would miss.
    const coverDocxResponse = await page.request.get(`/desk/job-draft/${READY_JOB_SLUG}/cover?format=docx`);
    expect(coverDocxResponse.ok()).toBe(true);
    const coverBytes = await coverDocxResponse.body();
    const coverCheck = looksLikeDocx(coverBytes);
    expect(coverCheck.isZip && coverCheck.hasDocumentXml, 'the cover letter DOCX must also be a real, openable zip').toBe(true);
  });

  test('3: a failed draft surfaces a failure the reader can see, not a spinner forever', async ({ page }) => {
    paidOnly();

    const { dbModule, renderStore } = await storeModules();
    const paidId = await paidUserId(dbModule);
    const ceilingMs = FUNCTION_MAX_DURATION_S * 1000;
    const reason = 'safety-net regression test: a forced failure, to prove the reader sees it.';

    // STORE-LEVEL: begin a real version (db/202's appendJobRenderVersion, the
    // same path a click takes), then fail it through failDraft() — the exact
    // function db/126_job_draft_failed.sql's failure_reason column exists for.
    const { resumeId, coverId } = await renderStore.beginJobDraft(paidId, FAILED_JOB_SLUG, reason);
    await renderStore.failDraft(resumeId, reason);
    await renderStore.failDraft(coverId, reason);

    // STORE-LEVEL: documentState() and jobDraftState() — the one pair of
    // functions the room and the status endpoint both call, so they can never
    // disagree with each other — must read this as 'failed', not stuck
    // 'pending' and not silently reset by the reconciled read.
    const now = Date.now();
    const rows = await renderStore.getJobRendersReconciled(paidId, FAILED_JOB_SLUG, now, ceilingMs);
    expect(rows.resume?.status, 'failDraft must actually flip the row').toBe('failed');
    expect(rows.resume?.failureReason).toBe(reason);
    expect(renderStore.documentState(rows.resume, now, ceilingMs)).toBe('failed');
    expect(renderStore.documentState(rows.cover, now, ceilingMs)).toBe('failed');
    expect(renderStore.jobDraftState(rows, now, ceilingMs)).toBe('failed');

    // BROWSER: the draft room reads that same state and shows the reader a
    // dead end with a reason and a way to retry — never the "drafting"
    // spinner left running over a row that will never finish.
    await page.goto(`/desk/job-draft/${FAILED_JOB_SLUG}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('That draft did not finish')).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start the draft over' })).toBeVisible();
    await expect(
      page.getByText('Drafting your resumé and cover letter against this posting'),
      'the big loading state must not still be showing over a failed draft'
    ).toHaveCount(0);
  });

  test('5: idempotence — starting a draft twice does not produce two runs', async ({ page }) => {
    paidOnly();

    const { dbModule, renderStore } = await storeModules();
    const paidId = await paidUserId(dbModule);

    // ---------------------------------------------------------------------
    // Store-level: claimJobRender() itself. The run endpoint's whole replay
    // guard is this one UPDATE ... WHERE started_at IS NULL; a second claim
    // of the same row must find nothing to claim.
    // ---------------------------------------------------------------------
    const { id: claimRowId } = await renderStore.beginJobDraftDocument(paidId, CLAIM_JOB_SLUG, 'resume', null);
    const firstClaim = await renderStore.claimJobRender(claimRowId, paidId, CLAIM_JOB_SLUG, 'resume');
    const secondClaim = await renderStore.claimJobRender(claimRowId, paidId, CLAIM_JOB_SLUG, 'resume');
    expect(firstClaim, 'the first claim of a fresh pending row must succeed').toBe(true);
    expect(secondClaim, 'a second claim of the same row must find nothing left to claim').toBe(false);

    // ---------------------------------------------------------------------
    // Route-level: the job-draft POST's own dedupe (src/pages/desk/job-
    // draft.ts's "IDEMPOTENT RETRY" block). beginJobDraft() directly (not
    // triggerJobDraft) leaves the row 'pending' forever — nothing renders it —
    // so the window this test depends on cannot close under it; the POST's
    // own reconciled read must see 'pending' and skip creating a new version.
    // ---------------------------------------------------------------------
    const before = await renderStore.beginJobDraft(paidId, IDEMPOTENCE_JOB_SLUG, 'idempotence check');
    const versionsBefore = await renderStore.listJobRenderVersions(paidId, IDEMPOTENCE_JOB_SLUG, 'resume');
    expect(versionsBefore.some((v) => v.id === before.resumeId && v.status === 'pending'), 'the seeded row is pending').toBe(
      true
    );

    const form = new URLSearchParams({ slug: IDEMPOTENCE_JOB_SLUG });
    const firstPost = await page.request.post('/desk/job-draft', {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form.toString()
    });
    expect(firstPost.ok(), `first POST /desk/job-draft answered ${firstPost.status()}`).toBe(true);
    const secondPost = await page.request.post('/desk/job-draft', {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form.toString()
    });
    expect(secondPost.ok(), `second POST /desk/job-draft answered ${secondPost.status()}`).toBe(true);

    const versionsAfter = await renderStore.listJobRenderVersions(paidId, IDEMPOTENCE_JOB_SLUG, 'resume');
    expect(
      versionsAfter.length,
      'two clicks on a still-pending draft must not write a second (or third) version'
    ).toBe(versionsBefore.length);
  });
});
