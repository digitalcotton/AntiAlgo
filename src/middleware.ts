/**
 * middleware.ts: where the gate is actually enforced.
 *
 * A check a page has to remember to call is a check a page will forget, and
 * the forgetting is silent. Running it here means a gated route cannot render
 * without the check having already run. The page still gets
 * `Astro.locals.viewer`, so it can decide what to SHOW; showing is the page's
 * job and allowing is not.
 *
 * MERGED FROM TWO MIDDLEWARES. AntiAlgo's own gated only `/account` and
 * `/internal` and sent a denied request to /sign-in or /waitlist. The Index's
 * gated the board's whole signed-in surface (/desk, /settings, /profile,
 * /drafts, /prelist) plus two extra viewer-resolution cases that are not
 * about tiers at all: `/u/[handle]` and an added posting's own board detail
 * page both answer owner-or-404, which needs a resolved viewer on an
 * otherwise-public path. Both halves are kept: entitlement.ts's merged
 * ROUTE_POLICY covers the gated prefixes, and SESSION_AWARE / SESSION_IF_COOKIE
 * below cover the two owner-or-404 cases.
 *
 * ORIGIN-CSRF: DROPPED THE INDEX'S HAND-ROLLED GATE, KEPT ASTRO'S OWN. The
 * Index turned `security.checkOrigin` off and ran its own isAllowedOrigin()
 * check instead, because its deployment sat behind the mothership's
 * server-side rewrite: the browser's Origin header (tokenstoagents.ai) never
 * matched the Vercel host Astro actually saw, so the framework's own check
 * would have 403'd every legitimate form POST. AntiAlgo has no such rewrite —
 * this site is reached at its own origin directly — so that reason does not
 * apply, and astro.config.mjs leaves `security.checkOrigin` at Astro's
 * default of true. See the note on isServerToServer's absence below for what
 * that means for /machine and /desk/**\/run.
 */
import { defineMiddleware } from 'astro:middleware';
import { decide, isGated } from './lib/entitlement';
import { routeIsLit } from './lib/flags';
import { viewerFrom } from './lib/viewer';
import { stripBase } from '../site.config.mjs';
import { isAddedDetailPath } from './lib/added-posting';

/**
 * Routes that need to know who you are, even though they are not (all)
 * gated. Base-free, same as entitlement.ts's ROUTE_POLICY: pathname is
 * stripped of BASE_PATH before it is compared against this list.
 *
 * '/sign-in', '/sign-up', '/waitlist' are AntiAlgo's own: signed-in visitors
 * to these get redirected on rather than shown a form they do not need.
 * '/verify-email', '/reset-password' are the Index's dormant auth pages
 * (email verification is off, but the routes still exist and read a viewer).
 *
 * '/u' IS HERE AND DELIBERATELY NOT IN GATED_PREFIXES, WHICH IS THE WHOLE
 * TRICK OF THAT ROUTE. src/pages/u/[handle].astro answers owner-or-404: the
 * person who claimed the handle sees their record, and a signed-out visitor,
 * a signed-in stranger, and a handle nobody owns all get the identical 404,
 * so a private profile and a nonexistent one cannot be told apart by
 * probing. That needs a resolved viewer, which needsViewer() below only
 * produces for a gated path or one named here. Gating '/u' instead would
 * attach a tier requirement the route does not want, and would bounce a
 * non-member owner before the ownership check ever ran.
 */
const SESSION_AWARE = ['/sign-in', '/sign-up', '/waitlist', '/verify-email', '/reset-password', '/u'];

/**
 * /board/added-<id> is the same trick as '/u', one level down. The board
 * detail route is public and ungated for every crawled posting, but a
 * posting a member added by link belongs to that member alone, and the page
 * answers owner-or-404 for it. isAddedDetailPath() matches only that exact
 * added-posting shape, so no crawled slug ever pays the session lookup.
 */
function needsViewer(pathname: string): boolean {
  return (
    isGated(pathname) ||
    isAddedDetailPath(pathname) ||
    SESSION_AWARE.some((p) => pathname === p || pathname.startsWith(p + '/'))
  );
}

/**
 * The board pays for a session only when there is one to read. /board and
 * every crawled /board/<slug> are public, and no anonymous request should pay
 * a session lookup on the site's busiest surface. But the fit score, the Fit
 * sort and the draft rail are signed-in features there (flags.config.mjs's
 * fit_public, DraftRail.astro), decided server-side because row order can
 * depend on the answer. So the lookup runs on these paths only when the
 * request carries a session cookie at all: a stranger sends none and pays
 * nothing, and a member's own cookie is what turns the check on. Better
 * Auth's cookie name always ends in session_token, with or without its
 * secure prefix.
 */
const SESSION_IF_COOKIE = ['/board'];

function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('cookie');
  return !!cookie && /session_token=/.test(cookie);
}

function needsViewerIfCookie(pathname: string, request: Request): boolean {
  return SESSION_IF_COOKIE.some((p) => pathname === p || pathname.startsWith(p + '/')) && hasSessionCookie(request);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = stripBase(context.url.pathname);

  // Better Auth answers its own routes. Resolving a viewer first would be a
  // session lookup in front of the endpoint whose job is to create the session.
  if (pathname.startsWith('/auth/')) return next();

  // A dark flag is a flat 404, before entitlement ever runs: a stranger
  // cannot tell a feature that does not exist in this edition from one that
  // exists and refused them, which is itself information this run withholds.
  // /machine (add_posting flag) and /desk (desk flag) are both covered here,
  // same as every other flagged prefix in flags.config.mjs's FLAGGED_ROUTES.
  if (!routeIsLit(pathname)) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (!needsViewer(pathname) && !needsViewerIfCookie(pathname, context.request)) {
    context.locals.viewer = null;
    return next();
  }

  let viewer = null;
  try {
    viewer = await viewerFrom(context);
  } catch (error) {
    // A database that will not answer must not become an open door.
    console.error('viewer resolution failed, treating request as signed out:', error);
    viewer = null;
  }
  context.locals.viewer = viewer;

  if (!isGated(pathname)) return next();

  const verdict = decide(pathname, viewer);
  context.locals.verdict = verdict;
  if (verdict.allow) return next();

  if (verdict.reason === 'signed-out') {
    return context.redirect(`/sign-in?next=${encodeURIComponent(pathname)}`, 302);
  }
  if (verdict.reason === 'waitlisted' || verdict.reason === 'email-unverified') {
    return context.redirect('/waitlist', 302);
  }
  // insufficient-tier or no-policy-declared: nothing to window-shop, or a
  // gated route nobody declared a policy for. Either way, refuse plainly.
  return new Response('Not available on your account.', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
});
