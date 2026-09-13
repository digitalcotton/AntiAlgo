/**
 * Everything /role/[slug] derives that src/lib/data.ts does not already own.
 *
 * Three surfaces render one posting: the HTML page, its markdown twin at
 * /jobs/<slug>.md, and its share card at /jobs/<slug>.og.svg. They have to
 * agree about the expiry window, the row position and the wording of the apply
 * destination, so those three answers are computed here once and read three
 * times. A second copy in the endpoint would be a second opinion, and the two
 * would disagree the first time one of them was corrected.
 *
 * Nothing here invents a fact. Every value returned is either a field of the
 * record, arithmetic on fields of the record, or the sweep clock. Where the
 * record does not carry what a value needs, the accessor returns null so the
 * caller can render a truthful absence rather than a plausible default.
 */

import {
  formatDate,
  loadStats,
  sortJobs,
  sourceLabel,
  sweepDate,
  sweptStamp,
  verifiedJobs,
  type Job
} from '../../lib/data';
import { safeDescription } from '../../lib/description';

// ---------------------------------------------------------------------------
// Date arithmetic, in UTC, with no reference to the host clock
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * "2026-08-17" plus n days, as another plain date.
 *
 * Written by hand for the same reason data.ts writes its own parser: the Date
 * constructor reads a bare date as UTC and a dated time as local, and a value
 * that shifts with the reader's timezone is not an observation. Date.UTC and a
 * fixed millisecond step have no timezone in them at all.
 */
function addDays(isoDate: string, days: number): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!parts) return null;
  const start = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const moved = new Date(start + days * MS_PER_DAY);
  return moved.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The expiry rule
// ---------------------------------------------------------------------------

/**
 * How long the machine considers a posting current before it stops standing
 * behind the reading, in days.
 *
 * Ten is the machine's own number, stated in src/data/jobs.json `_meta`:
 * "over 10 days live renders re_verified, senior and leadership roles carry a
 * 30-day window". A senior or leadership row carries that longer window on the
 * record itself, as `window.days`, along with which day of it the sweep found
 * the posting on, so those rows are never held to this constant.
 */
export const DEFAULT_WINDOW_DAYS = 10;

export interface Expiry {
  /** The last date the machine stands behind this reading. */
  date: string;
  /** How that date was arrived at, so no surface ever states it bare. */
  basis: string;
}

/**
 * The end of the machine's verification window for one posting.
 *
 * This is the only date on this page that nobody observed, so it is worth being
 * exact about what it claims. It is not the employer's deadline and it is not a
 * prediction about when the role will be filled. It is our own statement about
 * our own record: the date after which this reading is stale unless a later
 * sweep refreshes it. Schema.org's `validThrough` means exactly that, which is
 * the only reason a computed date is allowed on this page at all.
 *
 * IT IS ALWAYS COUNTED FROM THE SWEEP, and the first version of this function
 * was not, which produced the defect worth recording here. Counting ten days
 * from the source's published date gave the Mercury staff visual designer role
 * a validThrough of 2026-07-18: a machine-readable statement that the posting
 * had expired a month before the sweep that verified it was live. The page said
 * live and the structured data said expired, on the same document.
 *
 * The rule the machine actually runs is what fixes it. A posting over ten days
 * old renders `re_verified` rather than expiring, so re-verification refreshes
 * the window; senior and leadership rows carry a longer one and the record says
 * which day of it the sweep found them on. Both anchor on the same event: the
 * last time we looked. So the window runs from the sweep, every record can
 * evidence it, and no live posting can carry an expiry in its own past.
 *
 * IT RETURNS NULL WHEN THE WINDOW HAS NOTHING LEFT, which is the second half of
 * the same defect. Two live records were found on day 30 of a 30 day window, so
 * the subtraction gave zero days remaining and the expiry landed on the sweep
 * date itself. That published `validThrough: "2026-08-17"` on a page built on
 * 2026-08-17 and marked re-verified: structured data telling every consumer that
 * a posting we had just verified as live expired the day it was published. Zero
 * days left is not a short window, it is the absence of one. We hold no date
 * after which this reading goes stale, because the sweep found the reading at
 * the end of its window and the next sweep is what decides. So no date is
 * published, no `validThrough` is emitted, and the markdown twin says why. That
 * is the rule the rest of the site follows: where we do not hold something, say
 * so, never guess a number to fill the slot.
 */
export function expiryOf(job: Job): Expiry | null {
  const from = sweepDate();
  const swept = formatDate(from);

  const remaining = job.window ? job.window.days - job.window.day : DEFAULT_WINDOW_DAYS;
  if (remaining <= 0) return null;

  const date = addDays(from, remaining);

  if (!date) {
    throw new Error(
      `detail.ts: could not add ${remaining} days to the sweep date "${from}". Every verification window is counted from the sweep, so an unreadable sweep date is a broken window rather than a missing one.`
    );
  }

  return {
    date,
    basis: job.window
      ? `the rest of a ${job.window.days} day window, found on day ${job.window.day} at the sweep of ${swept}`
      : `${DEFAULT_WINDOW_DAYS} days from the sweep that verified it, ${swept}`
  };
}

// ---------------------------------------------------------------------------
// Where this row sat in the sweep
// ---------------------------------------------------------------------------

/**
 * The row's position in the index table, one based, or null for a closed
 * record.
 *
 * The canvas top bar reads "ROW 1 OF 37", and a position is only meaningful
 * against a stated order, so the label says which sort it is counting under.
 * Fit is the table's default and the order this is computed in, so the two
 * cannot disagree. A closed posting is not in the table at all, which is why
 * this returns null rather than a number that would put it in one.
 */
export function rowPosition(job: Job): number | null {
  if (job.status === 'closed') return null;
  const index = sortJobs(verifiedJobs(), 'fit').findIndex((row) => row.slug === job.slug);
  return index === -1 ? null : index + 1;
}

