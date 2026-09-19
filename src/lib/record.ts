/**
 * record.ts: the shape of a Profile Record (MASTER-SPEC 3.2) and the rules
 * that govern it. No database access in this file, on purpose, in the same
 * spirit as entitlement.ts and account.ts: this is what lets the immutable
 * core, the id sequence, the visibility rule, and validation all be tested
 * with no connection string, which matters here specifically because a
 * connection string is the one thing this repository will not let a worker
 * open. The impure half (querying db/004_profile_record.sql's tables) lives
 * elsewhere, later, and reads this file rather than reimplementing it.
 *
 * ONE RULE THIS FILE ENFORCES THAT IS EASY TO MISS ON A SKIM: there is no
 * skill tag, no endorsement, and no aggregation anywhere below. MASTER-SPEC
 * lists `skill` as an entry kind precisely because a skill is a written
 * claim a person makes about themselves in their own words, not a short
 * label with a count next to it. ProfileEntry is the same shape for a skill
 * as for a role held or a degree; nothing in this file counts entries,
 * groups them by kind, or ranks them. If a future change to this file makes
 * a tag cloud or an endorsement count easy to bolt on, that change is wrong,
 * not this comment.
 */

/* -------------------------------------------------------------------------
   The domains. CHECK constraints in the database, plain arrays here, for the
   same reason db/001 gives for using CHECK over a Postgres enum: the next
   value is one entry in one array, not a heavier type change.
   ------------------------------------------------------------------------- */

