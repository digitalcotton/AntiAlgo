/**
 * desk-home.ts: the read side of The Desk, the titles-driven member home. Given
 * one member's userId, it asks the database for the roles under the titles that
 * member named, so the page renders their own handful of roles instead of the
 * whole sweep. No clock of its own beyond data.ts's sweepDate().
 *
 * THE CUT IS IN SQL (2026-09-25). This used to call listBoardAll({ liveOnly:
 * true }), the unbounded "every live row" read, and cut the result in
 * TypeScript: 31,310 rows / 27.05 MB in about 970 ms on every request, measured
 * on production 2026-09-23, for a page that draws at most twelve roles. The
 * queries now live in desk-agg.ts, keyed on the member's watches, and the
 * numbers come back as numbers. See that file's header for what it replaced and
 * how the SQL mirrors the matcher.
 *
 * TWO WAVES, NOT ONE. The watch list and the filters decide what the lane query
 * asks, so they have to come back first: the reads that need nothing are one
 * Promise.all, the three that need the watches are a second. That is one extra
 * round trip in exchange for the 27 MB.
 *
 * HONESTY. role_family and tier are still absent upstream, so "Core" and
 * "Stretch" are the member's own shelving of a title (target vs reach), never a
 * seniority read. Fit is fit_total, a signed-in reading; there is no fabricated
 * per-requirement "distance" here, because measured fit components do not exist
 * yet. Company names are held on kill rows, as everywhere else on a paid surface.
 */
import { listAllKills, getBoardStats, type BoardKillRow } from './job-store';
import type { BoardRow } from './board-jobs';
import { boardRowToJob } from './board-jobs';
import {
  deskLaneCounts, deskLaneRows, deskTitleCounts, deskTitleIndex,
  type DeskLaneRow, type DeskWatch, type DeskWhen
} from './desk-agg';
import { listWatches, type Shelf } from './ledger-watch-store';
import { getPrefs, type LedgerSelection } from './ledger-prefs-store';
import { matchesTitle, type TitleCount } from './ledger-titles';
import { atsLabel, compShort, daysBetween, sweepDate, type KillRule } from './data';
import { ruleLabel } from './readings';

/** One watched title, with how much of the live board it actually catches. */
export interface DeskTitleVM {
  title: string;
  shelf: Shelf;
  /** Live roles matching this title right now (the whole market for it, before
      the member's remote/pay filters, which narrow the lanes not this total). */
  liveCount: number;
  /** N of "N of M titles": distinct board titles this watch matches that have a
      live role. */
  titlesLive: number;
  /** M of "N of M titles": distinct board titles this watch matches across live
      AND killed rows, so a title that only shows on dead roles still counts. */
  titlesTotal: number;
  /** Whether the board carries this title at all (live or killed): an uncovered
      one is simply not on the board yet. */
  covered: boolean;
}

/**
 * Where the role sits on the applicant arrival curve, derived from its age
 * against NBER WP 32320 (about 45% of applications land in the first 48 hours,
 * about 60% by 96 hours). aheadPct is 100 minus that share: the fraction of
 * eventual applicants a reader is ahead of by acting now. Null past the curve,
 * where the model makes no claim. This is a cited estimate, not a measurement.
 */
export interface HeadStart {
  label: string;
  aheadPct: number | null;
  zone: '48h' | '96h' | 'later';
}

/** One role in a lane: enough to render a card and link straight to the job. */
export interface DeskRoleVM {
  slug: string | null;
  title: string;
  company: string;
  pay: string | null;
  remote: boolean;
  location: string | null;
  /** The applicant system the posting is on (Greenhouse, Ashby, ...), for the
      "via X" chip. The honest stand-in for the design's unmeasured ease chip. */
  ats: string;
  /** The posting URL, for the Track action's click intent. */
  url: string | null;
  /** Which watched titles pulled this role in (the "matched X" line). */
  matched: string[];
  /** fit_total, a signed-in reading, 0..100. */
  fit: number;
  /** First observed, as an ISO date, for the head-start timeline. */
  firstSeen: string | null;
  /** Whole days since first observed, to place the marker on the arrival curve. */
  ageDays: number | null;
  /** Where the role sits on the arrival curve, or null when age is unknown. */
  headStart: HeadStart | null;
  /** True when the role first appeared on or after the reader last looked (date
      granularity). The lane shows fit-ranked live roles and tags the new ones,
      rather than showing new arrivals alone. */
  isNew: boolean;
}

