import { routeFor } from './nav';
import { withBase } from '../../site.config.mjs';

/**
 * The signed-in chrome's navigation, in one place.
 *
 * TWO LISTS, ONE SOURCE. MEMBER_NAV is the signed-in reader's surfaces (Index,
 * The Desk, Pre-List, The Drop, Profile, Settings); ACCOUNT_MENU is the short
 * Account disclosure (Profile, Settings, Sign out). SiteFooter.astro's "Your
 * desk" group and the Profile page's no-JS "Your surfaces" nav both render
 * MEMBER_NAV; SiteHeader.astro's Account menu renders ACCOUNT_MENU. Typing any
 * of those by hand is the day the header ends up with a link the footer forgot.
 *
 * EVERY HREF GOES THROUGH routeFor() (src/data/nav.ts), which only knows routes
 * registered in ROUTES and throws for anything else, so an entry here cannot
 * outlive its route or survive a rename in one file and not the other.
 *
 * `built: false` MARKS A DESTINATION WHOSE PAGE HAS NOT SHIPPED, and every
 * consumer renders it as plain text rather than an anchor, so this list can
 * never point a reader at a 404. Everything here is built today; the flag stays
 * for the next entry announced before its page exists. Written through
 * withBase() plus `built: false` going in, routeFor() plus `built: true` on the
 * day the page exists, never one without the other, and flipped in the same
 * task that ships the route, never before.
 */

export interface MemberNavItem {
  key: string;
  label: string;
  href: string;
  /** False until the page exists. A false entry renders as text, never an
   *  anchor, so this list can never point a reader at a 404. */
  built: boolean;
}

/** The signed-in reader's own surfaces: the footer's "Your desk" group and the
 *  Profile page's no-JS "Your surfaces" nav. */
export const MEMBER_NAV: MemberNavItem[] = [
  { key: 'index', label: 'Index', href: routeFor('index'), built: true },
  { key: 'desk', label: 'The Desk', href: routeFor('desk'), built: true },
  { key: 'prelist', label: 'Pre-List', href: routeFor('prelist'), built: true },
  { key: 'drop', label: 'The Drop', href: routeFor('drop'), built: true },
  { key: 'profile', label: 'Profile', href: routeFor('profile'), built: true },
  { key: 'settings', label: 'Settings', href: routeFor('settings'), built: true }
];

/** A link row in the account menu: everything except sign out. */
export interface AccountMenuLink extends MemberNavItem {
  kind: 'link';
}

/** The one row that is not a link: Better Auth's sign-out is a POST, so this
 *  renders as a form with a submit button, never an anchor. */
export interface AccountMenuAction {
  key: 'sign-out';
  label: string;
  kind: 'action';
}

export type AccountMenuEntry = AccountMenuLink | AccountMenuAction;

/** The Account disclosure's contents: SiteHeader.astro's signed-in menu. Two
 *  destinations and the sign-out. Everything a person does lives on one of the
 *  two pages, so the menu stays short: who you are, how it behaves, and out. */
export const ACCOUNT_MENU: AccountMenuEntry[] = [
  { key: 'profile', label: 'Profile', kind: 'link', href: routeFor('profile'), built: true },
  { key: 'settings', label: 'Settings', kind: 'link', href: routeFor('settings'), built: true },
  { key: 'sign-out', label: 'Sign out', kind: 'action' }
];

/**
 * Better Auth's own POST /sign-out, mounted at /auth by
 * src/pages/auth/[...all].ts. Verified against
 * node_modules/better-auth/dist/api/routes/sign-out.mjs: the endpoint is
 * registered as `/sign-out` with `method: 'POST'`, so the full address under
 * this repository's base is /jobs/auth/sign-out. Called by its bare path,
 * never modified or wrapped, the same way role/[slug].astro's own
 * data-session-url calls Better Auth's GET /get-session.
 */
export const SIGN_OUT_ACTION = withBase('/auth/sign-out');
