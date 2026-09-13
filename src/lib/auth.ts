/**
 * auth.ts: Better Auth, configured the way the index configures it.
 *
 * WHAT BETTER AUTH OWNS AND WHAT IT DOES NOT. The library owns identity:
 * credentials, sessions, and its four tables. What an account is ALLOWED to do
 * lives in our own table, app_user_profile, written by the hook below the
 * moment the account exists and read by src/lib/viewer.ts.
 *
 * EMAIL IS OUT OF SCOPE FOR THIS BUILD, AND THIS FILE SAYS SO IN ONE PLACE.
 * `requireEmailVerification` is false, so a new account signs itself in and
 * lands on the waitlist page at once. The entitlement decision still carries
 * emailVerified (an unverified account is refused a gated route as
 * `email-unverified` before its tier is even compared), so the day a sender
 * exists, flipping this one value and adding `emailVerification` is the whole
 * change. Nothing else in the repository assumes either answer.
 *
 * LAZY, NOT AT IMPORT TIME. Building the instance reads DATABASE_URL and
 * BETTER_AUTH_SECRET. A static page that imports this module through the
 * layout must not crash a build for lack of a secret it never uses.
 */
import { betterAuth } from 'better-auth';
import { SITE_ORIGIN } from '../../site.config.mjs';
import { db } from './db';
import { signupTier } from './entitlement';
import { isOn } from './flags';
import { hash as hashPassword, verify as verifyPassword } from './password';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Set it in Vercel environment variables or .env.local.`);
  return value;
}

function baseURL(): string {
  return process.env.BETTER_AUTH_URL || SITE_ORIGIN;
}

/**
 * The origins Better Auth accepts a browser request from: the canonical site
 * origin always, plus the exact Vercel deployment and branch URLs when the
 * platform provides them, so previews work without loosening anything.
 */
export function trustedOrigins(): string[] {
  const origins = new Set<string>([SITE_ORIGIN, baseURL()]);
  if (process.env.VERCEL_URL) origins.add(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_BRANCH_URL) origins.add(`https://${process.env.VERCEL_BRANCH_URL}`);
  return [...origins];
}

function build() {
  return betterAuth({
    database: db(),
    baseURL: baseURL(),
    basePath: '/auth',
    secret: required('BETTER_AUTH_SECRET'),
    trustedOrigins: trustedOrigins(),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      password: { hash: hashPassword, verify: verifyPassword }
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24
    },

    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      }
    },

    rateLimit: { enabled: true, window: 60, max: 30 },

    databaseHooks: {
      user: {
        create: {
          /**
           * Every user gets a profile row the moment the account exists, at
           * the tier the waitlist flag says. The flag is read here, once, at
           * creation, and never again: turning it off changes what the NEXT
           * account is created as and touches nobody who already exists.
           */
          after: async (user, context) => {
            const source = sanitiseSource(sourceFromRequest(context));
            const { first, last } = namesFrom(context, user.name);
            const tier = signupTier(isOn('waitlist'));
            await db().query(
              `INSERT INTO app_user_profile (user_id, tier, signup_source, first_name, last_name)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, tier, source, first, last]
            );

            // EMAIL IS OUT OF SCOPE FOR THIS BUILD, SO THE ADDRESS IS TREATED
            // AS VERIFIED AT CREATION. Entitlement still gates every tier above
            // public on emailVerified (an unverified account denies with
            // `email-unverified` before its tier is even read), and no verifier
            // exists yet to flip the flag: with requireEmailVerification off and
            // no sender, the column would stay false forever and an admitted
            // member could never open their Desk. Marking it true here is the
            // stand-in until email ships. THE DAY A VERIFIER EXISTS, this line
            // comes out and requireEmailVerification goes true, and the pure
            // decision in entitlement.ts already handles the unverified case
            // (entitlement.test.ts covers it). It is one line to reverse.
            await db().query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [user.id]);
          }
        }
      }
    }
  });
}

let instance: ReturnType<typeof build> | null = null;

export function getAuth(): ReturnType<typeof build> {
  if (!instance) instance = build();
  return instance;
}

/**
 * The placement that sent someone to sign up, read off the request that
 * created the account: the body's signup_source field first, then the
 * short-lived cookie the sign-up page sets, then 'direct'.
 */
function sourceFromRequest(context: unknown): string {
  const ctx = context as { body?: Record<string, unknown>; request?: Request; headers?: Headers } | undefined;
  const fromBody = ctx?.body?.signup_source;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const cookie = ctx?.request?.headers?.get('cookie') ?? ctx?.headers?.get('cookie') ?? '';
  const match = /(?:^|;\s*)signup_source=([^;]*)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : 'direct';
}

/** Control characters flattened, bounded at 120, whitespace collapsed and trimmed. */
export function sanitiseName(value: unknown): string {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 120)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The two name parts, preferring what the person typed. The sign-up form posts
 * first_name and last_name beside the single `name` Better Auth requires;
 * splitting `name` on whitespace is only the fallback for a signup that did
 * not come through that form, and it is a documented guess.
 */
export function namesFrom(context: unknown, fullName: unknown): { first: string; last: string } {
  const ctx = context as { body?: Record<string, unknown> } | undefined;
  const first = sanitiseName(ctx?.body?.first_name ?? ctx?.body?.firstName);
  const last = sanitiseName(ctx?.body?.last_name ?? ctx?.body?.lastName);
  if (first || last) return { first, last };
  const parts = sanitiseName(fullName).split(' ').filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Lowercase, [a-z0-9_-] only, at most 64 characters, 'direct' when empty. */
export function sanitiseSource(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().slice(0, 64);
  const cleaned = raw.replace(/[^a-z0-9_-]/g, '');
  return cleaned || 'direct';
}