export const ENTRY_KINDS = ['role_held', 'education', 'project', 'skill', 'artifact', 'recognition'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * The kinds an entry may carry no start date for. A role, a degree and a
 * project each happened in a year the person can name; a skill, an artifact
 * or a piece of recognition often has none written anywhere (a skills line,
 * a certification with no year), and insisting on one only invites an
 * invented one. Mirrors db/204_dateless_entries.sql's CHECK, which is the
 * backstop; this array is what validateEntry() reads.
 */
export const START_OPTIONAL_KINDS = ['skill', 'artifact', 'recognition'] as const;

/** True when validateEntry() insists on a start date for this kind. An
    unrecognised kind reads as required, the stricter reading, though it is
    already an issue of its own by then. */
export function startRequiredFor(kind: unknown): boolean {
  return !(START_OPTIONAL_KINDS as readonly unknown[]).includes(kind);
}

export const CLASSIFICATIONS = ['public', 'unlisted', 'private'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * 'employer_said' is a real value in the domain and nothing in this run
 * writes it (an offer-letter upload or similar employer-side confirmation
 * is out of scope per MASTER-SPEC 3.2). It is listed here anyway, rather
 * than left out and added later, so the type that will eventually carry it
 * already exists and this file's own validation (below) is the one place
 * that currently refuses it.
 */
export const PROVENANCES = ['you_told_us', 'employer_said'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const ARTIFACT_KINDS = ['live_url', 'repo', 'case_study', 'file'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/* -------------------------------------------------------------------------
   The shape.
   ------------------------------------------------------------------------- */

/**
 * A date known to the month, or only to the year. Not a single `Date` or
 * ISO string: see db/004_profile_record.sql's start_year/start_month
 * columns for why. A person who says "I started there in 2019" told us a
 * year, not a day, and a type that can only represent a full date forces
 * every caller to either invent a day or smuggle "unknown" through some
 * other channel (a magic day-of-month, a separate boolean). `month: null`
 * says the same thing this file's other absences say: not missing, known
 * precisely to be no more precise than this.
 */
export interface EntryDate {
  year: number;
  month: number | null;
}

export interface ProfileArtifact {
  kind: ArtifactKind;
  url: string;
  label: string | null;
}

/**
 * One fact in the record. Matches db/004_profile_record.sql's record_entry
 * columns field for field, with two differences that are both about shape,
 * not content: `start`/`end` bundle the SQL table's four separate
 * year/month columns into one EntryDate each, and `artifacts` is the
 * record_artifact rows for this entry, joined in, because nothing that
 * calls coreOf() or visibleTo() needs to know those live in a second table.
 */
export interface ProfileEntry {
  /** PRF-nnnn. Stable, unique per person, never reused. See nextPrfId(). */
  prfId: string;
  kind: EntryKind;
  /** null for a kind that names no organization (a personal project, a
      skill claimed in the person's own words). Required by validateEntry()
      for 'role_held' and 'education', matching the database CHECK. */
  employerOrInstitution: string | null;
  officialTitle: string;
  /** null for a skill, an artifact or a recognition the person gave no date
      for (a skills line on a resume, a certification with no year). A real
      state, not a missing value, the same way a null `end` is. Required by
      validateEntry() for 'role_held', 'education' and 'project', matching
      the CHECK db/204_dateless_entries.sql keys on kind. */
  start: EntryDate | null;
  /** null means "still there": a role still held, a degree still in
      progress. A real state, not a missing value; see the column comment
      on end_year in db/004_profile_record.sql. */
  end: EntryDate | null;
  location: string | null;
  description: string;
  classification: Classification;
  provenance: Provenance;
  artifacts: readonly ProfileArtifact[];
}

/* -------------------------------------------------------------------------
   The immutable core.
   ------------------------------------------------------------------------- */

/**
 * The field names that may never be altered by any render. Data, not prose,
 * so src/lib/record.test.ts and the provenance gate MASTER-SPEC F2's
 * done-when line names ("immutability enforced by test") can both read the
 * same list instead of one of them drifting from a sentence in a comment.
 */
export const IMMUTABLE_CORE_FIELDS = ['employerOrInstitution', 'officialTitle', 'start', 'end'] as const;
export type ImmutableCoreField = (typeof IMMUTABLE_CORE_FIELDS)[number];

export type ImmutableCore = Pick<ProfileEntry, ImmutableCoreField>;

/** Just the immutable core of an entry, in the shape coreMatches() compares. */
export function coreOf(entry: ProfileEntry): ImmutableCore {
  return {
    employerOrInstitution: entry.employerOrInstitution,
    officialTitle: entry.officialTitle,
    start: entry.start,
    end: entry.end
  };
}

function datesMatch(a: EntryDate | null, b: EntryDate | null): boolean {
  if (a === null || b === null) return a === b;
  return a.year === b.year && a.month === b.month;
}

/**
 * Byte-identical comparison of two cores. MASTER-SPEC 3.3's acceptance line
 * is "byte-identical to the record everywhere they appear", and this
 * function is written to match that word for word: plain `===` on every
 * string field, nothing normalised, nothing trimmed, nothing case-folded.
 * A comparison that forgives a trailing space or a smart quote swapped for
 * a straight one is a comparison that would let a render quietly change a
 * title and still pass, which is the one failure this function exists to
 * catch. See record.test.ts for the specific cases (trailing space, case,
 * smart quote, em dash) this is written against.
 */
export function coreMatches(a: ImmutableCore, b: ImmutableCore): boolean {
  return (
    a.employerOrInstitution === b.employerOrInstitution &&
    a.officialTitle === b.officialTitle &&
    datesMatch(a.start, b.start) &&
    datesMatch(a.end, b.end)
  );
}

/* -------------------------------------------------------------------------
   The id sequence.
   ------------------------------------------------------------------------- */

const PRF_ID_PATTERN = /^PRF-(\d{4,6})$/;

/**
 * The next PRF-nnnn for a person, given every id they have ever been
 * assigned.
 *
 * STRICTLY max(existing) + 1. NEVER FILLS A GAP. If a person's highest id
 * was PRF-0003 and that entry is later deleted, the next id issued must
 * still be PRF-0004, not a reused PRF-0003: an id that comes back refers to
 * two different facts over time, and every render that ever cited PRF-0003
 * (a downloaded resume, a saved cover letter, a link someone else was sent)
 * becomes ambiguous about which fact it meant. Filling the lowest open gap
 * is the natural first instinct for "the next number" and is exactly the
 * bug this function exists not to have.
 *
 * THE CONTRACT ON `existing`: it must be every id this person has ever
 * held, not merely the ids of entries that still exist. This function has
 * no database access and cannot itself tell "never issued" apart from
 * "issued, then deleted"; that distinction has to survive in whatever the
 * caller passes in (a soft delete, a separate ledger of issued ids, or
 * simply never removing the row are all ways to preserve it). This file
 * only promises it will never choose a number at or below the highest one
 * it was shown; keeping deleted ids visible to that call is the I/O layer's
 * job, not this one's.
 */
export function nextPrfId(existing: readonly string[]): string {
  let highest = 0;
  for (const id of existing) {
    const match = PRF_ID_PATTERN.exec(id);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > highest) highest = n;
  }
  const next = highest + 1;
  // THE CEILING IS THE SCHEMA'S, NOT AN OPINION. db/004_profile_record.sql
  // constrains prf_id to '^PRF-[0-9]{4,6}$', so 999999 is the last id this
  // format can express. Past it, an unpadded seven digit id would be generated
  // here, accepted by nobody, and rejected by the database as a check
  // constraint violation: an error naming a regex, thrown at insert time, to a
  // person who typed nothing wrong. Refusing here instead says which of the two
  // files has to change and keeps the pair honest about agreeing. Nothing
  // reaches this: it is a million entries for one person. It is written because
  // a function that can generate a value its own schema rejects is a
  // disagreement between two files that both claim to be the rule.
  if (next > 999999) {
    throw new Error(
      `record: PRF ids are exhausted for this person at ${highest}. ` +
        `db/004_profile_record.sql constrains prf_id to PRF- plus four to six digits, ` +
        `so widening the format means changing that constraint and this function together.`
    );
  }
  return `PRF-${String(next).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------
   Visibility.
   ------------------------------------------------------------------------- */

/**
 * Who is asking. Two values exist in this run: the owner, and everyone
 * else. RUN-MASTER amendment 6 locks public profile visibility off
 * entirely, so there is no third, 'public', audience yet; adding one later
 * is a new entry in this array plus a new case in visibleTo()'s switch, not
 * a rewrite of either.
 */
export const AUDIENCES = ['owner', 'other'] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * The per-entry visibility rule.
 *
 * The owner always sees their own entry regardless of classification.
 * Everyone else sees nothing in this run, regardless of classification
 * either: amendment 6 locks public profile visibility off entirely, so even
 * a 'public' entry is not shown to a non-owner today. The switch below
 * still names every classification value explicitly rather than collapsing
 * the 'other' branch to one `return false`, because the reason for that
 * blanket denial is different per value (a 'private' entry stays denied
 * forever; a 'public' one is denied only because the audience does not
 * exist yet) and a future change enabling public visibility should have to
 * touch this switch and make that decision on purpose. The `_exhaustive`
 * check below is what makes "on purpose" enforced rather than hoped for: a
 * new classification value added to CLASSIFICATIONS without a matching case
 * here fails to compile.
 */
export function visibleTo(entry: Pick<ProfileEntry, 'classification'>, audience: Audience): boolean {
  if (audience === 'owner') return true;

  switch (entry.classification) {
    case 'public':
    case 'unlisted':
    case 'private':
      return false;
    default: {
      const _exhaustive: never = entry.classification;
      return _exhaustive;
    }
  }
}

/* -------------------------------------------------------------------------
   Validation.
   ------------------------------------------------------------------------- */

/**
 * The same ceilings db/004_profile_record.sql enforces with CHECK
 * constraints, restated here so untrusted input is rejected before it ever
 * reaches a query. The database stays the backstop, not the first line: if
 * this file and the schema ever drift, the schema still wins, but a person
 * gets a field-level error instead of a failed insert.
 */
export const CEILINGS = {
  employerOrInstitution: 200,
  officialTitle: 200,
  location: 200,
  description: 4000,
  artifactUrl: 2000,
  artifactLabel: 200
} as const;

export const YEAR_MIN = 1900;
export const YEAR_MAX = 2100;

export interface ValidationIssue {
  /** Dotted path to the offending field ('officialTitle', 'artifacts.0.url'),
      so the UI can put the message next to the field it belongs to. */
  field: string;
  message: string;
}

/** What validateEntry() returns to build a ProfileEntry: everything except
    prfId (assigned by nextPrfId(), never typed by a person) and provenance
    (always 'you_told_us' in this run; see PROVENANCES above). */
export type NewEntryInput = Omit<ProfileEntry, 'prfId' | 'provenance'>;

export type ValidationResult =
  | { ok: true; entry: NewEntryInput }
  | { ok: false; issues: ValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX;
}

function isMonth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12;
}

/**
 * Validates one EntryDate-shaped value. `field` is the dotted path used in
 * any issue this raises ('start' or 'end'). Returns the clean date, or
 * pushes issues onto `issues` and returns null; the caller decides what a
 * null date means (required for `start`, "still there" for a missing
 * `end`, which never reaches this function at all).
 */
function validateDate(value: unknown, field: string, issues: ValidationIssue[]): EntryDate | null {
  if (!isPlainObject(value)) {
    issues.push({ field, message: 'must be an object with a year and an optional month' });
    return null;
  }
  const { year, month } = value;
  if (!isYear(year)) {
    issues.push({ field: `${field}.year`, message: `must be a whole number between ${YEAR_MIN} and ${YEAR_MAX}` });
    return null;
  }
  if (month !== null && month !== undefined && !isMonth(month)) {
    issues.push({ field: `${field}.month`, message: 'must be a whole number between 1 and 12, or null' });
    return null;
  }
  return { year, month: month === undefined ? null : (month as number | null) };
}

function validateBoundedString(
  value: unknown,
  field: string,
  ceiling: number,
  required: boolean,
  issues: ValidationIssue[]
): string | null {
  if (value === null || value === undefined) {
    if (required) issues.push({ field, message: 'is required' });
    return null;
  }
  if (typeof value !== 'string') {
    issues.push({ field, message: 'must be a string' });
    return null;
  }
  if (value.length > ceiling) {
    issues.push({ field, message: `must be ${ceiling} characters or fewer` });
    return null;
  }
  return value;
}

function validateArtifact(value: unknown, index: number, issues: ValidationIssue[]): ProfileArtifact | null {
  const field = (suffix: string) => `artifacts.${index}.${suffix}`;
  if (!isPlainObject(value)) {
    issues.push({ field: `artifacts.${index}`, message: 'must be an object' });
    return null;
  }
  const before = issues.length;

  const kind = value.kind;
  if (!(ARTIFACT_KINDS as readonly unknown[]).includes(kind)) {
    issues.push({ field: field('kind'), message: `must be one of ${ARTIFACT_KINDS.join(', ')}` });
  }

  const url = validateBoundedString(value.url, field('url'), CEILINGS.artifactUrl, true, issues);
  const label = validateBoundedString(value.label, field('label'), CEILINGS.artifactLabel, false, issues);

  if (issues.length > before) return null;
  return { kind: kind as ArtifactKind, url: url as string, label };
}

/**
 * Untrusted input in, either a clean NewEntryInput or the full list of what
 * is wrong with it, in the shape the UI renders (field plus message). Never
 * throws for user error: a throw is for a bug in this code, not for a
 * person leaving a required field blank.
 *
 * `existingArtifactsAllowed` is not a parameter here on purpose: an entry
 * with no artifacts at all is valid (MASTER-SPEC does not require proof to
 * exist before a fact can be recorded), so an absent or empty `artifacts`
 * array validates to an empty array rather than an error.
 */
export function validateEntry(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ field: '(root)', message: 'must be an object' }] };
  }

  const kind = input.kind;
  if (!(ENTRY_KINDS as readonly unknown[]).includes(kind)) {
    issues.push({ field: 'kind', message: `must be one of ${ENTRY_KINDS.join(', ')}` });
  }

  const employerRequired = kind === 'role_held' || kind === 'education';
  const employerOrInstitution = validateBoundedString(
    input.employerOrInstitution,
    'employerOrInstitution',
    CEILINGS.employerOrInstitution,
    employerRequired,
    issues
  );

  const officialTitle = validateBoundedString(input.officialTitle, 'officialTitle', CEILINGS.officialTitle, true, issues);

  // A blank start is the shape both forms post for an empty year field
  // ({ year: undefined, month: ... }, see profile/entry.ts's
  // buildValidationInput) as well as the parser's plain null. For a role, a
  // degree or a project it is a missing required field; for a skill, an
  // artifact or a recognition it is a real state, "no date", stored as a NULL
  // start_year (db/204). A month with no year identifies nothing either way.
  const startBlank =
    input.start === null ||
    input.start === undefined ||
    (isPlainObject(input.start) && (input.start.year === null || input.start.year === undefined));
  const startMonthGiven = isPlainObject(input.start) && input.start.month !== null && input.start.month !== undefined;
  let start: EntryDate | null = null;
  if (startBlank && startRequiredFor(kind)) {
    issues.push({ field: 'start.year', message: 'is required for a role held, education, or a project' });
  } else if (startBlank && startMonthGiven) {
    issues.push({ field: 'start.year', message: 'is needed when a start month is given' });
  } else if (!startBlank) {
    start = validateDate(input.start, 'start', issues);
  }

  // Absent end means "still there" and is valid; it never reaches
  // validateDate() at all, matching the way db/004_profile_record.sql
  // treats a NULL end_year as a real state rather than a missing value.
  let end: EntryDate | null = null;
  if (input.end !== null && input.end !== undefined) {
    end = validateDate(input.end, 'end', issues);
  }
  if (start && end && end.year < start.year) {
    issues.push({ field: 'end', message: 'end year must not be before the start year' });
  }
  // An end with no start is not a range this record can print, and db/204's
  // CHECK refuses the row; said here first, on the field the person can fix.
  if (startBlank && !startRequiredFor(kind) && end !== null) {
    issues.push({ field: 'end', message: 'needs a start date' });
  }

  /*
   * A CORE FIELD IS STORED EXACTLY AS TYPED. NO SCAN, NO WARNING, NO REFUSAL.
   *
   * This file used to refuse a core field carrying a leading or trailing
   * space, and separately refuse one carrying an invisible or hostile
   * character (a zero-width space, a bidirectional override, a Unicode tag
   * character), reporting each as a validation issue rather than silently
   * cleaning it. Both rules are gone, on the owner's own directive
   * (RUN-FINISH.md section 2.2, quoted here so nobody rebuilds either rule
   * as a feature): "we are not the police. we will not create phantom text
   * like this. if people find a way to trick the system, great."
   *
   * The distinction that directive draws is between what THIS SITE
   * generates and what A PERSON puts in their own record. A stray space or
   * a hidden character in employerOrInstitution or officialTitle is the
   * person's own byte, typed or pasted into their own fact about their own
   * employer or title. Refusing it, however politely worded, is exactly
   * the kind of scan-and-warn-about-content 2.2 forbids: "nothing scans,
   * strips, rewrites, warns about, or refuses a document because of what
   * the person put in it."
   *
   * The invariant the old rules protected still holds without them:
   * nothing in this function transforms employerOrInstitution or
   * officialTitle on the way in (no `.trim()`, no character strip, no
   * normalisation, chained onto either field, above or anywhere else in
   * this file), so a leading space, a trailing space, or a hidden
   * character is stored and rendered byte-identical to what was typed.
   * That is honest, not a gap: the record says what the person wrote,
   * unedited, exactly as record.test.ts's own coreMatches() tests already
   * hold every other case to. Gate 8's assertion 3b is the successor
   * proof: it asserts validateEntry() ACCEPTS a core carrying this kind of
   * byte and returns it unchanged, the direct reversal of the refusal this
   * function used to perform.
   */

  const location = validateBoundedString(input.location, 'location', CEILINGS.location, false, issues);

  const description = validateBoundedString(
    input.description === undefined ? '' : input.description,
    'description',
    CEILINGS.description,
    false,
    issues
  );

  const classification = input.classification;
  if (!(CLASSIFICATIONS as readonly unknown[]).includes(classification)) {
    issues.push({ field: 'classification', message: `must be one of ${CLASSIFICATIONS.join(', ')}` });
  }

  const artifactsInput = input.artifacts === undefined ? [] : input.artifacts;
  const artifacts: ProfileArtifact[] = [];
  if (!Array.isArray(artifactsInput)) {
    issues.push({ field: 'artifacts', message: 'must be an array' });
  } else {
    artifactsInput.forEach((artifact, index) => {
      const validated = validateArtifact(artifact, index, issues);
      if (validated) artifacts.push(validated);
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    entry: {
      kind: kind as EntryKind,
      employerOrInstitution,
      officialTitle: officialTitle as string,
      start,
      end,
      location,
      description: (description ?? '') as string,
      classification: classification as Classification,
      artifacts
    }
  };
}
