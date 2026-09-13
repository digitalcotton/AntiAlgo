/**
 * hygiene.ts: THE GATE'S INSTRUMENT. Not a filter over anyone's document.
 *
 * RUN-FINISH.md section 2.2 replaced RUN-MASTER phase 3, addition (a2), the
 * old "EXPORT HYGIENE" covenant that had this file strip hidden text out of
 * every tailor output. The owner's own words, quoted here so nobody rebuilds
 * the old rule as a feature: "we are not the police. we will not create
 * phantom text like this. if people find a way to trick the system, great."
 *
 * THE RULE THIS FILE NOW SERVES HAS TWO HALVES, AND THE DISTANCE BETWEEN
 * THEM IS THE WHOLE POINT.
 *
 *   1. WE DO NOT GENERATE IT. Everything tailor.ts emits is visible plain
 *      text: no white on white, no zero-width characters, no off-screen
 *      positioning, no zero font size. That is a property of OUR OWN
 *      generator (deterministicProvider, buildSections(), summarizeTarget(),
 *      the literal template strings tailor.ts authors itself), and this
 *      file's functions are what test/gates/fabrication.mjs (gate 9) calls
 *      to verify it, by diffing a render's own output against the record,
 *      the target, and any voice sample it was built from: a hidden
 *      character with no source in one of those inputs was GENERATED, and
 *      that fails the gate. See fabrication.mjs's own header for the exact
 *      check.
 *   2. WE DO NOT POLICE THE PERSON. Nothing in this codebase scans, strips,
 *      rewrites, warns about, or refuses a document because of what a
 *      person put in it. tailor.ts no longer calls sanitizeExportText() on
 *      a bullet, a salutation, a closing, or a target's company and title;
 *      record.ts no longer calls detectHostileCharacters() to refuse a core
 *      field; voice.ts no longer strips a sample's content. The functions
 *      below still exist, and still work exactly as before, but their only
 *      caller left in this repository is a gate, run at build time against
 *      this repository's OWN generated output, never against a person's
 *      record, target, or voice sample as a live filter on what they wrote.
 *
 * This file is no longer on any path between what a person types and what
 * a render ships. It is a detector, kept here because gate 9 needs the
 * exact same code points and the exact same categories record.test.ts and
 * the old validateEntry() rule were already tested against, not a second,
 * drifting copy of the same list. No I/O, no network, no database, no
 * model: same spirit as record.ts and provider.ts, and for the same
 * reason, this is what lets the categories below be tested exhaustively
 * with nothing running.
 *
 * WHAT THIS FILE OPERATES ON, AND WHY THAT BOUNDS WHAT IT HAS TO CHECK
 * Every string this file ever receives is plain text: a joined bullet, a
 * salutation, a voice sample. Nothing in this codebase today turns a Render
 * (see tailor.ts) into HTML, PDF, or any format with an independent styling
 * channel; tailor.ts's own Bullet.text is a bare string, and RenderSection,
 * RenderEntry and the rest are plain data with no markup field anywhere.
 * That means several of RUN-MASTER's named threats are STRUCTURALLY
 * IMPOSSIBLE here, not merely unchecked, and this file says exactly which:
 *
 *   - white-on-white text (a colour set to match the background): requires
 *     an inline style or a CSS class this pipeline never emits. STRUCTURALLY
 *     IMPOSSIBLE. Not checked.
 *   - a zero or near-zero font size: same reasoning, no styling channel
 *     exists to carry a font size at all. STRUCTURALLY IMPOSSIBLE. Not
 *     checked.
 *   - `display:none` or `visibility:hidden`: same reasoning, no CSS
 *     property of any kind reaches this pipeline's output. STRUCTURALLY
 *     IMPOSSIBLE. Not checked.
 *   - off-screen positioning: same reasoning, no positioning property
 *     exists to set. STRUCTURALLY IMPOSSIBLE. Not checked.
 *
 * THE DAY THIS STOPS BEING TRUE: the first time a component renders a
 * Render into HTML, a PDF, or anything else with an independent styling
 * channel (an inline style attribute, a CSS class driven by data rather
 * than fixed markup, a rich text format), the reasoning above no longer
 * holds and this file's coverage becomes incomplete. That future renderer
 * must either escape everything it places into markup and apply no
 * data-driven styling at all, or gain its own check equivalent to this
 * one. Do not assume this file already covers that case: it does not, and
 * cannot, because the channel those threats need does not exist yet for it
 * to check.
 *
 * WHAT THIS FILE DOES CHECK: hidden text carried in the characters
 * themselves, independent of any styling channel. A zero-width space, a
 * bidirectional override, or a Unicode tag character reads as invisible (or
 * as reordered, misleading text) to a human in effectively any renderer,
 * plain text included, which is exactly why these are the categories worth
 * a covenant-level check in a pipeline that only ever emits plain text.
 *
 * WHY EVERY FORBIDDEN CHARACTER BELOW IS A CODE POINT, NEVER A LITERAL
 * Written as a numeric code point and assembled into a regular expression
 * with a `\u{...}` escape sequence inside a string, never typed as the
 * character itself. test/gates/copy.mjs (gate 3) hard fails on unusual
 * characters appearing literally in this repository's own source, and it
 * is right to: a hygiene file that carries the very bytes it exists to
 * catch, sitting in source control, is not a serious safeguard. See
 * copy.mjs's own BANNED_CHARACTERS array for the same discipline applied
 * to a different, smaller list.
 *
 * STRIPPED VERSUS REFUSED: THE DECISION, AND WHY
 * Both actions remove the offending characters from the text this function
 * returns. Neither one ever lets a matched character reach the caller: the
 * covenant is "never ships", not "ships with a warning attached", so
 * "refused" content is removed exactly as thoroughly as "stripped" content.
 * The difference between the two is what the finding reports, not what
 * happens to the bytes:
 *
 *   - STRIPPED marks a category with an ordinary, everyday explanation. A
 *     zero-width space or a stray control character overwhelmingly arrives
 *     from a paste out of a word processor, a chat app, or a PDF, not from
 *     anyone typing it on purpose. This file removes it and reports the
 *     removal as routine tidying, the same register record.ts's own
 *     validateEntry() and description field use for ordinary free text.
 *   - REFUSED marks a category with no honest, everyday explanation. A
 *     bidirectional override control or a Unicode tag character has no
 *     keyboard key, no IME, and no common paste path that produces one; the
 *     only way either appears in a writing sample or a record entry is
 *     because someone or something put it there on purpose, and the
 *     documented uses of both are hiding or disguising text. This file
 *     removes it and reports the removal at a severity that says so
 *     plainly, so the person is told something adversarial was present, not
 *     merely something untidy.
 *
 * WHY NEITHER ACTION THROWS. A thrown error would turn a single stray
 * character into a failed run with no result at all, which is a worse tool
 * for a gate than a clean removal it can diff against the original: the
 * gate wants to know exactly what was found and exactly what it would take
 * to make the text clean, not to have the whole check abort. This file
 * always returns cleaned text, and always reports what it removed. Nothing
 * here silently does either action: the returned `findings` array is the
 * record of what happened, always populated when anything was removed,
 * never elided.
 *
 * "STRIPPED" AND "REFUSED" ARE LABELS FOR A DETECTOR NOW, NOT VERBS THIS
 * FILE PERFORMS ON A PERSON'S DOCUMENT. They describe how forgivable each
 * category is (an accidental paste versus something with no honest input
 * path), which still matters for how a gate's own finding reads, but
 * neither label means this file edits anyone's content any more: see the
 * file header.
 */

