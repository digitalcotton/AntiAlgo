import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { BASE_PATH, FUNCTION_MAX_DURATION_S, SITE_ORIGIN } from './site.config.mjs';

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
  trailingSlash: 'never',
  security: { checkOrigin: false },
  markdown: { smartypants: false },
  build: { inlineStylesheets: 'auto' }
});
