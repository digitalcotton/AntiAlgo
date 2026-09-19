/**
 * provider.ts: the seam between "facts, locked" and "facts, phrased".
 *
 * RUN-MASTER phase 3, addition (b): "generation goes through one provider
 * interface so a bring-your-own-key option can slot in later without
 * rework." This file is that interface, plus exactly one implementation:
 * the deterministic template pass. Nothing here calls a network, a model,
 * or a database. It is a pure module in the same spirit as record.ts and
 * entitlement.ts.
 *
 * THE ARCHITECTURE RULE THIS FILE EXISTS TO MAKE TRUE BY CONSTRUCTION:
 *   FACTS ARE SELECTED AND LOCKED FROM THE RECORD BEFORE ANY STYLE PASS RUNS.
 *
 * tailor.ts does the selecting and locking: it reads the Profile Record, the
 * target, decides which entries are in the render and in what order, and
 * writes the result down as a LockedFactSet. Only after that is frozen does
 * it hand the set to a StyleProvider. A provider never sees a ProfileEntry,
 * a Job, a target, or a database row. It sees LockedFactSlot values: a slot
 * id, the PRF ids the slot already cites, and an array of text fragments
 * that were already pulled from the record. Its `style()` method returns
 * text keyed by slot id and nothing else.
 *
 * WHY A PROVIDER CANNOT INTRODUCE A FACT, BY THE SHAPE OF THE CALL:
 *   - StyleResult has one field, styledSlots, and each entry in it has
 *     exactly two fields: slotId and text. There is no employer field, no
 *     title field, no date field, no credential field, no id-list field
 *     anywhere in this type. A provider that wanted to assert a new fact
 *     would have to invent a property this type does not declare, and
 *     nothing downstream reads an undeclared property.
 *   - A provider cannot mint a new slot. tailor.ts (see applyStyle() there)
 *     walks its own LockedFactSet, looks up each known slot id in the
 *     StyleResult it got back, and builds one Bullet per slot it already
 *     knew about. It never iterates the StyleResult's own list to decide
 *     what bullets to produce. A styledSlots entry whose slotId was never
 *     handed to the provider is simply never read by anything, however
 *     persuasive its text.
 *   - A provider never receives the immutable core at all. coreOf() runs in
 *     tailor.ts, straight from the ProfileEntry, and is written onto the
 *     render directly. LockedFactSlot has no employerOrInstitution,
 *     officialTitle, start, or end field, so there is no channel through
 *     which a provider's return value could reach the core, let alone
 *     change it.
 *   - sourcePrfIds travels with the slot INTO the provider and is never
 *     read back FROM it. tailor.ts's applyStyle() takes the ids straight
 *     off its own locked slot, never off anything the provider returned, so
 *     a provider cannot rewrite which PRF ids a bullet cites, only how the
 *     text for that bullet reads.
 *
 * WHAT THIS DOES NOT AND CANNOT ENFORCE: a provider's `text` field is a free
 * string. Nothing in this type system stops a future, badly behaved
 * provider from writing deceptive prose into an existing slot's text (for
 * example, turning "Maintained the build pipeline" into "Led a team of
 * twelve") while leaving slotId and the record's own sourcePrfIds
 * untouched. That is content-level fabrication inside an already-locked
 * fact, not a new fact, and no type can catch it: catching it needs the
 * adversarial fabrication test suite MASTER-SPEC F3 calls for (20+
 * adversarial prompts, fail closed), which is a later gate, not this file.
 * The deterministic provider shipped below never does this: it only joins
 * fragments that were already locked. State this limitation plainly rather
 * than implying the type system covers more ground than it does.
 *
 * COVENANT, PERMANENT: NO CLAUDE.AI OR CHATGPT ACCOUNT LOGIN AS AN INFERENCE
 * CREDENTIAL, EVER. This is MASTER-SPEC decision D7, recorded there at
 * covenant level, and RUN-MASTER phase 3 addition (b) repeats it as a stop
 * condition for any worker who proposes it. The reasons are not this
 * product's opinion: Anthropic's own terms explicitly prohibit third-party
 * Claude.ai login and credential intermediation (code.claude.com legal
 * page, 2026), and OpenAI's consumer sign-in shares identity only, not an
 * API credential a server-side provider could call. Neither is a lawful
 * path to inference from this codebase, this run or any future one. Bring
 * your own (API) key is the only credential model this seam is designed
 * for, and BYOK itself is explicitly OUT of this run (RUN-MASTER: "key
 * custody is a security surface that deserves its own supervised pass").
 * If a future worker or a future version of this file proposes routing a
 * StyleProvider through a Claude.ai or ChatGPT account login, that is a
 * covenant-level stop: do not build it, say so, and point back to this
 * comment and MASTER-SPEC D7.
 */

