/**
 * jobs-data-agg.test.ts: the parity check.
 *
 * WHAT IT PROVES. The Jobs Data page used to hold every live row in the browser
 * and reduce that array into every chart. It now asks Postgres for the numbers.
 * This test runs BOTH: it reads the whole board the old way, computes the old
 * aggregates with the browser's own arithmetic (ported verbatim below), asks
 * the new query layer for the same cut, and asserts the numbers are identical.
 *
 * Apply friction is the one expected difference, and it is asserted as a
 * difference: every row used to read 'easy' because the value was a literal.
 *
 * It needs a database. Without a connection string it skips rather than
 * passing, so a green run on a machine with no database cannot be mistaken for
 * a proof.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { liveAggregates, killAggregates, boardFacts, LADDER } from './jobs-data-agg';
import { NO_FILTERS, GROUP_DEFS, type Filters } from './jobs-data-filters';
import { listBoardAll, listAllKills } from './job-store';
import { tierFromTitle, famFromDepartment, regionOf, payOf, frictionOf } from './jobs-derived.mjs';

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const d = HAVE_DB ? describe : describe.skip;

// ---------------------------------------------------------------------------
// The old calculation, ported from public/scripts/ledger-v4-app.js verbatim.
// Nothing here is rewritten to be nicer; the point is that it is the code the
// page actually ran.
// ---------------------------------------------------------------------------

function med(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function quant(a: number[], p: number): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo));
}

interface OldRow {
  co: string; title: string; fam: string | null; tier: string | null; ats: string;
  region: string; remote: boolean; priced: boolean;
  min: number | null; max: number | null; mid: number | null;
  age: number | null; fit: number; c: Record<string, number>;
  friction: string;
}

let LIVE: OldRow[] = [];
let KILL_BY_CO: Record<string, { n: number; reposts: number; maxFired: number }> = {};

beforeAll(async () => {
  if (!HAVE_DB) return;
  const rows = await listBoardAll({ liveOnly: true });
  LIVE = rows
    .filter((r) => r.title)
    .map((r) => {
      const pay = payOf(r.comp_range);
      const c = (r.fit_components || {}) as Record<string, number>;
      return {
        co: r.company,
        title: r.title,
        // The old page kept the raw ats key out of the row and held the display
        // label; the filter compares whatever it held, so the key is what both
        // sides compare now. Same partition either way.
        ats: r.ats,
        fam: famFromDepartment(r.department),
        tier: tierFromTitle(r.title),
        region: regionOf(r.country || r.location || ''),
        remote: Boolean(r.remote),
        priced: pay.priced, min: pay.min_k, max: pay.max_k, mid: pay.mid_k,
        age: typeof r.days_up === 'number' ? r.days_up : null,
        fit: typeof r.fit_total === 'number' ? r.fit_total : 0,
        c: {
          title_scope: c.title_scope ?? 0, remote_geo: c.remote_geo ?? 0,
          comp: c.comp ?? 0, freshness: c.freshness ?? 0, apply_friction: c.apply_friction ?? 0
        },
        friction: frictionOf(r.ats)
      };
    });

  const kills = await listAllKills();
  KILL_BY_CO = {};
  for (const k of kills) {
    const e = KILL_BY_CO[k.company] || (KILL_BY_CO[k.company] = { n: 0, reposts: 0, maxFired: 0 });
    e.n += 1;
    if (k.kill_rule === 'repost_churn') e.reposts += 1;
    const fired = typeof k.times_fired === 'number' ? k.times_fired : 1;
    if (fired > e.maxFired) e.maxFired = fired;
  }
}, 120_000);

function coRecord(co: string) {
  return KILL_BY_CO[co] || { n: 0, reposts: 0, maxFired: 0 };
}

/** passes(), exactly as the browser had it. */
function oldPasses(r: OldRow, s: Filters): boolean {
  if (s.watches.length > 0) {
    const ok = s.watches.some((w) => {
      const def = GROUP_DEFS.find((g) => g.title === w.title);
      if (!def) return false;
      if (!(def.tiers as readonly string[]).includes(r.tier || '')) return false;
      if (def.fam !== null && r.fam !== def.fam) return false;
      return w.off.indexOf(r.title) === -1;
    });
    if (!ok) return false;
  }
  if (s.where === 'remote only' && !r.remote) return false;
  if (s.where === 'in office' && r.remote) return false;
  if (s.floor && r.priced && (r.min as number) < s.floor) return false;
  if (s.priced === 'priced' && !r.priced) return false;
  if (s.priced === 'unpriced' && r.priced) return false;
  if (s.age && r.age !== null && r.age > s.age) return false;
  if (s.level !== 'any' && r.tier !== s.level) return false;
  if (s.ats !== 'any' && r.ats !== s.ats) return false;
  if (s.friction !== 'any' && r.friction !== s.friction) return false;
  if (s.record === 'clean' && coRecord(r.co).n > 0) return false;
  if (s.record === 'lowchurn' && coRecord(r.co).maxFired >= 10) return false;
  return true;
}

