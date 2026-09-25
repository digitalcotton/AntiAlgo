/**
 * The typed data layer.
 *
 * Every derived observation on this site is computed here, once, and read by
 * pages. Nothing downstream recomputes a duration, an age, an intersection or a
 * page count, because seven pages doing the same subtraction seven ways is how
 * two of them end up disagreeing about a number that has to be one number.
 *
 * Three rules govern this file, and they are the product's rules, not style
 * preferences:
 *
 *   1. Structure may be derived. Facts may not. Nothing here invents a company,
 *      a role, a salary, a date, a duration or a statistic. Every value returned
 *      either came out of /fixtures or is arithmetic on two values that did.
 *
 *   2. A number renders only when its provenance can be shown. Where the record
 *      does not carry the date a figure was computed from, the accessor returns
 *      null and the page renders a truthful absence. Never a guess, never a
 *      fallback, never a plausible default.
 *
 *   3. One clock. Every timestamp is stats.swept_at_utc. There is no call to
 *      Date.now() in this repository and there must never be one: the site is a
 *      static build of a fixed sweep, so "now" is a value the machine recorded,
 *      not a value the renderer looks up.
 *
 * Two stored fields are deliberately never read: `duration_open_days` on a kill
 * and `age_days` on a job. Both are derived observations, and a derived
 * observation gets derived. Storing one beside the dates it came from creates a
 * second source of truth that can drift from the first, and gate 2 asserts the
 * computation rather than the stored value for exactly that reason. See
 * SESSION-07-KILL-LIST.md, "Compute the duration, never store it".
 */

import rawJobs from '../data/jobs.json';
import rawProspects from '../data/prospects.json';
import rawKills from '../data/kills.json';
import rawKillArchive from '../data/kills-archive.json';
import rawStats from '../data/stats.json';
import rawFacts from '../data/facts.json';
import rawCitations from '../data/citations.json';
import { assertDataContract, prospectsBeyondFreshness } from './data-contract';
import { stripBase } from '../../site.config.mjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a posting stood at the moment of the sweep. */
export type JobStatus = 'live' | 're_verified' | 'closed' | 'pre_posting';

/**
 * Which population a row came from, and the only fork in this file.
 *
 *   posted       a role the sweep read on a company's own board
 *   pre_posting  a company the pre-posting pass scored before any role exists
 *
 * ONE TABLE, ONE SCORE, AND THAT IS THE WHOLE ARGUMENT. Both populations are
 * scored by the same five weights, by the same code, so they sort against each
 * other honestly. Splitting them into two lists with two scores would give a
 * reader two mental models of the same question, which is "where should I spend
 * my next hour". The kind is a filter, not a second site.
 *
 * WHAT A PRE-POSTING ROW HAS NOTHING TO SAY ABOUT. No title, because no role is
 * posted and inventing one would put words in an employer's mouth. No comp, no
 * posting date, no apply link. Every one of those renders as the same absence
 * this table already uses for a board that published nothing.
 */
export type OpportunityKind = 'posted' | 'pre_posting';

/** One observation the pre-posting pass made about a company, in its words. */
export interface ProspectSignal {
  key: string;
  direction: 'positive' | 'negative';
  observation: string;
}

/** One rubric component with the sentence that produced it. */
export interface ProspectFitComponent {
  key: string;
  label: string;
  points: number;
  max: number;
  pct: number;
  basis: string;
}

/**
 * Everything a pre-posting row carries that a posted row does not.
 *
 * Kept in one nested object rather than spread across Job as a dozen optional
 * fields, so the type says plainly that these travel together and that a posted
 * row has none of them.
 */
export interface ProspectDetail {
  one_liner: string | null;
  team_size: number | null;
  cohort: string | null;
  stage: string | null;
  industry: string | null;
  investor: string | null;
  open_role_count: number | null;
  open_role_titles: string[];
  profile_url: string | null;
  company_website: string | null;
  signals: ProspectSignal[];
  fit_components: ProspectFitComponent[];
}

/** The machine's own risk band. Rendered as a machine assertion, never as advice. */
export type Risk = 'LOW' | 'MED' | 'HIGH';

/** How hard the apply path is. Verbatim from the sweep, uppercase at source. */
export type Friction = 'EASY' | 'MEDIUM' | 'HARD';

/**
 * The ATS or posting surface the record was read from, direct.
 *
 * The named members keep editor autocomplete and let the three call sites that
 * compare against a specific system (applyLabel, assertSourceSystems, and this
 * file's own SOURCE_LABELS) do it by literal. `| (string & {})` widens the type
 * so a board this list has not named yet — the next adapter the machine grows —
 * is still a valid SourceSystem instead of being coerced to 'custom'. See
 * sourceSystemOf in board-jobs.ts and atsLabel below: an unknown key is named
 * honestly, not flattened.
 */
export type SourceSystem =
  | 'greenhouse'
  | 'ashby'
  | 'workday'
  | 'amazon'
  | 'lever'
  | 'netflix'
  | 'workable'
  | 'rippling'
  | 'jobvite'
  | 'usajobs'
  | 'yc'
  | 'breezy'
  | 'bamboohr'
  | 'recruitee'
  | 'teamtailor'
  | 'icims'
  | 'successfactors'
  | 'taleo'
  | 'personio'
  | 'custom'
  | 'founder_post'
  | (string & {});

/** The five rubric v1 components. The keys are the fixture's own. */
export interface Fit {
  total: number;
  title_scope: number;
  remote_geo: number;
  comp: number;
  freshness: number;
  apply_friction: number;
}

export interface Ease {
  friction: Friction;
  /** Null where the machine has not measured it. Renders as an absence. */
  minutes_estimate: number | null;
  account_required: boolean;
  /** Named plainly, so the apply action can say where it sends a reader. */
  destination: string;
}

/**
 * A senior or leadership posting gets a longer expiry window. `day` is which
 * day of that window the sweep found it on.
 */
export interface JobWindow {
  days: number;
  day: number;
}

/** The design family a posting was tagged with by the sweep. Closed vocabulary;
 *  see the exporter field contract. A posting the sweep could not place is null,
 *  never guessed. */
export type RoleFamily = 'product' | 'design_engineering' | 'brand' | 'design_systems';
/** The seniority bucket a posting was tagged with. Null when no seniority signal
 *  was read; never defaulted to Senior. */
export type RoleTier = 'Senior' | 'Staff' | 'Lead' | 'Director';

export interface Job {
  id: string;
  slug: string;
  company: string;
  /**
   * The title as the source states it. Never cleaned up, never normalised.
   *
   * Null on a pre-posting row, and that null is load bearing. The machine
   * refuses to name a role nobody has posted, so the site renders the absence
   * rather than a placeholder that would read as the company's own words.
   */
  title: string | null;
  /**
   * The design family and seniority the sweep tagged this posting with, from the
   * ATS department or the title, per the exporter field contract. Measured
   * upstream, never parsed at render. Null is an honest absence: the Ledger draws
   * a gap and never buckets a null by inference. Absent on every row until the
   * exporter emits them, which reads as null here.
   */
  role_family?: RoleFamily | null;
  tier?: RoleTier | null;
  role_family_source?: 'ats_department' | 'title' | null;
  tier_source?: 'ats_level' | 'title' | null;
  /** Which population this row came from. See OpportunityKind. */
  kind: OpportunityKind;
  /** Present only on a pre-posting row. Null on every posted one. */
  prospect: ProspectDetail | null;
  /** The range as posted, or null where the source posted none. */
  comp_posted: string | null;
  /**
   * The same pay as numbers, parsed by the machine from the board's own
   * structured field. Null where the board published none, which is 23 of 66
   * rows and is a truthful absence rather than a gap.
   *
   * This exists so the site never reads a number out of an employer's sentence.
   * comp_posted is their prose and stays prose; this is what their board handed
   * the adapter. See comp_range_for in the machine's export-site-data.py.
   */
  comp_range: { min: number; max: number; currency: string | null; interval: string | null; source: string | null } | null;
  /**
   * The instant the source itself published the posting, to the second, where the
   * board exposes one. `published_date` is the same fact rounded to a calendar
   * day; this exists so the site can say "6h" for a posting six hours old rather
   * than rounding it up to "1d" and hiding exactly the freshness the arrival
   * research says matters most. Null wherever the board gave us a date and no
   * time, which is most of them.
   */
  published_at: string | null;
  /** The location as posted, including its own hedges and asterisks. */
  location: string;
  remote: boolean;
  source_system: SourceSystem;
  source_url: string;
  apply_url: string;
  /** The sweep on which the machine first saw this posting. */
  first_observed: string | null;
  /** Always the sweep instant. Gate 2 fails the build if it is not. */
  last_verified: string;
  /** The date the source itself shows. Present on very few records. */
  published_date: string | null;
  /** Stored, and never read here. See the file header. */
  age_days: number | null;
  status: JobStatus;
  window: JobWindow | null;
  risk: Risk;
  /** Null on a pre-posting row: ease measures an application that does not exist. */
  ease: Ease | null;
  fit: Fit;
  /** Fetched verbatim by the machine or absent. This repo never writes prose here. */
  description_html: string | null;
  closed_on?: string;
  closed_reason?: string;
  age_at_close_days?: number;
}

/**
 * Where a duration figure came from.
 *
 *   observed_by_us      we hold a first_published date and measured the span
 *   reported_elsewhere  the figure came from outside research, not our sweep
 *   null                no duration at all
 *
 * The distinction is a component requirement, not a footnote: a
 * reported_elsewhere row draws no bar, because the bar is a measurement and we
 * have none. See SESSION-07-KILL-LIST.md ruling 4.
 */
export type DurationProvenance = 'observed_by_us' | 'reported_elsewhere' | null;

/**
 * What the rule measured, as the machine's own scalars, so a page can say the
 * finding in plain words from the record rather than reading them back out
 * of the reason sentence. Allowlisted per rule on the mini (export-site-data.py
 * kill_evidence); absent on records exported before 2026-09-12.
 */
export interface KillEvidence {
  previous_published?: string;
  current_published?: string;
  gap_days?: number;
  identifier?: 'reused' | 'new' | string;
  previous_url?: string;
  current_url?: string;
  published_was?: string;
  published_now?: string;
  days_moved?: number;
  location_as_printed?: string;
  deadline?: string;
  days_past?: number;
  http_status?: number;
  confirmed_status?: number;
}

export interface Kill {
  company: string;
  title: string;
  /** Observations only. Any phrasing that assigned motive was cut on 2026-08-17. */
  reason: string;
  /** The rule's measured facts, for the plain line (src/lib/kill-plain.ts). */
  evidence?: KillEvidence | null;
  first_published: string | null;
  killed_on: string | null;
  /** Stored, and never read here. See the file header. */
  duration_open_days: number | null;
  duration_provenance?: DurationProvenance;
  /** Named outside source for a reported_elsewhere figure. Null until supplied. */
  duration_source?: string | null;
  /**
   * The rule the machine fired, emitted upstream by sweep.py's kill_reason().
   * Absent from the fixture today, which is why the reason taxonomy and its
   * per-group counts are blocked. Never classify downstream from the prose.
   */
  kill_rule?: string | null;
  /**
   * Held back from every published surface, and kept in the archive.
   *
   * A held record is a real kill whose central claim we cannot evidence as our
   * own observation. It renders no row, gets no share card, and is not counted
   * in any total of published rows. It is not deleted: the archive keeps
   * everything, and a record we quietly dropped would be the same move this
   * site exists to name.
   *
   * The hold is a publication decision, not a measurement. stats.killed still
   * counts it, because the sweep did kill it, and /kills says on the page that
   * a record is held and why. See DECISIONS.md, 2026-08-19.
   */
  held?: boolean;
  /** Why this record is held, in the record itself so the reason travels with it. */
  held_reason?: string;
}

/**
 * The rules the machine can fire, in the spelling the site uses.
 *
 * This list is the site's copy of the enum in schemas/kills.schema.json, and the
 * order is the order a reader sees on the kill list. `evergreen` is deliberately
 * absent: it was retired on 2026-08-19 for inferring an employer's intent from a
 * duration, on the one product whose spine is observations and never intent.
 */
export const KILL_RULES = [
  'repost_churn',
  'misrepresented',
  'zombie',
  'phantom',
  'touched_not_refreshed'
] as const;

export type KillRule = (typeof KILL_RULES)[number];

export interface Stats {
  /**
   * The sweep's only identifier. There is no sweep_number, on purpose: a counter
   * can be miscounted, a test run inflates it, and two machines disagree about
   * it, where an instant cannot be incremented by accident. See DECISIONS.md,
   * 2026-08-19.
   */
  swept_at_utc: string;
  boards: number;
  pulled: number;
  verified_live: number;
  killed: number;
  /**
   * A count per rule, every rule, every night, zeroes included. A rule missing
   * here reads as a rule that was never run, which is the reading the zeroes
   * exist to prevent.
   */
  killed_by_rule: Record<KillRule, number>;
  /** Kills carrying no rule the current taxonomy can name. See the schema. */
  killed_unattributed: number;
  /**
   * The machine's own note about what this sweep covered.
   *
   * TYPED HERE BECAUSE ONE FIELD IN IT IS A PUBLISHED NUMBER, NOT A COMMENT.
   * `postings_observed` is the count of postings the sweep read off the boards,
   * 3736 at this sweep, against `pulled`, which is 63 and counts only the
   * postings that passed the title and location filters and therefore reached a
   * verdict. Those are two populations and the difference between them is the
   * entire scope of what this site claims. A page that shows one while a reader
   * assumes the other is the 123 versus 65 mistake MASTER-SPEC names, so any
   * surface stating the site's scope reads this field rather than a number
   * somebody typed.
   *
   * Optional, and every field inside it is optional, because _meta is written
   * by the machine for a human to read and its shape is not part of the data
   * contract the way the counts above are. A consumer checks for the field
   * rather than assuming it.
   */
  _meta?: {
    purpose?: string;
    contents?: string;
    pulled_means?: string;
    postings_observed?: number;
    boards_that_failed?: readonly string[];
    [key: string]: unknown;
  };
}

