import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_IMPORT_WIRE_STATUSES,
  pollEnds,
  readLanded,
  wireStatusOf,
  type ImportWireStatus
} from './resume-parse-wire';

/**
 * THE SEAM ITSELF: what the status endpoint actually puts on the wire, for every
 * state the row can be in, checked against the predicates every browser reads it
 * with.
 *
 * WHY THIS IS A SEPARATE TEST FROM BOTH SIDES OF IT. ab7b03c changed the row's
 * lifetime and updated resume-parse-runner.test.ts with 51 new lines of assertions
 * about what the runner WROTE. Every one of them passed. Not one asked what the
 * endpoint would then SAY, or what a browser would conclude from it, and so a
 * four-day outage shipped with its own tests green.
 *
 * resume-parse-wire.test.ts covers the other half — that no client hand-writes the
 * vocabulary. Between them the contract has both ends nailed down. This file is the
 * middle: the real handler, the real row states, and the real predicates.
 *
 * Everything that would open a database connection is mocked, per this directory's
 * convention (see resume-parse-runner.test.ts's header). What is proved here is the
 * MAPPING from row state to wire status, which is pure once the store is stubbed.
 */

const getParse = vi.fn(async (..._args: unknown[]) => null as unknown);
vi.mock('./resume-parse-store', () => ({
  getParse: (...args: unknown[]) => getParse(...args)
}));

/** A viewer, as middleware puts one on context.locals. */
const VIEWER = { userId: 'seam-test-user' };

async function callStatus(locals: Record<string, unknown>) {
  const { GET } = await import('../pages/profile/import/status');
  const response = await GET({ locals } as never);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body, wire: wireStatusOf(body) };
}

describe('the import status endpoint speaks only the shared vocabulary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getParse.mockResolvedValue(null);
  });

  it('answers a status every consumer can decide, for every row state it can meet', async () => {
    // The four states this endpoint can actually be in, and what each one MEANS to a
    // poller. The expectations are written here independently of the code that
    // produces them, which is the only way this test can disagree with the endpoint.
    const cases: Array<{
      name: string;
      row: unknown;
      locals: Record<string, unknown>;
      expect: { wire: ImportWireStatus; landed: boolean; stop: boolean };
    }> = [
      {
        // THE ONE THAT BROKE /profile FOR FOUR DAYS. The runner deletes the row the
        // instant it has applied the proposals, so from the browser's side this is
        // what a SUCCESSFUL read looks like almost every time.
        name: 'no row, because the read landed and cleared itself',
        row: null,
        locals: { viewer: VIEWER },
        expect: { wire: 'none', landed: true, stop: true }
      },
      {
        name: 'a row still being read',
        row: { status: 'pending', outcome: null },
        locals: { viewer: VIEWER },
        expect: { wire: 'pending', landed: false, stop: false }
      },
      {
        // Durable only when applyParsedProposals threw and left the proposals for
        // review; otherwise visible for a few milliseconds.
        name: 'a finished row that has not been cleared',
        row: {
          status: 'ready',
          outcome: {
            method: 'deterministic',
            fallbackReason: null,
            notes: ['read 3 entries'],
            proposals: { entries: [{}], links: [], name: null }
          }
        },
        locals: { viewer: VIEWER },
        expect: { wire: 'ready', landed: true, stop: true }
      },
      {
        name: 'no viewer at all',
        row: null,
        locals: {},
        expect: { wire: 'signed-out', landed: false, stop: true }
      }
    ];

    for (const scenario of cases) {
      getParse.mockResolvedValue(scenario.row);
      const answer = await callStatus(scenario.locals);

      expect(
        answer.wire,
        `${scenario.name}: the endpoint answered ${JSON.stringify(answer.body.status)}, which is not in ` +
          'ImportWireStatus. A status that exists on the wire and not in the type is exactly how three ' +
          'browser surfaces became wrong at once.'
      ).toBe(scenario.expect.wire);

      expect(readLanded(answer.wire!), `${scenario.name}: readLanded`).toBe(scenario.expect.landed);
      expect(pollEnds(answer.wire!), `${scenario.name}: pollEnds`).toBe(scenario.expect.stop);
    }
  });

  it('never invents a status outside the union', async () => {
    // Every row shape above, plus a couple of malformed ones, and the answer is
    // always a member of the union. This is the assertion that fails the day someone
    // adds `json({ status: 'failed' })` to the endpoint without adding 'failed' to
    // resume-parse-wire.ts — which is the next change the runner's own "one honest
    // dead end" comment predicts.
    const rows: unknown[] = [
      null,
      { status: 'pending', outcome: null },
      { status: 'ready', outcome: { method: 'provider', fallbackReason: null, notes: [], proposals: { entries: [], links: [], name: null } } },
      { status: 'ready', outcome: null }
    ];

    for (const row of rows) {
      getParse.mockResolvedValue(row);
      const answer = await callStatus({ viewer: VIEWER });
      expect(
        ALL_IMPORT_WIRE_STATUSES,
        `the endpoint answered ${JSON.stringify(answer.body.status)} for row ${JSON.stringify(row)}`
      ).toContain(answer.wire);
    }
  });

  it('and a signed-out answer carries the JSON body the poller needs, not a redirect', async () => {
    // The poller reads the content type to tell our JSON from the gate's HTML
    // sign-in page. A 401 that answered with a page instead of {status:'signed-out'}
    // would be indistinguishable from an expired session, which /profile used to
    // report to the reader as "check your connection".
    getParse.mockResolvedValue(null);
    const { GET } = await import('../pages/profile/import/status');
    const response = await GET({ locals: {} } as never);
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });
});
