/**
 * POST /desk/job-draft/<slug>/run: render ONE document of a job draft, in an
 * invocation of its own.
 *
 * WHO CALLS THIS. Not a browser. src/lib/draft-run-dispatch.ts POSTs here from
 * inside the job-draft POST, once per document, so that each render is held
 * alive by a fresh invocation's waitUntil with the platform's whole ceiling,
 * rather than sharing the POST's own clock (see that file's header).
 *
 * AUTHENTICATION IS THE TOKEN, AND NOTHING ELSE. There is no session cookie on
 * a server-to-server call, so `locals.viewer` is null here by design.
 * Middleware lets the request reach this file: for a gated '/desk' path with no
 * viewer, decide() answers 'signed-out', and middleware refuses only
 * 'insufficient-tier' (src/middleware.ts), passing everything else through.
 * This route ignores `locals.viewer` and `locals.verdict` entirely and trusts
 * only a signature made with DRAFT_RUN_SECRET (src/lib/draft-run-token.ts). It
 * is not mounted under /internal (a 403 for signed-out) or /api (claimed by
 * the root api/ directory), for those reasons. The static 'run' segment wins
 * over the sibling [doc] route, exactly as 'status' does.
 *
 * THE ORDER, AND WHY. Verify, then CLAIM, then defer, then answer 202. The
 * claim (started_at stamped on a row that is still pending and unclaimed) is
 * what makes a replay harmless: the second request finds nothing to claim and
 * answers 202 without rendering. The deferral has to happen before the 202
 * goes out, because that is the moment the promise is registered with THIS
 * invocation's waitUntil; a caller that has its 202 knows the work is owned.
 *
 * NOT CONFIGURED IS 503, NOT A RENDER. With no secret there is nothing to
 * verify against; the dispatcher never calls here in that case, and a stray
 * call gets the honest "not configured" rather than a silent no-op.
 */
import type { APIContext } from 'astro';
import { draftableJobBySlug } from '../../../../lib/draft-job';
import { claimJobRender, failDraft } from '../../../../lib/generated-render-store';
import { renderOneDocument } from '../../../../lib/generation-preference-store';
import { draftRunSecret, verifyRunToken } from '../../../../lib/draft-run-token';
import { deferWork } from '../../../../lib/defer-work';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const secret = draftRunSecret();
  if (!secret) return json({ accepted: false, reason: 'not-configured' }, 503);

  let token: unknown = null;
  try {
    const body = (await context.request.json()) as { token?: unknown } | null;
    token = body?.token ?? null;
  } catch {
    return json({ accepted: false, reason: 'malformed' }, 400);
  }
  const payload = typeof token === 'string' ? verifyRunToken(token, secret, Date.now()) : null;
  if (!payload) return json({ accepted: false, reason: 'unauthorized' }, 401);

  const slug = (context.params.slug ?? '').trim();
  if (payload.jobId !== slug) return json({ accepted: false, reason: 'slug-mismatch' }, 400);

  const claimed = await claimJobRender(payload.renderId, payload.userId, payload.jobId, payload.kind);
  if (!claimed) return json({ accepted: false, reason: 'already-claimed' }, 202);

  const job = await draftableJobBySlug(slug, payload.userId);
  if (!job) {
    await failDraft(payload.renderId, 'the posting could not be found');
    return json({ accepted: false, reason: 'no-such-job' }, 404);
  }

  deferWork(
    renderOneDocument({
      userId: payload.userId,
      job,
      kind: payload.kind,
      renderId: payload.renderId,
      provider: payload.provider,
      reason: payload.reason
    }).catch((error) => {
      console.error(`job-draft run: renderOneDocument rejected for the ${payload.kind} of job ${slug}.`, error);
    })
  );

  return json({ accepted: true }, 202);
}
