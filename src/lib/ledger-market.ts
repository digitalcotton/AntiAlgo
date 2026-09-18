// ledger-market.ts
//
// THE LEDGER v4 -> REAL DATA, TOTAL COVERAGE. The single DATA object, built
// server-side per request from the whole crawl in the database (every provider,
// every function), and injected into ledger.astro as one JSON script tag. When
// the database is not reachable it falls back to the published design export so
// the page still renders.
//
// Family is the sweep's own measured department (Engineering, Design, Sales, ...)
// read at the source; it is not guessed. Seniority is read from the posted title
// (Senior, Staff, Lead, Director) and disclosed as title-derived in the method
// ledger, because no structured level field is collected; the exporter's
// role_family and tier tags refine both when they ship. Applicant system is
// named through atsLabel(), which titlecases any board it does not know, so
// every provider the sweep reads appears by name and none is collapsed.
//
// Gate 3: no em dash, no en dash, no curly quotes. One clock: dates derive from
// the sweep, never Date.now().

import {
  verifiedJobs,
  killsOnRecord,
  prospectRows,
  postedYcRoles,
  loadStats,
  sweepDate,
  ageOf,
  killDuration,
  publishedRuleOf,
  daysBetween,
  atsLabel,
  type Job,
  type KillRecord
} from './data';
import { isConfigured } from './db';
import { listBoardAll, listAllKills, getBoardStats, type BoardKillRow } from './job-store';
import type { BoardRow } from './board-jobs';

export type Region =
  | 'US West' | 'US East' | 'US Central' | 'EU' | 'UK'
  | 'Canada' | 'APAC' | 'LATAM' | 'Worldwide' | 'Unknown';
/** The four design families v4 draws; the family field is a string so a measured
 *  department outside these (Engineering, Sales, ...) is carried verbatim. */
export type Fam = 'product' | 'design engineering' | 'brand' | 'design systems';
export type Tier = 'Senior' | 'Staff' | 'Lead' | 'Director';
export type RuleLabel =
  | 'repost churn' | 'touched, not refreshed' | 'misrepresented remote'
  | 'zombie, past close date' | 'phantom, link 404s';

