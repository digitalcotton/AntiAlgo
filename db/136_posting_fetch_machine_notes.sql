-- machine_notes (2026-09-11): what the mini reports about a read beyond the
-- text itself, so the posting's page can tell the person what the machine did
-- in plain words. Today it holds one key, `board`: the verdict of the board
-- learning pass (added, known, no-board, no-adapter, empty, off), the board's
-- name and system, and how many postings the first pull saw. jsonb rather
-- than columns because the shape belongs to the mini's report and will grow
-- with it; the site allowlists what it stores (src/lib/posting-fetch-store.ts)
-- and prints nothing it did not allowlist. NULL for every row settled before
-- this migration and for every unreadable or pasted row.
ALTER TABLE desk_posting_fetch
  ADD COLUMN IF NOT EXISTS machine_notes jsonb;
