import { BASE_PATH, SITE_ORIGIN, SITE_URL, withBase } from '../../site.config.mjs';

/**
 * Site-level facts, in one place. Anti Algo is now the whole product (the
 * marketing pages plus the copied-in job board and everything behind
 * sign-in), all served from this one origin. Nothing here is sweep data;
 * anything that changes when the machine runs is read through src/lib/data.ts
 * (board) or src/lib/stats.ts (marketing feeds).
 */
export const SITE = {
  name: 'Anti Algo',
  /** The domain as it is printed in chrome, from the how-it-works canvas. */
  domain: 'antialgo.ai',
  /** The byline under the wordmark, verbatim from the canvas. */
  byline: 'swept nightly from one Mac mini',
  url: SITE_URL,
  origin: SITE_ORIGIN,
  basePath: BASE_PATH,
  description:
    'The verified job index for design and AI roles. A machine re-checks every posting at the company\'s own careers page nightly, kills the dead ones by published rule, and prints the night it read every number. Save your spot.',
  /** The default social image for any route that does not draw its own. */
  ogImage: withBase('/og.svg'),
  /** The product this site markets. */
  product: { name: 'The Index' },
  parent: { name: 'tokenstoagents.ai', url: 'https://tokenstoagents.ai' },
  /** Where a correction goes. The same inbox the index names. */
  contact: 'ryan@tokenstoagents.ai',
  locale: 'en_US',
  author: { name: 'Ryan Payne', url: 'https://uxmonopoly.com' }
} as const;

/** The absolute URL for a path this repository built. Every path out of
 *  nav.ts already carries the base, so this joins to `origin`, never `url`
 *  (joining to `url` would double the prefix on a based deployment). */
export const absoluteUrl = (path: string): string => `${SITE.origin}${path}`;

/** The same URL with the scheme stripped, for an address printed to be read
 *  (share cards, print footers) rather than clicked. */
export const displayUrl = (path: string): string => absoluteUrl(path).replace(/^https?:\/\//, '');

/**
 * Where the capture form posts, or null while nothing should be wired.
 *
 * The Index's copy of this constant was null because that build had no
 * server adapter at all. AntiAlgo does have one (@astrojs/vercel) plus a real
 * `api/subscribe.ts`, but wiring the waitlist to it live is a product
 * decision (what platform actually receives the address) beyond "make the
 * build compile" — so this stays null for now, same dormant posture as
 * email verification, and CaptureModule.astro already renders the honest
 * "nowhere to post yet" state when it is.
 */
export const SUBSCRIBE_ENDPOINT: string | null = null;
