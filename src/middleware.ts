/**
 * middleware.ts: where the gate is actually enforced.
 *
 * A check a page has to remember to call is a check a page will forget, and
 * the forgetting is silent. Running it here means a gated route cannot render
 * without the check having already run.
 *
 * WHAT A REFUSAL LOOKS LIKE, BY REASON. Signed out: to sign-in, carrying the
 * path back. Email unverified, or waitlisted: to the one waitlist page, which
 * states the account's actual state and links the public board. Insufficient
 * tier (a member on an internal page): a 403, because there is nothing to
 * window-shop.
 */
import { defineMiddleware } from 'astro:middleware';
import { decide, isGated } from './lib/entitlement';
import { routeIsLit } from './lib/flags';
import { viewerFrom } from './lib/viewer';
import { stripBase } from '../site.config.mjs';

/** Routes that need to know who you are, even though they are not gated. */
const SESSION_AWARE = ['/sign-in', '/sign-up', '/waitlist'];

function needsViewer(pathname: string): boolean {
  return isGated(pathname) || SESSION_AWARE.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = stripBase(context.url.pathname);

  // Better Auth answers its own routes.
  if (pathname.startsWith('/auth/')) return next();

  // A dark flag is a flat 404, before entitlement ever runs.
  if (!routeIsLit(pathname)) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (!needsViewer(pathname)) {
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
  return new Response('Not available on your account.', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
});