import type { EntryKind } from './record';
import type { VoiceSample } from './voice';
import type { CoverField, CoverPack } from './cover-context';

/* -------------------------------------------------------------------------
   Locked facts: computed and frozen by tailor.ts before any provider runs.
   ------------------------------------------------------------------------- */

/**
 * One already-selected, already-ordered fact a style pass may phrase.
 *
 * `fragments` is the complete, closed set of words a provider may draw on
 * for this slot: sentences pulled from the record entry's own description,
 * or (for a skill) the skill's own name, already vocabulary-mirrored
 * against the target by tailor.ts using only text that already matches the
 * record. A provider may reorder, join, or drop fragments; it has no way to
 * add one that is not here, because `fragments` is the only field carrying
 * words in and StyleResult (below) carries no fragments field at all, only
 * a slot id and a finished string.
 */
export interface LockedFactSlot {
  /** Stable within one render call. Not a PRF id: a single entry may in
      principle back more than one slot in a later version of this file, so
      the slot id and the PRF id are kept as two different namespaces on
      purpose even though this run's tailor.ts happens to mint one slot per
      entry. */
  readonly slotId: string;
  /** The PRF ids this slot's eventual bullet must cite. Non-empty by type:
      see Bullet in tailor.ts for why that matters. */
  readonly sourcePrfIds: readonly [string, ...string[]];
  readonly kind: SlotKind;
  readonly fragments: readonly string[];
}

/** What a slot is: one record entry of some kind, or the resume's opening
    summary (tailor.ts summarySlotFor), which is built from several entries and
    styled in the same one call as everything else. */
export type SlotKind = EntryKind | 'summary';

/** A closed set of locked slots, handed to a provider as one unit. */
export interface LockedFactSet {
  readonly slots: readonly LockedFactSlot[];
}

/* -------------------------------------------------------------------------
   What a style pass may return: phrasing, and nothing else.
   ------------------------------------------------------------------------- */

/** Exactly two fields. No employer, no title, no date, no credential, no
    id list: see the file header for why that absence is the point. */
export interface StyledSlot {
  readonly slotId: string;
  readonly text: string;
}

export interface StyleResult {
  readonly styledSlots: readonly StyledSlot[];
}

/* -------------------------------------------------------------------------
   The letter seam: the same "facts locked before any style pass" rule, but
   for a cover letter, where the unit is four paragraphs, not one bullet per
   entry.

   A cover letter is prose that connects the record to the posting, so its
   locked shape carries two things a resume slot never does: a few lines of
   the EMPLOYER'S OWN posting text (LetterTarget.requirements), so a paragraph
   can name the requirement it answers, and the PERSON'S OWN reason for this
   company (LockedLetter.reason), so the opener can quote it. Both are still
   strings the engine (tailor.ts) selected and froze; a provider still never
   sees a Job, a ProfileEntry, or a database row, exactly as the file header
   promises. The target block is engine-selected posting text, and the letter
   verifier (letter-verify.ts) treats it as such: a paragraph may name a
   requirement, but a first-person claim may still carry only what the
   fragments or the reason state.
   ------------------------------------------------------------------------- */

export const LETTER_ROLES = ['opener', 'proof', 'fit', 'close'] as const;
export type LetterRole = (typeof LETTER_ROLES)[number];

