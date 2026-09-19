import { beforeEach, describe, expect, it, vi } from 'vitest';

// db/203 usage persistence is tested by driving completeDraft() against a mocked
// db(), capturing the UPDATE it issues and asserting the token columns it binds.
// The connection is the one thing a worker here may not open, so it is replaced
// with a captured query spy; the pure-function tests below never touch it.
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn((_sql?: string, _params?: unknown[]) => Promise.resolve({ rows: [] as unknown[], rowCount: 1 }))
}));
vi.mock('./db', () => ({ db: () => ({ query: queryMock }) }));

import {
  ABANDONED_REASON,
  completeDraft,
  documentState,
  getJobRendersReconciled,
  jobDraftState,
  rowToRenderRow,
  STALE_CLAIMED_SLACK_MS,
  STALE_UNCLAIMED_MS,
  type GeneratedRenderRow,
  type RenderRow
} from './generated-render-store';

// generated-render-store.ts is the impure half of drafting-on-apply's
// persistence: beginDraft(), completeDraft(), failDraft(), claimJobRender()
// and the reads all open a database connection, which is exactly the thing a
// worker in this repository is not allowed to do. Two things in this file are
// pure and are what "honestly testable without a connection" comes to:
// rowToRenderRow(), the one row-to-shape mapper (the same seam
// desk-store.test.ts tests for rowToStoredApplication()), and
// jobDraftState(), the state math the status endpoint and the draft room
// both call so they can never disagree.

const T0 = Date.parse('2026-09-03T12:00:00Z');

function renderRow(overrides: Partial<GeneratedRenderRow> = {}): GeneratedRenderRow {
  return {
    id: 'render_1',
    kind: 'resume',
    status: 'pending',
    payload: null,
    provider: null,
    model: null,
    failure_reason: null,
    started_at: null,
    updated_at: new Date(T0),
    input_tokens: null,
    output_tokens: null,
    render_ms: null,
    ...overrides
  };
}

describe('rowToRenderRow(): the row-to-shape mapping, not the query', () => {
  it('carries a pending row through with a null payload, provider, model and reason, and null usage', () => {
    const stored = rowToRenderRow(renderRow());
    expect(stored).toEqual({
      id: 'render_1',
      kind: 'resume',
      status: 'pending',
      payload: null,
      provider: null,
      model: null,
      failureReason: null,
      startedAt: null,
      updatedAt: new Date(T0),
      inputTokens: null,
      outputTokens: null,
      renderMs: null
    });
  });

  it('carries a ready row through with its payload, provider and model intact', () => {
    const payload = { kind: 'resume', sections: [] };
    const stored = rowToRenderRow(
      renderRow({ id: 'render_2', status: 'ready', payload, provider: 'anthropic', model: 'claude-sonnet-5' })
    );
    expect(stored.status).toBe('ready');
    expect(stored.payload).toBe(payload);
    expect(stored.provider).toBe('anthropic');
    expect(stored.model).toBe('claude-sonnet-5');
  });

  it('carries a fallback row through with the configured provider still named, per generated-render-store.ts\'s own contract', () => {
    // The apply path's completeDraft() records provider/model on a 'fallback'
    // row too, naming what was attempted even though the deterministic writer
    // produced the payload. This mapper does not decide that; it only has to
    // carry whatever is on the row through unchanged.
    const stored = rowToRenderRow(
      renderRow({ id: 'render_3', kind: 'cover', status: 'fallback', payload: { kind: 'cover' }, provider: 'openai', model: 'gpt-5.6-sol' })
    );
    expect(stored.kind).toBe('cover');
    expect(stored.status).toBe('fallback');
    expect(stored.provider).toBe('openai');
    expect(stored.model).toBe('gpt-5.6-sol');
  });

  it('carries a failed row through with its reason, and decodes the two dates from either a Date or an ISO string', () => {
    const stored = rowToRenderRow(
      renderRow({
        status: 'failed',
        failure_reason: 'the live provider call failed (timed out)',
        started_at: '2026-09-03T11:58:00Z',
        updated_at: '2026-09-03T11:59:00Z'
      })
    );
    expect(stored.status).toBe('failed');
    expect(stored.failureReason).toBe('the live provider call failed (timed out)');
    expect(stored.startedAt?.toISOString()).toBe('2026-09-03T11:58:00.000Z');
    expect(stored.updatedAt.toISOString()).toBe('2026-09-03T11:59:00.000Z');
  });

  it('carries kind (resume vs cover) through unchanged', () => {
    expect(rowToRenderRow(renderRow({ kind: 'resume' })).kind).toBe('resume');
    expect(rowToRenderRow(renderRow({ kind: 'cover' })).kind).toBe('cover');
  });

  it('carries db/203 usage through: a measured row keeps its counts, an unmeasured row reads null', () => {
    const measured = rowToRenderRow(
      renderRow({ status: 'ready', payload: {}, input_tokens: 1200, output_tokens: 340, render_ms: 8100 })
    );
    expect(measured.inputTokens).toBe(1200);
    expect(measured.outputTokens).toBe(340);
    expect(measured.renderMs).toBe(8100);
    // A row with no measurement (a pending row, a deterministic fallback, a
    // pre-db/203 row) reads null, never a zero that would look measured.
    const unmeasured = rowToRenderRow(renderRow());
    expect(unmeasured.inputTokens).toBeNull();
    expect(unmeasured.outputTokens).toBeNull();
    expect(unmeasured.renderMs).toBeNull();
  });
});

