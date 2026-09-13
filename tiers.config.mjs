/**
 * The tier ladder, written once, in a format every consumer can read: the
 * TypeScript entitlement module, the admission script (plain Node), and the
 * tests. src/lib/entitlement.ts re-exports these with types and adds no
 * second copy of the rule.
 *
 * `waitlisted` sits at rank 5, between `public` (0) and `member` (10), so every
 * gate that requires `member` keeps refusing a waitlisted account without a
 * single gate being edited. The gap of ten between the older tiers is the
 * index's own convention; the waitlist slots into it without renumbering.
 */
export const TIERS = ['public', 'waitlisted', 'member', 'paid', 'internal'];

export const RANK = { public: 0, waitlisted: 5, member: 10, paid: 15, internal: 20 };

/** What sign-up creates when the waitlist flag is off: today's behaviour, unchanged. */
export const DEFAULT_TIER = 'member';

export const WAITLIST_TIER = 'waitlisted';

/** The tier a new account is created at. Pure: the flag's state is passed in. */
export function signupTier(waitlistOn) {
  return waitlistOn ? WAITLIST_TIER : DEFAULT_TIER;
}

/**
 * The tier after admission. Idempotent, and it never lowers anyone: a member,
 * a paid account and an internal account all come back unchanged, so running
 * the admission script twice, or on the wrong address, changes nothing.
 */
export function admittedTier(current) {
  return current === WAITLIST_TIER ? DEFAULT_TIER : current;
}
