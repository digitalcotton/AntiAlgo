/**
 * tailor.ts: the deterministic core of a resume or cover render.
 * MASTER-SPEC 3.3: "A render = a selection, ordering, and rephrasing of
 * Profile Record entries against one job." This file is that sentence,
 * written as code. No I/O, no network, no database, no model: same in the
 * same spirit as record.ts and entitlement.ts, and for the same reason,
 * this is what lets the rules below be tested exhaustively with nothing
 * running.
 *
 * DETERMINISTIC ONLY, THIS RUN. RUN-MASTER section 3 allows "tailor
 * rephrasing... deterministic-first (selection, ordering, templates) with
 * generative rephrase flag-dark if no LLM access pattern exists in the
 * repo," and none does. So selection here is by a fixed rubric
 * (relevanceScore, below), ordering is by that same score, and rephrasing
 * is templating (see provider.ts). A later, flagged addition may swap the
 * provider for a generative one; the facts a render may state are already
 * selected and locked from the record before that pass would ever run (see
 * provider.ts's file header), so plugging in a generative style pass later
 * changes phrasing, never facts.
 *
 * VOICE (RUN-MASTER PHASE 3, ADDITION A). A writing-voice sample reaches a
 * provider only through renderCover(), which hands it to
 * provider.styleLetter() and nowhere else. renderResume() never takes a voice
 * argument, and buildSections() (the resume's only path) has no parameter to
 * carry one, so a voice sample cannot reach a resume bullet at all. See
 * buildSections()'s and renderCover()'s own comments and voice.ts's file
 * header for the full containment argument.
 *
 * WE DO NOT GENERATE HIDDEN TEXT. WE DO NOT POLICE THE PERSON.
 * RUN-FINISH.md section 2.2 replaced the old EXPORT HYGIENE covenant
 * (RUN-MASTER phase 3, addition a2). The owner's own words: "we are not the
 * police. we will not create phantom text like this. if people find a way
 * to trick the system, great." This file used to run every bullet, a cover
 * render's salutation and closing, and a verified posting's own company
 * and title through hygiene.ts's sanitizeExportText() before shipping
 * them, refuse a record entry whose employer or title carried a hostile
 * character, and carry a `hygiene` field on every Render reporting what it
 * found. All three are gone.
 *
 *   - EVERY STRING THIS FILE SHIPS IS EITHER COPIED, VERBATIM, FROM
 *     SOMETHING THE PERSON OR AN EMPLOYER ALREADY WROTE (a record entry's
 *     own fields, a verified posting's own company and title, a free-text
 *     target's own text), OR IS A FIXED, LITERAL TEMPLATE STRING THIS FILE
 *     AUTHORS ITSELF ("Dear ", " team,", "Dear Hiring Team,", "Sincerely,").
 *     Nothing in this file ever composes a new byte out of anything a
 *     person could not already see in their own record or the posting they
 *     are applying to. That is what "we do not generate it" means as a
 *     property of THIS generator (deterministicProvider plus the plain
 *     templating below): it never introduces a hidden character, because it
 *     never introduces any character that was not already present in one
 *     of its inputs.
 *   - A hidden or invisible character already present in a record entry's
 *     own core, or in a verified posting's own company or title, is
 *     rendered and exported exactly as it arrived: no strip, no refusal, no
 *     entry silently left off a render. See hostileCoreRefusal() in this
 *     file's own git history for what "policing" used to look like here,
 *     and do not reintroduce it.
 *   - hygiene.ts still exists, repurposed: it is the instrument gate 9
 *     (test/gates/fabrication.mjs) uses to verify THIS file's own logic
 *     never introduces a hidden character with no source in the record, the
 *     target, or a voice sample. It is a check on the generator, run at
 *     build time by a gate, never a filter this file itself applies to a
 *     person's document. See hygiene.ts's own header.
 *
 * THE RULES FROM MASTER-SPEC 3.3, restated as what this file does about
 * each one:
 *   - "may compress, re-emphasise, and mirror the posting's vocabulary for
 *     skills that are already in the record": NOT IMPLEMENTED, on purpose,
 *     after review caught an earlier version of this file doing it unsafely.
 *     MASTER-SPEC 3.3 permits mirroring; MASTER-SPEC 3.2 separately says of
 *     employer, official title, and dates, "these render identically in
 *     every view. The tailor may never touch them." For a skill-kind entry,
 *     officialTitle IS the claimed skill name, so mirroring the posting's
 *     casing of it is touching it: a rendered claim that is sometimes the
 *     record's own bytes and sometimes a posting's is no longer the
 *     person's claim. When a permission and a prohibition collide on the
 *     same field, the prohibition wins. There is a second, independent
 *     reason this was never safe: a case-insensitive match is not a
 *     byte-for-byte equivalence (Unicode case folding is not always
 *     reversible; the Turkish dotted capital I folds to a two-codepoint
 *     sequence, not the plain letter a record might contain), so even a
 *     "same characters, different case" splice could import a byte the
 *     record never had. A skill's label is always `entry.officialTitle`,
 *     unmodified, wherever it renders. See tailor.test.ts's "a skill's
 *     rendered label is always the record's own officialTitle" tests.
 *   - "may add a descriptive title beside the official one, clearly
 *     labelled as descriptive": NOT IMPLEMENTED in this pass. RenderEntry
 *     reserves a `descriptiveTitle` field, always null today, rather than
 *     skip it silently, because inventing a labelling algorithm now with no
 *     spec for what "descriptive" means risks exactly the kind of
 *     unreviewed addition this file exists to refuse. See the DONE WHEN
 *     report for this stated as a gap, not glossed over.
 *   - "may NEVER add a skill, tool, employer, title, date, metric, or
 *     credential absent from the record": every Bullet's text is built only
 *     from fragmentsFor(), which reads only ProfileEntry fields and never
 *     the target's own text at all. See tailor.test.ts's "posting is data,
 *     never instructions" tests.
 *   - "the immutable core is emitted byte-identical": every RenderEntry's
 *     `core` is `coreOf(entry)` called directly, with no method chained onto
 *     employerOrInstitution, officialTitle, start, or end anywhere in this
 *     file. Gate 8 (test/gates/provenance.mjs) scans this file too.
 */

import {
  ENTRY_KINDS,
  coreOf,
  type EntryKind,
  type ImmutableCore,
  type ProfileEntry
} from './record';
import type { Job } from './data';
import {
  deterministicProvider,
  templateText,
  type LockedFactSet,
  type LockedFactSlot,
  type StyleProvider
} from './provider';
import { pairedFormFor } from './skill-aliases';
import type { VoiceSample } from './voice';
import { extractWords, plainTextFromHtml } from './vocabulary';
import { extractLetterTarget } from './posting-requirements';
import { detectSituation, packFor, type CoverField, type CoverSituation } from './cover-context';
import {
  buildLetterParagraphs,
  lockLetter,
  recordAllowlistText,
  summarizeLetterProvenance,
  type LetterParagraph,
  type LetterSelection
} from './cover-letter';
import type { LetterTarget } from './provider';

