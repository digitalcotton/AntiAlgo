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
 * reset-onboarding.test.ts: the negative tests for POST
 * /internal/reset-onboarding — the endpoint that puts one account back to
 * the start of Come ready by deleting every row Come ready wrote (see
 * reset-onboarding.ts's own header for the full list and for why it exists:
 * testing a first run means running it more than once).
 *
 * Same convention as tier.test.ts beside this file, src/lib/jobs-data-access
 * .test.ts (import the real handler, build locals by hand) and
 * test/desk-job-draft-post.test.ts (a POST with a FormData body). db.ts is
 * mocked so nothing here opens a Postgres connection, the same constraint
 * src/lib/resume-parse-runner.test.ts's header states for its own worker.
 *
 * WHICH LAYER THIS EXERCISES. Identical shape to tier.ts: '/internal' is
 * gated to the 'internal' tier in ROUTE_POLICY, and src/middleware.ts never
 * calls next() for a signed-out, member or paid caller, so
 * reset-onboarding.ts:73's own `if (!viewer || context.locals.verdict?.allow
 * !== true)` line is defense in depth that real traffic never exercises
 * today. These tests build the APIContext by hand and call the handler
 * directly, the way a caller that reached this file by any route other than
 * the one Astro wires up would, so that line has an actual test rather than
 * an assumption that middleware will always be the only door.
 *
 * THE "OUTSIDE THE KNOWN SET" ANALOGUE FOR THIS ENDPOINT. tier.ts has a tier
 * form field to attack; this endpoint has none — the only ON CONFLICT
 * UPDATE it can be aimed at is app_user_profile.tier, but this handler is
 * strictly a DELETE/UPDATE against the same email lookup as tier.ts and it
 * never writes a tier at all. What plays the same "outside the guarded set"
 * role here is the account it refuses to clear: reset-onboarding.ts's own
 * header calls the internal-account exemption the reason "the tool for
 * clearing test accounts must never be one keystroke away from clearing the
 * account that operates it" — so the test that matters most for this file
 * is that an internal caller cannot use it to wipe another internal
 * account, not even itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const connect = vi.fn(async () => ({ query: clientQuery, release: clientRelease }));
vi.mock('../src/lib/db', () => ({ db: () => ({ query: poolQuery, connect }) }));

const { POST } = await import('../src/pages/internal/reset-onboarding');

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

const MEMBER_ROW = { id: 'user-target', email: 'target@example.com', tier: 'member' };
const INTERNAL_ROW = { id: 'user-already-internal', email: 'ops@example.com', tier: 'internal' };

const INTERNAL_VIEWER: Viewer = { userId: 'user-internal', tier: 'internal', emailVerified: true };
const INTERNAL_VERDICT: Verdict = { allow: true, required: 'internal', reason: 'allowed' };
const MEMBER_VIEWER: Viewer = { userId: 'user-member', tier: 'member', emailVerified: true };
const PAID_VIEWER: Viewer = { userId: 'user-paid', tier: 'paid', emailVerified: true };
// What middleware actually sets on locals.verdict for a member or paid
// caller hitting a route ROUTE_POLICY requires 'internal' for — see
// entitlement.ts's decide(): RANK[viewer.tier] < RANK[required].
const INSUFFICIENT_VERDICT: Verdict = { allow: false, required: 'internal', reason: 'insufficient-tier' };
const SIGNED_OUT_VERDICT: Verdict = { allow: false, required: 'internal', reason: 'signed-out' };

function ctx(opts: { viewer: Viewer | null; verdict?: Verdict; form?: Record<string, string> }) {
  const body = new FormData();
  for (const [key, value] of Object.entries(opts.form ?? {})) body.set(key, value);
  const request = new Request('https://antialgo.ai/internal/reset-onboarding', { method: 'POST', body });
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
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [MEMBER_ROW] });
  connect.mockClear();
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rowCount: 0 });
  clientRelease.mockReset();
});

describe('POST /internal/reset-onboarding refuses every caller who is not internal', () => {
  it('signed out: refused, and no write happens', async () => {
    const context = ctx({ viewer: null, verdict: SIGNED_OUT_VERDICT, form: { email: MEMBER_ROW.email } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('member: refused, no write', async () => {
    const context = ctx({ viewer: MEMBER_VIEWER, verdict: INSUFFICIENT_VERDICT, form: { email: MEMBER_ROW.email } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('paid: refused, no write', async () => {
    const context = ctx({ viewer: PAID_VIEWER, verdict: INSUFFICIENT_VERDICT, form: { email: MEMBER_ROW.email } });
    const res = await POST(context);
    expect(res.status).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('POST /internal/reset-onboarding, called as internal', () => {
  it('allowed, and the write happens with the expected arguments', async () => {
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: MEMBER_ROW.email } });
    const res = await POST(context);

    expect(res.status).toBe(303);
    // The lookup by email (reset-onboarding.ts:82-89).
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery.mock.calls[0][1]).toEqual([MEMBER_ROW.email]);

    // The transaction: BEGIN, one DELETE per OWNED table, the profile UPDATE, COMMIT.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery).toHaveBeenLastCalledWith('COMMIT');

    const deleteCalls = clientQuery.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith('DELETE FROM')) as [
      string,
      unknown[]
    ][];
    expect(deleteCalls).toHaveLength(10); // reset-onboarding.ts's OWNED list has 10 tables
    for (const [, params] of deleteCalls) {
      expect(params).toEqual([MEMBER_ROW.id]);
    }
    expect(deleteCalls.some(([sql]) => sql.includes('record_entry'))).toBe(true);

    const updateCall = clientQuery.mock.calls.find((call: unknown[]) => (call[0] as string).startsWith('UPDATE app_user_profile'));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain('cover_letter_text');
    expect(updateCall![1]).toEqual([MEMBER_ROW.id]);

    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(relayPayload(context).ok).toBe(true);
  });

  it('a malformed body is refused cleanly, no write, no throw', async () => {
    // No '@' at all — the one validation reset-onboarding.ts runs (line 79)
    // before the database is touched at all.
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: 'not-an-email' } });

    await expect(POST(context)).resolves.toBeInstanceOf(Response);
    const res = await POST(ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: 'not-an-email' } }));

    expect(res.status).toBe(303);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(relayPayload(context).ok).toBe(false);
  });

  describe('THE ONE THAT MATTERS MOST FOR THIS ENDPOINT: an internal account is never reset here', () => {
    it('the target account being internal is refused, not cleared, even for an internal caller', async () => {
      poolQuery.mockResolvedValue({ rows: [INTERNAL_ROW] });
      const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: INTERNAL_ROW.email } });
      const res = await POST(context);

      expect(res.status).toBe(303);
      // The lookup runs (it has to, to learn the tier)...
      expect(poolQuery).toHaveBeenCalledTimes(1);
      // ...but the transaction that would delete its rows never opens.
      expect(connect, 'an internal caller tried to reset an internal account').not.toHaveBeenCalled();
      const payload = relayPayload(context);
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain('internal');
    });

    it('an internal caller cannot reset their own account by targeting their own email', async () => {
      poolQuery.mockResolvedValue({ rows: [{ id: INTERNAL_VIEWER.userId, email: 'self@example.com', tier: 'internal' }] });
      const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: 'self@example.com' } });
      const res = await POST(context);

      expect(res.status).toBe(303);
      expect(connect, 'the tool for clearing test accounts must never clear the account that operates it').not.toHaveBeenCalled();
      expect(relayPayload(context).ok).toBe(false);
    });
  });
});
