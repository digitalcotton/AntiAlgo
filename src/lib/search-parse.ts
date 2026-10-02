/**
 * search-parse.ts: the board's search box, read as facts and words. Pure, so the
 * server, the typeahead and a test all parse the same text the same way.
 *
 * WHAT IT DECIDES (docs/search-engine-design.md §2 and §5.4). A reader types one
 * line. The parts of it an employer actually STATED (a place, a company, pay, a
 * remote kind, how new the posting is) become chips, each one a query parameter,
 * each one counted. Everything else stays a word and is searched as text.
 * Nothing here guesses a category: the only inference is "this token is this
 * fact", and it is made from syntax (`150k`) or from an exact dictionary hit
 * (`london`), never from a model.
 *
 * TWO KINDS OF FACT, TWO KINDS OF CERTAINTY.
 *   - Syntax facts (pay, remote, age) cannot be a word by accident. `150k` is
 *     money, `hybrid` is a work arrangement, `last 7 days` is a window. They
 *     become chips outright.
 *   - Dictionary facts (place, company) CAN be a word. `phoenix` is a city and a
 *     job title; `oracle` is a company and a skill. The lexicon decides, for the
 *     whole matched PHRASE, whether the board uses it as a title term at least as
 *     much as it uses it as a name (`isTitleTerm`). A phrase that is not one
 *     becomes a chip. A phrase that is stays in `words` AND is listed in
 *     `offers`, so the reader chooses it; nothing is converted silently (the
 *     silent field-name 302 is the behaviour this replaces).
 *   - The question is asked of the phrase, once, and never of its words. A
 *     per-word test makes every place that contains a common word an offer for
 *     good: `new` is in titles ("New Grad Engineer"), so `new york` could never
 *     be a chip, and the same goes for anything with `of`, `san`, `the` or `st`
 *     in it. What matters is whether "new york" is a title term, which is a
 *     different fact from whether "new" is. A single word is its own phrase, so
 *     `phoenix` is asked about as `phoenix`.
 *
 * THE VOCABULARY IS INJECTED (`Lexicon`). The place table is built by the
 * geography work and the company and title-term sets come from the live board;
 * this file imports none of them, so it has no I/O, no database and nothing to
 * mock, and a test hands it a ten-line fake. Because the lexicon is what the
 * reader's words are measured against, the one normalisation both sides must
 * share is exported: `normalisePhrase`. Build the lexicon's keys with it.
 *
 * THREE THINGS THE LEXICON MUST DO that are not obvious from its types:
 *   1. Index every phrase through `normalisePhrase`, including multi-word
 *      aliases written the way people write them ("London, UK" arrives here as
 *      `london uk`, because edge punctuation is trimmed per word).
 *   2. Offer the longest alias a reader might type. Matching is longest first up
 *      to four words, but a reader who types "London, United Kingdom" only gets
 *      London if `london united kingdom` is itself an alias; otherwise `london`
 *      and `united kingdom` match one after the other and the last place wins.
 *   3. Resolve a place KEY (`GB/London`, `US-MD`) and a company's canonical name
 *      through `place()` and `company()` too. `chipsFromParams` only holds a key
 *      from the address, and these two functions are its only way to turn it
 *      back into a label.
 *
 * ONE FACT OF EACH KIND, except remote. A reader who types two pays, two ages,
 * two places or two companies has changed their mind, and the last one typed
 * wins; the earlier one leaves no trace in `words` or `chips` (a "London" kept
 * as a word would silently narrow the search to descriptions that say London,
 * which is the opposite of changing the mind). A posting has one company and one
 * location, so two of those could only ever count zero. Remote kinds are the
 * exception: `remote hybrid` means "either", so they accumulate and
 * de-duplicate. Offers never supersede anything; an offer is a word.
 *
 * CHIPS COME OUT IN ONE FIXED ORDER, not input order: place, company, remote
 * (remote, hybrid, onsite), pay, age. The address cannot remember what order the
 * reader typed in, so the order after a reload is this one; emitting it from the
 * parser too means the box does not rearrange itself when the page comes back,
 * and `chipsFromParams(chipsToParams(chips))` equals `chips` exactly.
 *
 * WHAT IS DELIBERATELY NOT A FACT, each one a mistake the first draft of any
 * parser makes:
 *   - A bare number. `3d`, `2025`, `150` are words. Pay needs a `k`, a currency
 *     sign or comma thousands, or a number reads as money in every job ad that
 *     says "5 years".
 *   - `401k`, with or without `+` or `>`: the retirement plan, not $401,000. Only
 *     `$401k` or a range such as `400-410k` is pay.
 *   - `office`. "Office manager" is a title. Only `in office`, `in-office`,
 *     `on-site`, `onsite` and `on site` mean on-site.
 *   - `new`. "New grad" and "new business" are titles; the design's `new` age
 *     chip was dropped for this. `today` and `this week` are unambiguous.
 *   - A pay with a ceiling in front of it (`under 150k`, `up to 150k`,
 *     `max 150k`, `<150k`). The chip is a FLOOR; applying it to a ceiling would
 *     invert what was asked, so the whole phrase stays words instead.
 *   - Anything in double quotes. A quoted phrase is one word, never a chip: it is
 *     the reader's way to say "this is text" (`"remote support"`).
 *
 * LOUD ABOUT BOUNDS RATHER THAN QUIET. Pay clamps to 1..2000 (thousands) and age
 * to 1..90 days: a chip the reader can see ("posted within 90 days") is more
 * honest than the words `last`, `365`, `days` quietly searched in descriptions.
 * Text beyond 200 characters is never read, so a pasted page cannot become 40
 * chips or a slow lexicon scan.
 */

