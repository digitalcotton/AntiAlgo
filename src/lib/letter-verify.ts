/**
 * letter-verify.ts: does a model's cover letter say only what the record, the
 * person's reason, and the posting allow? The fact checker for the letter seam,
 * the counterpart of verifyStyleResult() for a resume bullet, but far stricter,
 * because a letter is prose a model wrote, not a template this code filled.
 *
 * THE COVENANT, MECHANICAL. MASTER-SPEC 3.3: a render may never add a skill,
 * tool, employer, title, date, metric, or credential absent from the record.
 * For a letter that becomes: every number and every named thing in a paragraph
 * must trace to a closed corpus, and that corpus is built from three sources
 * kept apart so a token's origin is known:
 *   - record: the locked fragments (core sentences and description lines).
 *   - reason: the person's own words, which anchor the opener only.
 *   - target: the employer's own words (company, title, requirement lines).
 * A first-person claim may draw a fact only from the record or the reason: the
 * letter may NAME a requirement the posting stated, but it may never turn that
 * requirement into a claim about the person (C4). The voice sample is never in
 * any corpus: the person's own letter is a source of tone, never of fact.
 *
 * FAIL CLOSED, NEVER POLICE. A letter that fails any check is REJECTED, and the
 * caller (generation-providers.ts, Phase 3) falls back to the deterministic
 * letter, exactly as a failed bullet attempt falls back. This module rewrites
 * nothing and ships nothing; it returns a verdict. It reads only the locked
 * facts and the model's strings, never a database, a network, or the record
 * itself beyond what the lock already froze.
 */

import {
  LETTER_ROLES,
  type LetterRole,
  type LetterStyleResult,
  type LockedLetter
} from './provider';
import { detectHostileCharacters } from './hygiene';
import { lintLetter, type LintFinding, type WordBounds } from './letter-lint';

/** A paragraph longer than this is not a rephrase, it is a runaway. Matches
    the resume seam's own ceiling (MAX_STYLED_SLOT_LENGTH in
    generation-providers.ts), defined here rather than imported to keep this
    pure module free of an import cycle with the generative provider. */
const MAX_PARAGRAPH_LENGTH = 4000;

export interface VerifiedLetterOk {
  readonly ok: true;
  readonly paragraphs: LetterStyleResult;
  readonly warnings: readonly string[];
}
export interface VerifiedLetterFail {
  readonly ok: false;
  readonly reason: string;
  readonly warnings: readonly string[];
}
export type VerifiedLetter = VerifiedLetterOk | VerifiedLetterFail;

export interface VerifyLetterOptions {
  /** The verified company name, or null for a free-text target. When present,
      C7 requires its distinctive token appear in the letter body. */
  readonly companyName: string | null;
  /** The person's WHOLE record as plain text (every entry's title, employer,
      and description), not only the two entries this letter selected for its
      proof and fit paragraphs. An entity the person demonstrably has in their
      record is never a fabrication, whichever paragraph names it. Optional so a
      test may omit it; then the corpus falls back to the locked slots. */
  readonly fullRecordText?: string;
  /** The context pack's length band (cover-context.ts), flexing the L1/L2 lint
      so a short tech note or an internal letter is judged against its own band,
      not the default one-page floor. Optional; omitted falls back to default. */
  readonly wordBounds?: WordBounds;
}

/* -------------------------------------------------------------------------
   Text primitives, shared by the corpus and the checks so both read a token
   the same way.
   ------------------------------------------------------------------------- */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Straighten curly quotes without lowercasing, for the content the reader
    keeps. */
function straightenQuotes(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
}

/** The dashes the house rule forbids (figure, en, em, horizontal bar, minus). */
const FORBIDDEN_DASHES = /[\u2012\u2013\u2014\u2015\u2212]/g;

/**
 * Repair the two violations that are LOSSLESSLY fixable, so a good letter is
 * never discarded over them: straighten curly quotes, and recast a forbidden
 * dash the way the house rule asks (a dash between two numbers is a range, "to";
 * any other becomes a comma). Opus reaches for em dashes constantly even when
 * told not to; rejecting a truthful letter over one, when we could fix it
 * byte-for-byte, is pure waste. The repaired text is what gets verified AND what
 * ships.
 */
