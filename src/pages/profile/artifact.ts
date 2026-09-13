/**
 * POST /profile/artifact: add or remove one piece of evidence on a Profile
 * Record entry. MASTER-SPEC F2. See profile/entry.ts's own header for why
 * this is a second file rather than a third case there: an artifact is a
 * different resource, with different fields, from an entry.
 *
 * MOUNTED UNDER /profile, NOT /api, for the same forced reason export.ts,
 * delete.ts and profile/entry.ts are; see any of their headers for the
 * preview-deploy evidence.
 *
 * WHO THIS CAN ACT ON. Same rule as profile/entry.ts: userId comes only
 * from Astro.locals.viewer, never the request body, and every
 * record-store.ts call is scoped to it.
 *
 * VALIDATING AN ARTIFACT WITHOUT REIMPLEMENTING record.ts's RULES. The
 * only exported validator in src/lib/record.ts is validateEntry(), which
 * checks a whole entry, artifacts array included; there is no exported
 * validateArtifact() this route could call on its own; adding one would
 * mean editing record.ts, which this task's file list does not permit.
 * Reimplementing the same kind/url/label checks here by hand would create
 * a second copy of rules record.ts already owns, free to drift the day
 * CEILINGS or ARTIFACT_KINDS changes and this file is not updated to
 * match. Instead, `add` reads the entry's own current, already-valid
 * fields (via getEntry()), appends the candidate artifact to its existing
 * artifacts, and hands the WHOLE thing to validateEntry(): the same
 * function, the same rules, no duplicate. Only the issues whose field path
 * points at the newly appended artifact are kept; the entry's own fields
 * cannot fail (they are already valid, read straight from the database),
 * so nothing from them leaks into what this route reports.
 */
import type { APIContext } from 'astro';
import { validateEntry } from '../../lib/record';
import { addArtifact, getEntry, removeArtifact } from '../../lib/record-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;


/**
 * WHERE THIS ROUTE MAY SEND A READER BACK TO, AS A CLOSED LIST.
 *
 * One page renders the Profile Record with these forms on it, /profile,
 * ever since the structured editor that used to live at /account/record
 * merged into it. This map is a closed set of one rather than a bare
 * literal for the same reason it was a closed set of two before that
 * merge; see profile/entry.ts's own RETURN_PATHS for the full reasoning
 * (a key, never a path, because a path is an open redirect).
 */
const RETURN_PATHS = {
  profile: '/profile'
} as const;

type ReturnKey = keyof typeof RETURN_PATHS;

function returnKeyFrom(_form: FormData): ReturnKey {
  return 'profile';
}


const RELAY_COOKIE = 'record_form_relay';

interface RelayPayload {
  scope: 'artifact';
  intent: 'add';
  prfId: string;
  fields: Record<string, string>;
  issues: { field: string; message: string }[];
}

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

function setRelayCookie(context: APIContext, payload: RelayPayload, returnPath: string): void {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    // Scoped to the page that will read it. See profile/entry.ts's own
    // setRelayCookie for the same note.
    path: withBase(returnPath),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const userId = viewer.userId;
  const form = await context.request.formData();
  const intent = form.get('intent');
  const prfId = String(form.get('prfId') ?? '');
  // Where this request came from. See RETURN_PATHS above.
  const backTo = RETURN_PATHS[returnKeyFrom(form)];

  // Back to the entry being edited, landed on its Artifacts block rather than
  // the top of the page. Adding or removing an artifact is a full-page POST in
  // a no-JS form, so the redirect carries a fragment matching the id EntryCard
  // puts on `.record-artifacts` (`artifacts-<prfId>`), and the browser scrolls
  // the reader back to where the button they pressed was. prfId is a bare
  // slug (letters, digits, hyphens), so it is its own fragment unescaped.
  const backToArtifacts = (id: string) => `${backTo}?edit=${encodeURIComponent(id)}#artifacts-${id}`;

  if (intent === 'remove') {
    const artifactId = Number(form.get('artifactId'));
    if (Number.isInteger(artifactId)) {
      await removeArtifact(userId, artifactId);
    }
    return redirect(prfId ? backToArtifacts(prfId) : backTo);
  }

  if (intent === 'add') {
    const fields: Record<string, string> = {
      kind: String(form.get('kind') ?? ''),
      url: String(form.get('url') ?? ''),
      label: String(form.get('label') ?? '')
    };

    const existing = await getEntry(userId, prfId);
    if (!existing) {
      // Not this person's entry, or it no longer exists. Nothing to
      // attach evidence to; back to the editor with no error to relay,
      // same as profile/entry.ts's own "not found" branches.
      return redirect(backTo);
    }

    const candidateArtifacts = [
      ...existing.artifacts.map((a) => ({ kind: a.kind, url: a.url, label: a.label })),
      { kind: fields.kind, url: fields.url, label: fields.label.trim() || null }
    ];

    const result = validateEntry({
      kind: existing.kind,
      employerOrInstitution: existing.employerOrInstitution,
      officialTitle: existing.officialTitle,
      start: existing.start,
      end: existing.end,
      location: existing.location,
      description: existing.description,
      classification: existing.classification,
      artifacts: candidateArtifacts
    });

    if (!result.ok) {
      const newIndex = existing.artifacts.length;
      const issues = result.issues.filter((issue) => issue.field.startsWith(`artifacts.${newIndex}.`));
      if (issues.length === 0) {
        // The entry's own fields somehow failed validation even though
        // they were just read back from the database as already-valid.
        // That can only mean the row predates a rule this file does not
        // know about. Fail closed rather than force an unvalidated
        // artifact into the database: log it, and send the person back to
        // an unchanged editor rather than pretend this succeeded.
        console.error(
          `profile/artifact.ts: entry ${prfId} for user ${userId} failed validateEntry() on its own ` +
            `existing fields, unrelated to the artifact being added. Refusing to add.`,
          result.issues
        );
        return redirect(`${backTo}?edit=${encodeURIComponent(prfId)}`);
      }
      setRelayCookie(context, { scope: 'artifact', intent: 'add', prfId, fields, issues }, backTo);
      return redirect(backToArtifacts(prfId));
    }

    const newArtifact = result.entry.artifacts[result.entry.artifacts.length - 1];
    await addArtifact(userId, prfId, newArtifact);
    return redirect(backToArtifacts(prfId));
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
