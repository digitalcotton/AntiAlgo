/**
 * entitlement.ts: the one place that answers "are you allowed to see this".
 *
 * AUTHENTICATION AND ENTITLEMENT ARE TWO SYSTEMS. Better Auth answers who you
 * are. This file answers what you may see. The decision is a pure function of
 * a path and a viewer: no database, no session store, no request, so the
 * rules are tested exhaustively without a connection string.
 *
 * The impure half is src/lib/viewer.ts, the only code that reads a tier, and
 * it reads it from our own table via the server-side session. A tier is never
 * read from a header, a cookie the browser can write, a query parameter, or
 * anything else the client controls.
 *
 * The ladder itself lives in tiers.config.mjs so the admission script, which
 * is plain Node, reads the same values this file does.
 */
import {
  TIERS as RAW_TIERS,
  RANK as RAW_RANK,
  DEFAULT_TIER as RAW_DEFAULT,
  WAITLIST_TIER as RAW_WAITLIST,
  signupTier as rawSignupTier,
  admittedTier as rawAdmittedTier
} from '../../tiers.config.mjs';

export const TIERS = RAW_TIERS as unknown as readonly ['public', 'waitlisted', 'member', 'paid', 'internal'];
export type Tier = (typeof TIERS)[number];

const RANK = RAW_RANK as Record<Tier, number>;

export const DEFAULT_TIER = RAW_DEFAULT as Tier;
export const WAITLIST_TIER = RAW_WAITLIST as Tier;

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** The tier sign-up creates. Pure: the flag's state is passed in by the caller. */
export const signupTier = (waitlistOn: boolean): Tier => rawSignupTier(waitlistOn) as Tier;

/** The tier after admission. Idempotent and never a downgrade. */
export const admittedTier = (current: Tier): Tier => rawAdmittedTier(current) as Tier;

/** Who is asking. Null means signed out. */
export interface Viewer {
  userId: string;
  tier: Tier;
  emailVerified: boolean;
  /** The reader's first name, for the header's account menu label. Empty when
   *  the profile row carries none; readers that don't need it simply ignore it. */
  firstName?: string;
}

export interface Verdict {
  allow: boolean;
  /** The tier this path demands. */
  required: Tier;
  /** Machine-readable, so a route can branch and a test can assert on it. */
  reason:
    | 'allowed'
    | 'signed-out'
    | 'email-unverified'
    | 'waitlisted'
    | 'insufficient-tier'
    | 'no-policy-declared';
}

/**
 * THE ROUTE POLICY. The only place a route's requirement is written down.
 *
 * A route absent from this map is not automatically public: anything under a
 * gated prefix with no entry here is DENIED. Keys carry no base path and are
 * matched exactly, then by longest prefix, so e.g. `/drafts/acme` inherits
 * `/drafts` without its own line.
 *
 * MERGED FROM TWO POLICIES. `/account` is AntiAlgo's own (the signed-in
 * account page; a waitlisted account is sent to /waitlist instead) and
 * `/internal` was already shared. `/desk`, `/settings`, `/profile`,
 * `/drafts`, `/prelist` are the Index's gated prefixes for the board's
 * signed-in surfaces, copied in now that that code runs in this repo. All
 * five are 'member' for the same reason /account is: they read viewer state
 * this repo's own database owns and none of them is priced differently from
 * plain sign-in yet.
 */
