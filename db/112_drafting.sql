-- 012_drafting.sql
--
-- Drafting on apply: MASTER-SPEC F3's tailor engine, relocated from its own
-- page (the old /account/tailor, now deleted) to the moment a person clicks
-- apply on a verified posting. Two changes, in order.
--
-- (1) DRAFTING IS ON OUT OF THE BOX NOW. New accounts draft a resume and a
--     cover letter the first time they apply, provided a provider key is
--     stored (db/007_user_provider_key.sql) and the 'byok' flag is lit
--     (flags.config.mjs). Existing rows move to the new default too: this
--     run predates anyone deliberately turning generate_on_apply off, so
--     there is no "a person chose false" state this UPDATE could be
--     overwriting. That premise holds only for this one run; a future
--     migration must never re-run this blanket UPDATE once real opt-outs
--     exist. It is alpha, and the owner asked for on-by-default.
ALTER TABLE app_user_profile ALTER COLUMN generate_on_apply SET DEFAULT true;
UPDATE app_user_profile SET generate_on_apply = true;

-- (2) WHERE A DRAFTED RESUME AND COVER LIVE ONCE COMPUTED. One row per
--     (application, kind): src/lib/generated-render-store.ts's beginDraft()
--     writes both rows the moment a click decides to draft, each 'pending',
--     and its completeDraft() fills in the payload once the render (styled
--     or deterministic) finishes. Cascading from both the user and the
--     application, so a deleted account or a deleted application takes its
--     drafts with it rather than leaving an orphaned row a future account
--     could never reach and a delete audit could never explain.
--
--     APPLICATION_ID IS bigint, NOT integer, MATCHING desk_application.id.
--     db/006_desk.sql declares that column `bigint GENERATED ALWAYS AS
--     IDENTITY PRIMARY KEY`; a foreign key here has to reference that exact
--     type, so this column is bigint too, checked against db/006 directly
--     rather than assumed.
--
--     Regenerable, so excluded from the export bundle
--     (src/lib/account.ts's PERSON_TABLES: includedInExport false is the
--     right entry for this table, the same reasoning db/007 already gives
--     for user_provider_key, restated here for a different reason, a live
--     credential there, a value that can always be recomputed from the
--     record and the posting here): a resume render is not a fact about
--     what a person did, it is a cached answer to "what would the tailor
--     engine say right now," and re-deriving it from record_entry and the
--     sweep's own published job is strictly more honest than shipping a
--     frozen copy in a data export that could go stale the day the record
--     changes.
CREATE TABLE IF NOT EXISTS generated_render (
  -- Not an identity column: the store mints the id itself
  -- (crypto.randomUUID()) so it can stamp desk_application's own
  -- resume_render_id / cover_render_id columns in the same round trip that
  -- creates the row, rather than a second query to read back an
  -- auto-generated id first.
  id             text PRIMARY KEY,

  user_id        text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id bigint NOT NULL REFERENCES desk_application(id) ON DELETE CASCADE,

  -- CHECK rather than a Postgres enum, the same reasoning db/001 gives for
  -- tier and db/006 restates for desk_application.state: the next kind (a
  -- LinkedIn summary, say) is an ALTER of this constraint, not a heavier
  -- enum-type change.
  kind    text NOT NULL CHECK (kind IN ('resume', 'cover')),

  -- 'pending' the moment beginDraft() writes the row; 'ready' or 'fallback'
  -- once completeDraft() lands a payload. There is no 'failed' state: a hard
  -- failure still re-renders deterministically and completes the row as
  -- 'fallback' (src/lib/generation-preference-store.ts's own header), so a
  -- reader never watches a row that can only ever end in an error. The one
  -- honest exception, both attempts failing outright, leaves the row
  -- 'pending' forever, which the draft room's own polling state already
  -- describes plainly enough that no fourth status is needed for it.
  status  text NOT NULL CHECK (status IN ('pending', 'ready', 'fallback')),

  -- The render itself (src/lib/tailor.ts's ResumeRender or CoverRender),
  -- serialized whole. NULL while status = 'pending'. No CHECK ties payload's
  -- presence to status: the two writes that ever touch this column
  -- (beginDraft() setting it NULL, completeDraft() setting it once) are
  -- both in this codebase's own two files, not an open write surface a
  -- constraint needs to defend.
  payload jsonb,

  -- Which provider was configured for this draft, and which of that
  -- provider's models rendered it, whether or not the attempt actually
  -- succeeded (see status above): a 'fallback' row still names the provider
  -- that was tried, because "we tried X and fell back" is a different,
  -- more honest fact than "nothing was tried." Both NULL while pending.
  -- No CHECK against PROVIDER_REGISTRY's provider ids: that registry lives
  -- in src/lib/generation-providers.ts, a module this migration cannot
  -- import, the same reason db/007's own provider CHECK is a hand-kept
  -- list rather than a shared source of truth.
  provider text,
  model    text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per (application, kind): a second draft attempt against the
  -- same application replaces the row in place (beginDraft()'s own upsert),
  -- never appends a second one, so the draft room always has exactly one
  -- resume and one cover to read per application, never a history to pick
  -- from.
  UNIQUE (application_id, kind)
);

-- The draft room's own read (src/lib/generated-render-store.ts's
-- getRenders()) and the nightly account-delete/export sweeps both look up
-- by application_id. Left in even though the UNIQUE constraint above already
-- indexes (application_id, kind) and could serve an application_id-only
-- lookup off its own leading column: a name of its own is worth the small
-- redundancy, the same way db/006's own desk_application_user_idx documents
-- itself separately from that table's primary key.
CREATE INDEX IF NOT EXISTS generated_render_app_idx ON generated_render (application_id);

-- updated_at maintained by the database, the same trigger pattern db/001,
-- db/006, db/007 and db/009 all use, for the reason each of them gives: a
-- timestamp only some code paths update is worse than none, because it
-- looks authoritative.
CREATE OR REPLACE FUNCTION generated_render_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generated_render_touch_trigger ON generated_render;
CREATE TRIGGER generated_render_touch_trigger
  BEFORE UPDATE ON generated_render
  FOR EACH ROW EXECUTE FUNCTION generated_render_touch();