/* -------------------------------------------------------------------------
   Target: what a render is aimed at.
   ------------------------------------------------------------------------- */

export interface VerifiedPostingTarget {
  readonly kind: 'verified_posting';
  readonly job: Job;
}

/** A render against free text is legal, MASTER-SPEC 3.3's "freeform target
    allowed, labeled" state. See TargetSummary below for the label. */
export interface FreeTextTarget {
  readonly kind: 'free_text';
  readonly text: string;
}

export type Target = VerifiedPostingTarget | FreeTextTarget;

/** The whole of one person's Profile Record, as far as this file needs it:
    the entries. record.ts never names an aggregate type for "all of a
    person's entries" (see its own header on why it stays entry-shaped), so
    this alias exists here rather than in record.ts, purely so renderResume()
    and renderCover() have one name to write instead of the array type
    spelled out twice. */
export type ProfileRecord = readonly ProfileEntry[];

/* -------------------------------------------------------------------------
   Bullet: not constructible without its source ids.
   ------------------------------------------------------------------------- */

/**
 * A private, module-local symbol used to brand Bullet. TypeScript's object
 * types are structural: without this, any object literal with a `text` and
 * a non-empty `sourcePrfIds` would satisfy the Bullet type from any file,
 * whether or not it ever passed through createBullet()'s existence check
 * below. Because BULLET_BRAND is not exported, no file outside this module
 * can name it, so no file outside this module can write a value that is
 * structurally assignable to Bullet. createBullet() is the only place a
 * value carrying this property is ever produced.
 */
const BULLET_BRAND: unique symbol = Symbol('tailor.Bullet');

/**
 * One rendered line. Two things make a bullet without its provenance
 * unconstructible, one at compile time and one at run time:
 *
 *   1. `sourcePrfIds` is typed as a non-empty tuple, `readonly [string,
 *      ...string[]]`, not `readonly string[]`. `sourcePrfIds: []` is a type
 *      error wherever a Bullet is built; there is no code path in this file
 *      or any other that can quietly hand a bullet an empty id list, because
 *      the empty array does not type-check as this field to begin with.
 *   2. The BULLET_BRAND field (see above) means the only way to produce a
 *      value TypeScript accepts as a Bullet is to call createBullet(),
 *      which additionally checks every id in a non-empty (but possibly
 *      fabricated) tuple against the record actually being rendered, and
 *      throws if one does not resolve. A non-empty array of ids that do not
 *      exist still type-checks; the brand is what forces every Bullet
 *      through the one function that also checks existence.
 */
export interface Bullet {
  readonly text: string;
  readonly sourcePrfIds: readonly [string, ...string[]];
  readonly [BULLET_BRAND]: true;
}

/**
 * The only way to construct a Bullet. `knownPrfIds` is every PRF id that
 * exists in the record this render is being built from; every caller in
 * this file passes the same set, built once per render in buildSections().
 * A mismatch here means a bug in this file (a slot citing an id it should
 * never have been given), not a user-triggerable error, so this throws
 * rather than returning a result type: nothing about a person's own input
 * can reach this branch.
 */
function createBullet(
  text: string,
  sourcePrfIds: readonly [string, ...string[]],
  knownPrfIds: ReadonlySet<string>
): Bullet {
  for (const id of sourcePrfIds) {
    if (!knownPrfIds.has(id)) {
      throw new Error(
        `tailor: a bullet cited PRF id "${id}", which is not in the record it was rendered from. ` +
          'This is a bug in tailor.ts (a slot was built with an id that does not belong to the ' +
          'record being rendered), not something a person did.'
      );
    }
  }
  return { text, sourcePrfIds, [BULLET_BRAND]: true };
}

/* -------------------------------------------------------------------------
   Render shape.
   ------------------------------------------------------------------------- */

export interface RenderEntry {
  readonly prfId: string;
  readonly kind: EntryKind;
  /** coreOf(entry), verbatim. Byte-identical to the record; see coreMatches()
      in record.ts for how a test proves that. */
  readonly core: ImmutableCore;
  /** Reserved for MASTER-SPEC 3.3's labelled descriptive title. Always null
      in this pass; see the file header for why it is not implemented yet. */
  readonly descriptiveTitle: string | null;
  /** Zero or more. Zero is a real, honest state: the entry's core is still
      shown, and this file never invents filler text to avoid an empty
      bullets array. */
  readonly bullets: readonly Bullet[];
}

export interface RenderSection {
  readonly kind: EntryKind;
  readonly heading: string;
  readonly entries: readonly RenderEntry[];
}

/** The receipts footer, computed, never asserted: every PRF id that at
    least one bullet in this render actually cites, deduped and sorted so
    two renders of the same record and target produce the same array. */
export interface ProvenanceSummary {
  readonly citedPrfIds: readonly string[];
  readonly bulletCount: number;
}

/**
 * What a re-styling changed, DERIVED by byte-comparison and never narrated (the
 * confident-diff refusal this file's sharedVocabulary comment states). A KEPT
 * line is byte-identical to this file's own deterministic join of the record's
 * fragments, the person's own words; a REWROTE line is one a connected model
 * rephrased inside its locked slot (a resume line is only ever rephrased, never
 * re-facted, because the facts are locked before the style pass). mirroredTerms
 * are the posting's own terms paired onto a skill the record already holds
 * (skill-aliases.ts), the one honest "added for this posting" case. coreOnly
 * counts entries the two-page cap trimmed to their verbatim core with no bullet.
 * A deterministic (no-key) render is all KEPT by construction, which the room
 * says plainly rather than pretending a model touched anything.
 */
export interface ChangeRecord {
  readonly perEntry: readonly { readonly prfId: string; readonly verdict: 'KEPT' | 'REWROTE' }[];
  readonly counts: { readonly rewrote: number; readonly kept: number; readonly coreOnly: number };
  readonly mirroredTerms: readonly string[];
}

/** MASTER-SPEC's "gap report pattern applied to a person": when the record
    has too little to render, this names what is missing instead of the
    render padding itself out. Null when there is nothing to report. */
export interface GapReport {
  readonly missing: readonly string[];
}

/** A free-text target renders with `verified: false`; MASTER-SPEC 3.3's
    "freeform target allowed, labeled" state made structural: nothing reads
    a free-text render as verified, because the literal type of `verified`
    on that branch is `false`, not `boolean`. */
