/**
 * POST /desk/application: every write the Desk's tracker makes, for the
 * signed-in caller's own applications. MASTER-SPEC 3.5, F4; STM-0002.
 *
 * ONE FILE, MANY INTENTS, THE SAME one-file-per-resource SHAPE
 * src/pages/account/record/entry.ts already uses: every intent below acts
 * on the same resource (one desk_application row) and needs the same
 * preamble first (refuse a null viewer, never accept a userId from the
 * request, look the row up scoped to that userId before touching it).
 *
 * MOUNTED UNDER /desk, NOT /api, FOR THE SAME FORCED REASON
 * src/pages/account/record/entry.ts is not under /api/account. See
 * src/pages/auth/[...all].ts's header for the verified evidence. Do not
 * move this under /api.
 *
 * THIS FILE IS WHERE CLICK IS NOT APPLIED IS ACTUALLY ENFORCED, END TO END.
 * src/lib/desk.ts's transition() refuses a move to 'applied' unless it is
 * handed a PersonConfirmation built by recordPersonConfirmation(), and
 * src/lib/desk-store.ts's transitionApplication() trusts whatever `to` this
 * file already decided. The chain only holds if THIS FILE only ever calls
 * recordPersonConfirmation('applied', ...) from the one branch below where a
 * real person just POSTed answer=applied to the confirm loop (the 'confirm'
 * intent), never from a default, never from another intent's fallthrough.
 * That branch is this codebase's review point for "could this silently
 * auto-apply": read it, and nowhere else, to answer that question.
 *
 * VALIDATION FAILURE. Every intent below either performs its write or does
 * nothing at all; there is no partial write. A caller that POSTs an illegal
 * STM-0002 edge (an id in the wrong state, a tampered `to`) gets a redirect
 * back to the Desk with nothing changed, the same "no id, no page" silence
 * updateEntry() in record-store.ts already answers with for a mismatched
 * owner: the Desk's own UI never generates a form for an illegal edge, so
 * this is the adversarial-input path, not the everyday one, and it does not
 * need a relay-cookie error round trip to be honest.
 *
 * THE 'then' FIELD, ADDED FOR THE ROLE PAGE'S MERGED PRIMARY BUTTON
 * (src/pages/role/[slug].astro, this same task). ADDITIVE ONLY: an
 * optional field on the existing 'click' intent, never a new intent and
 * never a change to what 'click' already does to the database. Every
 * existing caller (src/pages/desk.astro's own manual "paste a URL" click
 * form) sends no `then` field and keeps landing on the Desk exactly as
 * before; see the click branch below. The role page's own primary form and
 * its quiet "Apply without drafting" secondary both send `then=posting`,
 * so a no-JS submission of either (the only path that ever reaches this
 * field today: the role page's own script reads the JSON response below
 * instead, for every reader whose browser gets that far) both opens a
 * listing and tracks it, then lands the same tab on the posting itself,
 * not on the Desk: see redirectToUrl()'s own comment for why that is a
 * different function from redirect() above rather than a second argument
 * to it.
 *
 * THE BACKGROUND GENERATION TRIGGER, SAME ADDITION, NOW AWAITED FOR ITS
 * DECISION. src/lib/generation-preference-store.ts's
 * triggerBackgroundGeneration(userId, applicationId, job) is gated on four
 * things (this account's own opt-in among them; see that file's header) and
 * fails safe on every one of them, so calling it here for every click
 * against a verified posting, unless the caller explicitly asked to skip
 * drafting, cannot make a click do anything this file's own "click is not
 * applied" guarantee above would need to answer for: it never writes to
 * desk_application, never touches ApplicationState, and never runs at all
 * for the common case (no key, no opt-in, KEY_ENCRYPTION_SECRET unset) this
 * task could actually verify. It IS awaited now, unlike the first cut of
 * this file: that function "returns the decision quickly and backgrounds
 * the heavy work" (its own header), so awaiting it here costs this branch
 * one fast round trip, not the render itself, and buys the JSON response
 * below an honest answer to "did drafting start" instead of a guess made
 * before the decision was even computed.
 *
 * THE JSON RESPONSE, FOR THE ROLE PAGE'S ENHANCED PRIMARY. A request that
 * sends `Accept: application/json` (src/pages/role/[slug].astro's merged
 * primary form, POSTed by its own script rather than submitted natively)
 * gets `{ applicationId, drafting: 'started' | 'skipped', draftUrl }`
 * instead of a redirect: draftUrl is always deskDraftPath(created.id),
 * present even when drafting was skipped, because the Desk's own row for
 * this application is always a legitimate place to land, drafted or not.
 * `drafting` is 'started' only when the trigger above actually ran and
 * decided `.go === true`; every other case (no job, `draft=skip`, the
 * trigger declining) answers 'skipped'. This negotiation runs BEFORE the
 * `then=posting` check below, so a JSON caller never receives a redirect at
 * all; a caller that sends no Accept header, or one that does not ask for
 * JSON (every native form submit, `then` or not) falls through to the
 * existing redirect behaviour unchanged.
 */
