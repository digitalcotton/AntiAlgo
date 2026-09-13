-- 005_record_prf_ledger.sql
--
-- The Profile Record's id ledger, added as a column on app_user_profile
-- rather than as a new table.
--
-- THE PROBLEM. src/lib/record.ts's nextPrfId() is strictly max(existing)+1
-- and its documented contract is that `existing` must be every PRF-nnnn a
-- person has ever been issued, not merely the ids of entries that still
-- exist: a deleted PRF-0003 must never be handed to a new entry, because
-- every render that ever cited it (a downloaded resume, a link someone else
-- was sent) would become ambiguous about which fact it meant. record_entry
-- (db/004) is a table that actually deletes a row when a person deletes an
-- entry, on purpose: MASTER-SPEC's promise that person data is "deletable"
-- means an entry a person removes is actually gone, not merely hidden
-- behind a soft-delete flag. Those two facts together mean src/lib/
-- record-store.ts cannot compute the next id by reading record_entry alone:
-- the moment an entry is deleted, its id disappears from that table and a
-- naive max()+1 would eventually reissue it.
--
-- THE FIX. app_user_profile gets one more column: every PRF-nnnn ever
-- issued to that person, appended to and never removed from. record-store.ts's
-- createEntry() reads this column (not record_entry) to build the `existing`
-- array nextPrfId() demands, so a deleted entry's number stays retired
-- forever even though the row that used it is gone.
--
-- WHY A COLUMN HERE AND NOT A THIRD TABLE. app_user_profile already is one
-- row per person, already cascades from user(id) the same way this ledger
-- needs to (so it disappears with the account, same as everything else
-- RUN-MASTER F1's delete promises), and is already the inventory entry
-- src/lib/account.ts's PERSON_TABLES reads for delete and export. A new
-- table here would need its own PERSON_TABLES entry to keep that inventory
-- honest and its own cascade wired by hand; a column on a table already
-- covered by both needs neither.
--
-- text[] rather than a join table: this is an append-only list scoped to
-- one person, read in full and only by that person's own create, which is
-- exactly what a Postgres array column is for. It is bookkeeping, not a
-- record: nothing a person wrote lives in it, so it carries no length
-- ceiling of its own and needs none of record_entry's CHECK constraints.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS record_prf_ids_issued text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN app_user_profile.record_prf_ids_issued IS
  'Every PRF-nnnn ever issued to this person by record-store.ts''s createEntry(), including ids whose record_entry row has since been deleted. Append-only: nothing in this codebase removes an entry from this array. src/lib/record.ts''s nextPrfId() reads it in full so a deleted entry''s number is never handed to a new one.';
