/**
 * billing.ts: the one seam over the Stripe SDK, for the same reason db.ts is
 * the one seam over the Postgres connection string. Every other file that
 * needs Stripe (the checkout route, the webhook route) calls through here;
 * none of them reads STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET or
 * STRIPE_PRICE_ID itself, and none of them constructs a `Stripe` client
 * itself. That keeps the "is Stripe configured at all" question answerable
 * in one place instead of three.
 *
 * NOTHING HERE IS REACHABLE TODAY. Both callers (src/pages/billing/checkout.ts
 * and src/pages/billing/webhook.ts) sit under the `stripe` flag in
 * flags.config.mjs, which is off in both editions, so middleware's
 * routeIsLit() 404s the request before either file's code ever runs. This
 * module still throws loudly rather than no-opping when its env vars are
 * unset (see required() below) — a silent no-op here would be indistinguishable
 * from "billing is working and just did nothing," which is a worse failure
 * mode than a thrown error, flag or no flag.
 *
 * THE PRICE IS SET IN STRIPE, NOT IN THIS CODEBASE. $7.25/month is configured
 * as a Stripe Price object (the STRIPE_PRICE_ID env var points at it); nothing
 * in this file or its callers hardcodes an amount, so the price can change in
 * the Stripe dashboard without a deploy here.
 */
import Stripe from 'stripe';

/**
 * Reads one required env var, or throws a clear, named error. Same shape as
 * db.ts's own required(): a missing value must surface as "which variable,
 * and why," never as a null pointer three layers down.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `billing: ${name} is not set. Stripe is not configured on this deployment. ` +
        `Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID (see .env.example) ` +
        `before the 'stripe' flag in flags.config.mjs is ever turned on.`
    );
  }
  return value;
}

let client: Stripe | null = null;

/** The one Stripe client, constructed lazily so importing this module never touches env vars by itself. */
function stripeClient(): Stripe {
  if (!client) {
    client = new Stripe(required('STRIPE_SECRET_KEY'));
  }
  return client;
}

export interface CreateCheckoutSessionParams {
  /** Better Auth user id. Stamped onto the session as client_reference_id
   *  AND onto the subscription's metadata, so the webhook can map a
   *  `checkout.session.completed` event OR a later subscription event back
   *  to a row in app_user_profile without a second lookup table. */
  userId: string;
  /** Where Stripe sends the browser back on success. Absolute URL; the
   *  caller builds it (this file has no notion of routes or base paths). */
  successUrl: string;
  /** Where Stripe sends the browser back if the checkout is abandoned. */
  cancelUrl: string;
  /** Pre-fills Stripe's own email field so the buyer is not asked to retype
   *  the address their account already has. Optional: Stripe still works
   *  without it, just asks. */
  customerEmail?: string;
}

/**
 * Creates a Stripe Checkout Session for the one subscription price
 * (STRIPE_PRICE_ID), for one signed-in user. `mode: 'subscription'` is what
 * makes this a recurring $7.25/month charge rather than a one-time payment —
 * Stripe bills the card again every period on its own, no cron job here.
 */
export async function createCheckoutSession(params: CreateCheckoutSessionParams): Promise<Stripe.Checkout.Session> {
  const priceId = required('STRIPE_PRICE_ID');
  const stripe = stripeClient();
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: params.userId,
    customer_email: params.customerEmail,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    subscription_data: {
      // Belt-and-suspenders alongside client_reference_id: a subscription
      // update/delete event carries this metadata directly, with no session
      // object in the payload to read client_reference_id from.
      metadata: { app_user_id: params.userId }
    }
  });
}

/**
 * Verifies a webhook request actually came from Stripe (HMAC signature over
 * the RAW body, using STRIPE_WEBHOOK_SECRET) and returns the parsed event.
 * Throws (constructEvent's own error) on a bad or missing signature — the
 * caller must not catch that and proceed as if the event were real.
 *
 * MUST BE CALLED WITH THE RAW, UNPARSED BODY. Stripe signs the exact bytes it
 * sent; re-serializing a JSON.parse()'d copy changes whitespace and breaks
 * the signature. This is why src/pages/billing/webhook.ts reads
 * `await request.text()` rather than `await request.json()`.
 */
export function verifyWebhookEvent(rawBody: string | Buffer, signature: string): Stripe.Event {
  const secret = required('STRIPE_WEBHOOK_SECRET');
  const stripe = stripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