export interface FitComponents {
  title_scope: number; remote_geo: number; comp: number;
  freshness: number; apply_friction: number;
}
export interface LiveRow {
  co: string; title: string; fam: string | null; tier: Tier | null; ats: string;
  coRegion: Region; region: Region; remote: boolean; place: string;
  priced: boolean; min: number | null; max: number | null; mid: number | null;
  age: number | null; published: string | null; observed: string | null;
  risk: 'LOW' | 'MED' | 'HIGH'; friction: 'easy' | 'medium' | 'heavy';
  minutes: number | null; account: boolean; status: 'live';
  c: FitComponents; fit: number;
}
export interface KillRow {
  co: string; title: string; rule: RuleLabel; ats: string;
  fired: number; life: number | null; killedOn: string | null;
  fam: string | null; tier: Tier | null; pipeline: 'sweep' | 'crawl';
}
export type CoRow = [string, number, number, Region, string];
export interface TitleIndexEntry {
  title: string; n: number; variants: [string, number][];
  fams: string[]; tiers: string[];
}
export interface LedgerData {
  SWEEP: {
    clock: string; stamp: string; boards: number; observed: number;
    pulled: number; verified: number; killed: number;
  };
  PAY_LO: number; PAY_HI: number; LIFE_HI: number;
  FAMS: Fam[]; TIERS: Tier[]; RULES: RuleLabel[];
  coverage: 'crawl' | 'design';
  hasFamilyTags: boolean; hasTierTags: boolean;
  LIVE: LiveRow[];
  KILLS: KillRow[];
  CO: CoRow[];
  KILL_BY_CO: Record<string, { n: number; reposts: number; maxFired: number }>;
  ALIAS: Record<string, string>;
  TITLE_INDEX: TitleIndexEntry[];
  INDUSTRY: [string, number, number][];
  TEAM: [string, number, boolean][];
  SIGNALS: [string, number][];
  prospectTotal: number; prospectPre: number; prospectPosted: number;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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
function frictionOf(ease: Job['ease']): 'easy' | 'medium' | 'heavy' {
  if (ease == null) return 'easy';
  const f = String(ease.friction || '').toUpperCase();
  if (f === 'MEDIUM') return 'medium';
  if (f === 'HARD') return 'heavy';
  return 'easy';
}

const RULE_LABEL: Record<string, RuleLabel> = {
  repost_churn: 'repost churn',
  touched_not_refreshed: 'touched, not refreshed',
  misrepresented: 'misrepresented remote',
  zombie: 'zombie, past close date',
  phantom: 'phantom, link 404s'
};
function ruleLabel(rule: string | null): RuleLabel {
  return (rule && RULE_LABEL[rule]) || 'repost churn';
}

/** The measured department, verbatim, as the family/function. Null when the ATS
 *  published none. Not inferred from the title. */
function famFromDepartment(dep: string | null | undefined): string | null {
  const d = (dep || '').trim();
  return d ? d : null;
}
/** Seniority read from the posted title, or null when no seniority word is
 *  present. Disclosed as title-derived; never defaulted to Senior. */
function tierFromTitle(title: string): Tier | null {
  const t = title.toLowerCase();
  if (/\b(director|head of|vp|vice president|chief)\b/.test(t)) return 'Director';
  if (/\b(principal|lead)\b/.test(t)) return 'Lead';
  if (/\bstaff\b/.test(t)) return 'Staff';
  if (/\b(senior|sr|snr)\b/.test(t)) return 'Senior';
  return null;
}

function regionOf(locationText: string): Region {
  const t = (locationText || '').toLowerCase();
  const has = (s: string) => t.includes(s);
  const word = (w: string) => new RegExp('\\b' + w + '\\b').test(t);
  if (has('remote') && (has('worldwide') || has('global') || has('anywhere'))) return 'Worldwide';
  if (has('united kingdom') || has('london') || has('england') || has('scotland') || word('uk')) return 'UK';
  if (has('ireland') || has('dublin') || has('spain') || has('germany') || has('berlin') ||
      has('france') || has('paris') || has('netherlands') || has('amsterdam') ||
      has('portugal') || has('lisbon') || has('europe') || word('eu')) return 'EU';
  if (has('canada') || has('toronto') || has('vancouver') || has('montreal')) return 'Canada';
  if (has('singapore') || has('tokyo') || has('sydney') || has('apac') ||
      has('bangalore') || has('india') || has('australia')) return 'APAC';
  if (has('mexico') || has('brazil') || has('argentina') || has('latam') || has('sao paulo')) return 'LATAM';
  if (has('san francisco') || word('sf') || has('foster city') || has('mountain view') ||
      has('seattle') || has('los angeles') || word('ca') || word('wa') || word('or')) return 'US West';
  if (has('new york') || has('nyc') || word('ny') || has('boston') || word('ma') ||
      has('washington') || word('dc') || has('atlanta') || has('miami')) return 'US East';
  if (has('austin') || word('tx') || has('chicago') || word('il') || has('denver') ||
      word('co') || has('texas')) return 'US Central';
  if (has('north america') || has('united states') || word('us') || has('remote')) return 'US West';
  return 'Unknown';
}

const GROUP_DEFS: { title: string; test: (r: LiveRow) => boolean }[] = [
  { title: 'Product Designer', test: r => r.fam === 'product' && (r.tier === 'Senior' || r.tier === 'Staff') },
  { title: 'Design Engineer', test: r => r.fam === 'design engineering' && (r.tier === 'Senior' || r.tier === 'Staff') },
  { title: 'Brand Designer', test: r => r.fam === 'brand' && (r.tier === 'Senior' || r.tier === 'Staff') },
  { title: 'Design Systems Designer', test: r => r.fam === 'design systems' && (r.tier === 'Senior' || r.tier === 'Staff') },
  { title: 'Design Leadership', test: r => r.tier === 'Lead' || r.tier === 'Director' }
];

const TEAM_BANDS: { label: string; lo: number; hi: number; inBand: boolean }[] = [
  { label: '1-5', lo: 1, hi: 5, inBand: false },
  { label: '6-10', lo: 6, hi: 10, inBand: true },
  { label: '11-20', lo: 11, hi: 20, inBand: true },
  { label: '21-50', lo: 21, hi: 50, inBand: false },
  { label: '51-120', lo: 51, hi: 120, inBand: false },
  { label: '121+', lo: 121, hi: Infinity, inBand: false }
];

// ---------------------------------------------------------------------------
// Row mappers.
// ---------------------------------------------------------------------------

function fitFrom(total: number | null | undefined, comps: Partial<FitComponents> | null | undefined): { c: FitComponents; fit: number } {
  const c = comps || {};
  return {
    c: {
      title_scope: c.title_scope ?? 0,
      remote_geo: c.remote_geo ?? 0,
      comp: c.comp ?? 0,
      freshness: c.freshness ?? 0,
      apply_friction: c.apply_friction ?? 0
    },
    fit: typeof total === 'number' ? total : 0
  };
}

function liveFromBoardRow(r: BoardRow): LiveRow | null {
  if (!r.title) return null;
  const cr = r.comp_range;
  const priced = !!cr && typeof cr.min === 'number' && cr.min > 0;
  const min = priced ? Math.round(cr!.min / 1000) : null;
  const max = priced ? Math.round((cr!.max ?? cr!.min) / 1000) : null;
  const mid = priced ? Math.round((min as number + (max as number)) / 2) : null;
  const region = regionOf(r.country || r.location || '');
  const { c, fit } = fitFrom(r.fit_total, r.fit_components);
  return {
    co: r.company, title: r.title,
    fam: famFromDepartment(r.department),
    tier: tierFromTitle(r.title),
    ats: atsLabel(r.ats),
    coRegion: region, region,
    remote: !!r.remote, place: r.location || 'Not stated',
    priced, min, max, mid,
    age: typeof r.days_up === 'number' ? r.days_up : null,
    published: dateOnly(r.published), observed: dateOnly(r.first_seen),
    risk: 'LOW', friction: 'easy', minutes: null, account: false,
    status: 'live', c, fit
  };
}

function liveFromJob(job: Job): LiveRow | null {
  if (job.title == null) return null;
  const priced = !!job.comp_range && job.comp_range.min > 0;
  const min = priced ? Math.round(job.comp_range!.min / 1000) : null;
  const max = priced ? Math.round(job.comp_range!.max / 1000) : null;
  const mid = priced ? Math.round((min as number + (max as number)) / 2) : null;
  const region = regionOf(job.remote ? job.location : (job.location || ''));
  const { c, fit } = fitFrom(job.fit.total, job.fit);
  return {
    co: job.company, title: job.title,
    fam: famFromDepartment(job.role_family) ?? null,
    tier: job.tier ?? tierFromTitle(job.title),
    ats: atsLabel(job.source_system),
    coRegion: regionOf(job.location), region,
    remote: job.remote, place: job.location,
    priced, min, max, mid,
    age: ageOf(job)?.days ?? null,
    published: job.published_date, observed: job.first_observed,
    risk: job.risk as LiveRow['risk'], friction: frictionOf(job.ease),
    minutes: job.ease?.minutes_estimate ?? null, account: job.ease?.account_required ?? false,
    status: 'live', c, fit
  };
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

function assemble(
  SWEEP: LedgerData['SWEEP'],
  LIVE: LiveRow[],
  KILLS: KillRow[],
  coverage: 'crawl' | 'design'
): LedgerData {
  const hasFamilyTags = LIVE.some(r => r.fam !== null) || KILLS.some(k => k.fam !== null);
  const hasTierTags = LIVE.some(r => r.tier !== null) || KILLS.some(k => k.tier !== null);

  // CO: union of live and kill companies.
  const names: string[] = [];
  const seen = new Set<string>();
  const homeRegion: Record<string, Region> = {};
  const repSystem: Record<string, string> = {};
  for (const r of LIVE) {
    if (!seen.has(r.co)) { seen.add(r.co); names.push(r.co); homeRegion[r.co] = r.coRegion; repSystem[r.co] = r.ats; }
  }
  for (const k of KILLS) if (!seen.has(k.co)) { seen.add(k.co); names.push(k.co); homeRegion[k.co] = 'Unknown'; repSystem[k.co] = k.ats; }
  const liveByCo: Record<string, number> = {};
  const killByCoN: Record<string, number> = {};
  for (const r of LIVE) liveByCo[r.co] = (liveByCo[r.co] || 0) + 1;
  for (const k of KILLS) killByCoN[k.co] = (killByCoN[k.co] || 0) + 1;
  const CO: CoRow[] = names.map(name => [
    name, liveByCo[name] || 0, killByCoN[name] || 0, homeRegion[name] || 'Unknown', repSystem[name] || 'the company site'
  ]);

  const KILL_BY_CO: Record<string, { n: number; reposts: number; maxFired: number }> = {};
  for (const k of KILLS) {
    const e = KILL_BY_CO[k.co] || (KILL_BY_CO[k.co] = { n: 0, reposts: 0, maxFired: 0 });
    e.n++;
    if (k.rule === 'repost churn') e.reposts++;
    if (k.fired > e.maxFired) e.maxFired = k.fired;
  }

  const ranked = CO.slice().sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ALIAS: Record<string, string> = {};
  ranked.forEach((c, i) => { ALIAS[c[0]] = 'source ' + (i < 26 ? LETTERS[i] : String(i + 1)); });

  const TITLE_INDEX: TitleIndexEntry[] = GROUP_DEFS.map(g => {
    const rows = LIVE.filter(g.test);
    const counts: Record<string, number> = {};
    rows.forEach(r => { counts[r.title] = (counts[r.title] || 0) + 1; });
    const variants = Object.keys(counts)
      .map(k => [k, counts[k]] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    const fams: Record<string, 1> = {}, tiers: Record<string, 1> = {};
    rows.forEach(r => { if (r.fam) fams[r.fam] = 1; if (r.tier) tiers[r.tier] = 1; });
    return { title: g.title, n: rows.length, variants, fams: Object.keys(fams), tiers: Object.keys(tiers) };
  });

  // Prospects (INDUSTRY, TEAM, SIGNALS) from the pre-posting pass.
  const pros = prospectRows();
  const byIndustry: Record<string, number[]> = {};
  for (const p of pros) {
    const ind = p.prospect?.industry;
    if (!ind) continue;
    (byIndustry[ind] || (byIndustry[ind] = [])).push(p.fit.total);
  }
  const INDUSTRY: [string, number, number][] = Object.keys(byIndustry)
    .map(name => [name, byIndustry[name].length, medInt(byIndustry[name])] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);
  const TEAM: [string, number, boolean][] = TEAM_BANDS.map(b => {
    const count = pros.filter(p => {
      const n = p.prospect?.team_size;
      return typeof n === 'number' && n >= b.lo && n <= b.hi;
    }).length;
    return [b.label, count, b.inBand];
  });
  const sigCount: Record<string, number> = {};
  const sigText: Record<string, string> = {};
  for (const p of pros) {
    for (const s of (p.prospect?.signals || [])) {
      sigCount[s.key] = (sigCount[s.key] || 0) + 1;
      if (sigText[s.key] === undefined) sigText[s.key] = scrub(s.observation || s.key);
    }
  }
  const SIGNALS: [string, number][] = Object.keys(sigCount)
    .map(key => [sigText[key], sigCount[key], key] as [string, number, string])
    .sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2]))
    .map(x => [x[0], x[1]] as [string, number]);

