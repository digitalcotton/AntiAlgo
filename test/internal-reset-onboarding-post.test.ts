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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const connect = vi.fn(async () => ({ query: clientQuery, release: clientRelease }));
vi.mock('../src/lib/db', () => ({ db: () => ({ query: poolQuery, connect }) }));

const { POST, OWNED, KEPT, KEPT_COLUMNS } = await import('../src/pages/internal/reset-onboarding');
const { PERSON_TABLES } = await import('../src/lib/account');

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
    // Length read from OWNED itself, not typed as a number: the number was 10
    // until 2026-09-25 and a literal here is a second place to forget.
    expect(deleteCalls).toHaveLength(OWNED.length);
    for (const [, params] of deleteCalls) {
      expect(params).toEqual([MEMBER_ROW.id]);
    }
    expect(deleteCalls.some(([sql]) => sql.includes('record_entry'))).toBe(true);
    // Every table OWNED names is actually aimed at, in OWNED's own order.
    expect(deleteCalls.map(([sql]) => sql)).toEqual(
      OWNED.map((t) => `DELETE FROM ${t.table} WHERE ${t.column} = $1`)
    );

    const updateCall = clientQuery.mock.calls.find((call: unknown[]) => (call[0] as string).startsWith('UPDATE app_user_profile'));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([MEMBER_ROW.id]);
    // The owner's line on 2026-09-25 was "no data other than the name and the
    // email", so the columns that carry a first run are named one by one
    // rather than spot-checked: cover_letter_text alone used to pass here
    // while handle, the resumé email and the PRF ledger all survived a reset.
    for (const column of [
      'cover_letter_text',
      'cover_letter_source_name',
      'cover_letter_added_at',
      'drafting_provider',
      'generate_on_apply',
      'handle',
      'resume_email',
      'resume_email_use_login',
      'signup_source',
      'record_prf_ids_issued'
    ]) {
      expect(updateCall![0], `${column} survives a reset`).toContain(column);
    }
    // And the ones a reset keeps are not written at all.
    for (const column of ['tier', 'first_name', 'last_name', 'created_at']) {
      expect(updateCall![0], `${column} must survive a reset`).not.toContain(`${column} =`);
    }

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

/**
 * THE DRIFT GUARD, and the reason it exists.
 *
 * OWNED was written out by hand in 2026-09-22 and three per-account tables
 * that landed around it — watchlist (db/108), account_filter_state (db/109)
 * and analytics_event (db/128) — were never added. A reset account therefore
 * walked back into a board that still remembered its filters and a Pre-List
 * that still held its follows: the account looked reset on /start and was not
 * reset on the job side at all. Nothing failed, because nothing was checking.
 *
 * src/lib/account.ts's PERSON_TABLES is this codebase's one inventory of what
 * a person's rows actually are — it is what the delete and export routes read
 * — so this test makes the reset answer to it. A migration that adds a
 * per-account table and a PERSON_TABLES entry now fails here until someone
 * decides, in writing, whether a reset clears it (OWNED) or deliberately
 * keeps it (KEPT).
 */
describe('the reset stays in step with the account inventory', () => {
  const appTables = PERSON_TABLES.filter((t) => t.owner === 'app');

  it('every app-owned table in PERSON_TABLES is either cleared or deliberately kept', () => {
    const named = new Set([...OWNED.map((t) => t.table), ...KEPT.map((t) => t.table)]);
    const unaccounted = appTables.filter((t) => !named.has(t.table)).map((t) => t.table);
    expect(
      unaccounted,
      'a per-account table exists that /internal/reset-onboarding neither clears nor names as kept'
    ).toEqual([]);
  });

  it('the job-side tables the reset used to miss are cleared', () => {
    const cleared = new Set(OWNED.map((t) => t.table));
    for (const table of ['watchlist', 'account_filter_state', 'analytics_event']) {
      expect(cleared.has(table), `${table} survived a reset before 2026-09-25`).toBe(true);
    }
  });

  it('nothing is named twice, and nothing is both cleared and kept', () => {
    const tables = [...OWNED.map((t) => t.table), ...KEPT.map((t) => t.table)];
    expect(new Set(tables).size).toBe(tables.length);
  });
});