/**
 * The posting, as strings the engine chose. company/title are a verified
 * posting's own bytes (empty/null for a free-text target); requirements are a
 * few lines lifted verbatim from the posting, in the employer's own order,
 * chosen for how well the record can answer them (see posting-requirements.ts).
 * register picks the salutation and tone. A provider receives this labelled as
 * the employer's words; it never receives the Job it came from.
 */
export interface LetterTarget {
  readonly company: string;
  readonly title: string | null;
  readonly requirements: readonly string[];
  readonly register: 'tech' | 'formal';
  /** The context-pack field this posting reads as (cover-context.ts). Drives
      the letter's length band and prompt guidance; `register` above still
      picks the salutation. Optional so an older lock or a test omits it. */
  readonly field?: CoverField;
}

/**
 * One paragraph's locked evidence. `fragments` is the closed set of record
 * text this paragraph may draw a fact from (a core sentence, then description
 * lines), the same role `LockedFactSlot.fragments` plays for a bullet.
 * `sourcePrfIds` is empty for the opener and close (which cite the target and
 * the person's reason, never a record fact) and non-empty for proof and fit;
 * cover-letter.ts's createParagraph() enforces that at paragraph-mint time.
 */
export interface LockedLetterSlot {
  readonly role: LetterRole;
  readonly sourcePrfIds: readonly string[];
  readonly fragments: readonly string[];
}

/** A whole letter's locked facts, handed to a provider as one unit: exactly
    the four roles in LETTER_ROLES order, the target strings, and the person's
    own reason (or null). */
export interface LockedLetter {
  readonly document: 'cover_letter';
  readonly slots: readonly LockedLetterSlot[];
  readonly target: LetterTarget;
  readonly reason: string | null;
  /** The person's WHOLE record as plain text, read ONLY by the verifier
      (letter-verify.ts) as a fact allowlist so a paragraph may safely name any
      real record fact, not just the two entries this letter selected. It is
      NEVER placed in the data message a provider's model receives
      (buildLetterDataMessage sends only slots, target, and reason), so it does
      not widen what the model can see. Optional so an older lock or a test omits
      it and the verifier falls back to the selected slots. */
  readonly recordAllowlist?: string;
  /** The resolved context pack (field x situation) for this letter
      (cover-context.ts). Read by the prompt builder (its guidance is appended
      to the letter data message) and by the verifier (its word band flexes the
      length check). Pure guidance and bounds: it can never add a fact. Optional
      so an older lock or a test omits it and the engine uses its defaults. */
  readonly pack?: CoverPack;
}

/** What a letter style pass returns: one string per role, and nothing else.
    The same "no fact-bearing field" discipline StyleResult keeps: there is no
    employer, title, date, or id field here, only the four paragraph strings. */
export type LetterStyleResult = Readonly<Record<LetterRole, string>>;

/**
 * The seam. `name` is diagnostic only (shown in a render's own debug
 * trail, never to an applicant as if it were a fact about their record).
 *
 * `style()` returns `Promise<StyleResult>`, not `StyleResult`. BYOK (the
 * slot RUN-MASTER phase 3 addition (b) names and Decision D7 fences with
 * the covenant above) is now in scope for this run's owner order, so the
 * signature change this file used to defer has happened here, in this one
 * diff, on purpose: a network-backed provider needs an async return, and
 * making that change now, together with every caller it touches, keeps the
 * breakage one reviewable diff instead of a change smeared thin across
 * whichever later worker first needed it. deterministicProvider (below) is
 * still synchronous inside; it is simply wrapped in `async` so its return
 * value satisfies the interface. See tailor.ts's buildSections() for the
 * one place that awaits a provider's `style()` call.
 *
 * `voice` is the second, optional argument RUN-MASTER phase 3 addition (a)
 * asks for: an optional writing-voice sample (see voice.ts), present only
 * on a cover render's style pass and null everywhere else. See tailor.ts's
 * buildSections() for the one place that decides which value this
 * receives, and voice.ts's file header for the full containment argument.
 * deterministicProvider (below), the only implementation this run ships,
 * ignores it entirely: it only joins fragments, so a voice sample changes
 * nothing about its output today. Read deterministicProvider's own comment
 * before assuming this parameter already does something.
 */