export interface Fact {
  id: string;
  /** The string that has to appear in rendered HTML, character for character. */
  string: string;
  source: string;
  /** Exact routes or one level globs. A fact is licensed to a route, not a topic. */
  pages: string[];
  so_what?: string;
  note?: string;
}

export interface Citation {
  id: string;
  /**
   * Somebody else's sentence, byte for byte. Not a fact string: a fact may be
   * reworded to fit a page and a quotation may not be touched at all, which is
   * why the two live in different files and are checked by different rules.
   */
  quote: string;
  author: string;
  work: string;
  year: number;
  /** Where in the work. Printed, so a reader can go and check us. */
  locator: string;
  /** Exact routes or one level globs, same licence rule as a fact. */
  pages: string[];
  /** Why this passage earns its place. Editorial, never rendered. */
  why?: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
//
// TypeScript infers a JSON module's types from its literal contents, so a field
// that happens to be null in every record infers as `null` rather than
// `number | null`. Casting through `unknown` puts the declared interface in
// charge instead. The runtime guards below are what actually protect the build:
// a fixture that lost its payload, or lost the sweep clock, fails here with a
// readable message rather than rendering an empty site that looks fine.

interface JobsDoc {
  _meta: unknown;
  jobs: Job[];
}
interface KillsDoc {
  _meta: unknown;
  kills: Kill[];
}

/**
 * One row of the all-time record.
 *
 * A Kill plus the four things a record needs that a night does not: an identity
 * that survives a rebuild, a slug that survives a new neighbour, which machine
 * found it, and how many nights it has now been seen. The reason, the dates and
 * the rule are the same fields the kill list has always rendered, so a record
 * row and a tonight row go through exactly the same components.
 */
export interface KillRecord extends Kill {
  id: string;
  slug: string;
  url: string;
  ats?: string | null;
  first_killed_at_utc?: string | null;
  last_fired_on?: string | null;
  /** Nights this rule has fired on this posting. One finding, observed n times. */
  times_fired?: number;
  pipeline?: 'sweep' | 'crawl';
  /** The design family and seniority the sweep tagged this killed posting with,
   *  per the exporter field contract. Null until the exporter emits them. */
  role_family?: RoleFamily | null;
  tier?: RoleTier | null;
}

interface KillArchiveDoc {
  _meta: unknown;
  swept_at_utc: string;
  archive_since: string | null;
  total: number;
  by_rule: Record<string, number>;
  retired_skipped: number;
  vacated: number;
  kills: KillRecord[];
}
interface FactsDoc {
  _meta: unknown;
  facts: Fact[];
}
interface RawProspect {
  id: string;
  slug: string;
  opportunity_kind: string;
  company_name: string;
  company_website: string | null;
  one_liner: string | null;
  team_size: number | null;
  cohort: string | null;
  stage: string | null;
  industry: string | null;
  investor: string | null;
  locations: string[] | null;
  regions: string[] | null;
  profile_url: string | null;
  remote: boolean | null;
  open_role_count: number | null;
  open_role_titles: string[] | null;
  fit: number;
  fit_components: ProspectFitComponent[] | null;
  signals: ProspectSignal[] | null;
  // Present only on a 'posted' row: the role the pass read on the company's YC
  // page. Null on every pre-posting row, which is why they are optional here.
  title?: string | null;
  url?: string | null;
  comp_posted?: string | null;
  location?: string | null;
  // The role's own description as published on Work at a Startup. A posted YC
  // role is an actual job, so it shows an actual description, the same rule the
  // swept board and the tracker follow. Optional because the export does not
  // carry it yet: until it does this is undefined and the slot renders its
  // honest absence rather than prose nobody read. See docs/MACHINE-CONTRACT.md.
  description_html?: string | null;
}

/**
 * One YC role that is already posted publicly on Work at a Startup, kept as its
 * own lean shape rather than a Job.
 *
 * WHY NOT A Job. A Job carries a status the sweep set and a "verified last night"
 * receipt the board prints from it. We did not sweep these: we are mirroring a
 * listing YC already publishes. Forcing them into the Job shape would either
 * claim a verification we never ran or need a fake status, so this carries only
 * what the YC record actually holds, and the surface that renders it says plainly
 * that YC is the source. The apply link points back to YC, never to an internal
 * role page (there is none), for the same reason.
 */
export interface PostedYcRole {
  id: string;
  company: string;
  title: string;
  compPosted: string | null;
  location: string | null;
  cohort: string | null;
  /** The role on Work at a Startup, where a reader applies. */
  ycUrl: string | null;
  /** The role's own description as published, or null until the export carries it. */
  descriptionHtml: string | null;
  /** The same five-weight score every row on the site carries, copied, never recomputed. */
  fit: number;
}
interface ProspectsDoc {
  _meta: unknown;
  prospects: RawProspect[];
}
interface CitationsDoc {
  _meta: unknown;
  citations: Citation[];
}

const jobsDoc = rawJobs as unknown as JobsDoc;
const killsDoc = rawKills as unknown as KillsDoc;
const killArchiveDoc = rawKillArchive as unknown as KillArchiveDoc;
const statsDoc = rawStats as unknown as Stats;
const factsDoc = rawFacts as unknown as FactsDoc;
const citationsDoc = rawCitations as unknown as CitationsDoc;

/**
 * The data contract runs before anything is read, so a build against missing,
 * stale or self-contradicting data dies here rather than rendering it.
 *
 * The four failure modes and the reasoning behind each are in
 * src/lib/data-contract.ts, and src/data/README.md is the contract in prose.
 * Two things this file used to do and no longer does, both of them wrong:
 *
 *   1. It threw on an empty `kills` array. An empty kills array is the best
 *      night the machine can have, and the kill list has a designed state that
 *      says so. Missing and empty are told apart by the key now, not by length.
 *   2. It checked only the clock's shape. Shape is not freshness, and a
 *      correctly shaped instant from three weeks ago is the one thing a site
 *      claiming "verified last night" cannot publish.
 */
const CONTRACT_NOTES = assertDataContract({
  jobs: jobsDoc,
  kills: killsDoc,
  killArchive: killArchiveDoc as unknown as Record<string, unknown>,
  stats: statsDoc as unknown as Record<string, unknown>,
  facts: factsDoc,
  prospects: rawProspects as unknown as { _meta?: unknown; prospects?: unknown }
});

// Printed, not swallowed. Today the only note this can carry is the labelled
// fixture running past the freshness window, and a build that quietly ignored
// that would be the first step toward a site that quietly ignores a real one.
for (const note of CONTRACT_NOTES) console.warn(note);

/**
 * The posted rows, each stamped with the kind it came from.
 *
 * The stamp is added here rather than asked of the exporter, because
 * jobs.json has shipped for weeks without the field and a nightly push that
 * predates this change must keep building. The machine's file says what it
 * always said; this line says what that file means.
 */
const JOBS: readonly Job[] = Object.freeze(
  jobsDoc.jobs.map((job) => ({ ...job, kind: 'posted' as OpportunityKind, prospect: null }))
);

/**
 * The pre-posting rows, mapped into the same shape the table already renders.
 *
 * THE MAPPING INVENTS NOTHING. Every field either carries a value the machine
 * measured or is null, and null is rendered by the same absence the table uses
 * for a board that published no pay. There is no default title, no guessed
 * date, no synthesised apply link. The score is copied, never recomputed: it was
 * produced by the same scorer that scores the boards, which is the only reason
 * these rows may sit in the same sorted list at all.
 *
 * source_system is 'yc' because that is where the pass reads. If the pass ever
 * reads somewhere else, the exporter has to say so and this has to learn it,
 * rather than quietly labelling a new source with an old name.
 */
const prospectsDoc = rawProspects as unknown as ProspectsDoc;

/**
 * The Pre-List's funding clock is text the pass bakes into prospects.json (e.g.
 * "Summer 2026, about 2 months ago, against a 12 month funding horizon"). This
 * file copies that text and never recomputes it, so if the pass stops
 * publishing, the months-ago figure freezes and would quietly drift out of
 * true. Past the attended window (prospectsBeyondFreshness), we stop standing
 * behind that figure: the freshness component's basis is replaced with a plain
 * line keyed to when the file was written. Within the window nothing changes,
 * because a frozen months-ago figure is still about right for a few days.
 */
const PROSPECTS_UNATTENDED = prospectsBeyondFreshness(prospectsDoc);
const prospectsMeta = prospectsDoc._meta as { generated_at_utc?: unknown } | undefined;
const PROSPECTS_STAMP_DATE =
  typeof prospectsMeta?.generated_at_utc === 'string' ? prospectsMeta.generated_at_utc.slice(0, 10) : null;

/**
 * Leave the pass's fit components untouched while the file is attended. Once it
 * is not, rewrite only the funding-clock freshness component (the one keyed to a
 * cohort, against the funding horizon), so no other component and no posted-style
 * freshness line is affected.
 */
function guardFundingClock(components: ProspectFitComponent[], cohort: string | null): ProspectFitComponent[] {
  if (!PROSPECTS_UNATTENDED) return components;
  return components.map((component) => {
    const isFundingClock =
      component.key === 'freshness' && (cohort !== null || /funding horizon/i.test(component.basis));
    if (!isFundingClock) return component;
    const when = PROSPECTS_STAMP_DATE ? ` (last updated ${PROSPECTS_STAMP_DATE})` : '';
    return {
      ...component,
      basis: `Funding recency${when} is from the pre-posting pass and is not being refreshed right now.`
    };
  });
}

const PROSPECTS: readonly Job[] = Object.freeze(
  prospectsDoc.prospects
    .filter((row) => row.opportunity_kind === 'pre_posting')
    .map((row): Job => ({
      id: row.id,
      slug: row.slug,
      company: row.company_name,
      title: null,
      kind: 'pre_posting',
      comp_posted: null,
      comp_range: null,
      published_at: null,
      location: locationOf(row),
      remote: Boolean(row.remote) || (row.regions ?? []).some((r) => /remote/i.test(r)),
      source_system: 'yc',
      source_url: row.profile_url ?? row.company_website ?? '',
      apply_url: row.profile_url ?? row.company_website ?? '',
      first_observed: null,
      last_verified: String(statsDoc.swept_at_utc),
      published_date: null,
      age_days: null,
      status: 'pre_posting',
      window: null,
      risk: 'LOW',
      // NO EASE OBJECT, AND THE FIRST DRAFT OF THIS WAS WRONG. It said EASY,
      // ~0 min, no account, and the row rendered "Apply on Work at a Startup"
      // under a company with nothing to apply to. Ease measures an application
      // flow. There is no application, so there is no measurement, so this is
      // null and the cell says what is actually true.
      ease: null,
      fit: {
        total: row.fit,
        title_scope: pointsFor(row, 'title_scope'),
        remote_geo: pointsFor(row, 'geo_remote'),
        comp: pointsFor(row, 'comp'),
        freshness: pointsFor(row, 'freshness'),
        apply_friction: pointsFor(row, 'apply_ease')
      },
      description_html: null,
      prospect: {
        one_liner: row.one_liner ?? null,
        team_size: row.team_size ?? null,
        cohort: row.cohort ?? null,
        stage: row.stage ?? null,
        industry: row.industry ?? null,
        investor: row.investor ?? null,
        open_role_count: row.open_role_count ?? null,
        open_role_titles: row.open_role_titles ?? [],
        profile_url: row.profile_url ?? null,
        company_website: row.company_website ?? null,
        signals: row.signals ?? [],
        fit_components: guardFundingClock(row.fit_components ?? [], row.cohort ?? null)
      }
    }))
);

/**
 * The YC roles that are already posted publicly on Work at a Startup.
 *
 * These sit apart from PROSPECTS (which is pre-posting only) and from JOBS (the
 * swept board). They are their own small population: public, because YC lists
 * them publicly, and mirrored here without a verification receipt, because the
 * sweep did not read them off the company's own board. The surface that renders
 * them names YC as the source and links back there to apply.
 */
const POSTED_YC_ROLES: readonly PostedYcRole[] = Object.freeze(
  prospectsDoc.prospects
    .filter((row) => row.opportunity_kind === 'posted')
    .map((row): PostedYcRole => ({
      id: row.id,
      company: row.company_name,
      title: row.title ?? row.company_name,
      compPosted: row.comp_posted ?? null,
      location: row.location ?? locationOf(row),
      cohort: row.cohort ?? null,
      ycUrl: row.url ?? row.profile_url ?? null,
      descriptionHtml: row.description_html ?? null,
      fit: row.fit
    }))
);

/** The YC roles already posted publicly on Work at a Startup. Public, and their
 *  own population: not swept, never in verifiedJobs(), never counted as a
 *  verified posting. See the PostedYcRole type for why they are not Jobs. */
export const postedYcRoles = (): PostedYcRole[] => [...POSTED_YC_ROLES];

/** The locations list, joined the way the posted rows already read. */
function locationOf(row: RawProspect): string {
  const list = (row.locations ?? []).filter(Boolean);
  if (list.length === 0) return 'Not stated';
  return list.join(' \u2022 ');
}

/** One rubric component's points, or zero where the pass emitted none. */
function pointsFor(row: RawProspect, key: string): number {
  const hit = (row.fit_components ?? []).find((c) => c.key === key);
  return hit ? hit.points : 0;
}

/**
 * Both populations, one sorted list. No longer what the index renders.
 *
 * This fed the index while the table held 37 rows and a client-side filter
 * needed both populations sent together to see across them. It now holds 424:
 * 63 verified postings plus 361 pre-posting companies, and printing every one
 * of those rows into the page put a whole second surface's weight behind the
 * same budget. RUN-MASTER.md section 2 amendment 7 keeps the index filtered
 * to its stated subject, and MASTER-SPEC.md section 6 requires every count on
 * a page to reconcile to one named population, so the index now sorts
 * verifiedJobs() alone. See the comment on that call in src/pages/index.astro.
 *
 * Kept, unused today, because it is the one place these two populations are
 * ever combined and scored against each other, and nothing else in this file
 * does that arithmetic. Deliberately NOT folded into verifiedJobs(): that
 * function answers "what did the sweep verify on a board last night", and
 * every stat tile, the age plot and the data contract's row counts read it.
 * Adding rows the sweep never verified would make those numbers describe a
 * different thing under the same name.
 */
export const allOpportunities = (): Job[] => [...verifiedJobs(), ...PROSPECTS];

/** The pre-posting rows alone, for anything that counts them. */
export const prospectRows = (): Job[] => [...PROSPECTS];
const FACTS: readonly Fact[] = Object.freeze(factsDoc.facts);
const CITATIONS: readonly Citation[] = Object.freeze(citationsDoc.citations);
const STATS: Stats = Object.freeze(statsDoc);

/**
 * Two kill sets, and the split is the whole of the held-row ruling.
 *
 * KILL_ARCHIVE is every record the sweep wrote, held ones included. It is what
 * the data contract counts against stats.killed, and it is what a sentence
 * describing the sweep itself ("this sweep holds N such kills") has to read, or
 * the sentence is false about the thing it names.
 *
 * KILLS is what may be published: rows, share cards, groupings, digests, and
 * every count of rendered rows. A held record is absent from all of it.
 *
 * Doing the filter here rather than in each page is the point. Seven surfaces
 * render a kill and every one of them reads this accessor, so a record marked
 * held disappears from the list, its card route, the repeat grouping, the both
 * lists intersection, the bar scale and the weekly digest in one move, with no
 * page having to remember. A page-level filter would have shipped the row on
 * whichever surface nobody thought about.
 */
const KILL_ARCHIVE: readonly Kill[] = Object.freeze(killsDoc.kills);

/**
 * The rule a record fired, when it is one this site still publishes.
 *
 * A record with no rule, or with a rule that is not in KILL_RULES, is not
 * publishable. That is not a data quality check, it is the second half of
 * retiring evergreen. The machine says the same thing from its end: sweep.py's
 * own comment on FILTER_RULES reads "the site is expected to render only rows
 * whose kill_rule is in KILL_RULES", and schemas/kills.schema.json rejects
 * "evergreen" outright so a historic age kill lifted out of the archive cannot
 * be rendered by accident.
 */
export const publishedRuleOf = (kill: Kill): KillRule | null => {
  const rule = kill.kill_rule;
  return typeof rule === 'string' && (KILL_RULES as readonly string[]).includes(rule)
    ? (rule as KillRule)
    : null;
};

/**
 * Publishable: not held, and carrying a rule this site still stands behind.
 *
 * THE SECOND CONDITION IS NEW ON 2026-08-19 AND IT EMPTIES THE PAGE. Every kill
 * in the sweep 001 fixture fired the evergreen rule, which killed a posting for
 * being older than a threshold. That rule was retired because a duration is not
 * evidence about an employer, and the kill list's spine is observations and
 * never intent. Retiring it in the machine while the site went on publishing
 * fourteen rows it produced would have retired the rule in the only place
 * nobody could see and kept the accusation in the only place anybody could.
 *
 * The records are not deleted. They stay in kills.json, they stay in the
 * archive, stats.killed still counts them, and /kills says in words how many
 * there are and why none of them is on the page. What changes is what this site
 * asserts in public, which is the only thing that was ever the problem.
 */
export const killIsPublishable = (kill: Kill): boolean =>
  kill.held !== true && publishedRuleOf(kill) !== null;

const KILLS: readonly Kill[] = Object.freeze(KILL_ARCHIVE.filter(killIsPublishable));
const HELD_KILLS: readonly Kill[] = Object.freeze(KILL_ARCHIVE.filter((kill) => kill.held === true));
/** Records kept out of the list for carrying no rule this site publishes. */
const UNATTRIBUTED_KILLS: readonly Kill[] = Object.freeze(
  KILL_ARCHIVE.filter((kill) => kill.held !== true && publishedRuleOf(kill) === null)
);

export const loadJobs = (): readonly Job[] => JOBS;

/** The publishable kills. Held records are not in here. */
export const loadKills = (): readonly Kill[] => KILLS;

/**
 * Every kill the sweep recorded, held records included.
 *
 * Read this only where the sentence is about the sweep's own records rather
 * than about the rows a reader can see. Nothing that renders a kill may read
 * it: a held record has no row, no card and no counted place in a list.
 */
export const killArchive = (): readonly Kill[] => KILL_ARCHIVE;

/**
 * Every kill still standing, from every sweep. THE RECORD, as against the news.
 *
 * WHY THIS IS A SECOND ACCESSOR AND NOT A WIDER killArchive(). The name above
 * is taken, and it means something precise that the data contract depends on:
 * the records THIS sweep wrote, held ones included, held to stats.killed. This
 * one spans every sweep and is held to nothing of the sort. Two sets that
 * different should never share a name, and swapping the meaning under the old
 * one would have changed what seven existing callers assert with no signature
 * for the compiler to catch.
 *
 * WHAT IT FIXES. kills.json is rewritten every night, so a kill found on Friday
 * was gone on Saturday: the row, the share card somebody had posted, and the
 * "what died" list all vanished, while the page went on promising that every
 * kill is kept forever. Anything that outlives one sweep reads this: the record
 * frame on the kill list, the card routes, and the drop's own window.
 *
 * Filtered through the same publishable test as the nightly list, so a held
 * record or a retired rule cannot reach a page by coming in through history.
 */
const KILLS_ON_RECORD: readonly KillRecord[] = Object.freeze(
  (killArchiveDoc.kills ?? []).filter(killIsPublishable)
);

export const killsOnRecord = (): readonly KillRecord[] => KILLS_ON_RECORD;

/**
 * Every kill that must resolve a share card, tonight's and the record's.
 *
 * WHY THE UNION AND NOT SIMPLY THE RECORD. A card is a URL somebody screenshots
 * and posts, so it has to answer forever, and it has to answer on the night the
 * kill is found. The record is rebuilt by the same export that writes tonight's
 * rows, so the two agree by construction; the union is the belt to that brace,
 * because a record rebuilt from an archive that lost a line would silently stop
 * building a card the list still links to. Deduplicated by slug rather than by
 * id, because the slug IS the route: two records that resolved to one path
 * would be a duplicate-path build error, and one of them would win at random.
 *
 * Tonight's row wins the tie. Where a posting is both, the sweep holds the
 * fresher observation prose.
 *
 * Computed on first call rather than at module load, because it needs
 * killSlug(), which is declared further down this file: a const initialised at
 * import time cannot call one that has not been reached yet.
 */
let CARD_KILLS: readonly Kill[] | null = null;

export const killsWithCards = (): readonly Kill[] => {
  if (CARD_KILLS === null) {
    const bySlug = new Map<string, Kill>();
    for (const kill of KILLS_ON_RECORD) bySlug.set(killSlug(kill), kill);
    for (const kill of KILLS) bySlug.set(killSlug(kill), kill);
    CARD_KILLS = Object.freeze([...bySlug.values()]);
  }
  return CARD_KILLS;
};

/**
 * The day the record begins: the first sweep the machine has an archive for.
 *
 * A date and never a count. This site has no sweep number and must not grow
 * one: "since 18 August" is checkable against the archive, and "sweep 12" is a
 * number only this site can confirm.
 */
export const killsRecordSince = (): string | null => killArchiveDoc.archive_since ?? null;

/** The records held back from publication, with their reasons. */
export const heldKills = (): readonly Kill[] => HELD_KILLS;

/**
 * Records the sweep killed under no rule this site publishes.
 *
 * Distinct from a held record, and the distinction is the reason for both. A
 * held record is one whose own claim we cannot evidence. These are records
 * whose claim we can evidence and whose RULE we withdrew. The page says which
 * is which, because "we could not prove it" and "we stopped believing the test"
 * are different admissions and a reader deserves the right one.
 */
export const unattributedKills = (): readonly Kill[] => UNATTRIBUTED_KILLS;

export const loadStats = (): Stats => STATS;
export const loadFacts = (): readonly Fact[] => FACTS;

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** The one instant. Every timestamp anywhere on the site is this string. */
export const sweptAt = (): string => STATS.swept_at_utc;

/** The sweep's calendar day, which is what every day count is measured to. */
export const sweepDate = (): string => STATS.swept_at_utc.slice(0, 10);

/**
 * There is no sweepNumber() and there must not be one.
 *
 * Sweep numbering was dropped from the whole system on 2026-08-19: from
 * stats.json, from the export, from the machine, and from every render. Three
 * reasons, and the third is the one that decided it. A counter can be
 * miscounted. A test run inflates it, so the number a reader sees stops being a
 * count of nights anyone measured. And `swept_at_utc` was already the thing the
 * footer published, so the site was carrying two identifiers for one sweep and
 * only one of them could be checked against anything.
 *
 * Anywhere a page wants to name the sweep, it names the instant: sweptStamp()
 * for a reader, sweptAt() for a machine.
 */

/**
 * The sweep instant as a reader sees it: "Aug 17, 2026, 02:14 UTC".
 *
 * Derived from stats.swept_at_utc by slicing, never by formatting a date object,
 * because a date object would be formatted in the timezone of whatever machine
 * ran the build and the stamp would drift by a day depending on who pressed
 * build. Every surface that shows the clock calls this, so there is one string
 * and it cannot be typed differently on two pages.
 */
export function sweptStamp(): string {
  const day = formatDate(sweepDate());
  const time = STATS.swept_at_utc.slice(11, 16);
  if (!day) {
    throw new Error(`data.ts: could not read a calendar day out of stats.swept_at_utc ("${STATS.swept_at_utc}").`);
  }
  return `${day}, ${time} UTC`;
}

/**
 * The archive has to have depth before "First seen" says anything.
 *
 * On the first sweep the machine first observed almost everything today, so the
 * column reads as one value repeated 32 times and implies that 32 postings
 * appeared overnight. The column is built and labelled now, and gated here,
 * because it becomes the most valuable column on the page once the archive has
 * depth: it comes from our own record rather than from the employer, and nobody
 * else has it. See DECISIONS.md, "The age column: two different facts".
 *
 * THE GATE IS AN OBSERVATION NOW, NOT A COUNTER. This used to read
 * `stats.sweep_number >= 3`, and sweep numbering was dropped on 2026-08-19
 * because a counter can be inflated by a test run. The replacement asks the
 * question the original was a proxy for: do the rows actually carry first-seen
 * dates that predate tonight? A column of dates is worth showing when most of
 * the dates in it are older than the sweep that rendered it, and worth
 * suppressing when they are not. Three sweeps of a machine that saw nothing new
 * would have satisfied the counter and still printed one repeated date.
 *
 * On the sweep 001 fixture: 33 rows carry a first-observed date and 5 of them
 * predate the sweep day, so the column stays dark, which is what the counter
 * did. Same outcome, from evidence rather than from a number nobody can audit.
 */
export const firstSeenVisible = (): boolean => {
  const dated = JOBS.map((job) => job.first_observed).filter((date): date is string => Boolean(date));
  if (dated.length === 0) return false;
  const older = dated.filter((date) => date.slice(0, 10) < sweepDate()).length;
  return older * 2 > dated.length;
};

/**
 * Whether one record's own first-observed date may be printed.
 *
 * `firstSeenVisible()` above gates the index table's First seen *column*, and
 * the reason it exists is specific: a column of 32 identical dates would imply
 * 32 postings appeared overnight. That argument is about a column of repeated
 * values, and it does not reach a date that predates the sweep. Five records on
 * sweep 001 carry one, and those five dates are real observations from before
 * tonight: they are the only first-observed dates on the site that could not be
 * mistaken for "we saw everything for the first time today".
 *
 * The site already publishes exactly these five through `ageOf()`, which
 * measures an age from a `first_observed` that predates the sweep and labels the
 * row "First seen Apr 20, 2026". So the rule here is the rule already in force,
 * written once so that a panel row, a timeline entry and a markdown twin cannot
 * disagree about whether the same date is publishable. Before this, the
 * provenance panel printed "Held back until the archive is three sweeps deep"
 * two lines above the date it had just withheld.
 */
export const firstSeenShowable = (job: Job): boolean =>
  Boolean(job.first_observed) && (firstSeenVisible() || job.first_observed! < sweepDate());

// ---------------------------------------------------------------------------
// Dates, computed without ever asking the host what time it is
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
] as const;