function repairText(text: string): string {
  return straightenQuotes(text)
    .replace(/(\d)\s*[\u2012\u2013\u2014\u2015\u2212]\s*(\d)/g, '$1 to $2')
    .replace(FORBIDDEN_DASHES, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ');
}

const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?[kmb]?\+?/gi;

function numbersIn(text: string): Set<string> {
  const set = new Set<string>();
  for (const match of text.matchAll(NUMBER_RE)) set.add(canonNumber(match[0]));
  return set;
}

function canonNumber(token: string): string {
  // Strip the currency, thousands separators, and a trailing percent, so a
  // number reconciles across the forms a model naturally uses: "$1,200" and
  // "1200", "20%" and "20 percent" (the "20" the word form leaves behind). The
  // k/m/b scale letter is kept, so 1.2m and 1.2b stay distinct.
  return token.toLowerCase().replace(/[$,%]/g, '');
}

/* Spelled quantities above ten: an unverifiable metric written as a word.
   one..ten are allowed as ordinary connective counting. */
const SPELLED_OVER_TEN = /\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)\b/i;

/* Words that may open a sentence in title case yet are not entities to trace,
   plus the letter's own fixed furniture. */
const ENTITY_ALLOWLIST = new Set([
  'i', "i'm", "i've", "i'll", "i'd", 'a', 'an', 'the',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'dear', 'hi', 'hello', 'hiring', 'manager', 'team', 'sincerely', 'present'
]);

/** The entity-ish tokens in one sentence: a capitalized word that is not the
    sentence's first word, a token with an internal capital or all-caps of
    length two or more, or a token mixing a digit and a letter. Punctuation is
    trimmed; the allowlist and pure numbers are dropped. */
