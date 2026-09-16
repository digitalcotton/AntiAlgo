/**
 * viewer.ts: turning a request into a Viewer. The impure half of entitlement.
 *
 * THE TIER IS READ FROM OUR TABLE, SERVER SIDE, ALWAYS. No function here
 * accepts a tier from a header, a cookie, a query string or a body, because
 * there is nowhere to put one.
 */
import type { APIContext } from 'astro';
import { getAuth } from './auth';
import { db } from './db';
import { DEFAULT_TIER, isTier, type Tier, type Viewer } from './entitlement';

export async function viewerFrom(context: APIContext): Promise<Viewer | null> {
  const session = await getAuth().api.getSession({ headers: context.request.headers });
  if (!session?.user) return null;
  // One row for both the tier (entitlement) and the first name (the header's
  // account-menu label), so a signed-in request pays a single SELECT.
  const { rows } = await db().query<{ tier: string; first_name: string }>(
    'SELECT tier, first_name FROM app_user_profile WHERE user_id = $1 LIMIT 1',
    [session.user.id]
  );
  const row = rows[0];
  const tier = isTier(row?.tier) ? row.tier : DEFAULT_TIER;
  return {
    userId: session.user.id,
    tier,
    emailVerified: Boolean(session.user.emailVerified),
    firstName: row?.first_name ?? ''
  };
}

/**
 * A missing or unrecognised profile row resolves to DEFAULT_TIER, the lowest
 * signed-in tier the index knows, never to something higher: a broken write
 * must not escalate anyone.
 */
export async function tierFor(userId: string): Promise<Tier> {
  const { rows } = await db().query<{ tier: string }>(
    'SELECT tier FROM app_user_profile WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const value = rows[0]?.tier;
  return isTier(value) ? value : DEFAULT_TIER;
}

/** The signed-in person's own account facts, for the account and waitlist pages. */
export interface AccountFacts {
  email: string;
  firstName: string;
  tier: Tier;
  emailVerified: boolean;
  createdAt: Date;
}

export async function accountFacts(context: APIContext): Promise<AccountFacts | null> {
  const session = await getAuth().api.getSession({ headers: context.request.headers });
  if (!session?.user) return null;
  const { rows } = await db().query<{ tier: string; first_name: string; created_at: Date }>(
    'SELECT tier, first_name, created_at FROM app_user_profile WHERE user_id = $1 LIMIT 1',
    [session.user.id]
  );
  const row = rows[0];
  return {
    email: session.user.email,
    firstName: row?.first_name ?? '',
    tier: isTier(row?.tier) ? row.tier : DEFAULT_TIER,
    emailVerified: Boolean(session.user.emailVerified),
    createdAt: row?.created_at ?? new Date(session.user.createdAt)
  };
}
