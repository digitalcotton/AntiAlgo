-- The "Save my spot" landing page's own table (2026-09-13). This is separate
-- from app_user_profile and the waitlisted tier that 200_waitlist_tier.sql
-- added: this table captures an email address before anyone creates an
-- account at all, which is all the pre-launch waitlist page asks for. Do not
-- fold this into app_user_profile; the two waitlists answer different
-- questions (who gave us an email vs. who has an account) and a later phase
-- may need to reconcile them deliberately rather than by construction.
--
-- referral_code and referred_by exist for a future "refer someone, move up"
-- feature. referred_by is a SOFT reference to another row's referral_code
-- (no foreign key), because the code that referred someone may not exist yet
-- when this table is queried, and because enforcing it buys nothing until the
-- bump logic that reads it actually exists. THE BUMP MATH ITSELF IS NOT
-- IMPLEMENTED HERE. Position is computed at read time from created_at (see
-- src/pages/api/waitlist.ts and scripts/waitlist.mjs); referred_by is only
-- ever written, never read, until that feature lands.
CREATE TABLE IF NOT EXISTS waitlist_email (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  referral_code text UNIQUE,
  referred_by   text NULL
);

CREATE INDEX IF NOT EXISTS waitlist_email_created_at_idx ON waitlist_email (created_at);
