/**
 * rank-reason.ts: the one line that says why a board row sits where it sits.
 *
 * The product's promise is that nothing orders the reader's board in a way the
 * reader cannot see. A row's `why` panel opens with this sentence, so the order
 * is never a thing a reader has to take on trust. It is pure and deterministic:
 * the same facts always give the same words, and it reads nothing but its
 * argument, so a test can pin every sentence and a server render and a unit test
 * cannot disagree.
 *
 * THE SENTENCE FOLLOWS THE SORT IN FORCE AND NAMES EVERY KEY THAT DECIDES.
 * "Matches the real order exactly" is the whole requirement, so each branch
 * below is written from the ORDER BY job-store.ts runs for that sort, key for
 * key. rank-reason.test.ts reads job-store.ts and fails when one of those
 * ORDER BY strings changes, so a reordering cannot ship with the old sentence.
 *
 *   best, exact words   tier, text rank, Deets (high first), age (newest first), id
 *   best, typo path     similarity, Deets, age, id
 *   Deets               Deets (high first), company, title, id
 *   pay                 the largest posted figure (none last), company, title, id
 *   age                 age in days (none last), company, title, id
 *
 * Two keys are left out of the words on purpose. `id` is only the last
 * tie-break that keeps a page from shuffling between loads, and no two postings a
 * reader could compare ever reach it. And the text rank (Postgres ts_rank_cd) is
 * stated as a rule, "the closer text match", never as a number: the store does
 * not return it, and printing a number we do not hold would be worse than
 * naming the rule honestly.
 *
 * WHICH SORT. `best` is the order typed words earn and only means something
 * while words are typed. A row that arrives under `best` with no tier and no
 * similarity (the store reports neither when there are no words) is on the
 * board's default order, which is Deets, so it reads that way.
 *
 * THE POSITION IS THE TRUE RANK IN THE WHOLE RESULT, page offset included, not
 * the place on the page. The caller owns that arithmetic (JobTable.astro).
 *
 * NO EM DASH AND NO CURLY QUOTE in anything this returns: the query is echoed
 * between straight quotes, the way every other rendered line on the site quotes.
 */
import type { BoardSort } from './board-query';

/** The field that completed a text match; the same union job-store.ts reports. */
export type MatchField = 'title' | 'company' | 'department' | 'description';

/** Which date an age was counted from, as the Age cell words it. */
export type AgeBasis = 'posted' | 'first_seen';

/** Everything the sentence is built from. A row carries these; nothing else is read. */
export interface RankFacts {
  /** Place in the WHOLE result, 1 for the first row of page 1. Page offset included. */
  position: number;
  /** The sort the rows are in. `best` with no tier and no similarity reads as Deets. */
  sort: BoardSort;
  /** Text-match rung: 0 title is the words, 1 all in title, 2 in title or company,
      3 anywhere. Null with no words, and null on the typo path. */
  tier: number | null;
  /** The lowest-weight field a word needed; only a tier 3 sentence uses it. */
  field: MatchField | null;
  /** True when this row came from the close-spelling (typo) path. */
  fuzzy: boolean;
  /** The similarity the typo path ordered by, 0 to 1. */
  fuzzyScore: number | null;
  /** The words as typed. */
  query: string;
  /** The row's Deets, out of 100. */
  deets: number;
  /** The row's age in whole days, the same count the Age cell is made from; null with no date. */
  ageDays: number | null;
  /** Posted or first seen; the Age cell says which, so this sentence must too. Default posted. */
  ageBasis?: AgeBasis;
  /** Whether the row has a pay figure the pay sort can read (the sort key, comp_top). */
  payStated: boolean;
}

/** The tie-break every non-text sort ends on, in plain words. */
const THEN_COMPANY = 'then company and title A to Z';

/** How much of a typed query the sentence will echo before it trims with "...". */
const QUERY_ECHO_MAX = 40;

/**
 * 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 12 -> "12th",
 * 13 -> "13th", 21 -> "21st", 101 -> "101st", 111 -> "111th". Thousands carry a
 * comma ("1,204th"), the way every count on the board is printed. A fraction is
 * floored and anything under 1 is not a place, so it is returned as the bare
 * number.
 */
