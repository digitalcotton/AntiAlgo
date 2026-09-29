-- desk_posting_fetch carries the facts a posting states (2026-09-29).
--
-- WHY. A job on the board has a location, a remote flag, a posted date, a
-- department and a pay range (jobs.location, remote, published, department,
-- comp_posted, comp_min_k, comp_max_k). A job a member pasted had a title, a
-- company and a body. Same posting, same platform, read minutes apart, two
-- different shapes -- because board_build.py asks its adapters for those
-- fields and postfetch.py never did. The payloads always carried them. This
-- adds the columns so the reader has somewhere to put what it was already
-- being handed, and an added posting can render as the job listing it is.
--
-- NAMED AFTER THE BOARD, NOT AFTER THIS TABLE. Every column below matches its
-- opposite number on `jobs` in name, type and unit (comp_*_k are thousands),
-- so the two can be read side by side and a view over both does not need a
-- translation layer. comp_mid_k and priced are NOT here: on `jobs` they are
-- stored, here they are arithmetic on min/max and are derived where shown,
-- because a stored copy of a derived value can disagree with its own inputs.
--
-- WHAT IS ABSENT ON PURPOSE. No derived_fam and no derived_tier: the standing
-- rule is that family and seniority are measured from upstream tags and never
-- parsed out of a title, and a pasted posting has no upstream tag. No days_up,
-- ghost, first_seen or last_seen either -- those are what watching a posting
-- over many nights reveals, not something one read can produce, which is what
-- the added-posting notice already tells the member.
--
-- Every column is nullable and NULL means "the source did not say". Existing
-- rows get NULL for all of them, which is true: they were read before the
-- reader asked.
ALTER TABLE desk_posting_fetch
  ADD COLUMN IF NOT EXISTS location        text    CHECK (length(location) <= 500),
  ADD COLUMN IF NOT EXISTS country         text    CHECK (length(country) <= 200),
  -- Three-valued on purpose: true, false, and "did not say". Collapsing NULL
  -- into false would invent an on-site claim the posting never made.
  ADD COLUMN IF NOT EXISTS remote          boolean,
  ADD COLUMN IF NOT EXISTS published       timestamptz,
  ADD COLUMN IF NOT EXISTS department      text    CHECK (length(department) <= 500),
  ADD COLUMN IF NOT EXISTS employment_type text    CHECK (length(employment_type) <= 200),
  -- The range in the source's own words. Kept verbatim because the caveats
  -- around a number change what the number means, and because a range we
  -- cannot parse is still worth showing a person.
  ADD COLUMN IF NOT EXISTS comp_posted     text    CHECK (length(comp_posted) <= 1000),
  -- Thousands, same unit as jobs.comp_min_k. Set only when comp_posted parsed
  -- unambiguously, so comp_posted WITHOUT these two is the normal, honest
  -- shape for a posting that says "competitive".
  ADD COLUMN IF NOT EXISTS comp_min_k      integer CHECK (comp_min_k >= 0 AND comp_min_k <= 100000),
  ADD COLUMN IF NOT EXISTS comp_max_k      integer CHECK (comp_max_k >= 0 AND comp_max_k <= 100000);

-- A range that runs backwards is a parse that went wrong, not a posting. Both
-- null, or both set the right way round; one without the other is refused.
ALTER TABLE desk_posting_fetch
  DROP CONSTRAINT IF EXISTS desk_posting_fetch_comp_range_check;
ALTER TABLE desk_posting_fetch
  ADD CONSTRAINT desk_posting_fetch_comp_range_check
  CHECK ((comp_min_k IS NULL) = (comp_max_k IS NULL)
         AND (comp_min_k IS NULL OR comp_min_k <= comp_max_k));