import type { APIContext } from 'astro';
import {
  getApplication,
  archiveApplication,
  createApplicationFromClick,
  setOfferedComp,
  transitionApplication,
  unarchiveApplication
} from '../../lib/desk-store';
import {
  ABANDON_REASONS,
  CLOSED_REASONS,
  recordPersonConfirmation,
  transition,
  type AbandonReason,
  type ApplicationState,
  type ClosedReason
} from '../../lib/desk';
import { triggerBackgroundGeneration } from '../../lib/generation-preference-store';
import { loadJobs } from '../../lib/data';
import { deskDraftPath } from '../../data/nav';
import { addedSlugFor } from '../../lib/added-posting';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const DESK_PATH = '/desk';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

/** Same shape as redirect() above, but for an absolute external URL (a
    job posting) rather than a path this site owns. withBase() prefixes
    BASE_PATH ('/jobs') onto whatever it is given, which is correct for a
    path like '/desk' and wrong for a posting's own URL: prefixing '/jobs'
    onto 'https://boards.example.com/...' would produce a broken Location
    header, not a working redirect. Used only by the click intent's
    `then=posting` branch below, and only after isHttpUrl() has already
    confirmed the value is a real http(s) URL, not a path, a
    javascript:/data: URI, or anything else Response's own Headers
    implementation might otherwise be asked to carry. */
function redirectToUrl(url: string): Response {
  return new Response(null, { status: 303, headers: { Location: url } });
}

/** Whether `value` parses as an absolute http, https, or mailto URL: the
    three schemes applyLabel()/ApplyAction.astro already treat as legal
    posting destinations (src/lib/data.ts's applyLabel() special-cases a
    'mailto:' apply_url by name, for the founder-post source system).
    Guards redirectToUrl() above: this file already accepts `url` as
    free-typed caller input for the click intent's own snapshot (see
    jobForUrl() and the click branch below), and that is fine for a value
    that only ever becomes a desk_application column; the moment a value
    from the same form field is about to become a Location header instead,
    it is worth one extra check that it is the kind of thing a Location
    header should ever carry. */
function isRedirectableJobUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** Whether the caller wants the click branch's JSON answer instead of a
    redirect: src/pages/role/[slug].astro's enhanced primary form sends this
    header on its background POST (see that page's own script), and no
    existing caller does (src/pages/desk.astro's manual click form is a
    plain native submit, and every no-JS fallback of the role page's own
    form is too), so every redirect-returning caller keeps redirecting. See
    this file's header, "THE JSON RESPONSE". */
function wantsJson(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').includes('application/json');
}

/** Where the redirect lands. The Desk, in the view the form came from; or,
    when the form says returnTo=posting, the posting's own page for a posting
    the person added by link (/board/added-<id>). That path is BUILT from the
    posted application id, never read from the form, so this can never become
    an open redirect: the only place it can send anyone is a page this site
    owns for the very card the intent just acted on. */
function backTo(form: FormData): string {
  if (form.get('returnTo') === 'posting') {
    const id = applicationId(form);
    if (id !== null) return `/board/${addedSlugFor(id)}`;
  }
  const view = form.get('view');
  return view === 'table' ? `${DESK_PATH}?view=table` : DESK_PATH;
}

function isAbandonReason(value: unknown): value is AbandonReason {
  return typeof value === 'string' && (ABANDON_REASONS as readonly string[]).includes(value);
}

function isClosedReason(value: unknown): value is ClosedReason {
  return typeof value === 'string' && (CLOSED_REASONS as readonly string[]).includes(value);
}

function applicationId(form: FormData): number | null {
  const raw = form.get('applicationId');
  const id = Number(raw);
  return typeof raw === 'string' && raw !== '' && Number.isInteger(id) ? id : null;
}

/** The same URL-to-verified-posting match src/pages/desk/save.ts's own
    jobForUrl() makes, for the click intent below. See that file's header
    for why this is its own small function on each side rather than one
    shared module. */
function jobForUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  return loadJobs().find((job) => job.apply_url === trimmed || job.source_url === trimmed) ?? null;
}

/** Strips markup down to plain text, generously: this is a person's own
    snapshot of a description we already hold as description_html, not a
    rendering of someone else's page, so a loose tag-strip is enough. No
    network fetch happens anywhere in this file: an external URL's
    description is never captured, because this codebase does not fetch
    other people's pages. */
