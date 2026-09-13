/**
 * generation-preference-store.ts: the impure half of "draft my resume and
 * cover letter when I apply." Three jobs: read and write
 * db/011_generation_on_apply.sql's one column (the same shape
 * record-store.ts's getHandle()/setHandle() already use against the
 * identical table, restated here rather than added there because
 * record-store.ts is outside this task's file list), orchestrate the
 * background trigger itself (src/pages/desk/application.ts's 'click' intent
 * calls this after it has already recorded the click and created the
 * application), and persist what that trigger renders. src/lib/
 * generation-preference.ts is pure and decides (decideGenerationTrigger());
 * this file does I/O and decides nothing beyond gathering that function's
 * four inputs, and, once it says go, calling db/012_drafting.sql's store
 * (src/lib/generated-render-store.ts) and the tailor engine, the same split
 * desk.ts/desk-store.ts and record.ts/record-store.ts already draw
 * elsewhere in this codebase.
 *
 * WHERE THE FOUR GATE INPUTS COME FROM, IN THE SAME FIXED ORDER
 * decideGenerationTrigger() CHECKS THEM. keyStorageConfigured and
 * byokFlagOn are both synchronous and need no database at all
 * (src/lib/keychain.ts's keyStorageIsConfigured(), src/lib/flags.ts's
 * isOn('byok')); triggerBackgroundGeneration() below checks both BEFORE
 * touching the database, so an environment with KEY_ENCRYPTION_SECRET
 * unset, or the 'byok' flag dark, never opens a connection or reads a row
 * at all. preferenceEnabled and hasStoredKey both need a query (this
 * file's own getGenerationPreference(), and src/lib/keychain-store.ts's
 * keyMeta()) and only run once the first two gates have already passed.
 *
 * THE NEW SIGNATURE: (userId, applicationId, job). db/012_drafting.sql
 * added the persistence this file used to have nowhere to put: a render
 * now belongs to one application (generated_render.application_id,
 * cascading from desk_application), not a page's own request-scoped
 * variable, so the caller has to hand in which application this draft is
 * for. src/pages/desk/application.ts's 'click' intent has that id the
 * moment createApplicationFromClick() returns; see that file's own header
 * for the exact call site.
 *
 * MUST RETURN THE DECISION QUICKLY. This task's own brief is explicit: the
 * caller `await`s this function only for the go/no-go decision, before its
 * own redirect, and must never wait on a network call to a person's own AI
 * provider. Every gate check and the two db/012 rows beginDraft() writes
 * are fast (no network), so they are awaited before returning; the actual
 * render, which can call out to a live provider and take seconds, is fired
 * with `void` and never awaited here. See renderInBackground() below.
 *
 * NEVER THROWS PAST THIS FILE. triggerBackgroundGeneration()'s entire body
 * past the two synchronous gates runs inside one try/catch that swallows
 * everything: a database hiccup, a KeychainTamperError from a corrupted
 * key row, a network failure calling a provider (though generativeProvider()
 * itself already fails closed to deterministicProvider per
 * generation-providers.ts's own header, so a provider-side failure alone
 * would not reach this catch). renderInBackground() carries its own,
 * separate try/catch for the same reason, one level further out: it is
 * never awaited by its caller, so a rejection from it would otherwise
 * become an unhandled promise rejection instead of a log line. The
 * `.catch()` on the `void` call below is a second safety net, not the
 * primary guard; renderInBackground() itself is written to never reject.
 *
 * WHAT HAPPENS TO THE RENDER ONCE IT IS COMPUTED, NOW THAT db/012 EXISTS.
 * This used to be "nothing, on purpose" (see this file's own git history):
 * db/006_desk.sql's resume_render_id and cover_render_id columns existed
 * with nowhere to point. That gap is closed. beginDraft() (src/lib/
 * generated-render-store.ts) writes two 'pending' rows the moment this
 * function decides to go, and stamps those ids onto the application row;
 * renderInBackground() below calls completeDraft() once per document,
 * 'ready' on a clean generative pass, 'fallback' when the deterministic
 * writer produced what is stored (either because the chosen provider's own
 * style() call fell back internally, or because this file caught a hard
 * failure, decrypting the key, reaching the database, or anything else,
 * and re-rendered deterministically itself). The draft room
 * (src/pages/desk/draft/[id].astro) is what reads these rows back.
 */
