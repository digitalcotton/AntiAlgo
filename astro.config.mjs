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
 * `security.checkOrigin` stays at Astro's default of true. This site is served
 * from its own origin with no rewrite in front of it, so the framework's own
 * CSRF check is correct here, unlike the Index's old deployment behind the
 * mothership's proxy (which is why its own astro.config.mjs turned this off —
 * that reason does not apply once the board is served from this same origin,
 * so that override is deliberately not carried over).
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
  markdown: { smartypants: false },
  build: { inlineStylesheets: 'auto' }
});
