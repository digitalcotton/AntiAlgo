/**
 * POST /internal/tier: set one account's tier by email.
 *
 * WHY THIS EXISTS. The only code that ever wrote 'paid' was the Stripe
 * webhook, and Stripe is dark, so a paid account could not be made at all;
 * scripts/admit.mjs stops at member and needs the production connection
 * string, which the Neon integration marks sensitive and no terminal here
 * can read. That left raw SQL in the Neon console as the only way to make a
 * test account paid. This is that job, done on the site, where the database
 * credentials already are.
 *
 * GATED AT 'internal' BY MIDDLEWARE (entitlement.ts '/internal'), which is
 * the whole security story: a signed-out reader is sent to sign-in, a
 * waitlisted account to the waitlist page, everyone else gets a 403 before
 * this file runs. The handler re-reads the verdict anyway, so a future
 * routing change cannot quietly open it.
 *
 * AN INTERNAL ACCOUNT IS NEVER CHANGED HERE, in either direction. Demoting
 * the account you are signed in with would lock you out of the page that
 * does the promoting, and there is no second way back in.
 */
import type { APIContext } from 'astro';
import { db } from '../../lib/db';
import { isTier, type Tier } from '../../lib/entitlement';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const INTERNAL_PATH = '/internal';
const RELAY_COOKIE = 'internal_tier_relay';

/** The tiers this control may set. 'public' is the absence of an account and
    'internal' is the gate this page sits behind; neither is a thing to hand
    to an account from a form. */
const SETTABLE: readonly Tier[] = ['waitlisted', 'member', 'paid'];

interface RelayPayload {
  ok: boolean;
  message: string;
}

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(INTERNAL_PATH) } });
}

function relay(context: APIContext, payload: RelayPayload): Response {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    path: withBase(INTERNAL_PATH),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
  return redirect();
}

/** A bare GET (a refresh after the 303, a crawler) goes to the page. */
export function GET(): Response {
  return redirect();
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer || context.locals.verdict?.allow !== true) {
    return new Response('Not available on your account.', { status: 403 });
  }

  const form = await context.request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const tier = String(form.get('tier') ?? '');

  if (!email.includes('@')) return relay(context, { ok: false, message: 'That does not look like an email address.' });
  if (!isTier(tier) || !SETTABLE.includes(tier)) {
    return relay(context, { ok: false, message: `Pick one of: ${SETTABLE.join(', ')}.` });
  }

  try {
    const { rows } = await db().query<{ id: string; email: string; tier: string | null }>(
      `SELECT u.id, u.email, p.tier
         FROM "user" u
         LEFT JOIN app_user_profile p ON p.user_id = u.id
        WHERE lower(u.email) = $1
        LIMIT 1`,
      [email]
    );
    const row = rows[0];
    if (!row) {
      return relay(context, { ok: false, message: `No account for ${email}. Create it on the login page first, then set the tier.` });
    }
    if (row.tier === 'internal') {
      return relay(context, { ok: false, message: `${row.email} is internal. An internal account is not changed here.` });
    }
    if (row.tier === tier) {
      return relay(context, { ok: true, message: `${row.email} is already ${tier}. Nothing to do.` });
    }

    // The profile row is created with the account, but an account made before
    // that table existed (or one whose profile was deleted by hand) has none;
    // upsert so the answer is the same either way.
    await db().query(
      `INSERT INTO app_user_profile (user_id, tier) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier`,
      [row.id, tier]
    );
    console.log(`internal/tier: ${viewer.userId} set ${row.email} from ${row.tier ?? 'no profile'} to ${tier}.`);
    return relay(context, { ok: true, message: `${row.email} is now ${tier}${row.tier ? `, was ${row.tier}` : ''}.` });
  } catch (error) {
    console.error('internal/tier: failed.', error);
    return relay(context, { ok: false, message: 'The database refused that. Nothing changed.' });
  }
}
