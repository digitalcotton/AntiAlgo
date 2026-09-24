/**
 * billing.test.ts: the seam over the Stripe SDK, tested with the SDK itself
 * replaced at the module boundary. No Stripe account, no network — every call
 * that would otherwise leave this process (`checkout.sessions.create`,
 * `webhooks.constructEvent`) is a `vi.fn()` here.
 *
 * WHY THE REAL SIGNATURE CRYPTO IS NOT HERE. Mocking `stripe.webhooks.constructEvent`
 * would only prove this file calls a function named `constructEvent` with three
 * arguments — it says nothing about whether a tampered body is actually
 * rejected, since the mock has no HMAC to check. That property is worth
 * something only against the real algorithm, so it is asserted in
 * src/pages/billing/webhook.test.ts against the real, installed `stripe`
 * package (constructEvent and generateTestHeaderString are pure local HMAC —
 * no network, no account, same "no Stripe account, no network" rule this file
 * follows). What belongs here is billing.ts's OWN logic: which env var it
 * reads, what shape it hands Stripe, what it does when a var is missing, and
 * that it does not swallow a rejection.
 *
 * ZERO TESTS BEFORE THIS FILE. billing.ts's own header says it is "the one
 * seam over the Stripe SDK" that both checkout.ts and webhook.ts call through
 * — and until now nothing exercised it at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionsCreate, constructEvent, FakeStripe } = vi.hoisted(() => {
  const sessionsCreate = vi.fn();
  const constructEvent = vi.fn();
  class FakeStripe {
    checkout = { sessions: { create: sessionsCreate } };
    webhooks = { constructEvent };
  }
  return { sessionsCreate, constructEvent, FakeStripe };
});

vi.mock('stripe', () => ({ default: FakeStripe }));

import { createCheckoutSession, verifyWebhookEvent } from './billing';

const PRIOR_ENV: Record<string, string | undefined> = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID
};

function withEnvVar(name: string, run: () => void | Promise<void>): Promise<void> | void {
  const prior = process.env[name];
  delete process.env[name];
  const restore = () => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  };
  const result = run();
  if (result instanceof Promise) return result.finally(restore);
  restore();
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_billing';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture_billing';
  process.env.STRIPE_PRICE_ID = 'price_fixture_725';
});

afterAll(() => {
  for (const [key, value] of Object.entries(PRIOR_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  sessionsCreate.mockReset();
  constructEvent.mockReset();
});

describe('createCheckoutSession', () => {
  it('creates a subscription-mode session for the one configured price, carrying the buyer id twice', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' });

    const session = await createCheckoutSession({
      userId: 'user_alice',
      successUrl: 'https://www.antialgo.ai/account?upgraded=1',
      cancelUrl: 'https://www.antialgo.ai/upgrade?canceled=1',
      customerEmail: 'alice@example.com'
    });

    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.mode).toBe('subscription');
    // The price lives in Stripe, not this codebase (billing.ts's own header):
    // the id comes from STRIPE_PRICE_ID, never a hardcoded amount.
    expect(params.line_items).toEqual([{ price: 'price_fixture_725', quantity: 1 }]);
    expect(params.client_reference_id).toBe('user_alice');
    expect(params.customer_email).toBe('alice@example.com');
    expect(params.success_url).toBe('https://www.antialgo.ai/account?upgraded=1');
    expect(params.cancel_url).toBe('https://www.antialgo.ai/upgrade?canceled=1');
    // Belt-and-suspenders (billing.ts:86-91): the subscription itself also
    // carries the user id, because a later customer.subscription.* webhook
    // event has no client_reference_id at all — there is no Checkout Session
    // in that payload to read one from.
    expect(params.subscription_data).toEqual({ metadata: { app_user_id: 'user_alice' } });
    expect(session.url).toBe('https://checkout.stripe.com/pay/cs_test_1');
  });

  it('leaves customer_email undefined when the caller has none — Stripe asks for one rather than this code inventing one', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_test_2', url: 'https://checkout.stripe.com/pay/cs_test_2' });
    await createCheckoutSession({ userId: 'user_bob', successUrl: 'https://x/success', cancelUrl: 'https://x/cancel' });
    expect(sessionsCreate.mock.calls[0][0].customer_email).toBeUndefined();
  });

  it('throws a named error instead of ever calling Stripe when STRIPE_PRICE_ID is unset', async () => {
    await withEnvVar('STRIPE_PRICE_ID', async () => {
      await expect(
        createCheckoutSession({ userId: 'user_x', successUrl: 'https://x', cancelUrl: 'https://y' })
      ).rejects.toThrow(/STRIPE_PRICE_ID/);
      expect(sessionsCreate).not.toHaveBeenCalled();
    });
  });
});

describe('verifyWebhookEvent', () => {
  it("passes the raw body, the signature header, and STRIPE_WEBHOOK_SECRET straight to Stripe's own verifier, unmodified, and returns what it returns", () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed' });
    const event = verifyWebhookEvent('{"raw":"body"}', 'sig_header_value');
    expect(constructEvent).toHaveBeenCalledWith('{"raw":"body"}', 'sig_header_value', 'whsec_test_fixture_billing');
    expect(event).toEqual({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('propagates a rejection from the verifier rather than swallowing it — the caller must not treat a bad signature as a real event', () => {
    constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload.');
    });
    expect(() => verifyWebhookEvent('{"raw":"body"}', 'bad_sig')).toThrow(/No signatures found/);
  });

  it('throws a named error instead of ever calling Stripe when STRIPE_WEBHOOK_SECRET is unset', () => {
    return withEnvVar('STRIPE_WEBHOOK_SECRET', () => {
      expect(() => verifyWebhookEvent('body', 'sig')).toThrow(/STRIPE_WEBHOOK_SECRET/);
      expect(constructEvent).not.toHaveBeenCalled();
    });
  });
});

/**
 * checkout.ts's own shape, covered here rather than in a file of its own
 * (the task names only billing.test.ts and webhook.test.ts). billing.ts,
 * viewer.ts and flags.ts are replaced fresh for this block alone —
 * vi.resetModules() + vi.doMock(), not the file-wide vi.mock('stripe') above
 * — so what is under test is checkout.ts's own routing and URL-building, not
 * billing.ts's, which the two describes above already cover directly. This
 * runs last in the file: resetModules() only changes what future dynamic
 * imports resolve to, so it cannot affect the already-completed describes above.
 */
