-- 004_profile_record.sql
--
-- The Profile Record: the single source of truth about one person's
-- professional facts (MASTER-SPEC 3.2). Two tables. record_entry holds the
-- facts themselves: a role held, a degree, a project, a skill claimed in the
-- person's own words, a standalone artifact, or a piece of recognition.
-- record_artifact holds the links that back an entry up: a live URL, a repo,
-- a case study, a file.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

-- ---------------------------------------------------------------------------
-- record_entry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS record_entry (
  -- Matches Better Auth's user.id (text, not uuid). ON DELETE CASCADE for the
  -- same reason db/001 gives for app_user_profile: a record outliving its
  -- person is a fact attached to nobody, and the next account to reuse that
  -- id would inherit somebody else's employment history. Phase 1's account
  -- delete (src/lib/account.ts, PERSON_TABLES) relies on exactly this: it
  -- expects a row class it does not have to run a statement for, because
  -- Postgres already removed it the moment the user row went.
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- PRF-nnnn. UNIQUE PER PERSON, NOT GLOBALLY, AND THAT IS WHY IT SITS IN THE
  -- PRIMARY KEY RATHER THAN BEHIND A SEPARATE UNIQUE INDEX. A global unique
  -- constraint on prf_id alone would force every person on the site to share
  -- one numbering space, which means either a global sequence (contention on
  -- every insert, and a running count of total entries ever created leaking
  -- out through the id itself) or a coordination step this table has no
  -- reason to need: two different people's "PRF-0001" are two different
  -- facts and were never in competition for the number. Making the pair the
  -- primary key means Postgres enforces "unique per person" as the same
  -- constraint that already gives every row its identity, one mechanism
  -- instead of two, and src/lib/record.ts's nextPrfId() only ever has to
  -- reason about one person's ids because that is the only scope the
  -- database itself recognizes.
  --
  -- Format is enforced here too, not left to the application: 4 to 6 digits
  -- keeps the id short enough to type or paste (matching MASTER-SPEC's
  -- PRF-nnnn) while leaving six orders of magnitude of headroom past what
  -- any one person will ever hold, so nextPrfId() never has to fail closed
  -- for running out of room.
  prf_id        text NOT NULL CHECK (prf_id ~ '^PRF-[0-9]{4,6}$'),

  PRIMARY KEY (user_id, prf_id),

  -- CHECK rather than a Postgres enum, for the reason db/001 gives for tier:
  -- the next kind (or the next classification, below) is an ALTER of this
  -- constraint, not a heavier enum-type change.
  --
  -- 'artifact' is a claimed entry kind of its own, distinct from the
  -- record_artifact rows below, which are links attached to any entry
  -- regardless of kind. A standalone piece of work with no employer and no
  -- role behind it (an open-source library, a talk) is the fact; a link to
  -- it is evidence for the fact. They are not the same thing and do not
  -- share a table.
  kind          text NOT NULL
                CHECK (kind IN ('role_held', 'education', 'project', 'skill', 'artifact', 'recognition')),

  -- THE IMMUTABLE CORE, PART 1: employer or institution. Nullable at the
  -- column level because not every kind has one (a personal project or a
  -- skill claimed in the person's own words may name no organization at
  -- all), but the CHECK below makes it mandatory for the two kinds where an
  -- entry with no organization is not a verifiable fact: a role or a degree
  -- nobody could confirm against is not the kind of claim this record exists
  -- to hold.
  employer_or_institution text
                CHECK (length(employer_or_institution) <= 200),

  -- THE IMMUTABLE CORE, PART 2: the official title. Required for every kind,
  -- because every kind names something: a job title, a degree, a project
  -- name, a skill stated in the person's own words, an artifact's name, an
  -- award's name. This is the field a render may show beside a descriptive
  -- label but must never alter (MASTER-SPEC 3.2, 3.3's acceptance line).
  official_title text NOT NULL
                CHECK (length(official_title) <= 200),

  CHECK (kind NOT IN ('role_held', 'education') OR employer_or_institution IS NOT NULL),

  -- THE IMMUTABLE CORE, PART 3: the dates. Year and month kept as separate
  -- small integers rather than a single `date` column, on purpose. A `date`
  -- column demands a day, and a person telling us "I started there in March
  -- 2019" does not know a day, so storing one would fabricate a precision
  -- nobody gave us, which is exactly the kind of invented fact the
  -- provenance rule (observed_by_us, you_told_us, employer_said) exists to
  -- rule out. Year is required because every entry happened in some year the
  -- person can name; month is optional because not every person remembers
  -- or was ever told one.
  start_year    smallint NOT NULL
                CHECK (start_year BETWEEN 1900 AND 2100),
  start_month   smallint
                CHECK (start_month BETWEEN 1 AND 12),

  -- end_year absent is a real state, not a missing value: it means "still
  -- there" (a role still held, a degree still in progress). It is not a
  -- placeholder for data collection that has not happened yet; a NULL here
  -- is a render's cue to print "present", not a gap to chase down.
  --
  -- An end_year that IS present but no end_month means the same partial
  -- knowledge as the start: the person can name the year they left but not
  -- the month. end_month with no end_year makes no sense (a month of an
  -- unstated year identifies nothing) and the CHECK below rules it out.
  end_year      smallint
                CHECK (end_year BETWEEN 1900 AND 2100),
  end_month     smallint
                CHECK (end_month BETWEEN 1 AND 12),

  CHECK (end_month IS NULL OR end_year IS NOT NULL),
  CHECK (end_year IS NULL OR end_year >= start_year),

  location      text
                CHECK (length(location) <= 200),

  -- The free-text account of the entry, in the person's own words. This is
  -- also where a `skill` entry's substance lives: MASTER-SPEC is explicit
  -- that a skill is a written claim, not a tag, and carries no count and no
  -- endorsement. There is no separate skills table with a short name column
  -- and a counter next to it, because that shape is exactly what makes a tag
  -- cloud or an endorsement button easy to bolt on later. A skill entry is a
  -- row in this table like any other, described in a paragraph like any
  -- other, with nothing anywhere in this schema that counts or aggregates
  -- across rows.
  description   text NOT NULL DEFAULT ''
                CHECK (length(description) <= 4000),

  -- Per-entry visibility. CHECK rather than an enum for the same reason as
  -- kind. 'public' is a real value today even though RUN-MASTER amendment 6
  -- locks public profile visibility off entirely this run: the column holds
  -- the full domain now so that turning public visibility on later is a
  -- change to src/lib/record.ts's visibleTo(), not a migration.
  classification text NOT NULL DEFAULT 'private'
                CHECK (classification IN ('public', 'unlisted', 'private')),

  -- Always 'you_told_us' in this run: nothing in this migration or the run
  -- it belongs to writes 'employer_said' (an offer-letter upload or similar
  -- employer-side confirmation is out of scope per MASTER-SPEC 3.2). Both
  -- values are already named by the spec, so the CHECK admits both now
  -- rather than needing a second migration the day employer confirmation
  -- ships; the default carries the only value anything in this run can
  -- possibly write.
  provenance    text NOT NULL DEFAULT 'you_told_us'
                CHECK (provenance IN ('you_told_us', 'employer_said')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintained by the database, the same trigger pattern db/001
-- uses, for the reason it gives: a timestamp only some code paths update is
-- worse than none, because it looks authoritative.
CREATE OR REPLACE FUNCTION record_entry_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS record_entry_touch_trigger ON record_entry;
CREATE TRIGGER record_entry_touch_trigger
  BEFORE UPDATE ON record_entry
  FOR EACH ROW EXECUTE FUNCTION record_entry_touch();

-- ---------------------------------------------------------------------------
-- record_artifact
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS record_artifact (
  -- No extension needed for a surrogate key here (record_entry did not need
  -- one because its natural key already had to exist; an artifact has no
  -- natural key of its own). IDENTITY is built into Postgres since version
  -- 10 and needs no pgcrypto or uuid-ossp extension, unlike gen_random_uuid().
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The entry this artifact hangs off. A composite foreign key into
  -- record_entry's own primary key, ON DELETE CASCADE: an artifact outliving
  -- the entry it was evidence for is a link attached to nothing, the same
  -- failure db/001 names for a profile row outliving its user. There is no
  -- separate, direct foreign key to "user" here, deliberately: record_entry
  -- already cascades from user(id), so deleting a user removes every entry,
  -- which removes every artifact through this constraint, one hop at a
  -- time. A link that has to say which entry it backs up before it can say
  -- whose it is matches what an artifact actually is: evidence FOR a fact,
  -- not a fact on its own.
  entry_user_id text NOT NULL,
  entry_prf_id  text NOT NULL,
  FOREIGN KEY (entry_user_id, entry_prf_id)
    REFERENCES record_entry (user_id, prf_id) ON DELETE CASCADE,

  kind          text NOT NULL
                CHECK (kind IN ('live_url', 'repo', 'case_study', 'file')),

  -- The link itself. 2000 is well past any URL a browser or a storage
  -- provider will actually hand back; it exists to bound an attacker-typed
  -- string at the database rather than trusting every future writer to.
  url           text NOT NULL
                CHECK (length(url) <= 2000),

  -- What the person calls this link ("Live demo", "Case study writeup").
  -- Optional: the kind alone is already a usable label.
  label         text
                CHECK (length(label) <= 200),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Postgres does not index foreign key columns automatically. Every artifact
-- lookup this feature has (show the artifacts for one entry) filters on
-- this pair, so it gets the index the primary key does not give it for free.
CREATE INDEX IF NOT EXISTS record_artifact_entry_idx
  ON record_artifact (entry_user_id, entry_prf_id);

CREATE OR REPLACE FUNCTION record_artifact_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS record_artifact_touch_trigger ON record_artifact;
CREATE TRIGGER record_artifact_touch_trigger
  BEFORE UPDATE ON record_artifact
  FOR EACH ROW EXECUTE FUNCTION record_artifact_touch();
