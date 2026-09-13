-- 006_desk.sql
--
-- The Desk: saved jobs and applications (MASTER-SPEC 3.5, F4). Two tables.
-- desk_saved_job is a bookmark against a verified posting from the sweep.
-- desk_application is the tracker's spine: STM-0002, the user-side state
-- machine, plus the JD snapshot F4.2 requires and the offer-stage
-- comparison MASTER-SPEC 3.5 calls out by name.
--
-- BOTH TABLES ARE PERSON-OWNED AND MUST BE INVENTORIED. Phase 1's account
-- delete and export both work off PERSON_TABLES in src/lib/account.ts, read
-- in full there before this file was written. This migration does not
-- touch that file; a later task must add an entry for each table below
-- before delete or export can be called complete. For that task: both
-- tables cascade from "user"(id) (deleteReach 'cascade', verifyColumn
-- 'user_id', same as record_entry in db/004), both are includedInExport
-- true, and desk_application's abandon_reason column is the one field on
-- either table that needs its own exportNote: see the paragraph on it
-- below before writing that entry.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

-- ---------------------------------------------------------------------------
-- desk_saved_job
-- ---------------------------------------------------------------------------

-- A bookmark, not a tracker entry: "save for later" against one of our own
-- verified postings, before the person has clicked apply on anything.
-- Scoped to the sweep's own jobs on purpose, unlike desk_application below:
-- F4.2's universal capture (any pasted URL) is a promise about applications,
-- the thing a person is actually pursuing, not about a browsing bookmark,
-- and a bookmark against a URL we never verified would have nothing of ours
-- to attach (no fate overlay, no auto-link) and nothing to show beyond what
-- the person could paste into any note-taking app.
CREATE TABLE IF NOT EXISTS desk_saved_job (
  -- Cascade for the same reason db/001 gives for app_user_profile and
  -- db/004 restates for record_entry: a bookmark outliving its person is a
  -- fact attached to nobody, and the next account to reuse this id would
  -- inherit somebody else's saved jobs.
  user_id     text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- The sweep's stable job id (data.ts's Job.id). NOT a foreign key: verified
  -- postings live in src/data/jobs.json, a published file this database
  -- never reads and this repo's own constraints canon marks untouchable.
  -- There is no jobs table in Postgres for this column to reference; the
  -- application layer resolves the id against the published data at read
  -- time, the same way desk_application.job_id does below.
  job_id      text NOT NULL CHECK (length(job_id) <= 200),

  -- One save per person per job: saving again is a no-op, not a second row.
  PRIMARY KEY (user_id, job_id),

  saved_at    timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION desk_saved_job_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS desk_saved_job_touch_trigger ON desk_saved_job;
CREATE TRIGGER desk_saved_job_touch_trigger
  BEFORE UPDATE ON desk_saved_job
  FOR EACH ROW EXECUTE FUNCTION desk_saved_job_touch();

