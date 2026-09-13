import { describe, expect, it } from 'vitest';
import { rowToStoredFilterState, type FilterStateRow } from './filters-store';

// filters-store.ts is the impure half of the stateful filter: every
// exported function but one opens a database connection, which is exactly
// the thing a worker in this repository is not allowed to do.
// rowToStoredFilterState() is a pure row-to-shape mapper with no I/O in it
// at all, the same seam watchlist-store.test.ts and desk-store.test.ts
// already test for their own tables. That is what "honestly testable
// without a connection" comes to for this file.
//
// saveFilterState()'s idempotency (saving again overwrites, not appends) is
// not re-proven here for the same reason watchlist-store.test.ts never
// calls followProspect() to prove its own primary key behaves the same way:
// the guarantee lives in db/009_account_filter_state.sql's PRIMARY KEY
// (user_id) and the ON CONFLICT DO UPDATE this file's header explains, not
// in branching logic this file could run without a live connection.

function filterStateRow(overrides: Partial<FilterStateRow> = {}): FilterStateRow {
  return {
    user_id: 'user_1',
    selection: { location: 'remote', comp: 'not-listed' },
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    updated_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides
  };
}

describe('rowToStoredFilterState(): the row-to-shape mapping, not the query', () => {
  it('carries a well-formed jsonb object across as selection, unaltered', () => {
    const stored = rowToStoredFilterState(filterStateRow());
    expect(stored.selection).toEqual({ location: 'remote', comp: 'not-listed' });
  });

  it('converts updated_at to a Date', () => {
    const stored = rowToStoredFilterState(filterStateRow({ updated_at: new Date('2026-08-21T00:00:00.000Z') }));
    expect(stored.updatedAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
  });

  it('accepts a string timestamp (what a test or a driver quirk might hand back) as well as a Date', () => {
    const stored = rowToStoredFilterState(filterStateRow({ updated_at: '2026-08-22T00:00:00.000Z' }));
    expect(stored.updatedAt).toEqual(new Date('2026-08-22T00:00:00.000Z'));
  });

  it('does not carry created_at onto StoredFilterState: the reader only needs the last save', () => {
    const stored = rowToStoredFilterState(filterStateRow());
    expect(stored).toEqual({
      selection: { location: 'remote', comp: 'not-listed' },
      updatedAt: new Date('2026-08-20T00:00:00.000Z')
    });
  });

  it('defaults selection to an empty object rather than throwing when the column reads back null', () => {
    // A defensive case that should never happen against the real schema
    // (selection is NOT NULL DEFAULT '{}'::jsonb), kept anyway for the same
    // reason rowToStoredFollow() and rowToStoredSavedJob() do not trust a
    // driver to always agree with a migration: the column is untyped as
    // far as Postgres' wire protocol is concerned.
    const stored = rowToStoredFilterState(filterStateRow({ selection: null }));
    expect(stored.selection).toEqual({});
  });

  it('defaults selection to an empty object for an array or a stray primitive too', () => {
    expect(rowToStoredFilterState(filterStateRow({ selection: ['not', 'an', 'object'] })).selection).toEqual({});
    expect(rowToStoredFilterState(filterStateRow({ selection: 'not-an-object' })).selection).toEqual({});
  });
});