/** How many rows that position is out of. The sweep's own verified count. */
export const verifiedCount = (): number => loadStats().verified_live;

// ---------------------------------------------------------------------------
// The apply action's own words
// ---------------------------------------------------------------------------

/**
 * The line under the apply button, naming what the click actually does.
 *
 * data.ts already names the destination in the label ("Apply on Greenhouse").
 * This is the other half of standing rule 4: a mailto opens a mail client
 * rather than a posting, and a reader deserves to know that before the click
 * rather than after it. The link check is stamped at the sweep, because that is
 * when the machine last followed it, and there is no second clock on this site.
 */
export function applyCaption(job: Job): string {
  const checked = `link checked ${sweptStamp()}`;
  if (job.apply_url.startsWith('mailto:')) {
    return `Opens a new message to the founder, ${checked}`;
  }
  return `Opens the source posting on ${sourceLabel(job)}, ${checked}`;
}

// ---------------------------------------------------------------------------
// The one-line summary under the title
// ---------------------------------------------------------------------------

/**
 * The parts of the canvas's summary line that the record actually holds.
 *
 * The canvas prints "$204k-$348k · REMOTE US · 2d · FIT 96" for its worked
 * example. Nine rows post no range and five have no measurable age, so each
 * segment drops out where the record is silent rather than rendering a dash or
 * a zero. The fit is not in here: it renders through FitBadge so gate 2 can
 * hold it to the fixture, and a marker cannot be attached to a substring.
 */
export function summaryParts(job: Job, age: string | null): string[] {
  const parts: string[] = [];
  if (job.comp_posted) parts.push(job.comp_posted);
  parts.push(job.location);
  if (age) parts.push(age);
  return parts;
}

// ---------------------------------------------------------------------------
// JSON-LD, live postings only
// ---------------------------------------------------------------------------

/**
 * A schema.org JobPosting for one live record.
 *
 * FOUR DECISIONS ARE BAKED IN HERE AND EACH ONE IS A REFUSAL.
 *
 * 1. `description` is emitted only when the machine fetched one. It is null on
 *    all 38 records today, so the field is absent from every page in this
 *    build. Google treats description as required and will say so, and that
 *    complaint is the honest outcome: we do not hold the employer's words yet,
 *    and writing our own summary of their role would be the single most
 *    tempting invention available on this page. The slot is built; the prose is
 *    theirs.
 *
 * 2. `datePosted` is emitted only where the source itself showed a date. Three
 *    live rows carry one. Filling the rest in from our first observation would
 *    publish, in machine-readable form, a claim about when an employer posted
 *    that we cannot support.
 *
 * 3. `baseSalary` is not emitted at all, even though most rows carry a posted
 *    range. A MonetaryAmount needs a currency and a period, and the record
 *    carries neither: "$204k-$348k" is a dollar sign, and reading a currency
 *    code out of a glyph is an inference. The range still renders verbatim on
 *    the page, where it is labelled as posted rather than typed as data.
 *
 * 4. `directApply` is false, always. It is the truest field in the block. This
 *    site never takes an application; it sends a reader to the source and says
 *    so on the button.
 *
 * Location is stated as posted, in a free text `name`, rather than decomposed
 * into a PostalAddress. "SF or NYC, city unconfirmed" is not a locality, and
 * splitting it into one would be this repository resolving an ambiguity the
 * employer left open.
 */
export function jobPostingLd(job: Job, canonicalUrl: string): Record<string, unknown> {
  const posting: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    identifier: {
      '@type': 'PropertyValue',
      name: 'The Index',
      value: job.id
    },
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company
    },
    jobLocation: {
      '@type': 'Place',
      name: job.location
    },
    url: canonicalUrl,
    directApply: false
  };

  // The embed pass, not the raw field. A consumer of this structured data is
  // another publisher, and handing one a third party iframe we would not render
  // ourselves is passing a decision we already made downstream to somebody who
  // did not make it. Heading levels are left exactly as the employer wrote them:
  // this description is not sitting inside our outline. See src/lib/description.ts.
  const description = safeDescription(job.description_html);
  if (description) posting.description = description;
  if (job.published_date) posting.datePosted = job.published_date;

  // Omitted where the window has nothing left. Google's own rule for this field
  // is that a posting with no known expiry should not carry one, and a date we
  // cannot evidence is exactly that case. See expiryOf().
  const expiry = expiryOf(job);
  if (expiry) posting.validThrough = expiry.date;

  if (job.remote) {
    posting.jobLocationType = 'TELECOMMUTE';
    posting.applicantLocationRequirements = {
      '@type': 'AdministrativeArea',
      name: job.location
    };
  }

  return posting;
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

/**
 * The status stamp beside the mark, in the machine voice.
 *
 * Three states and no more, matching the legend canon exactly, because a fourth
 * word here would be a fourth mark state nobody drew.
 */
export function statusStamp(job: Job): string {
  if (job.status === 'closed') return 'Closed';
  if (job.status === 're_verified') return 'Re-verified';
  return 'Verified this sweep';
}

/**
 * The word the provenance panel's Status row uses, which is not the same word.
 *
 * The stamp beside the mark answers "what did this sweep do", so a first
 * sighting is "verified this sweep". The Status row answers "what state is the
 * posting in", so the same record is "live". ProvenancePanel already draws that
 * distinction and the markdown twin has to repeat it exactly, or the two
 * documents describe one record and disagree about one word, which is the kind
 * of small difference that costs the most trust when someone spots it.
 */
export function provenanceStatus(job: Job): string {
  if (job.status === 'closed') return 'Closed';
  if (job.status === 're_verified') return 'Re-verified';
  return 'Live';
}

