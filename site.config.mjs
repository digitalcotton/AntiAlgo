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
 * Where the job index lives today. Every link to the board, the kill list,
 * the methodology and the rest goes through indexUrl(), so the day the index
 * moves onto this origin, this is the one value that changes.
 */
export const INDEX_URL = 'https://tokenstoagents.ai/jobs';

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
