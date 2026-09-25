/**
 * desk-agg.test.ts: the parity check for The Desk.
 *
 * WHAT IT PROVES. buildDeskHome used to read every live row (listBoardAll) and
 * cut it in TypeScript. It now asks Postgres for the cut. This test runs BOTH:
 * it reads the whole board the old way, computes the old numbers with the old
 * code (ported verbatim below, out of desk-home.ts as it stood at 4d37933), asks
 * desk-agg.ts for the same cut, and asserts they agree.
 *
 * THE ONE EXPECTED DIFFERENCE, ASSERTED AS A DIFFERENCE. The old ranking was
 * fit DESC then first_seen DESC, and Array.prototype.sort is stable, so rows
 * tied on both kept whatever order the sequential scan happened to return: the
 * sixth card of a lane could differ between two renders of the same board. The
 * new ORDER BY ends in id ASC. So the row assertions compare against the old
 * comparator WITH that tiebreak appended, and a test below shows the old
 * comparator without it leaves real ties, which is why the tiebreak had to be
 * added rather than assumed away.
 *
 * It needs a database. Without a connection string it skips rather than
 * passing, so a green run on a machine with no database cannot be mistaken for
 * a proof.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  deskLaneCounts, deskLaneRows, deskTitleCounts, deskTitleIndex,
  type DeskWatch, type DeskWhen
} from './desk-agg';
import { listBoardAll, listAllKills, type BoardKillRow } from './job-store';
import type { BoardRow } from './board-jobs';
import { buildTitleIndex, laneFor, matchesTitle } from './ledger-titles';
import { DESK_WINDOW_DAYS, inDeskWindow } from './desk-home';
import type { LedgerSelection } from './ledger-prefs-store';
import { daysBetween } from './data';
import { db } from './db';

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const d = HAVE_DB ? describe : describe.skip;

/** The windows the production caller passes; restated here so a change to one
    of them shows up as a failing parity check rather than as a silent drift. */
const SHOW = 6;
const FIRST_VISIT_WINDOW_DAYS = 7;
/** A fixed sweep day and a fixed last-visit day: the parity claim is about the
    cut, not about what "today" is, so neither side reads a clock. */
const SWEEP = '2026-09-20';

