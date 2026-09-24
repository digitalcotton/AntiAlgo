/**
 * Where this site is served, and where the job index it markets is served,
 * written once.
 *
 * A plain .mjs at the root, the same shape as the index's own site.config.mjs,
 * because four consumers have to agree about these values and none can import
 * the others' language: astro.config.mjs (plain ESM), the TypeScript under Vite, the Node scripts, and the tests.
 *
 * THE DOMAIN IS NOT DECIDED YET, AND THIS FILE DOES NOT INVENT ONE. The origin
 * is read from the environment: SITE_ORIGIN when the owner sets it (the day the
 * domain exists, that is the one edit), otherwise the production URL Vercel
 * injects for the project, otherwise the preview URL, otherwise localhost.
 * Nothing in this repository writes a vercel.app host by hand.
 */
import './load-local-env.mjs';

function fromEnv() {
  if (process.env.SITE_ORIGIN) return process.env.SITE_ORIGIN.replace(/\/$/, '');

  // A PREVIEW MUST NOT CALL ITSELF PRODUCTION. Vercel injects
  // VERCEL_PROJECT_PRODUCTION_URL on EVERY environment, including previews, so
  // the production branch below used to win on a preview deploy and this origin
  // resolved to www.antialgo.ai while serving from a branch URL. Three things
  // went wrong at once and all of them silently:
  //
  //   - src/lib/auth.ts's baseURL() is this value, so Better Auth signed its
  //     cookies for an origin the browser was not on. Sign-in simply did not work
  //     on a preview, with nothing in any log saying why.
  //   - every canonical URL, OG image and sitemap entry on the preview pointed at
  //     production, so a preview could never be checked for those at all.
  //   - src/lib/stats.ts and src/lib/kills.ts fetch this origin while rendering.
  //     A preview was reading PRODUCTION's numbers and showing them as its own,
  //     which makes a preview useless as a test of a data change.
  //
  // VERCEL_ENV is 'production' only on a production deploy, so a preview now
  // resolves to its own host. VERCEL_BRANCH_URL first because it is stable per
  // branch, which is what an auth callback and a bookmarked preview both need;
  // VERCEL_URL changes with every deployment.
  const production = process.env.VERCEL_ENV === 'production';
  if (!production) {
    if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:4321';
}

/** The public origin of this site. */
export const SITE_ORIGIN = fromEnv();

/** Served at the root. Kept as a constant so the path helpers below match the index's. */
export const BASE_PATH = '';

export const SITE_URL = `${SITE_ORIGIN}${BASE_PATH}`;

/**
 * Where the job index lives today: this same origin. It used to be a separate
 * property (tokenstoagents.ai/jobs) reached cross-origin; the board is now
 * copied into this repo and served locally, so indexUrl() resolves against
 * this site's own SITE_URL instead of a foreign host. Every link to the
 * board, the kill list, the methodology and the rest still goes through
 * indexUrl(), so a future re-split back onto its own origin is still one
 * edit here.
 */
export const INDEX_URL = SITE_URL;

/**
 * The Vercel function ceiling, in seconds. Read by astro.config.mjs (the
 * adapter's maxDuration) and by the job-draft state math
 * (src/lib/generated-render-store.ts's jobDraftState), so a row that has been
 * "pending" longer than the platform could possibly still be working on it is
 * reported as failed, and the two can never disagree about how long that is.
 * 300 is the Fluid compute maximum on every plan (Hobby caps here; Pro allows
 * more) — a draft's provider calls run after the response, in a fresh
 * invocation per document (src/lib/draft-run-dispatch.ts), held alive by
 * waitUntil for up to this long.
 */
export const FUNCTION_MAX_DURATION_S = 300;

/** The endpoint the index publishes its sweep totals at. Read, never typed. */
export const INDEX_STATS_URL = `${INDEX_URL}/board/stats.json`;

/**
 * The endpoint the index publishes its recent kill records at, the rows behind
 * the kill count, for the evidence page to render live. Read, never typed. The
 * env override lets local development point at a local index dev server, since
 * INDEX_URL is the production origin; production leaves it unset and reads the
 * live feed.
 */
export const INDEX_KILLS_URL = process.env.INDEX_KILLS_URL || `${INDEX_URL}/board/kills.json`;

export function withBase(path) {
  if (!BASE_PATH) return path;
  if (path === '/') return BASE_PATH;
  return `${BASE_PATH}${path}`;
}

export function stripBase(path) {
  if (!BASE_PATH) return path;
  if (path === BASE_PATH) return '/';
  if (path.startsWith(`${BASE_PATH}/`)) return path.slice(BASE_PATH.length);
  return path;
}

/** An absolute URL on the index. `/kills` becomes `https://tokenstoagents.ai/jobs/kills`. */
export function indexUrl(path = '/') {
  if (path === '/') return INDEX_URL;
  return `${INDEX_URL}${path}`;
}

/**
 * The product's launch, from the Anti Algo home canvas. "Product opens" and the
 * "days to launch" countdown both read this one date, and the day count is
 * DERIVED from it (never typed), so the number is right on every day without an
 * edit. Move launch by changing this one constant.
 */
export const LAUNCH_DATE = '2026-11-10T00:00:00Z';

/** Whole days from now until launch, floored at zero. Derived, never typed. */
export function daysToLaunch(now = new Date()) {
  const ms = new Date(LAUNCH_DATE).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/**
 * A number added to the live count of waitlisted accounts before it is shown as
 * "in line". Zero by default, so the figure is the real count and nothing is
 * invented. The home canvas drew 412; set this to seed the displayed line to a
 * starting number the owner stands behind. It never changes who is actually on
 * the list, only the number printed beside the action.
 */
export const WAITLIST_BASELINE = 0;