/**
 * Parses a plain "YYYY-MM-DD" into a UTC millisecond value.
 *
 * Written by hand rather than handed to `new Date(string)` because that
 * constructor reads a bare date as UTC and a date with a time as local, and the
 * difference is a whole day at the wrong end of the world. A day count that
 * changes with the reader's timezone is not an observation.
 */
function utcMillis(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Whole days from one calendar date to another. Null if either is unparseable. */
export function daysBetween(fromISO: string | null, toISO: string | null): number | null {
  if (!fromISO || !toISO) return null;
  const from = utcMillis(fromISO);
  const to = utcMillis(toISO);
  if (from === null || to === null) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

const MS_PER_HOUR = 3_600_000;

/**
 * Parses a full "YYYY-MM-DDTHH:MM:SSZ" instant into a UTC millisecond value.
 *
 * Unlike `utcMillis` above, this is safe to hand to `Date.parse`: the ambiguity
 * that function forbids is a bare calendar date, which JavaScript reads as UTC
 * while a date-with-time is read in the host's local zone. A "Z"-suffixed
 * instant carries its own zone, so there is nothing left for the host clock to
 * get to vote on.
 */
function utcInstantMillis(iso: string): number | null {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? null : millis;
}

/**
 * "2026-07-08" becomes "Jul 8, 2026".
 *
 * The year is always present. A month and day alone ("JUL 8") reads fine to a
 * person and is unverifiable to gate 2, which resolves written-out dates back to
 * ISO and checks them against the sweep data. Carrying the year means every
 * date on the site is a checked date.
 */
export function formatDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  const month = MONTH_NAMES[Number(match[2]) - 1];
  if (!month) return null;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

// ---------------------------------------------------------------------------
// Job selections
// ---------------------------------------------------------------------------

/**
 * The 37 postings that were live at the sweep: 31 `live` plus 6 `re_verified`.
 * Two live states, one meaning, exactly as the mark legend has it.
 */
export const verifiedJobs = (): Job[] => JOBS.filter((job) => job.status !== 'closed');

/** Postings the machine watched close. One record in this fixture. */
export const closedJobs = (): Job[] => JOBS.filter((job) => job.status === 'closed');

export function jobBySlug(slug: string): Job | null {
  return JOBS.find((job) => job.slug === slug) ?? null;
}

/** Live postings at a named company. The kill list's cross-link reads this. */
export function liveJobsAtCompany(company: string): Job[] {
  return verifiedJobs().filter((job) => job.company === company);
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * Which date an age was measured from. The row shows this, because an age with
 * no stated basis is a number a reader has to take on trust, and this site does
 * not ask for trust.
 *
 *   published_date  the source itself showed a date. The posting's real age.
 *   first_observed  the source showed nothing, so this is how long we have been
 *                   watching it. A floor on the true age, never the age itself.
 */
export type AgeBasis = 'published_date' | 'first_observed';

export interface Age {
  days: number;
  basis: AgeBasis;
  /** The date the count started from, so the row can show its own working. */
  from: string;
  /** The date it was counted to: the sweep, or the closure for a closed row. */
  to: string;
}

/**
 * The age of a posting, or null.
 *
 * Null is the important half, and it happens two different ways.
 *
 * FIRST: five verified rows carry an `age_days` with neither a `published_date`
 * nor a `first_observed`, so there is no date in the record for that number to
 * have come from. We show the absence instead. On the page whose whole argument
 * is provenance, a number we cannot source is the one thing we cannot print.
 * Those five are figma-manager-product-design, webflow-staff-brand-designer,
 * seeq-frontend-design-systems-engineer, notion-product-designer and
 * harvey-staff-product-designer, and they are a data defect for the export
 * script to fix upstream, exactly as `kill_rule` is.
 *
 * SECOND, and this one is a judgment the fixture makes and this function
 * reproduces: a posting we first observed on this very sweep has no measurable
 * age. We know it exists. We do not know how long it has existed, because the
 * source published no date and we were not watching yesterday. Counting from
 * first_observed there would render "0d", which reads as "posted today" and is
 * a claim about the employer we cannot evidence. The fixture agrees: every one
 * of the 27 rows whose first_observed equals the sweep date carries a null
 * `age_days`, and every row where it predates the sweep carries a real one.
 * That is the rule, read off the machine's own output rather than invented here.
 *
 * So an age is measured from `published_date` where the source showed one (the
 * posting's real age), and otherwise from a `first_observed` that predates this
 * sweep (a floor on the age: this is how long we have watched it, which is at
 * least how old it is).
 *
 * A closed posting is counted to the day its closure was observed, not to the
 * sweep that published the finding. Uplight closed on the 16th and the 02:14
 * sweep on the 17th recorded it; normalising that to the sweep would add a day
 * the posting was not open for.
 */
export function ageOf(job: Job): Age | null {
  const to = job.closed_on ?? sweepDate();

  if (job.published_date) {
    const days = daysBetween(job.published_date, to);
    if (days === null) return null;
    return { days, basis: 'published_date', from: job.published_date, to };
  }

  if (job.first_observed && job.first_observed < sweepDate()) {
    const days = daysBetween(job.first_observed, to);
    if (days === null) return null;
    return { days, basis: 'first_observed', from: job.first_observed, to };
  }

  return null;
}

/**
 * Hours since the source's own publish instant, and only while that instant is
 * still inside the arrival window: "45% of applications arrive within 48
 * hours ... and 60% within 96 hours" (facts.json, `arrival-window`). 96 is not
 * a display preference, it is the width of the window that research names, so a
 * posting seven days old has no business claiming to be measured in hours.
 *
 * Null wherever the row has no `published_at`, or the instant does not parse,
 * or the age has already reached 96 hours: those rows fall back to `ageOf()`
 * and its calendar days, same as before this existed.
 */
export function ageHours(job: Job): number | null {
  if (!job.published_at) return null;
  const from = utcInstantMillis(job.published_at);
  const to = utcInstantMillis(sweptAt());
  if (from === null || to === null) return null;
  const hours = Math.round((to - from) / MS_PER_HOUR);
  if (hours < 0 || hours >= 96) return null;
  return hours;
}

/**
 * How the Age cell should label the date its number came from.
 *
 * A number with no stated basis is a number a reader has to take on trust, and
 * this site does not ask for trust. Note that this is not the suppressed
 * "First seen" column: that column would print one date for every row and on
 * sweep 001 it would be the same date 32 times. This is one row explaining its
 * own figure, and it only ever appears on rows where the date is not today.
 */
export const AGE_BASIS_LABEL: Record<AgeBasis, string> = {
  published_date: 'Posted',
  first_observed: 'First seen'
};

/** The date the source itself showed, or null. Three verified rows carry one. */
export const postedDate = (job: Job): string | null => job.published_date;

/**
 * The sweep on which the machine first saw the posting.
 *
 * Present by construction on everything we have observed, and suppressed for
 * display until the archive has depth. Callers check `firstSeenVisible()`; this
 * accessor always returns the record's value, so the column can be built,
 * tested and reasoned about while it is still hidden.
 */
export const firstSeen = (job: Job): string | null => job.first_observed;

// ---------------------------------------------------------------------------
// Kills
// ---------------------------------------------------------------------------

/**
 * A stable, readable id for a kill.
 *
 * The fixture carries no slug, and the kill list needs one for
 * /kills/[slug]/card. Company plus title is the only pair that is unique across
 * the fourteen archived records: Brex appears twice with two different titles.
 * Derived from the record rather than typed out, so a new kill gets a URL
 * without anyone naming it.
 */
export function killSlug(kill: Kill): string {
  // The machine assigns one now, across the whole record at once, so a base two
  // postings claim suffixes both rather than letting the second silently take
  // the first one's card. Where it is present it wins: a slug derived here from
  // company and title would disagree with the record's own the moment a company
  // posts one title twice, and the card route is built from the record.
  const assigned = (kill as Partial<KillRecord>).slug;
  if (typeof assigned === 'string' && assigned.length > 0) return assigned;
  return `${kill.company} ${kill.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * One publishable kill, or null. A held record resolves to null here, which is
 * what keeps a hand-typed /kills/<held slug>/card from ever finding a record to
 * render.
 */
export function killBySlug(slug: string): Kill | null {
  return KILLS.find((kill) => killSlug(kill) === slug) ?? null;
}

export interface KillDuration {
  days: number;
  from: string;
  to: string;
}

/**
 * How long a killed posting stayed open, in days.
 *
 * Computed as `killed_on` minus `first_published`, never read from
 * `duration_open_days`. Ten of the fourteen archived records have both dates and
 * this reproduces every stated duration to the day; the other four have no
 * first_published and return null, which is what makes the bar slot render as an
 * absence rather than a guessed length. Three of those four are published rows,
 * and the fourth is the held record, which renders nowhere at all.
 *
 * This one number drives the bar length, the row label and the share card. They
 * read it here so they cannot disagree.
 */
export function killDuration(kill: Kill): KillDuration | null {
  if (!kill.first_published || !kill.killed_on) return null;
  const days = daysBetween(kill.first_published, kill.killed_on);
  if (days === null) return null;
  return { days, from: kill.first_published, to: kill.killed_on };
}

/** Convenience for the bar: is this a figure we measured ourselves? */
export const measuredByUs = (kill: Kill): boolean =>
  kill.duration_provenance === 'observed_by_us' && killDuration(kill) !== null;

export interface BothLists {
  company: string;
  /** The kills at this company. */
  kills: Kill[];
  /** The live or re-verified postings at the same company, in the same sweep. */
  live: Job[];
}

/**
 * Companies that appear on both lists, computed.
 *
 * A company can have a killed posting and a verified live one in the same
 * sweep, and saying so on the row costs nothing, is true, and makes every other
 * row more credible. No company name appears anywhere in this function: it is
 * the intersection of kill companies and companies holding a live or
 * re_verified role, so it stays correct when the fixture is replaced by the
 * full nightly export, where the overlap will be larger and will move every day.
 *
 * On the current data it yields Gamma, Harvey, Mercury and Vercel.
 */
export function companiesOnBothLists(): BothLists[] {
  const liveByCompany = new Map<string, Job[]>();
  for (const job of verifiedJobs()) {
    const existing = liveByCompany.get(job.company);
    if (existing) existing.push(job);
    else liveByCompany.set(job.company, [job]);
  }

  const out = new Map<string, BothLists>();
  for (const kill of KILLS) {
    const live = liveByCompany.get(kill.company);
    if (!live || live.length === 0) continue;
    const entry = out.get(kill.company);
    if (entry) entry.kills.push(kill);
    else out.set(kill.company, { company: kill.company, kills: [kill], live });
  }

  return [...out.values()].sort((a, b) => a.company.localeCompare(b.company));
}

/** The live siblings for one kill, or an empty array. */
export function liveSiblingsOf(kill: Kill): Job[] {
  return liveJobsAtCompany(kill.company);
}

/**
 * The archived posting this kill is the record of, when the sweep still holds
 * one, or null.
 *
 * WHY IT EXISTS. /role/uplight-senior-product-designer is the only closed
 * record in this fixture and the whole CLOSED variant of the job detail page,
 * and nothing on the site linked to it: the index lists live rows only, and the
 * Uplight kill row offered its share card. A page with no inbound link is a
 * deliverable that shipped and cannot be read, which is the same defect the
 * Desk preview had.
 *
 * MATCHED ON COMPANY AND TITLE, NOT ON THE SLUG. The two slugs happen to be
 * identical for Uplight and that is a coincidence of two derivations: a job
 * slug arrives in the export and a kill slug is computed here from company plus
 * title. Matching the pair that actually identifies a posting means the link
 * survives an export that starts slugging differently, and means a kill with no
 * archived record returns null rather than pointing at a URL nobody built.
 *
 * A live posting is never returned. A company can hold a killed posting and a
 * live one with the same title, and the live one already has its own treatment
 * in liveSiblingsOf(). This link is specifically "here is the record of the
 * thing that died".
 */
export function closedRecordFor(kill: Kill): Job | null {
  return closedJobs().find((job) => job.company === kill.company && job.title === kill.title) ?? null;
}

export interface RepeatOffender {
  company: string;
  count: number;
  kills: Kill[];
}

/**
 * Companies with more than one kill this sweep.
 *
 * Brex has two. The work order is explicit that this is a count and a grouping,
 * not a leaderboard: at this sample size a ranking would read as a finding the
 * data cannot support.
 */
export function repeatOffenders(): RepeatOffender[] {
  const byCompany = new Map<string, Kill[]>();
  for (const kill of KILLS) {
    const existing = byCompany.get(kill.company);
    if (existing) existing.push(kill);
    else byCompany.set(kill.company, [kill]);
  }

  return [...byCompany.entries()]
    .filter(([, kills]) => kills.length > 1)
    .map(([company, kills]) => ({ company, count: kills.length, kills }))
    .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company));
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface Page<T> {
  /** 1 based, because it is shown to a reader as "page 1 of 5". */
  number: number;
  rows: T[];
  /** The 1 based row numbers this page covers, for the "rows 1-8" line. */
  firstRow: number;
  lastRow: number;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Splits rows into pages. 37 rows at 8 per page is 5 pages, the last holding 5.
 *
 * Returns the whole set of pages rather than one page, because a static build
 * needs every page to exist at build time and because the pagination control has
 * to know the total before it can say "of 5".
 */
export function paginate<T>(rows: readonly T[], perPage: number): Page<T>[] {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error(`data.ts: paginate() needs a positive whole page size, got ${perPage}.`);
  }
  if (rows.length === 0) {
    return [{ number: 1, rows: [], firstRow: 0, lastRow: 0, isFirst: true, isLast: true }];
  }

  const total = Math.ceil(rows.length / perPage);
  const pages: Page<T>[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * perPage;
    const slice = rows.slice(start, start + perPage);
    pages.push({
      number: index + 1,
      rows: slice,
      firstRow: start + 1,
      lastRow: start + slice.length,
      isFirst: index === 0,
      isLast: index === total - 1
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/**
 * Rubric v1, verbatim from the approved job detail canvas:
 * "FIT 96 = 27+25+20+15+9 · RUBRIC V1 · WEIGHTS 30+25+20+15+10".
 *
 * The labels are the canvas's own wording. The weights are what a bar is drawn
 * against, which is the only reason they are here: without a stated maximum a
 * bar length is a picture of nothing.
 */
export const RUBRIC = [
  { key: 'title_scope', label: 'Title scope', weight: 30 },
  { key: 'remote_geo', label: 'Remote and geography', weight: 25 },
  { key: 'comp', label: 'Compensation', weight: 20 },
  { key: 'freshness', label: 'Freshness', weight: 15 },
  { key: 'apply_friction', label: 'Apply friction', weight: 10 }
] as const;

export type FitKey = (typeof RUBRIC)[number]['key'];

/**
 * Where the component split behind a total came from.
 *
 *   measured              the machine scored each component and exported it
 *   derived_from_weights  the export carries a real total and a split that was
 *                         back-filled from the rubric weights so that a sum
 *                         check has something to verify
 *
 * The value is read from `_meta.fit_component_provenance` in
 * `src/data/jobs.json`, and today it is `derived_from_weights`, which the
 * fixture has said in prose since it was written: "Totals are real sweep
 * scores. Component splits are derived from rubric v1 weights."
 *
 * WHY THIS IS A FIELD AND WHY IT DECIDES WHAT RENDERS. A component value that
 * was back-filled is not an observation, and this site's first rule is that it
 * never renders a number whose provenance it cannot show. Printing "Title scope
 * 37/30" in the machine voice, with a bar, states that the machine read 37 on
 * that component. It did not. So while the provenance is anything other than
 * `measured`, the totals render (they are real) and the components render as
 * truthful absences against their real published weights. The night the export
 * carries measured splits, the field flips and every bar appears with no change
 * to a page. Same shape as `kill_rule`, `role_family` and the five
 * unprovenanced ages: a defect that belongs upstream, rendered honestly
 * downstream in the meantime.
 */
export type FitComponentProvenance = 'measured' | 'derived_from_weights';

function readFitProvenance(rawMeta: unknown): FitComponentProvenance {
  const value = (rawMeta as Record<string, unknown> | null)?.fit_component_provenance;
  if (value === undefined || value === null) {
    // The safe default is suppression. An export that forgets to declare where
    // its splits came from gets treated as though they were derived, because
    // the cost of that is a page saying less than it could, and the cost of the
    // other default is a page asserting a reading nobody took.
    return 'derived_from_weights';
  }
  if (value !== 'measured' && value !== 'derived_from_weights') {
    throw new Error(
      `data.ts: src/data/jobs.json declares _meta.fit_component_provenance = ${JSON.stringify(value)}. It is either "measured" or "derived_from_weights"; anything else is a claim nobody defined.`
    );
  }
  return value;
}

const FIT_COMPONENT_PROVENANCE: FitComponentProvenance = readFitProvenance(jobsDoc._meta);

/** True only when the export says the machine scored each component itself. */
export const fitComponentsPublished = (): boolean => FIT_COMPONENT_PROVENANCE === 'measured';

export interface FitComponent {
  key: FitKey;
  label: string;
  /** The measured value, or null when the export publishes no component split. */
  value: number | null;
  weight: number;
  /**
   * The value as a fraction of its weight, or null when there is no published
   * value, or when the value falls outside 0 to weight and no honest bar can be
   * drawn.
   */
  fraction: number | null;
  /** False when the stored value is above its weight or below zero. */
  inRange: boolean;
}

export interface FitBreakdown {
  total: number;
  components: FitComponent[];
  /** True when the components are the machine's own readings, not back-filled. */
  published: boolean;
  /** The sum, which equals the total. Rendered as the working: 27+25+20+15+9. */
  sum: number;
  /** "27+25+20+15+9", for the line that shows the arithmetic. Null unpublished. */
  workingOut: string | null;
  /** The rubric weights as the canvas states them: "30+25+20+15+10". */
  weightsOut: string;
  /** True when at least one published component lies outside its weight. */
  hasOutOfRange: boolean;
}

/**
 * The five components and their total.
 *
 * Throws when the components do not sum to the total. Gate 2 checks the same
 * thing against the built HTML, but a score that does not add up should never
 * reach a page in the first place: the rubric is the reason a score is allowed
 * on screen at all.
 *
 * Eight of the 38 records carry a component outside its rubric weight
 * (title_scope up to 40 against a weight of 30, apply_friction as low as -5).
 * Every one of those totals still sums correctly, so the score itself is sound
 * and the split is what is wrong. Those components are marked `inRange: false`
 * and given a null fraction, and FitBars draws no bar for them: clipping 37 to
 * a full 30 bar would draw a picture that says "capped" about a number that is
 * not capped. This is a data defect for the export script, in the same family as
 * `kill_rule` and the five unprovenanced ages.
 */
export function fitComponents(job: Job): FitBreakdown {
  const published = fitComponentsPublished();

  // The sum is checked against the stored values whether or not they render.
  // An export whose components do not add up to its total is broken even when
  // nobody is looking at the split, and this is the cheapest place to find out.
  const sum = RUBRIC.reduce((running, { key }) => running + job.fit[key], 0);
  if (sum !== job.fit.total) {
    throw new Error(
      `data.ts: ${job.slug} has a fit total of ${job.fit.total} and components summing to ${sum}. The rubric is the score. Fix the component that is wrong, never the total.`
    );
  }

  const components: FitComponent[] = RUBRIC.map(({ key, label, weight }) => {
    const stored = job.fit[key];
    const inRange = stored >= 0 && stored <= weight;
    return {
      key,
      label,
      value: published ? stored : null,
      weight,
      fraction: published && inRange ? stored / weight : null,
      inRange
    };
  });

  return {
    total: job.fit.total,
    components,
    published,
    sum,
    workingOut: published ? RUBRIC.map(({ key }) => job.fit[key]).join('+') : null,
    weightsOut: RUBRIC.map((entry) => entry.weight).join('+'),
    hasOutOfRange: published && components.some((component) => !component.inRange)
  };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const FACT_BY_ID = new Map(FACTS.map((entry) => [entry.id, entry]));

export function factEntry(id: string): Fact {
  const found = FACT_BY_ID.get(id);
  if (!found) {
    throw new Error(
      `data.ts: no fact "${id}" in src/data/facts.json. The eight entries there are the only statistics allowed on this site, and a new one needs a line in that file with its source before it can be rendered. Known ids: ${[...FACT_BY_ID.keys()].join(', ')}.`
    );
  }
  return found;
}

/**
 * The verbatim fact string.
 *
 * Pages never type a statistic. Gate 2 compares rendered copy against
 * facts.json character for character, so a page that spells a number out by
 * hand fails the build the first time somebody rewords a sentence. Calling this
 * makes that impossible instead of merely discouraged.
 */
export const fact = (id: string): string => factEntry(id).string;

/** The named source, for the mono citation that has to sit beside the number. */
export const factSource = (id: string): string => factEntry(id).source;

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------
//
// The same shape as facts, deliberately, so the licence rule reads identically
// at both call sites. The difference is what the string is allowed to be: a
// fact is a number we restate in our own sentence, and a citation is a sentence
// somebody else wrote, which we may place and frame but never edit.

const CITATION_BY_ID = new Map(CITATIONS.map((entry) => [entry.id, entry]));

export function citationEntry(id: string): Citation {
  const found = CITATION_BY_ID.get(id);
  if (!found) {
    throw new Error(
      `data.ts: no citation "${id}" in src/data/citations.json. A passage has to be entered there, with its author, work and locator, before any page may quote it. Known ids: ${[...CITATION_BY_ID.keys()].join(', ')}.`
    );
  }
  return found;
}

/** The passage, verbatim. Never typed into a page. */
export const citation = (id: string): string => citationEntry(id).quote;

/** "Ng, Ghost Jobs, arXiv 2410.21771, 2024, page 7". Built, never typed. */
export function citationSource(id: string): string {
  const entry = citationEntry(id);
  return `${entry.author}, ${entry.work}, ${entry.year}, ${entry.locator}`;
}

export const citationIsLicensed = (id: string, route: string): boolean =>
  citationEntry(id).pages.some((pattern) => routeMatches(pattern, route));

export function assertCitationLicensed(id: string, route: string): void {
  if (citationIsLicensed(id, route)) return;
  const entry = citationEntry(id);
  throw new Error(
    `data.ts: citation "${id}" is not licensed for ${route}. It is licensed for ${entry.pages.join(', ')}. A quotation carries the authority of the person who wrote it, so where it may be placed is an editorial decision and not a convenience.`
  );
}

/**
 * Exact routes, or one level globs: "/role/*" covers "/role/x", not "/role/x/y".
 *
 * The route is stripped of the base before it is matched. facts.json licenses a
 * fact to a route of this site, which is an editorial decision, and not to a URL
 * on a particular host, which is a deployment one. Callers pass what nav.ts
 * gives them and that carries the base, so the normalisation happens here once
 * rather than at three call sites. Gate 2 checks the same licences from the
 * built tree, where a route is already base-free, so both instruments read
 * facts.json in the same vocabulary.
 */
function routeMatches(pattern: string, route: string): boolean {
  const bare = stripBase(route);
  if (pattern === bare) return true;
  if (!pattern.endsWith('/*')) return false;
  const prefix = pattern.slice(0, -1);
  return bare.startsWith(prefix) && !bare.slice(prefix.length).includes('/');
}

export const factIsLicensed = (id: string, route: string): boolean =>
  factEntry(id).pages.some((pattern) => routeMatches(pattern, route));

/**
 * Throws at build time when a fact is rendered on a route facts.json has not
 * licensed it to.
 *
 * Gate 2 catches this too, from the built HTML. Catching it here is worth the
 * duplication because the message can name the component, the route and the fix
 * while the build is still standing on the page that caused it.
 */
export function assertLicensed(id: string, route: string): void {
  if (factIsLicensed(id, route)) return;
  const entry = factEntry(id);
  throw new Error(
    `data.ts: fact "${id}" is not licensed for ${route}. It is licensed for ${entry.pages.join(', ')}. Either render it on one of those routes, or add "${route}" to its pages list in src/data/facts.json deliberately. A fact spreading across the site without anyone deciding is what that list exists to prevent.`
  );
}

/** Every fact a given route may render. Useful for a page auditing itself. */
export const factsFor = (route: string): Fact[] =>
  FACTS.filter((entry) => entry.pages.some((pattern) => routeMatches(pattern, route)));

/**
 * The kill list's reference line: the average lifespan of a real single position
 * posting, in days.
 *
 * Read out of the fact string rather than typed as 9.8, so the line and the
 * sentence that cites it cannot drift apart. If the fact is ever restated the
 * bar moves with it, and if the number is ever removed from the string this
 * throws rather than silently drawing a reference line at nothing.
 */
export function referenceDays(): number {
  const source = fact('posting-lifespan');
  const match = /(\d+(?:\.\d+)?)\s*days/.exec(source);
  if (!match) {
    throw new Error(
      `data.ts: could not read a day count out of the "posting-lifespan" fact ("${source}"). The kill list reference line is drawn from that number, so it cannot be inferred.`
    );
  }
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

/**
 * The sorts the canvas offers. Fit is the default and it blends the rubric score
 * with freshness, which the table footnote says out loud, per standing rule 4.
 */
export type SortKey = 'fit' | 'comp' | 'age';

/**
 * The regex SOURCE shared by compTop() below and job-store.ts's SQL comp_top
 * column, so the sort key can't drift from what compTop actually computes,
 * the way it drifted from compShortFromText() for months: the display cell
 * (compShortFromText) matches "$150,000" and prints a range; this pattern
 * used to require a literal "k" and no comma, so that same row sorted as if
 * it stated no pay at all. Written once here and consumed two ways:
 * compTop() below builds a JS RegExp from it, and job-store.ts's
 * BOARD_FACET_CTE interpolates the raw string into the SQL text it hands to
 * Postgres' regexp_matches(). THE TWO CONSUMERS MUST BE CHANGED TOGETHER —
 * see the matching comment on comp_top in job-store.ts.
 *
 * Group 1 is the digits, comma grouping intact ("150,000" or "150" or
 * "150.5"). Group 2 is a trailing "k"/"K" if present, else unmatched (NULL
 * in Postgres, undefined in JS) — that flag is what tells the consumer
 * whether the figure is already stated in thousands or is a full dollar
 * amount that still needs dividing by 1000.
 */
export const COMP_TOP_PATTERN = '\\$(\\d[\\d,]*(?:\\.\\d+)?)(k)?';

/**
 * The top of a posted range, in thousands, or null.
 *
 * Recognises whatever compShortFromText() below can display: "$204k-$348k"
 * gives 348, "$300k-$450k + equity" gives 450, "$150,000" gives 150,
 * "$150,000 - $250,000" gives 250, "USD $150,000 - $250,000 DOE" gives 250,
 * and a null comp_posted gives null. A figure with no "k" is treated as a
 * full dollar amount and divided by 1000 to land in the same unit as a "k"
 * figure ("$150,000" and "$150k" both give 150) — which also keeps a small
 * bare number such as "$45" (plausibly hourly, not annual) from landing in
 * the same range as a real salary: it becomes 0.045, not 45. This file has
 * no hourly/monthly unit of its own, so that is the full extent of the
 * protection; it does not attempt to detect or label a rate.
 *
 * Equity percentages, commission and zone qualifiers are ignored for
 * ordering and are never dropped from what a reader sees, because the cell
 * renders the string verbatim. Nine records post no range at all and sort
 * last rather than sorting as zero.
 */
export function compTop(job: Job): number | null {
  if (!job.comp_posted) return null;
  const amounts = [...job.comp_posted.matchAll(new RegExp(COMP_TOP_PATTERN, 'gi'))].map((match) => {
    const value = Number(match[1].replace(/,/g, ''));
    return match[2] ? value : value / 1000;
  });
  if (amounts.length === 0) return null;
  return Math.max(...amounts);
}

/** The currency symbols the board's pay ranges use; a code prefix otherwise. */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CAD: 'CA$',
  AUD: 'A$',
  EUR: '€',
  GBP: '£'
};

/**
 * A short, clean pay range for a board row: "$180K-$225K", from the structured
 * comp_range the ATS handed the tracker. Null where there is no structured
 * range.
 *
 * WHY THE ROW SHOWS THIS AND NOT comp_posted. Many postings write their pay as a
 * paragraph of location-conditional bands ("US employees in NYC ... 180,200 -
 * 225,200 USD | US employees outside ... | Canadian employees ..."). That is a
 * page of prose, not a cell, and it breaks the row. The overview shows the one
 * number a reader scans for; the posting's full pay text stays on the detail
 * page, verbatim, where there is room for it.
 */
export function compShort(job: Job): string | null {
  const range = job.comp_range;
  if (range && typeof range.min === 'number' && range.min > 0) {
    const symbol = range.currency ? CURRENCY_SYMBOL[range.currency] ?? `${range.currency} ` : '$';
    const k = (value: number): string => `${symbol}${Math.round(value / 1000)}K`;
    const max = typeof range.max === 'number' && range.max > range.min ? range.max : null;
    return max ? `${k(range.min)}-${k(max)}` : k(range.min);
  }
  // Fallback for the few postings the ATS gave no structured range: pull the
  // first pay figure out of the posted text, for the overview cell only. The
  // full text still shows verbatim on the detail page. This reads a number from
  // prose, which the site avoids everywhere it can; it is confined here because
  // the alternative is a blank cell on a posting that plainly states its pay.
  return compShortFromText(job.comp_posted);
}

/** The symbols and codes the fallback recognises, mapped to a display symbol. */
const CURRENCY_FROM_TEXT: Record<string, string> = {
  $: '$',
  '€': '€',
  '£': '£',
  USD: '$',
  CAD: 'CA$',
  AUD: 'A$',
  EUR: '€',
  GBP: '£'
};

/** First "N - M" pay figure in a posted string as "$180K-$225K", or null. */
export function compShortFromText(text: string | null): string | null {
  if (!text) return null;
  const SEP = '(?:[-\\u2013\\u2014]|to)';
  const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
  const SYM = '([$\\u20AC\\u00A3])?';
  const pattern = new RegExp(`${SYM}\\s?${NUM}\\s?(k)?\\s?${SEP}\\s?${SYM}\\s?${NUM}\\s?(k)?\\s?(USD|CAD|AUD|EUR|GBP)?`, 'i');
  const match = pattern.exec(text);
  if (!match) return null;
  const scale = (raw: string, k?: string): number => {
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) return NaN;
    return k ? value * 1000 : value;
  };
  const low = scale(match[2], match[3]);
  const high = scale(match[5], match[6]);
  if (Number.isNaN(low)) return null;
  const symbolKey = match[1] || match[4] || (match[7] ? match[7].toUpperCase() : '$');
  const symbol = CURRENCY_FROM_TEXT[symbolKey] ?? '$';
  const k = (value: number): string => `${symbol}${Math.round(value / 1000)}K`;
  return !Number.isNaN(high) && high > low ? `${k(low)}-${k(high)}` : k(low);
}

/**
 * Sorts a copy of the rows. Never sorts in place: the caller's array is usually
 * the frozen fixture order, which is the machine's own and worth keeping.
 *
 * Every comparison puts an unknown last. A row with no posted comp is not a row
 * with a comp of zero, and a row with no measurable age is not a new row.
 */
export function sortJobs(jobs: readonly Job[], key: SortKey): Job[] {
  const rows = [...jobs];
  if (key === 'fit') {
    return rows.sort((a, b) => b.fit.total - a.fit.total || a.company.localeCompare(b.company));
  }
  if (key === 'comp') {
    return rows.sort((a, b) => {
      const left = compTop(a);
      const right = compTop(b);
      if (left === null && right === null) return a.company.localeCompare(b.company);
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    });
  }
  return rows.sort((a, b) => {
    const left = ageOf(a);
    const right = ageOf(b);
    if (left === null && right === null) return a.company.localeCompare(b.company);
    if (left === null) return 1;
    if (right === null) return -1;
    return left.days - right.days;
  });
}

export const SORT_KEYS: readonly SortKey[] = ['fit', 'comp', 'age'];

/** A row's position under each sort, 0 based. */
export type SortRanks = Record<SortKey, number>;

/**
 * Every row's position under all three sorts, computed once at build time.
 *
 * The reason this exists rather than a comparator in browser script: the sort
 * island has to reorder rows without shipping the data, and a second comparator
 * written in a `<script>` block would be a second opinion about what "sort by
 * comp" means. Ranks are integers the browser can order with no knowledge of
 * comp strings, missing ages or tie breaks. sortJobs() above stays the only
 * place those rules are written down, and the island inherits them for free.
 */
export function sortRanks(jobs: readonly Job[]): Map<string, SortRanks> {
  const ranks = new Map<string, SortRanks>();
  for (const job of jobs) {
    ranks.set(job.slug, { fit: 0, comp: 0, age: 0 });
  }
  for (const key of SORT_KEYS) {
    sortJobs(jobs, key).forEach((job, index) => {
      const entry = ranks.get(job.slug);
      if (entry) entry[key] = index;
    });
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Duplicate-cluster collapse (MASTER-SPEC F10)
// ---------------------------------------------------------------------------

/**
 * One company, one title, every posting the sweep verified for it, each at a
 * different point in the sweep's own array order. `postings` holds every
 * member in the order the caller's array gave them, which on the index is
 * already sortJobs()'s order, so `postings[0]` is whichever member the
 * caller's own sort already ranked best. JobTable reads that member's own
 * real fit, comp and rank for the collapsed row rather than this file
 * inventing a merged figure no single posting actually carries. `locations`
 * is the distinct location strings across those postings, in first
 * appearance order, deduplicated by the same exact-match rule clusterJobs()
 * uses throughout: it can be shorter than `postings` if two postings happen
 * to carry the identical location string, never longer.
 */
export interface JobCluster {
  company: string;
  title: string;
  postings: readonly Job[];
  locations: readonly string[];
}

/**
 * One row of the index table after collapse: an ordinary posting with no
 * duplicate, or a cluster of two or more. JobTable renders the two cases
 * differently; nothing else in this file needs to tell them apart.
 */
export type ClusterRow = { kind: 'single'; job: Job } | { kind: 'cluster'; cluster: JobCluster };

/**
 * Collapses same-title-same-company postings into one row, per MASTER-SPEC
 * F10 ("the same title at the same company across multiple locations renders
 * as one row with a location list, expandable"). Pure: reads only `jobs`,
 * returns a new array, mutates nothing it was given, calls no clock and no
 * random source, so the same array in is the same array out, byte for byte,
 * every time.
 *
 * THE RULE FOR "SAME", spelled out because F10 leaves it to this file to
 * decide:
 *
 *   - company and title are compared with plain `===`. Nothing is trimmed,
 *     nothing is case-folded, nothing is Unicode-normalised. This is the same
 *     rule record.ts's coreMatches() holds a record's own core fields to
 *     ("byte-identical... nothing normalised, nothing trimmed, nothing
 *     case-folded"), and it is the rule the Job interface above already
 *     states for these two fields specifically: title is "never cleaned up,
 *     never normalised", and company carries no license to be either. A
 *     function that cleans a value up before comparing it would be
 *     normalising by the back door.
 *
 *   - Case-folding specifically was considered and rejected as unsafe, not
 *     merely unnecessary. tailor.ts's header lays out why a case-insensitive
 *     match is not a byte-for-byte equivalence: Unicode case folding is not
 *     always reversible, and the Turkish dotted capital I (U+0130) folds
 *     under JavaScript's own .toLowerCase() to a two-codepoint sequence, not
 *     to a plain "i", so a lowercase compare can call two titles "the same"
 *     that do not even share a length. Every title in the published data
 *     happens to be English-language today, but the rule is written for the
 *     type, not for today's rows, so nothing here assumes an ASCII-only
 *     title and nothing here case-folds one.
 *
 *   - Whitespace is not trimmed either, for the same reason: a leading or
 *     trailing space is a byte the source actually sent, same as any other
 *     byte in the title. Merging "Product Designer" with "Product Designer "
 *     would be this file guessing that the space was noise, and F10's own
 *     guidance is explicit about which way to guess when unsure: prefer the
 *     strictest rule that still clusters the obvious cases, because a
 *     cluster that merges two genuinely different roles hides a posting from
 *     a reader, which is worse than showing two rows. Checked against the
 *     published data (see data.test.ts), the strictest rule already clusters
 *     every duplicate that exists there, so there is no observed case this
 *     file fails to catch by declining to trim.
 *
 *   - A title that differs by even one word never clusters. "Senior Product
 *     Designer" and "Product Designer" are two different strings, and this
 *     function has no opinion about whether they name the same job: forming
 *     one would be exactly the kind of inference MASTER-SPEC forbids, a
 *     claim about what a posting means built from data the posting itself
 *     does not carry.
 *
 *   - Clustering never crosses `company`. Two identical titles at two
 *     different employers are two different jobs, full stop.
 *
 *   - A posting with `title === null` (a pre-posting row; see the Job
 *     interface) never joins a cluster, including with another pre-posting
 *     row at the same company: there is no title to compare, so there is no
 *     basis to say two of them name the same role.
 *
 * A cluster requires two or more postings sharing a (company, title) key. It
 * does not additionally require their locations to differ: two postings
 * identical in company, title AND location would still cluster (they are,
 * definitionally, the same title at the same company), and their shared
 * location collapses to one entry in `locations` rather than being listed
 * twice. F10 describes the case that motivates this rule, the same role
 * posted to several city boards, but nothing about the rule itself requires
 * checking whether the locations differ before it applies; doing so would
 * mean defining a second, separate notion of "different" this file would
 * then also have to justify.
 */
export function clusterJobs(jobs: readonly Job[]): ClusterRow[] {
  const groups = new Map<string, Job[]>();
  // Every job with no title gets its own counted key, so none of them ever
  // collide with each other. None of them can collide with a titled job's
  // key either: every titled key below carries U+0000, which cannot appear
  // in a company name or a title a board posted and never appears in an
  // "untitled-N" key, so the two key families never overlap. The U+0000
  // itself is what keeps two different (company, title) pairs from folding
  // onto one key the way a plain space could ("Acme Corp" + "X" would
  // otherwise key the same as "Acme" + "Corp X").
  let untitled = 0;
  for (const job of jobs) {
    const key = job.title === null ? `untitled-${untitled++}` : `${job.company}\u0000${job.title}`;
    const existing = groups.get(key);
    if (existing) existing.push(job);
    else groups.set(key, [job]);
  }

  const rows: ClusterRow[] = [];
  // Map iterates in insertion order, and every key's first insertion follows
  // `jobs`'s own order, so this walk reproduces the caller's row order with
  // duplicates collapsed in place rather than moved to the end.
  for (const postings of groups.values()) {
    if (postings.length === 1) {
      rows.push({ kind: 'single', job: postings[0] });
      continue;
    }
    const locations: string[] = [];
    for (const posting of postings) {
      if (!locations.includes(posting.location)) locations.push(posting.location);
    }
    rows.push({
      kind: 'cluster',
      cluster: {
        company: postings[0].company,
        title: postings[0].title as string,
        postings,
        locations
      }
    });
  }
  return rows;
}

export interface FilterOption {
  value: string;
  label: string;
  /** How many rows this option would leave. Shown, so a dead filter looks dead. */
  count: number;
}

export interface FilterGroup {
  key: string;
  label: string;
  options: FilterOption[];
}

/**
 * Which filter buckets a row belongs to. The table writes these onto each row as
 * data attributes and the filter island reads them back, so filtering never
 * needs the data at runtime.
 */
export interface JobFacets {
  /**
   * 'unknown' is a company before it posts (kind 'pre_posting'): it has no
   * workplace yet, so the Location filter cannot apply to it and JobTable
   * exempts it. Never used for a posting; a posting is one of the other two.
   */
  location: 'remote' | 'onsite' | 'unknown';
  /** A pay band key, or 'not-listed' where the board published no numbers. */
  comp: string;
  freshness: 'fresh' | 'older' | 'unknown';
  /** Which population the row came from. See OpportunityKind. */
  stage: OpportunityKind;
}

/**
 * The window inside which most applications land, in days.
 *
 * Four days, from "56% of applications land in the first 96 hours". The freshness
 * filter exists because that fact is on the index page telling a reader that age
 * matters, and a page that teaches something and then gives you no way to act on
 * it is decoration. Derived from the fact rather than chosen, for the same
 * reason the kill list reference line is.
 */
export const FRESH_WINDOW_DAYS = 4;

/**
 * The pay bands the comp filter offers.
 *
 * BANDED ON THE FLOOR, WHICH IS A CHOICE AND IS STATED ON THE PAGE. A posting
 * that reads 169,000 to 303,000 spans four of these bands, so something has to
 * decide which one it sits in. Banding on the floor answers "what is the least
 * this employer has committed to", which is the number a reader can hold them
 * to; banding on the ceiling would answer "what might they pay", which is the
 * number a job advert is written to make you imagine. The exclusive banding
 * also means the counts add up to the total, and a filter whose counts do not
 * add up is a filter nobody trusts.
 *
 * THE NUMBERS COME FROM THE MACHINE, NEVER FROM THE PROSE. Each row's floor is
 * comp_range.min, parsed by the sweep out of the board's own structured pay
 * field. This site never reads a number out of an employer's sentence: the one
 * time that was the only option, the answer was to have the machine emit the
 * field instead. See comp_range_for in export-site-data.py.
 *
 * The edges are round hundred thousands because pay is discussed in round
 * hundred thousands. They are not derived from the distribution, and that is
 * deliberate: edges that move with the data would renumber themselves every
 * night and a reader who filtered to a band yesterday would find a different
 * band under the same label today.
 */
export const COMP_BANDS: { key: string; label: string; floor: number; ceiling: number | null }[] = [
  { key: 'under-150', label: 'Under $150K', floor: 0, ceiling: 150_000 },
  { key: '150-200', label: '$150K to $200K', floor: 150_000, ceiling: 200_000 },
  { key: '200-250', label: '$200K to $250K', floor: 200_000, ceiling: 250_000 },
  { key: '250-300', label: '$250K to $300K', floor: 250_000, ceiling: 300_000 },
  { key: '300-plus', label: '$300K and up', floor: 300_000, ceiling: null }
];

/** The band a posting's floor falls in, or null where there is no floor. */
export function compBandOf(job: Job): string | null {
  const low = job.comp_range?.min;
  if (typeof low !== 'number' || !Number.isFinite(low) || low <= 0) return null;
  const band = COMP_BANDS.find((b) => low >= b.floor && (b.ceiling === null || low < b.ceiling));
  return band ? band.key : null;
}

export function facetsOf(job: Job): JobFacets {
  const age = ageOf(job);
  return {
    // REMOTE MEANS THE POSTING SAYS REMOTE, NOT THAT A FLAG WAS SET. The board's
    // own `remote` boolean is true on 37 of 63 postings whose location text names
    // an office or a city ("SF Office", "New York"), so filtering on the flag put
    // those under Remote, and a reader who chose Remote got a deskful of offices.
    // The facet now agrees with workplaceOf(): a posting is 'remote' only where
    // its own words say remote. Everything else, including a posting flagged
    // remote whose location names a place, is 'onsite', the same set the
    // "On-site or hybrid" option already hedges. See workplaceOf() for the rule.
    //
    // A COMPANY THAT HAS NOT POSTED YET HAS NO WORKPLACE. Until 2026-09-10 a
    // Pre-List row was 'onsite' by default, so a Location filter saved on the
    // Board ("Remote") carried over to Newly Funded and emptied it: 374 rows,
    // zero matches, and nothing on the page said why. 'unknown' is the honest
    // facet, and JobTable lets it through whatever Location is selected.
    location: job.kind === 'pre_posting' ? 'unknown' : workplaceOf(job) === 'Remote' ? 'remote' : 'onsite',
    comp: compBandOf(job) ?? 'not-listed',
    freshness: age === null ? 'unknown' : age.days <= FRESH_WINDOW_DAYS ? 'fresh' : 'older',
    stage: job.kind
  };
}

/**
 * The filter groups, derived from the rows themselves.
 *
 * Three groups, not the canvas's four. The canvas draws a "Role family" filter
 * and the data carries no role family: deriving one by reading job titles would
 * mean this repository inventing a classification and presenting it as the
 * machine's finding, which is the same objection that blocked the kill list's
 * reason taxonomy. The field is emitted upstream or the filter does not ship.
 * See DECISIONS.md.
 *
 * Every option label describes exactly what the field holds. "Remote" means the
 * posting's own location text says remote, not merely that the board set a
 * remote flag: the flag disagrees with the words on more than half the board,
 * so the words win. See workplaceOf() and facetsOf() for the evidence-first
 * rule the filter and the per-row workplace label now share.
 */
/**
 * The same three groups, built from counts the store computed in SQL over the
 * filtered set (job-store.ts listBoardFiltered), for the server-paged board
 * where the rows on the page are not the population. Same labels, same
 * pruning as filterGroups(): an empty comp band is not offered, a group whose
 * every row falls in one option is a label and not a filter. One addition: the
 * option the address currently names is never dropped, so a select can always
 * show what the URL says even when it would leave nothing.
 */
export function facetGroupsFromCounts(
  counts: { location: Record<string, number>; comp: Record<string, number>; freshness: Record<string, number> },
  selected: { location: string; comp: string; freshness: string }
): FilterGroup[] {
  const keep = (group: FilterGroup, current: string): FilterGroup => ({
    ...group,
    options: group.options.filter((o) => o.count > 0 || o.value === 'all' || o.value === current || o.value === 'not-listed')
  });
  const groups: FilterGroup[] = [
    keep(
      {
        key: 'location',
        label: 'Location',
        options: [
          { value: 'all', label: 'All', count: counts.location.all ?? 0 },
          { value: 'remote', label: 'Remote', count: counts.location.remote ?? 0 },
          { value: 'onsite', label: 'On-site or hybrid', count: counts.location.onsite ?? 0 }
        ]
      },
      selected.location
    ),
    keep(
      {
        key: 'comp',
        label: 'Comp',
        options: [
          { value: 'all', label: 'All', count: counts.comp.all ?? 0 },
          ...COMP_BANDS.map((band) => ({ value: band.key, label: band.label, count: counts.comp[band.key] ?? 0 })),
          { value: 'not-listed', label: 'Not listed', count: counts.comp['not-listed'] ?? 0 }
        ]
      },
      selected.comp
    ),
    keep(
      {
        key: 'freshness',
        label: 'Freshness',
        options: [
          { value: 'all', label: 'All', count: counts.freshness.all ?? 0 },
          { value: 'fresh', label: 'Inside 96 hours', count: counts.freshness.fresh ?? 0 },
          { value: 'older', label: 'Older', count: counts.freshness.older ?? 0 },
          { value: 'unknown', label: 'No date shown', count: counts.freshness.unknown ?? 0 }
        ]
      },
      selected.freshness
    )
  ];
  return groups.filter(
    (group, i) =>
      group.options.filter((o) => o.count > 0).length > 1 ||
      [selected.location, selected.comp, selected.freshness][i] !== 'all'
  );
}

export function filterGroups(jobs: readonly Job[]): FilterGroup[] {
  const facets = jobs.map(facetsOf);
  const count = (predicate: (facet: JobFacets) => boolean): number => facets.filter(predicate).length;

  // A "Stage" group used to sit first here, splitting posted rows from
  // pre-posting ones for a reader who wanted one or the other. It belonged to
  // allOpportunities(), the combined list this function no longer receives:
  // the index now calls filterGroups(verifiedJobs()), every row facets to
  // 'posted', and a control offering "Posted role" over "Before the post"
  // on a table with no pre-posting rows has one live option and changes
  // nothing. That is the dead control this repo's own components README
  // warns against, so it is removed rather than shipped inert. The facet
  // itself, JobFacets.stage and facetsOf(), is untouched: JobRow still writes
  // data-facet-stage, and the Pre-List RUN-MASTER phase 5 builds can read it.
  return [
    {
      key: 'location',
      label: 'Location',
      options: [
        { value: 'all', label: 'All', count: jobs.length },
        { value: 'remote', label: 'Remote', count: count((facet) => facet.location === 'remote') },
        { value: 'onsite', label: 'On-site or hybrid', count: count((facet) => facet.location === 'onsite') }
      ]
    },
    {
      key: 'comp',
      label: 'Comp',
      options: [
        { value: 'all', label: 'All', count: jobs.length },
        // A band with nothing in it is not offered. Selecting it could only ever
        // produce an empty table, and an option that cannot do anything is a
        // control that teaches a reader the controls do not work.
        ...COMP_BANDS.map((band) => ({
          value: band.key,
          label: band.label,
          count: count((facet) => facet.comp === band.key)
        })).filter((option) => option.count > 0),
        // Last, always, and never hidden even at zero. It is the only option
        // here that describes an absence rather than a value, and the number of
        // employers who published no pay at all is the single most useful thing
        // this filter can tell a reader about the market it is showing them.
        { value: 'not-listed', label: 'Not listed', count: count((facet) => facet.comp === 'not-listed') }
      ]
    },
    {
      key: 'freshness',
      label: 'Freshness',
      options: [
        { value: 'all', label: 'All', count: jobs.length },
        { value: 'fresh', label: 'Inside 96 hours', count: count((facet) => facet.freshness === 'fresh') },
        { value: 'older', label: 'Older', count: count((facet) => facet.freshness === 'older') },
        { value: 'unknown', label: 'No date shown', count: count((facet) => facet.freshness === 'unknown') }
      ]
    }
    // A group whose every row falls in one option is not a filter, it is a
    // label. Dropped rather than shipped dead.
  ].filter((group) => group.options.filter((option) => option.count > 0).length > 1);
}

// ---------------------------------------------------------------------------
// Small render helpers, so seven pages phrase one absence one way
// ---------------------------------------------------------------------------

/**
 * The two absences, spelled once.
 *
 * DESIGN-BRIEF.md standing rule 1 names both strings. They are here rather than
 * in each component because "No date shown" and "No date given" would look like
 * the same decision made twice and read as sloppiness, and because an absence is
 * editorial text: it renders in the human voice, never in the mono machine voice,
 * since there is no machine fact to state.
 */
export const ABSENCE = {
  date: 'No date shown',
  value: 'Not listed'
} as const;

/** "2d", "40d", "685d". Mono, tabular, no thousands separator: it is a count. */
export const formatDays = (days: number): string => `${days}d`;

/** "6h", "18h", "71h". Same register as formatDays, for a row inside the arrival window. */
export const formatHours = (hours: number): string => `${hours}h`;

/**
 * The plain age of a posting as a reader-facing duration: hours up to and
 * including 48 hours old (when there is a `published_at` to measure from), days
 * after that. The hours-to-days cut is 48, deliberately tighter than the 96 hour
 * arrival window `ageHours()` still tracks for the apply window: a posting more
 * than two days old reads as days ("3d"), not a large hour count ("71h"). This
 * is `formatAge()` without its window compound ("13d of 30"), for callers that
 * want the bare duration, such as the two endpoints of the age plot's axis.
 */
export function formatAgeDuration(job: Job): string | null {
  const age = ageOf(job);
  if (!age) return null;
  return formatAgeLabel(job.published_at, age.days);
}

/**
 * The same duration label as formatAgeDuration, from a row's own two facts
 * rather than from a whole Job.
 *
 * The age plot no longer holds a Job per row; it holds a per-day histogram whose
 * representative carries only a published instant and a day count (the two
 * things the label needs). So the hours-vs-days rule lives here, and
 * formatAgeDuration above is its Job-shaped caller, so the two can never drift.
 * The rule is unchanged: hours through 48 when there is an instant to measure
 * from and it is still that young, days after that.
 */
export function formatAgeLabel(publishedAt: string | null, days: number): string {
  if (publishedAt) {
    const from = utcInstantMillis(publishedAt);
    const to = utcInstantMillis(sweptAt());
    if (from !== null && to !== null) {
      const hours = Math.round((to - from) / MS_PER_HOUR);
      if (hours >= 0 && hours <= 48) return formatHours(hours);
    }
  }
  return formatDays(days);
}

/**
 * The age plot's data, as a distribution rather than a list of rows.
 *
 * The plot is a histogram: how many verified roles sit at each age, on one axis
 * with two filter handles. It never needs the rows themselves, so the store
 * hands it this shape (src/lib/job-store.ts listBoardAgeHistogram) built by a
 * GROUP BY, instead of every row of the crawl. `ageHistogramFromJobs` below is
 * the same shape built in memory from Jobs: the reference the SQL must match,
 * and what the plot's own tests render.
 */
export interface AgeBucket {
  /** The measured age in whole days, the group key. */
  days: number;
  /** How many verified (title-bearing) roles sit at this age. */
  rows: number;
  /** One posting at this age, named only where a tick stands for exactly one. */
  repCompany: string;
  repTitle: string;
  /** That posting's published instant, for the young end's hours label. */
  repPublishedAt: string | null;
}

export interface AgeHistogram {
  /** One entry per distinct measured age, ascending. Title-bearing rows only. */
  byDay: AgeBucket[];
  // (axisMax and total follow; EMPTY_AGE_HISTOGRAM below is the no-rows value.)
  /**
   * The oldest measured age, over EVERY measured row including title-less ones,
   * because the axis is drawn to the oldest thing on it whether or not that row
   * gets a mark.
   */
  axisMax: number;
  /** Every title-bearing measured row, the number the plot prints. */
  total: number;
}

/** The distribution of a board with nothing to plot: no marks, a zero axis. */
export const EMPTY_AGE_HISTOGRAM: AgeHistogram = { byDay: [], axisMax: 0, total: 0 };

/**
 * Build the age histogram from Jobs, in memory. The store does this in SQL over
 * the whole crawl; this is the in-memory twin for tests and small sets, and it
 * reads age through ageOf() so it cannot disagree with the rest of the site
 * about how old a row is.
 */
export function ageHistogramFromJobs(jobs: readonly Job[]): AgeHistogram {
  const measured = jobs
    .map((job) => ({ job, age: ageOf(job) }))
    .filter((row): row is { job: Job; age: NonNullable<ReturnType<typeof ageOf>> } => row.age !== null);

  const axisMax = measured.reduce((most, row) => Math.max(most, row.age.days), 0);

  // The representative is the row with the earliest published instant (nulls
  // last), matching the SQL's array_agg ORDER BY, so both name the same posting
  // where a bucket has exactly one and label the same instant where it has more.
  const earlier = (a: string | null, b: string | null): boolean => {
    if (a === null) return false;
    if (b === null) return true;
    return a < b;
  };

  const byDayMap = new Map<number, AgeBucket>();
  for (const { job, age } of measured) {
    if (job.title === null) continue;
    const bucket = byDayMap.get(age.days);
    if (!bucket) {
      byDayMap.set(age.days, {
        days: age.days,
        rows: 1,
        repCompany: job.company,
        repTitle: job.title,
        repPublishedAt: job.published_at
      });
      continue;
    }
    bucket.rows += 1;
    if (earlier(job.published_at, bucket.repPublishedAt)) {
      bucket.repCompany = job.company;
      bucket.repTitle = job.title;
      bucket.repPublishedAt = job.published_at;
    }
  }

  const byDay = [...byDayMap.values()].sort((a, b) => a.days - b.days);
  return { byDay, axisMax, total: byDay.reduce((sum, b) => sum + b.rows, 0) };
}

/** Slots across the axis: one per 2px tick at the widest layout (~1238px),
    so no two ticks in a band overlap. */
export const AGE_TICK_SLOTS = 600;
/** Median posting life; the band boundary (mirrors AgePlot's BAND_DAYS). */
export const AGE_BAND_DAYS = 7;

/** Square-root axis position, 0..100. The plot and its ticks share this. */
export function agePosition(days: number, axisMax: number): number {
  return axisMax <= 0 ? 0 : (Math.sqrt(days) / Math.sqrt(axisMax)) * 100;
}

export interface AgeTick {
  at: number;            // the first (youngest) mark's true position
  days: number;          // the first mark's whole-day age
  past: boolean;         // days > bandDays
  rows: number;          // summed over the marks in this slot
  label: string;         // formatAgeLabel of the first mark
  company: string | null;  // set only when rows === 1
  title: string | null;    // set only when rows === 1
}

/** Collapse the histogram to one tick per rendered slot, never overlapping.
    Bucketed by floor(position / slotWidth) within a band, so a live and a
    past tick may share a slot but two same-band ticks never do. First
    (youngest) mark in a slot sets `at`/`days`/label; rows are summed; the
    representative name is kept only when the slot holds exactly one row,
    because naming one of several would be the plot claiming something it did
    not measure. */
export function ageTicks(
  histogram: AgeHistogram,
  axisMax: number,
  opts: { slots?: number; bandDays?: number } = {}
): AgeTick[] {
  const slots = opts.slots ?? AGE_TICK_SLOTS;
  const bandDays = opts.bandDays ?? AGE_BAND_DAYS;
  const step = 100 / slots;
  const buckets = new Map<string, { at: number; days: number; past: boolean; rows: number; first: AgeBucket }>();
  for (const b of histogram.byDay) {
    const at = agePosition(b.days, axisMax);
    const past = b.days > bandDays;
    const key = `${Math.floor(at / step)}:${past ? 1 : 0}`;
    const seen = buckets.get(key);
    if (seen) {
      seen.rows += b.rows;
    } else {
      buckets.set(key, { at, days: b.days, past, rows: b.rows, first: b });
    }
  }
  return [...buckets.values()].map((s) => ({
    at: s.at,
    days: s.days,
    past: s.past,
    rows: s.rows,
    label: formatAgeLabel(s.first.repPublishedAt, s.first.days),
    company: s.rows === 1 ? s.first.repCompany : null,
    title: s.rows === 1 ? s.first.repTitle : null
  }));
}

/**
 * A comp string cut at its spaces, so a narrow column can wrap it without ever
 * breaking a number in half.
 *
 * The comp column is 9.5rem off the canvas and the source's own words are
 * whatever length they are: "$199.9k-$249.9k top metro" measures 203px inside a
 * 152px track. Held on one line it painted over the Location column; truncated
 * it would drop the qualifier that tells a reader which number they are looking
 * at. So the cell wraps, and each part is rendered unbreakable, which puts every
 * line break at a space the source itself wrote.
 *
 * The alternative was to let the browser wrap the raw string. It happens to
 * break at the spaces on this sweep, but only because greedy line filling takes
 * the last opportunity that fits and every range here is narrower than the
 * track. A wider range, say "$1,000,000-$1,200,000 base", has no space break
 * that fits and the browser would split it at the internal hyphen: "$1,000,000-"
 * on one line, "$1,200,000" on the next, which reads as two figures. Splitting
 * the string here makes that impossible rather than unlikely.
 *
 * This does not edit the value. Joining the parts back with single spaces
 * returns the source's own string, which is what gate 2 reads.
 */
export const compParts = (comp: string): string[] => comp.trim().split(/\s+/);

/**
 * "13d of 30" when the two clocks agree, else the age on its own.
 *
 * A record carrying a longer expiry window holds two different measurements. The
 * age is days since the posting was published or first seen; `window.day` is
 * which day of its own window the sweep found it on. On most windowed rows they
 * are the same number and "13d of 30" reads as one fact: thirteen days old,
 * inside a thirty day window.
 *
 * They are not always the same number, and the fraction is only a fact while
 * they are. One record is 119 days old and carries a window whose day counter
 * had run to 30 of 30. Printed as "119d of 30" it reads as a fraction that
 * cannot be true, because the numerator and the denominator are measuring
 * different things, and /methodology explains the pattern as an age against its
 * window. So the compound reading renders only where the record can evidence it,
 * and everywhere else the age renders alone, which is a number the page can
 * always show its working for. Nothing is dropped: the window is still on the
 * record, and the verification window section of the markdown twin states it.
 */
export function formatAge(job: Job): string | null {
  const age = ageOf(job);
  if (!age) return null;
  if (job.window && age.days === job.window.day) return `${age.days}d of ${job.window.days}`;
  return formatAgeDuration(job);
}

/** The mark state a row shows. Two live states, one closed, per the legend canon. */
export function markStateOf(job: Job): 'verified' | 're-verified' | 'closed' {
  if (job.status === 'closed') return 'closed';
  if (job.status === 're_verified') return 're-verified';
  return 'verified';
}

/**
 * The source system, as a reader sees it. The fixture stores machine keys and
 * the canvas prints proper names, so the mapping lives here rather than being
 * re-typed on every surface that names a board.
 */
const SOURCE_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  workday: 'Workday',
  amazon: 'Amazon',
  lever: 'Lever',
  netflix: 'Netflix',
  workable: 'Workable',
  rippling: 'Rippling',
  jobvite: 'Jobvite',
  usajobs: 'USAJOBS',
  yc: 'Work at a Startup',
  breezy: 'Breezy HR',
  bamboohr: 'BambooHR',
  recruitee: 'Recruitee',
  teamtailor: 'Teamtailor',
  icims: 'iCIMS',
  successfactors: 'SuccessFactors',
  taleo: 'Taleo',
  personio: 'Personio',
  custom: 'the company site',
  founder_post: 'the founder posting'
};

/**
 * The source system, as a reader sees it. Falls through the same way atsLabel
 * does, because job.source_system can now be a board this file has never named
 * (see the SourceSystem comment): a known key gets its SOURCE_LABELS entry, an
 * unknown one gets named from its own key rather than reading as undefined.
 */
export const sourceLabel = (job: Job): string => atsLabel(job.source_system);

/**
 * A display label for ANY applicant-system string, including a board this file
 * does not yet name. Known systems get their SOURCE_LABELS entry; anything else
 * gets a title-cased version of its own key rather than being dropped or
 * relabelled. This is how the Ledger's system dimension stays complete without a
 * hand-maintained list: whatever the sweep emits, it is named, never missed.
 */
export const atsLabel = (ats: string | null | undefined): string => {
  const key = (ats ?? '').trim().toLowerCase();
  if (!key) return 'the company site';
  if (key in SOURCE_LABELS) return SOURCE_LABELS[key as SourceSystem];
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
};

/**
 * How a posting is worked, said only where the posting's own words support it.
 *
 * THE RULE IS EVIDENCE FIRST, AND SILENCE WHEN THE EVIDENCE CONFLICTS. Each
 * posting carries two workplace signals and they do not always agree: a boolean
 * `remote` flag from the board's feed, and the employer's own `location` text.
 * On this sweep, 37 of 63 postings are flagged remote while their location names
 * a specific office or city ("SF Office", "New York"). Calling those "Remote"
 * because the flag says so prints "Remote" under "SF Office", and calling them
 * "Hybrid" because there is an office invents a category the employer never
 * stated. So this function claims a workplace only where the data is explicit,
 * and returns null, rendering nothing, where the two signals contradict:
 *
 *   - the location text says "hybrid" -> Hybrid. The employer's own word.
 *   - the location text says "remote" -> Remote. The employer's own word, and
 *     it wins over the flag either way, because it is the explicit statement.
 *   - not flagged remote, and the text names a place with no remote or hybrid
 *     word -> On-site. A physical location and no signal otherwise is the one
 *     reading the data supports.
 *   - flagged remote but the location names an office or city with no "remote"
 *     or "hybrid" word -> null. The flag and the text disagree and neither is
 *     explicit enough to win, so the row says nothing rather than pick one. A
 *     reliable answer for these would need a structured workplace field in
 *     the published files; the machine is frozen and none is coming, so
 *     silence is the honest label.
 *
 * A pre-posting row has no posting to describe and returns null, the same way
 * it renders no comp and no age.
 */
export type Workplace = 'Remote' | 'Hybrid' | 'On-site';

export function workplaceOf(job: Job): Workplace | null {
  if (job.kind === 'pre_posting') return null;
  const text = typeof job.location === 'string' ? job.location : '';
  if (/\bhybrid\b/i.test(text)) return 'Hybrid';
  if (/\bremote\b/i.test(text)) return 'Remote';
  if (!job.remote) return 'On-site';
  return null;
}

// ---------------------------------------------------------------------------
// Location display
// ---------------------------------------------------------------------------

/**
 * The four spellings of the reader's own country this function ever drops,
 * matched as a whole word or phrase, never as a fragment of a longer one.
 * The lookbehind and lookahead below stand in for `\b`: `\b` fails around
 * "U.S." because a period is a non-word character on both sides of it, so a
 * boundary check built on "is the neighbour alphanumeric" is used instead,
 * and it is what keeps "Massachusetts" and "Austin" untouched (the letters
 * either side of their own "us" are alphanumeric, so the match refuses to
 * start or end there).
 */
const US_HOME_COUNTRY = /(?<![A-Za-z0-9])(united states|u\.s\.|usa|us)(?![A-Za-z0-9])/gi;

/**
 * The same four spellings, but only when they are the entire contents of a
 * parenthetical aside, e.g. "(United States)". Matched and removed as one
 * unit, parentheses and the whitespace leading into them included, so
 * "Remote (United States)" loses the whole aside rather than being left with
 * an empty "Remote ()".
 */
const US_HOME_COUNTRY_PARENTHETICAL = /\s*\(\s*(?:united states|u\.s\.|usa|us)\s*\)/gi;

/** The separator characters this fixture's location strings use between list
    items: a slash, a comma, the bullet locationOf() above also joins with,
    or a semicolon. Kept as one class so the cleanup below does not have to
    know which one a given string happens to use. */
const LOCATION_SEPARATOR = '[/,•;]';

/**
 * Closes the gap US_HOME_COUNTRY's removal leaves in a delimited list: a
 * doubled separator where the dropped token sat between two others ("SF
 * /  / NYC"), a single one left stranded at either edge ("United States /
 * NYC" -> " / NYC"), and, once that is gone, a dangling "or" left over from
 * a prose list that used it as its final connector ("...Canada or United
 * States" -> "...Canada or"). The "or" step is deliberately narrower than
 * the others: it only ever looks at the very start or end of the whole
 * string, and only for a lower case "or", because the same three letters
 * upper case are Oregon's postal code ("Portland, OR") and a mid-string
 * ", or" is an ordinary Oxford-comma connector this function never touched
 * and must not start pretending is doubled.
 */
function cleanLocationSeparators(text: string): string {
  let cleaned = text
    .replace(new RegExp(`\\s*(${LOCATION_SEPARATOR})(?:\\s*${LOCATION_SEPARATOR})+\\s*`, 'g'), ' $1 ')
    .replace(new RegExp(`^\\s*${LOCATION_SEPARATOR}\\s*`), '')
    .replace(new RegExp(`\\s*${LOCATION_SEPARATOR}\\s*$`), '')
    .trim();

  cleaned = cleaned.replace(/^or\s+/, '').replace(/\s+or$/, '').trim();

  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

/**
 * The employer's location text, with a redundant "United States" (or "USA",
 * "U.S.", "US", parenthesised or bare) dropped from what is DISPLAYED.
 *
 * THIS IS THE ONE PLACE THIS REPOSITORY TRIMS AN EMPLOYER'S OWN WORDS. This
 * file's own header and JobRow's "what a row promises" both say every cell
 * prints the source's sentence verbatim, and this function is the single
 * deliberate exception. It earns that exception on a narrow claim: for a
 * reader of this site, "United States" inside a location is the home
 * country, and naming it beside a city, a state, or "Remote" adds no
 * information the rest of the string did not already carry. Removing it
 * changes no meaning. `job.location` itself is never touched, only what a
 * cell renders: the stored string, the sort and filter facets, and every
 * other reader of the field still see the employer's original words.
 *
 * A COUNTRY THAT IS NOT THE UNITED STATES IS NEVER TOUCHED, on purpose.
 * "Canada", "London", "Remote within Canada": dropping any of those would
 * change what the sentence claims, which is exactly the harm the home
 * country exemption above does not carry. So the four US spellings are the
 * whole, closed list this function looks for; nothing else is a candidate,
 * and there is no attempt to recognise "not the US" as a category.
 *
 * TEXT IN, TEXT OUT, NOT A JOB IN. JobTable's clustered row has no single
 * Job to read this from: cluster.locations is already a joined string
 * across every member's own location. A string in, string out function is
 * the one shape both JobRow's job.location and JobTable's joined string can
 * share, which is why this is not `locationDisplay(job: Job)`.
 *
 * NEVER RETURNS BLANK. A location that is nothing but the home country
 * ("United States" alone, "(United States)" alone) would trim to an empty
 * cell, and a blank location reads as a missing fact, which is worse than a
 * redundant one. Where the removal would leave nothing behind, this returns
 * the original text untouched.
 */
export function locationDisplay(text: string): string {
  if (!text) return text;

  const stripped = text.replace(US_HOME_COUNTRY_PARENTHETICAL, '').replace(US_HOME_COUNTRY, '');
  const cleaned = cleanLocationSeparators(stripped);

  return cleaned === '' ? text : cleaned;
}

export interface LocationShort {
  /** The first place, for the row. */
  primary: string;
  /** How many more places the posting lists, for a "+N more" hint. */
  more: number;
}

/**
 * The primary location for a board row, and a count of the rest.
 *
 * A posting that lists a dozen cities and their remote caveats is a paragraph,
 * not a cell, and it breaks the row the same way a wall of pay text does. The
 * row shows the first place and how many more there are; the full list stays on
 * the detail page. Places are split on the strong separators a posting uses
 * between distinct locations (slash, bullet, semicolon), and a run of
 * comma-separated "City, ST" pairs is regrouped into places so "San Francisco,
 * CA, New York, NY, Portland, OR" reads as three, not one long string.
 */
export function locationShort(text: string): LocationShort {
  const cleaned = locationDisplay(text || '');
  if (!cleaned) return { primary: text || '', more: 0 };

  const segments = cleaned.split(/\s*[/•;]\s*/).filter(Boolean);
  const places: string[] = [];
  for (const segment of segments) {
    const commas = (segment.match(/,/g) || []).length;
    if (commas >= 3) {
      const parts = segment.split(/\s*,\s*/);
      for (let index = 0; index < parts.length; index += 2) {
        places.push(parts.slice(index, index + 2).join(', '));
      }
    } else {
      places.push(segment);
    }
  }

  return { primary: places[0] ?? cleaned, more: Math.max(0, places.length - 1) };
}

/**
 * The apply action's own words, naming where it sends a reader.
 *
 * Standing rule 4: labels describe reality. "Apply now" is a button that hides
 * where you are about to go; "Apply on Greenhouse" is the same click with the
 * destination in it. A founder's mailbox gets its own wording, because clicking
 * it opens a mail client rather than a posting, and a reader should know that
 * before the click and not after.
 */
export function applyLabel(job: Job): string {
  if (job.source_system === 'founder_post' || job.apply_url.startsWith('mailto:')) {
    return 'Email the founder';
  }
  if (job.source_system === 'custom') return 'Apply on the company site';
  return `Apply on ${sourceLabel(job)}`;
}

/**
 * The one line summary of how hard applying is: "Easy · ~15 min · no account".
 *
 * Built out of the ease fields rather than written, and each segment drops out
 * when the machine has not measured it. A missing time estimate leaves "Easy ·
 * no account" rather than a guessed number of minutes, which is the same rule
 * the age column follows. The tilde marks an estimate, and the table footnote
 * says so once for every row that carries one.
 */
export function easeSegments(job: Job): string[] {
  if (job.ease === null) return [];
  const friction = job.ease.friction.charAt(0) + job.ease.friction.slice(1).toLowerCase();
  const segments: string[] = [friction];
  if (typeof job.ease.minutes_estimate === 'number') {
    segments.push(`~${job.ease.minutes_estimate} min`);
  }
  segments.push(job.ease.account_required ? 'account required' : 'no account');
  return segments;
}

/**
 * The same line as one string, for anywhere that cannot render elements.
 *
 * RENDER THE SEGMENTS, NOT THIS, wherever markup is possible. A joined string
 * has an ordinary break opportunity inside "no account" and inside "account
 * required", so a narrow column breaks the line mid phrase and leaves "no" and
 * "account" on separate lines, which reads as two facts instead of one.
 * Rendering each segment as its own element lets the line break between facts
 * and never inside one.
 */
export const easeSummary = (job: Job): string => easeSegments(job).join(' · ');
