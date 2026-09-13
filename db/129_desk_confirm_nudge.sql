-- 029_desk_confirm_nudge.sql
--
-- The confirm-loop nudge, behind the `email_send` flag. F4.1 names three
-- channels for the confirm loop (return-to-tab, next-visit, the weekly digest);
-- this is the third, made concrete as a scheduled email: a person who clicked
-- apply on a role and never came back to say what happened gets one gentle nudge
-- to resolve it on their Desk. desk_application already records the loop's state
-- (confirmed_at IS NULL AND archived_at IS NULL is "still waiting", db/006), and
-- the partial index desk_application_unconfirmed_idx already serves that read.
--
-- WHAT THIS COLUMN ADDS: idempotency. Without a record of who was already
-- nudged, a nightly cron would nudge the same unconfirmed card every single day,
-- which is spam, not a nudge. confirm_nudged_at is set the moment the nudge for
-- a card is sent, and the sender's query excludes any card that already has it.
-- One card, one nudge. A later, still-unconfirmed card the person clicks after
-- this runs has its own NULL and gets its own single nudge in a later run.
--
-- NULLABLE, no default: the overwhelming majority of rows are never nudged (they
-- get confirmed, or the reader resolves them another way), so NULL is the right
-- resting state and the column costs a row nothing until a nudge actually fires.

ALTER TABLE desk_application ADD COLUMN IF NOT EXISTS confirm_nudged_at timestamptz;

-- The exact read the sender makes: still-waiting cards that have not been nudged,
-- ordered for batching by person. A partial index so it stays small (it indexes
-- only the cards eligible for a nudge, not the whole table) and matches the
-- WHERE clause in src/lib/desk-store.ts's listUnconfirmedForNudge().
CREATE INDEX IF NOT EXISTS desk_application_nudge_idx
  ON desk_application (clicked_at)
  WHERE confirmed_at IS NULL AND archived_at IS NULL AND confirm_nudged_at IS NULL;