/** One kill matched to the member's titles. Company deliberately absent. */
export interface DeskKillVM {
  title: string;
  killRule: string;
  killRuleLabel: string;
  /** ISO calendar days, to match the mockup's mono date chips. */
  killedOn: string | null;
  firstPublished: string | null;
  stoodDays: number | null;
  /** How many times this posting fired a rule (the "fired Nx" chip, shown only
      when it fired more than once). */
  timesFired: number;
  /** The ingest's evidence sentence, its leading "rule-name:" prefix removed
      (the rule chip already carries the rule). Null when none was written. */
  reason: string | null;
  matched: string[];
}

export interface DeskHomeData {
  /** Whether the member has named any titles yet. False = the empty first-run. */
  hasTitles: boolean;
  coreTitles: DeskTitleVM[];
  stretchTitles: DeskTitleVM[];
  /** Titles the member watches that the board does not carry yet. */
  uncovered: string[];
  /** The member's saved filters (remote only, pay floor). */
  prefs: LedgerSelection;
  /** Distinct live roles under all watched titles, after filters. */
  liveUnderTitles: number;
  /** Fit-ranked top slice of the live roles under core titles, new ones tagged.
      All matches, not only new arrivals; the rest are on the board. */
  core: DeskRoleVM[];
  /** Fit-ranked top slice of the live roles under stretch titles. */
  stretch: DeskRoleVM[];
  died: DeskKillVM[];
  /** Total live roles under core / stretch titles (after filters): the lane
      heading count and what the "see all N on the board" link points at. */
  coreLiveCount: number;
  stretchLiveCount: number;
  /** New-since-last-visit counts, for the summary line and the lane tag note. */
  newCoreCount: number;
  newStretchCount: number;
  diedCount: number;
  /** Last night's sweep, for the summary and the sweep panel (real counts, no
      per-second timeline, which the sweep does not log). */
  sweep: {
    boardsSwept: number | null;
    postingsObserved: number | null;
    verifiedLive: number | null;
    killed: number | null;
    sweptAt: string | null;
    /** The sweep's per-stage instants (job-store BoardStats.stage_log), or
        null until the sweep logs them; the panel shows no time column then. */
    stages: Record<string, string> | null;
  };
  /** The HEAD of the live board's title index, most common first: the
      add-a-title autocomplete. DESK_TITLE_HEAD rows at most, not the whole
      index, which is one title per row at this size. */
  titleIndex: TitleCount[];
  /** How many distinct live titles the board carries in total, so a panel
      showing the head can say what it is not showing. */
  titleCount: number;
  /** When this reader last loaded The Desk, for the "new since" clock. */
  lastSeenAt: string | null;
}

/** How many fit-ranked lane roles the Desk shows before it links out to the full
    board. A digest, not the whole market: the rest is one click away. */
const DESK_SHOW = 6;
/** The lanes show only roles first seen within this many days of the sweep
    (owner rule, 2026-09-19): the head-start bar ends at 14D, and a role past it
    is not a head start. Older live matches stay on the board. */
export const DESK_WINDOW_DAYS = 14;
/** Pure: whether a role's age puts it inside the lanes' window. An unknown
    age is outside it, because nothing can place it on the curve. */
export function inDeskWindow(ageDays: number | null): boolean {
  return ageDays !== null && ageDays >= 0 && ageDays <= DESK_WINDOW_DAYS;
}
/** How many matched kills the died lane renders at most. */
const DIED_CAP = 20;
/**
 * How much of the title index the autocomplete is given. The deepest consumer
 * is the Come-ready title step (StepTitles.astro, which imports this rather
 * than restating it); /desk takes the first 200 of the same list. It is a HEAD,
 * not the index: the board carries about one distinct title per live row, so the
 * whole thing is hundreds of kilobytes and was most of what the old full-board
 * read was paying for.
 */
