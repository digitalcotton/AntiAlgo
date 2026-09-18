// ledger-market.ts
//
// THE LEDGER v4 -> REAL DATA. The single DATA object, built server-side at build
// time from the src/lib/data.ts accessors and injected into ledger.astro as one
// JSON script tag. This file holds the only new logic in the port: the region
// parser, the friction map, and the Part 1 assembly. Family and seniority are
// NOT parsed here: they are read from the sweep's own measured tags
// (job.role_family, job.tier) and are null until the exporter emits them, which
// the page renders as an honest gap. See the exporter field contract and the
// ledger-family-tier-upstream decision.
//
// Applicant system is named through atsLabel() (data.ts), which titlecases any
// board it does not explicitly know, so every system the sweep reads appears by
// name and none is collapsed to "custom". The heatmap columns are derived from
// the data on the client, never a hand-list.
//
// Gate 3: no em dash, no en dash, no curly quotes anywhere. Range glyphs are
// plain hyphens. One clock: every date derives from the sweep, never Date.now().

import {
  verifiedJobs,
  killsOnRecord,
  prospectRows,
  postedYcRoles,
  loadJobs,
  loadStats,
  sweepDate,
  ageOf,
  killDuration,
  publishedRuleOf,
  atsLabel,
  type Job,
  type KillRecord,
  type RoleFamily,
  type RoleTier
} from './data';

// ---------------------------------------------------------------------------
// Serializable shapes. Everything here survives JSON.stringify (no functions).
// The client rehydrates the TITLE_INDEX group tests from a fixed spec.
// ---------------------------------------------------------------------------

export type Region =
  | 'US West' | 'US East' | 'US Central' | 'EU' | 'UK'
  | 'Canada' | 'APAC' | 'LATAM' | 'Worldwide' | 'Unknown';
/** v4's family label vocabulary (spaces, not the tag's underscores). Null is an
 *  honest absence, never a guess. */
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
  co: string; title: string; fam: Fam | null; tier: Tier | null; ats: string;
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
  fam: Fam | null; tier: Tier | null; pipeline: 'sweep' | 'crawl';
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
  /** True when the sweep has tagged at least one row with a family/tier. While
   *  false, every family- and seniority-grouped view renders its empty state. */
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
// PART 0 helpers. The only new logic: region parsing, friction, rule label.
// Family and seniority are read from measured tags, not parsed.
// ---------------------------------------------------------------------------

/** iso.slice(0,10) + ' ' + iso.slice(11,16) + ' UTC'. Slice only, never format. */
function stampFrom(iso: string): string {
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
}

/** Small integer median, matching the client med() (rounds a two-value mean). */
function medInt(a: number[]): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Strip en/em dashes and curly quotes from a source string (gate 3). Classes
 *  are built from char codes so this file holds no literal dash or curly byte. */
