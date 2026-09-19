/**
 * GET /desk/job-draft/<slug>/status: what the draft for this posting is doing,
 * as JSON, for the detail page's own rail.
 *
 * WHY A SEPARATE ENDPOINT. The draft room at /desk/job-draft/<slug> answers the
 * same question by re-rendering itself every three seconds with a meta refresh,
 * which is the right answer for a page a reader is sitting on. The rail on the
 * job detail page cannot navigate: the whole point is that the reader never
 * leaves the posting. So it needs the state as data, and this is the smallest
 * honest shape of that state.
 *
 * THE STATE MATH IS THE ROOM'S, NOT A SECOND OPINION. Both call
 * jobDraftState() (src/lib/generated-render-store.ts), one pure function, so
 * the rail and the room can never disagree in front of a reader. It knows four
 * states: 'none' (nothing started), 'pending' (an invocation could still be
 * working on it), 'ready', and 'failed' (a row marked failed, or one left
 * pending longer than any invocation could live; the ceiling is
 * site.config.mjs's FUNCTION_MAX_DURATION_S, the same number the adapter
 * deploys with). A failed draft carries a reason: a sentence our own code
 * minted, never a provider body.
 *
 * IT NEVER 404s A SLUG. The room resolves the posting because it prints its
 * title; this returns 'none' for a slug with no rows and lets the caller decide.
 * A reader whose draft does not exist yet is not an error.
 *
 * OWNER SCOPED. The renders are read with the viewer's own id, so a slug alone
 * never reports on a stranger's draft. '/desk' is a gated prefix, so middleware
 * walls a signed-in non-member before this file runs; a signed-out request gets
 * a 401 with a JSON body, because the caller is a fetch() and not a form.
 *
 * ROUTING. The static 'status' segment wins over the sibling [doc] route, which
 * accepts only 'resume' and 'cover' and 404s everything else, so the two cannot
 * shadow each other.
 */
import type { APIContext } from 'astro';
import { ABANDONED_REASON, documentState, getJobRendersReconciled, jobDraftState } from '../../../../lib/generated-render-store';
import { jobDraftPath, jobDraftPdfPath } from '../../../../data/nav';
import { FUNCTION_MAX_DURATION_S } from '../../../../../site.config.mjs';
import { addedApplicationId, isAddedSlug } from '../../../../lib/added-posting';
import { fetchDisplayState, getPostingFetchByApplication } from '../../../../lib/posting-fetch-store';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer) return json({ status: 'signed-out' }, 401);

  const slug = (context.params.slug ?? '').trim();
  if (!slug) return json({ status: 'none' });

  const nowMs = Date.now();
  const ceilingMs = FUNCTION_MAX_DURATION_S * 1000;
  // Reconciled read: settles an abandoned pending row to 'failed' so the rail
  // and the room, which both poll this state, never disagree with the database.
  const rows = await getJobRendersReconciled(viewer.userId, slug, nowMs, ceilingMs);
  // An added posting carries its read state beside the draft state, so a
  // card can say "reading" before any render row exists.
  let fetch: { status: string; display: string; origin: string | null; sourceKind: string | null } | null = null;
  if (isAddedSlug(slug)) {
    const applicationId = addedApplicationId(slug);
    const row = applicationId === null ? null : await getPostingFetchByApplication(viewer.userId, applicationId);
    if (row) fetch = { status: row.status, display: fetchDisplayState(row, nowMs), origin: row.origin, sourceKind: row.sourceKind };
  }
  const state = jobDraftState(rows, nowMs, ceilingMs);
  const resumeState = documentState(rows.resume, nowMs, ceilingMs);
  const coverState = documentState(rows.cover, nowMs, ceilingMs);

  // A no-key draft is deterministic by design (provider null, status
  // 'fallback'), which is a quieter fact than "the provider we tried could not
  // be used". The rail says the first thing only when no provider was tried.
  const providerTried = rows.resume?.provider != null;
  // The pair reason is the first document that actually failed, so the message
  // names the document a reader is looking at, not a fixed cover-then-resume order.
  const failedReasonFor = (row: typeof rows.resume, docState: typeof resumeState) =>
    docState === 'failed' ? (row?.failureReason ?? ABANDONED_REASON) : null;
  const resumeReason = failedReasonFor(rows.resume, resumeState);
  const coverReason = failedReasonFor(rows.cover, coverState);

  return json({
    status: state,
    deterministic: state === 'ready' && !providerTried,
    failureReason: state === 'failed' ? (resumeReason ?? coverReason) : null,
    resume: { status: resumeState, failureReason: resumeReason },
    cover: { status: coverState, failureReason: coverReason },
    fetch,
    draftUrl: jobDraftPath(slug),
    resumeUrl: jobDraftPdfPath(slug, 'resume'),
    coverUrl: jobDraftPdfPath(slug, 'cover')
  });
}
