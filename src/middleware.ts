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
 * A signed-in reader gets a resolved viewer on EVERY route, so the header can
 * show the member nav (and the board its fit score, Fit sort and draft rail)
 * site-wide, not only on gated pages. The gate is the session cookie itself: a
 * stranger sends none and still pays nothing — the guard below short-circuits
 * to a null viewer before any session lookup — and a member's own cookie is
 * what turns the lookup on. So an anonymous request on a marketing page reads
 * neither Better Auth nor Postgres; only a request actually carrying a session
 * cookie pays the getSession + one SELECT. Better Auth's cookie name always
 * ends in session_token, with or without its secure prefix.
 */
function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('cookie');
  return !!cookie && /session_token=/.test(cookie);
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

  if (!needsViewer(pathname) && !hasSessionCookie(context.request)) {
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
