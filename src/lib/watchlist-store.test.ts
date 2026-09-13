import { describe, expect, it } from 'vitest';
import { rowToStoredFollow, type FollowRow } from './watchlist-store';

// watchlist-store.ts is the impure half of the Watchlist: every exported
// function but one opens a database connection, which is exactly the thing
// a worker in this repository is not allowed to do. rowToStoredFollow() is
// a pure row-to-shape mapper with no I/O in it at all, the same seam
// desk-store.test.ts already tests for desk_saved_job and desk_application.
// That is what "honestly testable without a connection" comes to for this
// file, the same restraint desk-store.test.ts states for itself.
//
// followProspect()'s idempotency (following twice is a no-op, not a second
// row and not an error) is not re-proven here for the same reason
// desk-store.test.ts never calls saveJob() to prove desk_saved_job's
// matching primary key behaves the same way: the guarantee lives in
// db/008_watchlist.sql's PRIMARY KEY (user_id, prospect_id) and the
// ON CONFLICT DO UPDATE this file's header explains, not in branching logic
// this file could run without a live connection. There is nothing pure to
// unit-test about a guarantee the database itself enforces.

function followRow(overrides: Partial<FollowRow> = {}): FollowRow {
  return {
    user_id: 'user_1',
    prospect_id: 'yc-30943:Iw9ggf8-mts-founding-designer',
    followed_at: new Date('2026-08-20T00:00:00.000Z'),
    updated_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides
  };
}

describe('rowToStoredFollow(): the row-to-shape mapping, not the query', () => {
  it('carries prospect_id across as prospectId, unaltered', () => {
    const stored = rowToStoredFollow(followRow());
    expect(stored.prospectId).toBe('yc-30943:Iw9ggf8-mts-founding-designer');
  });

  it('converts followed_at to a Date', () => {
    const stored = rowToStoredFollow(followRow({ followed_at: new Date('2026-08-21T00:00:00.000Z') }));
    expect(stored.followedAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
  });

  it('accepts a string timestamp (what a test or a driver quirk might hand back) as well as a Date', () => {
    const stored = rowToStoredFollow(followRow({ followed_at: '2026-08-22T00:00:00.000Z' }));
    expect(stored.followedAt).toEqual(new Date('2026-08-22T00:00:00.000Z'));
  });

  it('does not carry updated_at onto StoredFollow: the reader only needs when a follow happened', () => {
    const stored = rowToStoredFollow(followRow());
    expect(stored).toEqual({
      prospectId: 'yc-30943:Iw9ggf8-mts-founding-designer',
      followedAt: new Date('2026-08-20T00:00:00.000Z')
    });
  });
});
