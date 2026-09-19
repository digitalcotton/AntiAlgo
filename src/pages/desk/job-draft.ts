/**
 * POST /desk/job-draft: the one-click draft button's begin endpoint
 * (RUN-DRAFT.md phase 3). A signed-in person on a verified job detail page
 * presses one button and gets a resume and cover letter drafted for that
 * posting. This route starts that draft and sends them to the result page.
 *
 * DRAFTING TRACKS THE JOB, BUT NEVER MARKS IT APPLIED. Pressing the button
 * writes the two generated_render rows (db/022_job_draft.sql,
 * src/lib/generated-render-store.ts's beginJobDraft) AND, once, a
 * desk_application in the 'clicked' state (createApplicationFromClick), so the
 * job the person just invested in shows up on their Desk board instead of
 * vanishing. It is deduped on the active card (getActiveApplicationForJob), so
 * "Draft again", a per-document retry, and a job already further along the
 * board never spawn a second card or reset a state. It creates 'clicked' and
 * only 'clicked': reaching 'applied' still requires the confirm loop's branded
 * PersonConfirmation (src/lib/desk.ts), so "a click is not an application"
 * holds. Tracking is best-effort: a failure to write the card is logged and
 * the draft proceeds. The apply flow's own generate-on-apply behaviour
 * (src/pages/desk/application.ts) is untouched.
 *
 * IT ALWAYS DRAFTS. Unlike the apply path, this does not gate on a provider
 * key: src/lib/generation-preference-store.ts's triggerJobDraft() renders
 * deterministically when no key is on file, labelled as a fallback, so the
 * result page always has something to show.
 *
 * MOUNTED UNDER /desk, NOT /api, for the same forced reason desk/save.ts gives:
 * the root api/ directory claims every /api/* path before Astro's router runs.
 * The '/desk' prefix also means entitlement.ts's one '/desk' policy covers it,
 * so a signed-in non-member is walled by middleware before this file runs; a
 * signed-out request falls through to here, and is sent to sign-in below.
 *
 * WHO THIS CAN ACT ON. No id anywhere but the POSTed slug, resolved against
 * src/lib/draft-job.ts's draftableJobBySlug(), which knows both job
 * populations: the verified design set and the tracked board. userId comes only
 * from Astro.locals.viewer, resolved server-side by middleware.
 */
import type { APIContext } from 'astro';
import { draftableJobBySlug } from '../../lib/draft-job';
import { triggerJobDraft } from '../../lib/generation-preference-store';
import { createApplicationFromClick, getActiveApplicationForJob } from '../../lib/desk-store';
import {
  countRecentJobRenders,
  documentState,
  getJobRendersReconciled,
  type RenderKind
} from '../../lib/generated-render-store';
import { parseSteer } from '../../lib/draft-steer';
import { jobDraftPath, routeFor } from '../../data/nav';
import { isAddedSlug } from '../../lib/added-posting';
import { landReadyParse } from '../../lib/resume-parse-apply';
import { FUNCTION_MAX_DURATION_S } from '../../../site.config.mjs';

/** The per-user draft throttle: at most this many job-draft render rows in the
    window below. A full draft writes two rows, a per-document retry one, so this
    allows roughly 30 full drafts an hour, far above any real iterate rhythm. */
const DRAFT_RENDER_CEILING = 60;
const DRAFT_WINDOW_MS = 60 * 60 * 1000;

export const prerender = false;

/** Strips markup to plain text for the board card's snapshot, the same loose
    tag-strip src/pages/desk/application.ts's click branch uses on the same
    description_html, so a drafted card and a clicked card capture it alike. */
function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** The reason field's server-side length backstop; the textarea carries the
    same maxlength. Long enough for two or three sentences in the person's own
    words, short enough that it stays an anchor, not a second letter. */
const REASON_MAX_CHARS = 600;

function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

/** The answer both the "started a draft" and the "already drafting" paths give,
    so a re-click while a draft is in flight lands exactly where a fresh draft
    does. A fetch() caller (the job detail rail's button script) gets the URL as
    JSON and navigates itself; a plain form submit gets the 303. */
