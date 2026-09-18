/**
 * ledger-watch-store.ts: the impure half of the Ledger's watch list
 * (db/137_ledger_watch.sql). The same discipline watchlist-store.ts and
 * filters-store.ts hold themselves to: PARAMETERISED QUERIES ONLY, no string
 * ever concatenated into SQL here. Every function takes a userId and scopes its
 * query to it, and none accepts a userId from a request body, because a userId
 * is a viewer fact resolved server-side from the session (src/lib/viewer.ts),
 * never a form field a caller could type a stranger's id into.
 *
 * addWatch() MATCHES watchlist-store.ts's followProspect() SHAPE: an upsert
 * against the table's own primary key (user_id, title), so watching a title
 * already watched is not a second row and not an error. Unlike a follow, an
 * add carries a shelf, so the DO UPDATE actually moves it: adding a stretch
 * title as core is how a reader promotes it, and setShelf() is the same write
 * with the intent named.
 */
import { db } from './db';

export type Shelf = 'core' | 'stretch';

export interface WatchRow {
  user_id: string;
  title: string;
  shelf: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StoredWatch {
  title: string;
  shelf: Shelf;
  createdAt: Date;
}

/** node-postgres returns a timestamptz as a Date already in the common case,
    but a test can hand this an ISO string. Pure: a value in, the same instant
    out. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** A stored shelf, narrowed. Anything the column somehow holds that is not a
    known shelf reads as 'core', the quiet default, never a throw: a row that
    survived a future migration should still render. */
function toShelf(value: string): Shelf {
  return value === 'stretch' ? 'stretch' : 'core';
}

/** Pure: a row in, the shape the rest of the app reads out. The one mapping in
    this file worth testing with no connection string, the same reason
    watchlist-store.test.ts exists at all. */
export function rowToStoredWatch(row: WatchRow): StoredWatch {
  return { title: row.title, shelf: toShelf(row.shelf), createdAt: toDate(row.created_at) };
}

/** Every title this person watches, core first, then most recently added first
    within each shelf: the order the report reads them in. */
export async function listWatches(userId: string): Promise<StoredWatch[]> {
  const { rows } = await db().query<WatchRow>(
    `SELECT * FROM ledger_watch
      WHERE user_id = $1
      ORDER BY (shelf = 'core') DESC, created_at DESC`,
    [userId]
  );
  return rows.map(rowToStoredWatch);
}

/**
 * Adds one title to this person's watch list on the given shelf. Idempotent:
 * upsert against (user_id, title), and the DO UPDATE moves the shelf, so adding
 * a title again is how a reader changes its shelf rather than an error or a
 * second row.
 */
export async function addWatch(userId: string, title: string, shelf: Shelf): Promise<StoredWatch> {
  const { rows } = await db().query<WatchRow>(
    `INSERT INTO ledger_watch (user_id, title, shelf)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, title) DO UPDATE SET shelf = EXCLUDED.shelf
     RETURNING *`,
    [userId, title, shelf]
  );
  return rowToStoredWatch(rows[0]);
}

/** Moves one watched title to the other shelf. Returns the row when it existed,
    null when this person was not watching that title, so a caller can tell a
    move from a no-op. */
export async function setShelf(userId: string, title: string, shelf: Shelf): Promise<StoredWatch | null> {
  const { rows } = await db().query<WatchRow>(
    `UPDATE ledger_watch SET shelf = $3
      WHERE user_id = $1 AND title = $2
      RETURNING *`,
    [userId, title, shelf]
  );
  return rows[0] ? rowToStoredWatch(rows[0]) : null;
}

/** Removes one watched title. Returns whether a row was actually removed, the
    same "gone versus never there" distinction watchlist-store.ts returns. */
export async function removeWatch(userId: string, title: string): Promise<boolean> {
  const result = await db().query('DELETE FROM ledger_watch WHERE user_id = $1 AND title = $2', [userId, title]);
  return (result.rowCount ?? 0) > 0;
}