function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
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
  const target = backTo(form);
  const now = new Date();

  /* -----------------------------------------------------------------------
     click: MASTER-SPEC F4.2's universal capture. Writes 'clicked' and
     nothing else; see createApplicationFromClick()'s own header for why no
     argument here can spell any other state.
     ----------------------------------------------------------------------- */
  if (intent === 'click') {
    const url = String(form.get('url') ?? '').trim().slice(0, 2000);
    if (!url) {
      return redirect(target);
    }
    const job = jobForUrl(url);
    const titleOverride = String(form.get('titleOverride') ?? '').trim().slice(0, 500);
    const companyOverride = String(form.get('companyOverride') ?? '').trim().slice(0, 500);
    const draftRequested = form.get('draft') !== 'skip';

    const created = await createApplicationFromClick(userId, {
      jobId: job ? job.id : null,
      externalUrl: job ? null : url,
      snapshotTitle: job ? job.title : titleOverride || null,
      snapshotCompany: job ? job.company : companyOverride || null,
      snapshotDescription: job ? plainText(job.description_html) : null,
      clickedAt: now
    });

    // Awaited, for the decision only: see this file's header, "THE
    // BACKGROUND GENERATION TRIGGER", and generation-preference-store.ts's
    // own header for the full gating and why awaiting it here does not
    // await the render itself. Only for a verified posting: there is no
    // Job to build a tailor.ts Target from for an external, unmatched URL,
    // and this file does not invent a free-text target from a pasted URL
    // string. Skipped entirely, no call at all, when the caller explicitly
    // asked not to draft (draft=skip: the role page's own "Apply without
    // drafting" secondary, this same task).
    const outcome =
      draftRequested && job
        ? await triggerBackgroundGeneration(userId, created.id, job).catch((error) => {
            console.error(`desk/application: background generation trigger rejected for user ${userId}.`, error);
            return null;
          })
        : null;
    const started = draftRequested && outcome?.go === true;

    // JSON negotiation runs before the redirect logic below: see this
    // file's header, "THE JSON RESPONSE". Every redirect-returning caller
    // (no Accept: application/json) falls through untouched.
    if (wantsJson(context.request)) {
      return Response.json({
        applicationId: created.id,
        drafting: started ? 'started' : 'skipped',
        draftUrl: deskDraftPath(String(created.id))
      });
    }

    // then=posting: the role page's merged primary form's own no-JS
    // fallback asks to be sent straight to the posting it just recorded a
    // click for, rather than to the Desk. See this file's header, "THE
    // 'then' FIELD". Absent, or any value but 'posting', is every existing
    // caller (src/pages/desk.astro's own manual click form included) and
    // keeps today's exact behaviour.
    if (form.get('then') === 'posting' && isRedirectableJobUrl(url)) {
      return redirectToUrl(url);
    }
    return redirect(target);
  }

  // Every intent below acts on one existing application this person owns.
  // Scoped to userId, same as every desk-store.ts read/write: an id copied
  // from someone else's page matches nothing.
  const id = applicationId(form);
  if (id === null) {
    return redirect(target);
  }
  const current = await getApplication(userId, id);
  if (!current) {
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     confirm: the confirm loop's own two direct answers (F4.1). 'applied'
     is the one branch in this whole codebase that may call
     recordPersonConfirmation() with answer 'applied'; see this file's own
     header.
     ----------------------------------------------------------------------- */
  if (intent === 'confirm') {
    const answer = form.get('answer');
    const to: ApplicationState = answer === 'applied' ? 'applied' : 'still_working';
    const result = transition({
      from: current.state,
      to,
      confirmation: to === 'applied' ? recordPersonConfirmation('applied', now) : undefined
    });
    if (result.ok) {
      await transitionApplication(userId, id, { to: result.state, confirmedAt: now });
    }
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     abandon: the confirm loop's third answer, "didn't finish", resolved
     straight to a reason rather than a two-page round trip: the Desk's UI
     renders the six F4.1 reason chips inline as soon as "didn't finish" is
     opened, so this one POST both answers the confirm loop (confirmedAt)
     and records why in a single write.
     ----------------------------------------------------------------------- */
  if (intent === 'abandon') {
    const reason = form.get('reason');
    if (!isAbandonReason(reason)) {
      return redirect(target);
    }
    const result = transition({ from: current.state, to: 'abandoned', abandonReason: reason });
    if (result.ok) {
      await transitionApplication(userId, id, { to: result.state, abandonReason: reason, confirmedAt: now });
    }
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     transition: the plain STM-0002 forward moves that carry no reason
     (applied -> interviewing, interviewing -> offer), plus F4.1's
     user-defined interview sub-stage text.
     ----------------------------------------------------------------------- */
  if (intent === 'transition') {
    const to = form.get('to');
    if (to !== 'interviewing' && to !== 'offer') {
      return redirect(target);
    }
    const result = transition({ from: current.state, to });
    if (result.ok) {
      const substage = String(form.get('interviewSubstage') ?? '').trim().slice(0, 200);
      await transitionApplication(userId, id, {
        to: result.state,
        interviewSubstage: substage || null
      });
    }
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     close: MASTER-SPEC 3.5's five closed reasons. Closed-state copy is
     written humanely wherever it renders (src/pages/desk.astro); this
     endpoint only records the fact.
     ----------------------------------------------------------------------- */
  if (intent === 'close') {
    const reason = form.get('reason');
    if (!isClosedReason(reason)) {
      return redirect(target);
    }
    const result = transition({ from: current.state, to: 'closed', closedReason: reason });
    if (result.ok) {
      await transitionApplication(userId, id, { to: result.state, closedReason: reason });
    }
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     comp: MASTER-SPEC 3.5's posted-vs-offered comparison. Not gated by
     state: an offer figure can be worth recording even on a since-closed
     row (an accepted offer is exactly the case where this number matters
     most), so this intent is available regardless of `current.state`.
     ----------------------------------------------------------------------- */
  if (intent === 'comp') {
    const offeredComp = String(form.get('offeredComp') ?? '').trim().slice(0, 200);
    await setOfferedComp(userId, id, offeredComp || null);
    return redirect(target);
  }

  /* -----------------------------------------------------------------------
     archive / unarchive: F4.1's reversible self-archive, and its manual
     counterpart. Available on any application in any state, same as comp
     above: a person may archive a card they consider done regardless of
     whether STM-0002 calls it terminal.
     ----------------------------------------------------------------------- */
  if (intent === 'archive') {
    await archiveApplication(userId, id, now);
    return redirect(target);
  }

  if (intent === 'unarchive') {
    await unarchiveApplication(userId, id);
    return redirect(target);
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