export interface StyleProvider {
  readonly name: string;
  style(locked: LockedFactSet, voice?: VoiceSample | null): Promise<StyleResult>;
  /**
   * Phrase one cover letter from its locked facts. REQUIRED, not optional, on
   * purpose: a provider that phrases resume bullets must say what it does with
   * a letter, and every test double stops compiling until it does, the same
   * "compile error until extended" discipline HEADINGS keeps in tailor.ts. A
   * generative provider returns model prose here; deterministicProvider below
   * returns an honest template. `voice`, when present, is the person's own
   * writing sample (voice.ts) and reaches ONLY this method, never style():
   * see voice.ts's file header for the containment argument.
   */
  styleLetter(locked: LockedLetter, voice?: VoiceSample | null): Promise<LetterStyleResult>;
}

/* -------------------------------------------------------------------------
   templateText(): the one templating rule. Shared by the deterministic
   provider below and by tailor.ts's own fallback (see applyStyle() there),
   so "what a bullet says when nobody styled it" and "what the deterministic
   provider says" are one rule, not two that can drift apart.
   ------------------------------------------------------------------------- */

/**
 * Joins a slot's fragments into one bullet string. This is deterministic by
 * construction: the same fragments in the same order produce the same
 * string, always, because this function does nothing but string
 * concatenation on its own arguments.
 *
 * A 'skill' slot's first fragment is the skill's own (possibly
 * vocabulary-mirrored) name; any further fragments are the record's own
 * description text for that skill, joined after a colon. Every other kind
 * joins its fragments as sentences: each fragment is terminated with one
 * sentence-ending mark before the next begins, so a description line that
 * already ends in '.', '!', or '?' is not doubled (the "experiences..
 * Recruit" defect) and a line that ends in none is not left bare (the
 * unpunctuated last bullet). Terminating per fragment, then joining on a
 * single space, is one rule that fixes both. Empty input produces an empty
 * string on purpose: tailor.ts never builds a slot with zero fragments (see
 * fragmentsFor() there), so an empty result here only ever happens if a
 * caller passes fragments this module did not build, and an empty bullet
 * text is never turned into a Bullet (see applyStyle() in tailor.ts).
 */
export function templateText(kind: SlotKind, fragments: readonly string[]): string {
  if (fragments.length === 0) return '';
  if (kind === 'skill') {
    const [label, ...rest] = fragments;
    return rest.length > 0 ? `${label}: ${rest.join(' ')}` : label;
  }
  if (kind === 'summary') {
    // The summary's first two fragments are its two sentences (RESUME-RULES.md
    // layer 2: at most two sentences and 40 words; tailor.ts builds them within
    // that cap). Any further fragments are the record's own lines a model may
    // draw on inside the same cap; the template does not print them.
    return fragments.slice(0, 2).map(endWithSentenceMark).filter((s) => s.length > 0).join(' ');
  }
  return fragments.map(endWithSentenceMark).filter((s) => s.length > 0).join(' ');
}

/**
 * Trims trailing whitespace off one fragment and gives it exactly one
 * sentence-ending mark: left alone if it already ends in '.', '!', or '?',
 * otherwise a single '.' is appended. A fragment that is empty or
 * whitespace-only stays empty (templateText drops it), so this never emits a
 * lone period.
 */