export const ROUTE_POLICY: Record<string, Tier> = {
  // The signed-in account page: who you are, your tier, sign out. A member's
  // landing after admission. A waitlisted account is sent to /waitlist instead.
  '/account': 'member',
  // The Desk (the titles-driven member home) covers /desk and, by prefix, every
  // endpoint under it (desk/save.ts, desk/application.ts, desk/posting.ts,
  // desk/job-draft*). Member reaches the page; the paid content gates in-page
  // with isPaidViewer (a non-paid member sees the upsell), the same split
  // /ledger uses.
  '/desk': 'member',
  // The Opportunities tracker (formerly The Desk, MASTER-SPEC 3.5, F4). Same
  // member wall the tracker always had; its action endpoints still live under
  // /desk above.
  '/opportunities': 'member',
  // Settings: name, email, handle, drafting with provider keys, and the data
  // controls (export, delete, saved filters). Covers /settings and, by
  // prefix, every endpoint under it.
  '/settings': 'member',
  // Your own profile: identity header and the Profile Record, editable in
  // place. Private-only: unlike /desk and /prelist, no signed-out shop window.
  '/profile': 'member',
  // One outbound draft as a gated shop window: the company and opening line
  // are public, the rest sits behind this gate.
  '/drafts': 'member',
  // The Pre-List (RUN-FINISH 3.1, MASTER-SPEC F6): covers /prelist and, by
  // prefix, its one action route (prelist/follow.ts). Keeps a real shop
  // window for a signed-out reader, like /desk.
  '/prelist': 'member',
  // The Drop (owner decision, 2026-09-20): the weekly roll-up is member data,
  // not a public summary. Same wall as /desk; drop.astro carries
  // `export const prerender = false` so this policy is decided per request.
  '/drop': 'member',
  // Come ready (owner's designs, 2026-09-20): one page, three editions decided
  // in-page by tier. A waitlisted account sees what opens on admission, a
  // member the free account's five steps, a paid account the six that end at
  // the first draft. So the gate admits every signed-in tier and the page
  // does the telling apart; only a signed-out reader is sent to sign in.
  '/start': 'waitlisted',
  // Exists so the internal gate is reachable and its denial is provable.
  '/internal': 'internal'
};

/** Prefixes that are gated. Anything at or under one of these must have a policy. */
export const GATED_PREFIXES = ['/account', '/desk', '/opportunities', '/settings', '/profile', '/drafts', '/prelist', '/drop', '/start', '/internal'] as const;

function assertEveryGatedPrefixHasAPolicy(): void {
  const missing = GATED_PREFIXES.filter((p) => !(p in ROUTE_POLICY));
  if (missing.length > 0) {
    throw new Error(
      `entitlement: gated prefix ${missing.join(', ')} has no ROUTE_POLICY entry. ` +
        `Every gated prefix needs an explicit tier, or it denies everyone silently.`
    );
  }
}
assertEveryGatedPrefixHasAPolicy();

function normalise(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed || '/';
}

export function isGated(pathname: string): boolean {
  const path = normalise(pathname);
  return GATED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

export function requiredTierFor(pathname: string): Tier | null {
  const path = normalise(pathname);
  if (!isGated(path)) return null;
  let best: { key: string; tier: Tier } | null = null;
  for (const [key, tier] of Object.entries(ROUTE_POLICY)) {
    if (path === key || path.startsWith(key + '/')) {
      if (!best || key.length > best.key.length) best = { key, tier };
    }
  }
  return best ? best.tier : null;
}

/**
 * The verdict. Pure: same inputs, same answer, no I/O.
 *
 * ORDER MATTERS AND IS DELIBERATE. Undeclared policy first, so a gated route
 * nobody declared is refused even for an internal user. Then signed-out. Then
 * verification, before any tier comparison: an unverified account is a claim
 * about an address nobody has confirmed, so it is refused as `email-unverified`
 * whatever its tier. Only then the rank, where a waitlisted account gets its
 * own reason so the caller can send it to the one waitlist page instead of a
 * 403.
 */
export function decide(pathname: string, viewer: Viewer | null): Verdict {
  const path = normalise(pathname);

  if (!isGated(path)) return { allow: true, required: 'public', reason: 'allowed' };

  const required = requiredTierFor(path);
  if (required === null) return { allow: false, required: 'internal', reason: 'no-policy-declared' };

  if (!viewer) return { allow: false, required, reason: 'signed-out' };

  if (RANK[required] > RANK.public && !viewer.emailVerified) {
    return { allow: false, required, reason: 'email-unverified' };
  }

  if (RANK[viewer.tier] < RANK[required]) {
    if (viewer.tier === WAITLIST_TIER) return { allow: false, required, reason: 'waitlisted' };
    return { allow: false, required, reason: 'insufficient-tier' };
  }

  return { allow: true, required, reason: 'allowed' };
}

export function allows(pathname: string, viewer: Viewer | null): boolean {
  return decide(pathname, viewer).allow;
}
