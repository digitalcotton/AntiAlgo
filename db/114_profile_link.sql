-- 014_profile_link.sql
--
-- A person's own job-related links: the socials and sites a resume or a
-- profile carries at the top, above the roles. GitHub, LinkedIn, a portfolio,
-- Twitter/X, and the rest. These are identity, not evidence: unlike
-- record_artifact (db/004), which hangs one link off one entry as proof of
-- that entry, a profile link belongs to the person, not to any single role,
-- which is why it lives in its own table rather than as another artifact kind.
--
-- Many per person, no uniqueness: "multiple entry for URLs" was the whole ask,
-- so a person may list two portfolios, a personal site and a company one, as
-- many as they keep. The person curates the list themselves through add and
-- remove; nothing here dedupes for them.
--
-- One key point of care, the same one record_artifact's own url column has:
-- these URLs are rendered as href attributes on the profile page. The
-- application layer (src/lib/profile-links.ts's normaliseLinkUrl()) is what
-- refuses a non-http(s) scheme before a row is ever written, so a javascript:
-- or data: URL can never land here to be rendered back as a live link. This
-- CHECK is the database's own floor under that, a length cap only: scheme
-- validation needs a URL parser this migration does not have, and duplicating
-- half of it here in SQL would be a second, weaker copy to keep in sync.
CREATE TABLE IF NOT EXISTS profile_link (
  -- Not an identity column: the store mints the id itself (crypto.randomUUID())
  -- so a remove call can target one row by a stable, person-independent id,
  -- the same choice generated_render (db/012) made and for the same reason.
  id         text PRIMARY KEY,

  user_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- CHECK rather than a Postgres enum, the same reasoning db/001 gives for
  -- tier and db/007 restates for provider: the next platform is an ALTER of
  -- this constraint, not a heavier enum-type change. Kept in step with
  -- src/lib/profile-links.ts's LINK_PLATFORM_IDS, a hand-kept pair the same
  -- way db/007's provider CHECK and keychain.ts's PROVIDERS already are.
  platform   text NOT NULL CHECK (platform IN (
    'linkedin', 'github', 'twitter', 'bluesky', 'dribbble',
    'behance', 'mastodon', 'website', 'portfolio', 'other'
  )),

  url        text NOT NULL CHECK (char_length(url) <= 500),

  -- No updated_at and no touch trigger, unlike most tables here: a link is
  -- added or removed, never edited in place (to change one, a person removes
  -- it and adds the new one), so there is no update path for a timestamp to
  -- track and a column that only some code paths maintain is worse than none.
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The profile page's own read (src/lib/record-store.ts's listLinks()) and the
-- account-delete/export sweeps both look up by user_id.
CREATE INDEX IF NOT EXISTS profile_link_user_idx ON profile_link (user_id);
