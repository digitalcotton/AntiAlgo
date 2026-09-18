/**
 * ledger-prefs-store.ts: the impure half of the Ledger's per-person settings
 * (db/138_ledger_prefs.sql). One table, one row per person, the same split
 * filters-store.ts draws: this file does I/O and decides nothing, including
 * about ownership. Every function takes a userId, resolved server-side from the
 * session (src/lib/viewer.ts), never a request field.
 *
 * PARAMETERISED QUERIES ONLY. THIS FILE DOES NOT VALIDATE A SELECTION: it
 * persists whatever object it is handed, trusting the caller to have narrowed
 * it to the chips that map to real board fields first, the same way
 * filters-store.ts trusts normalizeFilterSelection().
 */
import { db } from './db';

/** The chip selection: real board fields only. Kept deliberately open, like
    filters-store's FilterSelection, so a chip can be added without a schema
    change; the caller decides what a key means. */
export interface LedgerSelection {
  /** Only remote-eligible roles when true. */
  remoteOnly?: boolean;
  /** A floor on comp_range.min, in whole units of the posted currency. */
  compFloor?: number;
  /** An ISO country code or name to hold the lane to, or absent for all. */
  country?: string;
}

export interface LedgerPrefsRow {
  user_id: string;
  selection: unknown;
  last_seen_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StoredLedgerPrefs {
  selection: LedgerSelection;
  /** The instant this reader last loaded the Ledger, or null on the first
      visit. "New since you last looked" is measured against this. */
  lastSeenAt: Date | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Pure: a row in, the shape the app reads out. selection is read defensively,
    the same way filters-store.ts reads its own jsonb column: a plain object or
    an empty one, never null, an array or a stray primitive. */
export function rowToStoredPrefs(row: LedgerPrefsRow): StoredLedgerPrefs {
  const selection: LedgerSelection =
    row.selection !== null && typeof row.selection === 'object' && !Array.isArray(row.selection)
      ? (row.selection as LedgerSelection)
      : {};
  return { selection, lastSeenAt: row.last_seen_at ? toDate(row.last_seen_at) : null };
}

/** This person's stored prefs, or null when they have never had a row: a fresh
    account and one that cleared every chip are told apart by row presence. */
export async function getPrefs(userId: string): Promise<StoredLedgerPrefs | null> {
  const { rows } = await db().query<LedgerPrefsRow>(
    'SELECT * FROM account_ledger_prefs WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  return row ? rowToStoredPrefs(row) : null;
}

/**
 * Saves this person's chip selection. Upsert against the primary key
 * (db/138: PRIMARY KEY (user_id)), the same shape filters-store.ts's
 * saveFilterState() uses: every chip change is a save, not an error and not a
 * second row. last_seen_at is left untouched here; touchLastSeen() owns it.
 */
export async function savePrefs(userId: string, selection: LedgerSelection): Promise<StoredLedgerPrefs> {
  const { rows } = await db().query<LedgerPrefsRow>(
    `INSERT INTO account_ledger_prefs (user_id, selection)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET selection = EXCLUDED.selection
     RETURNING *`,
    [userId, JSON.stringify(selection)]
  );
  return rowToStoredPrefs(rows[0]);
}

/**
 * Advances this reader's last_seen_at to now, creating the row if it is their
 * first visit. Called at the end of an authorized Ledger render, AFTER the page
 * has already read the previous value to decide what counts as new, so the next
 * visit measures against this one.
 */
export async function touchLastSeen(userId: string): Promise<void> {
  await db().query(
    `INSERT INTO account_ledger_prefs (user_id, last_seen_at)
     VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()`,
    [userId]
  );
}
