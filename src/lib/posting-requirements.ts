/**
 * posting-requirements.ts: which lines of a posting a cover letter should
 * answer, as strings the engine chose.
 *
 * The cover letter's proof paragraph names the requirement it answers. This
 * file decides which requirements those are, and it decides by the one measure
 * the engine is allowed to own: the strongest TRUE overlap. A posting line
 * scores higher when it sits under a requirements heading, when it is shaped
 * like a requirement, and, the load-bearing part, when it shares words with the
 * person's own record. The lines chosen are the ones the record can actually
 * answer, so naming a requirement is never a promise the record cannot keep.
 *
 * A SCORER, NOT A PARSER. A posting with clean headings and a bullet list gives
 * clean requirements; a posting with none degrades to "the lines the record
 * overlaps", which is honest rather than wrong. Everything here is strings and
 * numbers; nothing it returns is ever asserted as a fact about the person. The
 * result is a LetterTarget (provider.ts), the employer's own words, which the
 * letter verifier then holds a first-person claim apart from.
 *
 * PROVIDER ISOLATION HOLDS. This file reads a Job, but a provider never sees
 * what this file returns except as the plain LetterTarget strings the engine
 * selected, exactly as a LockedFactSlot carries record text the engine
 * selected. tailor.ts is the only caller, the one place that already holds a
 * Job.
 */

import type { Target } from './tailor';
import type { LetterTarget } from './provider';
import { classifyField, type CoverField } from './cover-context';
import { extractWords, plainTextFromHtml } from './vocabulary';

/** Lines shorter or longer than this (in words) are not requirement lines: a
    fragment is noise, a paragraph is prose. */
const MIN_LINE_WORDS = 4;
const MAX_LINE_WORDS = 45;
const MAX_REQUIREMENTS = 5;
const MAX_REQUIREMENT_CHARS = 300;

/** A short line whose text says the section below it is requirements. */
const REQUIREMENT_HEADING = /requirement|qualification|what you.?ll (bring|need|do)|we.?re looking for|about you|you have|must have|you.?ll have|who you are/i;

/** A short line that starts a section this file should stop scoring under
    (benefits, the company blurb, legal boilerplate). */
const OFF_TOPIC_HEADING = /benefit|perk|about (us|the (company|team|role))|who we are|why (join|work)|compensation|what we offer|equal opportunity/i;

/** A line shaped like a stated requirement. */
const REQUIREMENT_SHAPE = /^(\d+\+?\s*(years|yrs)|experience|proven|strong|deep|ability|track record|expert|familiar|you (have|are|can|will|bring)|must|comfortable)\b/i;

/** A line about benefits, pay, or legal status, never a skill requirement. */
const OFF_TOPIC_LINE = /\b(equal opportunity|benefits?|401\s?k|salary|compensation|we offer|perks?|insurance|visa|sponsorship|paid time off|pto)\b/i;

/** The salutation register a field takes. Tech and creative fields earn the
    warmer "Hi <Company> team," salutation (the skill blesses it for those);
    every other field stays formal. Kept as a narrow tech/formal binary because
    that is all the salutation ladder needs; the full field drives length and
    prompt guidance instead (see cover-context.ts). */
function registerFor(field: CoverField): 'tech' | 'formal' {
  return field === 'tech' || field === 'creative' ? 'tech' : 'formal';
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** A posting's HTML as plain lines: block-closing tags become newlines before
    the tag strip, so a list item or a paragraph lands on its own line, then
    each line's whitespace is normalized. */
function htmlToLines(html: string): readonly string[] {
  const withBreaks = html
    .replace(/<\/(li|p|div|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return plainTextFromHtml(withBreaks)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function isHeadingLength(line: string): boolean {
  return wordCount(line) <= 8;
}

function truncate(line: string): string {
  if (line.length <= MAX_REQUIREMENT_CHARS) return line;
  const cut = line.slice(0, MAX_REQUIREMENT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

interface Candidate {
  readonly text: string;
  readonly index: number;
  readonly score: number;
}

/** Score and rank the requirement lines in a set of plain lines. `useHeadings`
    is false for free text, which has no section structure to reward. */
function rankRequirements(
  lines: readonly string[],
  recordVocabulary: ReadonlySet<string>,
  useHeadings: boolean
): readonly string[] {
  const candidates: Candidate[] = [];
  let underRequirements = false;

  lines.forEach((line, index) => {
    if (useHeadings && isHeadingLength(line)) {
      if (REQUIREMENT_HEADING.test(line)) {
        underRequirements = true;
        return;
      }
      if (OFF_TOPIC_HEADING.test(line)) {
        underRequirements = false;
        return;
      }
    }

    const words = wordCount(line);
    if (words < MIN_LINE_WORDS || words > MAX_LINE_WORDS) return;

    let score = 0;
    if (underRequirements) score += 3;
    if (REQUIREMENT_SHAPE.test(line) || /\byears?\b/i.test(line)) score += 2;

    let shared = 0;
    for (const word of extractWords(line)) {
      if (recordVocabulary.has(word)) shared++;
    }
    score += Math.min(shared, 3);

    if (OFF_TOPIC_LINE.test(line)) score -= 3;

    if (score > 0) candidates.push({ text: line, index, score });
  });

  // Top MAX_REQUIREMENTS by score (ties broken by document order), then
  // re-sorted to document order, the employer's own priority. Each truncated.
  return [...candidates]
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, MAX_REQUIREMENTS)
    .sort((a, b) => a.index - b.index)
    .map((candidate) => truncate(candidate.text));
}

/**
 * The posting, reduced to the LetterTarget a provider may see. A verified
 * posting yields its own company and title plus the requirement lines the
 * record can best answer; a free-text target yields no company or title and
 * ranks requirement lines from its own text with no heading bonus.
 */
export function extractLetterTarget(target: Target, recordVocabulary: ReadonlySet<string>): LetterTarget {
  if (target.kind === 'free_text') {
    const lines = target.text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0);
    const field = classifyField(target.text);
    return {
      company: '',
      title: null,
      requirements: rankRequirements(lines, recordVocabulary, false),
      // Free text has no company to greet, so it never earns the warm "Hi
      // <Company> team," salutation: register (which only picks the salutation)
      // stays formal. The field is still classified: it drives the pack.
      register: 'formal',
      field
    };
  }

  const { job } = target;
  const lines = job.description_html ? htmlToLines(job.description_html) : [];
  const requirements = rankRequirements(lines, recordVocabulary, true);
  const field = classifyField(`${job.title ?? ''} ${job.company} ${lines.join(' ')}`);
  return {
    company: job.company,
    title: job.title ?? null,
    requirements,
    register: registerFor(field),
    field
  };
}
