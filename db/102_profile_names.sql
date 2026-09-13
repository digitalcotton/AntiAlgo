-- 002_profile_names.sql
--
-- First and last name, stored separately, in our table.
--
-- WHY NOT JUST BETTER AUTH'S `name`. Better Auth's user model has one `name`
-- field and it is required at sign-up, so it keeps getting the display form,
-- "Ryan Payne". That is correct for a header greeting and useless for the thing
-- this site is actually for: an outreach draft opens "Hi Ryan," and splitting a
-- single string on a space to get there is a guess that fails on every name
-- with a particle, a suffix, or two given names. Ask for the two parts once, at
-- the only moment the person is present to answer, and never guess again.
--
-- WHY THEY LIVE HERE AND NOT AS BETTER AUTH `additionalFields`. Same rule as
-- tier and signup_source: adding application columns to a vendor's user table
-- means migrating them out when the vendor is replaced. See src/lib/auth.ts.
--
-- NOT NULL DEFAULT '' RATHER THAN NULLABLE. Existing rows predate this column
-- and there is no honest value for them, but a nullable name field spreads a
-- null check into every caller, and the one that forgets renders "Hi null,".
-- Empty string means "not captured", is falsy in every language that touches
-- it, and degrades to the same fallback a missing name would.

ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_name  text NOT NULL DEFAULT '';

-- Length ceilings rather than free text. These are attacker-supplied strings
-- that end up in an email greeting, so they are bounded at the database rather
-- than trusting every writer to bound them. 120 is past the longest recorded
-- real name and far short of anything worth storing.
ALTER TABLE app_user_profile
  DROP CONSTRAINT IF EXISTS app_user_profile_first_name_len;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_first_name_len CHECK (length(first_name) <= 120);

ALTER TABLE app_user_profile
  DROP CONSTRAINT IF EXISTS app_user_profile_last_name_len;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_last_name_len CHECK (length(last_name) <= 120);
