import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { BASE_PATH, FUNCTION_MAX_DURATION_S, SITE_ORIGIN } from './site.config.mjs';

/**
 * The two review surfaces, injected rather than filed under src/pages.
 *
 * WHY THEY WERE DARK. src/review/specimen.astro (1,876 lines) and
 * src/review/states.astro (611 lines) came across from the Index with the rest
 * of the app. The integration that serves them did not, so both have sat in this
 * repository as maintained, type-checked, completely unreachable files. Nothing
 * has ever rendered them here.
 *
 * WHY THEY MATTER TO THE GATE. Every page worth watching in this app renders
 * per-request from a database whose rows change nightly, which is precisely what
 * killed the Index's screenshot gate: it photographed 96 built job pages, 85 of
 * them one template with rotating content, and every baseline failed the day
 * after it was recorded. These two routes are the opposite kind of surface. They
 * render the REAL components against fixed, authored fixtures — empty, loading,
 * error, dark, mobile — so a pixel changes only when a component changes. They
 * are the one honest place in this codebase to compare an image against a
 * baseline.
 *
 * WHY NOT src/pages/_states.astro. An underscore in src/pages means "not a
 * route" to the file router, and the Index's own config records that fighting
 * the router over this does not work: an entrypoint outside src/pages emits
 * every time, with or without an underscore. src/review/ is not a tidier
 * address, it is the fix.
 *
 * WHAT MUST STAY TRUE. `astro dev` serves them, `SPECIMEN=1 astro build` emits
 * them into dist-review/, and a plain `astro build` must not emit them at all.
 * scripts/route-census.mjs asserts both halves by running both builds rather
 * than reading this file and reasoning about a copy of the rule. The Index's
 * census header records why: a review route that was injected only under one of
 * the two conditions meant a conformance run "measured one route and reported
 * six passes".
 */
const reviewRoutes = {
  name: 'review-routes',
  hooks: {
    'astro:config:setup': ({ command, injectRoute }) => {
      if (command !== 'dev' && process.env.SPECIMEN !== '1') return;
      injectRoute({ pattern: '/_specimen', entrypoint: './src/review/specimen.astro' });
      injectRoute({ pattern: '/_states', entrypoint: './src/review/states.astro' });
    }
  }
};

/**
 * Static by default, with the Vercel adapter for the routes that cannot be:
 * the auth handler, sign-up, sign-in, the waitlist page, the board and
 * everything behind sign-in copied in from the Index (the Desk, drafts,
 * profile, settings, prelist), and the product page (which reads the sweep
 * totals per request). A route becomes dynamic only by saying
 * `export const prerender = false` in its own file.
 *
 * `security.checkOrigin` is OFF. Astro's built-in check compares the browser
 * Origin to the Host header, which on Vercel is the internal deploy host, not
 * the public www.antialgo.ai the browser posts from (that arrives only in
 * x-forwarded-host), so it refused every legitimate form POST (proven in
 * production 2026-09-18: a POST with a matching www.antialgo.ai Origin was
 * still 403'd). The CSRF defense moves into src/middleware.ts's ORIGIN GATE
 * (isAllowedOrigin), which checks the Origin against the real forwarded host
 * and this site's own hosts, the same hand-rolled guard the Index runs.
 *
 * maxDuration: the job draft's provider calls finish AFTER the response goes
 * out, held alive by waitUntil, which inherits this ceiling. The number lives
 * in site.config.mjs (FUNCTION_MAX_DURATION_S) so the state math that
 * declares an abandoned render (src/lib/generated-render-store.ts) reads the
 * same value this adapter is configured with. Requires Fluid compute on for
 * the Vercel project.
 */
export default defineConfig({
  site: SITE_ORIGIN,
  base: BASE_PATH,
  adapter: vercel({ maxDuration: FUNCTION_MAX_DURATION_S }),
  integrations: [reviewRoutes],
  trailingSlash: 'never',
  security: { checkOrigin: false },
  markdown: { smartypants: false },
  build: { inlineStylesheets: 'auto' }
});