// ---------------------------------------------------------------------------
// The old calculation, ported from src/lib/desk-home.ts verbatim. Nothing here
// is rewritten to be nicer; the point is that it is the code the page ran.
// ---------------------------------------------------------------------------

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isoDay(value: Date | string | null | undefined): string | null {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function passesPrefs(row: BoardRow, prefs: LedgerSelection): boolean {
  if (prefs.remoteOnly && !row.remote) return false;
  if (typeof prefs.compFloor === 'number' && prefs.compFloor > 0) {
    const min = row.comp_range && typeof row.comp_range.min === 'number' ? row.comp_range.min : null;
    if (min === null || min < prefs.compFloor) return false;
  }
  return true;
}

function isNew(firstSeen: Date | string | null, lastSeenDay: string | null, sweepIso: string): boolean {
  const firstDay = isoDay(firstSeen);
  if (firstDay === null) return false;
  if (lastSeenDay !== null) return firstDay >= lastSeenDay;
  const age = daysBetween(firstDay, sweepIso);
  return age !== null && age >= 0 && age <= FIRST_VISIT_WINDOW_DAYS;
}

interface OldDesk {
  liveUnderTitles: number;
  coreLiveCount: number;
  stretchLiveCount: number;
  newCoreCount: number;
  newStretchCount: number;
  /** The whole windowed lane, ranked, before the DESK_SHOW slice. */
  coreLane: { role: BoardRow; matched: string[] }[];
  stretchLane: { role: BoardRow; matched: string[] }[];
  titleVMs: { title: string; liveCount: number; titlesLive: number; titlesTotal: number; covered: boolean }[];
}

/**
 * The old reduction, with ONE change: a final `id` tiebreak on the ranking sort,
 * which is the difference this test is here to name. `tied()` below runs the
 * comparator without it to show the ties are real.
 */
function oldDesk(
  liveRows: BoardRow[],
  kills: BoardKillRow[],
  watches: DeskWatch[],
  prefs: LedgerSelection,
  lastSeenDay: string | null,
  sweepIso: string
): OldDesk {
  const allTitles = watches.map((w) => w.title);
  const coreSet = new Set(watches.filter((w) => w.shelf === 'core').map((w) => w.title));
  const filtered = liveRows.filter((row) => passesPrefs(row, prefs));

  const killTitles = kills.map((k) => k.title);
  const titleVMs = watches.map((w) => {
    const liveMatching = liveRows.filter((row) => matchesTitle(w.title, row.title));
    const liveTitleSet = new Set(liveMatching.map((row) => row.title));
    const allTitleSet = new Set(liveTitleSet);
    for (const t of killTitles) if (matchesTitle(w.title, t)) allTitleSet.add(t);
    return {
      title: w.title,
      liveCount: liveMatching.length,
      titlesLive: liveTitleSet.size,
      titlesTotal: allTitleSet.size,
      covered: allTitleSet.size > 0
    };
  });

  const lane = laneFor(filtered, allTitles);
  const laneRanked = [...lane].sort(
    (a, b) =>
      (b.role.fit_total ?? 0) - (a.role.fit_total ?? 0) ||
      (toMs(b.role.first_seen) ?? 0) - (toMs(a.role.first_seen) ?? 0) ||
      // The added tiebreak. See the header.
      a.role.id.localeCompare(b.role.id)
  );

  const coreLane: { role: BoardRow; matched: string[] }[] = [];
  const stretchLane: { role: BoardRow; matched: string[] }[] = [];
  for (const item of laneRanked) {
    if (!inDeskWindow(daysBetween(isoDay(item.role.first_seen), sweepIso))) continue;
    (item.matched.some((title) => coreSet.has(title)) ? coreLane : stretchLane).push(item);
  }
  const flagNew = (role: BoardRow): boolean => isNew(role.first_seen, lastSeenDay, sweepIso);
  return {
    liveUnderTitles: lane.length,
    coreLiveCount: coreLane.length,
    stretchLiveCount: stretchLane.length,
    newCoreCount: coreLane.reduce((n, x) => n + (flagNew(x.role) ? 1 : 0), 0),
    newStretchCount: stretchLane.reduce((n, x) => n + (flagNew(x.role) ? 1 : 0), 0),
    coreLane,
    stretchLane,
    titleVMs
  };
}

// ---------------------------------------------------------------------------

let LIVE: BoardRow[] = [];
let KILLS: BoardKillRow[] = [];

beforeAll(async () => {
  if (!HAVE_DB) return;
  LIVE = await listBoardAll({ liveOnly: true });
  KILLS = await listAllKills();
}, 120_000);

/** Watch lists built from the board itself, so a fixture cannot go stale: the
    most live title, two broad phrases, a title the board does not carry, and a
    watch that normalises to nothing. */
function fixtures(): { name: string; watches: DeskWatch[]; prefs: LedgerSelection; lastSeenDay: string | null }[] {
  const top = buildTitleIndex(LIVE).slice(0, 2).map((t) => t.title);
  const broad: DeskWatch[] = [
    { title: 'engineer', shelf: 'core' },
    { title: 'designer', shelf: 'stretch' },
    { title: 'manager', shelf: 'stretch' },
    { title: 'no such title exists on this board', shelf: 'core' }
  ];
  return [
    { name: 'one exact board title', watches: [{ title: top[0] ?? 'engineer', shelf: 'core' }], prefs: {}, lastSeenDay: null },
    { name: 'two exact board titles, both shelves', watches: [
        { title: top[0] ?? 'engineer', shelf: 'core' },
        { title: top[1] ?? 'designer', shelf: 'stretch' }
      ], prefs: {}, lastSeenDay: '2026-09-18' },
    { name: 'broad phrases, first visit', watches: broad, prefs: {}, lastSeenDay: null },
    { name: 'broad phrases, returning visit', watches: broad, prefs: {}, lastSeenDay: '2026-09-15' },
    { name: 'broad phrases, remote only', watches: broad, prefs: { remoteOnly: true }, lastSeenDay: '2026-09-15' },
    { name: 'broad phrases, pay floor', watches: broad, prefs: { compFloor: 150_000 }, lastSeenDay: '2026-09-15' },
    { name: 'broad phrases, remote and floor', watches: broad, prefs: { remoteOnly: true, compFloor: 200_000 }, lastSeenDay: '2026-09-10' },
    { name: 'a floor of zero is no floor', watches: broad, prefs: { compFloor: 0 }, lastSeenDay: null },
    { name: 'country is set and deliberately ignored', watches: broad, prefs: { country: 'US' }, lastSeenDay: null },
    { name: 'a watch that normalises to nothing', watches: [{ title: '!!! ---', shelf: 'core' }], prefs: {}, lastSeenDay: null },
    { name: 'a covered watch beside one that normalises to nothing', watches: [
        { title: '!!!', shelf: 'core' }, { title: 'engineer', shelf: 'core' }
      ], prefs: {}, lastSeenDay: null },
    { name: 'no watches at all', watches: [], prefs: {}, lastSeenDay: null }
  ];
}

function whenFor(lastSeenDay: string | null): DeskWhen {
  return { sweepDate: SWEEP, lastSeenDay, windowDays: DESK_WINDOW_DAYS, firstVisitDays: FIRST_VISIT_WINDOW_DAYS, show: SHOW };
}

d('the Desk lane, in SQL, says what the TypeScript reduction said', () => {
  it('has a board to compare over', () => {
    expect(LIVE.length).toBeGreaterThan(0);
  });

  it.each(fixtures())('$name: the five counts are identical', async (f) => {
    const old = oldDesk(LIVE, KILLS, f.watches, f.prefs, f.lastSeenDay, SWEEP);
    const got = await deskLaneCounts(f.watches, f.prefs, whenFor(f.lastSeenDay));
    expect(got).toEqual({
      liveUnderTitles: old.liveUnderTitles,
      coreLiveCount: old.coreLiveCount,
      stretchLiveCount: old.stretchLiveCount,
      newCoreCount: old.newCoreCount,
      newStretchCount: old.newStretchCount
    });
  }, 120_000);

  it.each(fixtures())('$name: the ranked rows are the same rows in the same order', async (f) => {
    const old = oldDesk(LIVE, KILLS, f.watches, f.prefs, f.lastSeenDay, SWEEP);
    const rows = await deskLaneRows(f.watches, f.prefs, whenFor(f.lastSeenDay));
    const gotCore = rows.filter((r) => r.isCore);
    const gotStretch = rows.filter((r) => !r.isCore);

    expect(gotCore.map((r) => r.row.id)).toEqual(old.coreLane.slice(0, SHOW).map((x) => x.role.id));
    expect(gotStretch.map((r) => r.row.id)).toEqual(old.stretchLane.slice(0, SHOW).map((x) => x.role.id));
    // The "matched X" line, in the member's own watch order.
    expect(gotCore.map((r) => r.matched)).toEqual(old.coreLane.slice(0, SHOW).map((x) => x.matched));
    expect(gotStretch.map((r) => r.matched)).toEqual(old.stretchLane.slice(0, SHOW).map((x) => x.matched));
    // The new tag, per row.
    const oldNew = (role: BoardRow) => isNew(role.first_seen, f.lastSeenDay, SWEEP);
    expect(gotCore.map((r) => r.isNew)).toEqual(old.coreLane.slice(0, SHOW).map((x) => oldNew(x.role)));
    expect(gotStretch.map((r) => r.isNew)).toEqual(old.stretchLane.slice(0, SHOW).map((x) => oldNew(x.role)));
  }, 120_000);

  it.each(fixtures())('$name: every row comes back whole, in BoardRow shape', async (f) => {
    const old = oldDesk(LIVE, KILLS, f.watches, f.prefs, f.lastSeenDay, SWEEP);
    const rows = await deskLaneRows(f.watches, f.prefs, whenFor(f.lastSeenDay));
    const byId = new Map(old.coreLane.concat(old.stretchLane).map((x) => [x.role.id, x.role]));
    for (const { row } of rows) {
      const was = byId.get(row.id);
      expect(was).toBeDefined();
      // Everything the cards read off a row, from the same columns as before.
      expect(row.title).toBe(was!.title);
      expect(row.company).toBe(was!.company);
      expect(row.slug).toBe(was!.slug);
      expect(row.url).toBe(was!.url);
      expect(row.ats).toBe(was!.ats);
      expect(row.remote).toBe(was!.remote);
      expect(row.location).toBe(was!.location);
      expect(row.fit_total).toBe(was!.fit_total);
      expect(row.comp_range).toEqual(was!.comp_range);
      expect(row.comp_posted).toBe(was!.comp_posted);
      expect(isoDay(row.first_seen)).toBe(isoDay(was!.first_seen));
      // The heavy column never leaves the database, the same as listBoardAll.
      expect(row.description).toBeNull();
    }
  }, 120_000);

  it.each(fixtures())('$name: the per-title counts are identical', async (f) => {
    const old = oldDesk(LIVE, KILLS, f.watches, f.prefs, f.lastSeenDay, SWEEP);
    const got = await deskTitleCounts(f.watches);
    expect(got.length).toBe(f.watches.length);
    got.forEach((c, i) => {
      expect({ ...c, covered: c.titlesTotal > 0 }).toEqual({
        liveCount: old.titleVMs[i].liveCount,
        titlesLive: old.titleVMs[i].titlesLive,
        titlesTotal: old.titleVMs[i].titlesTotal,
        covered: old.titleVMs[i].covered
      });
    });
  }, 120_000);

  it('returns at most DESK_SHOW rows per lane, and no more', async () => {
    const watches: DeskWatch[] = [
      { title: 'engineer', shelf: 'core' },
      { title: 'manager', shelf: 'stretch' }
    ];
    const rows = await deskLaneRows(watches, {}, whenFor(null));
    expect(rows.filter((r) => r.isCore).length).toBeLessThanOrEqual(SHOW);
    expect(rows.filter((r) => !r.isCore).length).toBeLessThanOrEqual(SHOW);
    expect(rows.length).toBeLessThanOrEqual(SHOW * 2);
  }, 120_000);

  it('asks for no rows at all when the member has named no title', async () => {
    let asked = 0;
    const real = db().query.bind(db());
    // A spy rather than a mock: the real client still runs whatever is sent.
    (db() as unknown as { query: unknown }).query = (...args: unknown[]) => {
      asked += 1;
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await deskLaneCounts([], {}, whenFor(null));
      await deskLaneRows([], {}, whenFor(null));
      await deskTitleCounts([]);
    } finally {
      (db() as unknown as { query: unknown }).query = real;
    }
    expect(asked).toBe(0);
  });
});

d('the one intended difference: a tie now resolves the same way every time', () => {
  it('the old comparator left real ties in the lane, so the tiebreak was needed', () => {
    const watches: DeskWatch[] = [{ title: 'engineer', shelf: 'core' }];
    const lane = laneFor(LIVE, ['engineer']).filter((x) =>
      inDeskWindow(daysBetween(isoDay(x.role.first_seen), SWEEP))
    );
    const keys = lane.map((x) => `${x.role.fit_total ?? 0}|${toMs(x.role.first_seen) ?? 0}`);
    const ties = keys.length - new Set(keys).size;
    // If this ever hits zero the difference stops mattering, but it is the
    // reason the ORDER BY ends in id ASC, so it is asserted rather than assumed.
    expect(ties).toBeGreaterThan(0);
    expect(watches.length).toBe(1);
  });

  it('the same query twice gives the same rows in the same order', async () => {
    const watches: DeskWatch[] = [{ title: 'engineer', shelf: 'core' }, { title: 'designer', shelf: 'stretch' }];
    const a = await deskLaneRows(watches, {}, whenFor(null));
    const b = await deskLaneRows(watches, {}, whenFor(null));
    expect(b.map((r) => r.row.id)).toEqual(a.map((r) => r.row.id));
  }, 120_000);
});

d('the title index head is the head of the old index', () => {
  it('holds the same titles, with the same counts, in the same order', async () => {
    const whole = buildTitleIndex(LIVE);
    for (const limit of [5, 200, 1500]) {
      const got = await deskTitleIndex(limit);
      expect(got.total).toBe(whole.length);
      expect(got.head.length).toBe(Math.min(limit, whole.length));
      // The collation claim: ORDER BY n DESC, title COLLATE "en-US-x-icu"
      // reproduces buildTitleIndex's count-then-localeCompare order exactly.
      expect(got.head).toEqual(whole.slice(0, limit));
    }
  }, 120_000);

  it('never returns the whole index', async () => {
    const whole = buildTitleIndex(LIVE);
    const got = await deskTitleIndex(1500);
    // The point of the head: the index is bigger than what travels.
    expect(whole.length).toBeGreaterThan(got.head.length);
    expect(got.total).toBeGreaterThan(got.head.length);
  }, 120_000);
});
