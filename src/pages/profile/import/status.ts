/**
 * GET /profile/import/status: what the resume read is doing, as JSON, for the
 * profile page's own upload panel.
 *
 * WHY A SEPARATE ENDPOINT. The review page answers the same question by
 * re-rendering itself every two seconds with a meta refresh, which is the
 * right answer for a page a reader is sitting on. The upload panel cannot
 * navigate: the point of the in-place flow is that the person never leaves
 * /profile. So it needs the state as data, the same seam the job-draft rail
 * already draws (desk/job-draft/[slug]/status.ts).
 *
 * WHAT IT RETURNS, and deliberately no more: the status, and the few outcome
 * facts the panel narrates while it decides whether to pull the full review
 * in (the method, the fallback reason, the notes, and whether anything was
 * proposed). The proposals themselves are not serialised out here: the panel
 * gets them by fetching the page HTML the server already renders, so there is
 * exactly one renderer of a proposal and it is ProposalForm.astro.
 *
 * OWNER SCOPED. The row is read with the viewer's own id; '/profile' is a
 * gated prefix, so middleware walls a signed-in non-member first, and a
 * signed-out request gets a 401 with a JSON body because the caller is a
 * fetch(), not a form.
 */
import type { APIContext } from 'astro';
import { getParse } from '../../../lib/resume-parse-store';
import type { ImportWireStatus } from '../../../lib/resume-parse-wire';

export const prerender = false;

/** Typed by the vocabulary the pollers read this with
 *  (src/lib/resume-parse-wire.ts), so a new status cannot be introduced here
 *  without the predicates every consumer shares deciding what it means. */
function json(body: { status: ImportWireStatus } & Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer) return json({ status: 'signed-out' }, 401);

  const parse = await getParse(viewer.userId);
  if (!parse) return json({ status: 'none' });
  if (parse.status === 'pending') return json({ status: 'pending' });

  const outcome = parse.outcome;
  const proposals = outcome?.proposals ?? null;
  const hasSomething = Boolean(
    proposals && (proposals.entries.length > 0 || proposals.links.length > 0 || proposals.name !== null)
  );

  return json({
    status: 'ready',
    method: outcome?.method ?? null,
    fallbackReason: outcome?.fallbackReason ?? null,
    notes: outcome?.notes ?? [],
    hasSomething
  });
}
