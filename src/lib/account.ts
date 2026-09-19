/**
 * account.ts: the knowledge RUN-MASTER F1 (delete account, export bundle)
 * runs on. Pure, on purpose, in the same spirit as entitlement.ts: no
 * database, no request, no import of src/lib/db.ts or src/lib/auth.ts. That
 * is what lets PERSON_TABLES and exportShape() be tested with no connection
 * string, which matters here specifically because a connection string is the
 * one thing this repository will not let a worker open.
 *
 * The impure half, the actual queries and the call into Better Auth, lives in
 * the two route handlers this file backs: src/pages/settings/export.ts and
 * src/pages/settings/delete.ts. They read PERSON_TABLES to know what to
 * touch; they decide nothing about what a table means. That split is the same
 * one entitlement.ts and viewer.ts already draw, restated for the same reason.
 *
 * WHERE EVERY CLAIM BELOW WAS VERIFIED, SO THE NEXT READER DOES NOT HAVE TO
 * RETAKE IT ON FAITH.
 *
 *   Better Auth's table names and fields: node_modules/@better-auth/core/dist/
 *   db/get-tables.mjs, buildAuthTables(). Read directly, not summarized from
 *   docs. account.test.ts calls this same function at test time (via the
 *   '@better-auth/core/db' subpath, which re-exports it) with the rateLimit
 *   option this app actually sets, so a library upgrade that adds or renames a
 *   table fails that test rather than silently leaving rows behind on delete.
 *
 *   internalAdapter.deleteUser(userId): node_modules/better-auth/dist/db/
 *   internal-adapter.mjs. It runs deleteManyWithHooks on "session", then on
 *   "account", then deleteWithHooks on "user". No transaction wraps those
 *   three calls (no BEGIN anywhere in the function), and it never touches
 *   "verification" at all. Both facts matter to how the delete route is built;
 *   neither is asserted here without having read the function body.
 *
 *   verification rows this app can actually produce: node_modules/better-auth/
 *   dist/api/routes/password.mjs, requestPasswordReset(). It writes
 *   `identifier: "reset-password:" + token, value: user.user.id`. That is the
 *   ONLY verification row this app's configuration ever creates: email
 *   verification uses a signed JWT (node_modules/better-auth/dist/api/routes/
 *   email-verification.mjs, createEmailVerificationToken(), which calls
 *   signJWT and writes no database row at all), and no OAuth or magic-link
 *   flow is configured (src/lib/auth.ts declares no socialProviders and no
 *   such plugin). auth.ts sets `verification: { storeIdentifier: 'hashed' }`,
 *   which hashes the IDENTIFIER column, not the VALUE column (confirmed by
 *   reading the same file's own comment, which cites verification-token-
 *   storage.mjs), so a stray password-reset row can still be found and
 *   removed by `value = <userId>` even though its identifier cannot be
 *   reconstructed without the original token.
 *
 *   app_user_profile's cascade: db/001_app_user_profile.sql, the `user_id`
 *   column: `text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE`. This
 *   is Postgres enforcing the cleanup, not application code, so it needs no
 *   statement of its own and no verification query would ever be able to
 *   catch it lagging.
 *
 * WHAT THIS FILE DOES NOT AND CANNOT VERIFY: whether internalAdapter.deleteUser
 * actually leaves zero rows against a REAL database, whether the survivor
 * count query's column quoting matches what Better Auth's migration actually
 * created, and whether a delete really round-trips through export cleanly.
 * Those need a live connection, which this file, by construction, never opens.
 * See the two route handlers' own comments for how they turn "could not
 * verify" into a loud failure instead of a quiet guess.
 */

// Type-only: erased by the compiler, never a runtime import. record-store.ts
// itself imports src/lib/db.ts, which is exactly what this file's own
// comment above says it never does; `import type` is what lets this file
// borrow record-store.ts's return shape for the Profile Record without
// borrowing its I/O. listEntries() is actually called in src/pages/settings/
// export.ts, the impure half, same as every other query this file names but
// never runs.
import type { StoredEntry } from './record-store';
// Same type-only borrowing as StoredEntry above, and for the same reason:
// desk-store.ts is the impure half of the Desk (it imports src/lib/db.ts),
// and `import type` is erased at compile time, so this file still opens no
// database connection of its own. listSavedJobs()/listApplications() are
// actually called in src/pages/settings/export.ts, which imports them as
// values (the impure half is allowed to; see ExportField below for how this
// file tells it which ones it must call).
import type { StoredApplication, StoredSavedJob } from './desk-store';
import type { StoredPostingFetch } from './posting-fetch-store';
// Same type-only borrowing as StoredApplication/StoredSavedJob above, and
// for the same reason: watchlist-store.ts is the impure half of the
// Watchlist (it imports src/lib/db.ts). listFollows() is actually called
// in src/pages/settings/export.ts, the impure half, same as every other
// reader this file names but never runs.
import type { StoredFollow } from './watchlist-store';
// Same type-only borrowing as StoredFollow above, and for the same reason:
// filters-store.ts is the impure half of the stateful filter (it imports
// src/lib/db.ts). getFilterState() is actually called wherever the
// account-backed half of MASTER-SPEC F10 needs a person's last saved
// selection, the same role listFollows() plays for the Watchlist.
import type { StoredFilterState } from './filters-store';
// Same type-only borrowing again: StoredLink's own shape is defined in the
// pure src/lib/profile-links.ts, and its reader listLinks() lives in the
// impure record-store.ts and is called from src/pages/settings/export.ts, the
// same role listFollows() and getFilterState() play for their tables.
import type { StoredLink } from './profile-links';

/* -------------------------------------------------------------------------
   PERSON_TABLES: the inventory.
   ------------------------------------------------------------------------- */

/**
 * How a person's rows in this table are actually removed when the account is
 * deleted.
 *
 *   'better-auth-delete-user': internalAdapter.deleteUser(userId) reaches this
 *     table itself. Nothing in this codebase has to.
 *   'cascade': Postgres removes it, via a foreign key, the moment the row it
 *     references is gone. Nothing in this codebase has to run a statement, but
 *     it also cannot be verified by a query run BEFORE the referenced row is
 *     gone, which is why the delete route checks this one last.
 *   'explicit-statement': nothing above reaches it. The delete route must run
 *     its own statement, and it is the one row class where forgetting the
 *     statement is exactly the failure MASTER-SPEC 6's acceptance line is
 *     naming ("delete leaves zero person rows").
 *   'not-user-linked': the table holds no column that identifies which rows
 *     belong to this person, so there is no statement that could target
 *     "this user's rows" even in principle. See rateLimit's note below for
 *     why that is an honest answer and not a gap.
 */
