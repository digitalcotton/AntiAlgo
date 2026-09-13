/**
 * record-import.ts: MASTER-SPEC F2's import boost, the pure half.
 *
 * "Import boost: paste an existing resume, the engine PROPOSES entries, the
 * person confirms each (proposals are drafts, never auto-facts; you_told_us
 * requires the telling)." That parenthesis is the whole design. Nothing
 * this file produces is a ProfileEntry. It is a PROPOSAL: a candidate entry
 * this file believes validateEntry() would accept, plus, for every field it
 * filled, the exact span of the input that field came from. A person reads
 * that span, decides whether the parser read it correctly, and checks a box
 * that this file never checks for them. See src/pages/profile.astro and
 * src/pages/profile/import.ts for the two halves of that: the review screen
 * that shows a proposal with nothing preselected, and the endpoint that
 * re-validates the round trip as untrusted input, exactly as
 * record-store.ts's createEntry() does for a form typed by hand.
 *
 * NO I/O, NO DATABASE, NO NETWORK, NO LANGUAGE MODEL. One string in, one
 * ImportResult out, same input always the same output, in the same spirit
 * as record.ts's own header. RUN-MASTER's autonomy rules (section 3) say a
 * generative rephrase ships flag-dark when no LLM access pattern exists in
 * this repository, and none does: this parser reads line shapes, date
 * patterns and the common resume conventions listed below, and nothing
 * cleverer. A proposal is allowed to be wrong, because a person reads it
 * before it becomes anything; what it must never do is claim confidence it
 * does not have.
 *
 * THE ONE RULE EVERY FUNCTION BELOW ANSWERS TO: never invent. No skill
 * inferred from a job title, no seniority inferred from a date range, no
 * employer inferred from an email address, no month inferred from a season
 * or a quarter. A field this parser cannot read with confidence is left
 * empty (or, when the schema has no "empty" for it, the whole block is left
 * unproposed) rather than filled with a plausible guess. See parseDateToken
 * below for the concrete case record.ts's own header calls out: "2019"
 * gives a year and no month, and a parser that fills in January has
 * fabricated a fact.
 *
 * THE IMMUTABLE CORE IS NEVER TRANSFORMED, ONLY READ. employerOrInstitution,
 * officialTitle and the two dates are record.ts's IMMUTABLE_CORE_FIELDS,
 * and nothing below trims, case folds or otherwise cleans one on its way
 * into a proposal, even where it would be easy to (a resume line's own
 * whitespace, a form field round-tripped through the confirm step).
 * Recognising a value while scanning the input is fine (a lookup is
 * trimmed to test it, a token is trimmed to see whether it parses as a
 * date); the value actually assigned to a core field never is. A core
 * field with stray whitespace reaches validateEntry() exactly as it
 * appeared and comes back as an issue the person sees and fixes
 * themselves; this file does not repair it for them. See
 * candidateInputFromFields() and parseEmployerLine() below for the two
 * places this is easiest to get backwards.
 *
 * WHY THIS FILE NEVER PROPOSES A KIND OTHER THAN 'role_held'. Telling a
 * role held apart from education, a project, a skill claimed in the
 * person's own words, or a piece of recognition, from formatting alone,
 * is exactly the kind of inference this file refuses to make elsewhere
 * (compare: no seniority inferred from a date range). A resume convention
 * that reliably marks a block as a degree does not exist across resumes in
 * general, and a wrongly kinded proposal is not "a proposal a person
 * corrects," it is a plausible-looking wrong fact sitting in a field the
 * person may not think to check. Every proposal below defaults to
 * 'role_held' and the review screen renders the kind as an ordinary,
 * editable field like any other; nothing about it is presented as read
 * from the input, because it was not.
 */
import {
  validateEntry,
  YEAR_MIN,
  YEAR_MAX,
  type EntryDate,
  type NewEntryInput
} from './record';

/* -------------------------------------------------------------------------
   The span. Every field a proposal fills carries one of these back to the
   input, so a review screen never has to take this file's word for it.
   ------------------------------------------------------------------------- */

export interface ImportSpan {
  /** 0-based character offset into the original input where this span
      starts. */
  start: number;
  /** 0-based character offset into the original input where this span
      ends, exclusive. */
  end: number;
  /** 1-based line number the span starts on. Line 1 is the first line of
      the input, matching how a person reading their own paste back would
      count lines, not how the offsets count characters. */
  line: number;
  /** The exact substring of the input this span covers, sliced once here
      rather than left for the caller to re-derive from start/end: a
      second slicing site is a second place the "exact span" promise could
      quietly drift from what start/end actually point at. */
  text: string;
}