function scrub(text: string): string {
  const cc = String.fromCharCode;
  const dashes = cc(0x2013, 0x2014);
  const singles = cc(0x2018, 0x2019);
  const doubles = cc(0x201c, 0x201d);
  return text
    .replace(new RegExp('[' + dashes + ']', 'g'), '-')
    .replace(new RegExp('[' + singles + ']', 'g'), "'")
    .replace(new RegExp('[' + doubles + ']', 'g'), '"');
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

/** The sweep's family tag mapped to v4's display label, or null when untagged.
 *  Never inferred from the title: a null family is drawn as a gap. */
const FAM_LABEL: Record<RoleFamily, Fam> = {
  product: 'product',
  design_engineering: 'design engineering',
  brand: 'brand',
  design_systems: 'design systems'
};
function famOf(tag: RoleFamily | null | undefined): Fam | null {
  return tag ? FAM_LABEL[tag] ?? null : null;
}
function tierOf(tag: RoleTier | null | undefined): Tier | null {
  return tag ?? null;
}

/** regionOf: lowercase, ordered tests, two-letter tokens are word-bounded. A
 *  presentational bucketing of the collected location string. */
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

// The board's own title index groups. The tests run server-side to build the
// index; the client rehydrates the same tests by title. A row whose family or
// tier is null (untagged) matches no group, so the index reads zero until the
// sweep tags land.
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
// PART 1: the DATA object. Built once, JSON safe.
// ---------------------------------------------------------------------------

let CACHED: LedgerData | null = null;

export function buildLedgerData(): LedgerData {
  if (CACHED) return CACHED;

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

  const allJobs = loadJobs();
  const jobSrc = verifiedJobs();
  const killSrc = killsOnRecord();

  function companyHomeLocation(company: string): string {
    const v = jobSrc.find(j => j.company === company);
    if (v) return v.location;
    const anyJob = allJobs.find(j => j.company === company && j.location);
    if (anyJob) return anyJob.location;
    const k = killSrc.find(x => x.company === company);
    if (k && k.evidence && k.evidence.location_as_printed) return k.evidence.location_as_printed;
    return '';
  }
  function representativeSystem(company: string): string {
    const v = jobSrc.find(j => j.company === company);
    if (v) return v.source_system;
    const k = killSrc.find(x => x.company === company);
    if (k && k.ats) return k.ats;
    return 'custom';
  }

  // 1.1 LIVE
  const LIVE: LiveRow[] = [];
  for (const job of jobSrc) {
    if (job.title == null) continue;
    const title = job.title;
    const priced = !!job.comp_range && job.comp_range.min > 0;
    const min = priced ? Math.round(job.comp_range!.min / 1000) : null;
    const max = priced ? Math.round(job.comp_range!.max / 1000) : null;
    const mid = priced ? Math.round(((min as number) + (max as number)) / 2) : null;
    const coRegion = regionOf(companyHomeLocation(job.company));
    const fitC = job.fit;
    LIVE.push({
      co: job.company,
      title,
      fam: famOf(job.role_family),
      tier: tierOf(job.tier),
      ats: atsLabel(job.source_system),
      coRegion,
      region: job.remote ? regionOf(job.location) : coRegion,
      remote: job.remote,
      place: job.location,
      priced, min, max, mid,
      age: ageOf(job)?.days ?? null,
      published: job.published_date,
      observed: job.first_observed,
      risk: job.risk as LiveRow['risk'],
      friction: frictionOf(job.ease),
      minutes: job.ease?.minutes_estimate ?? null,
      account: job.ease?.account_required ?? false,
      status: 'live',
      // Real data already carries the components and the total. Copy, never derive.
      c: {
        title_scope: fitC.title_scope,
        remote_geo: fitC.remote_geo,
        comp: fitC.comp,
        freshness: fitC.freshness,
        apply_friction: fitC.apply_friction
      },
      fit: fitC.total
    });
  }

  // 1.2 KILLS
  const KILLS: KillRow[] = killSrc.map((k: KillRecord) => ({
    co: k.company,
    title: k.title,
    rule: ruleLabel(publishedRuleOf(k)),
    ats: atsLabel(k.ats),
    fired: k.times_fired ?? 1,
    life: killDuration(k)?.days ?? null,
    killedOn: k.killed_on,
    fam: famOf(k.role_family),
    tier: tierOf(k.tier),
    pipeline: k.pipeline ?? 'crawl'
  }));

  const hasFamilyTags = LIVE.some(r => r.fam !== null) || KILLS.some(k => k.fam !== null);
  const hasTierTags = LIVE.some(r => r.tier !== null) || KILLS.some(k => k.tier !== null);

  // 1.3 CO: union of job and kill companies.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of LIVE) if (!seen.has(r.co)) { seen.add(r.co); names.push(r.co); }
  for (const k of KILLS) if (!seen.has(k.co)) { seen.add(k.co); names.push(k.co); }
  const CO: CoRow[] = names.map(name => [
    name,
    LIVE.filter(r => r.co === name).length,
    KILLS.filter(k => k.co === name).length,
    regionOf(companyHomeLocation(name)),
    atsLabel(representativeSystem(name))
  ]);

  // 1.4 KILL_BY_CO
  const KILL_BY_CO: Record<string, { n: number; reposts: number; maxFired: number }> = {};
  for (const k of KILLS) {
    const e = KILL_BY_CO[k.co] || (KILL_BY_CO[k.co] = { n: 0, reposts: 0, maxFired: 0 });
    e.n++;
    if (k.rule === 'repost churn') e.reposts++;
    if (k.fired > e.maxFired) e.maxFired = k.fired;
  }

  // 1.5 ALIAS: rank by standingKills desc, tie company name asc.
  const ranked = CO.slice().sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ALIAS: Record<string, string> = {};
  ranked.forEach((c, i) => { ALIAS[c[0]] = 'source ' + (i < 26 ? LETTERS[i] : String(i + 1)); });

  // 1.6 TITLE_INDEX over LIVE (data only, no test function in the payload).
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

  // 1.7 INDUSTRY, TEAM, SIGNALS from prospectRows().
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
    const list = p.prospect?.signals || [];
    for (const s of list) {
      sigCount[s.key] = (sigCount[s.key] || 0) + 1;
      if (sigText[s.key] === undefined) sigText[s.key] = scrub(s.observation || s.key);
    }
  }
  const SIGNALS: [string, number][] = Object.keys(sigCount)
    .map(key => [sigText[key], sigCount[key], key] as [string, number, string])
    .sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2]))
    .map(x => [x[0], x[1]] as [string, number]);

  // 1.8 Pipeline totals.
  const prospectPre = pros.length;
  const prospectPosted = postedYcRoles().length;
  const prospectTotal = prospectPre + prospectPosted;

  CACHED = {
    SWEEP,
    PAY_LO: 110, PAY_HI: 360, LIFE_HI: 44,
    FAMS: ['product', 'design engineering', 'brand', 'design systems'],
    TIERS: ['Senior', 'Staff', 'Lead', 'Director'],
    RULES: ['repost churn', 'touched, not refreshed', 'misrepresented remote', 'zombie, past close date', 'phantom, link 404s'],
    hasFamilyTags, hasTierTags,
    LIVE, KILLS, CO, KILL_BY_CO, ALIAS, TITLE_INDEX,
    INDUSTRY, TEAM, SIGNALS,
    prospectTotal, prospectPre, prospectPosted
  };
  return CACHED;
}