describe('completeDraft(): persists db/203 usage, honestly null when not measured', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  // The UPDATE binds, in order: id, status, payload, provider, model,
  // input_tokens, output_tokens, render_ms. These pull the last three off the
  // captured params so the assertions read what actually goes to the column.
  function lastParams(): unknown[] {
    return (queryMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];
  }

  it('writes the measured token counts and render_ms a generative render supplies', async () => {
    await completeDraft('render_1', {
      status: 'ready',
      payload: { kind: 'resume' },
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: { inputTokens: 1200, outputTokens: 340 },
      renderMs: 8100
    });
    const params = lastParams();
    expect(params[5]).toBe(1200); // input_tokens
    expect(params[6]).toBe(340); // output_tokens
    expect(params[7]).toBe(8100); // render_ms
  });

  it('writes a genuine measured zero when a generative call returned no usage field', async () => {
    // 0 is honest here: a wire call happened and billed none. It is the one case
    // a zero belongs in the column, and it must not be turned into null.
    await completeDraft('render_1', {
      status: 'ready',
      payload: {},
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: { inputTokens: 0, outputTokens: 0 },
      renderMs: 5
    });
    const params = lastParams();
    expect(params[5]).toBe(0);
    expect(params[6]).toBe(0);
    expect(params[7]).toBe(5);
  });

  it('leaves the columns NULL when usage is omitted (a deterministic, no-key fallback)', async () => {
    await completeDraft('render_1', {
      status: 'fallback',
      payload: {},
      provider: null,
      model: null
    });
    const params = lastParams();
    expect(params[5]).toBeNull(); // input_tokens: not measured, not zero
    expect(params[6]).toBeNull(); // output_tokens
    expect(params[7]).toBeNull(); // render_ms
  });
});

describe('jobDraftState(): one answer for the status endpoint and the draft room', () => {
  const CEILING_MS = 300_000;

  function row(overrides: Partial<GeneratedRenderRow> = {}): RenderRow {
    return rowToRenderRow(renderRow(overrides));
  }

  it('is none when nothing was ever started', () => {
    expect(jobDraftState({ resume: null, cover: null }, T0, CEILING_MS)).toBe('none');
  });

  it('is pending while either row is pending and fresh', () => {
    const ready = row({ kind: 'resume', status: 'ready', payload: {} });
    expect(jobDraftState({ resume: ready, cover: row({ kind: 'cover' }) }, T0 + 5_000, CEILING_MS)).toBe('pending');
  });

  it('is pending in the half-written moment between the two INSERTs (one row present)', () => {
    expect(jobDraftState({ resume: row({ status: 'ready', payload: {} }), cover: null }, T0, CEILING_MS)).toBe('pending');
  });

  it('is ready only when both rows are present and settled', () => {
    const resume = row({ kind: 'resume', status: 'ready', payload: {} });
    const cover = row({ kind: 'cover', status: 'fallback', payload: {} });
    expect(jobDraftState({ resume, cover }, T0, CEILING_MS)).toBe('ready');
  });

  it('is failed the moment either row is marked failed', () => {
    const resume = row({ kind: 'resume', status: 'ready', payload: {} });
    const cover = row({ kind: 'cover', status: 'failed', failure_reason: 'timed out' });
    expect(jobDraftState({ resume, cover }, T0, CEILING_MS)).toBe('failed');
  });

  it('declares a claimed row abandoned once it has been pending past the ceiling plus slack, and not a moment before', () => {
    const claimed = row({ started_at: new Date(T0), updated_at: new Date(T0) });
    const cover = row({ kind: 'cover', status: 'ready', payload: {} });
    const limit = CEILING_MS + STALE_CLAIMED_SLACK_MS;
    expect(jobDraftState({ resume: claimed, cover }, T0 + limit, CEILING_MS)).toBe('pending');
    expect(jobDraftState({ resume: claimed, cover }, T0 + limit + 1, CEILING_MS)).toBe('failed');
  });

  it('declares an unclaimed row dropped much sooner: nobody ever picked it up', () => {
    const unclaimed = row({ started_at: null, updated_at: new Date(T0) });
    const cover = row({ kind: 'cover', status: 'ready', payload: {} });
    expect(jobDraftState({ resume: unclaimed, cover }, T0 + STALE_UNCLAIMED_MS, CEILING_MS)).toBe('pending');
    expect(jobDraftState({ resume: unclaimed, cover }, T0 + STALE_UNCLAIMED_MS + 1, CEILING_MS)).toBe('failed');
  });
});

