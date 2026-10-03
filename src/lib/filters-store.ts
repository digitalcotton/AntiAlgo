/**
 * filters-store.ts: the impure half of the stateful filter (MASTER-SPEC F10's
 * second bullet, RUN-FINISH phase 7; db/009_account_filter_state.sql). One
 * table, one row per person, the same split src/lib/watchlist-store.ts and
 * src/lib/desk-store.ts already draw against their own pure counterparts:
 * the pure half decides what a selection means and whether a value in it is
 * trustworthy (src/lib/board-query.ts's parsers, applied below); the queries
 * decide nothing, including about ownership. Every function below takes a
 * userId and scopes its query to it.
 * None of them accepts a userId from a request body, because a userId is a
 * viewer fact, resolved server-side from the session by src/lib/viewer.ts,
 * never a form field or a JSON body a caller could type a stranger's id
 * into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * WHAT A SAVED SELECTION IS (2026-10-02). The strip's own three answers, in the
 * names the address gives them: `place` (a place key, or `all`), `remote` (the
 * arrangements ticked, as the comma list the address reads, or `all`) and
 * `pay_min` (a floor in thousands, `not-listed`, or `all`). Strings, so the
 * browser's localStorage copy, this row and the address are one shape and the
 * client restores any of them the same way. The column is jsonb and the shape
 * moved without a migration for the reason db/109 gives: the vocabulary is not
 * this table's to fix.
 *
 * VALIDATED HERE, BY THE ADDRESS'S OWN PARSERS. normalizeSavedSelection() builds
 * the address a selection stands for and reads it with parseBoardQuery(), then
 * writes back what that read. There is no second definition of a legal place,
 * arrangement or floor in this file, so the strip, a bookmark and a saved
 * selection can never disagree about what one of them means. The same read
 * is what keeps old rows alive: the first strip named two of these controls
 * `location` and `comp`, and parseBoardQuery already says what those mean now
 * (a one-item `remote`; a band's lower bound as a floor; `under-150`, which is
 * a ceiling a floor cannot say, as no pay filter). A row saved before this
 * change therefore reads as the selection it was, and nothing was migrated.
 *
 * Only `place`, `remote` and `pay_min` are ever written. `location`, `comp` and
 * `freshness` are read, never written: Freshness is no longer offered (owner,
 * 2026-09-28), so a stored value is carried back on a read for whoever wants it
 * and is dropped by the next save, which replaces the whole selection.
 *
 * saveFilterState() applies the same normalisation to whatever it is handed, so
 * no caller can put an unchecked value in the table. It still decides nothing
 * about WHO: the userId is the caller's, resolved from the session.
 */
import { db } from './db';
import { parseBoardQuery, stripValues } from './board-query';
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
 * The address a stored or posted selection stands for, one field per key it is
 * read from. Only strings count, as in an address; `remote` may also arrive as
 * a list of them, which is the same thing as repeating the field. Anything else
 * (a number, a nested object, a stray array under `place`) is not a value and is
 * left out, which parseBoardQuery reads as no choice.
 */
function addressOf(raw: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return params;
  const source = raw as Record<string, unknown>;
  for (const key of ['place', 'remote', 'pay_min', 'location', 'comp', 'freshness']) {
    const value = source[key];
    if (typeof value === 'string') params.append(key, value);
    else if (key === 'remote' && Array.isArray(value)) {
      for (const part of value) if (typeof part === 'string') params.append(key, part);
    }
  }
  return params;
}

/**
 * THE ONE TRANSLATION, in both directions of use. A selection is read as the
 * address it stands for (parseBoardQuery: its allowlists, its precedence between
 * `remote` and the old `location`, between a floor and an old band, and its rule
 * that `not-listed` beats both) and written back as the strip's three values,
 * canonical: `remote` in the address's own order and de-duplicated, a place key
 * only if it parses, a floor only inside the search box's bounds.
 *
 * `freshness` is the one thing carried past the strip, and only when asked.
 */
function stripSelection(raw: unknown, carryFreshness: boolean): FilterSelection {
  const query = parseBoardQuery(addressOf(raw));
  const { place, pay_min } = stripValues(query);
  const selection: FilterSelection = { place, remote: query.remote.length > 0 ? query.remote.join(',') : 'all', pay_min };
  if (carryFreshness && query.freshness !== 'all') selection.freshness = query.freshness;
  return selection;
}

/**
 * What may be written: `place`, `remote` and `pay_min`, each either `all` or a
 * value the address's parsers accept, and nothing else. Pure. A fresh selection
 * from the strip, one posted by hand and an old record handed back in all come
 * out the same way, so a row never holds a value the board would not read.
 */
export function normalizeSavedSelection(raw: unknown): FilterSelection {
  return stripSelection(raw, false);
}

/**
 * What a stored row means now: the same three values, plus `freshness` when an
 * old row holds one that is not `all` (read, not written: see this file's header).
 * Pure. A row that never held a selection, or whose column is not an object,
 * reads as the strip with nothing chosen.
 */
export function readSavedSelection(raw: unknown): FilterSelection {
  return stripSelection(raw, true);
}

/**
 * Pure: a row in, the shape the rest of the app reads out. The one mapping
 * in this file worth testing with no connection string, the same reason
 * watchlist-store.test.ts exists at all.
 *
 * `selection` is read through readSavedSelection(), never cast: a jsonb column
 * is untyped as far as Postgres is concerned, and a row written before the
 * strip changed holds the names the first strip used. Both come back as the
 * selection the strip speaks now.
 */
export function rowToStoredFilterState(row: FilterStateRow): StoredFilterState {
  return { selection: readSavedSelection(row.selection), updatedAt: toDate(row.updated_at) };
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
 *
 * `selection` is whatever the caller has (a request body's value, a record
 * read back from a browser): it is normalised first, so what lands in the
 * table is the strip's three canonical values and the returned state is read
 * back from the row. The write replaces the whole selection, as it always did.
 */
export async function saveFilterState(userId: string, selection: unknown): Promise<StoredFilterState> {
  const { rows } = await db().query<FilterStateRow>(
    `INSERT INTO account_filter_state (user_id, selection)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET selection = EXCLUDED.selection
     RETURNING *`,
    [userId, JSON.stringify(normalizeSavedSelection(selection))]
  );
  return rowToStoredFilterState(rows[0]);
}