import { db } from './db';
import { deferWork } from './defer-work';
import { isOn } from './flags';
import { keyStorageIsConfigured, type Provider } from './keychain';
import { getDecryptedKey, getWritingModel, keyMeta } from './keychain-store';
import { generativeProvider, GENERATION_PROVIDER_ORDER, PROVIDER_REGISTRY, type GenerativeStyleProvider } from './generation-providers';
import { beginDraft, beginJobDraft, beginJobDraftDocument, claimJobRender, completeDraft, failDraft, type RenderKind } from './generated-render-store';
import { dispatchJobDraftRuns, selfOrigin, type DocumentDispatch } from './draft-run-dispatch';
import { getCoverLetter, listEntries, listLinks, personName, resolveResumeEmail } from './record-store';
import { linkPlatformLabel } from './profile-links';
import { renderCover, renderResume, type RenderHeader, type Target } from './tailor';
import { acceptPastedVoiceSample, type VoiceSample } from './voice';
import type { Job } from './data';
import { decideGenerationTrigger, type GenerationTriggerDecision } from './generation-preference';

/** The reader's own opt-in, true when this person has no app_user_profile
    row at all (should not happen in practice; every account gets one at
    creation, the same invariant record-store.ts's personName() already
    leans on for the same table). DEFAULTS TO true, matching
    db/012_drafting.sql's ALTER COLUMN ... SET DEFAULT true: drafting is on
    out of the box now, not an opt-in a missing row should read as
    declined. Never throws for "no row"; a missing row is not this
    function's problem to diagnose, the same posture personName() already
    takes. */
