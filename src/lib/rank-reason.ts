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
 * TWO VARIANTS OF THE BEST ORDERS: WITH DEETS AND WITHOUT. A reader who cannot see
 * Deets (a signed-out reader while fit_public is dark: no Deets column, no why
 * panel) is not ordered by it, because an order they cannot read is one they cannot
 * check. job-store.ts BEST_ORDER and FUZZY_ORDER each hold both, chosen by the
 * filter's `deetsVisible`; for that reader best is tier, text rank, age, id and the
 * typo path is similarity, age, id, and these sentences drop the Deets step to
 * say so. The no-Deets variants are read by the same drift guard.
 *
 * TWO VOICES, ONE VOCABULARY. rankReason() is the per-row sentence, "Ranked 3rd:
 * ...", in a row's why panel for a reader who has one. orderReason() is the order
 * said once for the whole list, "Ordered by best match: ...", above the rows for a
 * reader who has no panel to say it in. Both are built from the same clauses.
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
  /** Whether the reader can see Deets; the best-match orders break a tie on it
      only when they can (job-store.ts BEST_ORDER). Absent is true. */
  deetsVisible?: boolean;
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
  const deetsVisible = facts.deetsVisible !== false;
  const deets = Number.isFinite(facts.deets) ? facts.deets : null;
  // A reader who cannot see Deets is not ordered by it, so the sentence has no
  // such step to name (the best orders), and the Deets order cannot be worded.
  const deetsStep = deets === null || !deetsVisible ? null : `Deets ${deets}`;

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
      return deetsStep === null
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

/** What the whole list's order is built from; the same facts a row's sentence reads
    that do not belong to one row. */
export interface OrderFacts {
  /** The sort the rows are in, as the reader is shown it: a signed-out reader's
      unwritten Deets default is already the age order (board.astro servedSort). */
  sort: BoardSort;
  /** The words as typed. */
  query: string;
  /** True when the close-spelling (typo) path answered, so the order is by similarity. */
  fuzzy: boolean;
  /** Whether the reader can see Deets; see RankFacts. */
  deetsVisible: boolean;
}

/**
 * THE ORDER, SAID ONCE FOR THE LIST. A signed-in reader has a why panel on every
 * row with rankReason() at the top of it. A reader who has no panel (no Deets, no
 * why) used to get no reason at all, and an order nobody can read is the thing this
 * product refuses, so for them the same rules are said in one line above the rows:
 *
 *   best, exact words  "Ordered by best match: where your words are found (the
 *                      title, then the company name, then the rest of the
 *                      posting), then the closer text match, then newer first."
 *   best, typo path    "Ordered by best match: the closest spelling of "prodct" first,
 *                      then newer first."
 *   pay                "Ordered by pay: highest posted figure first, roles that
 *                      post none last, then company and title A to Z."
 *   age                "Ordered by age: newest first, roles with no date last, then
 *                      company and title A to Z."
 *   Deets              "Ordered by Deets: highest first, then company and title A to Z."
 *
 * The clauses are rankReason's, and so are the orders: each follows the same ORDER BY
 * job-store.ts runs, tie-breaks included, which rank-reason.test.ts holds the strings
 * of. With Deets visible the best sentences name it where the SQL uses it, between
 * the text and the age; without, they do not, because the SQL does not. Deets is the
 * default order and is only worded for a reader who can see it: a Deets order said
 * to a reader with no Deets would name the number they cannot read, so that
 * combination is empty, and so is anything the facts cannot state truthfully.
 *
 * Same voice as the row's line (the facts first, "then" between the keys) and the
 * same punctuation rules: no em dash, no curly quote, the query between straight
 * quotes. Pure, like rankReason.
 */
export function orderReason(facts: OrderFacts): string {
  const wordsTyped = echoQuery(facts.query) !== '' || facts.fuzzy;
  // `best` with no words ranks nothing and is the default order, Deets.
  const sort = facts.sort === 'best' && !wordsTyped ? 'fit' : facts.sort;

  switch (sort) {
    case 'best': {
      const tail = [facts.deetsVisible ? 'Deets, highest first' : null, 'newer first'].filter((key): key is string => key !== null);
      if (facts.fuzzy) {
        const typed = echoQuery(facts.query);
        const of = typed === '' ? 'your words' : `"${typed}"`;
        return `Ordered by best match: the closest spelling of ${of} first, then ${tail.join(', then ')}.`;
      }
      return `Ordered by best match: where your words are found (the title, then the company name, then the rest of the posting), then ${['the closer text match', ...tail].join(', then ')}.`;
    }
    case 'fit':
      return facts.deetsVisible ? `Ordered by Deets: highest first, ${THEN_COMPANY}.` : '';
    case 'comp':
      return `Ordered by pay: highest posted figure first, roles that post none last, ${THEN_COMPANY}.`;
    case 'age':
      return `Ordered by age: newest first, roles with no date last, ${THEN_COMPANY}.`;
    default: {
      const unnamed: never = sort;
      void unnamed;
      return '';
    }
  }
}
