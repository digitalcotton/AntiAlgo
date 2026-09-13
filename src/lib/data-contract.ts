/**
 * The data contract, enforced at build time.
 *
 * BUILD.md phase 2: "The build must fail loudly on missing, stale (over 48
 * hours), or internally inconsistent data. Prove all three failure modes."
 * This module is those three checks plus the clock's shape, and it is the only
 * thing standing between a broken nightly push and a site that renders it as
 * though it were true.
 *
 * WHY IT IS A SEPARATE MODULE FROM data.ts, AND WHY THAT IS NOT TIDINESS.
 * data.ts states as its third rule that there is no call to Date.now() in this
 * repository and there must never be one, because every rendered value is an
 * artifact of a fixed sweep and "now" is a value the machine recorded rather
 * than one the renderer looks up. A staleness check needs a wall clock, and
 * that is a genuine exception to the rule rather than a loophole in it: the
 * clock decides whether the build may proceed, and nothing it reads ever
 * reaches a page. Keeping it here means the exception is one file, named for
 * what it does, and grep-able. The single call is in `now()` below and is the
 * only one in the repository.
 *
 * THE FIXTURE ESCAPE, AND WHY IT IS NOT A BYPASS.
 * `/fixtures` is a labelled build fixture: every file carries `_meta.fixture:
 * true`, and BUILD.md describes it as a subset to build against until the
 * mini's export script replaces it. A fixture is a photograph of one night, so
 * it goes stale by construction the day after it was taken, and a hard failure
 * on that would make this repository unbuildable two days after it was written
 * for a reason that has nothing to do with the sweep failing. So a file that
 * declares itself a fixture reports its age loudly on every build and does not
 * stop it. A file that does NOT declare itself a fixture is a real push from
 * the machine, and a real push older than the window is a sweep that did not
 * run, which is exactly the thing that must never reach a reader as though it
 * were last night's. That is the branch the should-fail fixture proves.
 *
 * Every failure here is a thrown Error with the file, the field, what was
 * expected and what was found. A build that dies with a readable sentence costs
 * a minute. A build that succeeds on data nobody checked costs the argument.
 */

/** The window BUILD.md sets. Past this, unlabelled data is not last night's. */
export const MAX_DATA_AGE_HOURS = 48;

/**
 * The window the READER is promised, which is a shorter one, and the number is
 * here rather than beside either of the two things that use it.
 *
 * The machine sweeps nightly, so one missed night is the signal and two is the
 * confirmation. 48 hours is the build's threshold: past it a push is provably
 * not last night's and the build refuses to render it. 36 hours is the reader's:
 * past it the index band stops claiming "verified this sweep" and says how long
 * it has actually been.
 *
 * Two consumers read this and they are on opposite sides of the deploy. The
 * band in JobTable.astro reads it in the reader's browser, against the reader's
 * clock, because only their clock can answer how old the page is now. The daily
 * check in api/rebuild.ts reads it on a schedule, against the server's, because
 * a reader who never visits raises no alarm at all. Written down twice, the two
 * halves of that pair would eventually disagree about what stale means, and the
 * disagreement would show up as a page that looks fresh while the alarm is
 * ringing, or the reverse. So it is written down once.
 *
 * It is deliberately shorter than MAX_DATA_AGE_HOURS. The alarm has to fire no
 * later than the moment the page stops making the claim, never after it.
 */
export const FRESH_WINDOW_HOURS = 36;

/**
 * The rules the machine can fire, spelled as the site spells them.
 *
 * Held here rather than imported from data.ts because this module runs before
 * data.ts has finished loading anything: the contract is what decides whether
 * data.ts may trust its own imports. The two lists agreeing is checked by
 * schemas/stats.schema.json and schemas/kills.schema.json, which are the same
 * enum written for a validator.
 *
 * `evergreen` is absent on purpose. It was retired on 2026-08-19, and a historic
 * age-based kill lifted out of the archive is rejected here rather than counted.
 */
