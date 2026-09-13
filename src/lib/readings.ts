import {
  KILL_RULES,
  heldKills,
  killsOnRecord,
  loadJobs,
  loadKills,
  loadStats,
  unattributedKills,
  type KillRule
} from './data';

/**
 * Readings: every number this site states about its own sweep.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SPECIES, AND WHY THEY NEVER SHARE A MODULE
 * ---------------------------------------------------------------------------
 *
 * There are exactly two kinds of number on this site and they have opposite
 * failure modes, so they are kept apart permanently.
 *
 * An EXTERNAL CITATION lives in src/data/facts.json. It is somebody else's
 * research, it is static, it is quoted verbatim with its source, and gate 2
 * checks it literally, because a citation that drifts from its source is a
 * misquote. Those are handled by fact() in data.ts and never by this file.
 *
 * A READING is ours. It is what the machine measured last night. It changes
 * every night, it is computed from src/data/stats.json at build time, and it
 * must never exist as a literal anywhere in this repository. The failure mode
 * is the mirror image of a misquote: a reading typed into a template is correct
 * on the morning it is typed and false by the next sweep, and nothing about the
 * page will look wrong on the day it turns.
 *
 * "We measured 27% this sweep, 14 of 51 pulled" was in facts.json until
 * 2026-08-19, listed beside the St. Louis Fed and Greenhouse as though it were
 * the same kind of thing. It was not. It was last Tuesday.
 *
 * ---------------------------------------------------------------------------
 * ONE HELPER, SO THIS HAPPENS IN ONE PLACE
 * ---------------------------------------------------------------------------
 *
 * Every reading the site renders comes through `reading()`, and every one is
 * rendered by src/components/Reading.astro, which stamps the markup contract
 * gate 2 reads (data-truth="tile" plus the metric name and the value). That
 * gives one formatter, one vocabulary of metric names shared by the page and
 * the gate, and one place to change when the formatting changes.
 *
 * Gate 2's reading check is the other half: a sentence that makes a claim about
 * our sweep and carries a numeral outside a marker fails the build. So a
 * reading cannot be typed, and a typed one cannot reach a reader.
 */

const STATS = loadStats();

/**
 * Every metric a page may state about the sweep.
 *
 * The dotted names are per-rule counts. They read a key out of
 * stats.killed_by_rule, so the vocabulary here is the same vocabulary the data
 * file uses and a rule cannot be renamed on the page alone.
 */
export type ReadingMetric =
  | 'boards'
  | 'pulled'
  | 'verified_live'
  | 'killed'
  | 'killed_by_rule'
  | 'killed_unattributed'
  | 'kills_published'
  | 'kills_held'
  | 'kills_unattributed'
  | 'jobs_with_published_date'
  | 'kills_on_record'
  | `killed_by_rule.${KillRule}`
  /* Registered before a page prints it, deliberately. The record holds one row
     tonight, so a breakdown of it would be a table with a single line in it and
     four zeroes; the day it is worth printing, the count is already resolvable
     here and already checked by test/gates/truth.mjs, and nobody has to add a
     metric under deadline. This is the one shape a reading may take before it
     has a caller: a per-rule sibling of a metric that already renders. */
  | `kills_on_record_by_rule.${KillRule}`;

export interface Reading {
  /** The metric name, which is also what the markup declares to gate 2. */
  metric: ReadingMetric;
  /** The number itself. */
  value: number;
  /** What a reader sees. Formatted here and nowhere else. */
  display: string;
  /** A noun phrase for the number, so a caption is not typed twice either. */
  label: string;
}

/** The rule counts, all of them, in the order a reader meets them. */
const ruleCounts = (): Record<KillRule, number> => {
  const counts = STATS.killed_by_rule;
  const resolved = {} as Record<KillRule, number>;
  for (const rule of KILL_RULES) {
    const value = counts?.[rule];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `readings.ts: stats.killed_by_rule is missing a count for "${rule}". Every rule reports every night, zeroes included, because a rule missing from the summary reads as a rule that was never run. See docs/MACHINE-CONTRACT.md.`
      );
    }
    resolved[rule] = value;
  }
  return resolved;
};

/**
 * Kills attributed to a named rule. The sum, and the number the tile prints.
 *
 * This replaced the ghost rate on 2026-08-19. A ghost rate is killed divided by
 * pulled, which a reader reads as a deception rate, and every kill in the
 * archive today fired the retired evergreen rule that inferred intent from a
 * duration. Publishing that division would have been publishing an accusation
 * resting on a rule we removed for being an accusation. This number is the
 * honest one: how many postings a named, evidenced rule caught.
 */
