/**
 * POST /profile/import/parse: read an uploaded resume (or pasted text) into
 * reviewable Profile Record proposals. MASTER-SPEC F2's import boost, rebuilt.
 *
 * This replaces the inline intent=parse handling profile.astro used to do in
 * its own frontmatter. The reason it moved to its own endpoint: reading a
 * resume with the person's own provider key can take many seconds, far longer
 * than a page render should hold a tab open, so the work runs in the
 * background (src/lib/resume-parse-runner.ts) and this endpoint returns a 303
 * to the review page at once. Text extraction (mammoth/unpdf, fast) still runs
 * here in the request; only the model read is deferred.
 *
 * MOUNTED UNDER /profile, NOT /api, for the same forced reason every other
 * record endpoint is; see profile/entry.ts's own header.
 *
 * WHO THIS CAN ACT ON. userId comes only from Astro.locals.viewer, never the
 * body. No byok gate here: a person with no key still gets the deterministic
 * reader, and the runner decides which reader to use. The uploaded file is
 * read once, in memory, and never stored (src/lib/resume-extract.ts's rule);
 * the raw resume text is handed to the background parse in memory and never
 * written to a column either (db/015's rule).
 *
 * IT ALSO ANSWERS intent=remove, the same verb import/cover.ts answers for the
 * letter. Removing the resume clears its receipt and DELETES THE RECORD
 * ENTRIES THAT READ PUT IN (owner, 2026-09-25: whatever records we took in,
 * delete them). It reaches only rows tagged import_source = 'resume' (db/209),
 * so an entry typed by hand, or one the cover letter brought in, is untouched.
 */
import type { APIContext } from 'astro';
import { extractResumeText } from '../../../lib/resume-extract';
import { startResumeParse } from '../../../lib/resume-parse-runner';
import { beginParse, clearParse, completeParse } from '../../../lib/resume-parse-store';
import { clearResumeOnFile, deleteEntriesFrom, setResumeOnFile } from '../../../lib/record-store';
import type { ImportWireStatus } from '../../../lib/resume-parse-wire';
import { keyStorageIsConfigured } from '../../../lib/keychain';
import { keyMeta } from '../../../lib/keychain-store';
import { isOn } from '../../../lib/flags';
import { withBase } from '../../../../site.config.mjs';

/** The ceiling on the text handed to a provider parse, whether pasted or
    extracted from a file. A real resume is a few thousand characters; this is
    generous headroom, and it stops an unbounded paste (the file path caps bytes
    at extraction, but the paste path had no cap) from becoming a large,
    uncapped prompt billed to the person's key and held in the function's memory. */
const PARSE_TEXT_MAX_CHARS = 120_000;

export const prerender = false;

/** The message a keyless caller gets. The profile page hides the upload form
    without a key, so reaching here without one is a direct or stale POST; the
    answer is the same either way, and it is the product stance, not a fault:
    a bring-your-own-key application reads a resume only with the person's own
    model. (This message once quoted "about 75 percent" for the basic reader;
    nothing ever measured that, so the number is gone. What is true: the basic
    reader matches one strict title/employer/dates shape and misses everything
    written any other way.) */
const KEY_REQUIRED_MESSAGE =
  'Reading a resume needs your own AI provider key. Without one, only a basic reader is available: it matches one strict shape and misses anything written differently, so it is not run. Connect a key in Settings and your own model reads your resume properly.';

const REVIEW_PATH = '/profile/review';
const PROFILE_PATH = '/profile';

function redirectToReview(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(REVIEW_PATH) } });
}

function redirectToProfile(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(PROFILE_PATH) } });
}

/** Whether the caller is the profile page's own fetch() rather than a plain
    form submit. A fetch caller stays on /profile and polls the status
    endpoint; a plain submit navigates to the review page, exactly as before
    this mode existed. Same seam desk/job-draft.ts already draws. */
function wantsJson(context: APIContext): boolean {
  // Optional-chained because the unit tests drive this handler with a bare
  // stub request that carries formData and nothing else; a missing headers
  // bag is a plain-form caller, which is the safe default.
  return (context.request.headers?.get('accept') ?? '').includes('application/json');
}

