/**
 * POST /profile/import: the confirm half of MASTER-SPEC F2's import boost.
 * "Import boost: paste an existing resume, the engine PROPOSES entries, the
 * person confirms each (proposals are drafts, never auto-facts; you_told_us
 * requires the telling)."
 *
 * WHERE THE PARSE STEP IS NOW, AND THE ONE AMENDMENT IT MADE. The parse no
 * longer runs inline: reading a resume with the person's own provider key can
 * take many seconds, longer than a page render should hold a tab, so
 * profile/import/parse.ts runs it in the background and stores the result in a
 * single transient row (db/015_resume_parse.sql), and /profile/review renders
 * it. That is a deliberate amendment to this file's older promise that
 * proposals were never persisted between the two steps: they are now, as one
 * working buffer per person, replaced on the next upload and cleared here the
 * moment a person acts on it (clearParse below). The reason the buffer is safe
 * is the same reason the old cookie-free flow was: nothing in it is a fact
 * about the person until they confirm it here, and what they confirm is
 * re-validated from scratch below, exactly as if it had been typed by hand.
 * The buffer holds proposals, never the resume text, which was never stored.
 *
 * WHO WRITES WHAT. This endpoint creates entries (createEntry), adds the links
 * a person confirmed (addLink), and sets a name only when the profile had none
 * (setPersonName). Every one is re-checked here against the same validators the
 * hand-entry forms use; this file has no memory of, and extends no trust to,
 * which proposals the review screen actually showed.
 *
 * ONE INTENT, STRUCTURED THE WAY profile/entry.ts's THREE ARE. 'confirm' is
 * the only content-mutating action this file performs, and it is still
 * written as an intent switch with an "unrecognised intent" fallback,
 * matching profile/entry.ts's shape, because this file is a resource
 * endpoint in the same family (create Profile Record entries) and should
 * read like one, not like a special case.
 *
 * MOUNTED UNDER /profile, NOT /api, for the same forced reason export.ts,
 * delete.ts, profile/entry.ts and profile/artifact.ts are; see any of their
 * headers for the preview-deploy evidence.
 *
 * WHO THIS CAN ACT ON, AND HOW THE ROUND TRIP IS TRUSTED. userId comes
 * only from Astro.locals.viewer, resolved server-side, never the request
 * body. Every field this file reads back from the confirm form is treated
 * as untrusted exactly as if it had been typed into the add-entry form
 * from nothing: candidateInputFromFields() (src/lib/record-import.ts)
 * converts it, and validateEntry() (src/lib/record.ts) decides whether it
 * is an entry at all. A proposal a person edited before confirming, a
 * proposal a person never touched, and a request built by hand with no
 * paste behind it whatsoever, are read exactly the same way here: this
 * file has no memory of which proposals this browser was actually shown.
 */
import type { APIContext } from 'astro';
import { validateEntry } from '../../lib/record';
import { candidateInputFromFields, type ImportEntryFields } from '../../lib/record-import';
import { addLink, createEntry, personName, setPersonName } from '../../lib/record-store';
import { isLinkPlatform, normaliseLinkUrl } from '../../lib/profile-links';
import { clearParse } from '../../lib/resume-parse-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

/** This page's own address, base-free: a literal rather than
    routeFor('profile'), because redirect() below adds the base itself
    (via withBase()) and a doubled base is a broken redirect. */
const RECORD_PATH = '/profile';

/** The small summary this endpoint relays back to profile.astro: counts
    only, never the entries themselves. Nothing about a confirmed proposal
    needs to survive past the createEntry() call that already wrote it to
    the database; profile.astro's own listEntries() read shows the created
    entries as what they now are, ordinary Profile Record rows, not a
    special "just imported" state. */
const RELAY_COOKIE = 'record_import_relay';
const RELAY_COOKIE_PATH = '/profile';

export interface ImportRelayPayload {
  scope: 'import';
  /** Entries created. */
  created: number;
  /** Entries a person checked that no longer validated (an edit made invalid,
      or a tampered round trip), kept separate from the ones a person simply
      left unchecked: a declined proposal is not worth reporting, a failed one
      is, so the review copy can tell the person only about the second. */
  failed: number;
  /** Links added. */
  links: number;
  /** Whether the person's name was set from the parse (only when it was empty). */
  name: boolean;
  /** The prfIds this confirm actually created, in the order they were created,
      so the record on /profile can mark exactly those rows as new. Ids, not
      entries: the cookie carries what the page needs to point at a row it is
      about to render anyway, never the row's contents. */
  createdIds: string[];
}

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

function setRelayCookie(context: APIContext, payload: ImportRelayPayload): void {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    path: withBase(RELAY_COOKIE_PATH),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
}