export function ordinal(n: number): string {
  if (!Number.isFinite(n) || n < 1) return String(n);
  const whole = Math.floor(n);
  const lastTwo = whole % 100;
  const last = whole % 10;
  let suffix = 'th';
  if (lastTwo < 11 || lastTwo > 13) {
    if (last === 1) suffix = 'st';
    else if (last === 2) suffix = 'nd';
    else if (last === 3) suffix = 'rd';
  }
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${suffix}`;
}

/** The typed words, made safe to quote on one line: spaces collapsed, straight
    double quotes removed (they would unbalance the quoting), long ones trimmed. */
function echoQuery(query: string): string {
  const clean = query.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  if (clean === '') return '';
  return clean.length > QUERY_ECHO_MAX ? `${clean.slice(0, QUERY_ECHO_MAX - 3).trimEnd()}...` : clean;
}

/** "posted today", "posted 1 day ago", "first seen 12 days ago". */
function ageClause(days: number, basis: AgeBasis): string {
  const lead = basis === 'first_seen' ? 'first seen' : 'posted';
  const d = Math.max(0, Math.floor(days));
  if (d === 0) return `${lead} today`;
  return `${lead} ${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** The sentence for a tier of exact matches, or null for a tier the store does not report. */
function tierClause(tier: number, field: MatchField | null): string | null {
  switch (tier) {
    case 0:
      return 'the title is exactly what you typed';
    case 1:
      return 'every word you typed is in the title';
    case 2:
      return 'every word you typed is in the title or the company name';
    case 3:
      if (field === 'department') return 'a word you typed is found only in the department';
      if (field === 'description') return 'a word you typed is found only in the description';
      return 'a word you typed is found outside the title and the company name';
    default:
      return null;
  }
}

/**
 * The line, or an empty string when the facts cannot state one truthfully (no
 * usable position, or a text tier the store does not report). The caller renders
 * nothing for an empty string; a made-up sentence is worse than none.
 */
export function rankReason(facts: RankFacts): string {
  if (!Number.isFinite(facts.position) || facts.position < 1) return '';
  const place = ordinal(facts.position);
  const deets = Number.isFinite(facts.deets) ? facts.deets : null;
  const deetsStep = deets === null ? null : `Deets ${deets}`;

  // The default order is Deets: `best` with nothing to rank on is that order.
  const wordsRanked = facts.fuzzy || facts.tier !== null;
  const sort = facts.sort === 'best' && !wordsRanked ? 'fit' : facts.sort;

  switch (sort) {
    case 'best': {
      const keys = [facts.fuzzy ? null : 'the closer text match', deetsStep, 'newer first'].filter(
        (key): key is string => key !== null
      );
      if (facts.fuzzy) {
        const typed = echoQuery(facts.query);
        const of = typed === '' ? 'your words' : `"${typed}"`;
        const score =
          facts.fuzzyScore !== null && Number.isFinite(facts.fuzzyScore)
            ? ` (similarity ${Math.min(1, Math.max(0, facts.fuzzyScore)).toFixed(2)})`
            : '';
        return `Ranked ${place}: a close spelling of ${of}${score}, then ${keys.join(', then ')}.`;
      }
      const group = tierClause(facts.tier as number, facts.field);
      if (group === null) return '';
      return `Ranked ${place}: ${group}, then ${keys.join(', then ')}.`;
    }
    case 'fit':
      return deets === null
        ? ''
        : `Ranked ${place} by Deets: ${deets} of 100, highest first, ${THEN_COMPANY}.`;
    case 'comp':
      return facts.payStated
        ? `Ranked ${place} by pay: highest posted figure first, ${THEN_COMPANY}.`
        : `Ranked ${place} by pay: it posts no figure, so it follows every row that does, ${THEN_COMPANY}.`;
    case 'age':
      return facts.ageDays !== null && Number.isFinite(facts.ageDays)
        ? `Ranked ${place} by age: ${ageClause(facts.ageDays, facts.ageBasis ?? 'posted')}, newest first, ${THEN_COMPANY}.`
        : `Ranked ${place} by age: it has no date to count from, so it follows every dated row, ${THEN_COMPANY}.`;
    default: {
      // A sort added to BoardSort without a sentence is a type error here, on
      // purpose: a new order must say how it orders before it can ship.
      const unnamed: never = sort;
      void unnamed;
      return '';
    }
  }
}
