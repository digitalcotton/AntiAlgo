/**
 * record-store.ts: the impure half of the Profile Record. Every query
 * db/004_profile_record.sql's two tables get, and nothing this file
 * decides on its own: the split is the same one entitlement.ts/viewer.ts
 * and account.ts already draw, restated for the same reason. src/lib/
 * record.ts is pure and decides (the shape, the immutable core, the id
 * sequence, the visibility rule, validation); this file does I/O and
 * decides nothing, including about ownership: every function below takes a
 * `userId`, and every function scopes its query to that id. None of them
 * accepts a userId from a request body, because a userId is a viewer fact,
 * resolved server-side from the session by src/lib/viewer.ts, never a form
 * field a caller could type a stranger's id into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * WHY PRF IDS ARE NEVER REUSED, EVEN THOUGH record_entry ACTUALLY DELETES A
 * ROW. record.ts's nextPrfId() demands "every id this person has ever
 * held", not merely the ids of entries that still exist, and record_entry
 * (db/004) genuinely runs DELETE on an entry a person removes, matching
 * MASTER-SPEC's promise that person data is deletable rather than merely
 * hidden. Those two facts collide unless something outside record_entry
 * remembers an id after its row is gone. db/005_record_prf_ledger.sql adds
 * that memory: a text[] column on app_user_profile,
 * `record_prf_ids_issued`, appended to and never trimmed. createEntry()
 * below reads that column, not record_entry, to build the array it hands
 * to nextPrfId(), so a deleted entry's number stays retired forever. See
 * db/005's own header for why a column on an existing, already-tracked
 * table was chosen over a third table.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from './db';
import { recordEvent } from './analytics';
import {
  nextPrfId,
  type ArtifactKind,
  type Classification,
  type EntryDate,
  type EntryKind,
  type NewEntryInput,
  type ProfileArtifact,
  type ProfileEntry,
  type Provenance
} from './record';
import type { LinkPlatform, StoredLink } from './profile-links';

/* -------------------------------------------------------------------------
   The stored shapes. StoredArtifact and StoredEntry both carry the one
   thing record.ts's own ProfileArtifact/ProfileEntry never need: a
   database identity an artifact-remove call can target. A ProfileArtifact
   has no natural key of its own (record_artifact's own comment on this in
   db/004 is why it has a surrogate id at all), so removeArtifact() below
   needs that id and record.ts's type has no field to carry it in. Extending
   rather than duplicating keeps every other field, and its meaning, exactly
   what record.ts already says it is.
   ------------------------------------------------------------------------- */

export interface StoredArtifact extends ProfileArtifact {
  /** record_artifact.id. Postgres returns a bigint as a string; this file
      converts it to a number at the boundary so nothing downstream has to
      remember which driver quirk produced the value. Safe here: an
      IDENTITY column climbing past Number.MAX_SAFE_INTEGER is not a
      scenario this app's own artifact volume will ever reach. */
  id: number;
}

export interface StoredEntry extends ProfileEntry {
  artifacts: readonly StoredArtifact[];
}

/**
 * The document an entry came in on (db/209). Null everywhere it is absent, and
 * absent is the common case: an entry typed into the hand-entry form belongs to
 * nobody but the person, and no document's remove may ever touch it.
 */
export type ImportSource = 'resume' | 'cover_letter';

/** What a caller may change about an entry's core fields. Artifacts are
    deliberately absent: they are added and removed through their own
    functions below, each scoped to one artifact, not replaced wholesale by
    an entry update. */
export type EntryCoreInput = Omit<NewEntryInput, 'artifacts'>;

/* -------------------------------------------------------------------------
   Raw row shapes, field for field against db/004_profile_record.sql, and
   the pure mappers between a row and the shape above. Pure on purpose,
   unlike everything below this section: a mapper that takes a row object
   in and returns a StoredEntry/StoredArtifact out, with no database
   connection anywhere in the call, is the one part of this file that can
   be tested with no connection string, which record-store.test.ts does.
   ------------------------------------------------------------------------- */

