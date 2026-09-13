import { indexUrl, withBase } from '../../site.config.mjs';

/**
 * The route registry: the complete inventory of what this site emits, and
 * the only correct way to get a path into markup. Never type a path in a
 * page; call routeFor(). That is what makes a route rename one edit.
 */
export interface RouteEntry {
  key: string;
  /** Base-free, in Astro's own bracket form for a dynamic route. */
  pattern: string;
  kind: 'static' | 'asset';
  note: string;
  sitemap: boolean;
}

export const ROUTES = [
  { key: 'start', pattern: '/', kind: 'static', note: 'The home / product page: what the machine does each night, and the waitlist.', sitemap: true },
  { key: 'how-it-works', pattern: '/how-it-works', kind: 'static', note: 'Five screens, in the order of your week: what each surface of the product answers.', sitemap: true },
  { key: 'evidence', pattern: '/evidence', kind: 'static', note: 'The research behind the claims, each figure with its source.', sitemap: true },
  { key: 'your-key', pattern: '/your-key', kind: 'static', note: 'Bring your own AI key: what it is, why it never touches our server, and the price.', sitemap: true },
  { key: 'sign-up', pattern: '/sign-up', kind: 'static', note: 'Create an account. Lands on the waitlist page while the waitlist flag is on.', sitemap: false },
  { key: 'sign-in', pattern: '/sign-in', kind: 'static', note: 'Sign in. Sends an already signed-in reader on rather than showing a form they do not need.', sitemap: false },
  { key: 'waitlist', pattern: '/waitlist', kind: 'static', note: 'The one page a waitlisted account sees: it exists, it is on the list, the board is public.', sitemap: false },
  { key: 'account', pattern: '/account', kind: 'static', note: 'The signed-in account page, member tier and above.', sitemap: false },
  { key: 'internal', pattern: '/internal', kind: 'static', note: 'Exists so the internal gate is reachable and its denial is provable.', sitemap: false },
  { key: 'sitemap', pattern: '/sitemap.xml', kind: 'asset', note: 'Every indexable URL this site emits.', sitemap: false }
] as const satisfies readonly RouteEntry[];

export type RouteKey = (typeof ROUTES)[number]['key'];

const ROUTE_BY_KEY = new Map<string, RouteEntry>(ROUTES.map((r) => [r.key, r]));

export function routeFor(key: RouteKey): string {
  const route = ROUTE_BY_KEY.get(key);
  if (!route) throw new Error(`nav.ts: no route registered under "${key}".`);
  return withBase(route.pattern);
}

export const sitemapRoutes = (): readonly RouteEntry[] => ROUTES.filter((r) => r.sitemap && r.kind === 'static');

/**
 * The index's own pages, which this site links to and never restates. Every
 * one goes through indexUrl(), so the day the index moves onto this origin
 * one constant changes and none of these do.
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