/* -------------------------------------------------------------------------
   The categories.
   ------------------------------------------------------------------------- */

export const HYGIENE_ACTIONS = ['stripped', 'refused'] as const;
export type HygieneAction = (typeof HYGIENE_ACTIONS)[number];

interface HostileCategory {
  readonly id: string;
  readonly action: HygieneAction;
  readonly label: string;
  /** Inclusive [start, end] code point pairs. */
  readonly ranges: readonly (readonly [number, number])[];
  readonly reason: string;
}

/**
 * RUN-MASTER (a2)'s own list, at minimum: "zero-width, white-on-white, and
 * off-screen content." White-on-white and off-screen are addressed in the
 * file header above (structurally impossible here); zero-width and the
 * other invisible ranges below are addressed by code.
 */
const HOSTILE_CATEGORIES: readonly HostileCategory[] = [
  {
    id: 'zero_width_or_invisible',
    action: 'stripped',
    label: 'zero-width and invisible spacing characters',
    // U+200B-U+200F: zero-width space, zero-width non-joiner, zero-width
    // joiner, left-to-right mark, right-to-left mark.
    // U+2060-U+2064: word joiner, invisible function application, invisible
    // times, invisible separator, invisible plus.
    // U+FEFF: zero-width no-break space, also the UTF-8 byte order mark.
    ranges: [
      [0x200b, 0x200f],
      [0x2060, 0x2064],
      [0xfeff, 0xfeff]
    ],
    reason:
      'These overwhelmingly arrive from a paste out of a word processor, a chat app, or a PDF: a byte order mark left over from a saved file, a directional mark a phone keyboard inserted, a word joiner nobody meant to type. Stripped as routine tidying, the same way an accidental leading space in free text is tidied elsewhere in this codebase.'
  },
  {
    id: 'control_characters',
    action: 'stripped',
    label: 'control characters',
    // C0 controls other than tab (U+0009), line feed (U+000A) and carriage
    // return (U+000D), plus DEL and the C1 control block.
    ranges: [
      [0x00, 0x08],
      [0x0b, 0x0c],
      [0x0e, 0x1f],
      [0x7f, 0x9f]
    ],
    reason:
      'Ordinary whitespace (tab, line feed, carriage return) is left alone. Everything else in this range has no honest reason to appear in prose and typically arrives from a mis-decoded file or a corrupted paste. Stripped as routine cleanup.'
  },
  {
    id: 'bidi_override',
    action: 'refused',
    label: 'bidirectional override controls',
    // U+202A-U+202E: left-to-right embedding, right-to-left embedding, pop
    // directional formatting, left-to-right override, right-to-left
    // override.
    ranges: [[0x202a, 0x202e]],
    reason:
      'These exist to visually reorder the characters that follow them. No keyboard, no input method, and no ordinary paste path produces one; the "right to left override" trick for disguising a file name or a sentence is a documented attack technique built entirely out of this range. Presence here can only be deliberate.'
  },
  {
    id: 'unicode_tag_characters',
    action: 'refused',
    label: 'Unicode tag characters',
    // U+E0000-U+E007F: the tag block, originally meant to carry region and
    // variant data on an emoji sequence.
    ranges: [[0xe0000, 0xe007f]],
    reason:
      'Invisible by design and outside anything a person types with a keyboard or an input method. Documented uses outside their narrow emoji-tagging purpose are for hiding instructions inside text that looks empty to a human reader. Presence in a writing sample or a rendered document can only be deliberate.'
  }
];