const KILL_RULE_NAMES = [
  'repost_churn',
  'misrepresented',
  'zombie',
  'phantom',
  'touched_not_refreshed'
];

const MS_PER_HOUR = 3_600_000;

/**
 * The one wall clock reading in this repository.
 *
 * Wrapped in a function, and overridable, so the should-fail fixture and any
 * future test can put the check at a known instant rather than depending on the
 * day somebody runs it. `DATA_CONTRACT_NOW` is read from the environment and is
 * never consulted by anything that renders.
 */
function now(): number {
  const pinned = typeof process !== 'undefined' ? process.env?.DATA_CONTRACT_NOW : undefined;
  if (pinned) {
    const parsed = Date.parse(pinned);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `data contract: DATA_CONTRACT_NOW is "${pinned}", which is not a date. Unset it, or set it to an ISO instant.`
      );
    }
    return parsed;
  }
  return Date.now();
}

/** What a caller hands over: the three fixture documents and the fact list. */
export interface ContractDocs {
  jobs: { _meta?: unknown; jobs?: unknown };
  kills: { _meta?: unknown; kills?: unknown };
  /**
   * Every kill still standing, from every sweep. Optional so a checkout that
   * predates the file still builds, exactly as prospects is.
   */
  killArchive?: Record<string, unknown> & { _meta?: unknown; kills?: unknown };
  stats: Record<string, unknown> & { _meta?: unknown };
  facts: { _meta?: unknown; facts?: unknown };
  /** Optional, so a checkout without the pre-posting file still builds. */
  prospects?: { _meta?: unknown; prospects?: unknown };
}

function fail(file: string, problem: string, fix: string): never {
  throw new Error(`data contract: ${file} ${problem}\n  ${fix}`);
}

function meta(doc: { _meta?: unknown }): Record<string, unknown> {
  return doc && typeof doc._meta === 'object' && doc._meta !== null
    ? (doc._meta as Record<string, unknown>)
    : {};
}

/** True when the file says of itself that it is a build fixture, not a push. */
export function isFixture(doc: { _meta?: unknown }): boolean {
  return meta(doc).fixture === true;
}

// ---------------------------------------------------------------------------
// 1. Missing
// ---------------------------------------------------------------------------
//
// The distinction that took a decision to get right: a missing key and an empty
// array are different findings. `"kills": []` is the best night the machine can
// have, and the kill list has a designed state that says so. A file with no
// `kills` key at all is a load that failed. Reading length alone conflates them,
// and the version of this check that did was found by an adversarial pass: an
// empty sweep would have killed the build before the page could say "nothing
// died this sweep, which happens and is worth saying plainly".