/** One field a proposal filled, and the span it read that field from.
    `field` matches validateEntry()'s own ValidationIssue.field vocabulary
    wherever the two shapes line up ('officialTitle', 'employerOrInstitution',
    'location', 'start', 'end', 'description'), so a review screen already
    built to look up an issue by field name can look up a reading the same
    way. A field this parser filled with a default rather than something it
    read (kind, classification; see this file's header) carries no reading:
    its absence here is the record of "not read from the input," not an
    oversight. */
export interface FieldReading {
  field: string;
  span: ImportSpan;
}

/**
 * One candidate entry this parser is offering, never a fact. `candidate` is
 * always the output of a validateEntry() call this file already ran and
 * that already came back ok: see the header on why a proposal the record
 * would refuse never reaches the caller.
 */
export interface ImportProposal {
  /** Position of this proposal within this parse run, 0-based. Not a
      database id: nothing here is ever persisted (see this file's header
      and record.astro/import.ts for where the "never persisted" promise is
      kept), so a stable id would name something that does not exist
      between one paste and the next. The review screen addresses each
      proposal by this index within the one form it builds from a single
      parse result. */
  index: number;
  /** What this proposal would create, exactly as record-store.ts's
      createEntry() would receive it, if and only if a person confirms it. */
  candidate: NewEntryInput;
  /** One entry per field this parser read with enough confidence to fill,
      each carrying the exact span it came from. */
  readings: FieldReading[];
}

export interface ImportResult {
  proposals: ImportProposal[];
  /** Plain sentences about the parse run as a whole: why nothing was
      recognised, how many blocks of text did not match a shape this parser
      reads. Never a substitute for `readings`; those are per field, these
      are about the paste overall. Empty when every block that looked like
      an entry became a proposal. */
  notes: string[];
}

/* -------------------------------------------------------------------------
   Lines, with their offsets kept, because every span this file returns is
   built from these.
   ------------------------------------------------------------------------- */

interface InputLine {
  text: string;
  start: number;
  end: number;
  lineNumber: number;
}

function splitLines(input: string): InputLine[] {
  const lines: InputLine[] = [];
  const breakPattern = /\r\n|\r|\n/g;
  let cursor = 0;
  let lineNumber = 1;
  let match: RegExpExecArray | null;
  while ((match = breakPattern.exec(input)) !== null) {
    lines.push({ text: input.slice(cursor, match.index), start: cursor, end: match.index, lineNumber });
    cursor = match.index + match[0].length;
    lineNumber++;
  }
  lines.push({ text: input.slice(cursor), start: cursor, end: input.length, lineNumber });
  return lines;
}

/** Groups lines into blocks separated by one or more blank (all whitespace)
    lines. A resume paste's usual shape: one block per role or entry, a
    blank line between them. A block with no blank line ever near it (a
    single unbroken paste) is still exactly one block; this function makes
    no assumption about how many there are. */