/* -------------------------------------------------------------------------
   Building the regular expressions. Every code point below is a number;
   the escape sequence is assembled into a string at run time, so no source
   line in this file ever holds one of these characters literally.
   ------------------------------------------------------------------------- */

function codePointEscape(codePoint: number): string {
  return '\\u{' + codePoint.toString(16) + '}';
}

function categoryPattern(category: HostileCategory): RegExp {
  const body = category.ranges
    .map(([start, end]) => `${codePointEscape(start)}-${codePointEscape(end)}`)
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

/* -------------------------------------------------------------------------
   The result shape. Always reports what happened; never a silent strip or
   a silent refusal.
   ------------------------------------------------------------------------- */

export interface HygieneFinding {
  readonly action: HygieneAction;
  readonly category: string;
  readonly count: number;
  readonly message: string;
}

export interface HygieneResult {
  readonly text: string;
  readonly findings: readonly HygieneFinding[];
  /** True only when nothing was found. A caller can use this instead of
      checking findings.length itself; both say the same thing. */
  readonly clean: boolean;
}

/** Aggregated across a whole render, so a caller has one flag and one list
    to check rather than reducing over every bullet itself. */
export interface HygieneSummary {
  readonly clean: boolean;
  readonly findings: readonly HygieneFinding[];
}

export const EMPTY_HYGIENE_SUMMARY: HygieneSummary = { clean: true, findings: [] };

function buildMessage(category: HostileCategory, count: number): string {
  const occurrences = count === 1 ? '1 occurrence' : `${count} occurrences`;
  const verb = category.action === 'stripped' ? 'Stripped' : 'Refused';
  return `${verb} ${occurrences} of ${category.label}. ${category.reason}`;
}

/**
 * THE GATE'S DETECTOR, BUILT ON REMOVAL. Nothing in the application calls
 * this any more (see the file header): its only caller left in this
 * repository is test/gates/fabrication.mjs, which uses the fact that
 * running a render's own flattened text through this function and getting
 * a different string back means something in that text was hidden, to
 * verify our own generator never introduces such a thing. Removes every
 * character in every category above, wherever it appears in `input`, and
 * reports what it removed. Never throws: see the file header for why.
 *
 * Idempotent: running the result back through this function again finds
 * nothing (each category's pattern is a global match against the whole
 * string, so the first pass already removed every occurrence) and returns
 * `clean: true`. See hygiene.test.ts's idempotency test.
 */
export function sanitizeExportText(input: string): HygieneResult {
  let text = input;
  const findings: HygieneFinding[] = [];

  for (const category of HOSTILE_CATEGORIES) {
    const pattern = categoryPattern(category);
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      text = text.replace(pattern, '');
      findings.push({
        action: category.action,
        category: category.id,
        count: matches.length,
        message: buildMessage(category, matches.length)
      });
    }
  }

  return { text, findings, clean: findings.length === 0 };
}

