/**
 * letter-lint.ts: the mechanical style checks a cover letter must pass, the
 * TypeScript port of the cover-letter skill's lint_letter.py.
 *
 * WHY THE BUZZWORD LIST IS COVER-LETTER TELLS, NOT THE COPY GATE'S LIST. The
 * copy gate (test/gates/copy.mjs) scans all of src/ for the banned vocabulary
 * in test/banned-vocabulary.json and hard-fails on any literal, so this module
 * cannot list those words to catch them. It also cannot import that file: this
 * module ships in the runtime bundle AND is copied into the visual gate's
 * frozen-fixture tree, which copies only src/ and its side directories, never
 * test/, so a `../../test/...` import breaks that build. So the buzzword list
 * here is the cover-letter skill's OWN tells (spearheaded, orchestrated, "proven
 * track record", and the rest), none of which is a copy-gate-banned word. The
 * broader machine-writing vocabulary the copy gate bans is steered against in
 * the prompt (COVER_SYSTEM_MESSAGE) rather than caught here.
 *
 * WHAT IT IS NOT. This is a linter, not the fact checker. It never sees the
 * record; it reads only the finished prose for the tells the skill's rubric
 * names. The fact rules (a number with no source, a first-person claim about a
 * requirement) live in letter-verify.ts, which calls this after its own
 * content checks pass. Every finding is advisory data returned to the caller;
 * nothing here strips or rewrites a person's letter.
 */

export interface LintFinding {
  readonly level: 'fail' | 'warn';
  readonly rule: string;
  readonly detail: string;
}

/* The cover-letter buzzword tells, the skill's own list. Literals are safe
   here because none of these is a copy-gate-banned word (the copy gate scans
   this file and would flag one that was, which is the check that keeps this
   honest). */
const STOCK_OPENERS: readonly RegExp[] = [
  /\bi am writing to (apply|express|inquire)/i,
  /\bi am excited to (apply|express|share|submit)/i,
  /\bi would like to (apply|express|submit)/i,
  /\bplease (accept|find) (my|attached|the attached)/i,
  /\bi am reaching out\b/i
];
const NEVER_SALUTATIONS: readonly RegExp[] = [/to whom it may concern/i, /\bdear sir(s| or madam| \/ madam)?\b/i];
const EXTRA_BUZZWORDS: readonly string[] = [
  'spearheaded', 'orchestrated', 'championed', 'unwavering', 'transformative',
  'proven track record', 'results-driven', 'hit the ground running', 'wealth of experience',
  'go-getter', 'team player', 'detail-oriented', 'self-starter', 'passionate about'
];
const WEAK_VERBS: readonly RegExp[] = [
  /\bresponsible for\b/i, /\bhelped to\b/i, /\bworked on\b/i, /\bassisted (with|in)\b/i,
  /\bparticipated in\b/i, /\binvolved in\b/i
];
const GENERIC_ENTHUSIASM: readonly RegExp[] = [
  /\bdream (job|role|company)\b/i, /\bperfect fit\b/i, /\bi would be thrilled\b/i, /\bhonou?red to\b/i
];
const SUPERLATIVES: readonly RegExp[] = [
  /\bworld.?class\b/i, /\btop.?tier\b/i, /\bunparalleled\b/i, /\bbest.?in.?class\b/i, /\bsecond to none\b/i
];
const PLACEHOLDERS: readonly RegExp[] = [
  /\[[^\]]*\]/, /\{\{[^}]*\}\}/, /\blorem ipsum\b/i, /\bxxxx+\b/i, /\btodo\b/i, /\byour name here\b/i
];
/* Dashes the house rule forbids: figure (U+2012), en (U+2013), em (U+2014),
   horizontal bar (U+2015), and the minus sign (U+2212). Written as code points,
   never literals, because gate 3 hard-fails on one typed into source. The plain
   hyphen (U+002D) is allowed. */
const FORBIDDEN_DASHES = /[\u2012\u2013\u2014\u2015\u2212]/;

/* Word-count thresholds, the skill's length rule. The defaults are the skill's
   general one-page band; a context pack (cover-context.ts) can pass a tighter
   or looser band for its field and situation (a short tech note, a longer
   corporate letter) via lintLetter's optional `bounds`. */
const HARD_MIN_WORDS = 150;
const HARD_MAX_WORDS = 500;
const SOFT_MIN_WORDS = 250;
const SOFT_MAX_WORDS = 400;

