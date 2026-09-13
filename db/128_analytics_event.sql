-- 028_analytics_event.sql
--
-- First-party funnel analytics, behind the `analytics` flag. The one question
-- this table exists to answer is the plain one every job product needs and no
-- third-party script is allowed near: of the people who sign up, how many go on
-- to build a profile, apply to a role, and draft an application. That is a count
-- of distinct users at each milestone, nothing more.
--
-- A MILESTONE TABLE, NOT AN EVENT LOG. Each row is "this user first reached this
-- milestone, at this time", at most once per (user, milestone). The PRIMARY KEY
-- is (user_id, event), and the recorder writes ON CONFLICT DO NOTHING, so the
-- second entry a person adds, the tenth role they apply to, never writes a new
-- row: the first occurrence is the fact, and its created_at is when they crossed
-- the line. This is deliberately not a volume log (how many times), because the
-- funnel question is about people, not clicks, and a milestone table cannot
-- accidentally become a behavioral profile.
--
-- NO THIRD PARTY, NO PII, DELETED WITH THE ACCOUNT. The only columns are the
-- user id, a milestone name from a fixed vocabulary, and a timestamp. No page
-- url, no user agent, no ip, nothing a person typed. user_id REFERENCES
-- "user"(id) ON DELETE CASCADE, the same shape every other person-linked table
-- uses (db/006, db/012, db/015), so deleting the account removes its analytics
-- at the database level with no application statement. It is registered in
-- account.ts PERSON_TABLES as includedInExport:false for the same reason
-- generated_render is: it is measurement this app computed about the person's
-- own actions, and those actions are exported in full under their own records;
-- the excluded_and_why register in the export bundle says so in the open.
--
-- THE VOCABULARY. `event` is free text at the schema level (a CHECK would need a
-- migration to add a milestone), but the recorder in src/lib/analytics.ts only
-- ever passes one of a fixed union: signup, first_entry, first_draft, apply.

CREATE TABLE IF NOT EXISTS analytics_event (
  user_id    text        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  event      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event)
);

-- The funnel is read across users by milestone ("how many reached first_entry"),
-- so the count query filters on event. A btree on event alone serves it; the
-- primary key already covers the per-user lookups the recorder's ON CONFLICT does.
CREATE INDEX IF NOT EXISTS analytics_event_event_idx
  ON analytics_event (event);
