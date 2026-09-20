import { indexUrl, withBase } from '../../site.config.mjs';
import { routeIsLit } from '../../flags.config.mjs';

/**
 * The route registry: the complete inventory of what this site emits, and
 * the only correct way to get a path into markup. Never type a path in a
 * page; call routeFor() for a static route, or one of the dynamic-route
 * builders below (jobPath, boardDetailPath, killCardPath, deskDraftPath,
 * jobDraftPath, jobDraftPdfPath, jobDraftRunPath) for one that takes a
 * parameter. That is what makes a route rename one edit.
 *
 * Merged from AntiAlgo's original marketing-only registry plus the Index's
 * board/desk/profile/settings routes now that the board lives locally at
 * /board (not a separate origin). AntiAlgo did not carry the Index's
 * PAGES/hrefFor/PageKey chrome-inventory concept — SiteHeader.astro builds
 * its own small nav array inline with routeFor() — so that machinery was not
 * ported; only ROUTES, routeFor(), the dynamic-path builders and
 * sitemapRoutes() were.
 */
export interface RouteEntry {
  key: string;
  /** Base-free, in Astro's own bracket form for a dynamic route. */
  pattern: string;
  kind: 'static' | 'dynamic' | 'asset';
  note: string;
  sitemap: boolean;
}