function respondStarted(request: Request, draftUrl: string): Response {
  if ((request.headers.get('accept') ?? '').includes('application/json')) {
    return new Response(JSON.stringify({ drafting: 'started', draftUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return redirectTo(draftUrl);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;

  // Signed out falls through the '/desk' wall to here (middleware walls a
  // signed-in non-member, not a signed-out reader). Send them to sign in
  // rather than answering a bare 401: the button's own signed-out line already
  // points here, and a no-JS submit lands somewhere honest.
  if (!viewer) {
    return redirectTo(routeFor('sign-in'));
  }

  const verdict = context.locals.verdict;
  if (verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const form = await context.request.formData();
  const slug = String(form.get('slug') ?? '').trim();
  const job = slug ? await draftableJobBySlug(slug, viewer.userId) : null;

  // No matching posting in either population: nothing to draft against. Send
  // them back to the index rather than draft a document aimed at a posting this
  // database has no record of.
  if (!job) {
    return redirectTo(routeFor('index'));
  }

  const draftUrl = jobDraftPath(job.slug);

  // An optional `kind` restarts just one document (the room's per-document
  // "Draft the cover letter again" button); anything but 'resume' or 'cover'
  // means both, so the plain begin form and the rail keep drafting the pair.
  // Parsed here because the idempotency check below needs it.
  const kindRaw = String(form.get('kind') ?? '');
  const kind = kindRaw === 'resume' || kindRaw === 'cover' ? kindRaw : undefined;

  // A resume read that finished but has not landed in the record yet lands
  // now (resume-parse-apply.ts), so the draft reads the roles it carried
  // rather than an empty record. Normally nothing is waiting.
  await landReadyParse(viewer.userId);

  // IDEMPOTENT RETRY. Every button that reaches this endpoint (the room's "Start
  // the draft over", a double submit, the rail re-click) posts the same slug. If
  // the requested document(s) are already drafting and not stale, begin nothing:
  // a new version would spend the throttle and pile a dead row onto the version
  // list on every click. getJobRendersReconciled first settles any row the clock
  // has abandoned to 'failed', so a genuinely stuck draft is not mistaken for one
  // in flight and can start fresh. Either way the person lands back on the room,
  // which is already polling for the result. Read failure never blocks drafting.
  const nowMs = Date.now();
  const ceilingMs = FUNCTION_MAX_DURATION_S * 1000;
  try {
    const rows = await getJobRendersReconciled(viewer.userId, job.slug, nowMs, ceilingMs);
    const requested: RenderKind[] = kind ? [kind] : ['resume', 'cover'];
    const stillDrafting = requested.some((k) => documentState(rows[k], nowMs, ceilingMs) === 'pending');
    if (stillDrafting) {
      console.log(`desk/job-draft: ${requested.join('+')} for job ${job.slug} already drafting; not starting another version.`);
      return respondStarted(context.request, draftUrl);
    }
  } catch (error) {
    console.error(`desk/job-draft: could not check for an in-flight draft for user ${viewer.userId}; beginning a new draft.`, error);
  }

  // Per-user throttle. Each draft spends up to two model calls on the person's
  // own key plus function time, and nothing else bounds how fast this endpoint
  // can be hit. A draft writes one or two render rows; DRAFT_RENDER_CEILING
  // rows an hour is well above any honest iterate-on-a-draft rhythm and cheap to
  // check (one COUNT). Over the ceiling, refuse for this window rather than
  // begin more work.
  try {
    const recent = await countRecentJobRenders(viewer.userId, DRAFT_WINDOW_MS);
    if (recent >= DRAFT_RENDER_CEILING) {
      return new Response('You have started a lot of drafts in the last hour. Give it a little while, then try again.', {
        status: 429,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' }
      });
    }
  } catch (error) {
    // A throttle that cannot read must not block drafting; log and proceed.
    console.error(`desk/job-draft: could not read the draft rate for user ${viewer.userId}; allowing.`, error);
  }

  // The person's own reason for wanting this company, optional. Trimmed and
  // length-capped as a backstop to the textarea's own maxlength; passed
  // verbatim otherwise, the same way a free-text target's own text is carried
  // through (it is the person's own words about themselves, not something to
  // police). Empty becomes null so the letter's gap report names its absence.
  const reasonRaw = String(form.get('reason') ?? '').trim();
  const reason = reasonRaw.length > 0 ? reasonRaw.slice(0, REASON_MAX_CHARS) : null;

  // The person's steer for this one regenerate: the allowlisted chips (repeated
  // checkbox values, so getAll) and the free-text note. parseSteer is the sole
  // gate on this untrusted form input; it drops anything not in STEER_CHIPS,
  // caps the note, and returns null when there is nothing to steer, so a plain
  // Regenerate stays plain. A steer only makes sense with a `kind` (that is how
  // the room posts it, one document at a time), but this does not hard-fail on
  // a missing kind: a stray steer with no kind is passed through harmlessly and
  // the both-documents path simply has nothing new to shape.
  const steerChips = form.getAll('steer').map((value) => String(value));
  const steerNote = form.get('steerNote');
  const steer = parseSteer(steerChips, steerNote === null ? null : String(steerNote));

  // Track the drafted job on the Desk board, once. Drafting is real investment
  // in this posting, so it belongs on the board rather than vanishing. A
  // 'clicked' card only: the confirm loop still gates 'applied', so this does
  // not pretend the person applied. Deduped on the active card so a re-draft or
  // a per-document retry never spawns a second card or resets a state further
  // along. Best-effort: a tracking failure is logged and the draft proceeds.
  //
  // A POSTING THE PERSON ADDED BY LINK ALREADY HAS ITS CARD. It was created
  // when they pasted the URL (src/pages/desk/posting.ts), keyed by
  // external_url with no job_id, so the dedupe below (which looks up by
  // job_id) would miss it and write a second card for the same posting.
  try {
    const alreadyTracked = isAddedSlug(job.slug) || (await getActiveApplicationForJob(viewer.userId, job.id));
    if (!alreadyTracked) {
      await createApplicationFromClick(viewer.userId, {
        jobId: job.id,
        externalUrl: null,
        snapshotTitle: job.title,
        snapshotCompany: job.company,
        snapshotDescription: plainText(job.description_html),
        clickedAt: new Date()
      });
    }
  } catch (error) {
    console.error(`desk/job-draft: could not track the drafted job on the board for user ${viewer.userId}.`, error);
  }

  // The request URL rides along so the render can be handed to this
  // deployment's own run endpoint (see triggerJobDraft); the origin actually
  // used is VERCEL_URL when present, never the forwarded host.
  await triggerJobDraft(viewer.userId, job, { reason, origin: context.url, kind, steer });

  return respondStarted(context.request, draftUrl);
}