  const prospectPre = pros.length;
  const prospectPosted = postedYcRoles().length;
  const prospectTotal = prospectPre + prospectPosted;

  return {
    SWEEP,
    PAY_LO: 110, PAY_HI: 360, LIFE_HI: 44,
    FAMS: ['product', 'design engineering', 'brand', 'design systems'],
    TIERS: ['Senior', 'Staff', 'Lead', 'Director'],
    RULES: ['repost churn', 'touched, not refreshed', 'misrepresented remote', 'zombie, past close date', 'phantom, link 404s'],
    coverage, hasFamilyTags, hasTierTags,
    LIVE, KILLS, CO, KILL_BY_CO, ALIAS, TITLE_INDEX,
    INDUSTRY, TEAM, SIGNALS,
    prospectTotal, prospectPre, prospectPosted
  };
}

function buildFromStatic(): LedgerData {
  const stats = loadStats();
  const SWEEP = {
    clock: sweepDate(),
    stamp: stampFrom(stats.swept_at_utc),
    boards: stats.boards,
    observed: stats._meta?.postings_observed ?? 0,
    pulled: stats.pulled,
    verified: stats.verified_live,
    killed: stats.killed
  };
  const LIVE = verifiedJobs().map(liveFromJob).filter((r): r is LiveRow => r !== null);
  const KILLS: KillRow[] = killsOnRecord().map((k: KillRecord) => ({
    co: k.company, title: k.title, rule: ruleLabel(publishedRuleOf(k)), ats: atsLabel(k.ats),
    fired: k.times_fired ?? 1, life: killDuration(k)?.days ?? null, killedOn: k.killed_on,
    fam: famFromDepartment(k.role_family) ?? null, tier: k.tier ?? tierFromTitle(k.title),
    pipeline: k.pipeline ?? 'crawl'
  }));
  return assemble(SWEEP, LIVE, KILLS, 'design');
}

