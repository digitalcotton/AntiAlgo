-- The waitlist tier and the signup source, folded onto the index's schema after
-- the copy-over (2026-09-13). The index's app_user_profile ladder is
-- ('public','member','paid','internal'); this site adds 'waitlisted' at rank 5,
-- between public and member, so the waitlist flag can park a new account below
-- member without any gate being edited (see tiers.config.mjs). Same
-- drop-and-re-add pattern the index's 034_paid_tier uses, so the constraint's
-- generated name does not matter.
DO $$
DECLARE
  con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'app_user_profile'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%tier%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app_user_profile DROP CONSTRAINT %I', con);
  END IF;
END $$;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_tier_check
  CHECK (tier IN ('public', 'waitlisted', 'member', 'paid', 'internal'));

-- Where the account came from, written once at signup by the auth hook. The
-- index does not carry this column; this site does, so a later read can tell a
-- waitlist signup from a direct one without joining anything.
ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS signup_source text;
