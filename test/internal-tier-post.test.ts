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
 * tier.test.ts: the negative tests for POST /internal/tier — the endpoint
 * that grants 'paid' and 'internal' via `ON CONFLICT (user_id) DO UPDATE SET
 * tier = EXCLUDED.tier` on app_user_profile (see tier.ts's own header for
 * why the endpoint exists at all: Stripe is dark and scripts/admit.mjs
 * cannot reach production, so this page is the only way to make a paid
 * test account).
 *
 * The real handler is imported and an APIContext is built by hand, the way
 * src/lib/jobs-data-access.test.ts does for a GET (`const { GET } = await
 * import('../pages/jobs-data/summary')`) and test/desk-job-draft-post.test.ts
 * does for a POST. db.ts is mocked so nothing here opens a Postgres
 * connection — the same constraint src/lib/resume-parse-runner.test.ts's
 * header names for its own worker.
 *
 * WHICH LAYER THIS EXERCISES, AND WHY IT MATTERS. `/internal` is a
 * GATED_PREFIXES entry with ROUTE_POLICY['/internal'] = 'internal'
 * (src/lib/entitlement.ts), and src/middleware.ts computes that verdict and
 * calls `next()` only when it is `allow: true` — for a signed-out, member or
 * paid caller it redirects or 403s BEFORE Astro ever reaches this file. So
 * on real traffic today, tier.ts:64's own
 * `if (!viewer || context.locals.verdict?.allow !== true)` line never
 * actually turns anyone away — middleware already did. That line is
 * defense in depth, not the live gate, and defense in depth that no test
 * ever runs is indistinguishable from no defense at all the day someone
 * routes around middleware (a script that imports the handler directly, a
 * framework change, a second entrypoint). These tests call the handler the
 * same way such a caller would — locals built by hand, middleware never
 * invoked — so they are the only thing in this repository that proves
 * tier.ts:64 actually refuses when asked to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../src/lib/db', () => ({ db: () => ({ query }) }));

const { POST } = await import('../src/pages/internal/tier');

interface Viewer {
  userId: string;
  tier?: string;
  emailVerified?: boolean;
}
interface Verdict {
  allow: boolean;
  required?: string;
  reason?: string;
}

const TARGET_ROW = { id: 'user-target', email: 'target@example.com', tier: 'member' };

const INTERNAL_VIEWER: Viewer = { userId: 'user-internal', tier: 'internal', emailVerified: true };
const INTERNAL_VERDICT: Verdict = { allow: true, required: 'internal', reason: 'allowed' };
const MEMBER_VIEWER: Viewer = { userId: 'user-member', tier: 'member', emailVerified: true };
const PAID_VIEWER: Viewer = { userId: 'user-paid', tier: 'paid', emailVerified: true };
// What middleware actually sets on locals.verdict for a member or paid
// caller hitting a route whose ROUTE_POLICY requires 'internal' — see
// entitlement.ts's decide(): RANK[viewer.tier] < RANK[required].
const INSUFFICIENT_VERDICT: Verdict = { allow: false, required: 'internal', reason: 'insufficient-tier' };
const SIGNED_OUT_VERDICT: Verdict = { allow: false, required: 'internal', reason: 'signed-out' };

function ctx(opts: { viewer: Viewer | null; verdict?: Verdict; form?: Record<string, string> }) {
  const body = new FormData();
  for (const [key, value] of Object.entries(opts.form ?? {})) body.set(key, value);
  const request = new Request('https://antialgo.ai/internal/tier', { method: 'POST', body });
  return {
    request,
    locals: { viewer: opts.viewer, verdict: opts.verdict },
    cookies: { set: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Parses the relay cookie a handler set, the only place its ok/message pair lives. */
function relayPayload(context: ReturnType<typeof ctx>): { ok: boolean; message: string } {
  const call = context.cookies.set.mock.calls[0];
  expect(call, 'expected the handler to set the relay cookie').toBeDefined();
  return JSON.parse(call[1]);
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [TARGET_ROW] });
});

