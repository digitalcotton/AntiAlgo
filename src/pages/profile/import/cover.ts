/**
 * POST /profile/import/cover: store a cover letter on file, and propose the
 * facts it names into the Profile Record.
 *
 * TWO EFFECTS, ONE COVENANT. The letter is stored (db/025_cover_letter.sql) as
 * a writing-VOICE sample: at render time a drafted cover letter adapts the
 * person's own voice (renderCover's `voice` argument), never treating the
 * letter as a source of facts. Separately, the letter's own text is handed to
 * the SAME import-propose-confirm reader a resume upload uses (startResumeParse),
 * so a dated employer or role it names becomes a reviewable proposal into the
 * record. Only once a fact is a record entry can a rendered letter assert it.
 * The letter is the voice; the record is the truth. This is the mechanism
 * behind the owner's decision "propose it into the record first".
 *
 * WHY EXTRACT BEFORE ACCEPT. voice.ts's file acceptor refuses .pdf/.docx/.rtf
 * by design (it accepts only writing a person can see they pasted), so a file
 * upload is text-extracted here first (the same resume-extract.ts path the
 * resume import uses) and the extracted TEXT is passed to acceptPastedVoiceSample,
 * which enforces the 20000-character voice cap.
 *
 * NO KEY IS NEEDED TO STORE THE VOICE; A KEY IS NEEDED TO READ THE FACTS. The
 * letter is stored whether or not a provider key is on file, because voice
 * needs no model. Proposing its facts into the record runs the model reader, so
 * it happens only when a key is present, the same gate profile/import/parse.ts
 * enforces. With no key, the letter is on file and usable as voice; its facts
 * wait for a key.
 *
 * WHO THIS CAN ACT ON. userId comes only from Astro.locals.viewer, never the
 * body. Same '/profile' mounting and wall as every other record endpoint.
 */
import type { APIContext } from 'astro';
import { extractResumeText } from '../../../lib/resume-extract';
import { startResumeParse } from '../../../lib/resume-parse-runner';
import { acceptPastedVoiceSample } from '../../../lib/voice';
import { setCoverLetter, clearCoverLetter } from '../../../lib/record-store';
import { keyStorageIsConfigured } from '../../../lib/keychain';
import { keyMeta } from '../../../lib/keychain-store';
import { isOn } from '../../../lib/flags';
import { returnTo } from '../../../lib/return-to';
import { withBase } from '../../../../site.config.mjs';

export const prerender = false;

const PROFILE_PATH = '/profile';
const REVIEW_PATH = '/profile/review';

function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

function wantsJson(context: APIContext): boolean {
  return (context.request.headers?.get('accept') ?? '').includes('application/json');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A message the caller can act on: JSON in place for the fetch path, a
    redirect back to the profile band for a plain submit. */
function withMessage(context: APIContext, message: string): Response {
  return wantsJson(context) ? jsonResponse({ status: 'error', message }, 400) : redirectTo(PROFILE_PATH);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return wantsJson(context) ? jsonResponse({ status: 'signed-out' }, 401) : new Response('Not signed in.', { status: 401 });
  }
  const userId = viewer.userId;

  const form = await context.request.formData();

  // Remove clears all three columns; the band's own "Remove" posts this.
  if (String(form.get('intent') ?? '') === 'remove') {
    await clearCoverLetter(userId);
    return wantsJson(context) ? jsonResponse({ status: 'removed' }) : redirectTo(PROFILE_PATH);
  }

  const file = form.get('file');
  const pastedField = form.get('pasted');
  const pasted = typeof pastedField === 'string' ? pastedField : '';

  // The letter's text and the name to show on the on-file line: a file is
  // extracted (the upload is the deliberate action), a paste is used as typed.
  let text: string;
  let sourceName: string | null;
  if (file instanceof File && file.size > 0) {
    const extraction = await extractResumeText(file);
    if (!extraction.ok) return withMessage(context, extraction.message);
    text = extraction.text;
    sourceName = file.name;
  } else if (pasted.trim().length > 0) {
    text = pasted;
    sourceName = null;
  } else {
    return withMessage(context, 'No file was chosen and no text was pasted. Add a cover letter and try again.');
  }

  // The voice cap and the non-empty check, the one place a letter's text is
  // validated before it is stored as a voice sample.
  const accepted = acceptPastedVoiceSample({ text });
  if (!accepted.ok) return withMessage(context, accepted.message);

  await setCoverLetter(userId, accepted.sample.text, sourceName);

  // Propose the letter's own facts into the record, through the same reader a
  // resume upload uses, but only with a key (the reader runs a model). With no
  // key the letter is on file as voice and its facts wait; the band says so.
  const hasProviderKey = keyStorageIsConfigured() && isOn('byok') && (await keyMeta(userId)).length > 0;
  // A stored letter may go back to an allowed `return` (Come ready, /start,
  // which lands a finished read into the record on its next load); a refused
  // one always lands on the profile band above.
  if (hasProviderKey) {
    await startResumeParse(userId, sourceName, text);
    return wantsJson(context) ? jsonResponse({ status: 'started', parsing: true }) : redirectTo(returnTo(form, REVIEW_PATH));
  }

  return wantsJson(context) ? jsonResponse({ status: 'stored', parsing: false }) : redirectTo(returnTo(form, PROFILE_PATH));
}