describe('documentState(): one document on its own', () => {
  const CEILING_MS = 300_000;
  function row(overrides: Partial<GeneratedRenderRow> = {}): RenderRow {
    return rowToRenderRow(renderRow(overrides));
  }

  it('is none for an absent row', () => {
    expect(documentState(null, T0, CEILING_MS)).toBe('none');
  });

  it('is failed for a row marked failed', () => {
    expect(documentState(row({ status: 'failed', failure_reason: 'timed out' }), T0, CEILING_MS)).toBe('failed');
  });

  it('is ready for a settled row, including the no-key fallback', () => {
    expect(documentState(row({ status: 'ready', payload: {} }), T0, CEILING_MS)).toBe('ready');
    expect(documentState(row({ status: 'fallback', payload: {} }), T0, CEILING_MS)).toBe('ready');
  });

  it('holds a claimed pending row as pending until the ceiling plus slack, then calls it failed', () => {
    const claimed = row({ started_at: new Date(T0), updated_at: new Date(T0) });
    const limit = CEILING_MS + STALE_CLAIMED_SLACK_MS;
    expect(documentState(claimed, T0 + limit, CEILING_MS)).toBe('pending');
    expect(documentState(claimed, T0 + limit + 1, CEILING_MS)).toBe('failed');
  });

  it('drops an unclaimed pending row much sooner: nobody ever picked it up', () => {
    const unclaimed = row({ started_at: null, updated_at: new Date(T0) });
    expect(documentState(unclaimed, T0 + STALE_UNCLAIMED_MS, CEILING_MS)).toBe('pending');
    expect(documentState(unclaimed, T0 + STALE_UNCLAIMED_MS + 1, CEILING_MS)).toBe('failed');
  });

  it('jobDraftState is exactly the two documentState answers folded together', () => {
    const ready = row({ status: 'ready', payload: {} });
    const failed = row({ kind: 'cover', status: 'failed', failure_reason: 'timed out' });
    // resume ready, cover failed: the pair is failed, matching "any failed".
    expect(documentState(ready, T0, CEILING_MS)).toBe('ready');
    expect(documentState(failed, T0, CEILING_MS)).toBe('failed');
    expect(jobDraftState({ resume: ready, cover: failed }, T0, CEILING_MS)).toBe('failed');
  });
});

describe('getJobRendersReconciled(): the clock writes what it infers', () => {
  const CEILING_MS = 300_000;
  const NOW = T0 + 10_000_000;

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** The one SELECT getJobRenders issues returns these rows; every later query
      (the failDraft UPDATE) falls through to the default rowCount:1. */
  function withCurrentRows(rows: GeneratedRenderRow[]) {
    queryMock.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
  const failUpdates = () =>
    queryMock.mock.calls.filter((c) => typeof c[0] === 'string' && /status\s*=\s*'failed'/.test(c[0] as string));

  it('settles a stale CLAIMED pending row to failed with the abandoned reason, and returns it failed', async () => {
    withCurrentRows([
      renderRow({ id: 'r-stale', kind: 'resume', status: 'pending', started_at: new Date(NOW - 400_000), updated_at: new Date(NOW - 400_000) })
    ]);

    const { resume } = await getJobRendersReconciled('user_1', 'job-1', NOW, CEILING_MS);

    const updates = failUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(['r-stale', ABANDONED_REASON]);
    expect(resume?.status).toBe('failed');
    expect(resume?.failureReason).toBe(ABANDONED_REASON);
    expect(resume?.payload).toBeNull();
  });

  it('settles a stale UNCLAIMED pending row (never started) past the shorter window', async () => {
    withCurrentRows([
      renderRow({ id: 'c-stale', kind: 'cover', status: 'pending', started_at: null, updated_at: new Date(NOW - (STALE_UNCLAIMED_MS + 1_000)) })
    ]);

    const { cover } = await getJobRendersReconciled('user_1', 'job-1', NOW, CEILING_MS);
    expect(failUpdates()).toHaveLength(1);
    expect(cover?.status).toBe('failed');
  });

  it('leaves a fresh pending row alone, and never touches a settled row', async () => {
    withCurrentRows([
      renderRow({ id: 'r-fresh', kind: 'resume', status: 'pending', started_at: new Date(NOW - 5_000), updated_at: new Date(NOW - 5_000) }),
      renderRow({ id: 'c-ready', kind: 'cover', status: 'ready', payload: { kind: 'cover' } })
    ]);

    const { resume, cover } = await getJobRendersReconciled('user_1', 'job-1', NOW, CEILING_MS);
    expect(failUpdates()).toHaveLength(0);
    expect(resume?.status).toBe('pending');
    expect(cover?.status).toBe('ready');
  });

  it('is idempotent: a row already read as failed triggers no write', async () => {
    withCurrentRows([
      renderRow({ id: 'r-failed', kind: 'resume', status: 'failed', failure_reason: ABANDONED_REASON })
    ]);

    const { resume } = await getJobRendersReconciled('user_1', 'job-1', NOW, CEILING_MS);
    expect(failUpdates()).toHaveLength(0);
    expect(resume?.status).toBe('failed');
  });
});