function groupBlocks(lines: InputLine[]): InputLine[][] {
  const blocks: InputLine[][] = [];
  let current: InputLine[] = [];
  for (const line of lines) {
    if (line.text.trim() === '') {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function spanForLine(line: InputLine): ImportSpan {
  return { start: line.start, end: line.end, line: line.lineNumber, text: line.text };
}

function spanForLines(input: string, first: InputLine, last: InputLine): ImportSpan {
  return { start: first.start, end: last.end, line: first.lineNumber, text: input.slice(first.start, last.end) };
}

/* -------------------------------------------------------------------------
   Dates. The one place this file is most tempted to guess, and the one
   place it least may.
   ------------------------------------------------------------------------- */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

/**
 * Words this parser reads as "still there": the role or degree has no end
 * date because it has not ended. Recognised, case insensitive, on the end
 * side of a date range only: present, current, currently, ongoing, now,
 * today. THIS LIST IS INCOMPLETE ON PURPOSE. It covers the common resume
 * vocabulary and nothing cleverer; a resume that phrases "still there" a
 * way this list does not know produces no proposal for that block rather
 * than a guess at either an end date or "still there". Extending the list
 * is a one line change here, not a rewrite of the function that reads it.
 */
const ONGOING_WORDS = new Set(['present', 'current', 'currently', 'ongoing', 'now', 'today']);

const DATE_TOKEN_PATTERN = /^(?:([A-Za-z]+)\.?\s+)?(\d{4})$/;

/**
 * One side of a date range: an optional month word followed by a four
 * digit year, or a bare year. Returns null when the token is not shaped
 * like a date at all (no trailing four digit year), which is different
 * from returning a year with `month: null`: the second case is this parser
 * doing exactly what record.ts's own header asks for ("2019" is a year and
 * no month, not a fabricated January); the first case is this parser
 * refusing to call something a date that is not shaped like one.
 *
 * A leading word it does not recognise as a month name (a season, a
 * quarter, a typo) still yields the year, with `month: null`: the year is
 * genuinely there in the text, and refusing it because of the word beside
 * it would throw away a fact the parser can read cleanly. The month is
 * genuinely not there, in the only sense this file is willing to claim
 * "there": spelled out as a month.
 */
function parseDateToken(raw: string): EntryDate | null {
  const trimmed = raw.trim();
  const match = DATE_TOKEN_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, wordRaw, yearRaw] = match;
  const year = Number(yearRaw);
  if (year < YEAR_MIN || year > YEAR_MAX) return null;

  if (!wordRaw) return { year, month: null };

  const month = MONTH_NAMES[wordRaw.toLowerCase()];
  return { year, month: month ?? null };
}

interface ParsedDateRange {
  start: EntryDate;
  end: EntryDate | null;
}

// The dash characters are written as \u escapes, never as literal
// characters, matching the discipline test/gates/copy.mjs enforces on
// every file in this repository (see its own header): a plain hyphen, an
// en dash (\u2013) or an em dash (\u2014), each surrounded by whitespace,
// or the word "to". The pasted resume this reads is data, not authored
// copy, so a dash inside it is expected; one sitting as a literal
// character in this file's own source is not, which is exactly what the
// escape avoids.
const RANGE_SEPARATOR = /\s(-|\u2013|\u2014|to)\s/i;

/**
 * A whole line read as a date range, or null when the line is not one.
 * Both sides have to resolve: the left side to a date (parseDateToken),
 * the right side to either a date or a recognised "still there" word. A
 * right side that is neither (garbled, or a phrase this parser's ongoing
 * word list does not know) means the line does not parse as a date range
 * at all, on purpose: this parser will not fabricate an end date, and it
 * will not fabricate "still there" either, so when it cannot tell the two
 * apart it treats the whole line, and the block it belongs to, as not
 * read. See this file's header on `end: null` being a real, claimed state,
 * never a default for "unknown".
 */
function parseDateRangeLine(line: string): ParsedDateRange | null {
  const trimmed = line.trim();
  const separator = RANGE_SEPARATOR.exec(trimmed);
  if (!separator) return null;

  const left = trimmed.slice(0, separator.index).trim();
  const right = trimmed.slice(separator.index + separator[0].length).trim();

  const start = parseDateToken(left);
  if (!start) return null;

  if (ONGOING_WORDS.has(right.toLowerCase())) {
    return { start, end: null };
  }

  const end = parseDateToken(right);
  if (!end) return null;

  return { start, end };
}

/* -------------------------------------------------------------------------
   Employer and location. One line, an optional separator.
   ------------------------------------------------------------------------- */

/**
 * Splits one line into an employer/institution and, if a separator is
 * present, a location. Recognises a pipe ("Acme Corp | Remote") ahead of a
 * comma ("Acme Corp, Remote"), because a pipe is written deliberately as a
 * field separator on a resume line where a comma much more often just
 * punctuates a place name ("Austin, TX") that this parser is not going to
 * split any further than "everything after the first comma". No separator
 * at all means the whole line is read as the employer and location is left
 * empty, never guessed at from, say, the line above or below it.
 *
 * employerOrInstitution IS PART OF THE IMMUTABLE CORE (record.ts's
 * IMMUTABLE_CORE_FIELDS), so the value returned here is never trimmed,
 * case folded or otherwise cleaned: it is exactly the substring that sat
 * on the employer's side of the line. What IS excluded is the separator's
 * own whitespace padding (" | ", ", "): that padding was typed as part of
 * the delimiter between two fields on one line, not as a character either
 * field claims, so PIPE_SEPARATOR/COMMA_SEPARATOR below match it together
 * with the pipe or comma itself, and the slice on either side of a match
 * never includes it. That is drawing the separator's own boundary
 * correctly, not a transform applied to a value after it is already cut
 * out; genuine whitespace elsewhere in the line (leading indentation, a
 * stray trailing space with no separator nearby) is left exactly as it
 * appeared and reaches validateEntry() unchanged, which is what surfaces
 * it to the person as something to fix, rather than this file silently
 * repairing it.
 */
const PIPE_SEPARATOR = /\s*\|\s*/;
const COMMA_SEPARATOR = /\s*,\s*/;

function parseEmployerLine(line: string): { employer: string; location: string | null } {
  const pipeMatch = PIPE_SEPARATOR.exec(line);
  if (pipeMatch) {
    const employer = line.slice(0, pipeMatch.index);
    const location = line.slice(pipeMatch.index + pipeMatch[0].length);
    return { employer, location: location === '' ? null : location };
  }

  const commaMatch = COMMA_SEPARATOR.exec(line);
  if (commaMatch) {
    const employer = line.slice(0, commaMatch.index);
    const location = line.slice(commaMatch.index + commaMatch[0].length);
    return { employer, location: location === '' ? null : location };
  }

  return { employer: line, location: null };
}

/* -------------------------------------------------------------------------
   One block, read as a candidate role, or not read at all.
   ------------------------------------------------------------------------- */

/**
 * The resume line shape this parser reads, and nothing more exotic:
 *
 *   Official title
 *   Employer or institution [| Location]
 *   Start date - End date (or a recognised "still there" word)
 *
 *   Description, one or more lines, everything after the date line.
 *
 * The description does not have to sit inside this same paragraph: a role
 * whose date line is the last line of its block, immediately followed
 * (after the blank line groupBlocks() split on) by one more block that is
 * not itself a role, is read as that block being the role's description
 * arriving after ordinary resume spacing. See parseResumeImport()'s own
 * `pending` handling for the one place that stitching happens; this
 * function only ever looks inside the one block it was given.
 *
 * The employer/location line is optional (a block with a title directly
 * above its date line is read with `employerOrInstitution: null`, which
 * validateEntry() will refuse for the default 'role_held' kind, correctly
 * producing no proposal rather than an invented employer). The description
 * is optional too. What is NOT optional is the date line: this function
 * searches every line after the title for the first one that
 * parseDateRangeLine() accepts, and a block with none produces no
 * proposal, full stop. A paragraph of prose, a section heading, a bare
 * list of skills: none of these contain a line shaped like a date range,
 * so none of them are read as an entry, which is exactly the "do not
 * invent a skill entry from a skill list" and "does not throw on
 * unstructured input" behaviour record-import.test.ts exercises.
 */
interface ReadBlockResult {
  proposal: ImportProposal | null;
  /** True when this block's date line was its last line: no description
      was found inside this block itself. parseResumeImport() uses this to
      decide whether the very next block, if it is not itself a role/date
      shape, is read as this role's description arriving after a blank
      line, which is common resume spacing. Meaningless when `proposal` is
      null. */
  endsAtDateLine: boolean;
}

function readBlock(input: string, block: InputLine[]): ReadBlockResult {
  const titleLine = block[0];
  const rest = block.slice(1);

  let dateLineIndex = -1;
  let parsedDate: ParsedDateRange | null = null;
  for (let i = 0; i < rest.length; i++) {
    const parsed = parseDateRangeLine(rest[i].text);
    if (parsed) {
      dateLineIndex = i;
      parsedDate = parsed;
      break;
    }
  }

  if (dateLineIndex === -1 || !parsedDate) {
    return { proposal: null, endsAtDateLine: false };
  }

  const dateLine = rest[dateLineIndex];
  const employerLines = rest.slice(0, dateLineIndex);
  const descriptionLines = rest.slice(dateLineIndex + 1);

  const readings: FieldReading[] = [];
  // officialTitle IS PART OF THE IMMUTABLE CORE (record.ts's
  // IMMUTABLE_CORE_FIELDS). titleLine.text is used exactly as it appears,
  // with no trim, case fold or other cleanup: any stray leading or
  // trailing whitespace in a person's own paste reaches validateEntry()
  // unchanged, which is what surfaces it to them as something to fix,
  // rather than this file quietly repairing their fact.
  const officialTitle = titleLine.text;
  readings.push({ field: 'officialTitle', span: spanForLine(titleLine) });

  let employerOrInstitution: string | null = null;
  let location: string | null = null;
  if (employerLines.length > 0) {
    // Only the line immediately above the date line is read for employer
    // and location. A resume that spreads that detail across several
    // lines is outside the shape this parser reads with confidence.
    const employerLine = employerLines[employerLines.length - 1];
    const parsedEmployer = parseEmployerLine(employerLine.text);
    // .trim() here only decides whether there is content to read at all
    // (RECOGNISING a value, which is fine); the value actually assigned
    // to employerOrInstitution below is parsedEmployer.employer itself,
    // untouched. See parseEmployerLine()'s own header.
    if (parsedEmployer.employer.trim() !== '') {
      employerOrInstitution = parsedEmployer.employer;
      readings.push({ field: 'employerOrInstitution', span: spanForLine(employerLine) });
    }
    if (parsedEmployer.location) {
      location = parsedEmployer.location;
      readings.push({ field: 'location', span: spanForLine(employerLine) });
    }
  }

  readings.push({ field: 'start', span: spanForLine(dateLine) });
  readings.push({ field: 'end', span: spanForLine(dateLine) });

  const description = descriptionLines
    .map((line) => line.text)
    .join('\n')
    .trim();
  if (description) {
    readings.push({
      field: 'description',
      span: spanForLines(input, descriptionLines[0], descriptionLines[descriptionLines.length - 1])
    });
  }

  // Not invented: 'role_held' is a default this file always offers, never a
  // reading of the text. See this file's header for why no kind other than
  // 'role_held' is ever proposed, and why 'kind' carries no FieldReading.
  const candidateInput: unknown = {
    kind: 'role_held',
    employerOrInstitution,
    officialTitle,
    start: parsedDate.start,
    end: parsedDate.end,
    location,
    description,
    // 'private' for the same reason: a default this file states plainly,
    // never a reading. record.astro's own add-entry form defaults new
    // entries to 'private' too, matching RUN-MASTER amendment 6's lock on
    // anything more visible.
    classification: 'private',
    artifacts: []
  };

  const validated = validateEntry(candidateInput);
  if (!validated.ok) {
    // A proposal the record would refuse (a title over CEILINGS.officialTitle,
    // a description over CEILINGS.description, a start year outside
    // YEAR_MIN/YEAR_MAX) never reaches the caller looking acceptable. See
    // this file's header.
    return { proposal: null, endsAtDateLine: false };
  }

  return {
    proposal: { index: -1, candidate: validated.entry, readings },
    endsAtDateLine: descriptionLines.length === 0
  };
}

/* -------------------------------------------------------------------------
   The entry point.
   ------------------------------------------------------------------------- */

/**
 * Reads one pasted string and returns every proposal this parser is
 * confident enough to offer. Never throws: a paste with no structure this
 * parser recognises is not this file's error to raise, it is simply a
 * paste with no proposals in it, which `notes` says plainly so the review
 * screen can say it plainly too.
 */
export function parseResumeImport(input: string): ImportResult {
  const notes: string[] = [];

  if (input.trim() === '') {
    notes.push('Nothing was pasted, so nothing was read.');
    return { proposals: [], notes };
  }

  const blocks = groupBlocks(splitLines(input));
  if (blocks.length === 0) {
    notes.push('Nothing was pasted, so nothing was read.');
    return { proposals: [], notes };
  }

  const proposals: ImportProposal[] = [];
  let skipped = 0;

  // A role's header (title, employer, date range) and its description are
  // very often written with a blank line between them, which groupBlocks()
  // above reads as two separate blocks. `pending` is the most recent block
  // that parsed as a role but had no description inside itself
  // (endsAtDateLine), held here for exactly one more block in case that
  // next block is the description arriving after that blank line, rather
  // than a new entry or something this parser does not read at all. Only
  // one continuation is ever accepted per role: this covers the common
  // "header, blank line, one paragraph of bullets" shape without also
  // risking an unrelated later section (a SKILLS heading, a second blank
  // line) being swallowed into an earlier role's description.
  let pending: ImportProposal | null = null;

  for (const block of blocks) {
    const read = readBlock(input, block);

    if (read.proposal) {
      if (pending) proposals.push({ ...pending, index: proposals.length });
      if (read.endsAtDateLine) {
        pending = read.proposal;
      } else {
        pending = null;
        proposals.push({ ...read.proposal, index: proposals.length });
      }
      continue;
    }

    if (pending) {
      const description = block.map((line) => line.text).join('\n').trim();
      const merged = { ...pending.candidate, description };
      const validated = validateEntry(merged);
      if (validated.ok) {
        proposals.push({
          index: proposals.length,
          candidate: validated.entry,
          readings: [
            ...pending.readings,
            { field: 'description', span: spanForLines(input, block[0], block[block.length - 1]) }
          ]
        });
      } else {
        // The continuation does not fit (most likely CEILINGS.description).
        // Proposing the role with its real description silently dropped,
        // or with a truncated one this parser would be choosing the cut
        // point for, is exactly the kind of guess this file refuses to
        // make; neither the role nor this block is proposed.
        skipped++;
      }
      pending = null;
      continue;
    }

    skipped++;
  }
  if (pending) proposals.push({ ...pending, index: proposals.length });

  if (proposals.length === 0) {
    notes.push(
      skipped > 0
        ? `${skipped} block${skipped === 1 ? '' : 's'} of pasted text did not match a title, employer or ` +
          'institution, and date range shape this parser reads. Nothing is proposed. Add entries by hand below.'
        : 'Nothing in the paste matched a shape this parser reads. Nothing is proposed. Add entries by hand below.'
    );
  } else if (skipped > 0) {
    notes.push(
      `${skipped} block${skipped === 1 ? '' : 's'} of the paste did not match a shape this parser reads and ` +
        'were left out. Add anything missing by hand below.'
    );
  }

  return { proposals, notes };
}

/* -------------------------------------------------------------------------
   The confirm step's field-to-input conversion.

   Factored here rather than duplicated in src/pages/profile/import.ts,
   matching the split record.ts/record-store.ts already draw this
   repository over: this file decides shape (pure, no I/O), import.ts does
   I/O and decides nothing about what a valid entry looks like. The shape
   read here is deliberately the same one profile/entry.ts's own
   (unexported) buildValidationInput() reads from its add/edit form, since
   the review screen's confirm form uses the same field vocabulary for the
   same reason: one set of inputs, one conversion, whether a person typed
   the values or a proposal pre-filled them and the person edited or
   accepted them.
   ------------------------------------------------------------------------- */

/** Every raw field the confirm step's per-proposal form group can submit. */
export interface ImportEntryFields {
  kind?: string;
  employerOrInstitution?: string;
  officialTitle?: string;
  startYear?: string;
  startMonth?: string;
  stillHere?: string;
  endYear?: string;
  endMonth?: string;
  location?: string;
  description?: string;
  classification?: string;
}

/**
 * Turns one proposal's round-tripped field strings into the shape
 * validateEntry() reads. Untrusted input in every sense record/entry.ts's
 * own buildValidationInput() already treats it as: this is a form field
 * that happens to have been pre-filled by a parser rather than typed from
 * nothing, and the confirm step re-validates it exactly as if a person had
 * typed every character themselves, per this file's header.
 */
export function candidateInputFromFields(fields: ImportEntryFields): unknown {
  const stillHere = fields.stillHere === 'on';

  const year = (raw: string | undefined): number | undefined => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  };
  const month = (raw: string | undefined): number | null => {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  };

  return {
    kind: fields.kind,
    // employerOrInstitution and officialTitle are both part of the
    // immutable core (record.ts's IMMUTABLE_CORE_FIELDS): neither is
    // trimmed, case folded or otherwise cleaned here. `|| null` only maps
    // "field absent" or "field submitted empty" to the null this shape
    // expects for "no employer"; it does not touch a non-empty value.
    // Whitespace inside a non-empty value (a proposal a person edited, or
    // one they left exactly as the parser proposed it) reaches
    // validateEntry() unchanged, which is what surfaces it to them as
    // something to fix, rather than this file silently repairing it.
    employerOrInstitution: fields.employerOrInstitution || null,
    officialTitle: fields.officialTitle,
    start: { year: year(fields.startYear), month: month(fields.startMonth) },
    end: stillHere ? null : { year: year(fields.endYear), month: month(fields.endMonth) },
    location: fields.location?.trim() || null,
    description: fields.description ?? '',
    classification: fields.classification,
    artifacts: []
  };
}