export const ROUTES = [
  // --- AntiAlgo's own marketing + account routes ---
  { key: 'start', pattern: '/', kind: 'static', note: 'The home / product page: what the machine does each night, and the waitlist.', sitemap: true },
  // 'index' is an alias for the same '/' pattern as 'start': the Index's own
  // board/marketing pages (copied in verbatim) call routeFor('index') for the
  // site root, while AntiAlgo's SiteHeader and marketing pages call
  // routeFor('start'). sitemap:false here so '/' is not double-listed —
  // 'start' above already carries it.
  { key: 'index', pattern: '/', kind: 'static', note: "Alias of 'start' for board code copied from the Index, which calls the site root 'index'.", sitemap: false },
  { key: 'how-it-works', pattern: '/how-it-works', kind: 'static', note: 'Five screens, in the order of your week: what each surface of the product answers.', sitemap: true },
  { key: 'evidence', pattern: '/evidence', kind: 'static', note: 'The research behind the claims, each figure with its source.', sitemap: true },
  { key: 'your-key', pattern: '/your-key', kind: 'static', note: 'Bring your own AI key: what it is, why it never touches our server, and the price.', sitemap: true },
  { key: 'the-account', pattern: '/the-account', kind: 'static', note: 'What the account opens: no account, account, paid, at one price. The signed-out tiers page.', sitemap: true },
  { key: 'sign-up', pattern: '/sign-up', kind: 'static', note: 'Create an account. Lands on the waitlist page while the waitlist flag is on.', sitemap: false },
  { key: 'sign-in', pattern: '/sign-in', kind: 'static', note: 'Sign in. Sends an already signed-in reader on rather than showing a form they do not need.', sitemap: false },
  { key: 'waitlist', pattern: '/waitlist', kind: 'static', note: 'The one page a waitlisted account sees: it exists, it is on the list, the board is public.', sitemap: false },
  // Beside the waitlist page, not under /api: the root api/ directory is a set
  // of Vercel functions that claims every /api/* path on the platform, so an
  // Astro route there is never reached (the same reason settings/export.ts and
  // settings/delete.ts live where they do).
  { key: 'waitlist-join', pattern: '/waitlist/join', kind: 'asset', note: 'POST. Saves an email on the waitlist and answers with its position in line.', sitemap: false },
  { key: 'account', pattern: '/account', kind: 'static', note: 'The signed-in account page, member tier and above.', sitemap: false },
  { key: 'internal', pattern: '/internal', kind: 'static', note: 'Exists so the internal gate is reachable and its denial is provable.', sitemap: false },

  // --- The board and its surfaces, copied in from the Index ---
  { key: 'board', pattern: '/board', kind: 'static', note: "The board: every tracked and posted role, verified last night, the site's main listing surface.", sitemap: true },
  { key: 'board-detail', pattern: '/board/[slug]', kind: 'dynamic', note: 'One tracked posting, rendered per request from the job store. The same page as /role, for the bulk tracker.', sitemap: false },
  { key: 'job', pattern: '/role/[slug]', kind: 'dynamic', note: 'One page per posting, live and closed variants. The SEO surface.', sitemap: true },
  { key: 'job-markdown', pattern: '/role/[slug].md', kind: 'asset', note: 'The markdown twin of a job page: same sections, same order, same absences, for a model reading the record.', sitemap: false },
  { key: 'job-card-image', pattern: '/role/[slug].og.svg', kind: 'asset', note: 'The social card for one posting. Vector, self contained, drawn from the token files.', sitemap: false },
  { key: 'kills', pattern: '/kills', kind: 'static', note: 'The kill list. What died this sweep, with the receipts.', sitemap: true },
  { key: 'kill-card', pattern: '/kills/[slug]/card', kind: 'dynamic', note: 'The single kill share card. One kill, its receipts, sized to be screenshotted.', sitemap: false },
  { key: 'kill-card-image', pattern: '/kills/[slug]/card.og.svg', kind: 'asset', note: 'The social card for one kill. What a platform fetches when the share card is posted.', sitemap: false },
  { key: 'report', pattern: '/report', kind: 'static', note: 'State of the market. The facts become the charts.', sitemap: true },
  { key: 'report-cover', pattern: '/report/cover', kind: 'static', note: 'The report cover, sized to be rasterised. Not a destination, so not in the sitemap.', sitemap: false },
  { key: 'report-card-image', pattern: '/report.og.svg', kind: 'asset', note: 'The social card for the report.', sitemap: false },
  { key: 'not-here', pattern: '/not-here', kind: 'static', note: 'Not here, on purpose. Each absence paired with the harm it prevents.', sitemap: true },
  // 'manifesto' is the Index's own key for this same page; alias for board
  // code copied in verbatim, same reasoning as 'index' above.
  { key: 'manifesto', pattern: '/not-here', kind: 'static', note: "Alias of 'not-here' for board code copied from the Index.", sitemap: false },
  { key: 'methodology', pattern: '/methodology', kind: 'static', note: 'How the machine works, the kill rules, the rubric and its weights, the legend.', sitemap: true },
  { key: 'colophon', pattern: '/colophon', kind: 'static', note: 'The stack, the gates, the conformance run, the decision log. How this was built is the argument.', sitemap: true },
  { key: 'data', pattern: '/data', kind: 'static', note: 'What the dataset is: method, coverage by population, history length, the kill rules link, the free monthly analysis, and two calls to action.', sitemap: true },
  { key: 'covenant', pattern: '/covenant', kind: 'static', note: 'The covenant: nine promises about money and observation, each marked checkable today or written before the feature.', sitemap: true },
  { key: 'drop', pattern: '/drop', kind: 'static', note: 'The weekly drop: what entered, what died, what changed, what is verified, with the sweep stamp on every number. Behind sign-in since 2026-09-20.', sitemap: false },
  { key: 'jobs-data', pattern: '/jobs-data', kind: 'static', note: 'Jobs Data (The Ledger until 2026-09-19): a paid, behind-login read of the market against the titles you watch, counted from last night, sweep stamp on every number.', sitemap: false },
  { key: 'ledger', pattern: '/ledger', kind: 'static', note: 'Deprecated 2026-09-19: the old address of Jobs Data, kept only as a permanent redirect to /jobs-data so saved links still land.', sitemap: false },
  { key: 'ledger-watch', pattern: '/ledger/watch', kind: 'asset', note: 'POST. Adds, removes or reshelves one watched title for the signed-in paid reader.', sitemap: false },
  { key: 'ledger-prefs', pattern: '/ledger/prefs', kind: 'asset', note: 'POST. Saves the Ledger filter chips for the signed-in paid reader.', sitemap: false },
  { key: 'privacy', pattern: '/privacy', kind: 'static', note: 'The privacy policy.', sitemap: true },
  { key: 'terms', pattern: '/terms', kind: 'static', note: 'The terms of use.', sitemap: true },
  { key: 'sitemap', pattern: '/sitemap.xml', kind: 'asset', note: 'Every indexable URL this site emits.', sitemap: false },
  { key: 'accessibility-report', pattern: '/accessibility-report.txt', kind: 'asset', note: 'The published accessibility receipt. Gate 1 writes it; nothing here does.', sitemap: false },
  { key: 'job-card-image-site', pattern: '/og.svg', kind: 'asset', note: 'The site card, and the default social image for every route that does not draw one of its own.', sitemap: false },

  // --- Auth pages ---
  { key: 'verify-email', pattern: '/verify-email', kind: 'static', note: 'Where a verification link lands. Dormant while email verification is off.', sitemap: false },
  { key: 'reset-password', pattern: '/reset-password', kind: 'static', note: 'Request a reset, and set a new password from a mailed link.', sitemap: false },

  // --- The Desk (the titles-driven member home) and the Opportunities tracker ---
  { key: 'desk', pattern: '/desk', kind: 'static', note: 'The Desk: the paid member home. Name the titles you want and the board narrows to them; a nightly read of what is new and what died under those titles.', sitemap: false },
  // 'come-ready', not 'start': the key 'start' already names the home page above.
  { key: 'come-ready', pattern: '/start', kind: 'static', note: "Come ready: the paid member's first run. Titles, key, resumé, cover letter and links, then the first draft. Behind the paid account.", sitemap: false },
  { key: 'opportunities', pattern: '/opportunities', kind: 'static', note: 'The applications tracker (formerly The Desk): what you did with an application vs what the sweep observed, two tracks, never one status. Behind sign-in.', sitemap: false },
  { key: 'desk-save', pattern: '/desk/save', kind: 'asset', note: 'POST. Saves or unsaves one verified posting for the signed-in account.', sitemap: false },
  { key: 'desk-application', pattern: '/desk/application', kind: 'asset', note: 'POST. Creates, confirms, transitions, archives or unarchives one application, by intent field.', sitemap: false },
  { key: 'desk-draft', pattern: '/desk/draft/[id]', kind: 'dynamic', note: "One application's drafted resume and cover, cited to the record.", sitemap: false },
  { key: 'desk-drafting-status', pattern: '/desk/drafting-status', kind: 'asset', note: 'GET. Whether applying would draft for the signed-in reader.', sitemap: false },
  { key: 'desk-job-draft', pattern: '/desk/job-draft', kind: 'asset', note: 'POST. Drafts a resume and cover for one verified posting.', sitemap: false },
  { key: 'desk-posting', pattern: '/desk/posting', kind: 'asset', note: 'POST. Adds a posting by URL, or pastes its text, retries a read, or renames it.', sitemap: false },
  { key: 'desk-job-draft-room', pattern: '/desk/job-draft/[slug]', kind: 'dynamic', note: "One posting's drafted resume and cover from the one-click button.", sitemap: false },
  { key: 'desk-job-draft-pdf', pattern: '/desk/job-draft/[slug]/[doc]', kind: 'dynamic', note: 'GET. One drafted document as a print-ready PDF.', sitemap: false },
  { key: 'desk-job-draft-status', pattern: '/desk/job-draft/[slug]/status', kind: 'dynamic', note: "GET. Whether this posting's draft is unstarted, drafting, ready or failed.", sitemap: false },
  { key: 'desk-job-draft-run', pattern: '/desk/job-draft/[slug]/run', kind: 'dynamic', note: 'POST. Renders one document of a job draft in its own invocation; signed-token only.', sitemap: false },

  // --- The machine (server-to-server, Mac mini) ---
  { key: 'machine-posting-fetch-claim', pattern: '/machine/posting-fetch/claim', kind: 'asset', note: 'GET. The machine claims the next queued posting to read.', sitemap: false },
  { key: 'machine-posting-fetch-result', pattern: '/machine/posting-fetch/result', kind: 'asset', note: 'POST. The machine returns a posting it read.', sitemap: false },

  // --- The Pre-List ---
  { key: 'prelist', pattern: '/prelist', kind: 'static', note: 'Companies the machine scored before they posted a role. Behind sign-in.', sitemap: true },
  { key: 'prelist-follow', pattern: '/prelist/follow', kind: 'asset', note: 'POST. Follows or unfollows one pre-posting company.', sitemap: false },

  // --- Profile / drafts / handle ---
  { key: 'profile', pattern: '/profile', kind: 'static', note: 'Your own profile: identity header and the Profile Record, editable in place.', sitemap: false },
  { key: 'profile-entry', pattern: '/profile/entry', kind: 'asset', note: 'POST. Creates, updates or deletes one Profile Record entry, by intent field.', sitemap: false },
  { key: 'profile-artifact', pattern: '/profile/artifact', kind: 'asset', note: 'POST. Adds or removes one artifact on a Profile Record entry.', sitemap: false },
  { key: 'profile-import', pattern: '/profile/import', kind: 'asset', note: 'POST. Creates Profile Record entries from a parsed resume.', sitemap: false },
  { key: 'profile-import-parse', pattern: '/profile/import/parse', kind: 'asset', note: 'POST. Reads an uploaded resume (or pasted text) into reviewable proposals.', sitemap: false },
  { key: 'profile-import-cover', pattern: '/profile/import/cover', kind: 'asset', note: 'POST. Stores a cover letter on file and proposes its facts into the record.', sitemap: false },
  { key: 'profile-import-status', pattern: '/profile/import/status', kind: 'asset', note: 'GET. Whether the resume read is unstarted, reading or ready.', sitemap: false },
  { key: 'profile-review', pattern: '/profile/review', kind: 'static', note: 'The review screen for an uploaded resume.', sitemap: false },
  { key: 'profile-link', pattern: '/profile/link', kind: 'asset', note: 'POST. Adds or removes one job-related profile link.', sitemap: false },
  { key: 'account-handle', pattern: '/u/[handle]', kind: 'dynamic', note: 'A claimed handle, rendered for its owner and nobody else.', sitemap: false },
  { key: 'drafts', pattern: '/drafts/[slug]', kind: 'dynamic', note: 'One outbound draft as a gated shop window.', sitemap: false },

  // --- Settings ---
  { key: 'settings', pattern: '/settings', kind: 'static', note: 'Name, email, handle, drafting with provider keys, and download or delete your data.', sitemap: false },
  { key: 'settings-export', pattern: '/settings/export', kind: 'asset', note: "GET. Downloads the signed-in account's data as one JSON file.", sitemap: false },
  { key: 'settings-delete', pattern: '/settings/delete', kind: 'asset', note: 'POST. Deletes the signed-in account.', sitemap: false },
  { key: 'settings-keys-save', pattern: '/settings/keys/save', kind: 'asset', note: 'POST. Adds or replaces one provider key for the signed-in account.', sitemap: false },
  { key: 'settings-keys-remove', pattern: '/settings/keys/remove', kind: 'asset', note: 'POST. Permanently deletes one provider key for the signed-in account.', sitemap: false },
  { key: 'settings-name', pattern: '/settings/name', kind: 'asset', note: 'POST. Changes the name on the signed-in account.', sitemap: false },
  { key: 'settings-email', pattern: '/settings/email', kind: 'asset', note: 'POST. Starts Better Auth two-step change of email.', sitemap: false },
  { key: 'settings-resume-email', pattern: '/settings/resume-email', kind: 'asset', note: 'POST. Sets which email a drafted resume prints.', sitemap: false },
  { key: 'settings-handle', pattern: '/settings/handle', kind: 'asset', note: 'POST. Claims, changes, or releases the signed-in account handle.', sitemap: false },
  { key: 'settings-generation', pattern: '/settings/generation', kind: 'asset', note: 'POST. Toggles whether applying drafts a tailored resume and cover in the background.', sitemap: false },
  { key: 'settings-model', pattern: '/settings/model', kind: 'asset', note: "POST. Records which of a connected provider's models drafts.", sitemap: false },
  { key: 'settings-filters', pattern: '/settings/filters', kind: 'asset', note: "GET and POST. The signed-in account's saved index filter selection.", sitemap: false }
] as const satisfies readonly RouteEntry[];

