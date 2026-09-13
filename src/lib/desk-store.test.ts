import { describe, expect, it } from 'vitest';
import {
  createApplicationFromClick,
  rowToStoredApplication,
  rowToStoredSavedJob,
  type ApplicationRow,
  type SavedJobRow
} from './desk-store';

// desk-store.ts is the impure half of the Desk: every exported function but
// three opens a database connection, which is exactly the thing a worker in
// this repository is not allowed to do. rowToStoredSavedJob() and
// rowToStoredApplication() are pure row-to-shape mappers with no I/O in
// them at all, the same seam record-store.test.ts already tests for the
// Profile Record. createApplicationFromClick()'s XOR guard is the third:
// it throws BEFORE ever calling db(), so a malformed call can be pinned
// with no connection string either. These tests are what "honestly
// testable without a connection" comes to for this file.

function savedJobRow(overrides: Partial<SavedJobRow> = {}): SavedJobRow {
  return {
    user_id: 'user_1',
    job_id: 'job-42',
    saved_at: new Date('2026-08-01T00:00:00.000Z'),
    updated_at: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides
  };
}

function applicationRow(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: '7',
    user_id: 'user_1',
    job_id: 'job-42',
    external_url: null,
    snapshot_title: 'Staff Product Designer',
    snapshot_company: 'Acme Corp',
    snapshot_description: 'Redesign checkout end to end.',
    state: 'clicked',
    interview_substage: null,
    abandon_reason: null,
    closed_reason: null,
    offered_comp: null,
    resume_render_id: null,
    cover_render_id: null,
    clicked_at: new Date('2026-08-10T00:00:00.000Z'),
    confirmed_at: null,
    archived_at: null,
    created_at: new Date('2026-08-10T00:00:00.000Z'),
    updated_at: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides
  };
}

describe('rowToStoredSavedJob(): the row-to-shape mapping, not the query', () => {
  it('carries job_id and the two timestamps across', () => {
    const stored = rowToStoredSavedJob(savedJobRow());
    expect(stored.jobId).toBe('job-42');
    expect(stored.savedAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(stored.updatedAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  it('accepts a string timestamp (what a test or a driver quirk might hand back) as well as a Date', () => {
    const stored = rowToStoredSavedJob(savedJobRow({ saved_at: '2026-08-02T00:00:00.000Z' }));
    expect(stored.savedAt).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });
});

describe('rowToStoredApplication(): the row-to-shape mapping, not the query', () => {
  it('converts a string id, as node-postgres returns a bigint, to a number', () => {
    const stored = rowToStoredApplication(applicationRow({ id: '7' }));
    expect(stored.id).toBe(7);
    expect(typeof stored.id).toBe('number');
  });

  it('leaves an already-numeric id alone', () => {
    const stored = rowToStoredApplication(applicationRow({ id: 7 }));
    expect(stored.id).toBe(7);
  });

  it('nests the JD snapshot fields under snapshot, not flat on the top level', () => {
    const stored = rowToStoredApplication(applicationRow());
    expect(stored.snapshot).toEqual({
      title: 'Staff Product Designer',
      company: 'Acme Corp',
      description: 'Redesign checkout end to end.'
    });
  });

  it('carries a null snapshot field as null, not as an empty string, matching db/006_desk.sql', () => {
    const stored = rowToStoredApplication(
      applicationRow({ snapshot_title: null, snapshot_company: null, snapshot_description: null })
    );
    expect(stored.snapshot).toEqual({ title: null, company: null, description: null });
  });

  it('carries jobId set and externalUrl null for a verified-posting application', () => {
    const stored = rowToStoredApplication(applicationRow({ job_id: 'job-42', external_url: null }));
    expect(stored.jobId).toBe('job-42');
    expect(stored.externalUrl).toBeNull();
  });

  it('carries externalUrl set and jobId null for an external-URL application', () => {
    const stored = rowToStoredApplication(
      applicationRow({ job_id: null, external_url: 'https://example.com/careers/42' })
    );
    expect(stored.jobId).toBeNull();
    expect(stored.externalUrl).toBe('https://example.com/careers/42');
  });

  it('carries the state through unchanged', () => {
    const stored = rowToStoredApplication(applicationRow({ state: 'interviewing' }));
    expect(stored.state).toBe('interviewing');
  });

  it('treats confirmed_at NULL as "never confirmed", not a zeroed date', () => {
    const stored = rowToStoredApplication(applicationRow({ confirmed_at: null }));
    expect(stored.confirmedAt).toBeNull();
  });

  it('converts a present confirmed_at to a Date', () => {
    const stored = rowToStoredApplication(applicationRow({ confirmed_at: new Date('2026-08-12T00:00:00.000Z') }));
    expect(stored.confirmedAt).toEqual(new Date('2026-08-12T00:00:00.000Z'));
  });

  it('treats archived_at NULL as "not archived", reading isArchived()-compatibly', () => {
    const stored = rowToStoredApplication(applicationRow({ archived_at: null }));
    expect(stored.archivedAt).toBeNull();
  });

  it('converts a present archived_at to a Date', () => {
    const stored = rowToStoredApplication(applicationRow({ archived_at: new Date('2026-08-24T00:00:00.000Z') }));
    expect(stored.archivedAt).toEqual(new Date('2026-08-24T00:00:00.000Z'));
  });

  it('carries abandon_reason, closed_reason, interview_substage and offered_comp across unchanged', () => {
    const stored = rowToStoredApplication(
      applicationRow({
        state: 'abandoned',
        abandon_reason: 'account_wall',
        closed_reason: null,
        interview_substage: 'Panel round',
        offered_comp: '$180k base'
      })
    );
    expect(stored.abandonReason).toBe('account_wall');
    expect(stored.closedReason).toBeNull();
    expect(stored.interviewSubstage).toBe('Panel round');
    expect(stored.offeredComp).toBe('$180k base');
  });
});

describe('createApplicationFromClick(): the XOR guard, which runs before any database call', () => {
  // Both branches below throw synchronously before this function ever calls
  // db(), so pinning them needs no connection string: a database call here
  // would throw for a different reason (no DATABASE_URL in a test
  // environment) and these tests would fail for the wrong reason if the
  // guard were not actually running first.

  it('rejects a call with neither jobId nor externalUrl set', async () => {
    await expect(
      createApplicationFromClick('user_1', {
        jobId: null,
        externalUrl: null,
        snapshotTitle: null,
        snapshotCompany: null,
        snapshotDescription: null,
        clickedAt: new Date('2026-08-10T00:00:00.000Z')
      })
    ).rejects.toThrow(/exactly one of jobId or externalUrl/);
  });

  it('rejects a call with both jobId and externalUrl set', async () => {
    await expect(
      createApplicationFromClick('user_1', {
        jobId: 'job-42',
        externalUrl: 'https://example.com/careers/42',
        snapshotTitle: null,
        snapshotCompany: null,
        snapshotDescription: null,
        clickedAt: new Date('2026-08-10T00:00:00.000Z')
      })
    ).rejects.toThrow(/exactly one of jobId or externalUrl/);
  });
});
