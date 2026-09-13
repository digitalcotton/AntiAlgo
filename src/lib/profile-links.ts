/**
 * profile-links.ts: the pure half of a person's job-related links. The
 * vocabulary (which platforms exist, how they are labeled) and the one
 * decision that matters, whether a typed string is a URL safe to store and
 * later render as an href. No database here: src/lib/record-store.ts is the
 * impure half that reads and writes db/014_profile_link.sql's one table, the
 * same split record.ts draws against record-store.ts.
 *
 * WHY SCHEME VALIDATION LIVES HERE AND NOT ONLY IN THE DATABASE. A stored URL
 * is rendered back as an <a href> on the profile page. A value like
 * "javascript:..." or "data:..." rendered into an href is a script-execution
 * vector, so normaliseLinkUrl() below refuses any scheme but http and https
 * before a row is ever written. db/014's own CHECK is a length floor under
 * this, not a substitute for it: SQL has no URL parser, and half a scheme
 * check written in a CHECK constraint would be a second, weaker copy to keep
 * in sync with this one.
 */

/** The job-related platforms a link can name. Kept in step with
    db/014_profile_link.sql's platform CHECK, a hand-kept pair the same way
    keychain.ts's PROVIDERS and db/007's provider CHECK already are. */
export type LinkPlatform =
  | 'linkedin'
  | 'github'
  | 'twitter'
  | 'bluesky'
  | 'dribbble'
  | 'behance'
  | 'mastodon'
  | 'website'
  | 'portfolio'
  | 'other';

/** The platforms in the order the add-a-link dropdown offers them, each with
    the label a person reads. LinkedIn and GitHub first because they are the
    two nearly everyone applying for a design or engineering role has; a plain
    "Personal website" and "Portfolio" near the end because not every link is a
    named platform; "Other" last, for anything this list does not name. */
export const LINK_PLATFORMS: readonly { id: LinkPlatform; label: string }[] = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'github', label: 'GitHub' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'website', label: 'Personal website' },
  { id: 'dribbble', label: 'Dribbble' },
  { id: 'behance', label: 'Behance' },
  { id: 'twitter', label: 'Twitter / X' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'other', label: 'Other' }
];

/** Just the ids, for the endpoint's own membership check and to mirror the
    database CHECK. Derived from LINK_PLATFORMS so the two never drift. */
export const LINK_PLATFORM_IDS: readonly LinkPlatform[] = LINK_PLATFORMS.map((p) => p.id);

const LABEL_BY_ID = new Map<LinkPlatform, string>(LINK_PLATFORMS.map((p) => [p.id, p.label]));

/** The reader-facing label for one platform id. */
export function linkPlatformLabel(platform: LinkPlatform): string {
  return LABEL_BY_ID.get(platform) ?? platform;
}

export function isLinkPlatform(value: unknown): value is LinkPlatform {
  return typeof value === 'string' && (LINK_PLATFORM_IDS as readonly string[]).includes(value);
}

/** One stored link, the shape the rest of the app reads. `id` is the row's
    own key, the value a remove call targets. */
export interface StoredLink {
  id: string;
  platform: LinkPlatform;
  url: string;
  createdAt: Date;
}

/** The longest a stored URL may be, matching db/014's CHECK. */
export const MAX_LINK_URL_LENGTH = 500;

export type LinkUrlResult = { ok: true; url: string; platform: LinkPlatform } | { ok: false; reason: string };

/** Which known platform a hostname belongs to, or 'website' for anything this
    list does not name. Matched on the registrable-domain suffix so a subdomain
    (www.github.com, gist.github.com) still resolves. This is why the add-a-link
    form no longer asks a person to pick a platform a URL already names: paste
    the link, and we read what it is. */
const HOST_TO_PLATFORM: readonly { suffix: string; platform: LinkPlatform }[] = [
  { suffix: 'linkedin.com', platform: 'linkedin' },
  { suffix: 'github.com', platform: 'github' },
  { suffix: 'github.io', platform: 'github' },
  { suffix: 'dribbble.com', platform: 'dribbble' },
  { suffix: 'behance.net', platform: 'behance' },
  { suffix: 'twitter.com', platform: 'twitter' },
  { suffix: 'x.com', platform: 'twitter' },
  { suffix: 'bsky.app', platform: 'bluesky' },
  { suffix: 'mastodon.social', platform: 'mastodon' },
  { suffix: 'mastodon.online', platform: 'mastodon' }
];

export function detectPlatform(hostname: string): LinkPlatform {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const { suffix, platform } of HOST_TO_PLATFORM) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return platform;
  }
  return 'website';
}

/**
 * Turns a typed string into a URL safe to store and later render as an href,
 * or refuses it with a reason a person can act on. The reason never echoes
 * anything but a description of the problem, never re-runs a script, and never
 * carries the input back verbatim into an attribute.
 *
 * A person may type "github.com/name" without a scheme; a missing scheme is
 * read as https, the same forgiving default a browser's address bar uses,
 * rather than refused. Everything else is strict: the result must parse as a
 * URL, its scheme must be http or https (this is the check that keeps a
 * javascript: or data: URL out of an href), it must have a host, and the
 * whole thing must fit db/014's length cap.
 */
export function normaliseLinkUrl(raw: string): LinkUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'a link cannot be empty' };
  }

  // A string with no scheme (no "http://", and not itself a "something:" that
  // a URL parser would read as a scheme) is treated as https. The test is
  // deliberately narrow: only prepend when the string does not already start
  // with a scheme, so "javascript:alert(1)" is left as-is and then refused by
  // the protocol check below, rather than turned into "https://javascript:..."
  // and quietly accepted.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'that does not look like a web address' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https links are allowed' };
  }

  if (parsed.hostname.length === 0) {
    return { ok: false, reason: 'that link is missing a website name' };
  }

  const url = parsed.toString();
  if (url.length > MAX_LINK_URL_LENGTH) {
    return { ok: false, reason: `a link must be ${MAX_LINK_URL_LENGTH} characters or fewer` };
  }

  return { ok: true, url, platform: detectPlatform(parsed.hostname) };
}
