import type { APIRoute } from 'astro';
import { routeFor } from '../data/nav';
import { absoluteUrl } from '../data/site';

/**
 * robots.txt, derived rather than typed.
 *
 * WHY IT DID NOT EXIST. The site has had a sitemap since it was built and has
 * never had the file that tells a crawler where to find it — /robots.txt answered
 * 404 in production on 2026-09-24. A sitemap nobody is pointed at is a sitemap
 * that gets found by luck.
 *
 * WHAT IT SAYS, AND WHAT IT DOES NOT. Everything is crawlable. This is deliberate
 * and it is not the same thing as being careless: a robots.txt is a REQUEST, not
 * a gate, and the gates are real and elsewhere. src/middleware.ts refuses every
 * signed-in route before a handler runs; src/lib/entitlement.ts decides tiers;
 * flags.config.mjs sends a dark route to a flat 404. Listing /desk or /settings
 * as Disallow here would add nothing to that and would publish a map of the
 * private surface to anyone who reads this file — which is everyone, by design.
 * The pages that should not be indexed already say so themselves, per page, with
 * a robots meta tag (report/cover.astro:80, and BaseLayout's `noindex` prop,
 * which /internal uses).
 *
 * The sitemap URL is built with routeFor() and absoluteUrl() rather than typed,
 * for the reason nav.ts's own header gives: a path written by hand is a path that
 * drifts. It resolves through SITE_ORIGIN, so a preview deploy advertises its own
 * sitemap and not production's.
 */
export const GET: APIRoute = () => {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl(routeFor('sitemap'))}`,
    ''
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};