export type DeleteReach = 'better-auth-delete-user' | 'cascade' | 'explicit-statement' | 'not-user-linked';

/**
 * The ExportInput field a store module's reader function fills, for a table
 * whose export data comes from calling one of those functions rather than
 * export.ts running its own raw query. Three tables, two functions:
 * record_entry and record_artifact both resolve to 'records' because
 * record-store.ts's listEntries() already nests one inside the other (see
 * that field's own comment on ExportInput below), the same sharing
 * exportBundleKey does for the same pair.
 *
 * THIS IS THE OTHER HALF OF THE FIX THIS TASK EXISTS FOR. exportBundleKey
 * says where a table's rows land in the bundle; exportField says which
 * function call actually has to run to put them there, and
 * requiredExportReaderFields() below turns that into a set export.ts's own
 * reader map is checked against by TypeScript itself: ReaderMap in that file
 * is typed `{ [K in ExportField]: ... }`, so adding a member here that no
 * reader map supplies a function for is a compile error in export.ts, not a
 * silent gap a route can half-wire the way desk_saved_job and
 * desk_application were before this task.
 *
 * 'watchlist' resolves to watchlist-store.ts's listFollows(): one table,
 * one reader, the same shape 'savedJobs' already has for desk_saved_job.
 *
 * 'filters' resolves to filters-store.ts's getFilterState(): one table,
 * one reader, the same shape 'watchlist' already has for the watchlist
 * table. Unlike every reader above it, this one can answer null (a person
 * who has never saved a selection), which is why it is the one ExportField
 * whose ExportInput slot (see below) is typed to allow it explicitly rather
 * than defaulting an absent field to an empty array.
 */
export type ExportField = 'records' | 'links' | 'savedJobs' | 'applications' | 'postingFetches' | 'watchlist' | 'filters';

export interface PersonTable {
  /** The table name as it must appear in a raw SQL statement: quoted where
      Postgres requires it (a reserved word, or a name Better Auth's Kysely-
      based schema created with mixed case) and bare otherwise. */
  sql: string;
  /** The plain name, for logging and for the export bundle's own commentary. */
  table: string;
  owner: 'better-auth' | 'app';
  /** What the table holds, in the columns that actually matter here. */
  holds: string;
  deleteReach: DeleteReach;
  /** Why deleteReach is what it is, with the file that was read to confirm it. */
  deleteNote: string;
  /** The column a "does this user have rows left" query filters on, already
      quoted the same way `sql` is. null for a table with no such column
      (see 'not-user-linked'): there is nothing honest to filter on. */
  verifyColumn: string | null;
  includedInExport: boolean;
  /** Which top-level AccountExportBundle key this table's rows land in, when
      includedInExport is true. Two tables can share one key: record_entry
      and record_artifact both land under 'record', because a person's
      Profile Record is nested data (entries, each carrying its own
      artifacts), not a second flat array sitting next to sessions and
      accounts. null for a table that is not included in the export, for
      whatever reason exportNote gives: there is no bundle key to check
      attendance for.

      requiredExportBundleKeys() below reads this field, not exportShape()
      itself. That is what makes "PERSON_TABLES says record_entry is
      includedInExport" and "exportShape() actually reads it" the same
      claim instead of two claims a future change could let drift apart,
      which is exactly the drift this task was written to close. */
  exportBundleKey: string | null;
  /** Which ExportInput field a store module's reader function must fill for
      this table's data to actually reach the bundle, when includedInExport
      is true. null for a table export.ts reads with its own raw query
      instead of a shared reader function (user, session, account, profile:
      no store module wraps those, so there is nothing to register here),
      and for a table that is not exported at all. See ExportField's own
      comment above for the whole mechanism this drives. */
  exportField: ExportField | null;
  /** What is exported and what is withheld, and why, in plain language. */
  exportNote: string;
}