describe('checkout.ts: the shape of what POST /billing/checkout sends', () => {
  const fakeCreateCheckoutSession = vi.fn();
  const fakeViewerFrom = vi.fn();
  const fakeIsOn = vi.fn(() => true);

  async function loadCheckout() {
    vi.resetModules();
    vi.doMock('./billing', () => ({ createCheckoutSession: fakeCreateCheckoutSession }));
    vi.doMock('./viewer', () => ({ viewerFrom: fakeViewerFrom }));
    vi.doMock('./flags', () => ({ isOn: fakeIsOn }));
    return import('../pages/billing/checkout');
  }

  beforeEach(() => {
    fakeCreateCheckoutSession.mockReset();
    fakeViewerFrom.mockReset();
    fakeIsOn.mockReset();
    fakeIsOn.mockReturnValue(true);
  });

  afterAll(() => {
    vi.doUnmock('./billing');
    vi.doUnmock('./viewer');
    vi.doUnmock('./flags');
    vi.resetModules();
  });

  it('cannot be called without a session: no viewer, 401, Stripe never reached', async () => {
    fakeViewerFrom.mockResolvedValue(null);
    const { POST } = await loadCheckout();
    const request = new Request('https://www.antialgo.ai/billing/checkout', { method: 'POST' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ request } as any);
    expect(res.status).toBe(401);
    expect(fakeCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('signed in: success_url and cancel_url are absolute, built from SITE_URL plus the registered routes, and the session redirects with 303', async () => {
    fakeViewerFrom.mockResolvedValue({ userId: 'user_carol', tier: 'member', emailVerified: true });
    fakeCreateCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_carol' });
    const { POST } = await loadCheckout();
    const request = new Request('https://www.antialgo.ai/billing/checkout', { method: 'POST' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ request } as any);

    expect(fakeCreateCheckoutSession).toHaveBeenCalledTimes(1);
    const [params] = fakeCreateCheckoutSession.mock.calls[0];
    expect(params.userId).toBe('user_carol');
    // Absolute URLs: Stripe redirects the browser here directly, not through
    // this app (checkout.ts's own header) — a base-relative path is not enough.
    expect(params.successUrl).toMatch(/^https?:\/\/.+\/account\?upgraded=1$/);
    expect(params.cancelUrl).toMatch(/^https?:\/\/.+\/upgrade\?canceled=1$/);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/pay/cs_carol');
  });

  it("dark by flag: isOn('stripe') === false 404s before the viewer is ever resolved", async () => {
    fakeIsOn.mockReturnValue(false);
    const { POST } = await loadCheckout();
    const request = new Request('https://www.antialgo.ai/billing/checkout', { method: 'POST' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ request } as any);
    expect(res.status).toBe(404);
    expect(fakeViewerFrom).not.toHaveBeenCalled();
    expect(fakeCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('a failure creating the session is a plain 500, never the underlying error text', async () => {
    fakeViewerFrom.mockResolvedValue({ userId: 'user_dana', tier: 'member', emailVerified: true });
    fakeCreateCheckoutSession.mockRejectedValue(new Error('billing: STRIPE_SECRET_KEY is not set.'));
    const { POST } = await loadCheckout();
    const request = new Request('https://www.antialgo.ai/billing/checkout', { method: 'POST' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST({ request } as any);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('STRIPE_SECRET_KEY');
  });
});
