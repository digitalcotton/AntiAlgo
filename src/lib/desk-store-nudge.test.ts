import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two confirm-loop nudge reads are the only cross-user queries in
// desk-store; both are exercised here against a captured query spy, so the SQL
// shape and the row mapping are checked with no database.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

import { listUnconfirmedForNudge, markConfirmNudged } from './desk-store';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('listUnconfirmedForNudge', () => {
  it('reads unconfirmed, unarchived, not-yet-nudged cards across users and maps them', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 7,
          user_id: 'u1',
          email: 'a@example.com',
          snapshot_title: 'Staff Designer',
          snapshot_company: 'Ambience',
          clicked_at: '2026-09-01T00:00:00Z'
        }
      ]
    });
    const out = await listUnconfirmedForNudge();
    // The query is the confirm-loop read: still-waiting, unnudged, windowed.
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('confirmed_at IS NULL');
    expect(sql).toContain('archived_at IS NULL');
    expect(sql).toContain('confirm_nudged_at IS NULL');
    // Defaults: 3 to 30 days, limit 500.
    expect(query.mock.calls[0][1]).toEqual([3, 30, 500]);
    // And the row maps to the candidate shape the sender consumes.
    expect(out).toEqual([
      {
        applicationId: 7,
        userId: 'u1',
        email: 'a@example.com',
        title: 'Staff Designer',
        company: 'Ambience',
        clickedAt: new Date('2026-09-01T00:00:00Z')
      }
    ]);
  });

  it('honors custom window and limit options', async () => {
    await listUnconfirmedForNudge({ minAgeDays: 1, maxAgeDays: 14, limit: 50 });
    expect(query.mock.calls[0][1]).toEqual([1, 14, 50]);
  });
});

describe('markConfirmNudged', () => {
  it('is a no-op for an empty list', async () => {
    await markConfirmNudged([], new Date());
    expect(query).not.toHaveBeenCalled();
  });

  it('stamps the given applications and guards against a double stamp', async () => {
    const when = new Date('2026-09-05T14:00:00Z');
    await markConfirmNudged([7, 8], when);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('confirm_nudged_at IS NULL');
    expect(query.mock.calls[0][1]).toEqual([[7, 8], when]);
  });
});
