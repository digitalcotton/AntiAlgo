/**
 * GET and POST /settings/filters: the signed-in account's saved strip selection.
 *
 * Outside src/pages for the reason test/internal-reset-onboarding-post.test.ts
 * gives in its own header (Astro builds every file under src/pages as a route).
 * The handlers are imported for real and handed a context built by hand, with
 * db.ts mocked so nothing opens a Postgres connection. The store's own rules
 * (what the parsers accept, the legacy mapping) are proven in
 * src/lib/filters-store.test.ts; what is proven here is that the ROUTE hands the
 * store exactly what was posted and answers with what the table would hold, and
 * that a request the strip never sends cannot wipe a saved selection.
 */
import type { APIContext } from 'astro';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../src/lib/db', () => ({ db: () => ({ query }) }));

const { GET, POST } = await import('../src/pages/settings/filters');

const VIEWER = { userId: 'user_member', tier: 'member', emailVerified: true };
const ALLOWED = { allow: true, required: 'member', reason: 'allowed' };

/** What the table holds for this person, or nothing (never saved). */
let stored: { selection: unknown; updated_at: Date } | null;

beforeEach(() => {
  stored = null;
  query.mockReset();
  query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes('INSERT INTO account_filter_state')) {
      stored = { selection: JSON.parse(args[1] as string), updated_at: new Date('2026-10-02T12:00:00.000Z') };
      return { rows: [{ user_id: args[0], created_at: stored.updated_at, ...stored }] };
    }
    if (sql.includes('FROM account_filter_state')) {
      return { rows: stored ? [{ user_id: args[0], created_at: stored.updated_at, ...stored }] : [] };
    }
    // The Desk's applications, read by the same GET: none.
    return { rows: [] };
  });
});

function asContext(parts: { viewer?: unknown; verdict?: unknown; body?: string }): APIContext {
  return {
    locals: { viewer: parts.viewer, verdict: parts.verdict },
    request: new Request('http://localhost/settings/filters', {
      method: parts.body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: parts.body
    })
  } as unknown as APIContext;
}

const post = (body: unknown, raw = false): Promise<Response> =>
  POST(asContext({ viewer: VIEWER, verdict: ALLOWED, body: raw ? (body as string) : JSON.stringify(body) }));
const get = (): Promise<Response> => GET(asContext({ viewer: VIEWER, verdict: ALLOWED }));
const writes = (): unknown[][] => query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO account_filter_state'));

describe('signed out', () => {
  it('GET and POST answer 401 and touch nothing', async () => {
    expect((await GET(asContext({}))).status).toBe(401);
    expect((await POST(asContext({ body: JSON.stringify({ selection: { place: 'GB' } }) }))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST: the strip as the strip writes it', () => {
  it('saves place, remote and the floor, and answers with the selection the table holds', async () => {
    const response = await post({ selection: { place: 'US', remote: 'remote,onsite', pay_min: '100' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selection: { place: 'US', remote: 'remote,onsite', pay_min: '100' } });
    expect(stored?.selection).toEqual({ place: 'US', remote: 'remote,onsite', pay_min: '100' });
  });

  it('saves Not listed, and a city key as the strip names it', async () => {
    await post({ selection: { place: 'GB/London', remote: 'all', pay_min: 'not-listed' } });
    expect(stored?.selection).toEqual({ place: 'GB/London', remote: 'all', pay_min: 'not-listed' });
  });

  it('a cleared strip is a saved selection of nothing, a row that exists, and reads back as nothing', async () => {
    await post({ selection: { place: 'US', remote: 'remote', pay_min: '100' } });
    await post({ selection: { place: 'all', remote: 'all', pay_min: 'all' } });
    expect(stored?.selection).toEqual({ place: 'all', remote: 'all', pay_min: 'all' });
    expect((await (await get()).json()).selection).toEqual({ place: 'all', remote: 'all', pay_min: 'all' });
  });

  it('what the parsers refuse is saved as no choice, and nothing the strip does not own is saved', async () => {
    await post({ selection: { place: 'gb', remote: 'mars', pay_min: '0', fam: 'engineering', freshness: 'fresh', q: 'x' } });
    expect(stored?.selection).toEqual({ place: 'all', remote: 'all', pay_min: 'all' });
  });

  it('a body in the first strip\'s names is saved in this one\'s', async () => {
    const response = await post({ selection: { location: 'hybrid', comp: '200-250', freshness: 'older' } });
    expect(await response.json()).toEqual({ selection: { place: 'all', remote: 'hybrid', pay_min: '200' } });
    expect(stored?.selection).toEqual({ place: 'all', remote: 'hybrid', pay_min: '200' });
  });
});

describe('POST: a request the strip never sends cannot clear what is saved', () => {
  beforeEach(async () => {
    await post({ selection: { place: 'US', remote: 'onsite', pay_min: '150' } });
    query.mockClear();
  });

  it.each([
    ['not JSON', 'this is not json', true],
    ['no selection key', {}, false],
    ['a selection that is null', { selection: null }, false],
    ['a selection that is a string', { selection: 'place=GB' }, false],
    ['a selection that is a list', { selection: ['GB'] }, false],
    ['a body that is a list', [{ place: 'GB' }], false]
  ] as const)('%s: 400, and the row is untouched', async (_name, body, raw) => {
    const response = await post(body, raw);
    expect(response.status).toBe(400);
    expect(writes()).toHaveLength(0);
    expect(stored?.selection).toEqual({ place: 'US', remote: 'onsite', pay_min: '150' });
  });
});

describe('GET: the selection a person sees on arrival', () => {
  it('is null for a person who never saved one, which is not the same as having cleared it', async () => {
    expect((await (await get()).json()).selection).toBeNull();
  });

  it('reads the strip back as it was saved', async () => {
    stored = { selection: { place: 'GB/London', remote: 'hybrid,onsite', pay_min: '150' }, updated_at: new Date() };
    expect((await (await get()).json()).selection).toEqual({ place: 'GB/London', remote: 'hybrid,onsite', pay_min: '150' });
  });

  it('reads a row the first strip saved as the strip speaks now: location is remote, a band is its floor', async () => {
    stored = { selection: { location: 'remote', comp: '150-200', freshness: 'all' }, updated_at: new Date() };
    expect((await (await get()).json()).selection).toEqual({ place: 'all', remote: 'remote', pay_min: '150' });
  });

  it('still reads a freshness an old row holds, and does not write one back', async () => {
    stored = { selection: { location: 'onsite', comp: 'all', freshness: 'fresh' }, updated_at: new Date() };
    expect((await (await get()).json()).selection).toEqual({ place: 'all', remote: 'onsite', pay_min: 'all', freshness: 'fresh' });
    await post({ selection: { place: 'all', remote: 'onsite', pay_min: 'all', freshness: 'fresh' } });
    expect(stored?.selection).toEqual({ place: 'all', remote: 'onsite', pay_min: 'all' });
  });

  it('is cache-proof: a saved selection is read fresh every time', async () => {
    expect((await get()).headers.get('Cache-Control')).toBe('no-store');
  });
});
