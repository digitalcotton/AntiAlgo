-- source_kind gains 'browser' (2026-09-11): a posting the mini could only read
-- by rendering the page in a headless browser, after the board APIs and the
-- server HTML gave nothing. Counted so the browser layer's worth can be judged
-- on numbers. The CHECK was declared inline in db/033 with no name, so it is
-- found by its definition, the way db/033 found the snapshot cap.
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
                         'jsonld', 'page', 'browser', 'pasted'));