export type RemoteKind = 'remote' | 'hybrid' | 'onsite';

export type Chip =
  | { kind: 'remote'; value: RemoteKind }
  | { kind: 'pay'; minK: number } // a floor, in thousands
  | { kind: 'age'; maxDays: number } // posted within N days
  | { kind: 'place'; key: string; label: string }
  | { kind: 'company'; name: string };

export interface Lexicon {
  /** Exact lookup of a normalised phrase (lower case, accents folded, single spaces). */
  place(phrase: string): { key: string; label: string } | null;
  company(phrase: string): string | null;
  /** True when this normalised phrase is used on the board as a TITLE term at least as
      much as it is used as a place or company name. The real implementation decides it
      from data (title frequency vs place/company frequency); the parser only asks. */
  isTitleTerm(phrase: string): boolean;
}

export interface ParseResult {
  /** Free-text terms left after facts are taken out, in input order. Quoted phrases stay whole, without quotes. */
  words: string[];
  /** Facts applied outright. */
  chips: Chip[];
  /** Facts that are ALSO plausible words: kept in `words`, offered to the reader as a chip they may choose. */
  offers: Array<{ span: string; chip: Chip }>;
}

/** Characters read from the box. Past this the text is cut before anything else
    happens, so a facts-looking token at character 201 is never a chip. */
export const SEARCH_MAX_CHARS = 200;
/** Pay floors, in thousands. 2000 is two million, past any posting's pay. */
export const PAY_MIN_K = 1;
export const PAY_MAX_K = 2000;
/** Age windows, in days. The board carries postings older than 90 days; a chip
    stops at 90 because the age strip beside it is the control for longer spans. */
export const AGE_MIN_DAYS = 1;
export const AGE_MAX_DAYS = 90;
/** The longest place or company alias looked up, in words ("ho chi minh city"). */
export const LEXICON_MAX_WORDS = 4;

/** Canonical order for remote kinds, in chips and in the address. */
export const REMOTE_KINDS: readonly RemoteKind[] = ['remote', 'hybrid', 'onsite'];

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Letters NFD does not take apart: they are single code points, not a base plus
    a mark, so stripping combining marks leaves them accented. Folded by hand so a
    reader typing `Malmo` finds `Malmö` and `Lodz` finds `Łódź`. */
const FOLD_EXTRA: Record<string, string> = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** Punctuation trimmed from BOTH ends of a word and nowhere else. Edges only,
    because the inside of a word is meaningful (`o'fallon`, `winston-salem`,
    `c++`, `node.js`) while a comma or full stop at the edge is the reader
    separating words ("designer, london" and "st." both mean the bare word). */
const EDGE_PUNCTUATION = /^[,;:!?.()[\]{}"'“”‘’…]+|[,;:!?.()[\]{}"'“”‘’…]+$/g;

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ßøæœłđðþı]/g, (c) => FOLD_EXTRA[c] ?? c);
}