-- ---------------------------------------------------------------------------
-- desk_application
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS desk_application (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- EITHER a verified posting from the sweep OR an external URL, never
  -- neither and never both (MASTER-SPEC F4.2: "Paste any job URL... Jobs on
  -- boards we sweep auto-link to verification and get the fate overlay;
  -- external ones are labeled not verified by us, plainly"). The CHECK
  -- below is the boolean-XOR spelling Postgres has no dedicated operator
  -- for: exactly one of the two must be non-null.
  --
  -- job_id is not a foreign key for the same reason desk_saved_job.job_id
  -- above is not one: the sweep's postings are a published file, not a
  -- table this database owns.
  job_id        text CHECK (length(job_id) <= 200),
  external_url  text CHECK (length(external_url) <= 2000),
  CHECK ((job_id IS NOT NULL) <> (external_url IS NOT NULL)),

  -- THE JD SNAPSHOT, TAKEN AT CLICK, NOT AT CONFIRM. F4.2 is explicit about
  -- why: postings die mid-process, and a snapshot taken later would be a
  -- snapshot of nothing. clicked_at below is that same instant: F4.2 asks
  -- for one moment of capture, not two clocks (a "clicked" timestamp and a
  -- "snapshot taken" timestamp) that some future bug could let drift apart.
  -- Person-owned, private, never re-fetched or refreshed after the click:
  -- this is the person's own copy, not a live mirror of the posting.
  --
  -- snapshot_title and snapshot_company are nullable rather than
  -- NOT NULL DEFAULT '': an empty string would claim we captured
  -- something and captured nothing, where NULL says plainly that the click
  -- happened somewhere with no title or company visible to snapshot. The
  -- 500-character ceiling is generous past any real posting title or
  -- company name, well past record_entry's 200 for the same fields on a
  -- person's own record, because this is scraped or pasted text, not
  -- something typed by hand.
  snapshot_title       text CHECK (length(snapshot_title) <= 500),
  snapshot_company     text CHECK (length(snapshot_company) <= 500),
  -- 20000 characters is a ceiling against abuse (an attacker paste, not a
  -- real job description), not a display limit: no known real posting
  -- description approaches it, and record_entry's 4000-character ceiling on
  -- description does not apply here because that field is a person's own
  -- prose about themselves where this one is an employer's full posting
  -- text, reproduced, which routinely runs several times longer.
  snapshot_description text CHECK (length(snapshot_description) <= 20000),

  -- THE USER-SIDE STATE, STM-0002. CHECK rather than a Postgres enum, for
  -- the reason db/001 gives for tier and db/004 restates for kind: the next
  -- state is one entry in this list plus one case in src/lib/desk.ts's
  -- transition table, not a heavier enum-type ALTER.
  --
  -- 'clicked' is the only state this migration lets a row start in
  -- (DEFAULT below): every other state is reached only through
  -- src/lib/desk.ts's transition(), which is where CLICK IS NOT APPLIED is
  -- enforced. This CHECK enforces the domain, not the sequence; the
  -- sequence is src/lib/desk.ts's job precisely because a CHECK constraint
  -- cannot see the confirmation a promotion to 'applied' requires.
  state         text NOT NULL DEFAULT 'clicked'
                CHECK (state IN ('clicked', 'applied', 'abandoned', 'still_working',
                                  'interviewing', 'offer', 'closed')),

  -- User-defined, free text, per MASTER-SPEC 3.5 ("interviewing (user-
  -- defined sub-stages allowed)"). Not constrained to a list because the
  -- whole point is that the person names their own stage ("panel round",
  -- "take-home due Friday"). Retained after the application leaves
  -- 'interviewing': it is a record of how far the process got, not a
  -- live-only field a later state should erase.
  interview_substage text CHECK (length(interview_substage) <= 200),

  -- THE ABANDON REASON, F4.1's six chips, exactly. Required when and only
  -- when state = 'abandoned'; the CHECK below is the same boolean-equality
  -- spelling as the job_id/external_url XOR above, read as "both or
  -- neither" rather than "exactly one" because here both sides being true
  -- together (abandoned AND a reason given) is the valid case.
  --
  -- PERSON-PRIVATE BY SHAPE, NOT BY POLICY ALONE. MASTER-SPEC F4.1: "store
  -- per-person private, aggregate only above an anonymity threshold (n of
  -- 10 or more per employer) and never expose individual behavior." This
  -- migration creates no view, no materialized rollup, and no per-employer
  -- counter anywhere: the only path to this column is a query against this
  -- table, scoped to one person's own rows, exactly like every other column
  -- here. An aggregate report is therefore not a query someone can stumble
  -- into; it is a GROUP BY an engineer has to write on purpose, and that
  -- code (not yet written; out of this task) is where the n >= 10 threshold
  -- belongs. Nothing in this schema makes skipping that threshold easier
  -- than enforcing it.
  abandon_reason text
                CHECK (abandon_reason IN ('form_too_long', 'account_wall', 'salary_missing',
                                           'posting_dead', 'changed_my_mind', 'other')),
  CHECK ((state = 'abandoned') = (abandon_reason IS NOT NULL)),

  -- THE CLOSED REASON, MASTER-SPEC 3.5's five. Same required-iff pattern as
  -- abandon_reason above. Closed-state copy is written with care elsewhere
  -- (RUN-FINISH.md phase 4: "never a red REJECTED"); this column only names
  -- the fact, the wording lives in the page that renders it.
  closed_reason text
                CHECK (closed_reason IN ('accepted', 'withdrawn', 'rejected', 'no_answer', 'presumed_closed')),
  CHECK ((state = 'closed') = (closed_reason IS NOT NULL)),

  -- offered_comp, MASTER-SPEC 3.5's last line: "stored against the posting's
  -- posted range: the posted-vs-offered delta. No fetched competitor
  -- captures this." Free text, matching data.ts's Job.comp_posted, which is
  -- also free text (an employer's own range, in their own words); a numeric
  -- column here would force parsing a figure this table has no business
  -- normalising, the same reasoning comp_range in data.ts already gives for
  -- keeping comp_posted as prose and treating a parsed number as a second,
  -- separate fact. The posted range itself is not duplicated onto this row:
  -- it is read from the sweep by job_id at render time, so the two numbers
  -- being compared can never drift into two different copies of the same
  -- fact. Private in the same sense the rest of this table is: it belongs
  -- to this person's row, filtered by user_id, nowhere aggregated.
  offered_comp  text CHECK (length(offered_comp) <= 200),

  -- resume render id / cover render id, named in MASTER-SPEC 3.5's
  -- reference list. Left typed but unconstrained (no foreign key) because
  -- this repository has no render-persistence table yet: src/lib/tailor.ts
  -- computes a Render value and nothing today writes one to a row with an
  -- id. These columns exist so a later task that adds that table changes
  -- one ALTER (add the FK) rather than adding the columns from nothing;
  -- until then the application layer simply does not populate them.
  resume_render_id text,
  cover_render_id  text,

  -- TIMESTAMPS THE CONFIRM LOOP RUNS ON (F4.1).
  --
  -- clicked_at: when the outbound click happened, and also the JD
  -- snapshot's own capture instant (see the snapshot fields' comment
  -- above for why this is one column and not two).
  clicked_at    timestamptz NOT NULL DEFAULT now(),
  -- confirmed_at: when the person answered a confirm-loop prompt, through
  -- any of F4.1's three channels (return-to-tab, next-visit, or the weekly
  -- digest). NULL means the card has never been resolved. src/lib/desk.ts's
  -- shouldSelfArchive() reads this column's absence, not the state column,
  -- because 'still_working' is itself a real answer to the prompt and must
  -- not keep counting toward the 14 days once the person has given it.
  confirmed_at  timestamptz,
  -- archived_at: F4.1's 14-day self-archive, "REVERSIBLE... labeled
  -- 'never confirmed'". A nullable timestamp rather than a boolean flag or
  -- a deleted row, on purpose: archiving is setting this column, and
  -- reversing it is clearing this column back to NULL. There is no DELETE
  -- anywhere in this table's story for a self-archived card; the row is
  -- the same row before and after, which is what makes the reversal free.
  archived_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every board view, table view, and confirm-loop sweep this feature needs
-- filters by user_id first; nothing here queries across people.
CREATE INDEX IF NOT EXISTS desk_application_user_idx
  ON desk_application (user_id);

-- The confirm loop's own queries: "this person's cards still waiting on a
-- resolution" is confirmed_at IS NULL, and the self-archive job additionally
-- filters on archived_at IS NULL. Partial, because most rows will settle
-- into confirmed, non-archived states over time and this index only needs
-- to stay small for the ones still in flight.
CREATE INDEX IF NOT EXISTS desk_application_unconfirmed_idx
  ON desk_application (user_id, clicked_at)
  WHERE confirmed_at IS NULL AND archived_at IS NULL;

-- The nightly fate-overlay job's own query: every application pointing at
-- one of our own postings, to join back against the published sweep and
-- kill files. Partial because external-URL applications (external_url IS
-- NOT NULL, job_id NULL) have no overlay to compute and should never be
-- scanned by this job.
CREATE INDEX IF NOT EXISTS desk_application_job_idx
  ON desk_application (job_id)
  WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION desk_application_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS desk_application_touch_trigger ON desk_application;
CREATE TRIGGER desk_application_touch_trigger
  BEFORE UPDATE ON desk_application
  FOR EACH ROW EXECUTE FUNCTION desk_application_touch();
