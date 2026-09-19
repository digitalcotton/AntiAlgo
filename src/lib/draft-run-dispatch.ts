/**
 * draft-run-dispatch.ts: hand each document of a job draft to its own fresh
 * function invocation.
 *
 * THE CLOCK THIS ESCAPES. A Vercel function has one ceiling (maxDuration),
 * counted from the moment its request arrives, and waitUntil() inherits it:
 * work deferred past the response still dies with the invocation. Rendering
 * both documents inside the POST's own invocation therefore gave the resume
 * and the cover one shared window, and the cover's provider call ran out of it
 * in production ("the live provider call failed (timed out)"). Nothing the
 * browser does can help: the page already polls; the work itself was on the
 * wrong clock.
 *
 * THE MOVE. The POST signs one token per document (src/lib/draft-run-token.ts)
 * and POSTs each to this deployment's own run endpoint
 * (src/pages/desk/job-draft/[slug]/run.ts). That endpoint registers the render
 * with ITS invocation's waitUntil and answers 202 at once. The POST awaits only
 * those two fast 202s, never the renders, so by the time it returns each
 * document is already held alive by an invocation with a whole ceiling of its
 * own, and the two can no longer starve each other.
 *
 * WHICH ORIGIN. Never the request's own origin: Astro builds it from the
 * forwarded host, which under the mothership's rewrite is tokenstoagents.ai,
 * and a fetch there would round-trip the mothership's /jobs proxy (and, from a
 * preview, land on production). VERCEL_URL names this exact deployment.
 * Locally there is no VERCEL_URL and the request origin is right.
 *
 * DEGRADES, NEVER BREAKS. No secret configured, a fetch that fails, a run
 * endpoint that answers anything but 202: that document is handed back to the
 * caller to render in-process, the way it always was. The person is never left
 * with a row nobody is working on. The caller owns that fallback because this
 * file must not import the render (it would be a cycle).
 */
import type { Job } from './data';
import type { RenderKind } from './generated-render-store';
import type { Provider } from './keychain';
import type { DraftSteer } from './draft-steer';
import { jobDraftRunPath } from '../data/nav';
import { draftRunSecret, signRunToken, RUN_TOKEN_TTL_MS } from './draft-run-token';

export interface DocumentDispatch {
  readonly userId: string;
  readonly job: Job;
  readonly kind: RenderKind;
  readonly renderId: string;
  readonly provider: Provider | null;
  readonly reason: string | null;
  /** The person's steer for this one regenerate, carried into the signed token
      so a fresh invocation renders with it (draft-steer.ts). Null for a first
      draft or a plain re-draft. */
  readonly steer: DraftSteer | null;
}

/** How long the POST will wait for a run endpoint's 202. The endpoint answers
    before it renders, so this is a network round trip, not a model call. */
export const DISPATCH_TIMEOUT_MS = 10_000;

/** The origin this deployment answers on, for a call to itself. */
export function selfOrigin(requestUrl: URL): string {
  const vercelHost = process.env.VERCEL_URL;
  return vercelHost && vercelHost.trim().length > 0 ? `https://${vercelHost.trim()}` : requestUrl.origin;
}

/** What answered a non-202: the app itself, or the platform in front of it.
    run.ts always replies JSON with a string `reason`; a middleware bounce is a
    3xx to /sign-in; Vercel Deployment Protection replies HTML (or its own
    redirect) from the edge before the function runs. Telling these apart turns a
    silent "it answered 401" into one log line that names WHO refused us. */
type RunResponseClass = 'app' | 'edge' | 'redirect';

async function classifyRunResponse(response: Response): Promise<{ cls: RunResponseClass; detail: string }> {
  if (response.status >= 300 && response.status < 400) {
    return { cls: 'redirect', detail: response.headers.get('location') ?? '' };
  }
  let body = '';
  try {
    body = await response.text();
  } catch {
    // A body we cannot read is still classifiable by its content type below.
  }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as { reason?: unknown };
      if (typeof parsed.reason === 'string') return { cls: 'app', detail: parsed.reason };
    } catch {
      // JSON content type but not the app's shape: fall through to edge.
    }
  }
  return { cls: 'edge', detail: body.slice(0, 120).replace(/\s+/g, ' ').trim() };
}

/**
 * Dispatch every document to its own invocation. Returns the documents that
 * could NOT be dispatched (all of them when no secret is set), for the caller
 * to render in-process. Never throws.
 */
export async function dispatchJobDraftRuns(
  origin: string,
  docs: readonly DocumentDispatch[],
  fetchImpl: typeof fetch = fetch
): Promise<readonly DocumentDispatch[]> {
  const secret = draftRunSecret();
  if (!secret) {
    console.error('draft-run-dispatch: DRAFT_RUN_SECRET is not set; rendering the job draft in-process.');
    return docs;
  }

  const inVercel = process.env.VERCEL === '1';
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // The self-call targets this deployment's own *.vercel.app host, which
  // Deployment Protection guards. Without the bypass secret the edge 401s it
  // before the function runs, and every draft silently falls back in-process
  // (the path that times out in production). Say so once, loudly.
  if (inVercel && !bypass) {
    console.error(
      `draft-run-dispatch: VERCEL_AUTOMATION_BYPASS_SECRET is not set; if Deployment Protection covers ${origin}, every run dispatch is refused at the edge and falls back in-process. Enable "Protection Bypass for Automation" in Project Settings.`
    );
  }

  const results = await Promise.all(
    docs.map(async (doc): Promise<DocumentDispatch | null> => {
      const token = signRunToken(
        {
          v: 1,
          renderId: doc.renderId,
          userId: doc.userId,
          jobId: doc.job.slug,
          kind: doc.kind,
          provider: doc.provider,
          reason: doc.reason,
          steer: doc.steer,
          exp: Date.now() + RUN_TOKEN_TTL_MS
        },
        secret
      );
      const url = `${origin}${jobDraftRunPath(doc.job.slug)}`;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {})
          },
          body: JSON.stringify({ token }),
          // Report a middleware 3xx as itself, not as a followed 200 from
          // /sign-in that would read as "the run endpoint answered 200".
          redirect: 'manual',
          signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS)
        });
        if (response.status === 202) return null;
        const { cls, detail } = await classifyRunResponse(response);
        console.error(
          `draft-run-dispatch: ${url} answered ${response.status} (${cls}${detail ? `: ${detail}` : ''}) for the ${doc.kind} of job ${doc.job.slug}; rendering it in-process.`
        );
        // The secret is configured and yet the app did not answer: the block is
        // in front of the function, i.e. Deployment Protection / a stale bypass.
        if (inVercel && bypass && cls !== 'app') {
          console.error(
            'draft-run-dispatch: a bypass secret IS set and the run endpoint still did not answer as the app. Check Project Settings, Deployment Protection (a disabled or stale bypass, or the wrong project).'
          );
        }
        return doc;
      } catch (error) {
        console.error(
          `draft-run-dispatch: could not reach ${url} for the ${doc.kind} of job ${doc.job.slug}; rendering it in-process.`,
          error
        );
        return doc;
      }
    })
  );
  return results.filter((doc): doc is DocumentDispatch => doc !== null);
}