export const PERSON_TABLES: readonly PersonTable[] = [
  {
    sql: '"user"',
    table: 'user',
    owner: 'better-auth',
    holds: 'Identity: id, name, email, emailVerified, image, createdAt, updatedAt.',
    deleteReach: 'better-auth-delete-user',
    deleteNote:
      'internalAdapter.deleteUser(userId) deletes this row last, after session and account ' +
      '(node_modules/better-auth/dist/db/internal-adapter.mjs, deleteUser).',
    verifyColumn: 'id',
    includedInExport: true,
    exportBundleKey: 'user',
    exportField: null,
    exportNote: 'Every field here is a record of the person, not a live secret. All of it is exported.'
  },
  {
    sql: 'session',
    table: 'session',
    owner: 'better-auth',
    holds: 'Sign-in history and live sessions: id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId.',
    deleteReach: 'better-auth-delete-user',
    deleteNote:
      'internalAdapter.deleteUser(userId) deletes every session row for this user first, via ' +
      'deleteManyWithHooks on "session" filtered by userId.',
    verifyColumn: '"userId"',
    includedInExport: true,
    exportBundleKey: 'sessions',
    exportField: null,
    exportNote:
      'createdAt, expiresAt, ipAddress and userAgent are exported as the sign-in history they are: ' +
      'observed data about the person. token is a live bearer token, not a record, and is never read ' +
      'into the bundle.'
  },
  {
    sql: 'account',
    table: 'account',
    owner: 'better-auth',
    holds:
      'The credential row: id, issuer, accountId, providerId, userId, accessToken, refreshToken, ' +
      'idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt.',
    deleteReach: 'better-auth-delete-user',
    deleteNote:
      'internalAdapter.deleteUser(userId) deletes every account row for this user before deleting ' +
      'the user row itself, via deleteManyWithHooks on "account" filtered by userId.',
    verifyColumn: '"userId"',
    includedInExport: true,
    exportBundleKey: 'accounts',
    exportField: null,
    exportNote:
      'issuer, providerId, accountId, scope, createdAt and updatedAt are exported. password is a live ' +
      'credential hash, not a record of the person, and is never read into the bundle. accessToken, ' +
      'refreshToken, idToken, accessTokenExpiresAt and refreshTokenExpiresAt are live third-party ' +
      'credentials this app does not currently issue (no social provider is configured in ' +
      'src/lib/auth.ts) and are withheld for the same reason password is: Better Auth itself marks all ' +
      'six of these fields `returned: false` in its own table schema, which is corroborating, not the ' +
      'reason; the reason is that a live credential is not a record of what a person did.'
  },
  {
    sql: 'verification',
    table: 'verification',
    owner: 'better-auth',
    holds: 'Short-lived tokens: id, identifier, value, expiresAt, createdAt, updatedAt.',
    deleteReach: 'explicit-statement',
    deleteNote:
      'internalAdapter.deleteUser(userId) does not touch this table; read in full, it deletes only ' +
      'session, then account, then user. The only row this app ever writes here is a password-reset ' +
      'request (node_modules/better-auth/dist/api/routes/password.mjs, requestPasswordReset: ' +
      'identifier: "reset-password:" + token, value: user.user.id). identifier is hashed at rest ' +
      '(src/lib/auth.ts, verification.storeIdentifier: "hashed") and so cannot be located without the ' +
      'original token, but value is stored as the plain user id, so the delete route removes it with ' +
      'DELETE FROM verification WHERE value = $1, run before internalAdapter.deleteUser so a failure ' +
      'here aborts before Better Auth touches anything.',
    verifyColumn: 'value',
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote:
      'Never read for export. A live, unexpired password-reset token is a usable credential, not a ' +
      'history of anything, and a short-lived row that outlives the export file it was pasted into ' +
      'defeats the point of a token that expires.'
  },
  {
    sql: 'app_user_profile',
    table: 'app_user_profile',
    owner: 'app',
    holds: 'Entitlement, the two-part name, and the resume email settings: user_id, tier, signup_source, created_at, updated_at, first_name, last_name, resume_email, resume_email_use_login.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/001_app_user_profile.sql). Deleting the ' +
      'user row deletes this one at the database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'profile',
    exportField: null,
    exportNote:
      'tier, signup_source, first_name, last_name, resume_email and resume_email_use_login are exported. record_prf_ids_issued ' +
      '(db/005_record_prf_ledger.sql) is deliberately withheld even though this row is ' +
      'includedInExport: true for those other columns: it is an append-only internal ledger that ' +
      'stops a deleted Profile Record entry\'s PRF number being reused (see record-store.ts\'s own ' +
      'header), not a fact this person told the site, and it names entries by an id alone, including ' +
      'ids whose entry has since been deleted, so a bare list of retired numbers pasted into a ' +
      'downloaded file would mean nothing to a person reading it and could lead a naive re-import to ' +
      'reconstruct a ledger with holes it never actually had. See exportShape()\'s own ' +
      '_meta.excluded_and_why for the same reasoning, kept honest in the bundle itself. None of the ' +
      'other columns here are secrets.'
  },
  {
    sql: 'rateLimit',
    table: 'rateLimit',
    owner: 'better-auth',
    holds:
      'Rate-limit counters: key, count, lastRequest. Present only because src/lib/auth.ts sets ' +
      'rateLimit.storage: "database" (node_modules/@better-auth/core/dist/db/get-tables.mjs adds this ' +
      'table exactly when that option is set).',
    deleteReach: 'not-user-linked',
    deleteNote:
      'This table carries no userId column and no foreign key to user(id): its key is ' +
      'ip + ":" + path (node_modules/@better-auth/core/dist/utils/ip.mjs, createRateLimitKey, called ' +
      'from node_modules/better-auth/dist/api/rate-limiter/index.mjs). A shared IP can produce a row no ' +
      'single account owns, so there is no statement that could correctly target "this person\'s rows" ' +
      'even in principle, and every row here expires on its own within its rate-limit window regardless ' +
      'of whether any account tied to it still exists. Listed here, rather than left off the inventory, ' +
      'precisely so this reasoning is on record instead of the table being silently forgotten.',
    verifyColumn: null,
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote: 'Never read for export: it is operational state about requests, not a record of the person.'
  },
  {
    // The Profile Record itself (MASTER-SPEC 3.2, db/004_profile_record.sql).
    // src/lib/record-store.ts is the only code that queries this table.
    sql: 'record_entry',
    table: 'record_entry',
    owner: 'app',
    holds:
      'Every fact in the Profile Record: kind, employer_or_institution, official_title, the start and end ' +
      'year/month pair, location, description, classification and provenance, one row per entry.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/004_profile_record.sql). Deleting the user row ' +
      'removes every entry at the database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'record',
    exportField: 'records',
    exportNote:
      'Every field is exported: this is the most person-owned data this database holds, not a live ' +
      'secret. Landed under the bundle\'s record.entries array, nested with the artifacts each entry ' +
      'carries, because that is the shape a Profile Record actually has, not a second flat table dump ' +
      'sitting next to sessions and accounts. src/pages/settings/export.ts assembles it by calling ' +
      'record-store.ts\'s own listEntries(), the same read the record UI itself uses, rather than ' +
      'querying this table a second time by hand.'
  },
  {
    // The links backing entries up (MASTER-SPEC 3.2, db/004_profile_record.sql).
    sql: 'record_artifact',
    table: 'record_artifact',
    owner: 'app',
    holds: 'The evidence attached to one entry: kind, url, label, and which entry it belongs to.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to record_entry (user_id, prf_id) (db/004_profile_record.sql), ' +
      'which itself cascades from user(id): deleting the user row removes every entry, which removes every ' +
      'artifact through this constraint, one hop at a time. No application statement runs it.',
    verifyColumn: 'entry_user_id',
    includedInExport: true,
    exportBundleKey: 'record',
    exportField: 'records',
    exportNote:
      'kind, url and label, the fields this table\'s own holds note names, are exported nested under ' +
      'the entry they back up, in record.entries[].artifacts. Not id: that is a database surrogate ' +
      'key (a bigint IDENTITY column, see db/004_profile_record.sql) with no meaning to a person ' +
      'reading their own export, not a fact about them, so it is left out the same deliberate way a ' +
      'live credential is.'
  },
  {
    // The person's own job-related links (MASTER-SPEC 3.1, db/014_profile_link.sql).
    // Identity, not per-entry evidence: unlike record_artifact above, a link
    // belongs to the person, not to one role. src/lib/record-store.ts is the
    // only code that queries this table.
    sql: 'profile_link',
    table: 'profile_link',
    owner: 'app',
    holds: 'One row per job-related link a person lists on their profile: platform, url, created_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/014_profile_link.sql), the same shape ' +
      'record_entry uses (db/004_profile_record.sql). Deleting the user row removes every link at the ' +
      'database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'links',
    exportField: 'links',
    exportNote:
      'platform, url and created_at are exported under the bundle\'s links array. These are the person\'s ' +
      'own public URLs, some of the most person-owned data this database holds, exported in full. Not id: ' +
      'that is a store-minted surrogate key (a randomUUID, see db/014_profile_link.sql) with no meaning to ' +
      'a person reading their own export, left out the same deliberate way record_artifact\'s own id is ' +
      'above. src/pages/settings/export.ts assembles it by calling record-store.ts\'s listLinks(), the ' +
      'same read the profile page itself uses.'
  },
  {
    // The Desk's bookmark table (MASTER-SPEC 3.5, F4, db/006_desk.sql).
    sql: 'desk_saved_job',
    table: 'desk_saved_job',
    owner: 'app',
    holds: 'One bookmark per verified posting a person has saved: job_id, saved_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/006_desk.sql), the same shape record_entry ' +
      'uses (db/004_profile_record.sql). Deleting the user row removes every saved job at the database ' +
      'level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'desk',
    exportField: 'savedJobs',
    exportNote:
      'job_id and saved_at are exported, nested under the bundle\'s desk.savedJobs array. job_id names ' +
      'a posting in src/data/jobs.json, a published file this database never reads; a person\'s own ' +
      'export names which posting they saved by that id and does not re-fetch or re-verify it.'
  },
  {
    // The Desk's tracker (MASTER-SPEC 3.5, F4, db/006_desk.sql). STM-0002's
    // states and the click-is-not-applied guard live in src/lib/desk.ts;
    // this table only stores what that file decided, and src/lib/
    // desk-store.ts is the only code that queries it.
    sql: 'desk_application',
    table: 'desk_application',
    owner: 'app',
    holds:
      'One row per application: job_id or external_url, the JD snapshot taken at click, STM-0002 state, ' +
      'interview_substage, abandon_reason, closed_reason, offered_comp, resume/cover render ids, and ' +
      'clicked_at/confirmed_at/archived_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/006_desk.sql), the same shape record_entry ' +
      'uses. Deleting the user row removes every application at the database level; no application ' +
      'statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'desk',
    exportField: 'applications',
    exportNote:
      'Every field is exported except the database surrogate id, the same deliberate omission ' +
      'record_artifact\'s own exportNote explains above: a bigint IDENTITY column means nothing to a ' +
      'person reading their own file. The JD snapshot (snapshot_title, snapshot_company, ' +
      'snapshot_description) is exported in full: MASTER-SPEC F4.2 takes it at click specifically so it ' +
      'survives a posting dying, which makes it, alongside the record, some of the most person-owned ' +
      'data this database holds. abandon_reason gets its own word here because db/006_desk.sql\'s own ' +
      'comment on that column requires it: MASTER-SPEC F4.1 asks that abandon reasons be "aggregate ' +
      'only above ten per employer, never expose individual behavior", and this export is the one path ' +
      'exempt from that rule on purpose, not by oversight, because it is the person reading their own ' +
      'single row back, never a report grouped by employer. Nothing in this file aggregates ' +
      'abandon_reason across people; the n-of-10 threshold applies to a report that does not exist yet, ' +
      'and this column travels with the row it belongs to the same way every other field here does.'
  },
  {
    // The "Add a posting" request table (db/033_desk_posting_fetch.sql).
    sql: 'desk_posting_fetch',
    table: 'desk_posting_fetch',
    owner: 'app',
    holds:
      'One row per posting a person added by URL: the URL, how the read went (pending, claimed, ready, ' +
      'unreadable, pasted), where the text came from, the title, company and description that came back, ' +
      'and the clocks.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) and to desk_application(id) (db/033). Deleting the ' +
      'user row removes every request at the database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'desk',
    exportField: 'postingFetches',
    exportNote:
      'Every field but the random request id is exported. The id is minted so the Mac mini can be told ' +
      'which row to read without being told who asked; it identifies nothing a person would recognise.'
  },
  {
    // The bring-your-own-key table (MASTER-SPEC decision D7, db/007_user_provider_key.sql).
    sql: 'user_provider_key',
    table: 'user_provider_key',
    owner: 'app',
    holds:
      'One row per person per provider: provider, the AES-256-GCM ciphertext/iv/auth_tag, key_last4, ' +
      'key_fingerprint, created_at, rotated_at, updated_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/007_user_provider_key.sql), the same shape ' +
      'record_entry uses. Deleting the user row removes every stored key at the database level; no ' +
      'application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote:
      'Never read for export, at any provider, for any field: db/007_user_provider_key.sql\'s own header ' +
      'states the D7 rule this table exists to hold to, and this is that rule enforced here too. ' +
      'ciphertext, iv and auth_tag are the parts of a live credential, not a record of what a person ' +
      'did, the same reasoning that already withholds account.password and account\'s third-party ' +
      'tokens from that same export (see the account table\'s own exportNote above). key_last4 and ' +
      'key_fingerprint are display and comparison aids for a live key still on file, not a fact about ' +
      'the person\'s history, and travel with the same withholding for the same reason: none of this ' +
      'table\'s columns describe something a person DID, all of them describe a secret this app still ' +
      'holds on their behalf. See exportShape()\'s own _meta.excluded_and_why for the same reasoning, ' +
      'kept honest in the bundle itself.'
  },
  {
    // The Watchlist's Pre-List follows (MASTER-SPEC 3.6, db/008_watchlist.sql).
    // src/lib/watchlist-store.ts is the only code that queries this table.
    sql: 'watchlist',
    table: 'watchlist',
    owner: 'app',
    holds: 'One follow per prospect a person is tracking pre-posting: prospect_id, followed_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/008_watchlist.sql), the same shape ' +
      'desk_saved_job uses (db/006_desk.sql). Deleting the user row removes every follow at the ' +
      'database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'watchlist',
    exportField: 'watchlist',
    exportNote:
      'prospect_id and followed_at are exported, nested under the bundle\'s watchlist.follows array. ' +
      'prospect_id names a row in src/data/prospects.json, a published file this database never reads; ' +
      'a person\'s own export names which prospect they followed by that id and does not re-fetch or ' +
      're-verify it, the same restraint desk_saved_job\'s own exportNote already states for job_id.'
  },
  {
    // The stateful filter (MASTER-SPEC F10's second bullet, RUN-FINISH
    // phase 7, db/009_account_filter_state.sql). src/lib/filters-store.ts
    // is the only code that queries this table.
    sql: 'account_filter_state',
    table: 'account_filter_state',
    owner: 'app',
    holds:
      'One row per person: the last filter selection they set on the index (location, comp, ' +
      'freshness, as a small JSON object), user_id, created_at, updated_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/009_account_filter_state.sql), the same ' +
      'shape desk_saved_job and watchlist use. Deleting the user row removes this row at the database ' +
      'level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: true,
    exportBundleKey: 'filters',
    exportField: 'filters',
    exportNote:
      'The selection object and updated_at are exported in full, under the bundle\'s own filters key. ' +
      'This is the filter choices the person set for themselves on a public page, not a live credential ' +
      'and not a fact about anyone else, the same register desk_saved_job\'s own exportNote already ' +
      'states for a bookmark.'
  },
  {
    // The drafted resume and cover renders (db/012_drafting.sql). One row per
    // (application, kind), written when a person applies with drafting on and a
    // provider key stored, read by the draft room (src/pages/desk/draft/[id].
    // astro). src/lib/generated-render-store.ts is the only code that queries
    // this table.
    sql: 'generated_render',
    table: 'generated_render',
    owner: 'app',
    holds:
      'One row per application per kind (resume, cover): kind, status, the render payload as JSON, the ' +
      'provider and model that produced it, created_at, updated_at.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign keys to user(id) and to desk_application(id) ' +
      '(db/012_drafting.sql), the same shape desk_saved_job and watchlist use. Deleting the user row, or ' +
      'the application the draft belongs to, removes the render at the database level; no application ' +
      'statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote:
      'Never read for export. A render is the person\'s own Profile Record reframed for one posting, ' +
      'not a new fact about them: the source record IS exported in full (under the record key above), ' +
      'and the posting it was framed against is a published verified job. The render is regenerable from ' +
      'those two at any time, so withholding it keeps the bundle a record of what the person supplied and ' +
      'did, not a cache of what this app computed from it. See exportShape()\'s own _meta.excluded_and_why ' +
      'for the same reasoning, kept honest in the bundle itself.'
  },
  {
    // The in-flight resume parse (db/015_resume_parse.sql). One row per person,
    // replaced each upload, the working buffer between an upload and the
    // confirm that turns proposals into record entries. src/lib/
    // resume-parse-store.ts is the only code that queries this table.
    sql: 'resume_parse',
    table: 'resume_parse',
    owner: 'app',
    holds:
      'One transient row per person: status, the uploaded filename, and the finished parse outcome as ' +
      'JSON (method, provider label, the verified proposals, the notes). Never the resume text itself.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/015_resume_parse.sql), the same shape ' +
      'record_entry uses. Deleting the user row removes the parse buffer at the database level; no ' +
      'application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote:
      'Never read for export. A parse is a working buffer, not a record of what the person did: it holds ' +
      'proposals a person has NOT yet confirmed, replaced the next time they upload and cleared once they ' +
      'act on it. The entries they actually confirm land in record_entry and ARE exported there in full; ' +
      'the links in profile_link; the resume text itself was never stored at all (db/015\'s own header). ' +
      'Exporting an unconfirmed, about-to-be-overwritten buffer would put words in the person\'s file they ' +
      'never agreed to. See exportShape()\'s own _meta.excluded_and_why, kept honest in the bundle itself.'
  },
  {
    // First-party funnel analytics (db/028_analytics_event.sql). One row per
    // (person, milestone): signup, first_entry, first_draft, apply. src/lib/
    // analytics.ts is the only code that writes it, best-effort, behind the
    // `analytics` flag.
    sql: 'analytics_event',
    table: 'analytics_event',
    owner: 'app',
    holds:
      'One milestone row per person per step (signup, first_entry, first_draft, apply): the milestone ' +
      'name and the time it was first reached. No page, no device, nothing the person typed.',
    deleteReach: 'cascade',
    deleteNote:
      'ON DELETE CASCADE on the foreign key to user(id) (db/028_analytics_event.sql), the same shape ' +
      'record_entry and generated_render use. Deleting the user row removes its analytics at the ' +
      'database level; no application statement runs it.',
    verifyColumn: 'user_id',
    includedInExport: false,
    exportBundleKey: null,
    exportField: null,
    exportNote:
      'Never read for export. Each row is a milestone this app measured about the person\'s own actions, ' +
      'and those actions are exported in full under their own records (an entry in record.entries, an ' +
      'application in desk applications). A count of when they crossed a line is measurement derived from ' +
      'facts already in this file, not a new fact they told us, so it is withheld the same way ' +
      'generated_render is. See exportShape()\'s own _meta.excluded_and_why, kept honest in the bundle itself.'
  }
] as const;

