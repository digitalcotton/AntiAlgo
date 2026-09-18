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
 * ORIGIN-CSRF: ADOPTED THE INDEX'S HAND-ROLLED GATE, TURNED ASTRO'S OFF. Astro's
 * built-in checkOrigin compares the browser's Origin to the Host header, but on
 * Vercel that Host is the internal deploy host; the public host the browser
 * actually posts from (www.antialgo.ai) arrives only in x-forwarded-host. So the
 * framework check refused every legitimate form POST, proven in production on
 * 2026-09-18 when a POST carrying a matching www.antialgo.ai Origin was still
 * 403'd "Cross-site POST form submissions are forbidden". astro.config.mjs now
 * sets `security.checkOrigin` to false and the CSRF defense lives in the ORIGIN
 * GATE below (isAllowedOrigin), which validates the Origin against the real
 * forwarded host and this site's own hosts instead. isServerToServer exempts the
 * /machine and /desk/**\/run server-to-server callers that POST with no Origin.
 */
import { defineMiddleware } from 'astro:middleware';
import { decide, isGated } from './lib/entitlement';
import { routeIsLit } from './lib/flags';
import { viewerFrom } from './lib/viewer';
import { SITE_ORIGIN, stripBase } from '../site.config.mjs';
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

/** Methods that change nothing, so they never need the origin gate. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * This site's own hosts: SITE_ORIGIN's host and its apex/www sibling. The domain
 * is reached at both (antialgo.ai answers with a 307 to www.antialgo.ai), so a
 * form posted from either is ours, not a forgery. Computed once at load.
 */
const SITE_HOSTS: ReadonlySet<string> = (() => {
  const hosts = new Set<string>();
  try {
    const host = new URL(SITE_ORIGIN).host;
    hosts.add(host);
    hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
  } catch {
    // SITE_ORIGIN is a valid URL in every real deployment; an empty set here
    // just leaves the decision to the other allow-branches below.
  }
  return hosts;
})();

/**
 * Callers that legitimately POST with no browser Origin: the draft run dispatch
 * (/desk/job-draft/<slug>/run) and the crawler's machine endpoints (/machine/**).
 * A missing Origin is already allowed below; naming them here also lets one that
 * sends a non-browser Origin through. Base-free pathname, like every other match
 * in this file.
 */
function isServerToServer(pathname: string): boolean {
  return /^\/desk\/job-draft\/[^/]+\/run$/.test(pathname) || pathname.startsWith('/machine/');
}

/**
 * An Origin we serve. Astro's own checkOrigin compares the browser Origin to the
 * Host header, which on Vercel is the internal deploy host, not the public
 * www.antialgo.ai the browser sees (only x-forwarded-host carries that), so the
 * framework check refuses every real form POST and is turned off in
 * astro.config.mjs. This is the replacement, and it checks the real public
 * origin: same-origin as Astro resolved it, SITE_ORIGIN, the public origin
 * rebuilt from the forwarded headers, this site's own hosts (apex and www),
 * localhost in dev, and this exact Vercel deployment. A cross-site attacker's
 * browser sends its own Origin, and Vercel sets x-forwarded-host to our host, so
 * the two never line up and none of these branches match.
 */
function isAllowedOrigin(origin: string, url: URL, headers: Headers): boolean {
  if (origin === url.origin || origin === SITE_ORIGIN) return true;
  const fwdHost = headers.get('x-forwarded-host');
  if (fwdHost) {
    const proto = headers.get('x-forwarded-proto') ?? 'https';
    if (origin === `${proto}://${fwdHost}`) return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'https:' && SITE_HOSTS.has(parsed.host)) return true;
  } catch {
    return false;
  }
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host && origin === `https://${host}`) return true;
  }
  return false;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = stripBase(context.url.pathname);

  // Better Auth answers its own routes. Resolving a viewer first would be a
  // session lookup in front of the endpoint whose job is to create the session.
  if (pathname.startsWith('/auth/')) return next();

  // ORIGIN GATE (CSRF). Astro's built-in checkOrigin is off (see
  // astro.config.mjs): on Vercel it compares the browser Origin to the internal
  // deploy host, not the public host, so it refused every legitimate form POST
  // (a POST carrying a matching www.antialgo.ai Origin was still 403'd in
  // production, 2026-09-18). The defense moves here: a state-changing request
  // whose Origin header is present and is not one we serve is a cross-site
  // forgery and is refused. A missing Origin is allowed (server-to-server
  // callers send none, and a victim's browser cannot suppress Origin on a
  // cross-site POST, so absence is not an attacker's lever). Better Auth
  // validates its own trustedOrigins and returned above.
  if (!SAFE_METHODS.has(context.request.method) && !isServerToServer(pathname)) {
    const origin = context.request.headers.get('origin');
    if (origin && !isAllowedOrigin(origin, context.url, context.request.headers)) {
      return new Response('Cross-origin request refused.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }

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
