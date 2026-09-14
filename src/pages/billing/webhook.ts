/**
 * POST /billing/webhook: Stripe calls this directly, server to server, never
 * a browser. It is the only writer of app_user_profile.tier = 'paid'.
 *
 * DARK BY FLAG. Same as checkout.ts: flags.config.mjs's FLAGGED_ROUTES maps
 * '/billing' to the `stripe` flag, so middleware 404s this request while the
 * flag is off, before this file's code ever runs. The isOn('stripe') check
 * below is the same belt-and-suspenders as checkout.ts's.
 *
 * WHY checkOrigin (ON) DOES NOT BLOCK THIS. Astro's CSRF check compares the
 * request's Origin header against the Host it expects, but only kicks in for
 * requests it can tell are a browser form/fetch submission; a server-to-server
 * POST from Stripe carries no Origin header and a `stripe-signature` header
 * instead, so this route is never in the set checkOrigin was built to police.
 * The real authentication here is the Stripe signature itself (verified
 * below with billing.ts's verifyWebhookEvent()), which is stronger than an
 * Origin check anyway: it proves the exact body came from Stripe's account,
 * not just "some browser tab on this origin."
 *
 * THE RAW BODY, NOT PARSED JSON. Stripe's signature is computed over the
 * exact bytes it sent; `request.text()` preserves that, `request.json()`
 * would not (JSON.parse().stringify() is not guaranteed byte-identical).
 * See billing.ts's verifyWebhookEvent() for the other half of this rule.
 *
 * TWO WAYS IN, ONE MAPPING, NEVER A DOWNGRADE BELOW `member`.
 *   - checkout.session.completed carries client_reference_id, set by
 *     checkout.ts to the buyer's user id at Checkout Session creation.
 *   - customer.subscription.* carries no client_reference_id (there is no
 *     Checkout Session in that payload at all), so it reads
 *     subscription.metadata.app_user_id instead — the same id, stamped onto
 *     the subscription itself by billing.ts's createCheckoutSession() via
 *     subscription_data.metadata, for exactly this case.
 *   Upgrading never touches an `internal` account (the WHERE clause below
 *   excludes it), and reverting only ever moves a `paid` account back to
 *   `member` — an account that is `waitlisted`, `member`, or `internal`
 *   already is left untouched by a subscription event that was never what
 *   granted it that tier in the first place.
 */
import type { APIContext } from 'astro';
import type Stripe from 'stripe';
import { isOn } from '../../lib/flags';
import { verifyWebhookEvent } from '../../lib/billing';
import { db } from '../../lib/db';

export const prerender = false;

function notFound(): Response {
  return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Statuses that mean "this person is actively paying right now." */
function isActiveStatus(status: Stripe.Subscription.Status): boolean {
  return status === 'active' || status === 'trialing';
}

/** Statuses named in Phase 6: the subscription stopped paying. */
function isEndedStatus(status: Stripe.Subscription.Status): boolean {
  return status === 'canceled' || status === 'unpaid';
}

/** Grants `paid`. Excludes `internal`, so a canceled/re-subscribed staff
 *  account is never pulled down to a lower rank than it already has. Every
 *  other tier (public, waitlisted, member, or already paid) is raised. */
async function setTierPaid(userId: string): Promise<void> {
  await db().query(`UPDATE app_user_profile SET tier = 'paid' WHERE user_id = $1 AND tier <> 'internal'`, [userId]);
}

/** Reverts to `member`. Only ever fires on a row that is currently `paid` —
 *  never below `member`, and never on a `waitlisted` or `internal` row that
 *  a subscription event did not put there in the first place. */
async function revertTierToMember(userId: string): Promise<void> {
  await db().query(`UPDATE app_user_profile SET tier = 'member' WHERE user_id = $1 AND tier = 'paid'`, [userId]);
}

export async function POST(context: APIContext): Promise<Response> {
  if (!isOn('stripe')) {
    return notFound();
  }

  const signature = context.request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header.', { status: 400 });
  }

  // Read as text, not JSON — see this file's own header on why the raw
  // bytes matter for signature verification.
  const rawBody = await context.request.text();

  let event: Stripe.Event;
  try {
    event = verifyWebhookEvent(rawBody, signature);
  } catch (error) {
    console.error('billing/webhook: signature verification failed; refusing the event.', error);
    return new Response('Invalid signature.', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        if (userId) {
          await setTierPaid(userId);
        } else {
          console.error('billing/webhook: checkout.session.completed carried no client_reference_id.');
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.app_user_id;
        if (!userId) {
          console.error(`billing/webhook: ${event.type} carried no metadata.app_user_id.`);
          break;
        }
        if (isActiveStatus(subscription.status)) {
          await setTierPaid(userId);
        } else if (isEndedStatus(subscription.status)) {
          await revertTierToMember(userId);
        }
        // Any other status (incomplete, past_due, paused, …) is left alone:
        // Stripe's own retry/dunning flow may still resolve it either way,
        // and this handler only acts on the statuses Phase 6 named.
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.app_user_id;
        if (userId) {
          await revertTierToMember(userId);
        } else {
          console.error('billing/webhook: customer.subscription.deleted carried no metadata.app_user_id.');
        }
        break;
      }

      default:
        // Stripe expects a 2xx for every event type it sends, whether or not
        // this app acts on it. Only the cases above touch app_user_profile.
        break;
    }
  } catch (error) {
    console.error(`billing/webhook: failed to apply event ${event.type}.`, error);
    return new Response('Webhook handler error.', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
