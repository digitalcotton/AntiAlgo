/**
 * GET /desk/drafting-status: whether applying right now would draft a
 * resume and cover letter for the signed-in reader.
 *
 * WHY THIS EXISTS. src/pages/role/[slug].astro is static, built for
 * nobody, so it cannot know at build time whether a given visitor has
 * drafting on and a provider key stored. This endpoint answers that one
 * boolean, per request, so the apply panel can decide what to say ("Apply
 * and draft" versus a plain "Apply without drafting") and where the
 * primary click should land, without the page itself needing any of
 * src/lib/generation-preference-store.ts's or src/lib/keychain-store.ts's
 * logic inlined into it.
 *
 * MOUNTED UNDER /desk, NOT /api, FOR THE SAME FORCED REASON
 * src/pages/desk/application.ts IS. See src/pages/auth/[...all].ts's own
 * header for the preview-deploy evidence: this repo's root api/ directory
 * claims every /api/* path before Astro's router ever runs. This route
 * lives inside the same '/desk' prefix application.ts and save.ts already
 * use, so no second src/lib/entitlement.ts ROUTE_POLICY entry is needed.
 *
 * SIGNED OUT IS NOT AN ERROR TO THE CALLER. src/middleware.ts calls next()
 * for a gated prefix whenever verdict.reason is not 'insufficient-tier'
 * (signed-out and email-unverified both fall through), so this file, not
 * the middleware, is what a signed-out or unverified request actually
 * reaches. A 401 here would work, but the apply panel's own job is simpler
 * with one shape to read regardless of why drafting is unavailable: 200
 * `{ available: false }` either way, the same "one boolean, no error branch
 * to special-case" contract src/pages/desk/application.ts's own header
 * asks endpoints in this directory to keep.
 *
 * THE FOUR CONDITIONS, SHORT-CIRCUITED IN CHEAPEST-FIRST ORDER, THE SAME
 * ORDER src/lib/generation-preference.ts's decideGenerationTrigger() CHECKS
 * THEM IN. keyStorageIsConfigured() and isOn('byok') are both synchronous;
 * a `false` from either means the two database reads below never run. This
 * file does not call decideGenerationTrigger() itself: that function
 * answers "should THIS click draft", parameterised on a Job, and this
 * endpoint has no Job and no click, only "is the account itself set up to
 * draft at all", so it reads the same four facts directly instead of
 * manufacturing an unused Job to satisfy a signature built for a different
 * question.
 */
import type { APIContext } from 'astro';
import { keyStorageIsConfigured } from '../../lib/keychain';
import { isOn } from '../../lib/flags';
import { getGenerationPreference } from '../../lib/generation-preference-store';
import { keyMeta } from '../../lib/keychain-store';
import { GENERATION_PROVIDER_ORDER } from '../../lib/generation-providers';

export const prerender = false;

function jsonResponse(body: { available: boolean }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer) {
    return jsonResponse({ available: false });
  }

  if (!keyStorageIsConfigured() || !isOn('byok')) {
    return jsonResponse({ available: false });
  }

  const preferenceEnabled = await getGenerationPreference(viewer.userId);
  if (!preferenceEnabled) {
    return jsonResponse({ available: false });
  }

  const stored = await keyMeta(viewer.userId);
  const available = stored.some((row) => GENERATION_PROVIDER_ORDER.includes(row.provider));

  return jsonResponse({ available });
}
