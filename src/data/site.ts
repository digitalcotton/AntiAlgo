import { BASE_PATH, SITE_ORIGIN, SITE_URL } from '../../site.config.mjs';

/**
 * Site-level facts, in one place. This is Anti Algo, the marketing site for
 * The Index: the board and everything behind sign-in live on the index at
 * tokenstoagents.ai/jobs, and this site is the front door and the waitlist.
 * Nothing here is sweep data; anything that changes when the machine runs is
 * read through src/lib/stats.ts.
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
  /** The product this site markets. */
  product: { name: 'The Index' },
  parent: { name: 'tokenstoagents.ai', url: 'https://tokenstoagents.ai' },
  /** Where a correction goes. The same inbox the index names. */
  contact: 'ryan@tokenstoagents.ai',
  locale: 'en_US',
  author: { name: 'Ryan Payne', url: 'https://uxmonopoly.com' }
} as const;

export const absoluteUrl = (path: string): string => `${SITE.origin}${path}`;
