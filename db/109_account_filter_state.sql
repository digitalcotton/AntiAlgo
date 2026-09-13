-- 009_account_filter_state.sql
--
-- Deterministic, stateful filters (MASTER-SPEC F10's second bullet,
-- RUN-FINISH phase 7): "exact filters that persist between sessions
-- (account-backed when signed in), never replaced by a chat box, ordered by
-- observed data, never by payment." Signed out, the same selection lives in
-- the browser's own localStorage; this table is the signed-in half, one row
-- per person, holding the last selection they set on the index.
--
-- THIS TABLE IS PERSON-OWNED AND IS INVENTORIED. Unlike db/006_desk.sql,
-- which left that step for a later task, this migration and its
-- src/lib/account.ts PERSON_TABLES entry land together: see that file's own
-- account_filter_state entry for deleteReach 'cascade', verifyColumn
-- 'user_id', includedInExport true, and the exportField 'filters' wiring.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS account_filter_state (
  -- Cascade for the same reason db/001 gives for app_user_profile and
  -- db/006/db/008 restate for their own person-owned tables: a filter
  -- selection outliving its person is a fact attached to nobody, and the
  -- next account to reuse this id would inherit somebody else's filters.
  --
  -- The primary key, not a separate id column: one row per person, the same
  -- shape db/007_user_provider_key.sql would use if a person could hold
  -- only one key per provider rather than several. There is exactly one
  -- current selection to remember, never a history of past ones, so there
  -- is nothing a second column would ever need to distinguish.
  user_id     text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,

  -- THE SELECTION ITSELF IS JSONB, NOT ONE COLUMN PER FILTER GROUP OR A
  -- CHECK CONSTRAINT NAMING EVERY VALUE, AND THAT IS DELIBERATE, THE SAME
  -- WAY db/006's job_id and db/008's prospect_id ARE DELIBERATELY NOT
  -- FOREIGN KEYS, FOR THE OPPOSITE REASON. Those two columns name no table
  -- on this side of the boundary to reference, because the data they point
  -- at is a published file this database never reads. This column has the
  -- reverse problem: the vocabulary it would need to enumerate (which
  -- filter groups exist, which values each one accepts, today 'location',
  -- 'comp' and 'freshness', and within 'comp' every key COMP_BANDS names)
  -- is not fixed by this migration at all. It is derived from the sweep's
  -- own rows every build, by src/lib/data.ts's filterGroups(), which can
  -- gain or retire a group or a band's key without a schema change. A
  -- CHECK constraint copying today's vocabulary into SQL would be a second,
  -- harder-to-move copy of something src/lib/data.ts already owns, and the
  -- two would drift the day a band is renamed there and not here.
  --
  -- The validation this repository does want, an unknown group dropped and
  -- an unknown value falling back to 'all', is application logic and lives
  -- in src/lib/filters.ts's normalizeFilterSelection(), run against the
  -- live groups on every read and every write. What Postgres enforces here
  -- is only that a row exists and belongs to exactly one person; the
  -- shape of what is inside it is this feature's job, not this migration's.
  selection   jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintained by the database, the same trigger pattern db/001,
-- db/006 and db/008 all use, for the reason each of them gives: a timestamp
-- only some code paths update is worse than none, because it looks
-- authoritative.
CREATE OR REPLACE FUNCTION account_filter_state_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_filter_state_touch_trigger ON account_filter_state;
CREATE TRIGGER account_filter_state_touch_trigger
  BEFORE UPDATE ON account_filter_state
  FOR EACH ROW EXECUTE FUNCTION account_filter_state_touch();

-- No index beyond the primary key: every read and every write this feature
-- makes is scoped to exactly one user_id, which the primary key already
-- serves, the same restraint db/008_watchlist.sql states for its own
-- narrower access pattern.