export type TargetSummary =
  | { readonly kind: 'verified_posting'; readonly verified: true; readonly jobId: string; readonly company: string; readonly title: string | null }
  | { readonly kind: 'free_text'; readonly verified: false; readonly text: string };

/** The person's own name, contact email, and job-related links, printed at
    the top of both documents. Boilerplate, not Bullets: the name, the email,
    and the links each cite no PRF id, so none can be a Bullet (see the
    salutation/closing precedent on CoverRender below, and Bullet above). It is
    assembled from data read outside this file (record-store.ts's personName(),
    listLinks(), and resolveResumeEmail()) and handed in as an argument, never
    built from the entries a render is made of, so it never passes through a
    StyleProvider's slots. The email is boilerplate on the same terms as the
    name and links: resolved outside this file by record-store.ts's
    resolveResumeEmail() and handed in, never read from the entries, so it never
    fills a StyleProvider slot either. */
export interface RenderHeader {
  readonly name: string | null;                 // "First Last", or null if the person has set no name
  readonly email: string | null;                // the contact address, or null if the person has none on file
  readonly links: readonly { readonly label: string; readonly url: string }[];
}

interface BaseRender {
  readonly target: TargetSummary;
  readonly sections: readonly RenderSection[];
  readonly provenance: ProvenanceSummary;
  readonly gaps: GapReport | null;
  /** Nullable and last so a payload stored before this field existed reads
      back as `header: undefined`, which every caller treats as "no header"
      exactly as they treat an explicit null; nothing re-validates a stored
      render (see draft/[id].astro), so an older jsonb row must not crash on
      read. Boilerplate, not Bullets: see RenderHeader above and the
      salutation/closing precedent on CoverRender below. */
  readonly header: RenderHeader | null;
  /** Nullable/optional and last, the same forward-compatible shape as `header`:
      a payload stored before this field existed reads back as undefined, which
      every reader treats as "no change record". Derived by byte-comparison in
      buildSections (resume) / the letter path (cover), never asserted. */
  readonly changeRecord?: ChangeRecord;
}

export interface ResumeRender extends BaseRender {
  readonly kind: 'resume';
}

export interface CoverRender extends BaseRender {
  readonly kind: 'cover';
  /** Boilerplate, not a Bullet: it cites no record fact, so it cannot be
      one (see Bullet above). Built only from the target's own public
      identity (a company name from a verified posting, or nothing from a
      free-text target), never from the record. */
  readonly salutation: string;
  readonly closing: string;
  /**
   * The letter itself: prose paragraphs, opener to close, styled from the
   * record and the posting (see cover-letter.ts). OPTIONAL AND LAST, the
   * `header` precedent on BaseRender: a row stored before this field existed
   * reads back with `paragraphs === undefined`, and every consumer treats
   * that as "a legacy cover, render its sections" (see DraftDocuments.astro
   * and pdf-resume.ts). `sections` still carries the record's cores for
   * provenance and the byte-identity gates, but a real cover never PRINTS
   * them; the paragraphs are the document.
   */
  readonly paragraphs?: readonly LetterParagraph[];
  /** The inputs this letter was drawn from, captured with the render: the
      person's reason (or null), the requirement lines the posting offered, and
      whether an uploaded letter retargeted it (adapt) or it was written fresh
      (create). Optional and last for the same round-trip reason as paragraphs.
      Feeds the "Draft again" prefill and the result page's note. */
  readonly letterInputs?: {
    readonly reason: string | null;
    readonly requirements: readonly string[];
    readonly mode: 'create' | 'adapt';
    /** The context pack this letter was written under (field x situation),
        captured for transparency and the "Draft again" prefill. */
    readonly context: { readonly field: CoverField; readonly situation: CoverSituation };
  };
}

/** The optional inputs renderCover() accepts beyond the record and target:
    the person's own reason for this company, used verbatim as the letter's
    opening anchor (never invented; see the file header and MASTER-SPEC 3.3's
    stated exception for a person's own free text). */
export interface CoverInputs {
  readonly reason?: string | null;
}

export type Render = ResumeRender | CoverRender;

/* -------------------------------------------------------------------------
   Section headings, in ENTRY_KINDS order (record.ts's own domain order),
   so adding a new EntryKind there is a compile error here until this map
   is extended to match, rather than a section silently rendering with no
   heading.
   ------------------------------------------------------------------------- */

// The resume section headings a reader (and an ATS parser) sees. These are the
// DISPLAY strings only: the grouping and every gate key off the entry KIND, not
// this text (resume-grouping.ts guards on section.kind === 'recognition'), so
// the names are chosen for ATS legibility. 'artifact' shows as Portfolio and
// 'recognition' as Awards, the labels ATS parsers key sections off far more
// reliably than the internal kind names.
const HEADINGS: Record<EntryKind, string> = {
  role_held: 'Experience',
  education: 'Education',
  project: 'Projects',
  skill: 'Skills',
  artifact: 'Portfolio',
  recognition: 'Awards'
};

/** The kinds that owe a description: a role, an education, or a project reads
    as thin without prose. A skill (its title IS the claim), a recognition (its
    title plus issuer are the whole fact), and an artifact (a link) render
    complete with no description, so an empty one is not a gap and the renderer
    shows no "no description" notice for them. */
export const DESCRIPTION_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['role_held', 'education', 'project']);

/* -------------------------------------------------------------------------
   Reading the target: text extraction and the word vocabulary used only
   for ordering (relevanceScore, below). Nothing pulled out of the target
   here is ever placed into a Bullet's text or a RenderEntry's core: this
   file does no vocabulary mirroring (see the file header for why).
   ------------------------------------------------------------------------- */

function rawTextFor(target: Target): string {
  if (target.kind === 'free_text') return target.text;
  const { job } = target;
  const body = job.description_html ? plainTextFromHtml(job.description_html) : '';
  return [job.title ?? '', job.company, body].join(' ');
}

function vocabularyFor(target: Target): ReadonlySet<string> {
  return extractWords(rawTextFor(target));
}

/**
 * The words one entry and one target actually share.
 *
 * EXPORTED FOR THE DIFF VIEW, AND EXPORTED RATHER THAN COPIED. The tailor page
 * shows a reader why the ordering came out as it did, and the honest answer is
 * the evidence rather than a narrative: these words, in both. Building that
 * needs the same stopword list and the same word extraction the ordering used,
 * and the page first got them by reproducing STOPWORDS and extractWords()
 * verbatim in its own file, because neither was exported.
 *
 * That is two copies of one rule, and this repository has already been bitten
 * by that shape more than once. Nothing would have noticed the day the scoring
 * changed here: the diff would have gone on confidently explaining an ordering
 * with the wrong evidence, and it would have looked exactly as correct as it
 * does now. So the seam is a function, not a pair of constants: the page asks
 * what was shared and never learns how sharing is decided.
 *
 * Sorted, so the same entry and target always list them in the same order and a
 * reader comparing two renders is not reading a reshuffle as a change.
 */
