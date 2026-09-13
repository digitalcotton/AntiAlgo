/**
 * POST /profile/entry: create, update or delete one entry in the signed-in
 * caller's Profile Record. MASTER-SPEC F2.
 *
 * ONE FILE, THREE ACTIONS, SWITCHED ON AN `intent` FORM FIELD, RATHER THAN
 * THREE FILES. All three verbs act on the same resource (one record_entry
 * row) and need the same three things first: refuse a null viewer, refuse
 * before touching the database, and never accept a userId from the
 * request. Three files would triplicate that preamble for comparatively
 * little gained, where Better Auth's own catch-all (src/pages/auth/
 * [...all].ts) already establishes "one handler, many verbs, dispatched on
 * a field the request itself carries" as an idiom this codebase is
 * comfortable with. Artifacts (profile/artifact.ts) get a second, separate
 * file rather than a fourth case here because an artifact is a different
 * resource with different fields (kind, url, label, not employer, title,
 * dates), and folding both resources' validation into one switch would
 * need two unrelated shapes living in one function.
 *
 * MOUNTED UNDER /profile, NOT /api, FOR THE SAME FORCED REASON export.ts
 * AND delete.ts ARE. See either of those files' own header for the
 * preview-deploy evidence: this repo's root api/ directory claims every
 * /api/* path before Astro's router runs, and vercel.json's /jobs rewrite
 * would otherwise land a request here as /api/profile/entry. Do not move
 * this back under /api.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body, and the body
 * is never trusted for whose account this is: userId comes only from
 * Astro.locals.viewer, resolved server-side from the session before this
 * file runs (this route is gated by its own '/profile' prefix in
 * src/lib/entitlement.ts). Every record-store.ts call below is scoped to
 * that userId, so a prfId typed from someone else's edit link matches
 * nothing rather than reading or changing their entry.
 *
 * VALIDATION FAILURE, AND HOW IT GETS BACK TO THE PAGE WITH THE ISSUES
 * ATTACHED. This route answers every request with a redirect (native form
 * posts do not read a JSON body back), and a 303 carries no payload of its
 * own. sign-up.astro already sets a short-lived, httpOnly cookie to carry
 * one value (signup_source) across exactly this kind of redirect; this
 * route does the same for a bigger payload: what was submitted and what
 * was wrong with it, as one JSON blob, read once by profile.astro and
 * cleared immediately after so a page refresh does not replay stale
 * errors. See profile.astro's own header for the reader side of this
 * relay.
 */
import type { APIContext } from 'astro';
import { validateEntry } from '../../lib/record';
import { createEntry, deleteEntry, updateEntry } from '../../lib/record-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;



/**
 * WHERE THIS ROUTE MAY SEND A READER BACK TO, AS A CLOSED LIST.
 *
 * One page renders the Profile Record with these forms on it, /profile,
 * ever since the structured editor that used to live at /account/record
 * merged into it. This map is a closed set of one rather than a bare
 * literal for the same reason it was a closed set of two before that
 * merge: the form submits `return=profile` and this map turns that into an
 * address, rather than the request naming its own redirect target.
 *
 * A KEY, NEVER A PATH. It would have been shorter to post the path itself
 * and redirect to it, and that is an open redirect: a form field is
 * attacker-supplied input, `Location:` is the one header that acts on it,
 * and "it is our own form" is not a property of the request, it is an
 * assumption about the request. An unrecognised value is not an error
 * worth showing anybody; it falls back to the one destination this map
 * has.
 */
const RETURN_PATHS = {
  profile: '/profile'
} as const;

type ReturnKey = keyof typeof RETURN_PATHS;

function returnKeyFrom(_form: FormData): ReturnKey {
  return 'profile';
}


/** The cookie that relays a failed submission's fields and issues back to
    whichever page posted. Path-scoped by setRelayCookie() to that page, and
    short-lived: its only job is to survive one redirect. */
const RELAY_COOKIE = 'record_form_relay';

