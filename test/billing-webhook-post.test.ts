/**
 * MOVED OUT OF src/pages ON 2026-09-24, and this header is the reason.
 *
 * Astro's file router builds EVERY file under src/pages as a route. A *.test.ts
 * there becomes a real, servable page — these three resolved to /internal/tier.test,
 * /internal/reset-onboarding.test and /billing/webhook.test — and `astro build`, the
 * exact command Vercel runs, then crashes trying to prerender one: "Vitest mocker was
 * not initialized in this environment. vi.queueMock() is forbidden."
 *
 * The repo had already learned this once: commit 7ae30de is titled "Move the prelist
 * render test out of src/pages so Astro stops building it as a route", and
 * test/desk-job-draft-post.test.ts carries the same note in its own header. So
 * scripts/gate-invariants.mjs now asserts it (check 6) rather than leaving it to
 * whoever reads a header next.
 */
/**
 * webhook.test.ts: POST /billing/webhook is, in its own header's words, "the
 * only writer of app_user_profile.tier = 'paid'" — and had zero tests before
 * this file. Every entitlement decision in the app keys off that column.
 *
 * NO STRIPE ACCOUNT, NO NETWORK. db.ts and flags.ts are mocked below; the
 * `stripe` package itself is NOT mocked. `stripe.webhooks.constructEvent` and
 * `generateTestHeaderString` are pure local HMAC — no network call, no
 * account, no key that has to be real — so the signature tests here exercise
 * the actual algorithm webhook.ts depends on, through the real billing.ts,
 * rather than a hand-rolled stand-in for it. (Contrast src/lib/billing.test.ts,
 * which mocks `stripe` entirely to test billing.ts's own logic in isolation —
 * the two files divide the work rather than duplicating it.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import type { APIContext } from 'astro';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: () => ({ query }) }));

const { isOn } = vi.hoisted(() => ({ isOn: vi.fn(() => true) }));
vi.mock('../src/lib/flags', () => ({ isOn }));

import { POST } from '../src/pages/billing/webhook';

const STRIPE_SECRET_KEY = 'sk_test_fixture_webhook';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture_webhook';

const PRIOR_ENV: Record<string, string | undefined> = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET
};

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
});

afterAll(() => {
  for (const [key, value] of Object.entries(PRIOR_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  query.mockReset();
  isOn.mockReset();
  isOn.mockReturnValue(true);
  vi.restoreAllMocks();
});

// A second, independent Stripe client used only to SIGN fixtures the way
// Stripe itself would — this test file plays "Stripe" so it can hand
// webhook.ts a real, valid signature and, separately, a deliberately invalid
// one. It never makes a network call; signing and verifying are both local.
const stripeForFixtures = new Stripe(STRIPE_SECRET_KEY);

function signedRequest(event: Record<string, unknown>, rawBodyOverride?: string): Request {
  const payload = JSON.stringify(event);
  const signature = stripeForFixtures.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
  return new Request('https://www.antialgo.ai/billing/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: rawBodyOverride ?? payload
  });
}

function context(request: Request): APIContext {
  return { request } as unknown as APIContext;
}

describe('signature verification: the raw body, not parsed JSON', () => {
  it('REJECTS a body with one byte changed from the one that was signed', async () => {
    const event = {
      id: 'evt_tamper_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_tamper', client_reference_id: 'user_1' } }
    };
    const payload = JSON.stringify(event);
    const signature = stripeForFixtures.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
    // One byte changed, nothing structural — still valid JSON, still the
    // wrong bytes relative to what was signed.
    const tampered = payload.replace('user_1', 'user_9');
    expect(tampered).not.toBe(payload);
    expect(tampered.length).toBe(payload.length);

    const request = new Request('https://www.antialgo.ai/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: tampered
    });
    const res = await POST(context(request));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts the same body with its real, matching signature — the control for the test above', async () => {
    const request = signedRequest({
      id: 'evt_control_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_control', client_reference_id: 'user_control' } }
    });
    query.mockResolvedValue({ rows: [] });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
  });

  it('reads request.text(), never request.json() — the signature is computed over the exact bytes Stripe sent, and JSON.parse(...).stringify() is not guaranteed to reproduce them (billing.ts\'s own header)', async () => {
    const request = signedRequest({ id: 'evt_shape_1', type: 'invoice.payment_failed', data: { object: {} } });
    const textSpy = vi.spyOn(request, 'text');
    const jsonSpy = vi.spyOn(request, 'json');
    const res = await POST(context(request));
    expect(textSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('400s with no stripe-signature header at all, before the body is even read', async () => {
    const request = new Request('https://www.antialgo.ai/billing/webhook', { method: 'POST', body: '{}' });
    const res = await POST(context(request));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

/**
 * The real table, read from webhook.ts rather than assumed. Its switch
 * handles exactly four event types by name — checkout.session.completed,
 * customer.subscription.created, customer.subscription.updated,
 * customer.subscription.deleted — and the two subscription cases share one
 * branch keyed on subscription.status, not on the event type alone. Every
 * other type, invoice.payment_failed included, falls through the `default`
 * and writes nothing.
 */