function endWithSentenceMark(fragment: string): string {
  const trimmed = fragment.replace(/\s+$/, '');
  if (trimmed.length === 0) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/* -------------------------------------------------------------------------
   deterministicLetter(): the honest cover letter when no model wrote one.
   The counterpart of templateText() for the letter seam, and shared the same
   way: it is what a letter says when the deterministic provider handles it AND
   what a generative provider falls back to when its own attempt is rejected,
   so "the built-in letter" is one rule, not two that drift.
   ------------------------------------------------------------------------- */

const DETERMINISTIC_LETTER_CLOSE =
  'The resume alongside this letter carries the full record. I would welcome a conversation about the role.';

/**
 * A plain, true cover letter composed only from the locked facts: the
 * target's own company and title, the person's own reason, one core sentence
 * and one description line each for the proof and fit entries, and fixed
 * literal connective strings this file authors itself. It reads no `voice`
 * argument on purpose (gate 9 requires a deterministic letter be byte-
 * identical with and without one), and it invents nothing: a paragraph with
 * no evidence comes back empty, and tailor.ts renders no empty paragraph, so
 * a thin record yields an opener and a close over honest empty space rather
 * than filler. It never claims a reason the person did not give.
 */
export function deterministicLetter(locked: LockedLetter): LetterStyleResult {
  const proof = locked.slots.find((s) => s.role === 'proof');
  const fit = locked.slots.find((s) => s.role === 'fit');
  return {
    opener: deterministicOpener(locked.target),
    proof: deterministicBodyParagraph(proof),
    fit: deterministicBodyParagraph(fit),
    close: DETERMINISTIC_LETTER_CLOSE
  };
}

/**
 * The deterministic opener names the role and the company, and NOTHING ELSE.
 * It deliberately omits the person's "why this company" note: that note is a
 * rough draft in their own words and may carry typos or informal grammar, and
 * this path has no model to clean it up. Pasting it raw would ship misspellings
 * in a document meant for an employer. The note is not lost: it is stored on the
 * render (letterInputs.reason) and, when a model writes the letter, it is turned
 * into a clean opener there (COVER_SYSTEM_MESSAGE). The deterministic letter is
 * the honest floor when no model ran, and a clean role-and-company opener is a
 * better floor than the person's unedited notes.
 */
function deterministicOpener(target: LetterTarget): string {
  if (target.company.length > 0 && target.title) {
    return `I am applying for the ${target.title} role at ${target.company}.`;
  }
  if (target.company.length > 0) {
    return `I am applying to ${target.company}.`;
  }
  return 'I am applying for the role in your posting.';
}

/** A proof or fit paragraph: the entry's core sentence, then up to three of its
    description lines (bare one-word fragments such as a skill label are skipped,
    since a lone "Figma." is not a sentence). Using more than one line keeps the
    deterministic floor from reading as a one-line stub on the rare occasion it
    runs. Empty when the slot has no real description line to draw on, because a
    paragraph that only restates a title and dates is the resume, not a letter. */
function deterministicBodyParagraph(slot: LockedLetterSlot | undefined): string {
  if (!slot || slot.fragments.length === 0) return '';
  const [coreSentence, ...rest] = slot.fragments;
  const lines = rest.filter((line) => line.includes(' ')).slice(0, 3);
  if (!coreSentence || lines.length === 0) return '';
  return [coreSentence, ...lines].map(endWithSentenceMark).filter((s) => s.length > 0).join(' ');
}

/**
 * THE ONE IMPLEMENTATION THIS RUN SHIPS. RUN-MASTER section 3: "tailor
 * rephrasing may ship deterministic-first (selection, ordering, templates)
 * with generative rephrase flag-dark if no LLM access pattern exists in the
 * repo." None exists (see the covenant note above for why one is not being
 * added here either), so this provider does the templating and nothing
 * more: it never reorders, compresses, or drops a fragment tailor.ts did
 * not already decide to include, and it never reaches outside the
 * LockedFactSet it was given.
 */
export const deterministicProvider: StyleProvider = {
  name: 'deterministic-template-v1',
  // `voice` is accepted (the StyleProvider interface requires it be
  // acceptable) and never read: this function's body names no identifier
  // called `voice` anywhere below. A writing-voice sample changes nothing
  // about this provider's output, on a cover render or anywhere else,
  // because there is no templating rule here that consults it. See
  // voice.ts's file header for what changes the day a provider actually
  // reads this argument.
  async style(locked: LockedFactSet): Promise<StyleResult> {
    return {
      styledSlots: locked.slots.map((slot) => ({
        slotId: slot.slotId,
        text: templateText(slot.kind, slot.fragments)
      }))
    };
  },
  // Same discipline as style() above: `voice` is not named in this body, so a
  // sample changes nothing about the deterministic letter. deterministicLetter
  // reads only the locked facts.
  async styleLetter(locked: LockedLetter): Promise<LetterStyleResult> {
    return deterministicLetter(locked);
  }
};