/**
 * Bundle keys that exist for structural reasons and answer to no single
 * PERSON_TABLES entry: currently only _meta, which describes the bundle
 * itself (what was withheld and why, what this database cannot reach)
 * rather than holding rows read from any one table.
 */
export const STRUCTURAL_EXPORT_BUNDLE_KEYS = ['_meta'] as const;

/**
 * The complete, correct set of AccountExportBundle's own top-level keys:
 * every table PERSON_TABLES marks includedInExport: true, translated
 * through exportBundleKey, plus the structural keys above. Derived, not
 * hand-kept, for the reason exportBundleKey's own comment gives.
 *
 * account.test.ts diffs a real exportShape() output's keys against this
 * function's return value in both directions: a table flagged
 * includedInExport whose key never actually showed up in a produced bundle
 * fails one way, and a bundle key that showed up with no table accounting
 * for it fails the other way.
 *
 * THIS FUNCTION ALONE IS NOT THE FIX, AND SAYING SO HERE IS THE CORRECTION.
 * A key showing up proves a bundle has a `desk` property; it proves nothing
 * about what is inside it, and desk_saved_job/desk_application shipped with
 * exportBundleKey: 'desk' for a whole task while src/pages/settings/export.ts
 * never queried either table, so every real export's `desk` key held two
 * empty arrays and this check, and the test built on it, went green over
 * that the entire time. requiredExportReaderFields() below is the other
 * half: it says which reader function has to run, export.ts's ReaderMap is
 * typed against it so a missing one is a compile error, and account.test.ts
 * now also asserts the CONTENT of every exportable table's data actually
 * reaches the bundle, not just the key it lands under.
 */