export function sharedVocabulary(entry: ProfileEntry, target: Target): readonly string[] {
  const vocabulary = vocabularyFor(target);
  const shared: string[] = [];
  for (const word of extractWords(`${entry.officialTitle} ${entry.employerOrInstitution ?? ''} ${entry.description}`)) {
    if (vocabulary.has(word)) shared.push(word);
  }
  return shared.sort();
}

/**
 * How much of `entry` overlaps the target's own vocabulary. A rubric, not a
 * model: pure word-set intersection, so the same entry against the same
 * target always scores the same, and ordering by this score is therefore
 * deterministic on its own, no tie-breaker magic required beyond the
 * explicit prfId tie-break in buildSections().
 */
function relevanceScore(entry: ProfileEntry, vocabulary: ReadonlySet<string>): number {
  // extractWords() lowercases its own argument internally (a transform on
  // its own local parameter, not on entry.officialTitle itself); the result
  // is a Set used only to count overlap for ordering, below. Nothing this
  // function returns is a string, so nothing it does can reach a render:
  // relevanceScore()'s only output is a number, compared to another number
  // in buildSections()'s sort comparator.
  const words = extractWords(`${entry.officialTitle} ${entry.employerOrInstitution ?? ''} ${entry.description}`);
  let score = 0;
  for (const w of words) {
    if (vocabulary.has(w)) score++;
  }
  return score;
}

/**
 * How strong an entry is as letter EVIDENCE, which is a different question from
 * how many posting keywords it happens to contain. The cover-letter rubric
 * scores a proof on outcomes with numbers and baselines, not on duties, so this
 * combines three things: the posting overlap NORMALIZED by length (so a long,
 * generic, keyword-dense entry does not beat a crisp on-point one), a bonus for
 * a quantified win (a digit or percent in the description), and a bonus for a
 * baseline ("from X", "X to Y"). Deterministic, a pure function of its inputs;
 * used to pick the proof and fit entries, never to reach a render as a string.
 */
function evidenceScore(entry: ProfileEntry, vocabulary: ReadonlySet<string>): number {
  // Evidence strength is about a quantified OUTCOME, not who the employer was,
  // so the employer name is deliberately NOT in this text: adding it would
  // dilute a crisp measured win under a longer, keyword-stuffed one. (Only
  // role/project entries with a real description reach this; recognition
  // entries are filtered out of letter evidence before ranking.)
  const words = extractWords(`${entry.officialTitle} ${entry.description}`);
  let overlap = 0;
  for (const w of words) if (vocabulary.has(w)) overlap += 1;
  const normalized = overlap / Math.sqrt(Math.max(1, words.size));
  const hasNumber = /\d/.test(entry.description) ? 0.75 : 0;
  const hasBaseline = /\bfrom\s+\d|\d[\d.,]*\s*(?:to|%|percent)\b/i.test(entry.description) ? 0.75 : 0;
  return normalized + hasNumber + hasBaseline;
}

/* -------------------------------------------------------------------------
   Selection: which fragments a slot for one entry carries, before any
   style pass sees them. This is the "facts... locked from the record
   before any style pass runs" step provider.ts's header describes.
   ------------------------------------------------------------------------- */

function fragmentsFor(entry: ProfileEntry): readonly string[] {
  // description is not core (see record.ts's IMMUTABLE_CORE_FIELDS): this
  // split/trim chain runs on the record's own free text, never on
  // employerOrInstitution, officialTitle, start, or end.
  const descriptionLines = entry.description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (entry.kind === 'skill') {
    // entry.officialTitle passed straight through, unmodified: for a
    // skill entry it IS the claimed skill name, immutable core, and every
    // place it renders carries the record's own bytes. There is no
    // vocabulary mirroring here or anywhere else in this file; see the
    // file header for why.
    return descriptionLines.length > 0 ? [entry.officialTitle, ...descriptionLines] : [entry.officialTitle];
  }

  // Every other kind renders its own description only. No fragment here is
  // ever drawn from officialTitle for a non-skill entry either: the
  // official title is core (rendered separately, verbatim, as
  // RenderEntry.core) and has no business being paraphrased into a
  // bullet's body text.
  return descriptionLines;
}

/**
 * A skill entry's fragments, with one paired mention appended when the posting
 * warrants it. RESUME-RULES.md layer 2's "mirror once", made a step: for a
 * skill the record holds whose curated acronym or long form the posting uses,
 * the skill's rendered line carries the record's own form with the paired form
 * once in parentheses ("Applicant Tracking System (ATS)"), so recruiter search
 * finds the term the posting used. skill-aliases.ts owns the decision and the
 * whole safety argument: the record's own bytes are never altered (only a
 * curated paired form is appended, and only to a skill the record already
 * holds), so this cannot introduce a skill, and the core rendered separately by
 * coreOf() stays byte-identical. Every non-skill kind, and any skill with no
 * warranted pairing, is returned exactly as fragmentsFor() built it.
 */
function mirroredFragmentsFor(entry: ProfileEntry, postingText: string): readonly string[] {
  const fragments = fragmentsFor(entry);
  if (entry.kind !== 'skill' || fragments.length === 0) return fragments;
  const paired = pairedFormFor(entry.officialTitle, postingText);
  if (paired === null) return fragments;
  // fragmentsFor() puts the skill's own name first for a skill slot; the paired
  // form rides on that first fragment and nowhere else, so the document carries
  // exactly one paired mention.
  const [first, ...rest] = fragments;
  return [`${first} (${paired})`, ...rest];
}

/* -------------------------------------------------------------------------
   The two-page cap, RESUME-RULES.md layer 2 ("length"). The model cannot see
   pages, so the working proxy is words: about 450 to a page, a two-page cap of
   about 900. The renderer owns real pagination; this only keeps the render from
   handing it far more than two pages of prose. The cap trims by relevance, not
   by record order: the most relevant entries keep their bullets, and the least
   relevant past the budget render core-only (title, employer, dates), which is
   the ordinary shape of a resume whose recent, relevant roles are detailed and
   whose older ones are a line each. Every entry still renders its core; the cap
   only decides which entries also carry bullets.
   ------------------------------------------------------------------------- */

