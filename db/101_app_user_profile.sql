-- 001_app_user_profile.sql
--
-- Our table. Better Auth owns identity and gets its own tables from its own CLI
-- (`npx auth@latest migrate`). This one owns substance: what a user is allowed
-- to do, and where they came from.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON BETTER AUTH'S `user`. Adding `tier`
-- to a table the auth library owns means the library's next migration is
-- operating on a schema we have modified, and swapping the library later means
-- extracting application data out of a vendor's table. A foreign key costs one
-- join and keeps the auth layer a component rather than a foundation.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS app_user_profile (
  -- Matches Better Auth's user.id, which is text rather than a uuid column.
  -- ON DELETE CASCADE so deleting an account takes its entitlement with it: a
  -- profile row outliving its user is a tier attached to nobody, and the next
  -- account to reuse that id would inherit it.
  user_id       text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,

  -- The entitlement. CHECK rather than a Postgres enum, deliberately: adding
  -- 'paid' later is an ALTER of this constraint, where adding a value to an
  -- enum type is a heavier operation and, in older Postgres, could not run
  -- inside a transaction. The whole point of building tiers now is that the
  -- next one is a data change.
  tier          text NOT NULL DEFAULT 'member'
                CHECK (tier IN ('public', 'member', 'internal')),

  -- Which gate converted this person. Written once at account creation.
  signup_source text NOT NULL DEFAULT 'direct',

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Answering "how many members did the drafts gate convert" should not read the
-- whole table once there are more than a few thousand rows.
CREATE INDEX IF NOT EXISTS app_user_profile_signup_source_idx
  ON app_user_profile (signup_source);

CREATE INDEX IF NOT EXISTS app_user_profile_tier_idx
  ON app_user_profile (tier);

-- updated_at that is maintained by the database rather than by every caller
-- remembering. A timestamp only some code paths update is worse than none,
-- because it looks authoritative.
CREATE OR REPLACE FUNCTION app_user_profile_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_user_profile_touch_trigger ON app_user_profile;
CREATE TRIGGER app_user_profile_touch_trigger
  BEFORE UPDATE ON app_user_profile
  FOR EACH ROW EXECUTE FUNCTION app_user_profile_touch();