/** A letter's length band: below `hardMin` or above `hardMax` fails; outside
    the soft band warns. */
export interface WordBounds {
  readonly hardMin: number;
  readonly hardMax: number;
  readonly softMin: number;
  readonly softMax: number;
}

const DEFAULT_BOUNDS: WordBounds = {
  hardMin: HARD_MIN_WORDS,
  hardMax: HARD_MAX_WORDS,
  softMin: SOFT_MIN_WORDS,
  softMax: SOFT_MAX_WORDS
};

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** How many buzzword tells the text carries: each cover-letter tell counted
    once per occurrence, single words inflected (plural, past, gerund) and
    phrases matched as written with flexible whitespace. */
export function countBuzzwords(text: string): number {
  let count = 0;
  for (const tell of EXTRA_BUZZWORDS) {
    const body = escapeRegExp(tell).replace(/\\ /g, '\\s+');
    const pattern = tell.includes(' ')
      ? new RegExp(`\\b${body}\\b`, 'gi')
      : new RegExp(`\\b${body}(?:s|es|ed|ing)?\\b`, 'gi');
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentences(text: string): readonly string[] {
  return text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Lint one whole letter's prose. Returns every finding, `fail` and `warn`.
 * letter-verify.ts treats any `fail` as a rejection and passes `warn`s up as
 * advisory. Pure: it reads only the text it is given.
 */
export function lintLetter(text: string, bounds: WordBounds = DEFAULT_BOUNDS): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const words = wordCount(text);

  // Length (L1 hard, L2 soft), against the pack's band or the default one-page band.
  if (words < bounds.hardMin) findings.push({ level: 'fail', rule: 'length', detail: `only ${words} words; this letter is at least ${bounds.hardMin}` });
  else if (words > bounds.hardMax) findings.push({ level: 'fail', rule: 'length', detail: `${words} words; this letter is at most ${bounds.hardMax}` });
  else if (words < bounds.softMin || words > bounds.softMax) findings.push({ level: 'warn', rule: 'length', detail: `${words} words; the target is ${bounds.softMin} to ${bounds.softMax}` });

  // Stock openers and the salutations the skill forbids (L3).
  for (const pattern of STOCK_OPENERS) {
    if (pattern.test(text)) { findings.push({ level: 'fail', rule: 'stock-opener', detail: 'opens with a stock phrase' }); break; }
  }
  for (const pattern of NEVER_SALUTATIONS) {
    if (pattern.test(text)) { findings.push({ level: 'fail', rule: 'salutation', detail: 'uses a salutation the skill forbids' }); break; }
  }

  // Buzzwords (L4 fail, L5 warn).
  const buzz = countBuzzwords(text);
  if (buzz >= 4) findings.push({ level: 'fail', rule: 'buzzwords', detail: `${buzz} buzzword tells; four or more reads as boilerplate` });
  else if (buzz >= 2) findings.push({ level: 'warn', rule: 'buzzwords', detail: `${buzz} buzzword tells` });

  // Dashes (L6).
  if (FORBIDDEN_DASHES.test(text)) findings.push({ level: 'fail', rule: 'dash', detail: 'contains an em or en dash; use a comma, colon, parentheses, or a period' });

  // Placeholder residue (L7).
  for (const pattern of PLACEHOLDERS) {
    if (pattern.test(text)) { findings.push({ level: 'fail', rule: 'placeholder', detail: 'contains placeholder or template residue' }); break; }
  }

  // Weak, generic, and superlative tells (L8 warns).
  if (WEAK_VERBS.some((p) => p.test(text))) findings.push({ level: 'warn', rule: 'weak-verb', detail: 'uses a weak verb ("responsible for", "worked on")' });
  if (GENERIC_ENTHUSIASM.some((p) => p.test(text))) findings.push({ level: 'warn', rule: 'generic-enthusiasm', detail: 'uses generic enthusiasm ("dream job", "perfect fit")' });
  if (SUPERLATIVES.filter((p) => p.test(text)).length >= 2) findings.push({ level: 'warn', rule: 'superlatives', detail: 'stacks superlatives about the person' });

  // A sentence over 40 words is hard to read aloud (L8).
  const longest = Math.max(0, ...sentences(text).map(wordCount));
  if (longest > 40) findings.push({ level: 'warn', rule: 'sentence-length', detail: `a sentence runs ${longest} words` });

  return findings;
}