function normaliseWord(raw: string): string {
  return fold(raw).replace(EDGE_PUNCTUATION, '');
}

function hasAlphanumeric(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * The one normalisation shared by the parser and whatever builds the lexicon:
 * lower case, accents folded (`München` -> `munchen`, `Łódź` -> `lodz`), edge
 * punctuation trimmed from each word, runs of whitespace made one space. Words
 * are normalised one at a time and joined, so "London, UK" and `london uk` are
 * the same phrase, and a phrase of only punctuation is the empty string.
 */
export function normalisePhrase(text: string): string {
  return String(text ?? '')
    .split(/\s+/)
    .map(normaliseWord)
    .filter((word) => word !== '')
    .join(' ');
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Tok {
  /** As typed. For a quoted phrase: the text inside the quotes, spaces collapsed. */
  raw: string;
  /** A quoted phrase is always a word. It is also a wall: no fact spans it. */
  quoted: boolean;
  /** `normaliseWord(raw)`; empty for a quoted phrase, which is never matched. */
  norm: string;
}

/** Straight and curly double quotes. A phone or a Mac turns `"` into `“ ”` on
    its own, and a reader cannot see the difference, so all three open and close. */
const QUOTES = '"“”';

/**
 * Whitespace separates tokens. A double quote at the START of a token opens a
 * phrase that runs to the next quote, or to the end of the text: a reader part
 * way through typing `"remote supp` plainly means the phrase, and the typeahead
 * sends exactly that text. A quote in the middle of a token is just a character.
 * A token or phrase with no letter or digit in it (`&`, `-`, `""`) is dropped:
 * it can match nothing and would only become noise in a text query.
 */
function tokenise(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (QUOTES.includes(ch)) {
      let j = i + 1;
      while (j < n && !QUOTES.includes(text.charAt(j))) j += 1;
      const inner = text.slice(i + 1, j).replace(/\s+/g, ' ').trim();
      if (hasAlphanumeric(inner)) out.push({ raw: inner, quoted: true, norm: '' });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(text.charAt(j))) j += 1;
    const raw = text.slice(i, j);
    out.push({ raw, quoted: false, norm: normaliseWord(raw) });
    i = j;
  }
  return out;
}

/** A word as it goes into `words`: the reader's own spelling and case, minus the
    commas and semicolons they typed between terms. Null when nothing searchable
    is left. */
function wordFrom(tok: Tok): string | null {
  if (tok.quoted) return tok.raw;
  const word = tok.raw.replace(/^[,;]+|[,;]+$/g, '');
  return hasAlphanumeric(word) ? word : null;
}

function tokenAt(toks: readonly Tok[], i: number): Tok | null {
  const tok = toks[i];
  return tok !== undefined && !tok.quoted ? tok : null;
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

const DASH = '-–—';
/** `150`, `1500`, `150.5`, or `150,000` (comma thousands, optional decimals). */
const NUMBER = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const AMOUNT = new RegExp(`^([$€£])?(${NUMBER})(k)?$`);
const RANGE = new RegExp(`^(.+?)([${DASH}])(.+)$`);

interface Amount {
  num: number;
  k: boolean;
  currency: boolean;
  comma: boolean;
}

function readAmount(text: string): Amount | null {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const digits = m[2] ?? '';
  return { num: Number(digits.replace(/,/g, '')), k: m[3] === 'k', currency: Boolean(m[1]), comma: digits.includes(',') };
}

/** Money, as opposed to a number: it carries a `k`, a currency sign or comma thousands. */
function isQualified(a: Amount): boolean {
  return a.k || a.currency || a.comma;
}

/**
 * An amount in thousands. With a `k` it is what it says (`150k` is 150). Without
 * one, a value of 1000 or more is whole currency units (`$150,000` and
 * `$150000` are 150), and a smaller one is read as thousands (`$150` is 150):
 * nobody filters an annual-pay board by `$150` a year, and an hourly rate is
 * written `$45/hr`, which is not an amount at all and stays a word.
 */
function inThousands(a: Amount, inheritK: boolean): number {
  return a.k || inheritK ? a.num : a.num >= 1000 ? a.num / 1000 : a.num;
}

/** The floor written into a chip. Rounded DOWN, never up: a reader who types
    `$95,500` must still see the posting that pays $95,500, so the floor may
    undercut what was typed by a fraction of a thousand and never exceed it. */
function payFloor(thousands: number): number {
  return Math.min(PAY_MAX_K, Math.max(PAY_MIN_K, Math.floor(thousands)));
}

/** The text of a token as the pay rules read it: folded, with the punctuation a
    sentence puts after a number (`150k,`) trimmed, but not the `+`, `>` or `$`
    that are part of the syntax. */
function payCore(raw: string): string {
  return fold(raw).replace(/^\(+|[.,;:!?)]+$/g, '');
}

/**
 * One pay expression in thousands, or null: an amount (`150k`, `$150,000`,
 * `€90k`), optionally written as a floor (`>150k`, `>=150k`, `150k+`), or a range
 * (`150-200k`, `150k-200k`, `$150k–$200k`) whose floor is its lower bound.
 *
 * In a range a bare number takes its partner's unit (`150-200k` is 150k to 200k)
 * but a range of two bare numbers (`100-150`, `2024-2026`) is not money. A range
 * written backwards (`200-150k`) reads the way round it can only have meant, the
 * same repair board-query makes for a backwards age range.
 */
function readPay(core: string): number | null {
  if (/^(<=|<|≤)/.test(core)) return null; // a ceiling; the caller leaves it as words
  const body = core.replace(/^(>=|>|≥)/, '').replace(/\+$/, '');

  const single = readAmount(body);
  if (single !== null) {
    if (!isQualified(single)) return null;
    // `401k` is the retirement plan. Only a currency sign makes it a salary.
    if (single.k && !single.currency && single.num === 401) return null;
    return payFloor(inThousands(single, false));
  }

  const range = RANGE.exec(body);
  if (range === null) return null;
  const lo = readAmount(range[1] ?? '');
  const hi = readAmount(range[3] ?? '');
  if (lo === null || hi === null) return null;
  if (!isQualified(lo) && !isQualified(hi)) return null;
  return payFloor(Math.min(inThousands(lo, hi.k), inThousands(hi, lo.k)));
}

/** `150k - 200k`, `150k to 200k`, `150k- 200k` and `150k -200k` are one range
    typed with spaces. Join the tokens the way the reader would have without
    them, then let `readPay` decide. */
function joinRange(parts: readonly string[]): string | null {
  if (parts.length === 3) {
    const [a = '', mid = '', b = ''] = parts;
    if (mid === 'to' || new RegExp(`^[${DASH}]$`).test(mid)) return `${a}-${b}`;
    return null;
  }
  if (parts.length === 2) {
    const [a = '', b = ''] = parts;
    if (new RegExp(`[${DASH}]$`).test(a) || new RegExp(`^[${DASH}]`).test(b)) return `${a}${b}`;
  }
  return null;
}

/** Words that put the number after them at a FLOOR. They are consumed with it. */
const FLOOR_LEAD_ONE = new Set(['over', 'above', 'min', 'minimum', '>', '>=', '≥']);
const FLOOR_LEAD_TWO = new Set(['at least', 'more than']);
/** Words that put the number after them at a CEILING, which a floor chip cannot say. */
const CEILING_ONE = new Set(['under', 'below', 'max', 'maximum', 'upto', '<', '<=', '≤']);
const CEILING_TWO = new Set(['up to', 'less than', 'at most']);

function followsCeiling(toks: readonly Tok[], i: number): boolean {
  const one = tokenAt(toks, i - 1);
  if (one === null) return false;
  if (CEILING_ONE.has(one.norm)) return true;
  const two = tokenAt(toks, i - 2);
  return two !== null && CEILING_TWO.has(`${two.norm} ${one.norm}`);
}

/** The pay expression starting at `i` (one, two or three tokens), longest first. */
function expressionAt(toks: readonly Tok[], i: number): { span: number; minK: number } | null {
  const cores: string[] = [];
  for (let k = 0; k < 3; k += 1) {
    const tok = tokenAt(toks, i + k);
    if (tok === null) break;
    cores.push(payCore(tok.raw));
  }
  for (const span of [3, 2]) {
    if (cores.length < span) continue;
    const joined = joinRange(cores.slice(0, span));
    const minK = joined === null ? null : readPay(joined);
    if (minK !== null) return { span, minK };
  }
  const minK = cores.length > 0 ? readPay(cores[0] ?? '') : null;
  return minK === null ? null : { span: 1, minK };
}

function matchPay(toks: readonly Tok[], i: number): { span: number; minK: number } | null {
  if (followsCeiling(toks, i)) return null;
  const first = tokenAt(toks, i);
  if (first === null) return null;
  const second = tokenAt(toks, i + 1);

  let lead = 0;
  if (FLOOR_LEAD_ONE.has(first.norm)) lead = 1;
  else if (second !== null && FLOOR_LEAD_TWO.has(`${first.norm} ${second.norm}`)) lead = 2;
  if (lead > 0) {
    const after = expressionAt(toks, i + lead);
    if (after !== null) return { span: lead + after.span, minK: after.minK };
    // A lone `over` is an ordinary word; fall through and read the token as itself.
  }
  return expressionAt(toks, i);
}

// ---------------------------------------------------------------------------
// Remote and age
// ---------------------------------------------------------------------------

function matchRemote(toks: readonly Tok[], i: number): { span: number; kind: RemoteKind } | null {
  const first = tokenAt(toks, i);
  if (first === null) return null;
  switch (first.norm) {
    case 'remote':
      return { span: 1, kind: 'remote' };
    case 'hybrid':
      return { span: 1, kind: 'hybrid' };
    case 'onsite':
    case 'on-site':
    case 'in-office':
      return { span: 1, kind: 'onsite' };
  }
  const second = tokenAt(toks, i + 1);
  if (second === null) return null;
  const pair = `${first.norm} ${second.norm}`;
  return pair === 'on site' || pair === 'in office' ? { span: 2, kind: 'onsite' } : null;
}

function ageDays(days: number): number {
  return Math.min(AGE_MAX_DAYS, Math.max(AGE_MIN_DAYS, days));
}

/**
 * `today`, `this week`, `past week`, `last week` (7 days), and `last|past N`
 * followed by a unit: hours (rounded UP to whole days, so `last 24 hours` is 1
 * and `last 48 hours` is 2), days, or weeks. The bare word `new` is deliberately
 * absent: it is a job-title word far more often than a window.
 */
function matchAge(toks: readonly Tok[], i: number): { span: number; maxDays: number } | null {
  const first = tokenAt(toks, i);
  if (first === null) return null;
  if (first.norm === 'today') return { span: 1, maxDays: 1 };
  const second = tokenAt(toks, i + 1);
  if (second === null) return null;
  const thisOrPast = first.norm === 'this' || first.norm === 'past' || first.norm === 'last';
  if (thisOrPast && second.norm === 'week') return { span: 2, maxDays: 7 };
  if (first.norm !== 'past' && first.norm !== 'last') return null;
  if (!/^\d{1,4}$/.test(second.norm)) return null;
  const unit = tokenAt(toks, i + 2);
  if (unit === null) return null;
  const n = Number(second.norm);
  switch (unit.norm) {
    case 'hour':
    case 'hours':
    case 'hr':
    case 'hrs':
      return { span: 3, maxDays: ageDays(Math.ceil(n / 24)) };
    case 'day':
    case 'days':
      return { span: 3, maxDays: ageDays(n) };
    case 'week':
    case 'weeks':
      return { span: 3, maxDays: ageDays(n * 7) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Places and companies
// ---------------------------------------------------------------------------

interface LexiconHit {
  span: number;
  chip: Chip;
}

/**
 * The longest run of words starting at `i` (four, then three, two, one) that the
 * lexicon knows as a place, or failing that as a company. Place is asked first
 * at every length, so a name that is both ("paris") is the place, and the longer
 * run wins over the shorter one wherever both exist ("new york city" over "new
 * york"). A quoted phrase or a token with no letters ends the run.
 */
function matchLexicon(toks: readonly Tok[], i: number, lex: Lexicon): LexiconHit | null {
  const norms: string[] = [];
  for (let k = 0; k < LEXICON_MAX_WORDS; k += 1) {
    const tok = tokenAt(toks, i + k);
    if (tok === null || !hasAlphanumeric(tok.norm)) break;
    norms.push(tok.norm);
  }
  for (let span = norms.length; span >= 1; span -= 1) {
    const phrase = norms.slice(0, span).join(' ');
    const place = lex.place(phrase);
    if (place !== null) return { span, chip: { kind: 'place', key: place.key, label: place.label } };
    const company = lex.company(phrase);
    if (company !== null) return { span, chip: { kind: 'company', name: company } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

interface Facts {
  place: { key: string; label: string } | null;
  company: string | null;
  remote: ReadonlySet<RemoteKind>;
  pay: number | null;
  age: number | null;
}

/** Chips in the one order everything uses: place, company, remote kinds, pay, age. */
function canonicalChips(facts: Facts): Chip[] {
  const chips: Chip[] = [];
  if (facts.place !== null) chips.push({ kind: 'place', key: facts.place.key, label: facts.place.label });
  if (facts.company !== null) chips.push({ kind: 'company', name: facts.company });
  for (const value of REMOTE_KINDS) if (facts.remote.has(value)) chips.push({ kind: 'remote', value });
  if (facts.pay !== null) chips.push({ kind: 'pay', minK: facts.pay });
  if (facts.age !== null) chips.push({ kind: 'age', maxDays: facts.age });
  return chips;
}

/**
 * The text of the box, read as chips, words and offers.
 *
 * Longest-first, left to right: at each token the syntax facts are tried first
 * (pay, age, remote), then the lexicon; the first that matches consumes its
 * tokens and the scan resumes after them. A token nothing claims is a word.
 */
export function parseSearch(text: string, lex: Lexicon): ParseResult {
  const toks = tokenise(String(text ?? '').slice(0, SEARCH_MAX_CHARS));
  const words: string[] = [];
  const offers: ParseResult['offers'] = [];
  const offered = new Set<string>();
  const remote = new Set<RemoteKind>();
  let pay: number | null = null;
  let age: number | null = null;
  let place: { key: string; label: string } | null = null;
  let company: string | null = null;

  const keepWord = (tok: Tok) => {
    const word = wordFrom(tok);
    if (word !== null) words.push(word);
  };

  for (let i = 0; i < toks.length; ) {
    const tok = toks[i];
    if (tok === undefined) break;
    if (tok.quoted) {
      keepWord(tok);
      i += 1;
      continue;
    }

    const payHit = matchPay(toks, i);
    if (payHit !== null) {
      pay = payHit.minK;
      i += payHit.span;
      continue;
    }
    const ageHit = matchAge(toks, i);
    if (ageHit !== null) {
      age = ageHit.maxDays;
      i += ageHit.span;
      continue;
    }
    const remoteHit = matchRemote(toks, i);
    if (remoteHit !== null) {
      remote.add(remoteHit.kind);
      i += remoteHit.span;
      continue;
    }

    const hit = matchLexicon(toks, i, lex);
    if (hit !== null) {
      const matched = toks.slice(i, i + hit.span);
      // Asked once, of the whole phrase, with the same normalised text that
      // matched: never word by word (see the header).
      const phrase = matched.map((t) => t.norm).join(' ');
      if (lex.isTitleTerm(phrase)) {
        // Used as a title term at least as much as a name: keep every token as
        // text and offer the fact.
        for (const t of matched) keepWord(t);
        const key = `${phrase}|${JSON.stringify(hit.chip)}`;
        if (!offered.has(key)) {
          offered.add(key);
          offers.push({ span: matched.map((t) => t.raw).join(' '), chip: hit.chip });
        }
      } else if (hit.chip.kind === 'place') {
        place = { key: hit.chip.key, label: hit.chip.label };
      } else if (hit.chip.kind === 'company') {
        company = hit.chip.name;
      }
      i += hit.span;
      continue;
    }

    keepWord(tok);
    i += 1;
  }

  return { words, chips: canonicalChips({ place, company, remote, pay, age }), offers };
}

// ---------------------------------------------------------------------------
// Chips and the address
// ---------------------------------------------------------------------------

/**
 * Chips to query parameters. The names are fixed because the SQL layer reads the
 * same ones: `place` (the place KEY, not its label), `company` (the canonical
 * name), `remote`, `pay_min` (thousands), `age_max` (days). Only the parameters
 * that were stated are written, so no chips is an empty object and the bare
 * board stays bare.
 *
 * `remote` is a comma list, in canonical order, when more than one kind is
 * chosen (`remote=remote,hybrid`): a Record of strings has one slot per name and
 * "remote or hybrid" is a real thing to ask for. Anywhere a kind appears twice,
 * or a place, company, pay or age chip appears twice, the last one wins, the
 * same rule `parseSearch` applies to typed text.
 */
export function chipsToParams(chips: readonly Chip[]): Record<string, string> {
  let place: string | null = null;
  let company: string | null = null;
  let pay: number | null = null;
  let age: number | null = null;
  const remote = new Set<RemoteKind>();
  for (const chip of chips) {
    switch (chip.kind) {
      case 'place':
        if (chip.key !== '') place = chip.key;
        break;
      case 'company':
        if (chip.name !== '') company = chip.name;
        break;
      case 'remote':
        remote.add(chip.value);
        break;
      case 'pay':
        if (Number.isFinite(chip.minK)) pay = payFloor(chip.minK);
        break;
      case 'age':
        if (Number.isFinite(chip.maxDays)) age = ageDays(Math.floor(chip.maxDays));
        break;
    }
  }
  const out: Record<string, string> = {};
  if (place !== null) out.place = place;
  if (company !== null) out.company = company;
  if (remote.size > 0) out.remote = REMOTE_KINDS.filter((kind) => remote.has(kind)).join(',');
  if (pay !== null) out.pay_min = String(pay);
  if (age !== null) out.age_max = String(age);
  return out;
}

/** A whole number of digits only: `150` and never `150.5`, `-5`, `1e3` or `150k`. */
function wholeNumber(value: string, min: number, max: number): number | null {
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** A parameter value as the lexicon sees it: the normalised phrase first, then
    exactly as written, since a lexicon may index its keys either way. */
function lookup<T>(value: string, find: (phrase: string) => T | null): T | null {
  const text = value.trim().slice(0, SEARCH_MAX_CHARS);
  if (text === '') return null;
  const normalised = normalisePhrase(text);
  const hit = normalised === '' ? null : find(normalised);
  return hit ?? (text === normalised ? null : find(text));
}

/**
 * The address, read back as chips: the inverse of `chipsToParams`, and as
 * suspicious as board-query is of everything in it. Each parameter is checked on
 * its own and a bad one is DROPPED, never repaired and never an error, so a stale
 * bookmark is the board without that narrowing: an unknown remote kind, a pay or
 * age that is not a whole number in range (`pay_min=0`, `pay_min=150.5`,
 * `age_max=365`), a place or company the lexicon does not know. A parameter
 * given twice takes the last value that is valid. Chips come out in the
 * canonical order.
 *
 * Unlike the typed box, a number out of range is dropped here and not clamped:
 * nobody typed it, so nobody is owed a guess at what they meant. (`age_max` is
 * also the age strip's parameter, which reads any whole number of days; a value
 * past 90 is the strip's to honour and is simply not a chip.)
 */
export function chipsFromParams(params: URLSearchParams, lex: Pick<Lexicon, 'place' | 'company'>): Chip[] {
  let place: { key: string; label: string } | null = null;
  let company: string | null = null;
  let pay: number | null = null;
  let age: number | null = null;
  const remote = new Set<RemoteKind>();

  for (const value of params.getAll('place')) {
    const hit = lookup(value, (phrase) => lex.place(phrase));
    if (hit !== null) place = { key: hit.key, label: hit.label };
  }
  for (const value of params.getAll('company')) {
    const hit = lookup(value, (phrase) => lex.company(phrase));
    if (hit !== null) company = hit;
  }
  for (const value of params.getAll('remote')) {
    for (const part of value.split(',')) {
      const kind = part.trim().toLowerCase();
      const known = REMOTE_KINDS.find((candidate) => candidate === kind);
      if (known !== undefined) remote.add(known);
    }
  }
  for (const value of params.getAll('pay_min')) {
    const n = wholeNumber(value, PAY_MIN_K, PAY_MAX_K);
    if (n !== null) pay = n;
  }
  for (const value of params.getAll('age_max')) {
    const n = wholeNumber(value, AGE_MIN_DAYS, AGE_MAX_DAYS);
    if (n !== null) age = n;
  }
  return canonicalChips({ place, company, remote, pay, age });
}
