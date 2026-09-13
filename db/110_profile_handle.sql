-- 010_profile_handle.sql
--
-- A handle: the /u/<handle> address MASTER-SPEC F8 asks for. RUN-MASTER
-- amendment 6 ships the route and this column built, visibility locked to
-- private-only this run: nobody but the owner is ever served through a
-- claimed handle. See src/pages/u/[handle].astro's own header for where
-- that gate actually lives (the route, not this schema).
--
-- LIVES ON app_user_profile, THE SAME TABLE db/002_profile_names.sql PUT
-- first_name/last_name ON, FOR THE SAME REASON. One row per person already
-- exists there and already cascades on delete
-- (db/001_app_user_profile.sql's user_id FK, ON DELETE CASCADE): a second
-- table would need its own FK and its own cascade to restate a fact this
-- table already guarantees. Deleting the account removes a claimed handle
-- with it, no application statement required; see src/lib/account.ts's
-- app_user_profile entry (deleteReach: 'cascade') for where that is
-- recorded, and this file's own footer for how it was actually checked.
--
-- NULLABLE, UNLIKE first_name/last_name. db/002's own header chose NOT NULL
-- DEFAULT '' specifically so no caller has to null-check a name. A handle is
-- the opposite case: most accounts have never claimed one, "no handle" is
-- the overwhelmingly common state, and a handle is UNIQUE. Postgres never
-- treats two NULLs as equal for a unique constraint, so leaving this column
-- NULL until claimed is what lets every unclaimed account coexist under one
-- UNIQUE index. An empty-string default would collide with itself the
-- moment a second person also had not claimed one, and dodging that would
-- need a partial index carved around the empty string: a second rule to
-- keep in sync with the first, for a state ('not captured') NULL already
-- means to a constraint with no help required.
--
-- THE CHARACTER SET IS THE CASE DECISION, AND IT DECIDES A THIRD QUESTION
-- TOO (LENGTH, CHARACTERS, CASE, ALL AT ONCE). src/lib/record.ts's
-- coreMatches() refuses to case-fold a person's name or title, on purpose:
-- arbitrary text has no safe, locale-independent lowercasing (full Unicode
-- case folding produces surprising many-to-one collisions across scripts;
-- the Turkish dotted-capital-I pair is the standard example, one instance
-- of a general problem with folding text nobody constrained). A handle is
-- not arbitrary text. It is restricted here to plain ASCII: lowercase a-z,
-- 0-9, and an interior hyphen, first and last character alphanumeric, 3 to
-- 30 characters total. That restriction is what makes "is Ryan the same
-- handle as ryan" answerable at all: with uppercase excluded from the legal
-- alphabet entirely, this column can never hold two byte strings that only
-- differ by case, so the answer is yes, enforced structurally, at the cost
-- of nothing more than a plain UNIQUE constraint on a column that is
-- already lowercase by construction. There is no lower(), no COLLATE
-- clause, and no case-insensitive index anywhere below, because there is
-- nothing left for one to fold: the CHECK constraint is what makes "Ryan"
-- fail before it can ever reach the unique index, not a runtime
-- normalisation this schema would otherwise have to trust every future
-- write path to remember to run. src/lib/record-store.ts's
-- foldHandleCase()/validateHandleFormat() mirror this same shape for a
-- fast, friendly rejection before the round trip; this constraint is the
-- one that cannot be bypassed by a caller that forgets to call them, which
-- is the whole point of deciding this in the schema and not in application
-- code (two application paths WILL eventually disagree; the database
-- cannot).
--
-- WHY NOT ALSO ADD CHECK (handle = lower(handle)). Redundant with the
-- character class: [a-z0-9-] contains no uppercase code point, so any
-- string this constraint accepts is already lowercase by construction. A
-- second CHECK restating that fact would be a second place the same
-- decision could drift from the first, the exact "two copies of one rule"
-- failure this repository's own comments keep naming.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS handle text;

ALTER TABLE app_user_profile
  DROP CONSTRAINT IF EXISTS app_user_profile_handle_shape;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_handle_shape
    CHECK (handle IS NULL OR handle ~ '^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$');

-- UNIQUE, not a hand-built index: Postgres creates one automatically for a
-- UNIQUE constraint, and that same index is what src/pages/u/[handle].astro
-- reads through (src/lib/record-store.ts's ownerOfHandle(), SELECT user_id
-- FROM app_user_profile WHERE handle = $1) to resolve a handle to an owner
-- in one indexed lookup, the identical read whether the handle is claimed,
-- unclaimed, or malformed: all three simply match zero rows.
ALTER TABLE app_user_profile
  DROP CONSTRAINT IF EXISTS app_user_profile_handle_unique;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_handle_unique UNIQUE (handle);

-- WHERE THE CASCADE CLAIM ABOVE WAS ACTUALLY CHECKED, SO THE NEXT READER
-- DOES NOT HAVE TO RETAKE IT ON FAITH. db/001_app_user_profile.sql's
-- user_id column reads `text PRIMARY KEY REFERENCES "user"(id) ON DELETE
-- CASCADE`. Adding a column to an existing table with ALTER TABLE does not
-- touch that foreign key or its ON DELETE clause in any way: a column is
-- not a constraint, and Postgres cascades a delete by walking the
-- constraints on a table, not by inspecting which columns it happens to
-- have gained since the table was created. handle is exactly as cascaded
-- as first_name and last_name already are, for the identical reason. No
-- new migration, trigger, or application statement is needed for a
-- deleted account's handle to stop resolving; src/pages/account/delete.ts
-- is unmodified by this migration and needs no change.
