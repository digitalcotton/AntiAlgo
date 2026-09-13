-- desk_posting_fetch: one row per "Add a posting" request (2026-09-10).
--
-- A member pastes a job posting URL on the Desk. The site records the
-- application card (desk_application, state 'clicked', external_url) and this
-- row, then wakes the Mac mini with the row's id and nothing else. The mini
-- claims the row, reads the posting, and posts back title, company and the
-- description as HTML. The site sanitises that, settles the row, fills the
-- application's null snapshot once, and drafts.
--
-- WHY A TABLE OF ITS OWN. The fetch has a lifecycle (pending, claimed, ready,
-- unreadable, pasted), its own clocks, a retry, and an HTML body at a cap far
-- above the snapshot's. desk_application is STM-0002's spine and db/006 says
-- its snapshot is one capture at one instant; a state machine hung off it
-- would bend that. Filling a null snapshot exactly once is the only touch.
--
-- WHAT THE MINI EVER SEES: id and url. Never user_id, never application_id.
-- The id is a random UUID minted in the application, so it carries nothing.
CREATE TABLE IF NOT EXISTS desk_posting_fetch (
  id               text PRIMARY KEY CHECK (length(id) <= 64),
  user_id          text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id   bigint NOT NULL UNIQUE REFERENCES desk_application(id) ON DELETE CASCADE,
  url              text NOT NULL CHECK (length(url) <= 2000),
  url_key          text NOT NULL CHECK (length(url_key) <= 2000),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'claimed', 'ready', 'unreadable', 'pasted')),
  -- Where the text came from, stated on every settled row and only there.
  origin           text CHECK (origin IN ('machine', 'pasted')),
  CHECK ((status IN ('ready', 'pasted')) = (origin IS NOT NULL)),
  source_kind      text CHECK (source_kind IN ('greenhouse', 'ashby', 'lever', 'workable', 'rippling',
                                               'workday', 'jsonld', 'page', 'pasted')),
  title            text CHECK (length(title) <= 500),
  company          text CHECK (length(company) <= 500),
  description_html text CHECK (length(description_html) <= 120000),
  final_url        text CHECK (length(final_url) <= 2000),
  http_status      integer,
  -- Our own codes, never a sentence the mini wrote. The site maps codes to copy.
  failure_code     text CHECK (failure_code IN ('refused_url', 'http_error', 'timeout', 'too_large',
                                                'not_html', 'no_content', 'fetch_error')),
  fetched_at       timestamptz,
  claimed_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS desk_posting_fetch_user_idx ON desk_posting_fetch (user_id);
CREATE INDEX IF NOT EXISTS desk_posting_fetch_open_idx ON desk_posting_fetch (created_at)
  WHERE status IN ('pending', 'claimed');
-- One in-flight request per URL per person; a double submit hits this, not a second fetch.
CREATE UNIQUE INDEX IF NOT EXISTS desk_posting_fetch_inflight_uidx ON desk_posting_fetch (user_id, url_key)
  WHERE status IN ('pending', 'claimed');

CREATE OR REPLACE FUNCTION desk_posting_fetch_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS desk_posting_fetch_touch_trigger ON desk_posting_fetch;
CREATE TRIGGER desk_posting_fetch_touch_trigger
  BEFORE UPDATE ON desk_posting_fetch
  FOR EACH ROW EXECUTE FUNCTION desk_posting_fetch_touch();

-- The snapshot cap, raised once, from 20000 to 40000 characters. A posting the
-- machine read in full is longer than the null a pasted URL used to leave. The
-- constraint was declared inline in db/006 with no name, so it is found by its
-- definition rather than assumed by name, the way db/026 could not.
DO $$
DECLARE
  con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'desk_application'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%snapshot_description%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE desk_application DROP CONSTRAINT %I', con);
  END IF;
END $$;
ALTER TABLE desk_application
  ADD CONSTRAINT desk_application_snapshot_description_check CHECK (length(snapshot_description) <= 40000);