function oldBox(rows: OldRow[]) {
  const vals = rows.filter((r) => r.priced).map((r) => r.mid as number);
  return {
    n: rows.length,
    priced: vals.length,
    lo: vals.length ? Math.min(...vals) : null,
    hi: vals.length ? Math.max(...vals) : null,
    p25: quant(vals, 0.25),
    p50: med(vals),
    p75: quant(vals, 0.75)
  };
}

const CASES: { name: string; f: Filters }[] = [
  { name: 'unfiltered', f: { ...NO_FILTERS } },
  { name: 'remote only', f: { ...NO_FILTERS, where: 'remote only' } },
  { name: 'Senior, priced, 14 days', f: { ...NO_FILTERS, level: 'Senior', priced: 'priced', age: 14 } },
  { name: 'ashby with a pay floor', f: { ...NO_FILTERS, ats: 'ashby', floor: 200 } },
  { name: 'a watched title group', f: { ...NO_FILTERS, watches: [{ title: 'Design Leadership', off: [] }] } },
  { name: 'clean issuers, in office', f: { ...NO_FILTERS, record: 'clean', where: 'in office' } }
];

d('jobs-data aggregates match the old client-side calculation', () => {
  for (const c of CASES) {
    it(`${c.name}: cut size, pay ladder, place split, ages, geography, issuers`, async () => {
      const cut = LIVE.filter((r) => oldPasses(r, c.f));
      const got = await liveAggregates(c.f);

      expect(got.cutN, 'cut size').toBe(cut.length);
      expect(got.pricedN, 'priced rows in the cut').toBe(cut.filter((r) => r.priced).length);

      LADDER.forEach((t, i) => {
        expect(got.ladder[i], `pay ladder, ${t}`).toMatchObject(oldBox(cut.filter((r) => r.tier === t)));
      });

      expect(got.place[0], 'remote box').toMatchObject(oldBox(cut.filter((r) => r.remote)));
      expect(got.place[1], 'in office box').toMatchObject(oldBox(cut.filter((r) => !r.remote)));

      const ageDefs: [number, number][] = [[0, 1], [2, 2], [3, 4], [5, 7], [8, 14], [15, 30], [31, 90], [91, 9999]];
      expect(got.ageCounts, 'age histogram').toEqual(
        ageDefs.map(([lo, hi]) => cut.filter((r) => r.age !== null && r.age >= lo && r.age <= hi).length)
      );
      expect(got.in48).toBe(cut.filter((r) => r.age !== null && r.age <= 2).length);
      expect(got.past14).toBe(cut.filter((r) => r.age !== null && r.age > 14).length);

      const regions: Record<string, { n: number; remote: number }> = {};
      cut.forEach((r) => {
        if (!regions[r.region]) regions[r.region] = { n: 0, remote: 0 };
        regions[r.region].n += 1;
        if (r.remote) regions[r.region].remote += 1;
      });
      const gotGeo: Record<string, { n: number; remote: number }> = {};
      got.geo.forEach((g) => { gotGeo[g.region] = { n: g.n, remote: g.remote }; });
      expect(gotGeo, 'geography').toEqual(regions);

      // Fit components: average to one decimal, and the zero count.
      for (const k of ['title_scope', 'remote_geo', 'comp', 'freshness', 'apply_friction']) {
        const vals = cut.map((r) => r.c[k]);
        const avg = vals.length ? Math.round((vals.reduce((a, x) => a + x, 0) / vals.length) * 10) / 10 : 0;
        const row = got.drag.find((x) => x.key === k)!;
        expect(row.avg, `fit component ${k}, average`).toBeCloseTo(avg, 1);
        expect(row.zeros, `fit component ${k}, zeros`).toBe(vals.filter((v) => v === 0).length);
      }

      // The issuer table: one row per company, not per posting.
      const byCo: Record<string, OldRow[]> = {};
      cut.forEach((r) => { (byCo[r.co] || (byCo[r.co] = [])).push(r); });
      const oldIssuers = Object.keys(byCo).length;
      const gotWithLive = got.issuers.filter((r) => r.live > 0).length;
      expect(gotWithLive, 'issuers holding a live row in the cut').toBe(oldIssuers);
      for (const co of Object.keys(byCo).slice(0, 25)) {
        const rowsCo = byCo[co];
        const g = got.issuers.find((x) => x.co === co)!;
        expect(g, `issuer ${co} present`).toBeTruthy();
        expect(g.live, `issuer ${co}, live rows`).toBe(rowsCo.length);
        const pr = rowsCo.filter((r) => r.priced).map((r) => r.mid as number);
        expect(g.med, `issuer ${co}, median`).toBe(med(pr));
        expect(g.remotePct, `issuer ${co}, remote share`).toBe(
          Math.round((rowsCo.filter((r) => r.remote).length / rowsCo.length) * 100)
        );
        expect(g.kills, `issuer ${co}, kills`).toBe(coRecord(co).n);
      }
    }, 120_000);
  }

  it('facet counts match a recomputed cut for every button', async () => {
    const base: Filters = { ...NO_FILTERS, where: 'remote only', level: 'Senior' };
    const got = await liveAggregates(base);
    const countWith = (k: keyof Filters, v: unknown) =>
      LIVE.filter((r) => oldPasses(r, { ...base, [k]: v } as Filters)).length;

    expect(got.facets.where['anywhere']).toBe(countWith('where', 'anywhere'));
    expect(got.facets.where['remote only']).toBe(countWith('where', 'remote only'));
    expect(got.facets.where['in office']).toBe(countWith('where', 'in office'));
    expect(got.facets.priced['priced']).toBe(countWith('priced', 'priced'));
    expect(got.facets.priced['unpriced']).toBe(countWith('priced', 'unpriced'));
    for (const t of LADDER) expect(got.facets.level[t], `level ${t}`).toBe(countWith('level', t));
    for (const a of [2, 4, 7, 14]) expect(got.facets.age[String(a)], `age ${a}`).toBe(countWith('age', a));
    for (const v of [150, 200, 250, 300]) expect(got.facets.floor[String(v)], `floor ${v}`).toBe(countWith('floor', v));
    expect(got.facets.record['clean']).toBe(countWith('record', 'clean'));
    expect(got.facets.record['lowchurn']).toBe(countWith('record', 'lowchurn'));
    expect(got.facets.friction['easy']).toBe(countWith('friction', 'easy'));
    expect(got.facets.friction['hard']).toBe(countWith('friction', 'hard'));
    expect(got.facets.ats['ashby']).toBe(countWith('ats', 'ashby'));
  }, 120_000);

  it('apply friction is the one number that is MEANT to differ', async () => {
    const got = await liveAggregates({ ...NO_FILTERS });
    // Before this build every live row read 'easy', because the value was a
    // literal in the row mapper rather than a measurement.
    expect(got.facets.friction['hard'], 'rows behind an account wall').toBeGreaterThan(0);
    expect(got.facets.friction['easy'] + got.facets.friction['hard']).toBe(got.cutN);
  }, 120_000);

  it('the archive aggregate matches the old kill cut', async () => {
    const kills = await listAllKills();
    const standing = kills.length;
    const got = await killAggregates({ ...NO_FILTERS }, [], []);
    expect(got.archiveTotal).toBe(standing);
    expect(got.killCutN).toBe(standing);
    const ruleTotal = Object.values(got.heat).reduce(
      (a, row) => a + Object.values(row).reduce((x, n) => x + n, 0), 0
    );
    expect(ruleTotal, 'every kill lands in exactly one heat cell').toBe(standing);
  }, 120_000);

  it('no response carries an individual posting', async () => {
    const [agg, kagg, facts] = await Promise.all([
      liveAggregates({ ...NO_FILTERS }), killAggregates({ ...NO_FILTERS }, [], []), boardFacts()
    ]);
    // A posting is identified by its url, its slug, its id or its posting_id.
    // Its title travels only as a group variant label, which is a count of
    // postings sharing a string, not a posting.
    const blob = JSON.stringify({ agg, kagg, facts });
    for (const key of ['"url"', '"slug"', '"posting_id"', '"apply_url"', '"description"', '"first_seen"']) {
      expect(blob.includes(key), `no ${key} in any response`).toBe(false);
    }
  }, 120_000);
});