/** Every JSON answer this endpoint gives, typed by the vocabulary the browser
 *  reads it with (src/lib/resume-parse-wire.ts). The `status` field is not a free
 *  string: inventing a sixth value here is a compile error, which is what stops
 *  a server change from silently stranding a poller the way ab7b03c did. */
function jsonResponse(
  body: { status: ImportWireStatus } & Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Writes a finished parse that read nothing, so the review surface can show
    one honest message (a bad file, or an empty paste) instead of a blank
    pending state that never resolves. A JSON caller gets the message back
    directly so it can show it in place without a navigation. */
async function completeWithMessage(
  context: APIContext,
  userId: string,
  sourceName: string | null,
  message: string
): Promise<Response> {
  await beginParse(userId, sourceName);
  await completeParse(userId, {
    method: 'deterministic',
    providerLabel: null,
    fallbackReason: null,
    proposals: { entries: [], links: [], name: null },
    notes: [message]
  });
  if (wantsJson(context)) {
    return jsonResponse({ status: 'ready', note: message });
  }
  return redirectToReview();
}

/** The read has started; where the caller waits is up to the caller. */
function started(context: APIContext): Response {
  if (wantsJson(context)) {
    return jsonResponse({ status: 'started' });
  }
  return redirectToReview();
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return wantsJson(context)
      ? jsonResponse({ status: 'signed-out' }, 401)
      : new Response('Not signed in.', { status: 401 });
  }

  const userId = viewer.userId;

  // REMOVE COMES FIRST, BEFORE THE KEY GATE. Taking a document back needs no
  // model and no key: a person who removed their key must still be able to
  // remove what a past read of theirs put in the record. Three effects, in the
  // order that keeps them coherent if the request dies partway: the entries
  // go, the receipt goes, and any read still sitting in the buffer is dropped
  // so it cannot land after the remove and refill the record.
  const removeForm = await context.request.formData();
  if (String(removeForm.get('intent') ?? '') === 'remove') {
    const removed = await deleteEntriesFrom(userId, 'resume');
    await clearResumeOnFile(userId);
    await clearParse(userId);
    console.log(`profile/import/parse: removed the resume for user ${userId}, with ${removed} entries.`);
    return wantsJson(context) ? jsonResponse({ status: 'ready', removed }) : redirectToProfile();
  }

  // The bring-your-own-key gate, enforced here and not only hidden in the UI:
  // a resume is read only with the person's own model. No key, no read. Same
  // gate the profile page uses to hide the upload form, restated on the server
  // so a direct POST cannot reach the deterministic reader either.
  const hasProviderKey = keyStorageIsConfigured() && isOn('byok') && (await keyMeta(userId)).length > 0;
  if (!hasProviderKey) {
    return completeWithMessage(context, userId, null, KEY_REQUIRED_MESSAGE);
  }

  // Already read above: a request body can only be consumed once.
  const form = removeForm;
  const file = form.get('file');
  const pastedField = form.get('pasted');
  const pasted = typeof pastedField === 'string' ? pastedField : '';

  // A file wins over a paste when both somehow arrive: the upload is the
  // deliberate action, the textarea the fallback.
  if (file instanceof File && file.size > 0) {
    const extraction = await extractResumeText(file);
    if (!extraction.ok) {
      return completeWithMessage(context, userId, file.name, extraction.message);
    }
    await startResumeParse(userId, file.name, extraction.text.slice(0, PARSE_TEXT_MAX_CHARS), 'resume');
    // The receipt, so the band has something to show and something to remove.
    // The name and the moment, never the file and never its text.
    await setResumeOnFile(userId, file.name);
    return started(context);
  }

  if (pasted.trim().length > 0) {
    await startResumeParse(userId, null, pasted.slice(0, PARSE_TEXT_MAX_CHARS), 'resume');
    // A pasted resume lands the same entries a file does, so it leaves the
    // same receipt and is as removable. Null name: there was no file.
    await setResumeOnFile(userId, null);
    return started(context);
  }

  return completeWithMessage(
    context,
    userId,
    null,
    'No file was chosen and no text was pasted. Add a resume and try again.'
  );
}