export const DESK_TITLE_HEAD = 1500;
/** On a first visit (no last_seen), "new" falls back to this many days. */
const FIRST_VISIT_WINDOW_DAYS = 7;

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** An ISO calendar day from a stored timestamp, or null. */
function isoDay(value: Date | string | null | undefined): string | null {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * WHERE "NEW SINCE YOU LAST LOOKED" IS DECIDED, AND WHY AT DATE GRANULARITY.
 * desk-agg.ts's lane CTE makes this call in SQL. first_seen is a DATE (db/117),
 * so it has no time of day; last_seen_at is a precise timestamp. Comparing the
 * raw instants (a midnight date against an afternoon visit) would silently drop
 * a role first seen later on the same calendar day as a prior visit, and it
 * would stay hidden forever. So both sides collapse to their calendar day and
 * the test is "on or after" (>=): the safe direction, which may re-show a role
 * from the last visit day but never hides a genuinely new one. On a first visit
 * (no last_seen) "new" falls back to the last FIRST_VISIT_WINDOW_DAYS. The
 * verbatim old TypeScript is kept in desk-agg.test.ts, which asserts the query
 * agrees with it row for row.
 */

/** The arrival-curve reading for a role's age. See HeadStart. */
function headStartFor(ageDays: number | null): HeadStart | null {
  if (ageDays === null || ageDays < 0) return null;
  if (ageDays <= 2) return { label: 'inside the first 48 hours', aheadPct: 55, zone: '48h' };
  if (ageDays <= 4) return { label: 'inside the first 96 hours', aheadPct: 40, zone: '96h' };
  return { label: 'past the first 96 hours', aheadPct: null, zone: 'later' };
}

function roleVM(row: BoardRow, matched: string[], sweepIso: string, isNewFlag: boolean): DeskRoleVM {
  const job = boardRowToJob(row);
  const ageDays = daysBetween(isoDay(row.first_seen), sweepIso);
  return {
    slug: row.slug,
    title: row.title,
    company: row.company,
    pay: compShort(job),
    remote: row.remote,
    location: row.location,
    ats: atsLabel(row.ats),
    url: row.url,
    matched,
    fit: typeof row.fit_total === 'number' && Number.isFinite(row.fit_total) ? row.fit_total : 0,
    firstSeen: isoDay(row.first_seen),
    ageDays,
    headStart: headStartFor(ageDays),
    isNew: isNewFlag
  };
}

/** The stored evidence sentence with its leading "rule-name: " prefix stripped:
    the red rule chip already names the rule, so the prefix is noise on the card. */
function cleanReason(reason: string | null): string | null {
  if (!reason) return null;
  const trimmed = reason.replace(/^[a-z][a-z-]*:\s+/i, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function killVM(kill: BoardKillRow, matched: string[]): DeskKillVM {
  return {
    title: kill.title,
    killRule: kill.kill_rule,
    killRuleLabel: ruleLabel(kill.kill_rule as KillRule),
    killedOn: isoDay(kill.killed_on),
    firstPublished: isoDay(kill.first_published),
    stoodDays: daysBetween(isoDay(kill.first_published), isoDay(kill.killed_on)),
    timesFired: kill.times_fired,
    reason: cleanReason(kill.reason),
    matched
  };
}

/**
 * The whole Desk view model for one member. Reads the live crawl, the standing
 * kills, the sweep stats, the member's watched titles and their filters, then
 * cuts and ranks it all to those titles.
 */
export async function buildDeskHome(userId: string): Promise<DeskHomeData> {
  // Wave one: everything that does not depend on the member's own watch list.
  const [kills, stats, watches, prefsRow, titleIndex] = await Promise.all([
    listAllKills(),
    getBoardStats(),
    listWatches(userId),
    getPrefs(userId),
    deskTitleIndex(DESK_TITLE_HEAD)
  ]);

  const prefs: LedgerSelection = prefsRow?.selection ?? {};
  const lastSeenAt = prefsRow?.lastSeenAt ?? null;
  // Compared at date granularity against first_seen (a DATE); see isNew.
  const lastSeenDay = isoDay(lastSeenAt);
  const sweepIso = sweepDate();

  const allTitles = watches.map((w) => w.title);
  const deskWatches: DeskWatch[] = watches.map((w) => ({ title: w.title, shelf: w.shelf }));
  // Every window and cap the queries read, passed in: desk-agg.ts has no clock
  // and no policy of its own, so the rules stay in this file beside their
  // reasons and the SQL stays a mirror of them.
  const when: DeskWhen = {
    sweepDate: sweepIso,
    lastSeenDay,
    windowDays: DESK_WINDOW_DAYS,
    firstVisitDays: FIRST_VISIT_WINDOW_DAYS,
    show: DESK_SHOW
  };

  // Wave two: the three reads keyed on the watches. Each returns nothing but
  // counts and the ranked head of each lane, and each short-circuits without a
  // query when the member has named no title yet.
  const [counts, laneRows, titleCounts] = await Promise.all([
    deskLaneCounts(deskWatches, prefs, when),
    deskLaneRows(deskWatches, prefs, when),
    deskTitleCounts(deskWatches)
  ]);

  // Per-title counts, in the watch list's own order: liveCount and titlesLive
  // over the whole LIVE set (the title's real market, before the member's
  // remote/pay filters, which narrow the lanes below, not this total), and
  // titlesTotal folding in killed titles so "N of M" counts an alias that only
  // appears on dead roles. An uncovered title is one the board carries in
  // neither set.
  const titleVMs: DeskTitleVM[] = watches.map((w, i) => {
    const c = titleCounts[i] ?? { liveCount: 0, titlesLive: 0, titlesTotal: 0 };
    return {
      title: w.title,
      shelf: w.shelf,
      liveCount: c.liveCount,
      titlesLive: c.titlesLive,
      titlesTotal: c.titlesTotal,
      covered: c.titlesTotal > 0
    };
  });
  const coreTitles = titleVMs.filter((t) => t.shelf === 'core');
  const stretchTitles = titleVMs.filter((t) => t.shelf === 'stretch');
  const uncovered = titleVMs.filter((t) => !t.covered).map((t) => t.title);

  // The lanes: the fit-ranked head of each, NOT only what arrived since the last
  // visit. A member with live matches has to see them, or the page is a wall of
  // zeros sitting on top of real roles. New arrivals are tagged, and the full
  // set is one click away on the board, which narrows to these same titles.
  // Which lane a role is in, and what "new" means, were both decided in SQL.
  const toShown = (items: DeskLaneRow[]): DeskRoleVM[] =>
    items.map(({ row, matched, isNew: isNewFlag }) => roleVM(row, matched, sweepIso, isNewFlag));
  const core = toShown(laneRows.filter((r) => r.isCore));
  const stretch = toShown(laneRows.filter((r) => !r.isCore));

  // Kills matched to the watched titles, most recent first (sorted on the raw
  // timestamp, before it is formatted for display). Company held.
  const laneKills = kills
    .map((kill) => ({ kill, matched: allTitles.filter((title) => matchesTitle(title, kill.title)) }))
    .filter((x) => x.matched.length > 0)
    .sort((a, b) => (toMs(b.kill.killed_on) ?? 0) - (toMs(a.kill.killed_on) ?? 0))
    .map((x) => killVM(x.kill, x.matched));

  return {
    hasTitles: watches.length > 0,
    coreTitles,
    stretchTitles,
    uncovered,
    prefs,
    liveUnderTitles: counts.liveUnderTitles,
    core,
    stretch,
    died: laneKills.slice(0, DIED_CAP),
    coreLiveCount: counts.coreLiveCount,
    stretchLiveCount: counts.stretchLiveCount,
    newCoreCount: counts.newCoreCount,
    newStretchCount: counts.newStretchCount,
    diedCount: laneKills.length,
    sweep: {
      boardsSwept: stats?.boards_swept ?? null,
      postingsObserved: stats?.postings_observed ?? null,
      verifiedLive: stats?.verified_live ?? null,
      killed: stats?.killed ?? null,
      // The full instant, not the day: the sweep panel prints the real finish
      // time from it (SweepPanel.astro finishedStamp).
      sweptAt: (() => {
        const ms = toMs(stats?.swept_at ?? null);
        return ms === null ? null : new Date(ms).toISOString();
      })(),
      stages: stats?.stage_log ?? null
    },
    titleIndex: titleIndex.head,
    titleCount: titleIndex.total,
    lastSeenAt: isoDay(lastSeenAt)
  };
}
