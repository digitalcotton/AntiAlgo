/**
 * jobs-data-access.test.ts: the gate on /jobs-data/summary.
 *
 * Signed out is 401, a member is 403, a bad parameter is 400, and too many
 * requests is 429. The tier is read from the session on EVERY request, so these
 * assert the endpoint itself rather than the page that linked to it.
 *
 * The viewer resolution is mocked because the point is the gate, not Better
 * Auth's session handling, which has its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hit, resetRateLimits, addressOf } from './rate-limit';

const viewerFrom = vi.fn();
vi.mock('./viewer', () => ({ viewerFrom: (...a: unknown[]) => viewerFrom(...a) }));
// The gate must refuse before any query runs, so these throw if reached by a
// caller that should have been turned away.
vi.mock('./jobs-data-cache', () => ({
  cachedFacts: async () => ({ liveN: 1, pricedN: 0, customLivePct: 0, atsOptions: [{ key: 'ashby', n: 1 }], titleIndex: [] }),
  cachedView: async () => ({ stamp: 's', live: { cutN: 1 }, kills: { killCutN: 0 } })
}));

const { GET } = await import('../pages/jobs-data/summary');

const PAID = { userId: 'u1', tier: 'paid', emailVerified: true };
const INTERNAL = { userId: 'u2', tier: 'internal', emailVerified: true };
const MEMBER = { userId: 'u3', tier: 'member', emailVerified: true };
const UNVERIFIED = { userId: 'u4', tier: 'paid', emailVerified: false };

function ctx(url = 'https://antialgo.ai/jobs-data/summary', ip = '10.0.0.1') {
  return {
    request: new Request(url, { headers: { 'x-forwarded-for': ip } }),
    locals: {}
  } as never;
}

beforeEach(() => {
  resetRateLimits();
  viewerFrom.mockReset();
});

describe('/jobs-data/summary refuses everyone it should', () => {
  it('401 when nobody is signed in', async () => {
    viewerFrom.mockResolvedValue(null);
    const res = await GET(ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty('error');
  });

  it('403 for a signed-in member, which is not the same as 401', async () => {
    viewerFrom.mockResolvedValue(MEMBER);
    const res = await GET(ctx());
    expect(res.status).toBe(403);
  });

  it('403 for a paid account whose address was never verified', async () => {
    viewerFrom.mockResolvedValue(UNVERIFIED);
    expect((await GET(ctx())).status).toBe(403);
  });

  it('200 for paid and for internal, which outranks paid', async () => {
    for (const v of [PAID, INTERNAL]) {
      resetRateLimits();
      viewerFrom.mockResolvedValue(v);
      const res = await GET(ctx());
      expect(res.status, `tier ${v.tier}`).toBe(200);
      expect(await res.json()).toHaveProperty('live');
    }
  });

  it('never lets a response be cached by anything shared', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const res = await GET(ctx());
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('400 with the parameter named when a filter value is not on the list', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const res = await GET(ctx('https://antialgo.ai/jobs-data/summary?level=Junior'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ param: 'level' });
  });

  it('400 for an applicant system the crawl does not hold', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const res = await GET(ctx('https://antialgo.ai/jobs-data/summary?ats=nonesuch'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ param: 'ats' });
  });

  it('429 once one account goes past its minute, with a retry-after', async () => {
    viewerFrom.mockResolvedValue(PAID);
    let last: Response | null = null;
    for (let i = 0; i < 62; i += 1) last = await GET(ctx());
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('429 from one address before the session is even resolved', async () => {
    // The address limit is counted first, so an unauthenticated flood cannot
    // make the endpoint do session work per request.
    viewerFrom.mockResolvedValue(null);
    let last: Response | null = null;
    for (let i = 0; i < 242; i += 1) last = await GET(ctx('https://antialgo.ai/jobs-data/summary', '9.9.9.9'));
    expect(last!.status).toBe(429);
  });
});

describe('the rate limiter itself', () => {
  beforeEach(resetRateLimits);

  it('allows exactly max requests and refuses the next', () => {
    const limit = { max: 3, windowMs: 1000 };
    expect(hit('k', limit, 0).ok).toBe(true);
    expect(hit('k', limit, 0).ok).toBe(true);
    const third = hit('k', limit, 0);
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    expect(hit('k', limit, 0).ok).toBe(false);
  });

  it('opens a fresh window once the old one has passed', () => {
    const limit = { max: 1, windowMs: 1000 };
    expect(hit('k', limit, 0).ok).toBe(true);
    expect(hit('k', limit, 500).ok).toBe(false);
    expect(hit('k', limit, 1001).ok).toBe(true);
  });

  it('counts each key on its own', () => {
    const limit = { max: 1, windowMs: 1000 };
    expect(hit('a', limit, 0).ok).toBe(true);
    expect(hit('b', limit, 0).ok).toBe(true);
    expect(hit('a', limit, 0).ok).toBe(false);
  });

  it('reads the first entry of x-forwarded-for and nothing else', () => {
    expect(addressOf(new Request('https://x/', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }))).toBe('1.2.3.4');
    expect(addressOf(new Request('https://x/'))).toBe('unknown');
  });
});
