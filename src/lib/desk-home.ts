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
import { buildTitleIndex, laneFor, matchesTitle, isCovered, type TitleCount } from './ledger-titles';
import { compShort, daysBetween, formatDate, sweepDate, type KillRule } from './data';
import { ruleLabel } from './readings';

/** One watched title, with how much of the live board it actually catches. */
export interface DeskTitleVM {
  title: string;
  shelf: Shelf;
  /** Live roles matching this title, after the member's own filters. */
  liveCount: number;
  /** Distinct board titles this watch matches (the aliases it goes by). */
  matchedTitles: number;
  /** Whether the board carries this title at all (ignoring the member's
      filters): a covered title with liveCount 0 was filtered out, an uncovered
      one is simply not on the board yet. */
  covered: boolean;
}

/** One role in a lane: enough to render a card and link straight to the job. */
export interface DeskRoleVM {
  slug: string | null;
  title: string;
  company: string;
  pay: string | null;
  remote: boolean;
  location: string | null;
  /** Which watched titles pulled this role in (the "matched X" line). */
  matched: string[];
  /** fit_total, a signed-in reading, 0..100. */
  fit: number;
  /** First observed, as an ISO date, for the head-start timeline. */
  firstSeen: string | null;
  /** Whole days since first observed, to place the role on the arrival curve. */
  ageDays: number | null;
}

/** One kill matched to the member's titles. Company deliberately absent. */
export interface DeskKillVM {
  title: string;
  killRule: string;
  killRuleLabel: string;
  killedOn: string | null;
  stoodDays: number | null;
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
  newCore: DeskRoleVM[];
  newStretch: DeskRoleVM[];
  died: DeskKillVM[];
  /** Counts for the executive summary line. */
  newCoreCount: number;
  newStretchCount: number;
  diedCount: number;
  /** Last night's sweep, for the summary and the stamp. */
  sweep: {
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

/** How many recent lane roles and matched kills a page renders at most. */
const LANE_CAP = 40;
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

/** True when a role entered after the reader last looked. On a first visit
    (no last_seen), "new" falls back to the last FIRST_VISIT_WINDOW_DAYS. */
function isNew(firstSeen: Date | string | null, lastSeenMs: number | null, sweepIso: string): boolean {
  const firstMs = toMs(firstSeen);
  if (firstMs === null) return false;
  if (lastSeenMs !== null) return firstMs > lastSeenMs;
  const age = daysBetween(isoDay(firstSeen), sweepIso);
  return age !== null && age >= 0 && age <= FIRST_VISIT_WINDOW_DAYS;
}

function roleVM(row: BoardRow, matched: string[], sweepIso: string): DeskRoleVM {
  const job = boardRowToJob(row);
  return {
    slug: row.slug,
    title: row.title,
    company: row.company,
    pay: compShort(job),
    remote: row.remote,
    location: row.location,
    matched,
    fit: typeof row.fit_total === 'number' && Number.isFinite(row.fit_total) ? row.fit_total : 0,
    firstSeen: isoDay(row.first_seen),
    ageDays: daysBetween(isoDay(row.first_seen), sweepIso)
  };
}

function killVM(kill: BoardKillRow, matched: string[]): DeskKillVM {
  return {
    title: kill.title,
    killRule: kill.kill_rule,
    killRuleLabel: ruleLabel(kill.kill_rule as KillRule),
    killedOn: formatDate(isoDay(kill.killed_on)),
    stoodDays: daysBetween(isoDay(kill.first_published), isoDay(kill.killed_on)),
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
  const lastSeenMs = toMs(lastSeenAt);
  const sweepIso = sweepDate();

  const shelfByTitle = new Map<string, Shelf>();
  for (const w of watches) shelfByTitle.set(w.title, w.shelf);
  const allTitles = watches.map((w) => w.title);
  const coreSet = new Set(watches.filter((w) => w.shelf === 'core').map((w) => w.title));

  // The member's own filters narrow the live set before anything is counted.
  const filtered = liveRows.filter((row) => passesPrefs(row, prefs));

  // Per-title live counts and alias counts, computed over the filtered set; the
  // covered test reads the whole live set, so a filtered-out title still reads
  // as covered rather than as one the board does not carry.
  const titleVMs: DeskTitleVM[] = watches.map((w) => {
    const rows = filtered.filter((row) => matchesTitle(w.title, row.title));
    const distinct = new Set(rows.map((row) => row.title));
    return {
      title: w.title,
      shelf: w.shelf,
      liveCount: rows.length,
      matchedTitles: distinct.size,
      covered: isCovered(w.title, liveRows)
    };
  });
  const coreTitles = titleVMs.filter((t) => t.shelf === 'core');
  const stretchTitles = titleVMs.filter((t) => t.shelf === 'stretch');
  const uncovered = titleVMs.filter((t) => !t.covered).map((t) => t.title);

  // The lane: every filtered role under any watched title, tagged with which
  // titles caught it, then ranked by fit. A role a core title caught is core,
  // even if a stretch title also caught it.
  const lane = laneFor(filtered, allTitles);
  const liveUnderTitles = lane.length;

  const laneRanked = [...lane].sort((a, b) => (b.role.fit_total ?? 0) - (a.role.fit_total ?? 0));
  const newCore: DeskRoleVM[] = [];
  const newStretch: DeskRoleVM[] = [];
  for (const { role, matched } of laneRanked) {
    if (!isNew(role.first_seen, lastSeenMs, sweepIso)) continue;
    const isCore = matched.some((title) => coreSet.has(title));
    (isCore ? newCore : newStretch).push(roleVM(role, matched, sweepIso));
  }

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
    newCore: newCore.slice(0, LANE_CAP),
    newStretch: newStretch.slice(0, LANE_CAP),
    died: laneKills.slice(0, DIED_CAP),
    newCoreCount: newCore.length,
    newStretchCount: newStretch.length,
    diedCount: laneKills.length,
    sweep: {
      postingsObserved: stats?.postings_observed ?? null,
      verifiedLive: stats?.verified_live ?? null,
      killed: stats?.killed ?? null,
      sweptAt: isoDay(stats?.swept_at ?? null)
    },
    titleIndex: buildTitleIndex(liveRows),
    lastSeenAt: isoDay(lastSeenAt)
  };
}