export async function getGenerationPreference(userId: string): Promise<boolean> {
  const { rows } = await db().query<{ generate_on_apply: boolean }>(
    'SELECT generate_on_apply FROM app_user_profile WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.generate_on_apply ?? true;
}

/** Writes the opt-in. Returns whether a row was actually updated, the same
    "gone versus never there" shape record-store.ts's setPersonName() and
    setHandle() already return for the identical table, so a caller (the
    settings endpoint) can tell "no such profile row" apart from a write
    that silently did nothing. */
export async function setGenerationPreference(userId: string, enabled: boolean): Promise<boolean> {
  const result = await db().query('UPDATE app_user_profile SET generate_on_apply = $2 WHERE user_id = $1', [
    userId,
    enabled
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The model this person's drafting should use with this provider: their own
 * choice when they made one and it is still offered, the provider's writing
 * default otherwise.
 *
 * NEVER A GATE. A missing, unknown or retired choice resolves to the default
 * and drafting proceeds; it does not become a fifth condition in
 * generation-preference.ts's four-gate order. Losing a model choice must never
 * be the reason a person's documents fail to draft.
 */
export async function writingModelFor(userId: string, provider: Provider): Promise<string> {
  const chosen = await getWritingModel(userId, provider);
  return chosen ?? PROVIDER_REGISTRY[provider].defaultWritingModel;
}

export type GenerationTriggerOutcome = GenerationTriggerDecision;

/**
 * Runs both renders against one already-chosen provider and persists them,
 * never awaited by its caller (see triggerBackgroundGeneration() below).
 *
 * TWO PROVIDER INSTANCES, ONE PER DOCUMENT, ON PURPOSE. generativeProvider()
 * is a cheap object construction (no network call until .style() runs), so
 * building two costs nothing; what it buys is a clean, per-document read of
 * fallbackReasons() (generation-providers.ts's GenerativeStyleProvider): a
 * single shared instance's fallbackReasons() list is deduplicated by
 * message across every style() call that instance ever makes, so a resume
 * render and a cover render that failed for the exact same reason (the
 * provider is down, say) would collapse into one entry and this file could
 * not tell which document, if not both, actually fell back. A fresh
 * instance per document keeps that answer exact.
 *
 * STATUS 'ready' VS 'fallback'. A resume or cover whose provider instance
 * reports zero fallbackReasons() after its one render call actually got a
 * verified response from the live provider; 'fallback' otherwise. provider
 * and model are recorded either way, naming what was CONFIGURED and
 * attempted, not only what succeeded: a 'fallback' row still says which
 * provider this account has connected, because "we tried X and the
 * deterministic writer stood in" is a more honest fact than an empty
 * column.
 *
 * THE OUTER CATCH: A HARD FAILURE BEFORE OR BETWEEN THE TWO RENDERS. A key
 * that fails to decrypt, a database hiccup reading the record, or anything
 * else this function did not anticipate lands here. Re-rendering
 * deterministically (no provider argument, tailor.ts's own default) is what
 * lets both rows still complete as 'fallback' rather than sitting at
 * 'pending' forever; the inner try/catch around that second attempt is the
 * one honest case where this function gives up and logs, because a caller
 * with nothing left to try has nothing more useful to do.
 */
/**
 * The person's own name, contact email, and job-related links, read from the
 * record and shaped into the boilerplate header tailor.ts prints at the top of
 * both documents. Three reads, no writes, no decision: exactly the "gather
 * inputs, decide nothing" posture this file's header states for the render
 * itself.
 *
 * The name follows profile.astro's own "No name on file" rule verbatim: null
 * when the person has set neither part, the joined "First Last" (trimmed, so
 * a set first name with an empty last name reads clean) otherwise. Links map
 * one-to-one to a reader label plus the stored url; normaliseLinkUrl()
 * already refused any scheme but http/https before storage, so each url is
 * safe to hand back as an href without re-checking here. The email is whatever
 * resolveResumeEmail() decides (login address or the person's custom one, or
 * null when neither is on file); the switch between those lives there, not
 * here, so this function stays a plain gather.
 *
 * Reading, like the render itself, can throw (a database hiccup); this is
 * called inside renderInBackground()'s try blocks so a failure lands in the
 * one deterministic fallback path rather than a second copy of it.
 */
async function buildRenderHeader(userId: string): Promise<RenderHeader> {
  const name = await personName(userId);
  const links = await listLinks(userId);
  const email = await resolveResumeEmail(userId);
  return {
    name: name && (name.firstName || name.lastName) ? `${name.firstName} ${name.lastName}`.trim() : null,
    email,
    links: links.map((link) => ({ label: linkPlatformLabel(link.platform), url: link.url }))
  };
}

/** The person's cover letter on file, as a writing-voice sample, or null when
    none is stored. Fed ONLY to renderCover (never renderResume), where the
    provider adapts the person's own voice; the letter is never a source of
    facts (see db/025 and profile/import/cover.ts). A stored letter that no
    longer passes the voice cap (should not happen; it passed on the way in)
    degrades to null rather than throwing. */
async function buildCoverVoice(userId: string): Promise<VoiceSample | null> {
  const onFile = await getCoverLetter(userId);
  if (!onFile) return null;
  const accepted = acceptPastedVoiceSample({ text: onFile.text });
  return accepted.ok ? accepted.sample : null;
}

/** The letter verifier's advisory warnings on a letter the provider DID ship
    (a soft length miss, a couple of buzzword tells): logged, never stored on
    the payload and never a fallback. A shipped letter with a warning is still
    a real letter; this only leaves a breadcrumb for tuning the prompt. */
function logLetterWarnings(coverProvider: GenerativeStyleProvider, userId: string): void {
  const warnings = coverProvider.letterWarnings();
  if (warnings.length > 0) {
    console.warn(
      `generation-preference-store: the cover letter shipped with lint warnings for user ${userId}: ${warnings.join('; ')}`
    );
  }
}

// Exported for generation-preference-store.test.ts only: it is the unit the
// header-passthrough tests exercise directly, with the I/O boundary
// (record-store, tailor, the render store) mocked so no database is opened,
// the same "reach the logic, touch no connection" posture the rest of this
// suite already holds. triggerBackgroundGeneration() below remains the only
// production caller; nothing else in the app imports this.
export async function renderInBackground(
  userId: string,
  applicationId: number,
  job: Job,
  provider: Provider,
  resumeId: string,
  coverId: string
): Promise<void> {
  // ONE RESOLVED VALUE, USED AND RECORDED. Before the model became a choice
  // this line read the registry default and was passed only to completeDraft's
  // audit row, never to the provider: the recorded model and the used model
  // agreed by coincidence. A person choosing their own model breaks that
  // coincidence, so the same value now goes both places or the provenance
  // this site publishes would be false.
  const model = await writingModelFor(userId, provider);
  const target: Target = { kind: 'verified_posting', job };

  try {
    const plaintext = await getDecryptedKey(userId, provider);
    if (!plaintext) {
      // A row existed in keyMeta() a moment ago but getDecryptedKey() came
      // back empty: the ordinary "key removed between two reads" case every
      // other caller of these two functions in sequence already has to
      // allow for. Thrown here, on purpose, so the catch below runs the one
      // deterministic re-render path rather than this function needing a
      // second copy of it.
      throw new Error('generation-preference-store: the stored key could not be read back for decryption.');
    }

    const entries = await listEntries(userId);
    const header = await buildRenderHeader(userId);
    // The letter on file, as voice for the cover only. renderResume below never
    // receives it (its signature has no voice parameter); the containment is by
    // absence, the same way voice.test.ts proves it cannot reach a resume.
    const coverVoice = await buildCoverVoice(userId);

    // One provider instance per document (each tracks its own fallback state),
    // and the two documents render in parallel: the resume's per-kind calls and
    // the letter's single call overlap, so the wall time is the slower of the
    // two, not their sum. This matters now that the letter is a real prose call
    // with its own timeout, not a copy of the resume.
    const resumeProvider = generativeProvider(provider, plaintext, { model });
    const coverProvider = generativeProvider(provider, plaintext, { model });
    const [resume, cover] = await Promise.all([
      renderResume(entries, target, resumeProvider, header),
      renderCover(entries, target, coverProvider, coverVoice, header)
    ]);
    await completeDraft(resumeId, {
      status: resumeProvider.fallbackReasons().length > 0 ? 'fallback' : 'ready',
      payload: resume,
      provider,
      model
    });
    await completeDraft(coverId, {
      status: coverProvider.fallbackReasons().length > 0 ? 'fallback' : 'ready',
      payload: cover,
      provider,
      model
    });
    logLetterWarnings(coverProvider, userId);
  } catch (error) {
    console.error(
      `generation-preference-store: falling back to the deterministic writer for user ${userId}, application ${applicationId}.`,
      error
    );
    try {
      const entries = await listEntries(userId);
      // Re-fetched here so the fallback path never renders a header-less
      // document while the happy path renders one: the header build may be
      // the very thing that threw above, so this path builds its own rather
      // than trusting a value the happy path might never have reached.
      const header = await buildRenderHeader(userId);
      // `undefined` for provider (and voice) keeps tailor.ts's own
      // deterministic default, the same no-provider render this path always
      // did; only the trailing header argument is new.
      const resume = await renderResume(entries, target, undefined, header);
      const cover = await renderCover(entries, target, undefined, undefined, header);
      await completeDraft(resumeId, { status: 'fallback', payload: resume, provider, model });
      await completeDraft(coverId, { status: 'fallback', payload: cover, provider, model });
    } catch (fallbackError) {
      // Both attempts failed. The two rows stay 'pending': the draft room's
      // own polling state already describes that plainly, and there is
      // nothing more honest this function can do here than log and stop.
      console.error(
        `generation-preference-store: the deterministic fallback also failed for user ${userId}, application ${applicationId}.`,
        fallbackError
      );
    }
  }
}

/**
 * The whole background trigger, start to finish: gathers
 * decideGenerationTrigger()'s four inputs in the cheapest-first order the
 * file header describes, defers to it, and, only when it says go, writes
 * the two pending draft rows (beginDraft()) and fires the actual render
 * (renderInBackground() above) without awaiting it.
 *
 * Returns the decision either way. A caller that only cares about "did
 * this block anything" can ignore the return value entirely, which is
 * exactly how src/pages/desk/application.ts's click branch uses it: fired,
 * not awaited, before that branch's own redirect. The return value exists
 * for this file's own tests and for a future caller (a status line, a log)
 * that wants to know why nothing happened.
 */
export async function triggerBackgroundGeneration(
  userId: string,
  applicationId: number,
  job: Job
): Promise<GenerationTriggerOutcome> {
  // The two free checks, no database touched for either. See the file
  // header: this is what keeps a deployment with KEY_ENCRYPTION_SECRET
  // unset, or the 'byok' flag dark, from opening a connection just to learn
  // what these two calls already know for nothing.
  const keyStorageConfigured = keyStorageIsConfigured();
  const byokFlagOn = isOn('byok');

  if (!keyStorageConfigured || !byokFlagOn) {
    return decideGenerationTrigger({
      keyStorageConfigured,
      byokFlagOn,
      preferenceEnabled: false,
      hasStoredKey: false
    });
  }

  try {
    const preferenceEnabled = await getGenerationPreference(userId);
    if (!preferenceEnabled) {
      return decideGenerationTrigger({ keyStorageConfigured, byokFlagOn, preferenceEnabled, hasStoredKey: false });
    }

    const stored = await keyMeta(userId);
    // First match in GENERATION_PROVIDER_ORDER wins: the same fixed
    // preference order (anthropic, openai, kimi, deepseek) the old
    // tailor.astro's own "BYOK PROVIDER SELECTION" section used to pick by,
    // now owned by this file alone since that page is gone.
    const chosen = GENERATION_PROVIDER_ORDER.map((id) => stored.find((row) => row.provider === id)).find(
      (row) => row !== undefined
    );
    const decision = decideGenerationTrigger({
      keyStorageConfigured,
      byokFlagOn,
      preferenceEnabled,
      hasStoredKey: chosen !== undefined
    });
    if (!decision.go || !chosen) return decision;

    const { resumeId, coverId } = await beginDraft(userId, applicationId);

    // Deferred, not awaited: see the file header, "MUST RETURN THE DECISION
    // QUICKLY". Deferred through the platform (src/lib/defer-work.ts) because
    // a bare void fire on Vercel can be frozen the moment the response goes
    // out, leaving both rows 'pending' forever. The `.catch()` is a safety
    // net, not the primary guard; renderInBackground() carries its own
    // try/catch and is written to never reject.
    deferWork(
      renderInBackground(userId, applicationId, job, chosen.provider, resumeId, coverId).catch((error) => {
        console.error(
          `generation-preference-store: renderInBackground rejected for user ${userId}, application ${applicationId}.`,
          error
        );
      })
    );

    return decision;
  } catch (error) {
    console.error(
      `generation-preference-store: background generation trigger failed for user ${userId}, job ${job.id}.`,
      error
    );
    return { go: false, reason: 'generation-preference: the trigger failed; see the server log.' };
  }
}

/* -------------------------------------------------------------------------
   The one-click draft button (RUN-DRAFT.md phase 3). Same engine as the apply
   path above, three deliberate differences:
     1. It is keyed to the posting (beginJobDraft, db/022), not an application:
        pressing the button creates no application and no desk card.
     2. It ALWAYS renders. The apply path skips when there is no provider key;
        the button drafts anyway, deterministically, because its whole promise
        is "press it and read something". A no-key draft is labeled 'fallback'
        exactly as the apply path labels a fallback, so the result page's one
        quiet "a connected key writes stronger prose" line has a status to hang
        on without a fourth render state.
     3. It ignores the generate_on_apply preference: that toggle is about what
        happens ON APPLY, and this is not an apply.
   ------------------------------------------------------------------------- */

/** Everything one document's render needs, and nothing it does not: the same
    shape a signed run token carries (src/lib/draft-run-token.ts), so the
    in-process path and the fresh-invocation path render from one input. */
export interface DocumentRenderInput {
  readonly userId: string;
  readonly job: Job;
  readonly kind: RenderKind;
  readonly renderId: string;
  readonly provider: Provider | null;
  readonly reason: string | null;
}

/**
 * Renders ONE document of a job draft and settles its row. Three endings, and
 * the owner's ruling decides which:
 *
 *   'ready'    a provider was tried and delivered a clean, verified document.
 *   'failed'   a provider was tried and could not deliver (its key would not
 *              read back, a non-2xx, a reply cut off, the verifier refusing
 *              twice, anything that threw). The row carries the reason and the
 *              result page offers a retry. NEVER the built-in template: for a
 *              person whose own key was tried, the template drops their note
 *              and reads like a resume, which is the "looks broken" the ruling
 *              forbids.
 *   'fallback' no key is on file at all (`provider` null). The built-in writer
 *              drafts, labelled so the page shows its "connect a key" line.
 *              This is the only path that still writes the template.
 *
 * Never rejects: it is deferred unawaited, so a rejection would be unhandled.
 * The one honest dead end (the failure write itself failing) is logged, and
 * the row is then found abandoned by jobDraftState()'s clock, never left
 * looking like work in progress.
 *
 * The person's own "why this company" note reaches renderCover only, in its
 * inputs, the same way a free-text target's own text passes through untouched
 * (tailor.ts); renderResume never receives it. The letter on file rides as
 * voice on the cover only (buildCoverVoice).
 */
export async function renderOneDocument(input: DocumentRenderInput): Promise<void> {
  const { userId, job, kind, renderId, provider, reason } = input;
  const target: Target = { kind: 'verified_posting', job };
  const label = `${kind} draft`;

  try {
    // The person's own choice, used and recorded from one value; see the note
    // in renderInBackground() above on why those must be the same value.
    const model = provider ? await writingModelFor(userId, provider) : null;
    const entries = await listEntries(userId);
    const header = await buildRenderHeader(userId);

    if (provider) {
      const plaintext = await getDecryptedKey(userId, provider);
      if (!plaintext) {
        console.error(
          `generation-preference-store: ${label} could not read the connected ${provider} key back for user ${userId}, job ${job.slug}.`
        );
        await failDraft(renderId, 'the connected key could not be read back');
        return;
      }

      const instance = generativeProvider(provider, plaintext, model ? { model } : {});
      const payload =
        kind === 'resume'
          ? await renderResume(entries, target, instance, header)
          : await renderCover(entries, target, instance, await buildCoverVoice(userId), header, { reason });

      // The specific reason a provider slot fell back (a non-2xx, a truncated
      // reply, a bad model id, a timeout) is logged, per document, so the actual
      // reason a person's own key could not be used is diagnosable from the
      // server logs. It is a plain sentence our own code minted (never the raw
      // provider body), so it cannot leak a key; the same sentence is stored as
      // the row's failure reason.
      const reasons = instance.fallbackReasons();
      if (reasons.length > 0) {
        console.error(
          `generation-preference-store: ${label} could not be written by the provider for user ${userId}, job ${job.slug}, provider ${provider}, model ${model}: ${reasons.join('; ')}`
        );
        await failDraft(renderId, reasons.join('; '));
        return;
      }

      await completeDraft(renderId, { status: 'ready', payload, provider, model });
      if (kind === 'cover') logLetterWarnings(instance, userId);
      return;
    }

    const payload =
      kind === 'resume'
        ? await renderResume(entries, target, undefined, header)
        : await renderCover(entries, target, undefined, undefined, header, { reason });
    await completeDraft(renderId, { status: 'fallback', payload, provider: null, model: null });
  } catch (error) {
    console.error(`generation-preference-store: ${label} failed for user ${userId}, job ${job.slug}.`, error);
    try {
      await failDraft(renderId, 'the draft could not be rendered');
    } catch (failError) {
      console.error(
        `generation-preference-store: could not record the ${label} failure for user ${userId}, job ${job.slug}.`,
        failError
      );
    }
  }
}

/**
 * Renders one job draft's two documents in this process, in parallel. The
 * in-process path: what triggerJobDraft() falls back to when a document could
 * not be handed to an invocation of its own (no DRAFT_RUN_SECRET, local dev, a
 * dispatch that failed). Each document settles its own row; see
 * renderOneDocument() for the endings.
 */
export async function renderJobDraftInBackground(
  userId: string,
  job: Job,
  provider: Provider | null,
  resumeId: string,
  coverId: string,
  reason: string | null = null
): Promise<void> {
  await Promise.all([
    renderOneDocument({ userId, job, kind: 'resume', renderId: resumeId, provider, reason }),
    renderOneDocument({ userId, job, kind: 'cover', renderId: coverId, provider, reason })
  ]);
}

/** One document rendered here, in this invocation: claim the row first (so a
    run endpoint that turns out to have claimed it after all does not render
    it twice), then render. Never rejects. */
async function renderInProcess(doc: DocumentDispatch): Promise<void> {
  let claimed = false;
  try {
    claimed = await claimJobRender(doc.renderId, doc.userId, doc.job.slug, doc.kind);
  } catch (error) {
    console.error(`generation-preference-store: could not claim the ${doc.kind} of job ${doc.job.slug} in-process.`, error);
    return;
  }
  if (!claimed) return;
  await renderOneDocument(doc).catch((error) => {
    console.error(`generation-preference-store: renderOneDocument rejected for the ${doc.kind} of job ${doc.job.slug}.`, error);
  });
}

/**
 * Begins a job draft and hands each document to an invocation of its own,
 * returning the two ids so a caller can point the reader at the result page
 * immediately. Unlike the apply trigger, this never gates: it picks a provider
 * if a key is on file and the flag is lit, and otherwise renders
 * deterministically, but it always begins a draft and always renders.
 *
 * WHY THE HAND-OFF. The renders run after this function's response goes out,
 * and a deferred promise inherits its invocation's ceiling. Rendering both
 * documents here gave them one shared window and the cover ran out of it in
 * production. dispatchJobDraftRuns() (src/lib/draft-run-dispatch.ts) POSTs a
 * signed token per document to this deployment's own run endpoint, which
 * registers the render with a fresh invocation and answers 202 at once; only
 * those two fast answers are awaited here. A document that could not be
 * dispatched is rendered in this process instead, so nothing is ever left
 * with a pending row nobody is working on. `origin` is the request's URL;
 * without it (a caller with no request) everything renders in-process.
 */
export async function triggerJobDraft(
  userId: string,
  job: Job,
  options: { reason?: string | null; origin?: URL; kind?: RenderKind } = {}
): Promise<{ resumeId: string | null; coverId: string | null }> {
  const reason = options.reason ?? null;
  const keyStorageConfigured = keyStorageIsConfigured();
  const byokFlagOn = isOn('byok');

  let provider: Provider | null = null;
  if (keyStorageConfigured && byokFlagOn) {
    try {
      const stored = await keyMeta(userId);
      const chosen = GENERATION_PROVIDER_ORDER.map((id) => stored.find((row) => row.provider === id)).find(
        (row) => row !== undefined
      );
      provider = chosen ? chosen.provider : null;
    } catch (error) {
      console.error(
        `generation-preference-store: could not read key metadata for a job draft, user ${userId}; drafting deterministically.`,
        error
      );
      provider = null;
    }
  }

  // A per-document retry (options.kind set): restart just that one row, leaving
  // its sibling as it stands, and carry the note forward for a cover retry so
  // the person's words survive it. Otherwise begin both fresh.
  let docs: readonly DocumentDispatch[];
  let resumeId: string | null = null;
  let coverId: string | null = null;
  if (options.kind) {
    const { id, reason: carried } = await beginJobDraftDocument(userId, job.slug, options.kind, reason);
    if (options.kind === 'resume') resumeId = id;
    else coverId = id;
    docs = [{ userId, job, kind: options.kind, renderId: id, provider, reason: reason ?? carried }];
  } else {
    const ids = await beginJobDraft(userId, job.slug, reason);
    resumeId = ids.resumeId;
    coverId = ids.coverId;
    docs = [
      { userId, job, kind: 'resume', renderId: ids.resumeId, provider, reason },
      { userId, job, kind: 'cover', renderId: ids.coverId, provider, reason }
    ];
  }

  const inProcess = options.origin ? await dispatchJobDraftRuns(selfOrigin(options.origin), docs) : docs;

  // Whatever could not be handed off renders here, deferred through the
  // platform for the same reason the apply path above is: a bare void fire
  // can be frozen with the rows still 'pending'.
  for (const doc of inProcess) deferWork(renderInProcess(doc));

  return { resumeId, coverId };
}