export interface RecordEntryRow {
  user_id: string;
  prf_id: string;
  kind: EntryKind;
  employer_or_institution: string | null;
  official_title: string;
  /** null only on a skill, an artifact or a recognition with no date (db/204). */
  start_year: number | null;
  start_month: number | null;
  end_year: number | null;
  end_month: number | null;
  location: string | null;
  description: string;
  classification: Classification;
  provenance: Provenance;
  /** db/209. Null means typed by hand, which is every row written before that
      migration and every row the hand-entry form writes after it. */
  import_source?: ImportSource | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface RecordArtifactRow {
  /** bigint IDENTITY. node-postgres returns int8 as a string by default,
      so the raw row type says so; rowToStoredArtifact() is where it
      becomes a number. */
  id: string | number;
  entry_user_id: string;
  entry_prf_id: string;
  kind: ArtifactKind;
  url: string;
  label: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** One record_entry row, plus the record_artifact rows already joined in
    for it, into the shape the rest of the app reads. */
export function rowToStoredEntry(row: RecordEntryRow, artifacts: readonly StoredArtifact[]): StoredEntry {
  const start: EntryDate | null = row.start_year === null ? null : { year: row.start_year, month: row.start_month };
  const end: EntryDate | null = row.end_year === null ? null : { year: row.end_year, month: row.end_month };

  return {
    prfId: row.prf_id,
    kind: row.kind,
    employerOrInstitution: row.employer_or_institution,
    officialTitle: row.official_title,
    start,
    end,
    location: row.location,
    description: row.description,
    classification: row.classification,
    provenance: row.provenance,
    artifacts
  };
}

export function rowToStoredArtifact(row: RecordArtifactRow): StoredArtifact {
  return {
    id: typeof row.id === 'string' ? Number(row.id) : row.id,
    kind: row.kind,
    url: row.url,
    label: row.label
  };
}

/* -------------------------------------------------------------------------
   Person identity: first_name/last_name only, nothing else on the row.

   NOT PART OF THE PROFILE RECORD. db/002_profile_names.sql put these two
   columns on app_user_profile, one table over from record_entry/
   record_artifact, because a display name is MASTER-SPEC 3.1's Person, not
   3.2's Profile Record this file otherwise exists for. It lives here anyway,
   narrowly, rather than as a new file, because nothing else in this
   codebase's permitted-to-edit surface both does I/O and is allowed to read
   app_user_profile for a caller that only wants a name: src/lib/account.ts
   already reads the same column pair, but only as one field inside the
   full export-bundle row (RawProfileRow), assembled from a query
   src/pages/settings/export.ts runs itself, not through a reusable function.
   A caller that wants only a name should not have to run that whole export
   query to get it.

   EMPTY STRING IS "NOT CAPTURED", NEVER GUESSED. db/002's own comment: "NOT
   NULL DEFAULT '' rather than nullable... a nullable name field spreads a
   null check into every caller, and the one that forgets renders 'Hi
   null,'." personName() below preserves that: it returns the two strings
   exactly as stored, including empty ones, and never substitutes a
   placeholder. Deciding what an empty name means (skip the greeting, skip
   the letterhead, point the person at where to add one) is the caller's
   job, the same way record.ts leaves formatting to its own callers.
   ------------------------------------------------------------------------- */

export interface PersonNameRow {
  first_name: string;
  last_name: string;
}

export interface PersonName {
  firstName: string;
  lastName: string;
}

/** Pure: a row in, the two names out. Nothing else on RawProfileRow (tier,
    signup_source, timestamps) is read or returned; a caller that wants a
    name has no business receiving the rest. */
export function rowToPersonName(row: PersonNameRow): PersonName {
  return { firstName: row.first_name, lastName: row.last_name };
}

/**
 * `userId` is a server-side session fact, never a request field: the same
 * contract every other function in this file holds itself to (see the file
 * header). Returns null only when this person has no app_user_profile row
 * at all, which this file's own createEntry() already treats as "something
 * went wrong" rather than a normal state; it never returns null for a row that
 * exists with two empty strings on it, because that is a real, valid state
 * (see this section's own header) and not an absence.
 */
export async function personName(userId: string): Promise<PersonName | null> {
  const { rows } = await db().query<PersonNameRow>(
    'SELECT first_name, last_name FROM app_user_profile WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  return row ? rowToPersonName(row) : null;
}

/**
 * Writes the two-part name, verbatim. Added for src/pages/settings/
 * name.ts: the gap the owner named directly, "there is no way to
 * edit your name after sign-up."
 *
 * NO VALIDATION, NO TRIM, NO CASE CHANGE, HERE OR IN THE CALLER'S EXPECTED
 * USE. RUN-FINISH 2.1: "a person's name is stored verbatim... sanitise for
 * safety, never for taste." The caller is expected to have already run the
 * value through src/lib/auth.ts's sanitiseNameForStorage() (control
 * characters flattened, length capped at the CHECK constraint below), which
 * is a safety operation, not a cleaning one; this function does not repeat,
 * loosen, or second-guess that choice, the same "does no validation of its
 * own" division this file's own header states for every write here.
 *
 * Returns whether a row was actually updated, the same shape deleteEntry()
 * and removeArtifact() already use, so a caller can tell "no such profile
 * row" apart from a write that silently did nothing. See personName()'s own
 * comment above for why a missing row is "something went wrong" rather than
 * a normal state.
 */
export async function setPersonName(userId: string, firstName: string, lastName: string): Promise<boolean> {
  const result = await db().query(
    'UPDATE app_user_profile SET first_name = $2, last_name = $3 WHERE user_id = $1',
    [userId, firstName, lastName]
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   The handle: MASTER-SPEC F8's public identifier, in waiting. Lives on
   app_user_profile for the identical reason first_name/last_name do (this
   section's own header above): one row per person, already cascading on
   delete (db/010_profile_handle.sql's own footer), and this is the one file
   inside this task's permitted-to-edit surface that both does I/O and is
   allowed to read that table for a caller that wants a single narrow fact.

   NOTHING BELOW DECIDES WHO MAY SEE A PROFILE AT A CLAIMED HANDLE. That
   decision belongs to decideHandleView() at the bottom of this section, and
   to src/pages/u/[handle].astro, which calls it once and never re-decides.
   This block only claims, releases, folds and validates a handle string;
   see db/010_profile_handle.sql's own header for the full reasoning behind
   every rule enforced here.
   ------------------------------------------------------------------------- */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

/**
 * Mirrors db/010_profile_handle.sql's own CHECK constraint exactly:
 * lowercase a-z0-9 only, first and last character alphanumeric, interior
 * hyphens allowed, 3 to 30 characters total. Kept as one literal pattern,
 * not assembled from HANDLE_MIN_LENGTH/HANDLE_MAX_LENGTH, so a reader can
 * compare it against the SQL constraint by eye and see the same rule
 * twice, not a rule and a derivation of it that could drift apart.
 */
const HANDLE_PATTERN = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;

export type HandleIssue = 'empty' | 'length' | 'characters';

export interface HandleValidation {
  ok: boolean;
  issue: HandleIssue | null;
}

/**
 * Format only. Says nothing about whether the handle is already taken;
 * that needs a query and lives in setHandle() below. Pure, and tested as
 * such: no database, same input always the same output, the same
 * discipline record.ts's own validateEntry() holds to for the identical
 * reason (see this file's own header for why that split matters here).
 *
 * EXPECTS ITS INPUT ALREADY FOLDED. This function has no notion of case on
 * purpose (see foldHandleCase() below): a caller that wants "Ryan" treated
 * the same as "ryan" folds first, then validates. Handing this function
 * "Ryan" un-folded returns 'characters', the same answer any other illegal
 * byte would get, because from here there is no way to tell "wrong case"
 * apart from "wrong alphabet".
 */
export function validateHandleFormat(value: string): HandleValidation {
  if (value.length === 0) return { ok: false, issue: 'empty' };
  if (value.length < HANDLE_MIN_LENGTH || value.length > HANDLE_MAX_LENGTH) {
    return { ok: false, issue: 'length' };
  }
  if (!HANDLE_PATTERN.test(value)) return { ok: false, issue: 'characters' };
  return { ok: true, issue: null };
}

/**
 * THE CASE DECISION, IN CODE. "Ryan" and "ryan" are the same handle: both
 * fold to the identical stored value here, so both compete for the
 * identical UNIQUE row. See db/010_profile_handle.sql's own header for the
 * full reasoning, and for why this is safe in a way record.ts's
 * coreMatches() is right to refuse for a person's name or title.
 *
 * NEVER String.prototype.toLowerCase() OR toLocaleLowerCase(). Both apply
 * the full Unicode case-folding table, which is exactly the operation this
 * codebase's own comments (record.ts's coreMatches(), quoted above) already
 * hold is unsafe for text nobody constrained. This function folds nothing
 * but plain ASCII A-Z, one code point at a time, by a fixed arithmetic
 * offset (+32), because that is the only mapping the handle's own legal
 * alphabet (a-z0-9-, see HANDLE_PATTERN above) can ever need: nothing
 * outside A-Z/a-z is a legal handle character to begin with, so nothing
 * outside A-Z ever needs folding, and this function decides nothing about
 * what a wider set of scripts should fold to. A non-ASCII or otherwise
 * illegal character passes through this function unchanged and is refused
 * by validateHandleFormat() by name, on the very next call, rather than
 * being silently folded into something that happens to pass.
 */
export function foldHandleCase(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i];
  }
  return out;
}

export interface HandleRow {
  handle: string | null;
}

/** The handle on file for this person, or null when none is claimed. Same
    "server-side session fact, never a request field" contract every
    function in this file holds to: userId comes from the caller's own
    resolved viewer, never from a form field. */
export async function getHandle(userId: string): Promise<string | null> {
  const { rows } = await db().query<HandleRow>('SELECT handle FROM app_user_profile WHERE user_id = $1', [userId]);
  return rows[0]?.handle ?? null;
}

/**
 * The owner of a claimed handle, or null when nobody holds it.
 *
 * EXPECTS `handle` ALREADY FOLDED. This function runs the query on
 * whatever it is given, with no folding or validation of its own, because
 * its one real caller (src/pages/u/[handle].astro) needs "no such handle",
 * "a handle shaped so badly it could never have been claimed", and
 * anything else that simply matches no row to look identical from here:
 * all three are one code path, a query that returns zero rows, which is
 * exactly the indistinguishability MASTER-SPEC F8's own acceptance line
 * asks the route itself to hold to.
 */
export async function ownerOfHandle(handle: string): Promise<string | null> {
  const { rows } = await db().query<{ user_id: string }>(
    'SELECT user_id FROM app_user_profile WHERE handle = $1',
    [handle]
  );
  return rows[0]?.user_id ?? null;
}

export type SetHandleResult = 'ok' | 'invalid' | 'taken' | 'no-profile-row';

/** Postgres' own code for a UNIQUE constraint violation: 23505,
    unique_violation, per the errcodes table Postgres ships and `pg`
    surfaces unmodified on `error.code`. Read defensively, the same "never
    trust the shape of a thrown value" discipline
    src/pages/settings/email.ts's own errorCodeOf() already holds
    to for a different library's errors. */
function isUniqueViolation(error: unknown): boolean {
  const withCode = error as { code?: unknown } | null;
  return withCode?.code === '23505';
}

/**
 * Claims a handle for this person, or reports why it could not.
 *
 * FOLDS BEFORE VALIDATING, VALIDATES BEFORE WRITING. `rawHandle` is
 * whatever a person actually typed, so "Ryan" is folded to "ryan" here,
 * once, before validateHandleFormat() or the UNIQUE constraint ever see
 * it: neither of those has any notion of case on purpose (see
 * foldHandleCase()'s own comment), so the fold has to already have
 * happened by the time either runs.
 *
 * NEVER REVEALS WHOSE HANDLE IT IS. A unique-constraint failure comes back
 * as 'taken' and nothing else: not the owner, not whether that owner is
 * this same person retrying a handle they already hold, not any detail a
 * caller could use to probe who is behind a given handle. This is also
 * the database-level backstop the whole design leans on: even if some
 * future write path forgot to fold or validate first, this function still
 * cannot end up with two rows sharing one handle, because
 * db/010_profile_handle.sql's own UNIQUE constraint refuses the second
 * write outright, no matter which application path produced it.
 */
export async function setHandle(userId: string, rawHandle: string): Promise<SetHandleResult> {
  const folded = foldHandleCase(rawHandle);
  const validation = validateHandleFormat(folded);
  if (!validation.ok) return 'invalid';

  try {
    const result = await db().query('UPDATE app_user_profile SET handle = $2 WHERE user_id = $1', [userId, folded]);
    return (result.rowCount ?? 0) > 0 ? 'ok' : 'no-profile-row';
  } catch (error) {
    if (isUniqueViolation(error)) return 'taken';
    throw error;
  }
}

/** Releases whatever handle this person holds, if any. Kept separate from
    setHandle() rather than folded into it with an empty-string special
    case: an empty string is not a legal handle
    (validateHandleFormat('').issue === 'empty'), and a caller that means
    "give this up" should say so by calling a function named for it, not by
    an input value the format validator would otherwise just refuse.
    Returns whether a row existed for this user id, the same "gone versus
    never there" shape deleteEntry() and removeArtifact() already answer
    with, below. */
export async function clearHandle(userId: string): Promise<boolean> {
  const result = await db().query('UPDATE app_user_profile SET handle = NULL WHERE user_id = $1', [userId]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   The view decision behind /u/[handle]: owner or 404, nothing else, and
   nothing in between. Pure, on purpose: MASTER-SPEC F8's acceptance line
   ("visibility states enforced at the route level") and this task's own
   brief ("a signed-out visitor, a signed-in stranger, and a request for a
   handle nobody owns must all get the identical response") both need a
   rule a test can call directly, with no request, no database, and no
   Astro runtime, the same reason entitlement.ts's decide() is pure. The
   page (src/pages/u/[handle].astro) calls this once and either renders or
   returns the site's ordinary 404, never branching on ownerId or viewerId
   a second time of its own; see that file's own header.
   ------------------------------------------------------------------------- */

export type HandleViewDecision = 'render' | 'not-found';

/**
 * `ownerId` is ownerOfHandle()'s result: null when the handle matched no
 * row at all. `viewerId` is the resolved session's own userId, null when
 * signed out. Three of the four branches below return 'not-found', for
 * reasons that must never be told apart from outside this function: an
 * unclaimed handle, a signed-out visitor, and a signed-in stranger each
 * take a different branch through this body and each leave it exactly the
 * same way, which is what makes the three cases indistinguishable to a
 * caller that only ever sees the return value, never which branch
 * produced it.
 */
export function decideHandleView(ownerId: string | null, viewerId: string | null): HandleViewDecision {
  if (ownerId === null) return 'not-found';
  if (viewerId === null) return 'not-found';
  if (viewerId !== ownerId) return 'not-found';
  return 'render';
}

/* -------------------------------------------------------------------------
   Reads.
   ------------------------------------------------------------------------- */

/**
 * Every entry a person holds, most recent start date first and the undated
 * ones (db/204) after every dated one, with each entry's artifacts already
 * attached. Two queries rather than a join: a
 * join would repeat every entry column once per artifact, which this file
 * would then have to de-duplicate back apart; two queries and an in-memory
 * group-by is the plainer read for what is, per person, a small table.
 */
export async function listEntries(userId: string): Promise<StoredEntry[]> {
  const [entryResult, artifactResult] = await Promise.all([
    db().query<RecordEntryRow>(
      `SELECT * FROM record_entry
       WHERE user_id = $1
       ORDER BY start_year DESC NULLS LAST, start_month DESC NULLS LAST, prf_id DESC`,
      [userId]
    ),
    db().query<RecordArtifactRow>(
      'SELECT * FROM record_artifact WHERE entry_user_id = $1 ORDER BY id ASC',
      [userId]
    )
  ]);

  const artifactsByPrfId = new Map<string, StoredArtifact[]>();
  for (const row of artifactResult.rows) {
    const list = artifactsByPrfId.get(row.entry_prf_id) ?? [];
    list.push(rowToStoredArtifact(row));
    artifactsByPrfId.set(row.entry_prf_id, list);
  }

  return entryResult.rows.map((row) => rowToStoredEntry(row, artifactsByPrfId.get(row.prf_id) ?? []));
}

/** One entry, with its artifacts, or null when this person holds no entry
    with that id. Never looks at another person's rows: the WHERE clause
    scopes on user_id as well as prf_id, so an id copied from someone
    else's URL matches nothing rather than reading their entry. */
export async function getEntry(userId: string, prfId: string): Promise<StoredEntry | null> {
  const [entryResult, artifactResult] = await Promise.all([
    db().query<RecordEntryRow>('SELECT * FROM record_entry WHERE user_id = $1 AND prf_id = $2', [userId, prfId]),
    db().query<RecordArtifactRow>(
      'SELECT * FROM record_artifact WHERE entry_user_id = $1 AND entry_prf_id = $2 ORDER BY id ASC',
      [userId, prfId]
    )
  ]);

  const row = entryResult.rows[0];
  if (!row) return null;

  return rowToStoredEntry(row, artifactResult.rows.map(rowToStoredArtifact));
}

/* -------------------------------------------------------------------------
   Writes.
   ------------------------------------------------------------------------- */

async function insertArtifact(
  client: PoolClient,
  userId: string,
  prfId: string,
  artifact: ProfileArtifact
): Promise<StoredArtifact> {
  const { rows } = await client.query<RecordArtifactRow>(
    `INSERT INTO record_artifact (entry_user_id, entry_prf_id, kind, url, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, prfId, artifact.kind, artifact.url, artifact.label]
  );
  return rowToStoredArtifact(rows[0]);
}

/**
 * Creates one entry, plus any artifacts it was created with, and returns
 * the whole thing. `input` is expected to already be the `entry` half of
 * an ok validateEntry() result: this function does no validation of its
 * own, the same division record.ts's own header describes for every
 * caller of this file.
 *
 * ONE TRANSACTION, AND WHY. Three things have to agree or none of them
 * happen: the id ledger (app_user_profile.record_prf_ids_issued) records
 * that this id was issued, the entry row is inserted under that id, and
 * every artifact the entry was created with is inserted under it too. A
 * failure partway through (an artifact that somehow fails a CHECK the
 * validated input should have already ruled out) must not leave an id
 * marked issued with no entry behind it, which would burn a number for
 * nothing, nor an entry with only some of its artifacts attached.
 *
 * `SELECT ... FOR UPDATE` on the app_user_profile row is what makes the
 * id assignment itself safe under concurrent submissions from the same
 * person (two browser tabs, a double click that both reach the server):
 * the second transaction blocks on the row lock until the first commits
 * or rolls back, so two calls can never read the same ledger and both
 * compute the same "next" id.
 */
export async function createEntry(
  userId: string,
  input: NewEntryInput,
  importSource: ImportSource | null = null
): Promise<StoredEntry> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');

    const { rows: profileRows } = await client.query<{ record_prf_ids_issued: string[] }>(
      'SELECT record_prf_ids_issued FROM app_user_profile WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const profileRow = profileRows[0];
    if (!profileRow) {
      // Every account gets an app_user_profile row at account creation
      // (see db/001's own comment on why a missing row means something
      // went wrong rather than that this person is new). Refusing here,
      // rather than inventing a ledger out of nothing, keeps that
      // invariant honest instead of quietly working around a broken one.
      throw new Error(
        `record-store: createEntry called for user ${userId}, who has no app_user_profile row.`
      );
    }

    const prfId = nextPrfId(profileRow.record_prf_ids_issued);

    await client.query(
      'UPDATE app_user_profile SET record_prf_ids_issued = array_append(record_prf_ids_issued, $2) WHERE user_id = $1',
      [userId, prfId]
    );

    const { rows: entryRows } = await client.query<RecordEntryRow>(
      `INSERT INTO record_entry
         (user_id, prf_id, kind, employer_or_institution, official_title,
          start_year, start_month, end_year, end_month, location, description, classification,
          import_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        userId,
        prfId,
        input.kind,
        input.employerOrInstitution,
        input.officialTitle,
        input.start?.year ?? null,
        input.start?.month ?? null,
        input.end?.year ?? null,
        input.end?.month ?? null,
        input.location,
        input.description,
        input.classification,
        importSource
      ]
    );

    const artifacts: StoredArtifact[] = [];
    for (const artifact of input.artifacts) {
      artifacts.push(await insertArtifact(client, userId, prfId, artifact));
    }

    await client.query('COMMIT');

    // The first-entry funnel milestone, best-effort and after the commit so it
    // is never part of the transaction and can never fail the create. The
    // milestone table keeps only the first, so recording on every entry is fine.
    await recordEvent(userId, 'first_entry');

    return rowToStoredEntry(entryRows[0], artifacts);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Updates an entry's core fields. Artifacts are untouched here; the
 * returned entry carries whatever artifacts already existed for it,
 * re-read after the update so the caller always gets the full, current
 * shape back in one call.
 *
 * Returns null when this person holds no entry with that id, which the
 * caller reads as "nothing to update" rather than an error: the WHERE
 * clause already scopes on user_id, so this also correctly returns null
 * for an id that exists but belongs to someone else, without ever telling
 * the caller which of the two happened.
 */
export async function updateEntry(userId: string, prfId: string, input: EntryCoreInput): Promise<StoredEntry | null> {
  const { rows } = await db().query<RecordEntryRow>(
    `UPDATE record_entry SET
       kind = $3,
       employer_or_institution = $4,
       official_title = $5,
       start_year = $6,
       start_month = $7,
       end_year = $8,
       end_month = $9,
       location = $10,
       description = $11,
       classification = $12
     WHERE user_id = $1 AND prf_id = $2
     RETURNING *`,
    [
      userId,
      prfId,
      input.kind,
      input.employerOrInstitution,
      input.officialTitle,
      input.start?.year ?? null,
      input.start?.month ?? null,
      input.end?.year ?? null,
      input.end?.month ?? null,
      input.location,
      input.description,
      input.classification
    ]
  );

  const row = rows[0];
  if (!row) return null;

  const { rows: artifactRows } = await db().query<RecordArtifactRow>(
    'SELECT * FROM record_artifact WHERE entry_user_id = $1 AND entry_prf_id = $2 ORDER BY id ASC',
    [userId, prfId]
  );

  return rowToStoredEntry(row, artifactRows.map(rowToStoredArtifact));
}

/**
 * Deletes one entry. A real DELETE, not a soft delete: see this file's own
 * header for why that is deliberate and how nextPrfId()'s no-reuse promise
 * survives it anyway. record_artifact's foreign key to record_entry
 * cascades (db/004), so every artifact on this entry goes with it; no
 * second statement runs for them, the same pattern account.ts's
 * PERSON_TABLES already documents for app_user_profile.
 *
 * Returns whether a row was actually removed, so a caller can tell "gone"
 * apart from "was never there" without a second query.
 */
export async function deleteEntry(userId: string, prfId: string): Promise<boolean> {
  const result = await db().query('DELETE FROM record_entry WHERE user_id = $1 AND prf_id = $2', [userId, prfId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Deletes every entry one document brought in, and returns how many went
 * (db/209). This is what a document's "Remove" actually costs: removing the
 * resume or the cover letter takes back the record rows that document put in,
 * which is the owner's rule of 2026-09-25 — whatever records we took in,
 * delete them.
 *
 * WHAT IT CANNOT REACH, BY DESIGN. `import_source IS NULL` is every entry
 * typed into the hand-entry form, and every entry that predates db/209. The
 * equality below never matches NULL, so no remove can take a row the person
 * wrote themselves, and no remove can take a row from the other document.
 * That is the whole reason the column exists rather than "delete the imported
 * ones".
 *
 * record_artifact cascades on the composite key (db/104), so the links hanging
 * off these entries go with them in the same statement.
 *
 * PRF IDS ARE NOT RETURNED TO THE POOL, exactly as deleteEntry above leaves
 * them: the id ledger on app_user_profile is untouched, so the next entry gets
 * the next number and a number never names two different facts.
 */
export async function deleteEntriesFrom(userId: string, source: ImportSource): Promise<number> {
  const result = await db().query('DELETE FROM record_entry WHERE user_id = $1 AND import_source = $2', [
    userId,
    source
  ]);
  return result.rowCount ?? 0;
}

/** How many entries one document has in the record right now. What the band's
    Remove line names before it is pressed, so a control that deletes confirmed
    record rows says its cost out loud. */
export async function countEntriesFrom(userId: string, source: ImportSource): Promise<number> {
  const { rows } = await db().query<{ n: string }>(
    'SELECT count(*) AS n FROM record_entry WHERE user_id = $1 AND import_source = $2',
    [userId, source]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Adds one artifact to an entry this person owns. Returns null, rather
 * than inserting anything, when the entry does not exist or belongs to
 * someone else: a foreign key would also refuse the insert, but checking
 * first inside the same transaction is what lets this function answer
 * "not yours" instead of surfacing a constraint-violation error to a
 * caller that has no way to interpret one.
 */
export async function addArtifact(
  userId: string,
  prfId: string,
  artifact: ProfileArtifact
): Promise<StoredArtifact | null> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');

    const { rows: entryRows } = await client.query(
      'SELECT 1 FROM record_entry WHERE user_id = $1 AND prf_id = $2',
      [userId, prfId]
    );
    if (entryRows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const stored = await insertArtifact(client, userId, prfId, artifact);
    await client.query('COMMIT');
    return stored;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes one artifact. Scoped on entry_user_id rather than requiring the
 * caller to also pass the entry's prf_id: record_artifact's own id is
 * already unique across the whole table (it is a bigint IDENTITY, not
 * scoped per entry the way prf_id is scoped per person), so entry_user_id
 * alone is enough to keep this from ever touching another person's row,
 * and asking for a prf_id the caller would only be using to double-check
 * a fact the id column already settles is a parameter with no job.
 *
 * Returns whether a row was actually removed, for the same reason
 * deleteEntry() does.
 */
export async function removeArtifact(userId: string, artifactId: number): Promise<boolean> {
  const result = await db().query('DELETE FROM record_artifact WHERE id = $1 AND entry_user_id = $2', [
    artifactId,
    userId
  ]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   Profile links (db/014_profile_link.sql): the person's own job-related
   socials and sites, identity rather than per-entry evidence. src/lib/
   profile-links.ts is the pure half (the platform vocabulary, URL
   validation); this file does the I/O, scoping every query to one userId the
   same way every function above does. The url passed in has already cleared
   profile-links.ts's normaliseLinkUrl() at the endpoint; this file trusts the
   caller for shape the same division record.ts's own header describes.
   ------------------------------------------------------------------------- */

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

interface ProfileLinkRow {
  id: string;
  platform: LinkPlatform;
  url: string;
  created_at: Date | string;
}

/** Pure: a row in, the shape the rest of the app reads out. */
export function rowToStoredLink(row: ProfileLinkRow): StoredLink {
  return {
    id: row.id,
    platform: row.platform,
    url: row.url,
    createdAt: toDate(row.created_at)
  };
}

/** Every link this person has, oldest first, so the list reads in the order
    they built it rather than reshuffling each time a row is added. */
export async function listLinks(userId: string): Promise<StoredLink[]> {
  const { rows } = await db().query<ProfileLinkRow>(
    'SELECT id, platform, url, created_at FROM profile_link WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [userId]
  );
  return rows.map(rowToStoredLink);
}

/** Adds one link and returns it. The id is minted here (crypto.randomUUID())
    rather than read back from an identity column, the same choice generated_
    render's store made, so the row's key is known without a second query. */
export async function addLink(userId: string, platform: LinkPlatform, url: string): Promise<StoredLink> {
  const { rows } = await db().query<ProfileLinkRow>(
    `INSERT INTO profile_link (id, user_id, platform, url)
     VALUES ($1, $2, $3, $4)
     RETURNING id, platform, url, created_at`,
    [randomUUID(), userId, platform, url]
  );
  return rowToStoredLink(rows[0]);
}

/** Removes one link, scoped on user_id as well as its own id so an id copied
    from another person's page matches nothing. Returns whether a row was
    actually removed, the same "gone versus never there" distinction
    removeArtifact() and deleteEntry() answer. */
export async function removeLink(userId: string, linkId: string): Promise<boolean> {
  const result = await db().query('DELETE FROM profile_link WHERE id = $1 AND user_id = $2', [linkId, userId]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   The resume email (db/016_resume_email.sql): a contact email for the top of a
   drafted resume, kept apart from the login email. Two stored facts, the
   custom address and a switch for which one the resume prints, and neither is
   ever deleted by the other (see db/016's own header).
   ------------------------------------------------------------------------- */

export interface ResumeEmailSettings {
  /** When true, the resume prints the login email; when false, the custom one. */
  readonly useLogin: boolean;
  /** The custom address the person last typed, kept whether or not it is the
      one in use right now. Null when they have never set one. */
  readonly custom: string | null;
}

interface ResumeEmailRow {
  resume_email: string | null;
  resume_email_use_login: boolean;
}

export async function getResumeEmailSettings(userId: string): Promise<ResumeEmailSettings> {
  const { rows } = await db().query<ResumeEmailRow>(
    'SELECT resume_email, resume_email_use_login FROM app_user_profile WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  // No row is the "something went wrong, degrade rather than throw" case the
  // other readers here hold; default to the column default, use the login email.
  return { useLogin: row ? row.resume_email_use_login : true, custom: row ? row.resume_email : null };
}

/**
 * Writes the switch, and the custom address only when one is passed. A bare
 * toggle (custom omitted) flips resume_email_use_login and leaves the stored
 * custom address untouched, which is db/016's rule: toggling never deletes the
 * custom value, only a real edit changes it. Passing custom (a string or null)
 * is that edit.
 */
export async function setResumeEmailSettings(
  userId: string,
  settings: { useLogin: boolean; custom?: string | null }
): Promise<void> {
  if (settings.custom === undefined) {
    await db().query('UPDATE app_user_profile SET resume_email_use_login = $2 WHERE user_id = $1', [
      userId,
      settings.useLogin
    ]);
    return;
  }
  await db().query('UPDATE app_user_profile SET resume_email_use_login = $2, resume_email = $3 WHERE user_id = $1', [
    userId,
    settings.useLogin,
    settings.custom
  ]);
}

/** The login email, read from Better Auth's own "user" table (this app does not
    store it on app_user_profile; db/016's header says why). Null when the row
    is missing, the same degrade the other readers hold. */
export async function loginEmail(userId: string): Promise<string | null> {
  const { rows } = await db().query<{ email: string | null }>('SELECT email FROM "user" WHERE id = $1', [userId]);
  return rows[0]?.email ?? null;
}

/** The address a drafted resume should print: the login email when the switch
    says so, otherwise the custom one (which may itself be null). One call for
    the render side, so buildRenderHeader() does not have to know the rule. */
export async function resolveResumeEmail(userId: string): Promise<string | null> {
  const settings = await getResumeEmailSettings(userId);
  if (settings.useLogin) return loginEmail(userId);
  return settings.custom;
}

/* -------------------------------------------------------------------------
   The cover letter on file (db/025_cover_letter.sql): the person's own letter,
   fed to a cover render as a writing-voice sample only, never as a source of
   facts (that path is the import-propose-confirm flow into the record). Three
   stored facts: the text, the source file's name, and when it was added.
   ------------------------------------------------------------------------- */

export interface CoverLetterOnFile {
  /** The letter as plain text (a PDF or DOCX is extracted before it is stored). */
  readonly text: string;
  /** The uploaded file's name, or null for a paste. */
  readonly sourceName: string | null;
  /** When it was stored, ISO 8601, or null if never set. */
  readonly addedAt: string | null;
}

interface CoverLetterRow {
  cover_letter_text: string | null;
  cover_letter_source_name: string | null;
  cover_letter_added_at: Date | string | null;
}

/** The letter on file, or null when none is stored (or the row is missing, the
    same degrade the other readers here hold). */
export async function getCoverLetter(userId: string): Promise<CoverLetterOnFile | null> {
  const { rows } = await db().query<CoverLetterRow>(
    'SELECT cover_letter_text, cover_letter_source_name, cover_letter_added_at FROM app_user_profile WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  if (!row || row.cover_letter_text === null || row.cover_letter_text.trim().length === 0) return null;
  const addedAt = row.cover_letter_added_at;
  return {
    text: row.cover_letter_text,
    sourceName: row.cover_letter_source_name,
    addedAt: addedAt instanceof Date ? addedAt.toISOString() : addedAt
  };
}

/** Stores (or replaces) the letter on file, stamping the time. The text is the
    already-extracted plain text; the caller does the extraction and the voice
    acceptance (voice.ts) before this write. Returns whether a row was updated,
    the same "gone versus never there" shape the other writers here return. */
export async function setCoverLetter(userId: string, text: string, sourceName: string | null): Promise<boolean> {
  const result = await db().query(
    'UPDATE app_user_profile SET cover_letter_text = $2, cover_letter_source_name = $3, cover_letter_added_at = now() WHERE user_id = $1',
    [userId, text, sourceName]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Removes the letter on file, clearing all three columns. The entries the
    letter proposed into the record are a separate statement; the endpoint runs
    deleteEntriesFrom(userId, 'cover_letter') beside this one. */
export async function clearCoverLetter(userId: string): Promise<boolean> {
  const result = await db().query(
    'UPDATE app_user_profile SET cover_letter_text = NULL, cover_letter_source_name = NULL, cover_letter_added_at = NULL WHERE user_id = $1',
    [userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   The resume's receipt (db/209). Deliberately NOT the shape of the cover
   letter above it: there is no resume_text column and there is not going to be
   one. The band's third promise reads "Read once, in memory, then gone.
   Nothing stored, nothing sent to us", and that stays literally true — what is
   kept here is the file's NAME and the moment it was read, so the person has
   something to point a Remove at. The resume itself lives in memory for the
   one parse call and is gone after (src/lib/resume-extract.ts's rule).
   ------------------------------------------------------------------------- */

export interface ResumeOnFile {
  /** The uploaded file's name, or null when the resume was pasted as text. */
  readonly sourceName: string | null;
  /** When it was read, ISO 8601. */
  readonly addedAt: string | null;
}

interface ResumeReceiptRow {
  resume_source_name: string | null;
  resume_added_at: Date | string | null;
}

/** The last resume read, or null when none has been. A paste leaves a receipt
    too (sourceName null, addedAt set), because a pasted resume lands the same
    entries a file does and must be as removable. */
export async function getResumeOnFile(userId: string): Promise<ResumeOnFile | null> {
  const { rows } = await db().query<ResumeReceiptRow>(
    'SELECT resume_source_name, resume_added_at FROM app_user_profile WHERE user_id = $1',
    [userId]
  );
  const row = rows[0];
  if (!row || row.resume_added_at === null) return null;
  const addedAt = row.resume_added_at;
  return {
    sourceName: row.resume_source_name,
    addedAt: addedAt instanceof Date ? addedAt.toISOString() : addedAt
  };
}

/** Stamps a resume read, replacing any earlier one: there is one resume on
    file at a time, the same "replaced each upload" rule db/115 holds for the
    parse buffer. */
export async function setResumeOnFile(userId: string, sourceName: string | null): Promise<boolean> {
  const result = await db().query(
    'UPDATE app_user_profile SET resume_source_name = $2, resume_added_at = now() WHERE user_id = $1',
    [userId, sourceName]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Clears the receipt. As with the letter, the entries are a separate
    statement the endpoint runs beside this one. */
export async function clearResumeOnFile(userId: string): Promise<boolean> {
  const result = await db().query(
    'UPDATE app_user_profile SET resume_source_name = NULL, resume_added_at = NULL WHERE user_id = $1',
    [userId]
  );
  return (result.rowCount ?? 0) > 0;
}