describe('POST /internal/tier refuses every caller who is not internal', () => {
  it('signed out: refused, and no write happens', async () => {
    const context = ctx({ viewer: null, verdict: SIGNED_OUT_VERDICT, form: { email: TARGET_ROW.email, tier: 'paid' } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('member: refused, no write', async () => {
    const context = ctx({ viewer: MEMBER_VIEWER, verdict: INSUFFICIENT_VERDICT, form: { email: TARGET_ROW.email, tier: 'paid' } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('paid: refused, no write', async () => {
    const context = ctx({ viewer: PAID_VIEWER, verdict: INSUFFICIENT_VERDICT, form: { email: TARGET_ROW.email, tier: 'internal' } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /internal/tier, called as internal', () => {
  it('allowed, and the write happens with the expected arguments', async () => {
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: TARGET_ROW.email, tier: 'paid' } });
    const res = await POST(context);

    expect(res.status).toBe(303);
    expect(query).toHaveBeenCalledTimes(2);
    // Call 1: the lookup by email (tier.ts:78-85).
    expect(query.mock.calls[0][1]).toEqual([TARGET_ROW.email]);
    // Call 2: the upsert that actually grants the tier (tier.ts:100-104).
    const [writeSql, writeParams] = query.mock.calls[1];
    expect(writeSql).toContain('INSERT INTO app_user_profile');
    expect(writeSql).toContain('ON CONFLICT (user_id) DO UPDATE SET tier');
    expect(writeParams).toEqual([TARGET_ROW.id, 'paid']);
    expect(relayPayload(context).ok).toBe(true);
  });

  it('a malformed body is refused cleanly, no write, no throw', async () => {
    // Not an email address at all — the first validation tier.ts runs
    // (line 72), before the tier value or the database are ever touched.
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: 'not-an-email', tier: 'paid' } });

    await expect(POST(context)).resolves.toBeInstanceOf(Response);
    const res = await POST(ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: 'not-an-email', tier: 'paid' } }));

    expect(res.status).toBe(303);
    expect(query).not.toHaveBeenCalled();
    expect(relayPayload(context).ok).toBe(false);
  });

  describe('THE ONE THAT MATTERS MOST: cannot set a tier outside the known set', () => {
    it('an invented tier (not in tiers.config.mjs at all) is refused, not written', async () => {
      const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: TARGET_ROW.email, tier: 'owner' } });
      const res = await POST(context);

      expect(res.status).toBe(303);
      expect(query, 'an internal caller sent tier=owner, which is not one of public/waitlisted/member/paid/internal').not.toHaveBeenCalled();
      const payload = relayPayload(context);
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain('waitlisted, member, paid');
    });

    it('a real tier this control does not hand out (internal) is refused, not written', async () => {
      // 'internal' IS in tiers.config.mjs's TIERS, so isTier('internal') is
      // true — the escalation this guards is SETTABLE excluding it, per
      // tier.ts's own header: "'internal' is the gate this page sits
      // behind... not a thing to hand to an account from a form."
      const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: TARGET_ROW.email, tier: 'internal' } });
      const res = await POST(context);

      expect(res.status).toBe(303);
      expect(query, 'an internal caller tried to grant itself/another account internal through the tier form').not.toHaveBeenCalled();
      expect(relayPayload(context).ok).toBe(false);
    });

    it('a real tier this control does not hand out (public) is refused, not written', async () => {
      // 'public' is also in TIERS (the absence of an account) and also
      // excluded from SETTABLE, for the same reason 'internal' is.
      const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: TARGET_ROW.email, tier: 'public' } });
      const res = await POST(context);

      expect(res.status).toBe(303);
      expect(query).not.toHaveBeenCalled();
      expect(relayPayload(context).ok).toBe(false);
    });
  });
});