function entitiesInSentence(sentence: string): string[] {
  const rawTokens = sentence.split(/\s+/).filter((t) => t.length > 0);
  const entities: string[] = [];
  rawTokens.forEach((raw, index) => {
    const token = raw.replace(/^[^A-Za-z0-9$]+/, '').replace(/[^A-Za-z0-9%+]+$/, '');
    if (token.length === 0) return;
    const lower = token.toLowerCase();
    if (ENTITY_ALLOWLIST.has(lower)) return;
    if (/^\$?\d[\d,]*(?:\.\d+)?%?[kmb]?\+?$/i.test(token)) return; // a pure number, handled by C1
    const hasInternalCap = /[A-Z]/.test(token.slice(1));
    const isAllCaps = /^[A-Z0-9]{2,}$/.test(token) && /[A-Z]/.test(token);
    const hasDigitAndLetter = /\d/.test(token) && /[A-Za-z]/.test(token);
    const isCapitalized = /^[A-Z]/.test(token);
    const sentenceInitial = index === 0;
    if (hasInternalCap || isAllCaps || hasDigitAndLetter || (isCapitalized && !sentenceInitial)) {
      entities.push(lower);
    }
  });
  return entities;
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A global form of SPELLED_OVER_TEN, so C2 can iterate every spelled quantity
    in a paragraph and check each against the corpus. */
const SPELLED_OVER_TEN_G = new RegExp(SPELLED_OVER_TEN.source, 'gi');

/**
 * A real first-person CLAIM: "I" (optionally "I have"/"I've") followed by a verb
 * of doing. This is what C4 gates on, not the mere co-occurrence of "I" and a
 * capitalized posting word, so "Your posting asks for Kubernetes" is fine while
 * "I have used Kubernetes" (when Kubernetes is a posting-only requirement) is
 * not. Deliberately broad on the verb list; a false gate only widens what C4
 * inspects, and C3's own trace still catches a truly fabricated entity.
 */
const CLAIM_VERB = /\bi\s+(?:have\s+|had\s+|'ve\s+|'d\s+)?(?:use|used|build|built|lead|led|run|ran|manage|managed|design|designed|ship|shipped|work(?:ed)?\s+(?:with|on)|architect|architected|develop|developed|deliver|delivered|own|owned|create|created|wrote|drove|scaled|launched|grew|cut|raised|increased|reduced|ran|founded|led)\b/i;

/* C10 splits AI disclosure into two kinds. A DISCLOSURE PHRASE is a confession
   that a tool wrote the letter, which no record can make true, so it always
   fails. It is bounded on purpose: "As an AI product designer" and "revenue
   generated by the redesign" are ordinary truthful English and must not trip
   it, so "as an ai" only fires before a clause break or a self-referential
   word, and "generated by" only before a tool noun. */
const AI_DISCLOSURE = new RegExp(
  [
    String.raw`\bas an ai\b(?=\s*[,.;:]|\s+(?:i|i'm|assistant|model|system|language)\b)`,
    String.raw`\bas a (?:large )?language model\b`,
    String.raw`\bi am an? (?:ai|language model|assistant)\b`,
    String.raw`\bwritten by an? (?:ai|model|assistant|tool)\b`,
    String.raw`\bai[- ]generated\b`,
    String.raw`\bthis letter was (?:generated|drafted|written by)\b`,
    String.raw`\bgenerated by (?:an? )?(?:ai|model|language model|tool|assistant|llm)\b`
  ].join('|'),
  'i'
);

/* A TOOL or MODEL BRAND NAME is a FACT, not a confession: it is a fabrication
   only when it appears nowhere in the person's record, their reason, or the
   posting (the same trace C3 runs on every other entity). The person who
   shipped "a ChatGPT-style platform" may say so; the posting at OpenAI names
   its own company; a letter that invents "I built this with Gemini" from
   nothing does not. Global, so each hit is traced on its own. */
const AI_BRAND_G = /\b(?:chatgpt|claude|gemini|copilot|gpt-?\d(?:\.\d)?o?|llama|openai|anthropic|llm|language models?)\b/gi;

/* -------------------------------------------------------------------------
   The verifier.
   ------------------------------------------------------------------------- */

interface Corpus {
  readonly record: string;
  readonly reason: string;
  readonly target: string;
  /** The company and title: the posting words a first-person sentence MAY
      name ("I am applying for the Product Designer role at OpenAI"). */
  readonly nameable: string;
  /** The requirement lines: the posting words a first-person sentence may name
      but never CLAIM ("I have used Kubernetes" when Kubernetes is only here). */
  readonly requirements: string;
  readonly recordNumbers: Set<string>;
  readonly reasonNumbers: Set<string>;
  readonly requirementNumbers: Set<string>;
}

function buildCorpus(locked: LockedLetter, opts: VerifyLetterOptions): Corpus {
  // The record corpus is the person's WHOLE record (the fact allowlist) UNIONED
  // with the letter's own selected slots, which are always valid record facts.
  // The union matters: an incomplete allowlist must never drop the very entries
  // this letter was built from. C5/C6 still check a paragraph against its OWN
  // slot's fragments, so widening the trace corpus here does not let a proof
  // paragraph borrow a different entry's evidence.
  const record = normalize([opts.fullRecordText ?? '', locked.slots.flatMap((s) => s.fragments).join(' ')].join(' '));
  const reason = normalize(locked.reason ?? '');
  const nameable = normalize([locked.target.company, locked.target.title ?? ''].join(' '));
  const requirements = normalize(locked.target.requirements.join(' '));
  const target = normalize([locked.target.company, locked.target.title ?? '', ...locked.target.requirements].join(' '));
  return {
    record,
    reason,
    target,
    nameable,
    requirements,
    recordNumbers: numbersIn(record),
    reasonNumbers: numbersIn(reason),
    requirementNumbers: numbersIn(requirements)
  };
}

/** A token reduced to bare letters and digits, accents folded away, so spacing,
    hyphens, punctuation, and diacritics never decide a match: "south east",
    "south-east" and "Southeast" all become "southeast". */
function dense(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Whether the corpus contains a token, tolerantly. Plain substring first, then
 * a "dense" comparison (spacing/hyphen/accent-insensitive) so the model's
 * cleaned-up form matches the person's rough one, and a singular/plural fold so
 * "systems" matches a record "system" and vice versa. This only ever ADDS
 * acceptances: a token genuinely absent from the corpus (a fabricated proper
 * noun) is still absent after densing, so it cannot hide a fabrication. It fixes
 * the asymmetry of a raw substring test, which was lenient when the model
 * shortened a word but strict when it expanded, combined, or pluralized one,
 * the direction a model told to "fix the spelling and grammar" actually goes.
 */
function corpusHas(corpus: string, token: string): boolean {
  if (corpus.includes(token)) return true;
  const denseCorpus = dense(corpus);
  const denseToken = dense(token);
  if (denseToken.length === 0) return false;
  if (denseCorpus.includes(denseToken)) return true;
  if (denseToken.endsWith('s') && denseCorpus.includes(denseToken.slice(0, -1))) return true;
  if (denseCorpus.includes(`${denseToken}s`)) return true;
  return false;
}

/** Common legal suffixes and filler that are not a company's distinctive name. */
const COMPANY_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh',
  'plc', 'lp', 'llp', 'sa', 'ag', 'nv', 'group', 'holdings', 'the'
]);