export function requiredExportBundleKeys(): readonly string[] {
  const keys = new Set<string>(STRUCTURAL_EXPORT_BUNDLE_KEYS);
  for (const entry of PERSON_TABLES) {
    if (entry.includedInExport && entry.exportBundleKey) {
      keys.add(entry.exportBundleKey);
    }
  }
  return Array.from(keys).sort();
}

/**
 * The complete, correct set of ExportField values a caller must supply data
 * for: every table PERSON_TABLES marks includedInExport: true whose
 * exportField is non-null. Derived from the same inventory
 * requiredExportBundleKeys() reads, for the same reason: two hand-kept lists
 * of "what export.ts must do" is how a table like desk_application ends up
 * marked includedInExport: true while nothing calls its reader.
 *
 * export.ts's own ReaderMap type is `{ [K in ExportField]: ... }`, which
 * TypeScript itself checks has every member of the ExportField union as a
 * key. This function exists so that guarantee has a name a test can call
 * and assert against directly, rather than trusting the compiler silently:
 * account.test.ts checks this function's return value against
 * Object.keys(the real ReaderMap export.ts uses), so a future ExportField
 * member with no matching reader fails a test even before it would fail a
 * build.
 */
export function requiredExportReaderFields(): readonly ExportField[] {
  const fields = new Set<ExportField>();
  for (const entry of PERSON_TABLES) {
    if (entry.includedInExport && entry.exportField) {
      fields.add(entry.exportField);
    }
  }
  return Array.from(fields).sort();
}