export type RouteKey = (typeof ROUTES)[number]['key'];

const ROUTE_BY_KEY = new Map<string, RouteEntry>(ROUTES.map((r) => [r.key, r as RouteEntry]));

/** The served path for a static route, base included. Throws on a key nobody
 *  registered, and on a dynamic route (build those with the per-key path
 *  builders below so the parameter cannot be forgotten). */
export function routeFor(key: RouteKey): string {
  const route = ROUTE_BY_KEY.get(key);
  if (!route) throw new Error(`nav.ts: no route registered under "${key}".`);
  if (route.kind === 'dynamic') {
    throw new Error(`nav.ts: "${key}" is a dynamic route (${route.pattern}). Build it with its dedicated path helper instead.`);
  }
  return withBase(route.pattern);
}

// A route behind a dark flag (flags.config.mjs FLAGGED_ROUTES) is a 404, so
// it is never listed however its own sitemap field reads.
export const sitemapRoutes = (): readonly RouteEntry[] =>
  ROUTES.filter((r) => r.sitemap && r.kind === 'static' && routeIsLit(r.pattern));

// --- Dynamic-route path builders, one per parameterised pattern above. Never
// type these paths by hand; the board and desk pages import these. ---

/** The canonical path for one posting. */
export const jobPath = (slug: string): string => withBase(`/role/${slug}`);
/** The markdown twin of one posting. */
export const jobMarkdownPath = (slug: string): string => withBase(`/role/${slug}.md`);
/** The social card for one posting. */
export const jobCardImagePath = (slug: string): string => withBase(`/role/${slug}.og.svg`);
/** The board detail page for one crawled (or member-added) posting. */
export const boardDetailPath = (slug: string): string => withBase(`/board/${slug}`);
/** The canonical path for one kill's share card. */
export const killCardPath = (slug: string): string => withBase(`/kills/${slug}/card`);
/** The social card a platform fetches for one kill's share card. */
export const killCardImagePath = (slug: string): string => withBase(`/kills/${slug}/card.og.svg`);
/** The draft room for one application. */
export const deskDraftPath = (id: string): string => withBase(`/desk/draft/${id}`);
/** The job draft room for one posting (the one-click button's result page). */
export const jobDraftPath = (slug: string): string => withBase(`/desk/job-draft/${slug}`);
/** The PDF download for one job draft's resume or cover. */
export const jobDraftPdfPath = (slug: string, doc: 'resume' | 'cover'): string =>
  withBase(`/desk/job-draft/${slug}/${doc}`);
/** The per-document render hand-off for one job draft (server-to-server). */
export const jobDraftRunPath = (slug: string): string => withBase(`/desk/job-draft/${slug}/run`);
/** A file that ships from public/ rather than from a route (the font cuts). */
export const publicAsset = (path: string): string => withBase(path);

/**
 * The index's own pages, which this site links to and never restates. Every
 * one goes through indexUrl(), which (since the board copy-over) resolves to
 * this same origin rather than a foreign one — see site.config.mjs.
 */
export const INDEX = {
  board: indexUrl('/board'),
  kills: indexUrl('/kills'),
  killsByRule: `${indexUrl('/kills')}#by-rule`,
  report: indexUrl('/report'),
  methodology: indexUrl('/methodology'),
  covenant: indexUrl('/covenant'),
  notHere: indexUrl('/not-here'),
  prelist: indexUrl('/prelist'),
  desk: indexUrl('/desk')
} as const;

/** The share card the index draws for one kill, from its own record. */
export const killCardUrl = (slug: string): string => indexUrl(`/kills/${slug}/card`);
export const killCardImageUrl = (slug: string): string => indexUrl(`/kills/${slug}/card.og.svg`);