/** The company's most distinctive token, for C7: the longest word left after
    dropping legal suffixes and punctuation. "OpenAI, Inc." -> "openai",
    "Southern Company" -> "southern", "Alabama Power" -> "alabama". Falls back to
    the whole name when nothing is left (a company that is only a suffix). */
function companyDistinctiveToken(company: string): string {
  const bare = normalize(company).replace(/[.,]/g, '');
  const words = bare.split(/\s+/).filter((w) => w.length > 0 && !COMPANY_SUFFIXES.has(w));
  if (words.length === 0) return bare;
  return words.reduce((longest, w) => (w.length > longest.length ? w : longest), '');
}

export function verifyLetterResult(
  locked: LockedLetter,
  result: LetterStyleResult,
  opts: VerifyLetterOptions
): VerifiedLetter {
  const warnings: string[] = [];
  const fail = (reason: string): VerifiedLetterFail => ({ ok: false, reason, warnings });

  // S1: exactly the four roles, each a non-empty string, no extras.
  const keys = Object.keys(result);
  for (const key of keys) {
    if (!LETTER_ROLES.includes(key as LetterRole)) return fail(`the letter returned an unexpected paragraph "${key}"`);
  }
  for (const role of LETTER_ROLES) {
    const value = result[role];
    if (typeof value !== 'string' || value.trim().length === 0) return fail(`the letter's ${role} paragraph came back empty`);
  }

  // Repair the losslessly-fixable violations (curly quotes, forbidden dashes)
  // once, up front. The repaired text is what we verify AND what ships, so a
  // stray dash never rejects an otherwise truthful letter.
  const repaired: LetterStyleResult = {
    opener: repairText(result.opener),
    proof: repairText(result.proof),
    fit: repairText(result.fit),
    close: repairText(result.close)
  };

  const corpus = buildCorpus(locked, opts);
  const hasReason = corpus.reason.trim().length > 0;
  const wholeLetter = LETTER_ROLES.map((r) => repaired[r]).join('\n');
  const targetNumbers = numbersIn(corpus.target);
  // The person's own words may draw on their own note anywhere in the letter
  // (the reason is a MASTER-SPEC 3.3 exception): a number the note states is
  // permitted in every paragraph, the same way C3 already accepts a reason
  // entity in every paragraph.
  const permittedNumbers = new Set([...corpus.recordNumbers, ...corpus.reasonNumbers, ...targetNumbers]);

  for (const role of LETTER_ROLES) {
    const paragraph = repaired[role];
    const normalized = normalize(paragraph);

    // S2: length.
    if (paragraph.length > MAX_PARAGRAPH_LENGTH) return fail(`the ${role} paragraph is longer than a rephrase should ever be`);
    // S3: hostile characters.
    if (detectHostileCharacters(paragraph).length > 0) return fail(`the ${role} paragraph carried a hidden or hostile character`);
    // C9 (checked per paragraph so a leak reports as a leak, before its digits
    // read as a stray number): no provenance chrome in the prose.
    if (/\bprf-\d/i.test(normalized) || /\bsource:/i.test(normalized)) return fail(`the ${role} paragraph leaked a PRF id or a Source line`);

    // C1: every number traces to the permitted corpus (record + reason + posting).
    for (const number of numbersIn(paragraph)) {
      if (!permittedNumbers.has(number)) return fail(`the ${role} paragraph states a number ("${number}") that is nowhere in the record, reason, or posting`);
    }

    // C2: a spelled quantity above ten is fine ONLY if it is actually in the
    // corpus (a record fragment that literally says "twenty people"); otherwise
    // an unverifiable metric written as a word.
    for (const spelled of normalized.match(SPELLED_OVER_TEN_G) ?? []) {
      const word = spelled.toLowerCase();
      if (!corpusHas(corpus.record, word) && !corpusHas(corpus.reason, word) && !corpusHas(corpus.target, word)) {
        return fail(`the ${role} paragraph spells out a quantity ("${word}") that is nowhere in the record, reason, or posting`);
      }
    }

    // C3 and C4: entities trace to the corpus, and a real first-person CLAIM may
    // not turn a posting-only requirement into a fact about the person. The
    // OPENER, when a reason is present, is skipped: its content is the person's
    // own note (a 3.3 exception) plus the target's role and company, which the
    // model was told to reword and clean up; holding that to an entity trace
    // fights the cleanup and drops the person's own words. C1 above still guards
    // its numbers.
    if (role === 'opener' && hasReason) continue;
    for (const sentence of sentencesOf(paragraph)) {
      const claim = CLAIM_VERB.test(sentence);
      for (const entity of entitiesInSentence(sentence)) {
        const inRecord = corpusHas(corpus.record, entity);
        const inReason = corpusHas(corpus.reason, entity);
        const inNameable = corpusHas(corpus.nameable, entity) || (opts.companyName ? corpusHas(normalize(opts.companyName), entity) : false);
        const inRequirements = corpusHas(corpus.requirements, entity);
        if (!inRecord && !inReason && !inNameable && !inRequirements) {
          return fail(`the ${role} paragraph names "${entity}", which is nowhere in the record, reason, or posting`);
        }
        // C4: a requirement word (a skill or tool only the posting states) may be
        // NAMED, but a first-person CLAIM verb ("I have used X") may not turn it
        // into a fact about the person. Naming without a claim verb is allowed.
        if (claim && inRequirements && !inRecord && !inReason && !inNameable) {
          return fail(`the ${role} paragraph turns "${entity}", a requirement only the posting states, into a first-person claim`);
        }
      }
      // C4 for numbers: a first-person claim may not assert a requirement-only number.
      if (claim) {
        for (const number of numbersIn(sentence)) {
          const requirementOnly = corpus.requirementNumbers.has(number) && !corpus.recordNumbers.has(number) && !corpus.reasonNumbers.has(number);
          if (requirementOnly) return fail(`the ${role} paragraph claims a number ("${number}") that only the posting states`);
        }
      }
    }
  }

  // C5 and C6: a proof or fit paragraph must use its own evidence, and a fit
  // paragraph with no evidence must add no fact.
  for (const role of ['proof', 'fit'] as const) {
    const slot = locked.slots.find((s) => s.role === role);
    const paragraph = repaired[role];
    const slotNumbers = numbersIn(normalize((slot?.fragments ?? []).join(' ')));
    const slotEntities = new Set((slot?.fragments ?? []).flatMap((f) => entitiesInSentence(f).concat(entitiesInSentence(`x ${f}`))));
    const hasEvidence = (slot?.sourcePrfIds.length ?? 0) > 0;
    const paragraphNumbers = numbersIn(paragraph);
    const paragraphEntities = new Set(sentencesOf(paragraph).flatMap(entitiesInSentence));

    if (hasEvidence && (slotNumbers.size > 0 || slotEntities.size > 0)) {
      const usesANumber = [...paragraphNumbers].some((n) => slotNumbers.has(n));
      const usesAnEntity = [...paragraphEntities].some((e) => slotEntities.has(e) || corpusHas(normalize((slot?.fragments ?? []).join(' ')), e));
      if (!usesANumber && !usesAnEntity) warnings.push(`the ${role} paragraph does not visibly use its own evidence`);
    }
    if (!hasEvidence) {
      // C6: an evidence-less fit paragraph may carry no number and no
      // non-target entity.
      if (paragraphNumbers.size > 0) return fail(`the ${role} paragraph asserts a number but has no evidence behind it`);
    }
  }

  // C7: the company is named at least once (swap-test proxy). Its DISTINCTIVE
  // token, not the full punctuated legal name: "OpenAI" satisfies a verified
  // "OpenAI, Inc." A model writes the plain name, and requiring the comma and
  // the suffix would reject an otherwise on-target letter.
  if (opts.companyName && opts.companyName.trim().length > 0) {
    const distinctive = companyDistinctiveToken(opts.companyName);
    if (distinctive.length > 0 && !corpusHas(normalize(wholeLetter), distinctive)) {
      return fail('the letter never names the company it is addressed to');
    }
  }

  // (No verbatim-reason check.) The reason is the person's own rough note, and
  // the model is asked to write a clean, correctly spelled opener FROM ITS
  // MEANING, not to copy its exact words (COVER_SYSTEM_MESSAGE). Requiring the
  // note appear byte-for-byte would reject exactly the cleaned-up opener we
  // want, and ship the person's typos. Fact-safety does not depend on it: C1,
  // C3, and C4 above already hold every number and entity in the opener to the
  // opener corpus (record + reason + target), so the model may draw facts FROM
  // the note but cannot invent past it, and a note-fact that strays into a
  // proof or fit paragraph still fails (their corpus excludes the reason).

  // C9: no provenance chrome leaks into the prose.
  if (/\bprf-\d/i.test(wholeLetter) || /\bsource:/i.test(wholeLetter)) return fail('the letter leaked a PRF id or a Source line');

  // C10a: a real AI disclosure ("as a language model", "this letter was
  // generated by a model") is a confession no record can make true, so it
  // always fails, whatever the corpus holds.
  if (AI_DISCLOSURE.test(wholeLetter)) {
    return fail('the letter states or implies a tool wrote it');
  }

  // C10b: a tool or model brand name is a fabrication only when it is nowhere
  // in the record, the reason, or the posting, the same trace C3 runs on every
  // other entity. Checked per role INCLUDING the opener (unlike C3, which
  // trusts the opener's cleaned note): "I used ChatGPT to write this" is
  // exactly what an opener might smuggle in. The person who shipped a
  // ChatGPT-style platform, and a letter to OpenAI, both pass.
  for (const role of LETTER_ROLES) {
    for (const brand of normalize(repaired[role]).match(AI_BRAND_G) ?? []) {
      const known =
        corpusHas(corpus.record, brand) ||
        corpusHas(corpus.reason, brand) ||
        corpusHas(corpus.target, brand) ||
        (opts.companyName ? corpusHas(normalize(opts.companyName), brand) : false);
      if (!known) {
        return fail(`the ${role} paragraph names "${brand}", an AI tool that is nowhere in the record, reason, or posting`);
      }
    }
  }

  // L: the mechanical lint. Any fail rejects; warns are advisory.
  const lint: readonly LintFinding[] = lintLetter(wholeLetter, opts.wordBounds);
  for (const finding of lint) {
    if (finding.level === 'fail') return fail(`lint: ${finding.rule} (${finding.detail})`);
    warnings.push(`lint: ${finding.rule} (${finding.detail})`);
  }

  return { ok: true, paragraphs: repaired, warnings };
}
