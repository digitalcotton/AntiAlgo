/**
 * POST /billing/checkout: start a Stripe Checkout Session for the
 * $7.25/month membership, for the caller's own account only.
 *
 * DARK BY FLAG, TWICE OVER. flags.config.mjs's FLAGGED_ROUTES maps '/billing'
 * to the `stripe` flag, so while it is off (both editions, today) middleware
 * 404s this request before this file's code ever runs — see
 * src/middleware.ts's routeIsLit() check. The isOn('stripe') check below is
 * belt-and-suspenders, the same pattern src/pages/settings/keys/save.ts uses
 * for `byok`: a kill switch that only hides a button but still accepts a
 * direct POST is not a kill switch.
 *
 * WHO THIS ACTS ON. '/billing' is deliberately NOT a GATED_PREFIXES entry in
 * entitlement.ts (see that file's own header on ROUTE_POLICY, and the Phase 6
 * plan: no paid-gated feature is designated yet, so nothing should require
 * the `paid` tier to reach this route). That means middleware does not
 * pre-resolve Astro.locals.viewer for this path the way it does for a gated
 * prefix. So this handler resolves its own viewer with viewerFrom(), the same
 * impure helper src/lib/viewer.ts exports for exactly this: reading the
 * session from the request headers and the tier from app_user_profile,
 * never from anything the client sent. A signed-out request is refused
 * before Stripe is ever called.
 *
 * client_reference_id IS THE ONLY LINK BACK. The Checkout Session carries
 * this user's id as client_reference_id (and again in the subscription's own
 * metadata, set by billing.ts) so billing/webhook.ts can map a Stripe event
 * back to a row in app_user_profile with no separate mapping table.
 */
import type { APIContext } from 'astro';
import { isOn } from '../../lib/flags';
import { viewerFrom } from '../../lib/viewer';
import { createCheckoutSession } from '../../lib/billing';
import { SITE_URL, withBase } from '../../../site.config.mjs';
import { routeFor } from '../../data/nav';

export const prerender = false;

function notFound(): Response {
  return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function POST(context: APIContext): Promise<Response> {
  if (!isOn('stripe')) {
    // Matches middleware's own dark-flag response exactly: a stranger must
    // not be able to distinguish "this route doesn't exist in this edition"
    // from "this route exists and refused you."
    return notFound();
  }

  const viewer = await viewerFrom(context);
  if (!viewer) {
    return new Response('Not signed in.', { status: 401 });
  }

  try {
    const session = await createCheckoutSession({
      userId: viewer.userId,
      // Absolute URLs: Stripe redirects the browser here directly, not
      // through this app, so a base-relative path is not enough.
      successUrl: `${SITE_URL}${withBase('/account')}?upgraded=1`,
      cancelUrl: `${SITE_URL}${routeFor('upgrade')}?canceled=1`
    });

    if (!session.url) {
      throw new Error('Stripe returned a Checkout Session with no url.');
    }

    // 303: this POST's result is "go look at this other resource," the same
    // reason every other form handler in this codebase (settings/name.ts,
    // settings/keys/save.ts) redirects with 303 rather than 302.
    return new Response(null, { status: 303, headers: { Location: session.url } });
  } catch (error) {
    // billing.ts throws a named, specific error when Stripe is not
    // configured (missing env var) or Stripe itself rejects the request;
    // neither is shown to the caller verbatim, only logged server-side.
    console.error('billing/checkout: failed to create a Stripe Checkout Session.', error);
    return new Response('Checkout is not available right now.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