/** Every raw field one proposal's form group can submit, named
    `entry-{index}-{field}` by profile.astro's review screen. Reads a
    string as '' rather than undefined for a field the form did not send,
    matching FormData.get()'s own "missing means null" so
    candidateInputFromFields() sees the same shape whichever produced it. */
function fieldsForIndex(form: FormData, index: number): ImportEntryFields {
  const get = (name: string): string => {
    const value = form.get(`entry-${index}-${name}`);
    return typeof value === 'string' ? value : '';
  };
  return {
    kind: get('kind'),
    employerOrInstitution: get('employerOrInstitution'),
    officialTitle: get('officialTitle'),
    startYear: get('startYear'),
    startMonth: get('startMonth'),
    stillHere: get('stillHere'),
    endYear: get('endYear'),
    endMonth: get('endMonth'),
    location: get('location'),
    description: get('description'),
    classification: get('classification')
  };
}

/** An upper bound on how many proposal groups this endpoint will ever
    read out of `proposalCount`, independent of whatever number the
    request claims. A pasted resume producing this many role blocks in one
    paste is not a real case this feature serves; a request lying about
    the count to make this file loop further than the form it was sent
    from ever could, is exactly the kind of untrusted-input case this
    file's own header says every field gets treated as. */
const MAX_PROPOSALS_PER_CONFIRM = 200;

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const userId = viewer.userId;
  const form = await context.request.formData();
  const intent = form.get('intent');

  if (intent === 'confirm') {
    const rawCount = Number(form.get('proposalCount'));
    const count = Number.isInteger(rawCount) ? Math.min(Math.max(rawCount, 0), MAX_PROPOSALS_PER_CONFIRM) : 0;

    let failed = 0;
    const createdIds: string[] = [];

    for (let i = 0; i < count; i++) {
      const confirmed = form.get(`entry-${i}-confirm`) === 'on';
      if (!confirmed) {
        // Not opted in. This proposal is not re-validated, and nothing about
        // it is inspected further: an unchecked box is a person declining, not
        // an error to report on, so it is not counted at all.
        continue;
      }

      const fields = fieldsForIndex(form, i);
      const input = candidateInputFromFields(fields);
      const result = validateEntry(input);

      if (!result.ok) {
        // A checked proposal that no longer validates (an edit made it invalid,
        // or the round trip itself was tampered with) is not created. Counted
        // as failed, separately from a declined one, so the review copy can
        // tell the person the specific thing that went wrong.
        failed++;
        continue;
      }

      const stored = await createEntry(userId, result.entry);
      createdIds.push(stored.prfId);
    }
    const created = createdIds.length;

    // Links found in the resume, confirmed the same untrusted-round-trip way:
    // the platform and url are read back from the form, re-checked against
    // isLinkPlatform() and normaliseLinkUrl() (which refuses any scheme but
    // http and https), never trusted because the parse once approved them.
    const rawLinkCount = Number(form.get('linkCount'));
    const linkCount = Number.isInteger(rawLinkCount) ? Math.min(Math.max(rawLinkCount, 0), MAX_PROPOSALS_PER_CONFIRM) : 0;
    let links = 0;
    for (let i = 0; i < linkCount; i++) {
      if (form.get(`link-${i}-confirm`) !== 'on') continue;
      const platform = form.get(`link-${i}-platform`);
      const rawUrl = form.get(`link-${i}-url`);
      if (!isLinkPlatform(platform) || typeof rawUrl !== 'string') continue;
      const normalised = normaliseLinkUrl(rawUrl);
      if (!normalised.ok) continue;
      await addLink(userId, platform, normalised.url);
      links++;
    }

    // The name, set ONLY when the profile has none: an upload fills an empty
    // identity but never silently overwrites a name the person chose. Re-checked
    // server-side, not trusted to the form's nameProposed hint, which could be
    // stale. Stored exactly as read (RUN-FINISH 2.1: never alter a name).
    let name = false;
    if (form.get('nameConfirm') === 'on') {
      const first = typeof form.get('nameFirst') === 'string' ? String(form.get('nameFirst')) : '';
      const last = typeof form.get('nameLast') === 'string' ? String(form.get('nameLast')) : '';
      const current = await personName(userId);
      const alreadyNamed = current !== null && (current.firstName.trim().length > 0 || current.lastName.trim().length > 0);
      if (!alreadyNamed && (first.trim().length > 0 || last.trim().length > 0)) {
        await setPersonName(userId, first, last);
        name = true;
      }
    }

    // The working buffer has done its job: the person acted on the proposals,
    // so clear the parse row rather than leave a stale one to reopen. Best
    // effort; a failure here does not undo the entries just created.
    await clearParse(userId).catch(() => {});

    setRelayCookie(context, { scope: 'import', created, failed, links, name, createdIds });
    return redirect(RECORD_PATH);
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