const RENDER_PAGE_WORDS = 450;
const RENDER_MAX_PAGES = 2;
const RENDER_WORD_CAP = RENDER_PAGE_WORDS * RENDER_MAX_PAGES;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** The words a render spends on one entry's core line, whether or not its
    bullets survive the cap: the title, the employer, and a small fixed
    allowance for the dates and location that render beside them. A proxy, not a
    layout measurement (the renderer owns that); enough to keep the budget
    honest about the fixed cost of every entry that appears at all. */
function headerWordCount(entry: ProfileEntry): number {
  return wordCount(entry.officialTitle) + wordCount(entry.employerOrInstitution ?? '') + 2;
}

/**
 * The set of PRF ids whose bullets fit under the two-page word cap, chosen in
 * global relevance order (most relevant first, prfId to break a tie) across
 * every kind, not within one section. An entry keeps its bullets only while the
 * running word total, counting every entry's core line and the kept bullets,
 * stays under the cap; past it, an entry contributes only its core line's words
 * and its bullets are dropped. Deterministic: the order is a pure sort and the
 * word counts are pure functions of the fragments, so the same record and target
 * always keep the same set.
 */
function bulletsWithinWordCap(
  entries: ProfileRecord,
  fragmentsByPrfId: ReadonlyMap<string, readonly string[]>,
  vocabulary: ReadonlySet<string>
): ReadonlySet<string> {
  const globalOrder = [...entries].sort((a, b) => {
    const diff = relevanceScore(b, vocabulary) - relevanceScore(a, vocabulary);
    if (diff !== 0) return diff;
    return a.prfId < b.prfId ? -1 : a.prfId > b.prfId ? 1 : 0;
  });

  const keep = new Set<string>();
  let words = 0;
  for (const entry of globalOrder) {
    const header = headerWordCount(entry);
    const fragments = fragmentsByPrfId.get(entry.prfId) ?? [];
    if (fragments.length === 0) {
      // No bullet to keep or drop; the core line still costs its words.
      words += header;
      continue;
    }
    const bulletWords = wordCount(templateText(entry.kind, fragments));
    if (words + header + bulletWords <= RENDER_WORD_CAP) {
      keep.add(entry.prfId);
      words += header + bulletWords;
    } else {
      words += header;
    }
  }
  return keep;
}

/* -------------------------------------------------------------------------
   Building sections: selection, ordering, locking, then one style pass.
   ------------------------------------------------------------------------- */

/**
 * THE RESUME'S SECTION BUILDER, AND ONLY THE RESUME'S. It calls
 * `provider.style(locked)` with no voice argument at all: a writing-voice
 * sample cannot reach a resume bullet because this function, the only path to
 * one, has no channel to carry it. renderCover() no longer routes through
 * here; it builds its letter from provider.styleLetter() directly (see
 * renderCover below), so the voice sample reaches styleLetter() alone. This is
 * a stronger form of RUN-MASTER (a)'s "never resumes" than the old threaded
 * `voice` parameter was: containment by absence of a parameter, not by a
 * caller remembering to pass null. See voice.ts's file header.
 *
 * EVERY ENTRY RENDERS. There is no refusal path here any more: this
 * function used to leave an entry off the render entirely when its core
 * carried a hostile character (hostileCoreRefusal(), removed per
 * RUN-FINISH 2.2, "we do not police the person"). An entry with a fragment
 * to say gets a bullet; an entry with none gets none; every entry that
 * exists in `entries` gets a RenderEntry, always, core included, exactly as
 * stored.
 */
async function buildSections(
  entries: ProfileRecord,
  target: Target,
  provider: StyleProvider
): Promise<{ readonly sections: readonly RenderSection[]; readonly changeRecord: ChangeRecord }> {
  const vocabulary = vocabularyFor(target);
  const postingText = rawTextFor(target);
  const knownPrfIds = new Set(entries.map((e) => e.prfId));

  // Fragments per entry, computed once: a skill may carry one paired mention of
  // the posting's term for a skill the record holds (mirroredFragmentsFor), and
  // the same fragments feed both the word-cap budget below and the slots locked
  // for the one style() call, so the two can never disagree about what a bullet says.
  const fragmentsByPrfId = new Map<string, readonly string[]>();
  for (const entry of entries) {
    fragmentsByPrfId.set(entry.prfId, mirroredFragmentsFor(entry, postingText));
  }

  // Two-page cap: which entries keep their bullets, chosen by relevance across
  // every kind at once (see bulletsWithinWordCap). Entries past the budget still
  // render, core only.
  const keepBullets = bulletsWithinWordCap(entries, fragmentsByPrfId, vocabulary);

  // Lock EVERY kept entry's slot across all kinds into ONE set, then make ONE
  // style() call for the whole resume. This used to be one call per EntryKind,
  // up to six sequential provider calls, which is what timed a full record's
  // render out under the function's own duration cap (each call carried its own
  // timeout, and six of them in a row could not finish in the budget). The
  // styled results are keyed by slotId, so one call and six produce the same
  // render: the deterministic provider styles each slot independently either
  // way, and a generative provider's reply is read back by slotId, never by
  // position. A slot is built only for an entry the cap kept that has a fragment
  // to say; an entry with none, or one trimmed to core-only past the cap, gets
  // no slot and, below, no bullet.
  const slotsByPrfId = new Map<string, LockedFactSlot>();
  for (const entry of entries) {
    if (!keepBullets.has(entry.prfId)) continue;
    const fragments = fragmentsByPrfId.get(entry.prfId) ?? [];
    if (fragments.length === 0) continue;
    slotsByPrfId.set(entry.prfId, {
      slotId: `${entry.prfId}#0`,
      sourcePrfIds: [entry.prfId],
      kind: entry.kind,
      fragments
    });
  }

  const locked: LockedFactSet = { slots: [...slotsByPrfId.values()] };
  const styled = await provider.style(locked);
  const styledTextBySlotId = new Map(styled.styledSlots.map((s) => [s.slotId, s.text] as const));

  // Derived, never narrated (see ChangeRecord): a bullet whose final text equals
  // this file's own deterministic join is the person's own words (KEPT); one a
  // connected model rephrased inside its locked slot differs (REWROTE). An entry
  // with no bullet was trimmed to its verbatim core (coreOnly).
  const perEntry: { prfId: string; verdict: 'KEPT' | 'REWROTE' }[] = [];
  let coreOnly = 0;

  const sections: RenderSection[] = [];
  for (const kind of ENTRY_KINDS) {
    const ofKind = entries.filter((e) => e.kind === kind);
    if (ofKind.length === 0) continue;

    // Display order: reverse-chronological (byRecency), the resume convention.
    // Which of these entries kept their bullets was already decided by relevance
    // in bulletsWithinWordCap; the date order here only arranges what shows.
    const ordered = [...ofKind].sort(byRecency);

    const renderEntries: RenderEntry[] = ordered.map((entry) => {
      const slot = slotsByPrfId.get(entry.prfId);
      const bullets: Bullet[] = [];
      if (slot) {
        // A provider that returned nothing for a known slot, or returned an
        // empty string, falls back to this file's own deterministic join
        // (see provider.ts's templateText()). A Bullet with empty text is
        // never constructed: it would trace to a real record entry but say
        // nothing, which is a worse failure than a plain deterministic
        // sentence.
        const deterministic = templateText(slot.kind, slot.fragments);
        const styledText = styledTextBySlotId.get(slot.slotId);
        const text = styledText && styledText.trim().length > 0 ? styledText : deterministic;
        bullets.push(createBullet(text, slot.sourcePrfIds, knownPrfIds));
        perEntry.push({ prfId: entry.prfId, verdict: text === deterministic ? 'KEPT' : 'REWROTE' });
      } else {
        coreOnly++;
      }
      return {
        prfId: entry.prfId,
        kind: entry.kind,
        core: coreOf(entry),
        descriptiveTitle: null,
        bullets
      };
    });

    sections.push({ kind, heading: HEADINGS[kind], entries: renderEntries });
  }

  // The one honest "added for this posting": a skill the record already holds
  // whose curated paired form the posting uses (mirroredFragmentsFor above,
  // skill-aliases.ts). Collected from the kept skill slots, deduped; the
  // record's own bytes stay untouched, so this adds a term, never a skill.
  const mirroredTerms: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'skill' && slotsByPrfId.has(entry.prfId)) {
      const paired = pairedFormFor(entry.officialTitle, postingText);
      if (paired) mirroredTerms.push(paired);
    }
  }

  const changeRecord: ChangeRecord = {
    perEntry,
    counts: {
      rewrote: perEntry.filter((e) => e.verdict === 'REWROTE').length,
      kept: perEntry.filter((e) => e.verdict === 'KEPT').length,
      coreOnly
    },
    mirroredTerms: [...new Set(mirroredTerms)]
  };

  return { sections, changeRecord };
}

