-- source_kind gains 'apple' (2026-09-29): jobs.apple.com draws its posting with
-- a script, so the server HTML carries only Apple's nav and footer and the
-- generic extractor came back 'no_content' on every Apple link a member pasted.
-- The posting itself is already in that first response, inside the React Router
-- hydration blob, so posting-resolvers.ts reads it there and reports this kind.
-- Counted apart from 'page' because it is a per-employer adapter, not the
-- generic read, and a change on Apple's side should be visible as this kind
-- going quiet rather than as a rise in unreadable pages.
-- The CHECK was declared inline in db/033 with no name and re-added by name in
-- db/135; it is found by its definition either way, the way db/135 found it.
DO $$
DECLARE
  con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'desk_posting_fetch'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%source_kind%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE desk_posting_fetch DROP CONSTRAINT %I', con);
  END IF;
END $$;
ALTER TABLE desk_posting_fetch
  ADD CONSTRAINT desk_posting_fetch_source_kind_check
  CHECK (source_kind IN ('greenhouse', 'ashby', 'lever', 'workable', 'rippling', 'workday',
                         'apple', 'jsonld', 'page', 'browser', 'pasted'));