export const killedByRuleTotal = (): number =>
  Object.values(ruleCounts()).reduce((total, count) => total + count, 0);

/**
 * True when no deception rule has produced a finding yet.
 *
 * The kill list's empty state reads this. It is a state of the archive, not a
 * state of the market, and the page says which.
 */
export const noRuleHasFired = (): boolean => killedByRuleTotal() === 0;

const LABELS: Record<string, string> = {
  boards: 'boards swept',
  pulled: 'postings pulled',
  verified_live: 'verified live',
  killed: 'killed this sweep',
  killed_by_rule: 'killed by rule',
  killed_unattributed: 'killed before the rules were named',
  kills_published: 'published kill rows',
  kills_held: 'records held back',
  kills_unattributed: 'records closed under a rule we withdrew',
  jobs_with_published_date: 'verified rows carrying the posted date',
  kills_on_record: 'kills on the record',
  repost_churn: 'repost churn',
  misrepresented: 'misrepresented',
  zombie: 'zombie',
  phantom: 'phantom',
  touched_not_refreshed: 'touched, not refreshed'
};

/**
 * The one formatter.
 *
 * Plain integers, no separators, so what a reader sees is character for
 * character what gate 2 compares against the data file. When that changes it
 * changes here, once, for every surface at the same moment.
 */
export const formatReading = (value: number): string => String(value);

/** The label for a rule, used by the breakdown and by nothing else. */
export const ruleLabel = (rule: KillRule): string => LABELS[rule] ?? rule;

export function reading(metric: ReadingMetric): Reading {
  const value = resolve(metric);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `readings.ts: no reading called "${metric}". A number describing our own sweep has to come from src/data/stats.json through this file, because a number typed into a page is true on the day it is typed and false the next night.`
    );
  }
  const key = metric.startsWith('killed_by_rule.') ? metric.slice('killed_by_rule.'.length) : metric;
  return { metric, value, display: formatReading(value), label: LABELS[key] ?? metric };
}

function resolve(metric: ReadingMetric): number | undefined {
  if (metric.startsWith('kills_on_record_by_rule.')) {
    const rule = metric.slice('kills_on_record_by_rule.'.length) as KillRule;
    return killsOnRecord().filter((kill) => kill.kill_rule === rule).length;
  }
  if (metric.startsWith('killed_by_rule.')) {
    const rule = metric.slice('killed_by_rule.'.length) as KillRule;
    return ruleCounts()[rule];
  }
  switch (metric) {
    case 'boards':
      return STATS.boards;
    case 'pulled':
      return STATS.pulled;
    case 'verified_live':
      return STATS.verified_live;
    case 'killed':
      return STATS.killed;
    case 'killed_by_rule':
      return killedByRuleTotal();
    case 'killed_unattributed':
      return STATS.killed_unattributed;
    // These three are counted off kills.json rather than read from stats.json,
    // because publication is a site decision and the machine does not make it.
    // stats.killed counts every kill the sweep made, held records included.
    //
    // THE TWO UNATTRIBUTED COUNTS ARE NOT THE SAME NUMBER AND MUST NOT BE USED
    // INTERCHANGEABLY. stats.killed_unattributed counts every record the sweep
    // killed under no rule this site publishes, held ones included, because it
    // describes the sweep. 'kills_unattributed' below counts only the records
    // that are off the list FOR THAT REASON, so a sentence naming both reasons
    // does not count one record twice. On the sweep 001 fixture they are 14 and
    // 13, and the difference is the single held record.
    case 'kills_published':
      return loadKills().length;
    case 'kills_held':
      return heldKills().length;
    case 'kills_unattributed':
      return unattributedKills().length;
    // Counted off kills-archive.json: every kill still standing, from every
    // sweep. Deliberately NOT read from stats.json, which describes tonight and
    // has no opinion about the nights before it.
    case 'kills_on_record':
      return killsOnRecord().length;
    // Counted off jobs.json, because it is a property of the rows rather than a
    // total the machine wrote down. /methodology states it where it explains
    // how few boards publish a posted date at all.
    case 'jobs_with_published_date':
      return loadJobs().filter((job) => job.status !== 'closed' && Boolean(job.published_date)).length;
    default:
      return undefined;
  }
}

/** The breakdown, in rule order, for the kill list and the methodology page. */
export const ruleBreakdown = (): { rule: KillRule; label: string; reading: Reading }[] =>
  KILL_RULES.map((rule) => ({
    rule,
    label: ruleLabel(rule),
    reading: reading(`killed_by_rule.${rule}` as ReadingMetric)
  }));