/**
 * TargetSummary's company and title are a verified posting's own text,
 * republished, not the person's claim and not part of the immutable core.
 * Passed straight through: no transform, no strip, per RUN-FINISH 2.2 (this
 * file's header). A free-text target's own `text` passes through the same
 * way, for the same reason: it is untrusted, externally supplied text this
 * document carries to a reader, labelled rather than hidden, and it is not
 * this file's place to edit it.
 */
function summarizeTarget(target: Target): TargetSummary {
  if (target.kind === 'verified_posting') {
    const { job } = target;
    return {
      kind: 'verified_posting',
      verified: true,
      jobId: job.id,
      company: job.company,
      title: job.title ?? null
    };
  }
  return { kind: 'free_text', verified: false, text: target.text };
}

function summarizeProvenance(sections: readonly RenderSection[]): ProvenanceSummary {
  const cited = new Set<string>();
  let bulletCount = 0;
  for (const section of sections) {
    for (const entry of section.entries) {
      for (const bullet of entry.bullets) {
        bulletCount++;
        for (const id of bullet.sourcePrfIds) cited.add(id);
      }
    }
  }
  return { citedPrfIds: [...cited].sort(), bulletCount };
}

/**
 * The gap report pattern applied to a person (MASTER-SPEC F3 states).
 * Returns null when the render has real content; otherwise names what is
 * missing instead of the render silently coming back thin or empty.
 */
function computeGaps(entries: ProfileRecord, sections: readonly RenderSection[]): GapReport | null {
  const missing: string[] = [];

  if (entries.length === 0) {
    missing.push(
      'The record has no entries yet. Add at least one role, education, project, or skill in the Profile Record editor before generating a render.'
    );
  } else {
    // A description is only expected of a role, an education, or a project. A
    // credential or a skill legitimately renders as a title and an issuer with
    // no prose, so it must not count toward "missing a description": a record
    // of only certifications is thin, not broken. Count bullets only on the
    // kinds that owe a description, and only warn when the person actually has
    // such an entry.
    const describable = sections.filter((section) => DESCRIPTION_KINDS.has(section.kind));
    const describableEntries = describable.reduce((n, section) => n + section.entries.length, 0);
    const describableBullets = describable.reduce(
      (sum, section) => sum + section.entries.reduce((n, entry) => n + entry.bullets.length, 0),
      0
    );
    if (describableEntries > 0 && describableBullets === 0) {
      missing.push(
        'Your roles, education, and projects are missing descriptions. Add detail to at least one so a render has more than a title and dates to show.'
      );
    }
  }

  return missing.length > 0 ? { missing } : null;
}

/**
 * The salutation ladder (cover-letter skill's salutation rule, minus the
 * named-person rung, which needs a source a posting does not reliably carry):
 * a verified posting in a tech or design field gets the warmer "Hi <Company>
 * team,"; a verified posting in any other field, and a free-text target with
 * no company to name, get "Dear Hiring Manager,". Never "To Whom It May
 * Concern." The company, when named, is the posting's own bytes, passed
 * through untouched exactly as before (see summarizeTarget and the file
 * header's RUN-FINISH 2.2 note).
 */
function salutationFor(target: Target, register: LetterTarget['register']): string {
  if (target.kind === 'verified_posting' && register === 'tech') {
    return `Hi ${target.job.company} team,`;
  }
  return 'Dear Hiring Manager,';
}

/* -------------------------------------------------------------------------
   Letter evidence selection: which entries the cover letter's proof and fit
   paragraphs are built from. tailor.ts owns this because it owns
   relevanceScore and the target vocabulary; cover-letter.ts turns the chosen
   entries into a LockedLetter (see its file header on why selection lives
   here, not there).
   ------------------------------------------------------------------------- */

/** Prefer an experience, then a project, then the rest; a skill is evidence of
    last resort for a letter's proof, since a skill rides the fit paragraph as a
    label. Lower rank sorts first. */
const EVIDENCE_KIND_RANK: Record<EntryKind, number> = {
  role_held: 0,
  project: 1,
  education: 2,
  artifact: 3,
  recognition: 4,
  skill: 5
};

function hasDescriptionLine(entry: ProfileEntry): boolean {
  return entry.description.split('\n').some((line) => line.trim().length > 0);
}

/** A core date as a comparable month index. Reads the core's own numbers only,
    no transform chained onto a core field (gate 8). A null month sorts as the
    start of its year. */
