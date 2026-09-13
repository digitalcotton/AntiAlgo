/**
 * resume-parse-store.ts: the impure half of the in-flight resume parse
 * (db/015_resume_parse.sql). One row per person, replaced each upload. The
 * split is the same one record-store.ts and generated-render-store.ts draw:
 * the pure decisions (what a proposal is, how it is verified) live in
 * src/lib/resume-parse.ts; this file only reads and writes, scoped to one
 * userId, never a userId from a request body.
 *
 * TWO WRITES, ONE READ. beginParse() upserts a fresh pending row the moment an
 * upload arrives (clearing any prior outcome, since a new upload replaces the
 * last). completeParse() lands the finished outcome once the background parse
 * returns. getParse() is what the review page reads to decide pending versus
 * ready. Mirrors generated-render-store.ts's beginDraft/completeDraft/
 * getRenders, minus the per-kind fan-out: a parse is one row, not two.
 */
import { db } from './db';
import type { ResumeProposals } from './resume-parse';

/** The finished parse, serialized whole into resume_parse.outcome. */
export interface StoredParseOutcome {
  /** How the ready proposals were produced. */
  readonly method: 'llm' | 'deterministic';
  /** The provider and model that read the resume, for the review page's note,
      when method is llm. Null for a deterministic parse. */
  readonly providerLabel: string | null;
  /** Set only when a provider key was tried and could not be used, so the
      parse fell back to the deterministic reader: the review page shows this
      as an honest "your key could not read this, here is the basic read"
      notice. Null when method is llm, and null for a plain no-key deterministic
      parse (which is not a fallback, just the only reader available). */
  readonly fallbackReason: string | null;
  readonly proposals: ResumeProposals;
  readonly notes: readonly string[];
}

export type ParseStatus = 'pending' | 'ready';

export interface StoredParse {
  readonly status: ParseStatus;
  readonly sourceName: string | null;
  /** Null while status is 'pending'. */
  readonly outcome: StoredParseOutcome | null;
  readonly updatedAt: Date;
}

interface ResumeParseRow {
  status: ParseStatus;
  source_name: string | null;
  outcome: StoredParseOutcome | null;
  updated_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Pure: a row in, the shape the review page reads out. node-postgres decodes
    a jsonb column to a plain object already, so outcome needs no JSON.parse
    here; it is typed as StoredParseOutcome because completeParse() is the only
    writer and writes exactly that shape. */
export function rowToStoredParse(row: ResumeParseRow): StoredParse {
  return {
    status: row.status,
    sourceName: row.source_name,
    outcome: row.outcome,
    updatedAt: toDate(row.updated_at)
  };
}

/**
 * Opens (or replaces) this person's parse as a fresh pending row: a new upload
 * clears the previous outcome so the review page never shows a stale read
 * while a new one is running. ON CONFLICT on the user_id primary key is what
 * makes "one parse per person, replaced each time" true.
 */
export async function beginParse(userId: string, sourceName: string | null): Promise<void> {
  await db().query(
    `INSERT INTO resume_parse (user_id, status, source_name, outcome, updated_at)
     VALUES ($1, 'pending', $2, NULL, now())
     ON CONFLICT (user_id) DO UPDATE SET
       status = 'pending',
       source_name = EXCLUDED.source_name,
       outcome = NULL,
       updated_at = now()`,
    [userId, sourceName]
  );
}

/**
 * Lands the finished outcome and flips the row to ready. Scoped to userId, and
 * a no-op (zero rows updated) if beginParse() never ran or the row was deleted
 * mid-parse (an account closed between the two, say); the caller does not need
 * to distinguish, the same "gone versus never there" tolerance the other
 * stores hold.
 */
export async function completeParse(userId: string, outcome: StoredParseOutcome): Promise<void> {
  await db().query(
    `UPDATE resume_parse SET status = 'ready', outcome = $2::jsonb, updated_at = now()
     WHERE user_id = $1`,
    [userId, JSON.stringify(outcome)]
  );
}

/** This person's current parse, or null when they have never uploaded one. */
export async function getParse(userId: string): Promise<StoredParse | null> {
  const { rows } = await db().query<ResumeParseRow>(
    'SELECT status, source_name, outcome, updated_at FROM resume_parse WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  return row ? rowToStoredParse(row) : null;
}

/** Removes this person's parse buffer, for the confirm step to call once the
    proposals have been acted on: the working buffer has done its job and does
    not need to linger. Never an error to call when there is no row. */
export async function clearParse(userId: string): Promise<void> {
  await db().query('DELETE FROM resume_parse WHERE user_id = $1', [userId]);
}
