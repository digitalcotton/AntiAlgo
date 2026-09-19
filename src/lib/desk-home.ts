/**
 * desk-home.ts: the read side of The Desk, the titles-driven member home. Given
 * one member's userId, it reads the whole live crawl once and cuts it to the
 * titles that member named, so the page renders their own handful of roles
 * instead of the whole sweep. Pure-ish: one Promise.all of store reads, then all
 * derivation in TypeScript, no clock of its own beyond data.ts's sweepDate().
 *
 * WHY THE CUT LIVES HERE AND NOT IN SQL. The board's own narrowing (job-store.ts
 * listBoardFiltered titles param) is for the paginated board; The Desk needs the
 * whole matched set at once to count titles, split core from stretch, rank by
 * fit and read "new since you last looked", so it reads listBoardAll and cuts
 * with ledger-titles.laneFor, the same deterministic matcher the board's SQL
 * clause mirrors. The two agree by construction: both are matchesTitle.
 *
 * HONESTY. role_family and tier are still absent upstream, so "Core" and
 * "Stretch" are the member's own shelving of a title (target vs reach), never a
 * seniority read. Fit is fit_total, a signed-in reading; there is no fabricated
 * per-requirement "distance" here, because measured fit components do not exist
 * yet. Company names are held on kill rows, as everywhere else on a paid surface.
 */
import { listBoardAll, listAllKills, getBoardStats, type BoardKillRow } from './job-store';
import type { BoardRow } from './board-jobs';
import { boardRowToJob } from './board-jobs';
import { listWatches, type Shelf } from './ledger-watch-store';
import { getPrefs, type LedgerSelection } from './ledger-prefs-store';
import { buildTitleIndex, laneFor, matchesTitle, type TitleCount } from './ledger-titles';
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
  };
  /** Every live board title, most common first: the add-a-title autocomplete. */
  titleIndex: TitleCount[];
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

/** A live row passes the member's own filters: remote when asked, and a pay
    floor read off comp_range.min the same way the board's comp facet reads it. */
function passesPrefs(row: BoardRow, prefs: LedgerSelection): boolean {
  if (prefs.remoteOnly && !row.remote) return false;
  if (typeof prefs.compFloor === 'number' && prefs.compFloor > 0) {
    const min = row.comp_range && typeof row.comp_range.min === 'number' ? row.comp_range.min : null;
    if (min === null || min < prefs.compFloor) return false;
  }
  return true;
}

/**
 * True when a role first appeared on or after the reader last looked, compared
 * at DATE granularity on purpose. first_seen is a DATE (db/117), so it has no
 * time of day; last_seen_at is a precise timestamp. Comparing the raw instants
 * (a midnight date against an afternoon visit) would silently drop a role first
 * seen later on the same calendar day as a prior visit, and it would stay hidden
 * forever. So both sides collapse to their calendar day and the test is "on or
 * after" (>=): the safe direction, which may re-show a role from the last visit
 * day but never hides a genuinely new one. On a first visit (no last_seen) "new"
 * falls back to the last FIRST_VISIT_WINDOW_DAYS.
 */