function monthIndexOf(date: { year: number; month: number | null }): number {
  return date.year * 12 + ((date.month ?? 1) - 1);
}

/**
 * Reverse-chronological order for a resume section, the convention
 * resume-drafting.md's skim theory rests on: an ongoing entry (no end date) is
 * the most recent, then by end date descending, then start date descending,
 * then prfId so the order is deterministic. This decides DISPLAY order only;
 * relevanceScore still decides which entries earn bullets under the two-page cap
 * (bulletsWithinWordCap), so the most relevant entries stay the detailed ones
 * while the section still reads newest-first.
 */
function byRecency(a: ProfileEntry, b: ProfileEntry): number {
  if (a.end === null && b.end !== null) return -1;
  if (a.end !== null && b.end === null) return 1;
  if (a.end !== null && b.end !== null) {
    const endDiff = monthIndexOf(b.end) - monthIndexOf(a.end);
    if (endDiff !== 0) return endDiff;
  }
  const startDiff = monthIndexOf(b.start) - monthIndexOf(a.start);
  if (startDiff !== 0) return startDiff;
  return a.prfId < b.prfId ? -1 : a.prfId > b.prfId ? 1 : 0;
}

/** The person's own words, as a vocabulary: every entry's title and
    description, tokenised the one way vocabulary.ts tokenises. This is what a
    posting line is scored against in posting-requirements.ts, so the
    requirements chosen are the ones this record can answer. */
function recordVocabularyOf(entries: ProfileRecord): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of entries) {
    for (const word of extractWords(`${entry.officialTitle} ${entry.employerOrInstitution ?? ''} ${entry.description}`)) set.add(word);
  }
  return set;
}