/**
 * THE SAME DRIFT GUARD, one level down: the profile row's own columns.
 *
 * The table list above was one half of "a reset does not actually reset".
 * The other half was app_user_profile itself. Its UPDATE cleared four
 * columns, and every column added to that table after those four was simply
 * never considered: handle, resume_email, resume_email_use_login,
 * signup_source and record_prf_ids_issued all survived, which is why a
 * supposedly brand-new test account handed out PRF-0003 as its first entry.
 *
 * So the schema is the source here, the same way PERSON_TABLES is the source
 * above. This reads db/*.sql for every column that has ever been added to
 * app_user_profile and requires each one to be either written by the UPDATE
 * or named in KEPT_COLUMNS with a reason. A migration that adds a column
 * fails this test until someone decides, in writing, which it is.
 */
describe("the reset stays in step with app_user_profile's own schema", () => {
  /** Every column the migrations give app_user_profile, read from db/*.sql.
      Both shapes the schema actually uses: the CREATE TABLE block in db/101,
      and every `ALTER TABLE app_user_profile ... ADD COLUMN IF NOT EXISTS`. */
  function schemaColumns(): string[] {
    const dir = join(process.cwd(), 'db');
    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8');

      const created = sql.match(/CREATE TABLE IF NOT EXISTS app_user_profile\s*\(([\s\S]*?)\n\);/);
      if (created) {
        for (const line of created[1].split('\n')) {
          const bare = line.trim();
          if (!bare || bare.startsWith('--')) continue;
          const name = bare.match(/^([a-z_]+)\s+[a-z]/);
          if (name) found.add(name[1]);
        }
      }

      // Scope to this table: a file may ALTER others in the same breath.
      for (const chunk of sql.split(/ALTER TABLE\s+/).slice(1)) {
        if (!chunk.startsWith('app_user_profile')) continue;
        const statement = chunk.slice(0, chunk.indexOf(';') + 1);
        for (const m of statement.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g)) found.add(m[1]);
      }
    }
    return [...found].sort();
  }

  it('the schema reader actually finds the columns (it is the test\'s own input)', () => {
    const columns = schemaColumns();
    // If this ever goes empty or thin, every assertion below passes vacuously.
    expect(columns).toContain('user_id');
    expect(columns).toContain('tier');
    expect(columns).toContain('record_prf_ids_issued');
    expect(columns).toContain('cover_letter_added_at');
    expect(columns.length).toBeGreaterThanOrEqual(15);
  });

  it('every app_user_profile column is either cleared by the reset or kept on purpose', async () => {
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: MEMBER_ROW.email } });
    await POST(context);
    const update = clientQuery.mock.calls.find((call: unknown[]) =>
      (call[0] as string).startsWith('UPDATE app_user_profile')
    )![0] as string;

    // What the statement actually assigns, read off the statement itself.
    const written = new Set([...update.matchAll(/([a-z_]+)\s*=/g)].map((m) => m[1]));
    const kept = new Set(KEPT_COLUMNS.map((c) => c.column));

    const unaccounted = schemaColumns().filter((c) => !written.has(c) && !kept.has(c));
    expect(
      unaccounted,
      'an app_user_profile column exists that a reset neither clears nor names in KEPT_COLUMNS'
    ).toEqual([]);
  });

  it('every kept column carries a written reason, and none is also cleared', async () => {
    for (const { column, why } of KEPT_COLUMNS) {
      expect(why.length, `${column} is kept with no reason given`).toBeGreaterThan(20);
    }
    const kept = KEPT_COLUMNS.map((c) => c.column);
    expect(new Set(kept).size).toBe(kept.length);
  });

  it('the columns that made a reset account look used are cleared', async () => {
    const context = ctx({ viewer: INTERNAL_VIEWER, verdict: INTERNAL_VERDICT, form: { email: MEMBER_ROW.email } });
    await POST(context);
    const update = clientQuery.mock.calls.find((call: unknown[]) =>
      (call[0] as string).startsWith('UPDATE app_user_profile')
    )![0] as string;

    // record_prf_ids_issued is the one you could see: a brand-new account
    // whose first Profile Record entry came back numbered PRF-0003.
    expect(update).toContain('record_prf_ids_issued = DEFAULT');
    expect(update).toContain('handle = NULL');
  });
});
