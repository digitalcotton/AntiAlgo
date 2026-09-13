/**
 * added-posting.ts: a posting a member added by URL, as a Job the engine can draft for.
 *
 * THE SLUG IS `added-<applicationId>`. generated_render.job_id holds a slug with
 * no foreign key (db/022), the job draft room and its PDF routes resolve a slug
 * through draftableJobBySlug(), and every added posting belongs to exactly one
 * desk_application row, so the application id is the one stable key. The
 * prefix keeps it apart from every published slug and lets draftableJobBySlug
 * route it to the owner-scoped population without a database miss first.
 *
 * WHAT THE ENGINE READS, AND WHAT IT NEVER READS. tailor.ts and
 * posting-requirements.ts read id, slug, title, company and description_html.
 * Nothing on the draft room or the Desk card prints the rest. So the verdict
 * fields a Job carries (fit, risk, ease, status, window, age) are filled with
 * their quietest honest value here and are never rendered: this population was
 * never swept, never scored, never re-verified. A future surface that lists
 * Jobs must exclude added slugs (isAddedSlug) rather than print those fields.
 *
 * source_system is 'custom', whose reader label is "the company site" and
 * whose apply label is "Apply on the company site": true of any URL a person
 * pasted, and the closest the table has to "not one of ours".
 */
import type { Job } from './data';
import type { StoredPostingFetch } from './posting-fetch-store';

export const ADDED_SLUG_PREFIX = 'added-';

export function isAddedSlug(slug: string): boolean {
  return slug.startsWith(ADDED_SLUG_PREFIX);
}

export function addedSlugFor(applicationId: number): string {
  return `${ADDED_SLUG_PREFIX}${applicationId}`;
}

/** The application id inside an added slug, or null when the slug is not one
    (or its tail is not a positive integer). */
export function addedApplicationId(slug: string): number | null {
  if (!isAddedSlug(slug)) return null;
  const tail = slug.slice(ADDED_SLUG_PREFIX.length);
  if (!/^[1-9]\d{0,17}$/.test(tail)) return null;
  const id = Number(tail);
  return Number.isSafeInteger(id) ? id : null;
}

/** The host of a URL, for a company name when the page gave none. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the company site';
  }
}

export function addedPostingToJob(row: StoredPostingFetch): Job {
  const slug = addedSlugFor(row.applicationId);
  const verifiedAt = row.fetchedAt ?? row.completedAt ?? row.createdAt;
  return {
    id: slug,
    slug,
    company: row.company ?? hostnameOf(row.url),
    title: row.title,
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Not stated',
    remote: false,
    source_system: 'custom',
    source_url: row.url,
    apply_url: row.url,
    first_observed: null,
    last_verified: verifiedAt.toISOString(),
    published_date: null,
    age_days: null,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: null,
    fit: { total: 0, title_scope: 0, remote_geo: 0, comp: 0, freshness: 0, apply_friction: 0 },
    description_html: row.descriptionHtml
  };
}

/** True for the base-free path of one added posting's detail page, and for
    nothing else under /board. Middleware resolves a viewer only for this shape. */
export function isAddedDetailPath(pathname: string): boolean {
  return /^\/board\/added-[1-9]\d{0,17}$/.test(pathname);
}

/** The notices the detail page and the Desk print after a posting intent
    bounced. Keyed by the `posting` query value the redirect carries. */
export const POSTING_NOTICES: Readonly<Record<string, string>> = {
  'bad-url': 'That link has to start with https. Paste the posting\'s own address.',
  'paste-incomplete': 'The pasted text and the company name are both needed to draft from it.'
};

/**
 * The board systems the mini reads through their own API, and the name each
 * one is called on the page. Mirrors postfetch.board_of on the mini: the same
 * host shapes, in the same order, so what the page says the machine did is
 * what the machine did. Eightfold is here and not in SOURCE_KINDS because the
 * mini reports an Eightfold read as kind 'page' (the API is fetched through
 * the page plan); readThrough() names it from the URL instead.
 */
export const BOARD_SYSTEMS = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workable: 'Workable',
  rippling: 'Rippling',
  workday: 'Workday',
  eightfold: 'Eightfold'
} as const;
export type BoardSystem = keyof typeof BOARD_SYSTEMS;

export interface PostingSource {
  ats: BoardSystem;
  /** The system's name as the page prints it. */
  label: string;
}

/** The board system a posting URL lives on, or null for a plain careers page. */
export function postingSource(url: string): PostingSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segs = parsed.pathname.split('/').filter(Boolean);
  const source = (ats: BoardSystem): PostingSource => ({ ats, label: BOARD_SYSTEMS[ats] });
  if (/^(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io$/.test(host) && segs.length >= 3 && segs[1] === 'jobs') {
    return source('greenhouse');
  }
  if (/^\d+$/.test(parsed.searchParams.get('gh_jid') ?? '')) return source('greenhouse');
  if (host === 'jobs.ashbyhq.com' && segs.length >= 2) return source('ashby');
  if (host === 'jobs.lever.co' && segs.length >= 2) return source('lever');
  if (host === 'apply.workable.com' && segs.length >= 3 && segs[1] === 'j') return source('workable');
  if (host === 'ats.rippling.com' && segs.length >= 3 && segs[1] === 'jobs') return source('rippling');
  if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(host) && segs.indexOf('job') >= 1) return source('workday');
  if (parsed.pathname.includes('/careers/job/') && /^[a-z0-9.-]+\.(net|com)$/.test(host)) return source('eightfold');
  return null;
}

/**
 * What the machine read the posting through, in the page's words, or null for
 * a row nothing was read for (pasted, or not settled yet). A board kind names
 * the board; the two page kinds say how far into the page the reader had to
 * go; a browser read says so, since it is the one expensive path.
 */
export function readThrough(row: Pick<StoredPostingFetch, 'sourceKind' | 'url'>): string | null {
  const kind = row.sourceKind;
  if (kind === null || kind === 'pasted') return null;
  if (kind === 'jsonld') return 'the page\'s own structured data';
  if (kind === 'browser') return 'a rendered copy of the page';
  if (kind === 'page') {
    return postingSource(row.url)?.ats === 'eightfold' ? 'Eightfold\'s board' : 'the page itself';
  }
  return `${BOARD_SYSTEMS[kind]}'s board`;
}

/** How long the read took, in words rather than a number, measured from the
    claim to the result. Null until both stamps exist. */
export function readTook(row: Pick<StoredPostingFetch, 'claimedAt' | 'completedAt'>): string | null {
  if (!row.claimedAt || !row.completedAt) return null;
  const ms = row.completedAt.getTime() - row.claimedAt.getTime();
  if (ms < 3_000) return 'in a moment';
  if (ms < 20_000) return 'in a few seconds';
  if (ms < 60_000) return 'in under a minute';
  return 'in a few minutes';
}