function selectLetterEvidence(
  entries: ProfileRecord,
  target: Target,
  vocabulary: ReadonlySet<string>
): LetterSelection {
  // Only entries with something to say (a description line) can anchor a
  // paragraph; a title-and-dates-only entry is core, shown on the resume, not
  // proof for a letter. Ranked by EVIDENCE strength (a quantified, on-point win
  // beats a keyword-dense generic one), then by kind, then by prfId, so the
  // choice is deterministic.
  const described = entries.filter(hasDescriptionLine);
  const ranked = [...described].sort((a, b) => {
    const scoreDiff = evidenceScore(b, vocabulary) - evidenceScore(a, vocabulary);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    const kindDiff = EVIDENCE_KIND_RANK[a.kind] - EVIDENCE_KIND_RANK[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.prfId < b.prfId ? -1 : a.prfId > b.prfId ? 1 : 0;
  });

  const proof = ranked[0] ?? null;
  // The fit entry is the next strongest that is NOT the proof, preferring a
  // different employer so the two paragraphs are not one company twice; falls
  // back to any other entry when every remaining one shares the employer.
  const differentEmployer =
    proof !== null
      ? ranked.find(
          (entry) =>
            entry.prfId !== proof.prfId &&
            (entry.employerOrInstitution !== proof.employerOrInstitution || proof.employerOrInstitution === null)
        )
      : undefined;
  const fit = differentEmployer ?? ranked.find((entry) => proof !== null && entry.prfId !== proof.prfId) ?? null;
  // Skills ride the fit paragraph and only when there is a fit entry to anchor
  // them: up to three skill entries whose own words overlap the posting.
  const skills = fit
    ? entries.filter((entry) => entry.kind === 'skill' && sharedVocabulary(entry, target).length > 0).slice(0, 3)
    : [];
  return { proof, fit, skills };
}

/** Every entry's core, grouped into sections in ENTRY_KINDS order, with no
    bullets and no provider call. A cover render carries these for provenance
    and for the byte-identity gates (gate 8 reads a cover's cores too), but the
    letter branch of DraftDocuments and pdf-resume never prints them: the
    paragraphs are the document. Ordered reverse-chronologically, the same
    convention the resume uses, so two renders of the same inputs stay
    byte-identical. */
function coreOnlySections(entries: ProfileRecord): readonly RenderSection[] {
  const sections: RenderSection[] = [];
  for (const kind of ENTRY_KINDS) {
    const ofKind = entries.filter((entry) => entry.kind === kind);
    if (ofKind.length === 0) continue;
    const ordered = [...ofKind].sort(byRecency);
    const renderEntries: RenderEntry[] = ordered.map((entry) => ({
      prfId: entry.prfId,
      kind: entry.kind,
      core: coreOf(entry),
      descriptiveTitle: null,
      bullets: []
    }));
    sections.push({ kind, heading: HEADINGS[kind], entries: renderEntries });
  }
  return sections;
}

/** The cover letter's gap report: the resume gaps, plus a letter-specific line
    when the opener has no reason to anchor on, and another when the posting
    offered no requirement lines to answer. */
function computeLetterGaps(
  entries: ProfileRecord,
  paragraphs: readonly LetterParagraph[],
  reason: string | null,
  letterTarget: LetterTarget,
  recordVocabulary: ReadonlySet<string>
): GapReport | null {
  const missing: string[] = [];
  if (entries.length === 0) {
    missing.push(
      'The record has no entries yet. Add at least one role, education, project, or skill in the Profile Record editor before generating a render.'
    );
  } else if (
    !paragraphs.some((p) => p.sourcePrfIds.length > 0) &&
    entries.some((entry) => DESCRIPTION_KINDS.has(entry.kind))
  ) {
    // Only a role, education, or project owes the description a letter draws
    // on; a record of only credentials and skills is thin, not broken, so it
    // is not told every entry is missing detail.
    missing.push(
      'Your roles, education, and projects are missing descriptions. Add detail to at least one so the letter has more than a title and dates to draw on.'
    );
  }
  if (reason === null || reason.trim().length === 0) {
    missing.push(
      'No reason for this company was given, so the opener names the role and company only. Add a line on the job page and the letter will open on why this company, in its own words.'
    );
  }
  if (letterTarget.requirements.length === 0) {
    missing.push('The posting carries no requirement lines to answer, so the letter leans on your record alone.');
  } else {
    // Elicitation (resume-drafting.md Layer 1): a requirement the record cannot
    // answer at all is a real gap. Count them, but do NOT quote the posting line
    // back: a requirement line can carry a skill the record does not hold, and
    // echoing it into a gap would put a fact foreign to the record into the
    // render (fabrication gate 9). Name the count, not the content, and point
    // the person at the posting.
    const unansweredCount = letterTarget.requirements.filter((line) => {
      for (const word of extractWords(line)) {
        if (recordVocabulary.has(word)) return false;
      }
      return true;
    }).length;
    if (unansweredCount > 0) {
      const noun = unansweredCount === 1 ? 'one requirement' : `${unansweredCount} requirements`;
      missing.push(`The posting lists ${noun} your record does not yet speak to. Add a role, project, or skill that covers it, and the letter can answer more of what they asked for.`);
    }
  }
  return missing.length > 0 ? { missing } : null;
}

/* -------------------------------------------------------------------------
   The two public entry points.
   ------------------------------------------------------------------------- */

/**
 * Pure and deterministic: the same `entries` and `target` (compared by
 * value, not by reference) always produce byte-identical JSON, because
 * every step above (extractWords, relevanceScore, fragmentsFor, the
 * ordering comparator, templateText) is itself a pure function of its own
 * arguments with no clock, no randomness, and no mutation of shared state.
 * See tailor.test.ts's determinism tests.
 */
export async function renderResume(
  entries: ProfileRecord,
  target: Target,
  provider: StyleProvider = deterministicProvider,
  header: RenderHeader | null = null
): Promise<ResumeRender> {
  // Three arguments to buildSections(), never four. No identifier called
  // `voice` appears anywhere in this function. See buildSections()'s own
  // comment and voice.ts's file header: this is the entire mechanism that
  // keeps a writing-voice sample out of a resume render.
  const { sections, changeRecord } = await buildSections(entries, target, provider);
  return {
    kind: 'resume',
    target: summarizeTarget(target),
    sections,
    provenance: summarizeProvenance(sections),
    gaps: computeGaps(entries, sections),
    // Carried through unchanged, attached after buildSections() the same way
    // salutation/closing are on a cover: a link is never rephrased by a
    // provider because it is not a slot (see RenderHeader).
    header,
    changeRecord
  };
}

/**
 * A real cover letter: prose paragraphs, not the resume's grouped bullets.
 * Same determinism guarantee as renderResume() (the same inputs always produce
 * byte-identical JSON, because every step below is a pure function of its
 * arguments and the provider this run ships is deterministic).
 *
 * The shape, following provider.ts's covenant one step further than a resume
 * does:
 *   1. SELECT the evidence entries (selectLetterEvidence), the requirement
 *      lines (extractLetterTarget), and carry the person's own reason.
 *   2. LOCK them into a LockedLetter (cover-letter.ts): one core sentence and
 *      its description lines per evidence paragraph, plus the target strings
 *      and the reason. A provider never sees a ProfileEntry, a Job, or the
 *      immutable core, only these locked strings.
 *   3. STYLE the four paragraphs in one call (provider.styleLetter). The
 *      deterministic provider returns an honest template; a generative one
 *      returns model prose that a verifier has already accepted (Phase 3).
 *   4. MINT the returned strings into branded paragraphs whose provenance is
 *      read off the lock, never off the provider's return value.
 *
 * `sections` still carries every entry's core (coreOnlySections): a cover's
 * cores feed provenance and the byte-identity gates, but the letter branch of
 * the renderers never prints them. `voice` is RUN-MASTER (a)'s writing sample,
 * and this is still the ONLY exported function that ever hands a non-null
 * voice to a provider: renderResume() never does, and it reaches styleLetter()
 * alone, never style(). See voice.ts's file header for the containment.
 */
export async function renderCover(
  entries: ProfileRecord,
  target: Target,
  provider: StyleProvider = deterministicProvider,
  voice: VoiceSample | null = null,
  header: RenderHeader | null = null,
  inputs: CoverInputs = {}
): Promise<CoverRender> {
  const reason = inputs.reason ?? null;
  const vocabulary = vocabularyFor(target);
  const recordVocabulary = recordVocabularyOf(entries);
  const knownPrfIds = new Set(entries.map((entry) => entry.prfId));

  const letterTarget = extractLetterTarget(target, recordVocabulary);
  const selection = selectLetterEvidence(entries, target, vocabulary);

  // The context pack (Phase 3): the posting's field and the person's situation
  // against it resolve one pack that shapes the letter's length band and prompt
  // guidance. Pure and deterministic; it carries no fact of its own.
  const field = letterTarget.field ?? 'general';
  const targetCompany = target.kind === 'verified_posting' ? target.job.company : null;
  const situation = detectSituation(entries, field, targetCompany);
  const pack = packFor(field, situation);

  const locked = lockLetter(selection, letterTarget, reason, recordAllowlistText(entries), pack);

  const styled = await provider.styleLetter(locked, voice);
  const paragraphs = buildLetterParagraphs(styled, locked, knownPrfIds);

  // The letter's change record, derived the same honest way as the resume's: a
  // paragraph whose styled text equals what the DETERMINISTIC writer would have
  // produced for the same lock is the record's own words (KEPT); one a connected
  // model rephrased differs (REWROTE). When this run IS the deterministic writer
  // the two are identical, so every paragraph is KEPT, which the room states
  // plainly. The deterministic baseline is a pure, clock-free call, so it never
  // makes a second network trip. Keyed by role (opener/proof/fit/close), the
  // letter has no bullet prfId; coreOnly is zero because a letter prints prose,
  // not trimmed cores, and mirroredTerms is a resume-only skill-alias case.
  const baseline: LetterStyleResult =
    provider === deterministicProvider ? styled : await deterministicProvider.styleLetter(locked, voice);
  const baselineByRole: Record<string, string> = {
    opener: baseline.opener,
    proof: baseline.proof,
    fit: baseline.fit,
    close: baseline.close
  };
  const letterPerEntry = paragraphs.map((paragraph) => ({
    prfId: paragraph.role,
    verdict: (paragraph.text === baselineByRole[paragraph.role] ? 'KEPT' : 'REWROTE') as 'KEPT' | 'REWROTE'
  }));
  const changeRecord: ChangeRecord = {
    perEntry: letterPerEntry,
    counts: {
      rewrote: letterPerEntry.filter((e) => e.verdict === 'REWROTE').length,
      kept: letterPerEntry.filter((e) => e.verdict === 'KEPT').length,
      coreOnly: 0
    },
    mirroredTerms: []
  };

  return {
    kind: 'cover',
    target: summarizeTarget(target),
    sections: coreOnlySections(entries),
    provenance: summarizeLetterProvenance(paragraphs),
    gaps: computeLetterGaps(entries, paragraphs, reason, letterTarget, recordVocabulary),
    salutation: salutationFor(target, letterTarget.register),
    closing: 'Sincerely,',
    // Attached here, never routed through a provider: the header is assembled
    // from the argument above, exactly like salutation/closing, and never from
    // the entries a slot is built from (see RenderHeader).
    header,
    paragraphs,
    letterInputs: { reason, requirements: letterTarget.requirements, mode: voice ? 'adapt' : 'create', context: { field, situation } },
    changeRecord
  };
}