interface RelayPayload {
  scope: 'entry';
  intent: 'create' | 'update';
  /** null for a failed create; the entry being edited for a failed update. */
  prfId: string | null;
  fields: Record<string, string>;
  issues: { field: string; message: string }[];
}

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

function setRelayCookie(context: APIContext, payload: RelayPayload, returnPath: string): void {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    // Scoped to the one page that will read it, WITH the site base path: the
    // redirect below goes to withBase(returnPath) (/jobs/profile), so a cookie
    // scoped to the base-free /profile is never sent back and the relay never
    // arrives. This was the bug that hid every validation error.
    path: withBase(returnPath),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
}

/** Every raw field this form can submit, read once as plain strings.
    Nothing here is trusted; it is handed straight to validateEntry(),
    which is the one place untrusted input becomes a NewEntryInput or a
    list of what is wrong with it. */
function fieldsFromForm(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of [
    'kind',
    'employerOrInstitution',
    'officialTitle',
    'startYear',
    'startMonth',
    'stillHere',
    'endYear',
    'endMonth',
    'location',
    'description',
    'classification'
  ]) {
    const value = form.get(name);
    if (typeof value === 'string') fields[name] = value;
  }
  return fields;
}

/** Turns the raw field strings into the object shape validateEntry()
    reads. An empty year field becomes undefined, not 0 or NaN, so
    validateEntry() reports "must be a whole number" rather than a
    ceiling failure on a value nobody typed. */
function buildValidationInput(fields: Record<string, string>): unknown {
  const stillHere = fields.stillHere === 'on';
  const year = (raw: string | undefined): number | undefined => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  };
  const month = (raw: string | undefined): number | null => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  };

  return {
    kind: fields.kind,
    // NOT TRIMMED, AND THAT IS THE POINT. This read `?.trim() || null`, copied
    // from the `location` line below it, while officialTitle beside it was left
    // alone. Gate 8 caught it. employerOrInstitution is immutable core: it is
    // stored and rendered exactly as the person typed it, and stray whitespace
    // comes back from validateEntry() as an issue they are shown rather than as
    // an edit nobody told them about.
    employerOrInstitution: fields.employerOrInstitution || null,
    officialTitle: fields.officialTitle,
    start: { year: year(fields.startYear), month: month(fields.startMonth) },
    end: stillHere ? null : { year: year(fields.endYear), month: month(fields.endMonth) },
    location: fields.location?.trim() || null,
    description: fields.description ?? '',
    classification: fields.classification,
    artifacts: []
  };
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
  // Where this request came from, and so where it goes back to. See
  // RETURN_PATHS above for why this is a key and never a path.
  const backTo = RETURN_PATHS[returnKeyFrom(form)];

  if (intent === 'delete') {
    const prfId = String(form.get('prfId') ?? '');
    if (prfId) {
      await deleteEntry(userId, prfId);
    }
    return redirect(backTo);
  }

  if (intent === 'create' || intent === 'update') {
    const fields = fieldsFromForm(form);
    const input = buildValidationInput(fields);
    const result = validateEntry(input);

    if (!result.ok) {
      const prfId = intent === 'update' ? String(form.get('prfId') ?? '') : null;
      setRelayCookie(context, { scope: 'entry', intent, prfId, fields, issues: result.issues }, backTo);
      const target = prfId ? `${backTo}?edit=${encodeURIComponent(prfId)}` : `${backTo}?edit=new`;
      return redirect(target);
    }

    if (intent === 'create') {
      await createEntry(userId, result.entry);
      return redirect(backTo);
    }

    // intent === 'update'. artifacts is dropped: this endpoint only ever
    // changes an entry's core fields, never its artifacts (see
    // record-store.ts's own EntryCoreInput and profile/artifact.ts for why
    // those are a separate resource with their own two actions).
    const prfId = String(form.get('prfId') ?? '');
    const { artifacts: _artifacts, ...coreInput } = result.entry;
    // Not found, or not this person's entry, both redirect the same way as
    // a successful update: the editor simply no longer shows a form for an
    // id that does not resolve, rather than this route describing why not.
    await updateEntry(userId, prfId, coreInput);
    return redirect(backTo);
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