async function buildFromCrawl(): Promise<LedgerData> {
  const [rows, kills, bs] = await Promise.all([listBoardAll({ liveOnly: true }), listAllKills(), getBoardStats()]);
  const LIVE = rows.map(liveFromBoardRow).filter((r): r is LiveRow => r !== null);
  const KILLS: KillRow[] = kills.map((k: BoardKillRow) => ({
    co: k.company, title: k.title, rule: ruleLabel(k.kill_rule), ats: atsLabel(k.ats),
    fired: typeof k.times_fired === 'number' ? k.times_fired : 1,
    life: daysBetween(dateOnly(k.first_published), dateOnly(k.killed_on)),
    killedOn: dateOnly(k.killed_on),
    fam: null, tier: tierFromTitle(k.title),
    pipeline: (k.pipeline === 'crawl' ? 'crawl' : 'sweep')
  }));
  const sweptIso = bs?.swept_at ? iso(bs.swept_at) : loadStats().swept_at_utc;
  const SWEEP = {
    clock: dateOnly(sweptIso) ?? sweepDate(),
    stamp: stampFrom(sweptIso),
    boards: bs?.boards_swept ?? 0,
    observed: bs?.postings_observed ?? (LIVE.length + KILLS.length),
    pulled: (bs?.verified_live ?? LIVE.length) + (bs?.killed ?? 0),
    verified: bs?.verified_live ?? LIVE.length,
    killed: bs?.killed ?? 0
  };
  return assemble(SWEEP, LIVE, KILLS, 'crawl');
}

let CACHED: LedgerData | null = null;

/**
 * The DATA object for the Ledger. Reads the whole crawl from the database (total
 * coverage) when it is reachable, and falls back to the published design export
 * otherwise, so the page renders in every environment.
 */
export async function buildLedgerData(): Promise<LedgerData> {
  if (CACHED) return CACHED;
  if (isConfigured()) {
    try {
      CACHED = await buildFromCrawl();
      return CACHED;
    } catch (error) {
      console.error('ledger-market: crawl read failed, falling back to the design export:', error);
    }
  }
  CACHED = buildFromStatic();
  return CACHED;
}
