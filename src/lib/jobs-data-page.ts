/**
 * jobs-data-page.ts: what /jobs-data embeds in its own HTML for a paid reader.
 *
 * WHAT IT IS NOT ANY MORE. It used to be buildLedgerData(), which read every
 * live row and every kill out of Postgres and serialised the lot into the page:
 * 31,310 rows, 12.0 MB, and a page that stopped rendering. This is the same
 * page's first screen with none of the rows: the crawl's headline counts, the
 * handful of board-wide facts no filter moves, and the PRECOMPUTED unfiltered
 * view, so the first paint needs no round trip. Every later cut comes from
 * /jobs-data/summary.
 *
 * THE PIPELINE NUMBERS ARE STILL STATIC. Industry, team size and signals come
 * from the pre-posting prospect pass, a published file rather than the crawl.
 * They are a few dozen rows and no filter on this page touches them, so they
 * ride along whole.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

import { prospectRows, postedYcRoles, loadStats, sweepDate } from './data';
import { getBoardStats } from './job-store';
import { cachedView, cachedFacts } from './jobs-data-cache';
import { NO_FILTERS } from './jobs-data-filters';
import { PAY_LO, PAY_HI, LIFE_HI, LADDER, RULE_KEYS, RULE_LABELS } from './jobs-data-agg';

function iso(v: Date | string): string { return v instanceof Date ? v.toISOString() : String(v); }
function dateOnly(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso(v));
  return m ? m[1] : null;
}
function stampFrom(isoStr: string): string {
  return isoStr.slice(0, 10) + ' ' + isoStr.slice(11, 16) + ' UTC';
}
function medInt(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function scrub(text: string): string {
  const cc = String.fromCharCode;
  return text
    .replace(new RegExp('[' + cc(0x2013, 0x2014) + ']', 'g'), '-')
    .replace(new RegExp('[' + cc(0x2018, 0x2019) + ']', 'g'), "'")
    .replace(new RegExp('[' + cc(0x201c, 0x201d) + ']', 'g'), '"');
}

const TEAM_BANDS = [
  { label: '1-5', lo: 1, hi: 5, inBand: false },
  { label: '6-10', lo: 6, hi: 10, inBand: true },
  { label: '11-20', lo: 11, hi: 20, inBand: true },
  { label: '21-50', lo: 21, hi: 50, inBand: false },
  { label: '51-120', lo: 51, hi: 120, inBand: false },
  { label: '121+', lo: 121, hi: Infinity, inBand: false }
];

/** The pre-posting pass, which no filter on this page cuts. */
function pipeline() {
  const pros = prospectRows();

  const byIndustry: Record<string, number[]> = {};
  for (const p of pros) {
    const ind = p.prospect?.industry;
    if (!ind) continue;
    (byIndustry[ind] || (byIndustry[ind] = [])).push(p.fit.total);
  }
  const INDUSTRY = Object.keys(byIndustry)
    .map((name) => [name, byIndustry[name].length, medInt(byIndustry[name])] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);

  const TEAM = TEAM_BANDS.map((b) => {
    const count = pros.filter((p) => {
      const n = p.prospect?.team_size;
      return typeof n === 'number' && n >= b.lo && n <= b.hi;
    }).length;
    return [b.label, count, b.inBand] as [string, number, boolean];
  });

  const sigCount: Record<string, number> = {};
  const sigText: Record<string, string> = {};
  for (const p of pros) {
    for (const s of (p.prospect?.signals || [])) {
      sigCount[s.key] = (sigCount[s.key] || 0) + 1;
      if (sigText[s.key] === undefined) sigText[s.key] = scrub(s.observation || s.key);
    }
  }
  const SIGNALS = Object.keys(sigCount)
    .map((key) => [sigText[key], sigCount[key], key] as [string, number, string])
    .sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2]))
    .map((x) => [x[0], x[1]] as [string, number]);

  const prospectPre = pros.length;
  const prospectPosted = postedYcRoles().length;
  return { INDUSTRY, TEAM, SIGNALS, prospectPre, prospectPosted, prospectTotal: prospectPre + prospectPosted };
}

/**
 * The page's own payload. Small by construction: the biggest thing in it is the
 * issuer table, one row per company, which is an aggregate and not a listing.
 */
export async function buildJobsDataPayload() {
  const [bs, facts, view] = await Promise.all([
    getBoardStats(),
    cachedFacts(),
    cachedView({ ...NO_FILTERS })
  ]);

  const sweptIso = bs?.swept_at ? iso(bs.swept_at) : loadStats().swept_at_utc;
  const SWEEP = {
    clock: dateOnly(sweptIso) ?? sweepDate(),
    stamp: stampFrom(sweptIso),
    boards: bs?.boards_swept ?? 0,
    observed: bs?.postings_observed ?? facts.liveN,
    pulled: (bs?.verified_live ?? facts.liveN) + (bs?.killed ?? 0),
    verified: bs?.verified_live ?? facts.liveN,
    killed: bs?.killed ?? 0
  };

  return {
    SWEEP,
    PAY_LO, PAY_HI, LIFE_HI,
    TIERS: LADDER.slice(),
    RULE_KEYS: RULE_KEYS.slice(),
    RULES: RULE_KEYS.map((k) => RULE_LABELS[k]),
    FACTS: facts,
    VIEW: view,
    ...pipeline()
  };
}
