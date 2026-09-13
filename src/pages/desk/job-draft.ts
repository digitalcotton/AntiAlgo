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
import { countRecentJobRenders } from '../../lib/generated-render-store';
import { jobDraftPath, routeFor } from '../../data/nav';
import { isAddedSlug } from '../../lib/added-posting';

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

  // An optional `kind` restarts just one document (the room's per-document
  // "Draft the cover letter again" button); anything but 'resume' or 'cover'
  // means both, so the plain begin form and the rail keep drafting the pair.
  const kindRaw = String(form.get('kind') ?? '');
  const kind = kindRaw === 'resume' || kindRaw === 'cover' ? kindRaw : undefined;

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
  await triggerJobDraft(viewer.userId, job, { reason, origin: context.url, kind });

  const draftUrl = jobDraftPath(job.slug);

  // Progressive enhancement: a fetch() caller (the role page's own button
  // script) gets the URL as JSON and navigates itself; a plain form submit
  // gets a redirect. Same destination either way.
  if ((context.request.headers.get('accept') ?? '').includes('application/json')) {
    return new Response(JSON.stringify({ drafting: 'started', draftUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return redirectTo(draftUrl);
}