describe('the fixture table: what each event writes, or that it writes nothing', () => {
  it('checkout.session.completed with client_reference_id sets tier = paid, excluding internal', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', client_reference_id: 'user_alice' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`SET tier = 'paid'`);
    expect(sql).toContain(`tier <> 'internal'`);
    expect(params).toEqual(['user_alice']);
  });

  it('customer.subscription.created with an active status also sets tier = paid — grouped with .updated in the switch, not a separate case', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_created',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_0', status: 'active', metadata: { app_user_id: 'user_zoe' } } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(`SET tier = 'paid'`);
    expect(query.mock.calls[0][1]).toEqual(['user_zoe']);
  });

  it('customer.subscription.updated with an active status sets tier = paid', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_active',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', metadata: { app_user_id: 'user_bob' } } }
    });
    await POST(context(request));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(`SET tier = 'paid'`);
    expect(query.mock.calls[0][1]).toEqual(['user_bob']);
  });

  it('customer.subscription.updated with a trialing status also sets tier = paid', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_trialing',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1b', status: 'trialing', metadata: { app_user_id: 'user_trial' } } }
    });
    await POST(context(request));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(`SET tier = 'paid'`);
  });

  it('customer.subscription.updated with a canceled status reverts tier to member, and only ever from paid', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_canceled',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_2', status: 'canceled', metadata: { app_user_id: 'user_carl' } } }
    });
    await POST(context(request));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`SET tier = 'member'`);
    expect(sql).toContain(`tier = 'paid'`);
    expect(params).toEqual(['user_carl']);
  });

  it('customer.subscription.updated with an unpaid status also reverts tier to member', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_unpaid',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_2b', status: 'unpaid', metadata: { app_user_id: 'user_unpaid' } } }
    });
    await POST(context(request));
    expect(query.mock.calls[0][0]).toContain(`SET tier = 'member'`);
  });

  it("customer.subscription.updated with an in-between status (past_due) writes nothing — Stripe's own dunning flow may still resolve it either way (webhook.ts:123-125)", async () => {
    const request = signedRequest({
      id: 'evt_sub_pastdue',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_3', status: 'past_due', metadata: { app_user_id: 'user_dana' } } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it('customer.subscription.deleted reverts tier to member', async () => {
    query.mockResolvedValue({ rows: [] });
    const request = signedRequest({
      id: 'evt_sub_deleted',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_4', metadata: { app_user_id: 'user_erin' } } }
    });
    await POST(context(request));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(`tier = 'member'`);
    expect(query.mock.calls[0][1]).toEqual(['user_erin']);
  });

  it('invoice.payment_failed — a real Stripe event type this handler does not name at all — falls through the default and writes nothing, but still 200s (Stripe expects a 2xx for every type it sends)', async () => {
    const request = signedRequest({
      id: 'evt_invoice_failed',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', customer: 'cus_1' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("idempotence: Stripe retries deliveries, so the same event twice must not double-apply", () => {
  it('the identical checkout.session.completed event, delivered twice, runs the identical UPDATE twice rather than compounding', async () => {
    query.mockResolvedValue({ rows: [] });
    const event = {
      id: 'evt_retry_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_retry', client_reference_id: 'user_frank' } }
    };
    // Two separate Request objects built from the identical event, exactly as
    // a real Stripe retry would redeliver the identical bytes with the
    // identical signature.
    const res1 = await POST(context(signedRequest(event)));
    const res2 = await POST(context(signedRequest(event)));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(2);
    // Not merely "called twice" — the SAME statement with the SAME params
    // both times. There is no event-id ledger here, and none is needed: every
    // write in this file is `UPDATE ... SET tier = <fixed value> WHERE ...`,
    // which is idempotent by construction. A retry lands on a row already at
    // the target tier and changes nothing further. (If a future change ever
    // makes a write additive — a counter, an INSERT, an append — this
    // assertion is the one to widen, not delete.)
    expect(query.mock.calls[0]).toEqual(query.mock.calls[1]);
  });
});

describe('an event for an unknown customer or user writes nothing and does not throw', () => {
  it('checkout.session.completed with no client_reference_id logs and writes nothing, still 200s', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = signedRequest({
      id: 'evt_no_ref',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_orphan' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('customer.subscription.updated with no metadata.app_user_id logs and writes nothing, still 200s', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = signedRequest({
      id: 'evt_no_meta',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_orphan', status: 'active' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('customer.subscription.deleted with no metadata.app_user_id logs and writes nothing, still 200s', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = signedRequest({
      id: 'evt_deleted_no_meta',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_orphan_2' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a database error while applying a known event is a 500, not an uncaught throw', async () => {
    query.mockRejectedValueOnce(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = signedRequest({
      id: 'evt_db_down',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', client_reference_id: 'user_x' } }
    });
    await expect(POST(context(request))).resolves.toBeInstanceOf(Response);
    const res = await POST(
      context(
        signedRequest({
          id: 'evt_db_down_2',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_2', client_reference_id: 'user_y' } }
        })
      )
    );
    // The second call's mock resolves normally (mockRejectedValueOnce only
    // fires once); what matters is the first call did not throw out of POST.
    expect(res.status).toBe(200);
  });
});

describe('the stripe flag: unreachable while off', () => {
  it("today, for real: flags.config.mjs has 'stripe' off in both editions, and FLAGGED_ROUTES maps '/billing' to it — so routeIsLit('/billing/webhook') is false", async () => {
    // The real module, bypassing the vi.mock('../src/lib/flags', ...) above —
    // this is the assertion that would fail the day someone flips the flag on
    // without meaning to, which is the actual risk this test guards.
    const realFlags = await vi.importActual<typeof import('../src/lib/flags')>('../src/lib/flags');
    expect(realFlags.isOn('stripe')).toBe(false);
    expect(realFlags.routeIsLit('/billing/webhook')).toBe(false);
    expect(realFlags.routeIsLit('/billing/checkout')).toBe(false);
    expect(realFlags.flagForRoute('/billing/webhook')).toBe('stripe');
  });

  it("POST 404s, byte-for-byte the same response a stranger gets for a route that does not exist, when isOn('stripe') is false — the belt-and-suspenders check inside the handler itself", async () => {
    isOn.mockReturnValue(false);
    const request = signedRequest({
      id: 'evt_dark',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'user_x' } }
    });
    const res = await POST(context(request));
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    // The signature is never even checked while the flag is off: a stranger
    // cannot tell "no such route" apart from "route exists, signature refused."
    const body = await res.text();
    expect(body).toBe('Not found.');
  });
});