function isNew(firstSeen: Date | string | null, lastSeenDay: string | null, sweepIso: string): boolean {
  const firstDay = isoDay(firstSeen);
  if (firstDay === null) return false;
  // ISO calendar days compare correctly as plain strings.
  if (lastSeenDay !== null) return firstDay >= lastSeenDay;
  const age = daysBetween(firstDay, sweepIso);
  return age !== null && age >= 0 && age <= FIRST_VISIT_WINDOW_DAYS;
}

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
  const [liveRows, kills, stats, watches, prefsRow] = await Promise.all([
    listBoardAll({ liveOnly: true }),
    listAllKills(),
    getBoardStats(),
    listWatches(userId),
    getPrefs(userId)
  ]);

  const prefs: LedgerSelection = prefsRow?.selection ?? {};
  const lastSeenAt = prefsRow?.lastSeenAt ?? null;
  // Compared at date granularity against first_seen (a DATE); see isNew.
  const lastSeenDay = isoDay(lastSeenAt);
  const sweepIso = sweepDate();

  const allTitles = watches.map((w) => w.title);
  const coreSet = new Set(watches.filter((w) => w.shelf === 'core').map((w) => w.title));

  // The member's own filters narrow the live set before anything is counted.
  const filtered = liveRows.filter((row) => passesPrefs(row, prefs));

  // Per-title counts: liveCount and titlesLive over the whole LIVE set (the
  // title's real market, before the member's remote/pay filters, which narrow
  // the lanes below, not this total), and titlesTotal folding in killed titles
  // so "N of M" counts an alias that only appears on dead roles.
  const killTitles = kills.map((k) => k.title);
  const titleVMs: DeskTitleVM[] = watches.map((w) => {
    const liveMatching = liveRows.filter((row) => matchesTitle(w.title, row.title));
    const liveTitleSet = new Set(liveMatching.map((row) => row.title));
    const allTitleSet = new Set(liveTitleSet);
    for (const t of killTitles) if (matchesTitle(w.title, t)) allTitleSet.add(t);
    return {
      title: w.title,
      shelf: w.shelf,
      liveCount: liveMatching.length,
      titlesLive: liveTitleSet.size,
      titlesTotal: allTitleSet.size,
      covered: allTitleSet.size > 0
    };
  });
  const coreTitles = titleVMs.filter((t) => t.shelf === 'core');
  const stretchTitles = titleVMs.filter((t) => t.shelf === 'stretch');
  const uncovered = titleVMs.filter((t) => !t.covered).map((t) => t.title);

  // The lane: every filtered role under any watched title, tagged with which
  // titles caught it, then ranked by fit (newest breaking a tie).
  const lane = laneFor(filtered, allTitles);
  const liveUnderTitles = lane.length;

  const laneRanked = [...lane].sort(
    (a, b) =>
      (b.role.fit_total ?? 0) - (a.role.fit_total ?? 0) ||
      (toMs(b.role.first_seen) ?? 0) - (toMs(a.role.first_seen) ?? 0)
  );

  // Split the whole matched live set into core and stretch (a role a core title
  // caught is core, even if a stretch title also caught it). The Desk shows a
  // fit-ranked top slice of each, NOT only what arrived since the last visit: a
  // member with live matches has to see them, or the page is a wall of zeros
  // sitting on top of real roles. New arrivals are tagged, and the full set is
  // one click away on the board, which narrows to these same titles.
  const coreLane: { role: BoardRow; matched: string[] }[] = [];
  const stretchLane: { role: BoardRow; matched: string[] }[] = [];
  for (const item of laneRanked) {
    // Only a role first seen inside the window makes a lane (DESK_WINDOW_DAYS).
    if (!inDeskWindow(daysBetween(isoDay(item.role.first_seen), sweepIso))) continue;
    (item.matched.some((title) => coreSet.has(title)) ? coreLane : stretchLane).push(item);
  }
  const flagNew = (role: BoardRow): boolean => isNew(role.first_seen, lastSeenDay, sweepIso);
  const toShown = (items: { role: BoardRow; matched: string[] }[]): DeskRoleVM[] =>
    items.slice(0, DESK_SHOW).map(({ role, matched }) => roleVM(role, matched, sweepIso, flagNew(role)));
  const core = toShown(coreLane);
  const stretch = toShown(stretchLane);
  const coreLiveCount = coreLane.length;
  const stretchLiveCount = stretchLane.length;
  const newCoreCount = coreLane.reduce((count, x) => count + (flagNew(x.role) ? 1 : 0), 0);
  const newStretchCount = stretchLane.reduce((count, x) => count + (flagNew(x.role) ? 1 : 0), 0);

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
    liveUnderTitles,
    core,
    stretch,
    died: laneKills.slice(0, DIED_CAP),
    coreLiveCount,
    stretchLiveCount,
    newCoreCount,
    newStretchCount,
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
      })()
    },
    titleIndex: buildTitleIndex(liveRows),
    lastSeenAt: isoDay(lastSeenAt)
  };
}
