import { loadJobs, loadStats } from './data';

/**
 * Populations: the counts this site holds that are easy to mistake for one
 * another, and the plain-language phrase that tells them apart on the page.
 *
 * ---------------------------------------------------------------------------
 * THE 123 VS 65 LESSON, RESTATED FOR THIS SWEEP
 * ---------------------------------------------------------------------------
 *
 * stats.json holds two very different counts that both answer to the word
 * "postings". `postings_observed` (3736 at this sweep) is everything the sweep
 * read off the boards. `pulled` (63) is the much smaller set that passed the
 * title and location filters and therefore reached a verdict, live or killed.
 * Both numbers are true. A page that shows one while the sentence around it
 * implies the other is the failure MASTER-SPEC calls the 123 vs 65 lesson, and
 * test/gates/population.mjs (gate 10) is the instrument that holds every page
 * to naming which one it means.
 *
 * `jobs_total` is a third population, and it is newly in play this wave:
 * another worker is collapsing duplicate postings into single rows, so the
 * count of rows a reader can see and the count of postings the sweep pulled
 * are about to diverge on purpose. It is registered here, with its own phrase,
 * so gate 10 is ready for that render the day it lands, with no edit to this
 * file required.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PHRASE IS FOR
 * ---------------------------------------------------------------------------
 *
 * A metric name on a data-truth tile (see test/gates/truth.mjs) tells the
 * MACHINE which count a number is. It is an attribute; a reader never sees it.
 * The phrase below is the same declaration made in words, in the sentence
 * around the number, so the READER is told too. gate 10 requires both: a
 * `data-population` marker naming the population, and the population's own
 * phrase present, verbatim, in the prose block that carries the number. See
 * that gate's own header for the full markup contract.
 *
 * The phrases are deliberately drawn from src/data/stats.json's own `_meta`
 * prose (`pulled_means`, `contents`) rather than invented here, so the site's
 * explanation of its own numbers and the words a page is required to use to
 * disclose them stay one text, not two that can drift apart.
 */

export type PopulationName = 'boards' | 'postings_observed' | 'pulled' | 'jobs_total';

export interface Population {
  name: PopulationName;
  /** The count itself, read fresh from the data files. Never hardcoded. */
  value: number;
  /** Plain integer, the same formatting every reading on this site uses. */
  display: string;
  /**
   * The noun phrase that has to appear, verbatim, in the same prose block as
   * this number. Distinctive on purpose: none of the four phrases below is a
   * substring of another, so a block that carries the wrong one is caught
   * rather than accidentally satisfying the check.
   */
  phrase: string;
}

const PHRASES: Record<PopulationName, string> = {
  boards: 'boards swept',
  postings_observed: 'postings observed',
  pulled: 'reached a verdict',
  jobs_total: 'published rows'
};

/**
 * Populations easy to mistake for one another, grouped so gate 10 knows which
 * pairs need a page to reconcile them for the reader rather than merely name
 * them separately. Membership means only "these are two answers to a question
 * that sounds like one question"; it says nothing about a page being wrong to
 * state both; it says a page that states two of them has to tie them together
 * in one place a reader can see, the way ScopeBanner.astro does for the first
 * two. Nothing about boards belongs here: "how many boards" is not a count of
 * postings and nobody reads it as one.
 */
export const CONFUSABLE_GROUPS: readonly PopulationName[][] = [['postings_observed', 'pulled', 'jobs_total']];

function valueOf(name: PopulationName): number {
  const stats = loadStats();
  switch (name) {
    case 'boards':
      return stats.boards;
    case 'pulled':
      return stats.pulled;
    case 'postings_observed': {
      const observed = stats._meta?.postings_observed;
      if (typeof observed !== 'number' || !Number.isFinite(observed)) {
        throw new Error(
          'population.ts: stats.json has no _meta.postings_observed. ScopeBanner cannot state the site\'s scope without the count the sweep actually read off the boards, and rendering the "in scope" number alone is exactly the disclosure gap gate 10 exists to close.'
        );
      }
      return observed;
    }
    case 'jobs_total':
      // Counted off the rows themselves, the same way test/gates/truth.mjs's
      // own metrics.jobs_total is: a property of the published rows, not a
      // total the machine wrote down. This is the number that moves the day
      // duplicate-cluster collapse lands.
      return loadJobs().length;
    default: {
      const exhaustive: never = name;
      throw new Error(`population.ts: no population named "${exhaustive}".`);
    }
  }
}

/**
 * One population, resolved fresh from the data files every call. Never store
 * the result across a build: a duration or a row count is exactly the kind of
 * value that goes stale silently, and the whole point of this module is that
 * nothing on this site prints one without saying so.
 */
export function population(name: PopulationName): Population {
  const value = valueOf(name);
  return { name, value, display: String(value), phrase: PHRASES[name] };
}

/** The phrase alone, for a caller that already has the value from elsewhere. */
export function populationPhrase(name: PopulationName): string {
  return PHRASES[name];
}
