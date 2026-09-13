/**
 * filters-store.ts: the impure half of the stateful filter (MASTER-SPEC F10's
 * second bullet, RUN-FINISH phase 7; db/009_account_filter_state.sql). One
 * table, one row per person, the same split src/lib/watchlist-store.ts and
 * src/lib/desk-store.ts already draw against their own pure counterparts:
 * src/lib/filters.ts decides what a selection means and whether a value in
 * it is trustworthy; this file does I/O and decides nothing, including about
 * ownership. Every function below takes a userId and scopes its query to it.
 * None of them accepts a userId from a request body, because a userId is a
 * viewer fact, resolved server-side from the session by src/lib/viewer.ts,
 * never a form field or a JSON body a caller could type a stranger's id
 * into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * THIS FILE DOES NOT VALIDATE A SELECTION. saveFilterState() persists
 * whatever FilterSelection object it is handed, trusting the caller to have
 * already run it through src/lib/filters.ts's normalizeFilterSelection()
 * against the live filter groups. That split matches desk-store.ts's own
 * transitionApplication() trusting its caller to have already run
 * src/lib/desk.ts's transition(): the decision belongs to the one file that
 * knows the current vocabulary, and this file only ever moves bytes.
 */
import { db } from './db';
import type { FilterSelection } from './filters';

export interface FilterStateRow {
  user_id: string;
  /** jsonb: node-postgres hands this back already parsed, the same as any
      other JSON value it reads. */
  selection: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StoredFilterState {
  selection: FilterSelection;
  updatedAt: Date;
}

/** node-postgres returns a timestamptz as a Date already in the common
    case, but a test can hand this an ISO string, and a driver upgrade
    could too. Pure: no clock read, a value in, the same instant out. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Pure: a row in, the shape the rest of the app reads out. The one mapping
 * in this file worth testing with no connection string, the same reason
 * watchlist-store.test.ts exists at all.
 *
 * `selection` is read defensively rather than cast outright: a jsonb column
 * is untyped as far as Postgres is concerned, and the one guarantee this
 * function can make without a live row in hand is that whatever comes back
 * is at least a plain object, never null, an array or a stray primitive. It
 * is not re-validated against the live filter groups here; that check
 * belongs to normalizeFilterSelection() in src/lib/filters.ts, run by
 * whichever caller is about to act on the value (see that function's own
 * comment on why the vocabulary lives there and not in this table).
 */
export function rowToStoredFilterState(row: FilterStateRow): StoredFilterState {
  const selection: FilterSelection =
    row.selection !== null && typeof row.selection === 'object' && !Array.isArray(row.selection)
      ? (row.selection as FilterSelection)
      : {};
  return { selection, updatedAt: toDate(row.updated_at) };
}

/** This person's stored selection, or null when they have never saved one:
    a fresh account and an account that cleared every filter back to 'all'
    are told apart by row presence, not by an empty object standing in for
    "never set". */
export async function getFilterState(userId: string): Promise<StoredFilterState | null> {
  const { rows } = await db().query<FilterStateRow>(
    'SELECT * FROM account_filter_state WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  return row ? rowToStoredFilterState(row) : null;
}

/**
 * Saves this person's selection. Upsert against the table's own primary key
 * (db/009_account_filter_state.sql: PRIMARY KEY (user_id)), the same shape
 * watchlist-store.ts's followProspect() and desk-store.ts's saveJob() use
 * for their own idempotent writes: saving again, even the identical
 * selection, is the normal case here (every filter change is a save), not
 * an error and not a second row.
 */
export async function saveFilterState(userId: string, selection: FilterSelection): Promise<StoredFilterState> {
  const { rows } = await db().query<FilterStateRow>(
    `INSERT INTO account_filter_state (user_id, selection)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET selection = EXCLUDED.selection
     RETURNING *`,
    [userId, JSON.stringify(selection)]
  );
  return rowToStoredFilterState(rows[0]);
}
