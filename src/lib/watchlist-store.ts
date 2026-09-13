/**
 * watchlist-store.ts: the impure half of the Watchlist (MASTER-SPEC 3.6,
 * db/008_watchlist.sql). listFollows() served src/pages/settings/export.ts
 * alone until the Pre-List (RUN-FINISH 3.1, MASTER-SPEC F6) needed a write
 * path: follow() and unfollow() are that path, for src/pages/prelist/
 * follow.ts to call. The notify-on-event logic MASTER-SPEC 3.6 describes
 * still belongs to a later task; nothing here decides anything about that.
 *
 * Same discipline record-store.ts and desk-store.ts already hold themselves
 * to: PARAMETERISED QUERIES ONLY, no string ever concatenated into SQL
 * here. Every function below takes a userId and scopes its query to it; it
 * never accepts a userId from a request body, because a userId is a viewer
 * fact resolved server-side from the session (src/lib/viewer.ts), never a
 * form field a caller could type a stranger's id into.
 *
 * follow() MATCHES desk-store.ts's saveJob() SHAPE ON PURPOSE: an upsert
 * against the table's own primary key (db/008_watchlist.sql: PRIMARY KEY
 * (user_id, prospect_id)), a no-op DO UPDATE rather than DO NOTHING so
 * RETURNING still has a row on the "already followed" path. Following twice
 * is a no-op, not a second row and not an error, which is what that primary
 * key already guarantees; this function just gives the guarantee a caller.
 */
import { db } from './db';

/** node-postgres returns a timestamptz as a Date already in the common
    case, but a test can hand this an ISO string, and a driver upgrade
    could too. Pure: no clock read, a value in, the same instant out. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface FollowRow {
  user_id: string;
  prospect_id: string;
  followed_at: Date | string;
  updated_at: Date | string;
}

export interface StoredFollow {
  /** src/data/prospects.json's own "id" field, unaltered. Not a foreign
      key: see db/008_watchlist.sql's own comment on why that file cannot
      be referenced from this database. */
  prospectId: string;
  followedAt: Date;
}

/** Pure: a row in, the shape the rest of the app reads out. The one
    mapping in this file worth testing with no connection string, the same
    reason record-store.test.ts and desk-store.test.ts exist at all. */
export function rowToStoredFollow(row: FollowRow): StoredFollow {
  return { prospectId: row.prospect_id, followedAt: toDate(row.followed_at) };
}

/** Every prospect this person follows, most recently followed first. */
export async function listFollows(userId: string): Promise<StoredFollow[]> {
  const { rows } = await db().query<FollowRow>(
    'SELECT * FROM watchlist WHERE user_id = $1 ORDER BY followed_at DESC',
    [userId]
  );
  return rows.map(rowToStoredFollow);
}

/**
 * Follows one prospect. Idempotent: see this file's own header for why the
 * upsert's DO UPDATE is a no-op write rather than DO NOTHING.
 *
 * prospectId travels as a parameter, never concatenated, and is not checked
 * against src/data/prospects.json here: db/008_watchlist.sql's own comment
 * explains why prospect_id is deliberately not a foreign key (the file is
 * machine-owned and regenerated wholesale, with no stable row Postgres could
 * reference), so resolving a follow against a live prospect is the caller's
 * job, at read time, the same way desk-store.ts's own callers resolve
 * job_id against src/lib/data.ts's loadJobs().
 */
export async function followProspect(userId: string, prospectId: string): Promise<StoredFollow> {
  const { rows } = await db().query<FollowRow>(
    `INSERT INTO watchlist (user_id, prospect_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, prospect_id) DO UPDATE SET user_id = watchlist.user_id
     RETURNING *`,
    [userId, prospectId]
  );
  return rowToStoredFollow(rows[0]);
}

/** Removes one follow. Returns whether a row was actually removed, the same
    "gone versus never there" distinction desk-store.ts's unsaveJob()
    returns. */
export async function unfollowProspect(userId: string, prospectId: string): Promise<boolean> {
  const result = await db().query('DELETE FROM watchlist WHERE user_id = $1 AND prospect_id = $2', [
    userId,
    prospectId
  ]);
  return (result.rowCount ?? 0) > 0;
}
