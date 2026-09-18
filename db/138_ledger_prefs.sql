-- 138_ledger_prefs.sql
--
-- The Ledger's per-person settings: the filter chips a reader set (which map to
-- real board fields, never to a re-weighting of the fit score), plus the one
-- timestamp the daily report needs, last_seen_at: the instant this reader last
-- loaded the Ledger, so "new since you last looked" is measured server-side
-- against a clock the client cannot write.
--
-- One row per person, the same shape db/009_account_filter_state.sql uses for
-- the board's own stateful filters. The selection is jsonb for the same reason
-- db/009 gives: the vocabulary (which chips exist, which values each accepts)
-- is derived from the sweep's own rows, not fixed by this migration, so a CHECK
-- constraint copying it into SQL would be a second copy that drifts. Validation
-- is application logic (src/lib/ledger-prefs-store.ts's caller), not a schema
-- rule; what Postgres enforces here is only that a row exists and belongs to
-- exactly one person.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS account_ledger_prefs (
  -- Cascade, and the primary key, for the same reasons db/009 states: one row
  -- per person, gone with the person.
  user_id       text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,

  -- The chip selection: real board fields only (remote, a comp floor, geo),
  -- never a fit re-weighting, because the fit components are derived from the
  -- rubric weights upstream and not yet measured, so re-weighting them would be
  -- a number we cannot stand behind.
  selection     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The daily clock. Null until the first authorized render stamps it. "New
  -- since you last looked" reads this, then the render advances it.
  last_seen_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintained by the database, the same trigger pattern db/001,
-- db/008 and db/009 use.
CREATE OR REPLACE FUNCTION account_ledger_prefs_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_ledger_prefs_touch_trigger ON account_ledger_prefs;
CREATE TRIGGER account_ledger_prefs_touch_trigger
  BEFORE UPDATE ON account_ledger_prefs
  FOR EACH ROW EXECUTE FUNCTION account_ledger_prefs_touch();

-- No index beyond the primary key: every read and write is scoped to one
-- user_id, which the primary key already serves, the same restraint db/009
-- states for its own access pattern.
