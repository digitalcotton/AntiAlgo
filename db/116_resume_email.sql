-- 016_resume_email.sql
--
-- A separate email for the top of a drafted resume, kept apart from the login
-- email. Two columns on app_user_profile, the same one-row-per-person table
-- db/010 and db/011 chose to extend rather than add a table beside: the row
-- already exists for every account, already cascades on delete, already
-- touch-stamps, and account.ts's PERSON_TABLES already inventories it as
-- exported and cascade-deleted, so a new column needs no new entry there.
--
-- WHY TWO VALUES, NOT ONE. A person's login email and the email they want on a
-- resume are often not the same address, and the choice between them is a
-- setting, not a deletion: flipping back to the login email must not throw the
-- custom one away. So resume_email holds the custom address (whatever they last
-- typed, kept), and resume_email_use_login is the switch that decides which one
-- the drafted resume prints. Toggling the switch never touches resume_email;
-- only an edit does. Default is to use the login email, which is what every
-- existing account gets, so nothing changes for anyone until they choose.
--
-- The login email itself is NOT stored here. Better Auth owns "user".email;
-- src/lib/record-store.ts reads it from there when the switch says to use it.
-- This column only holds the custom alternative.
ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS resume_email text
    CHECK (resume_email IS NULL OR char_length(resume_email) <= 320),
  ADD COLUMN IF NOT EXISTS resume_email_use_login boolean NOT NULL DEFAULT true;