/* -------------------------------------------------------------------------
   exportShape(): the raw rows in, the bundle out. Pure.
   ------------------------------------------------------------------------- */

export interface RawUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface RawSessionRow {
  id: string;
  expiresAt: Date | string;
  /** A live bearer token. Present on the type because a real row carries one;
      exportShape() must never read it. */
  token?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface RawAccountRow {
  id: string;
  issuer: string;
  accountId: string;
  providerId: string;
  userId: string;
  /** Live third-party credentials. Present on the type; never read by exportShape(). */
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: Date | string | null;
  refreshTokenExpiresAt?: Date | string | null;
  scope: string | null;
  /** A live credential hash. Present on the type; never read by exportShape(). */
  password?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface RawProfileRow {
  user_id: string;
  tier: string;
  signup_source: string;
  first_name: string;
  last_name: string;
  resume_email: string | null;
  resume_email_use_login: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * A short-lived-token row. exportShape() never puts one of these in a
 * bundle, under any circumstance; see ExportInput.verifications below for
 * why the type still has to be able to carry one.
 */
export interface RawVerificationRow {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ExportInput {
  user: RawUserRow;
  sessions: readonly RawSessionRow[];
  accounts: readonly RawAccountRow[];
  /** null when the account somehow has no profile row yet; see viewer.ts's
      own comment on why that is a "something went wrong" state and not a
      normal one, and why it must degrade rather than throw here too. */
  profile: RawProfileRow | null;
  /**
   * Verification rows, if a caller collected any. Never read into the bundle:
   * PERSON_TABLES marks verification includedInExport: false, and the real
   * caller (src/pages/settings/export.ts) never queries this table at
   * all, so in production this is always absent. It is part of the type,
   * rather than omitted from it, for exactly one reason: it lets a test
   * construct an input that contains a password hash, a session token, AND
   * a verification row all at once, and assert none of the three reaches
   * the bundle, which is the one case worth pinning against a future
   * refactor that starts spreading a raw row instead of picking fields.
   */
  verifications?: readonly RawVerificationRow[];
  /**
   * Every entry in this person's Profile Record, artifacts already nested:
   * src/lib/record-store.ts's listEntries(userId) return shape, unaltered.
   * exportShape() does no row-to-shape assembly of its own for the record;
   * record-store.ts already did that once (RecordEntryRow/RecordArtifactRow
   * into StoredEntry), and re-deriving the same mapping here would be a
   * second copy of it to keep in sync, the exact failure mode PERSON_TABLES
   * and this function are both written to avoid elsewhere.
   *
   * Always an array, never undefined: a person with no entries yet gets
   * record.entries: [], the same way an account with no sessions gets
   * sessions: [] rather than a missing field. That is also what makes
   * requiredExportBundleKeys()'s 'record' key attendance check meaningful:
   * the key is present because a real query ran, not because the field
   * happened to be non-empty this time.
   */
  records: readonly StoredEntry[];
  /**
   * The person's job-related links (MASTER-SPEC 3.1, db/014_profile_link.sql):
   * src/lib/record-store.ts's listLinks() return shape, unaltered, for the
   * same "do no second row-to-shape mapping here" reason `records` gives.
   *
   * OPTIONAL, like savedJobs/applications/watchlist below, and for the same
   * reason: it keeps account.test.ts's kitchenSinkInput() compiling without
   * constructing link data for tests that are not about links; exportShape()
   * defaults an absent input to an empty array. PERSON_TABLES marks
   * profile_link includedInExport: true with exportField 'links', which is
   * what makes requiredExportReaderFields() require export.ts's ReaderMap to
   * carry listLinks, and what makes an empty default not something a real
   * export should ever actually produce.
   */
  links?: readonly StoredLink[];
  /**
   * The Desk (MASTER-SPEC 3.5, F4): every job this person has saved and
   * every application they hold, src/lib/desk-store.ts's listSavedJobs()/
   * listApplications() return shapes, unaltered, for the same "do no
   * second row-to-shape mapping here" reason `records` above gives.
   *
   * OPTIONAL, UNLIKE `records`, AND THAT STAYS TRUE EVEN NOW THAT
   * src/pages/settings/export.ts CALLS BOTH FUNCTIONS ON EVERY REQUEST.
   * PERSON_TABLES marks desk_saved_job and desk_application
   * includedInExport: true with exportField 'savedJobs' and 'applications'
   * respectively, which is what makes requiredExportReaderFields() require
   * export.ts's ReaderMap to carry both. The real route now supplies both on
   * every call (Promise.all over that map, same shape `records` already
   * used). The field stays optional here, rather than becoming required,
   * only so account.test.ts's existing kitchenSinkInput(), which predates
   * the Desk, still compiles without constructing Desk data for tests that
   * are not about the Desk; exportShape() still defaults an absent input to
   * empty arrays for exactly that case. What changed is that an empty
   * default is no longer what a REAL export produces: account.test.ts's own
   * "every exportable table's data reaches the bundle" test constructs
   * non-empty saved jobs and applications and asserts they survive into the
   * bundle, which is what makes an empty desk.savedJobs/desk.applications a
   * test failure now, not just a possibility this comment used to warn
   * about.
   */
  savedJobs?: readonly StoredSavedJob[];
  applications?: readonly StoredApplication[];
  postingFetches?: readonly StoredPostingFetch[];
  /**
   * The Watchlist (MASTER-SPEC 3.6): every prospect this person follows,
   * src/lib/watchlist-store.ts's listFollows() return shape, unaltered, for
   * the same "do no second row-to-shape mapping here" reason `records` and
   * `savedJobs`/`applications` above give.
   *
   * OPTIONAL for the same reason savedJobs/applications are: it keeps
   * account.test.ts's kitchenSinkInput(), which predates the Watchlist,
   * compiling without constructing Watchlist data for tests that are not
   * about it; exportShape() defaults an absent input to an empty array.
   * PERSON_TABLES marks watchlist includedInExport: true with exportField
   * 'watchlist', which is what makes requiredExportReaderFields() require
   * export.ts's ReaderMap to carry it, and what makes an empty default not
   * something a real export should ever actually produce.
   */
  watchlist?: readonly StoredFollow[];
  /**
   * The stateful filter (MASTER-SPEC F10's second bullet): the selection
   * this person last saved, src/lib/filters-store.ts's getFilterState()
   * return shape, unaltered. Optional and nullable rather than defaulted to
   * an empty array the way savedJobs/applications/watchlist are above,
   * because this is not a list: a person who has never saved a selection is
   * a real, common, permanent state (every signed-out visit and every first
   * signed-in visit before a filter is ever touched), not an empty history
   * waiting to be filled, and exportShape() below renders that state as
   * `filters: null`, the same honest absence `profile: null` already
   * renders for an account with no profile row.
   */
  filters?: StoredFilterState | null;
  /** When the bundle was assembled. Passed in, not read from `new Date()`
      inside this function, so the function stays pure and testable. */
  generatedAt: Date;
}

export interface AccountExportBundle {
  _meta: {
    what: string;
    generated_at_utc: string;
    excluded_and_why: Record<string, string>;
    unreachable_from_this_database: Record<string, string>;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
    updatedAt: string;
  };
  profile: {
    tier: string;
    signupSource: string;
    firstName: string;
    lastName: string;
    resumeEmail: string | null;
    resumeEmailUseLogin: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
  accounts: Array<{
    id: string;
    issuer: string;
    providerId: string;
    accountId: string;
    scope: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  sessions: Array<{
    createdAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }>;
  /** The Profile Record (MASTER-SPEC 3.2): every entry this person holds,
      each with the artifacts backing it up nested inside it. One bundle
      key for two PERSON_TABLES entries (record_entry, record_artifact); see
      exportBundleKey's own comment on why they share it. */
  record: {
    entries: Array<{
      prfId: string;
      kind: string;
      employerOrInstitution: string | null;
      officialTitle: string;
      start: { year: number; month: number | null } | null;
      end: { year: number; month: number | null } | null;
      location: string | null;
      description: string;
      classification: string;
      provenance: string;
      artifacts: Array<{
        kind: string;
        url: string;
        label: string | null;
      }>;
    }>;
  };
  /** The person's job-related links (MASTER-SPEC 3.1, db/014_profile_link.sql):
      the socials and sites above the record. Its own top-level key rather than
      nested under record, because a link belongs to the person, not to any one
      entry, the same distinction PERSON_TABLES draws by giving profile_link its
      own row separate from record_artifact. */
  links: Array<{
    platform: string;
    url: string;
    createdAt: string;
  }>;
  /** The Desk (MASTER-SPEC 3.5, F4): saved jobs and the application
      tracker, JD snapshots included. One bundle key for two PERSON_TABLES
      entries (desk_saved_job, desk_application), the same sharing record
      already does for record_entry and record_artifact above. */
  desk: {
    /** Every "Add a posting" request (db/033): the URL pasted, how it was read
        (by the machine or from pasted text), and the text that came back. The
        random request id is omitted: it means nothing to a person. */
    postingFetches: Array<{
      url: string;
      status: string;
      origin: string | null;
      sourceKind: string | null;
      title: string | null;
      company: string | null;
      descriptionHtml: string | null;
      finalUrl: string | null;
      failureCode: string | null;
      machineNotes: { board?: { verdict: string; name: string | null; ats: string | null; postingsSeen: number | null } };
      createdAt: string;
      completedAt: string | null;
    }>;
    savedJobs: Array<{
      jobId: string;
      savedAt: string;
    }>;
    applications: Array<{
      jobId: string | null;
      externalUrl: string | null;
      snapshot: {
        title: string | null;
        company: string | null;
        description: string | null;
      };
      state: string;
      interviewSubstage: string | null;
      abandonReason: string | null;
      closedReason: string | null;
      offeredComp: string | null;
      resumeRenderId: string | null;
      coverRenderId: string | null;
      clickedAt: string;
      confirmedAt: string | null;
      archivedAt: string | null;
    }>;
  };
  /** The Watchlist (MASTER-SPEC 3.6): every prospect this person follows,
      pre-posting. One bundle key for one PERSON_TABLES entry (watchlist);
      unlike record and desk above, nothing else shares this key today. */
  watchlist: {
    follows: Array<{
      prospectId: string;
      followedAt: string;
    }>;
  };
  /** The stateful filter (MASTER-SPEC F10's second bullet): the selection
      this person last saved on the index, or null when they never have.
      One bundle key for one PERSON_TABLES entry (account_filter_state),
      the same shape watchlist above holds for its own single entry. */
  filters: {
    selection: Record<string, string>;
    updatedAt: string;
  } | null;
}

function toISO(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Raw rows in, the bundle a person actually downloads out. Pure: no clock
 * read internally, no I/O, same input always the same output.
 *
 * EVERY FIELD BELOW IS NAMED, NONE IS SPREAD. That is not a style preference.
 * `{ ...row }` on a session or account row is exactly how a password hash or
 * a bearer token would end up in a downloaded file the day someone "cleans
 * up" this function without rereading this comment. account.test.ts asserts
 * against that failure mode directly: it hands this function a row carrying
 * a password, a token and a verification record, and checks all three are
 * absent from both the object shape and the serialized JSON.
 *
 * THE SET OF TOP-LEVEL KEYS THIS FUNCTION RETURNS IS ITSELF PINNED. Every key
 * below exists because some PERSON_TABLES entry's exportBundleKey names it,
 * or because it is one of the fixed structural keys (_meta). account.test.ts
 * asserts the produced bundle's own Object.keys() against
 * requiredExportBundleKeys() in both directions, so a key going missing here
 * (the exact way `record` was missing before this function read
 * ExportInput.records) or a stray key appearing that no table claims both
 * fail a test, not just a code review.
 */
export function exportShape(input: ExportInput): AccountExportBundle {
  const { user, sessions, accounts, profile, records, generatedAt } = input;
  // Defaulted, not required: see ExportInput.savedJobs's own comment for
  // why the real caller does not populate these yet, and why exportShape()
  // still produces the 'desk' key unconditionally rather than only when a
  // caller happens to pass one.
  const savedJobs = input.savedJobs ?? [];
  const applications = input.applications ?? [];
  const postingFetches = input.postingFetches ?? [];
  // Same defaulting, same reason, for the Watchlist: see ExportInput.
  // watchlist's own comment.
  const watchlist = input.watchlist ?? [];
  // Same defaulting, same reason, for the profile links: see ExportInput.
  // links's own comment.
  const links = input.links ?? [];
  // NOT defaulted to an empty object: see ExportInput.filters's own comment
  // on why "never saved a selection" is a real state this renders as null,
  // the same honest absence `profile` uses below, rather than a shape that
  // would claim a selection exists where none does.
  const filters = input.filters ?? null;

  return {
    _meta: {
      what: 'Every row this database holds about your account, as JSON.',
      generated_at_utc: toISO(generatedAt),
      excluded_and_why: {
        account_password:
          'A live credential hash, not a record of you. Withheld from the account rows below.',
        session_token:
          'A live bearer token. Withheld from the session rows below; the sign-in history it ' +
          'produced (when, where, what browser) is kept.',
        third_party_tokens:
          'accessToken, refreshToken and idToken on an account row are live third-party credentials. ' +
          'This app does not currently issue any (no social sign-in is configured), and none would be ' +
          'exported if it did.',
        verification_table:
          'Short-lived password-reset tokens. Not a history of anything, and this export never reads ' +
          'that table at all.',
        record_prf_ids_issued:
          'An append-only internal ledger of every PRF id this person has ever been issued ' +
          '(db/005_record_prf_ledger.sql), kept only so a deleted Profile Record entry\'s number is ' +
          'never handed to a new one. It is bookkeeping about the numbering scheme, not a fact you ' +
          'told us, and a bare list of retired numbers would mean nothing pasted into a downloaded ' +
          'file. Withheld from the profile fields below for that reason; your entries themselves, ' +
          'under their own PRF-nnnn ids, are in record.entries below in full.',
        user_provider_key:
          'Your bring-your-own API keys (db/007_user_provider_key.sql). A live credential is not a ' +
          'record of what you did: this export never reads that table, under any provider, for any ' +
          'field, ciphertext included.',
        generated_render:
          'A drafted resume or cover letter (db/012_drafting.sql). Each one reframes your own Profile ' +
          'Record for one posting, so it is regenerable from data already in this file (your record, ' +
          'below) and a published verified job. This export never reads that table; the record it was ' +
          'drawn from is here in full.',
        resume_parse:
          'The in-flight parse of a resume you uploaded (db/015_resume_parse.sql): a working buffer of ' +
          'proposals you have not confirmed yet, replaced the next time you upload and cleared once you ' +
          'act on it. The entries you DO confirm are in record.entries above, and the links in your ' +
          'links; the resume file and its text were never stored. Exporting an unconfirmed, about-to-be ' +
          'overwritten buffer would hand you words you never agreed to keep.',
        analytics_event:
          'Funnel milestones (db/028_analytics_event.sql): the times you first signed up, added an entry, ' +
          'drafted, and applied. Each is a count this app measured about actions that are themselves in ' +
          'this file already, your entries in record.entries and your applications in desk, so it is ' +
          'measurement derived from your record, not a new fact you told us. This export never reads that ' +
          'table.'
      },
      unreachable_from_this_database: {
        beehiiv:
          'If you subscribed to the mailing list, that subscription is a separate identity beehiiv ' +
          'holds with no link back to this account (written by api/subscribe.ts). It is not in this ' +
          'file and this export cannot reach it.',
        resend:
          "Delivery logs for email this site has sent you live in Resend's own systems, not this " +
          'database. Not in this file.'
      }
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: toISO(user.createdAt),
      updatedAt: toISO(user.updatedAt)
    },
    profile: profile
      ? {
          tier: profile.tier,
          signupSource: profile.signup_source,
          firstName: profile.first_name,
          lastName: profile.last_name,
          resumeEmail: profile.resume_email,
          resumeEmailUseLogin: profile.resume_email_use_login,
          createdAt: toISO(profile.created_at),
          updatedAt: toISO(profile.updated_at)
        }
      : null,
    accounts: accounts.map((account) => ({
      id: account.id,
      issuer: account.issuer,
      providerId: account.providerId,
      accountId: account.accountId,
      scope: account.scope,
      createdAt: toISO(account.createdAt),
      updatedAt: toISO(account.updatedAt)
    })),
    sessions: sessions.map((session) => ({
      createdAt: toISO(session.createdAt),
      expiresAt: toISO(session.expiresAt),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent
    })),
    record: {
      entries: records.map((entry) => ({
        prfId: entry.prfId,
        kind: entry.kind,
        employerOrInstitution: entry.employerOrInstitution,
        officialTitle: entry.officialTitle,
        start: entry.start ? { year: entry.start.year, month: entry.start.month } : null,
        end: entry.end ? { year: entry.end.year, month: entry.end.month } : null,
        location: entry.location,
        description: entry.description,
        classification: entry.classification,
        provenance: entry.provenance,
        // kind, url, label only, the same explicit-field discipline as
        // everywhere else in this function. Not `id`: see record_artifact's
        // own exportNote in PERSON_TABLES for why that surrogate key is
        // left out on purpose rather than by oversight.
        artifacts: entry.artifacts.map((artifact) => ({
          kind: artifact.kind,
          url: artifact.url,
          label: artifact.label
        }))
      }))
    },
    // platform, url and created_at only. Not `id`: the same explicit-field
    // discipline, and the same surrogate-key omission, as record_artifact
    // above. See profile_link's own exportNote in PERSON_TABLES.
    links: links.map((link) => ({
      platform: link.platform,
      url: link.url,
      createdAt: toISO(link.createdAt)
    })),
    desk: {
      postingFetches: postingFetches.map((row) => ({
        url: row.url,
        status: row.status,
        origin: row.origin,
        sourceKind: row.sourceKind,
        title: row.title,
        company: row.company,
        descriptionHtml: row.descriptionHtml,
        finalUrl: row.finalUrl,
        failureCode: row.failureCode,
        machineNotes: row.machineNotes,
        createdAt: toISO(row.createdAt),
        completedAt: row.completedAt === null ? null : toISO(row.completedAt)
      })),
      savedJobs: savedJobs.map((saved) => ({
        jobId: saved.jobId,
        savedAt: toISO(saved.savedAt)
      })),
      applications: applications.map((application) => ({
        jobId: application.jobId,
        externalUrl: application.externalUrl,
        snapshot: {
          title: application.snapshot.title,
          company: application.snapshot.company,
          description: application.snapshot.description
        },
        state: application.state,
        interviewSubstage: application.interviewSubstage,
        abandonReason: application.abandonReason,
        closedReason: application.closedReason,
        offeredComp: application.offeredComp,
        resumeRenderId: application.resumeRenderId,
        coverRenderId: application.coverRenderId,
        clickedAt: toISO(application.clickedAt),
        confirmedAt: application.confirmedAt ? toISO(application.confirmedAt) : null,
        archivedAt: application.archivedAt ? toISO(application.archivedAt) : null
      }))
    },
    watchlist: {
      follows: watchlist.map((follow) => ({
        prospectId: follow.prospectId,
        followedAt: toISO(follow.followedAt)
      }))
    },
    filters: filters
      ? {
          selection: { ...filters.selection },
          updatedAt: toISO(filters.updatedAt)
        }
      : null
  };
}