/**
 * Folds one string's HygieneResult into a running HygieneSummary. tailor.ts
 * no longer calls this (renders carry no `hygiene` field any more; see the
 * file header), but a caller checking several strings from one source, a
 * gate scanning several fields of one input, for instance, still wants one
 * combined summary rather than a separate result per string, so the
 * function stays.
 */
export function foldHygiene(summary: HygieneSummary, result: HygieneResult): HygieneSummary {
  if (result.findings.length === 0) return summary;
  return { clean: false, findings: [...summary.findings, ...result.findings] };
}

/**
 * REPORTS WITHOUT STRIPPING. Same categories, same ranges, same findings
 * shape as sanitizeExportText() above, the one difference being that this
 * function never touches `input`.
 *
 * record.ts and tailor.ts do not call this any more: record.ts's
 * validateEntry() used to call it on employerOrInstitution and
 * officialTitle to refuse an entry carrying a hostile character, and
 * tailor.ts used to call it to decide whether to leave a stored entry off
 * a render. Both calls were removed per RUN-FINISH 2.2 (see the file
 * header): a core field is stored and rendered exactly as typed, hostile
 * character or not, and nothing refuses it. Its only caller left in this
 * repository is test/gates/fabrication.mjs, which needs to know a category
 * is present in a piece of text (a record field, a target field, a voice
 * sample) without touching that text, the same "look, do not touch"
 * property that made it useful before, now used to build the input side of
 * the gate's traceability check rather than to refuse a person's entry.
 *
 * Deliberately not built on top of sanitizeExportText() (running it and
 * throwing the cleaned text away): that would still require constructing
 * a new string via `.replace()` no caller ever uses, which is needless
 * work for a function whose entire point is "look, do not touch".
 */
export function detectHostileCharacters(input: string): readonly HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const category of HOSTILE_CATEGORIES) {
    const pattern = categoryPattern(category);
    const matches = input.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({
        action: category.action,
        category: category.id,
        count: matches.length,
        message: buildMessage(category, matches.length)
      });
    }
  }
  return findings;
}
