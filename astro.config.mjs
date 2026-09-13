import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { BASE_PATH, SITE_ORIGIN } from './site.config.mjs';

/**
 * Static by default, with the Vercel adapter for the routes that cannot be:
 * the auth handler, sign-up, sign-in, the waitlist page and the product page
 * (which reads the index's live sweep totals per request). A route becomes
 * dynamic only by saying `export const prerender = false` in its own file.
 *
 * `security.checkOrigin` stays at Astro's default of true. This site is served
 * from its own origin with no rewrite in front of it, so the framework's own
 * CSRF check is correct here, unlike the index behind the mothership's proxy.
 */
export default defineConfig({
  site: SITE_ORIGIN,
  base: BASE_PATH,
  adapter: vercel(),
  trailingSlash: 'never',
  markdown: { smartypants: false },
  build: { inlineStylesheets: 'auto' }
});