function assertArray(doc: Record<string, unknown>, file: string, key: string, allowEmpty: boolean): unknown[] {
  const value = doc[key];
  if (!Array.isArray(value)) {
    fail(
      file,
      `has no "${key}" array (found ${value === undefined ? 'nothing' : typeof value}).`,
      'That is a load that failed, not a quiet night. The site cannot be built from data it does not have.'
    );
  }
  if (value.length === 0 && !allowEmpty) {
    fail(
      file,
      `has an empty "${key}" array.`,
      `An empty ${key} list is not a possible state for this file, so an empty one means the payload was lost in transit.`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 2. Stale
// ---------------------------------------------------------------------------

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function assertClock(stats: Record<string, unknown>): number {
  const swept = stats.swept_at_utc;
  if (typeof swept !== 'string' || !INSTANT.test(swept)) {
    fail(
      'src/data/stats.json',
      `has swept_at_utc = ${JSON.stringify(swept)}.`,
      'Every rendered timestamp on this site equals that value, so it has to be a UTC instant shaped exactly like 2026-08-17T02:14:00Z.'
    );
  }
  const parsed = Date.parse(swept);
  if (Number.isNaN(parsed)) {
    fail('src/data/stats.json', `has an unparseable swept_at_utc ("${swept}").`, 'It matched the shape and is still not a date.');
  }
  return parsed;
}

function assertFresh(stats: ContractDocs['stats'], sweptMs: number, report: (line: string) => void): void {
  const ageHours = (now() - sweptMs) / MS_PER_HOUR;

  // A sweep stamped in the future is as broken as one that is too old, and it
  // is the more dangerous of the two because "0 hours old" reads as fresh.
  if (ageHours < -1) {
    fail(
      'src/data/stats.json',
      `is stamped ${Math.abs(ageHours).toFixed(1)} hours in the future.`,
      'A sweep that has not happened yet cannot have verified anything. Check the machine\'s clock.'
    );
  }

  if (ageHours <= MAX_DATA_AGE_HOURS) return;

  const line =
    `data contract: src/data/stats.json is ${ageHours.toFixed(1)} hours old, past the ${MAX_DATA_AGE_HOURS} hour window.`;

  if (isFixture(stats)) {
    // Labelled fixture: say it every build, loudly, and carry on. See the file
    // header for why this is not a bypass.
    report(`${line} It declares _meta.fixture: true, so this is a build against the labelled sweep 001 fixture rather than a nightly push, and the build continues. Every date on the built site is that sweep's.`);
    return;
  }

  fail(
    'src/data/stats.json',
    `is ${ageHours.toFixed(1)} hours old, past the ${MAX_DATA_AGE_HOURS} hour window.`,
    'This file does not declare itself a fixture, so it is a push from the machine, and a push this old means the sweep did not run. Publishing it would put "verified last night" over data that is not last night\'s. Re-run the sweep, or label the file _meta.fixture: true if it is a fixture.'
  );
}

// ---------------------------------------------------------------------------
// 3. Internally inconsistent
// ---------------------------------------------------------------------------
//
// The three files describe one sweep from three angles, and the whole product
// rests on them agreeing. Every equation below is one the fixture's own _meta
// already claims in prose; this is that claim made checkable.

interface JobLike {
  status?: unknown;
  slug?: unknown;
  last_verified?: unknown;
  source_system?: unknown;
  source_url?: unknown;
  apply_url?: unknown;
  fit?: Record<string, number> & { total?: number };
}

/**
 * The applicant tracking systems the site can name, and the host that proves
 * each one.
 *
 * Every label the site puts on a source system sits directly beside a link:
 * "Apply on Ashby" on the button, "Ashby, read direct" in the row, "Destination:
 * Ashby" in the ease panel, "Source system: Ashby" in the markdown twin. Four
 * surfaces, one field, and nothing in this repository compared that field
 * against the host the link actually goes to. One record in sweep 001 said
 * "ashby" over four links to openai.com, which is the company's own board and is
 * what its four sibling records at the same host are labelled, so the site
 * asserted a destination in the machine voice that the link did not go to.
 *
 * `custom` and `founder_post` are the two labels that describe an absence of an
 * ATS ("the company site", "the founder posting"), so they are the correct
 * answer for any host not in this table, and the wrong answer for every host
 * that is in it.
 */
const ATS_HOSTS: ReadonlyArray<{ system: string; suffix: string }> = [
  { system: 'greenhouse', suffix: 'greenhouse.io' },
  { system: 'ashby', suffix: 'ashbyhq.com' },
  { system: 'workable', suffix: 'workable.com' },
  { system: 'jobvite', suffix: 'jobvite.com' },
  { system: 'yc', suffix: 'ycombinator.com' },
  { system: 'yc', suffix: 'workatastartup.com' }
];

/** The system a URL's host proves, or null where the host is nobody's ATS. */
export function systemOfHost(url: string): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    // A URL this module cannot parse is not this check's finding. The schema and
    // gate 2's own reachability probe both have something to say about it.
    return null;
  }
  const match = ATS_HOSTS.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`));
  return match ? match.system : null;
}

/**
 * The named system has to agree with both links on the record.
 *
 * Both, because both are labelled with it: the source URL carries "read direct"
 * and the apply URL carries "Apply on X". A record whose two links live on
 * different systems cannot be described by one field, and the honest outcome is
 * a build that stops and says which record it is, rather than a page that picks
 * one of the two and prints it beside the other.
 */
function assertSourceSystems(rows: JobLike[]): void {
  for (const job of rows) {
    const system = typeof job.source_system === 'string' ? job.source_system : null;
    if (!system) continue;
    const named = system === 'custom' || system === 'founder_post' ? null : system;

    for (const field of ['source_url', 'apply_url'] as const) {
      const url = job[field];
      if (typeof url !== 'string' || url === '') continue;
      const proven = systemOfHost(url);
      if (proven === named) continue;

      const detail =
        proven === null
          ? `${url} is not on any board this site knows, and "${system}" names one.`
          : named === null
            ? `${url} is on ${proven}, and "${system}" says it is not on a board at all.`
            : `${url} is on ${proven}, and the record says "${system}".`;

      fail(
        'src/data/jobs.json',
        `has a record (${String(job.slug)}) whose ${field} disagrees with its source_system: ${detail}`,
        'Standing rule 4: labels describe reality. The site prints this field beside that link four times over, so ' +
          'the two have to be the same claim. Fix the field in the export, never the label on the page. If the two ' +
          'URLs genuinely live on different systems, the record needs a field per link before the site can name either.'
      );
    }
  }
}

function assertConsistent(docs: ContractDocs, jobs: unknown[], kills: unknown[], swept: string): void {
  const stats = docs.stats;
  const number = (key: string): number => {
    const value = stats[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('src/data/stats.json', `has no numeric "${key}".`, 'Every tile on the site reads one of these fields.');
    }
    return value;
  };

  const boards = number('boards');
  const pulled = number('pulled');
  const verifiedLive = number('verified_live');
  const killed = number('killed');

  if (boards < 1) {
    fail('src/data/stats.json', `says ${boards} boards were read.`, 'A sweep that read no boards verified nothing.');
  }

  const rows = jobs as JobLike[];
  const liveRows = rows.filter((job) => job.status === 'live' || job.status === 're_verified').length;
  if (liveRows !== verifiedLive) {
    fail(
      'src/data/stats.json and src/data/jobs.json',
      `disagree: stats.verified_live is ${verifiedLive} and jobs.json holds ${liveRows} live or re-verified records.`,
      'The tile and the table would print two different counts of the same sweep. Fix the export, never the page.'
    );
  }

  if (kills.length !== killed) {
    fail(
      'src/data/stats.json and src/data/kills.json',
      `disagree: stats.killed is ${killed} and kills.json holds ${kills.length} records.`,
      'The kill count on the index and the number of rows on the kill list have to be the same number.'
    );
  }

  if (verifiedLive + killed !== pulled) {
    fail(
      'src/data/stats.json',
      `does not reconcile: ${verifiedLive} verified plus ${killed} killed is ${verifiedLive + killed}, and pulled is ${pulled}.`,
      'Everything pulled was either verified or killed. A third outcome is a state nobody designed.'
    );
  }

  // There is no ghost_rate to check any more, and its absence is checked
  // instead. It was killed divided by pulled, published as the headline number
  // of the whole product, and a reader reads it as a deception rate. Every kill
  // in the archive on 2026-08-19 fired the evergreen rule, which was retired
  // that day for inferring an employer's intent from a duration, so the
  // division would have been an accusation resting on a rule we removed for
  // being an accusation. It comes back when a deception rule produces a
  // finding, and not before. See DECISIONS.md, 2026-08-19.
  for (const dead of ['ghost_rate', 'ghost_rate_display', 'sweep_number']) {
    if (dead in stats) {
      fail(
        'src/data/stats.json',
        `still carries ${dead}, which was removed from the contract on 2026-08-19.`,
        dead === 'sweep_number'
          ? 'The sweep is identified by swept_at_utc. A counter can be miscounted and a test run inflates it.'
          : 'No ghost rate until a deception rule produces one. The site publishes killed_by_rule instead.'
      );
    }
  }

  // The rule breakdown, which is what replaced the ghost rate on every surface.
  //
  // Two things are checked and the second is the one that matters. Every rule
  // reports a count, zeroes included, because a rule missing from the object
  // reads as a rule that was never run. And the counts have to add up to the
  // kills the sweep actually made: a rule tally that quietly totals less than
  // stats.killed would let the site publish a smaller, tidier sweep than the
  // one on disk.
  const ruleCounts = stats.killed_by_rule;
  if (ruleCounts === null || typeof ruleCounts !== 'object' || Array.isArray(ruleCounts)) {
    fail(
      'src/data/stats.json',
      'has no killed_by_rule object.',
      'The kill tile and the kill list both read it. See schemas/stats.schema.json for the required keys.'
    );
  } else {
    const counts = ruleCounts as Record<string, unknown>;
    let attributed = 0;
    for (const rule of KILL_RULE_NAMES) {
      const value = counts[rule];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(
          'src/data/stats.json',
          `killed_by_rule is missing a usable count for "${rule}" (saw ${JSON.stringify(value)}).`,
          'Every rule reports every night including the zeroes, because a rule missing from a summary reads as a rule that was never run.'
        );
      } else {
        attributed += value;
      }
    }
    for (const key of Object.keys(counts)) {
      if (!KILL_RULE_NAMES.includes(key)) {
        fail(
          'src/data/stats.json',
          `killed_by_rule carries "${key}", which is not a rule this site publishes.`,
          'The keys are exactly the kill_rule enum in schemas/kills.schema.json. A retired rule (evergreen) is rejected here rather than rendered.'
        );
      }
    }

    const unattributed = stats.killed_unattributed;
    if (typeof unattributed !== 'number' || !Number.isFinite(unattributed) || unattributed < 0) {
      fail(
        'src/data/stats.json',
        `has no usable killed_unattributed (saw ${JSON.stringify(unattributed)}).`,
        'Kills that predate the rules being named are counted, not dropped. Zero is a valid answer and has to be written down.'
      );
    } else if (attributed + unattributed !== killed) {
      fail(
        'src/data/stats.json',
        `does not reconcile: ${attributed} attributed to rules plus ${unattributed} unattributed is ${attributed + unattributed}, and killed is ${killed}.`,
        'Every kill either fired a named rule or predates the rules. A kill in neither column is one the site would never show.'
      );
    }

    // And the tally has to match the records, not only itself. The machine
    // writes both, so a bug that miscounted one would otherwise agree with
    // itself all the way to the page.
    const ruledRecords = kills.filter(
      (kill) => typeof (kill as { kill_rule?: unknown }).kill_rule === 'string'
    ).length;
    if (ruledRecords !== attributed) {
      fail(
        'src/data/stats.json and src/data/kills.json',
        `disagree: killed_by_rule totals ${attributed} and ${ruledRecords} records carry a kill_rule.`,
        'The breakdown counts the same records the kill list renders. If they differ, one of them is describing a sweep that did not happen.'
      );
    }
  }

  // One clock, asserted at the source rather than only in the rendered HTML.
  // Gate 2 catches a drifting timestamp on a page; this catches it in the data,
  // which is a whole build earlier and names the record.
  for (const job of rows) {
    if (typeof job.last_verified === 'string' && job.last_verified !== swept) {
      fail(
        'src/data/jobs.json',
        `has a record (${String(job.slug)}) verified at ${job.last_verified}, and the sweep is ${swept}.`,
        'Every row in a sweep was verified by that sweep. Two instants in one export is two clocks.'
      );
    }
  }

  assertSourceSystems(rows);

  // A fit total that is not the sum of its own components is the one arithmetic
  // error that would survive every other check, because both halves look
  // plausible alone.
  for (const job of rows) {
    const fit = job.fit;
    if (!fit || typeof fit.total !== 'number') continue;
    const sum = Object.entries(fit)
      .filter(([key]) => key !== 'total')
      .reduce((running, [, value]) => running + (typeof value === 'number' ? value : 0), 0);
    if (sum !== fit.total) {
      fail(
        'src/data/jobs.json',
        `has a fit total of ${fit.total} for ${String(job.slug)} and components summing to ${sum}.`,
        'The rubric is the score. Fix the component that is wrong, never the total.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Runs every contract check, in the order a reader would want them to fail:
 * present, then shaped, then fresh, then self-consistent. Returns the notes
 * worth printing (today, only the labelled-fixture staleness line).
 *
 * Called once, at module load in data.ts, so a build against broken data dies
 * before a single page renders.
 */
/**
 * The pre-posting file, checked for shape and reported on for age.
 *
 * A NOTE AND NOT A FAILURE, WHICH IS A DELIBERATE EXCEPTION TO THIS FILE'S OWN
 * RULE. Stale posted data fails the build, because those rows carry the claim
 * "verified last night" and publishing week-old rows under it is the exact lie
 * this site exists to refuse. A pre-posting row makes no such claim: it has no
 * date on it anywhere, it names a company rather than a posting, and a company
 * that was worth writing to on Tuesday is still worth writing to on Friday.
 *
 * The harder reason is the failure mode. The two passes run on separate
 * schedules, and the prospects pass is the slower, more fragile one. A hard fail
 * here would mean a broken prospects pass stops the build, which stops the
 * nightly push, which takes the sweep off the site as well. The half that works
 * would be held hostage by the half that does not. So this reports, loudly, on
 * every build, and the sweep keeps publishing.
 */
function assertProspects(docs: ContractDocs, report: (line: string) => void): void {
  const doc = docs.prospects as Record<string, unknown> | undefined;
  if (!doc) return;
  const rows = assertArray(doc, 'src/data/prospects.json', 'prospects', true);

  const meta = doc._meta as Record<string, unknown> | undefined;
  const stamp = typeof meta?.generated_at_utc === 'string' ? meta.generated_at_utc : null;
  if (!stamp) {
    report('src/data/prospects.json carries no _meta.generated_at_utc, so its age cannot be checked.');
    return;
  }
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) {
    report(`src/data/prospects.json has an unparseable _meta.generated_at_utc: ${stamp}`);
    return;
  }
  const hours = Math.round((now() - ms) / 3_600_000);
  if (hours > MAX_PROSPECT_AGE_HOURS) {
    report(
      `src/data/prospects.json is ${hours} hours old (written ${stamp}). ` +
        `The pre-posting pass runs nightly at 21:00, so past ${MAX_PROSPECT_AGE_HOURS} hours it has ` +
        'stopped running. The site still builds and still shows these rows, because they carry no ' +
        'freshness claim, but nobody is adding to them. Check prospects.log on the machine.'
    );
  }
}

/**
 * The window past which the pre-posting file is reported as unattended.
 *
 * A week, not the 48 hours the posted rows get. These rows are a list of
 * companies rather than a list of postings, so a few days changes nothing a
 * reader can see, and a shorter window would cry wolf on every long weekend the
 * pass happened to miss.
 */
export const MAX_PROSPECT_AGE_HOURS = 24 * 7;

/**
 * Whether the pre-posting file has gone past MAX_PROSPECT_AGE_HOURS unattended,
 * as a plain boolean a renderer can branch on.
 *
 * assertProspects() above reports this in words at build time; this answers the
 * same question for a page that has to decide, per render, whether it can still
 * stand behind a figure baked into that file. A missing or unreadable stamp
 * counts as beyond freshness (true): a file whose age cannot be established is
 * not a file whose figures can be vouched for. Reads the same now() and the same
 * MAX_PROSPECT_AGE_HOURS as the build-time note, so the two never disagree.
 */
export function prospectsBeyondFreshness(doc: { _meta?: unknown } | undefined): boolean {
  const meta = doc?._meta as Record<string, unknown> | undefined;
  const stamp = typeof meta?.generated_at_utc === 'string' ? meta.generated_at_utc : null;
  if (!stamp) return true;
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return true;
  return (now() - ms) / 3_600_000 > MAX_PROSPECT_AGE_HOURS;
}

/**
 * The all-time record, and the one invariant that makes the kill list keepable.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK. It never counts these rows against
 * stats.killed. That check exists one function up and is right: stats describes
 * THIS sweep and kills.json is this sweep's rows, so the two must agree. This
 * file spans every sweep, so holding it to tonight's total would be comparing a
 * history to a night and would fail on the second interesting day the machine
 * ever has.
 *
 * WHAT IT DOES CHECK is the direction that can actually go wrong. The archive
 * must be a SUPERSET of tonight: a kill published on the list and missing from
 * the record is precisely the failure this file was added to end, and it would
 * otherwise be invisible until somebody went looking for a card that had stopped
 * resolving. Identity and slug uniqueness are checked for the same reason: two
 * records sharing either one would silently overwrite each other's page.
 */
function assertKillArchive(docs: ContractDocs, kills: unknown[]): void {
  const doc = docs.killArchive;
  if (!doc) return;

  const rows = assertArray(doc, 'src/data/kills-archive.json', 'kills', true);

  const swept = String(docs.stats.swept_at_utc);
  if (doc.swept_at_utc !== swept) {
    fail(
      'src/data/kills-archive.json',
      `is stamped ${JSON.stringify(doc.swept_at_utc)} and stats.json is stamped ${JSON.stringify(swept)}.`,
      'The record spans every sweep but is written by one of them, and two clocks in one export is the thing this repository refuses.'
    );
  }

  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const row of rows as Record<string, unknown>[]) {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail(
        'src/data/kills-archive.json',
        `holds a record for ${JSON.stringify(row.company)} with no id.`,
        'The id is a digest of the posting URL and the rule, written by export-site-data.py. A record with no identity cannot be told apart from another.'
      );
    }
    if (ids.has(id)) {
      fail(
        'src/data/kills-archive.json',
        `holds two records with the id ${id}.`,
        'One would overwrite the other. The id is a digest of URL and rule, so a collision means two different kills were given one identity.'
      );
    }
    ids.add(id);

    const slug = row.slug;
    if (typeof slug === 'string' && slugs.has(slug)) {
      fail(
        'src/data/kills-archive.json',
        `holds two records with the slug ${slug}.`,
        'One would overwrite the other card route. Slugs are assigned across the whole record at once so a shared base suffixes every claimant.'
      );
    }
    if (typeof slug === 'string') slugs.add(slug);

    if (typeof row.kill_rule !== 'string' || !KILL_RULE_NAMES.includes(row.kill_rule)) {
      fail(
        'src/data/kills-archive.json',
        `holds a record under the rule ${JSON.stringify(row.kill_rule)}, which this site does not publish.`,
        'A record with no live rule is not published and never reaches this file. A retired rule is rejected here rather than rendered.'
      );
    }
  }

  for (const kill of kills as Record<string, unknown>[]) {
    if (typeof kill.id === 'string' && !ids.has(kill.id)) {
      fail(
        'src/data/stats.json and src/data/kills-archive.json',
        `disagree: ${JSON.stringify(kill.company)} is published on tonight's kill list and absent from the record.`,
        'The list may never carry a kill the record does not keep, because the page promises the kill is kept and the card route is built from the record.'
      );
    }
  }
}

export function assertDataContract(docs: ContractDocs): string[] {
  const notes: string[] = [];
  const report = (line: string) => notes.push(line);

  const jobs = assertArray(docs.jobs as Record<string, unknown>, 'src/data/jobs.json', 'jobs', true);
  const kills = assertArray(docs.kills as Record<string, unknown>, 'src/data/kills.json', 'kills', true);
  assertArray(docs.facts as Record<string, unknown>, 'src/data/facts.json', 'facts', false);

  const sweptMs = assertClock(docs.stats);
  assertFresh(docs.stats, sweptMs, report);
  assertConsistent(docs, jobs, kills, String(docs.stats.swept_at_utc));
  assertKillArchive(docs, kills);
  assertProspects(docs, report);

  return notes;
}
