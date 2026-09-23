/**
 * jobs-derived.mjs: ONE DEFINITION of every field the Jobs Data page derives
 * from a posting rather than reads from it.
 *
 * WHY THIS FILE EXISTS. Until 2026-09-23 these definitions lived in
 * src/lib/ledger-market.ts and ran in the browser, once per row, on every
 * render: seniority was a regex over the title, region was a regex over the
 * location, family was the department trimmed, and friction was the literal
 * string 'easy' on every row. That forced the whole board into the page as
 * JSON (12.0 MB at 31,310 live rows) because no filter could be a SQL WHERE
 * against a column that did not exist.
 *
 * Now the derivation happens ONCE, at ingest, into real columns, and the page
 * filters on those columns. This file is the single owner of the rules:
 *
 *   - scripts/ingest-jobs.mjs calls it on every row it writes (nightly);
 *   - scripts/backfill-derived.mjs calls it to fill rows written before
 *     db/207 added the columns;
 *   - src/lib/jobs-data-agg.ts NEVER re-derives; it reads the columns.
 *
 * So there is no second copy to drift. A rule change here is a code change
 * plus one backfill, and both halves of the data agree by construction.
 *
 * PLAIN .mjs ON PURPOSE. scripts/ingest-jobs.mjs is a plain Node script that
 * cannot import a TypeScript module (the same reason src/lib/upsert-sql.mjs is
 * .mjs). TypeScript callers import it directly; the shapes are documented in
 * jobs-derived.d.ts.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

/** The seniority ladder, lowest to highest. Order is load bearing: the pay
 *  ladder chart draws in this order and reads the step between neighbours. */
export const TIERS = ['Senior', 'Staff', 'Lead', 'Director'];

/** Every region regionOf can answer. 'Unknown' is a real answer, not a gap:
 *  it means the posting printed a location this rule does not recognise. */
export const REGIONS = [
  'US West', 'US East', 'US Central', 'EU', 'UK',
  'Canada', 'APAC', 'LATAM', 'Worldwide', 'Unknown'
];

/** The two friction levels. See frictionOf for what they mean and the
 *  evidence behind the mapping. */
export const FRICTIONS = ['easy', 'hard'];

// ---------------------------------------------------------------------------
// Seniority.
// ---------------------------------------------------------------------------

/**
 * Seniority read from the posted title, or null when the title prints no
 * seniority word. Never defaulted to Senior: a title with no level word is a
 * posting that did not state a level, and the page shows that as a gap.
 *
 * Order matters. "Principal Design Lead" is Lead, not Senior, because the
 * ladder is tested from the top down.
 */
export function tierFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(director|head of|vp|vice president|chief)\b/.test(t)) return 'Director';
  if (/\b(principal|lead)\b/.test(t)) return 'Lead';
  if (/\bstaff\b/.test(t)) return 'Staff';
  if (/\b(senior|sr|snr)\b/.test(t)) return 'Senior';
  return null;
}

// ---------------------------------------------------------------------------
// Family (function).
// ---------------------------------------------------------------------------

/**
 * The measured department, verbatim, as the family. Null when the applicant
 * system published none. NOT inferred from the title: the department is a
 * field the employer filled in, and a guess from the title would be a
 * different, weaker claim wearing the same name.
 */
export function famFromDepartment(department) {
  const d = String(department == null ? '' : department).trim();
  return d ? d : null;
}

// ---------------------------------------------------------------------------
// Region.
// ---------------------------------------------------------------------------

/**
 * The region a posted location falls in. A word list, in precedence order:
 * worldwide-remote first, then countries and regions, then US sub-regions,
 * then the bare-US catch-all. Anything unrecognised is 'Unknown'.
 */
export function regionOf(locationText) {
  const t = String(locationText || '').toLowerCase();
  const has = (s) => t.includes(s);
  const word = (w) => new RegExp('\\b' + w + '\\b').test(t);
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

// ---------------------------------------------------------------------------
// Apply friction.
// ---------------------------------------------------------------------------

/**
 * ACCOUNT-WALLED APPLICANT SYSTEMS. An applicant system is on this list when
 * the applicant must create an account, or sign in to an existing one, BEFORE
 * the application form can be reached. Everything not on the list is 'easy':
 * the form is the first thing the apply link shows, and a name, an email and a
 * resume submit it.
 *
 * MEASURED, NOT ASSUMED (2026-09-23). Every applicant system carrying live
 * rows was checked by loading a real posting's apply link in a browser and
 * reading what came back. The rendered page is the only honest test here:
 * most of these are single-page apps whose served HTML is an empty shell, so
 * a fetch-and-grep reads every one of them as having no form at all.
 *
 *   usajobs  hard  /Applicant/... redirects to login.usajobs.gov/Account/Login
 *   workday  hard  the apply flow opens on "step 1 of 6: Create Account/Sign In"
 *   amazon   hard  /applicant/jobs/<id>/apply redirects to passport.amazon.jobs,
 *                  titled "Log in or create account"
 *   yc       hard  "Apply to role" goes to account.ycombinator.com/authenticate
 *                  with signUpActive=true
 *
 *   ashby, greenhouse, teamtailor, breezy, personio, recruitee, jobvite,
 *   lever, workable, rippling, netflix  easy  the apply link renders a form
 *   carrying name, email and a resume file input, and no password field.
 *
 * NETFLIX IS THE REASON THIS WAS MEASURED. It runs its own careers portal, so
 * it read as an account wall by analogy with Amazon. It is not one:
 * explore.jobs.netflix.net/careers/apply?pid=<id> renders the form directly.
 *
 * KEYED ON THE APPLICANT SYSTEM, NOT THE EMPLOYER. The account requirement is
 * a property of the platform's apply flow, which employers on that platform do
 * not configure. Checked against eight distinct employers per platform: no
 * platform split. Where an employer redirects its apply link to a flow of its
 * own the crawl records that posting under a different applicant system, so it
 * is classified by the system it actually lands on.
 *
 * The four walled systems carry 16,463 of 31,310 live rows (52.6%), so this is
 * the difference between half the board and the other half, not a rounding
 * detail.
 */
export const ACCOUNT_WALLED_ATS = Object.freeze([
  // Measured here, 2026-09-23, by loading a real posting's apply link.
  'usajobs',
  'workday',
  'amazon',
  'yc',
  // NOT MEASURED HERE, BECAUSE THEY CARRY NO LIVE ROWS TONIGHT, but already on
  // record in the crawler's own ACCOUNT_GATED_HOSTS (jobmachine sweep.py), which
  // reaches the same verdict from the apply URL's host rather than from the
  // adapter. Their adapters shipped on 2026-09-22 and will bring rows; listing
  // them now means the first night they appear is classified rather than
  // silently defaulted. They move no number today.
  'taleo',
  'icims',
  'successfactors'
]);

/**
 * Every applicant system whose apply flow has actually been checked, by either
 * route. frictionOf defaults anything else to 'easy', which is the honest
 * default for a two-level field but IS a default, so the backfill names any
 * system that is not on this list. A new adapter's first night then shows up as
 * a line in the receipt instead of as a silent 'easy' on a few thousand rows.
 */
export const MEASURED_ATS = Object.freeze([
  'usajobs', 'workday', 'amazon', 'yc', 'taleo', 'icims', 'successfactors',
  'ashby', 'greenhouse', 'lever', 'workable', 'rippling', 'personio',
  'recruitee', 'breezy', 'teamtailor', 'jobvite', 'netflix'
]);

const WALLED = new Set(ACCOUNT_WALLED_ATS);
const MEASURED = new Set(MEASURED_ATS);

/** True when this applicant system's apply flow has been checked. */
export function isMeasuredAts(ats) {
  return MEASURED.has(String(ats || '').toLowerCase());
}

/**
 * 'hard' when the applicant must hold an account with the applicant system
 * before applying, 'easy' when the apply link opens the form itself.
 *
 * An unknown applicant system is 'easy'. That is the honest default: the
 * walled list is the set we have evidence for, and inventing a wall for a
 * system nobody has checked would print a claim the crawl cannot support. A
 * new system joins the list when it is measured, and the backfill moves its
 * rows in one pass.
 */
export function frictionOf(ats) {
  return WALLED.has(String(ats || '').toLowerCase()) ? 'hard' : 'easy';
}

// ---------------------------------------------------------------------------
// Posted pay.
// ---------------------------------------------------------------------------

/**
 * The posted range in thousands, or nulls when the posting printed none.
 *
 * priced is true only when a structured minimum above zero was published. A
 * range parsed out of prose is not a printed range, and an absent range is a
 * gap, never a zero and never a number below a reader's floor.
 *
 * comp_range arrives as the crawl's JSON object ({min, max, currency, ...});
 * max falls back to min so a single posted figure is a range of width zero
 * rather than a null that would drop the row out of every pay view.
 */
export function payOf(compRange) {
  const cr = compRange && typeof compRange === 'object' ? compRange : null;
  const rawMin = cr && typeof cr.min === 'number' ? cr.min : null;
  if (rawMin === null || !(rawMin > 0)) {
    return { priced: false, min_k: null, max_k: null, mid_k: null };
  }
  const rawMax = typeof cr.max === 'number' && cr.max > 0 ? cr.max : rawMin;
  const min_k = Math.round(rawMin / 1000);
  const max_k = Math.round(rawMax / 1000);
  return { priced: true, min_k, max_k, mid_k: Math.round((min_k + max_k) / 2) };
}

// ---------------------------------------------------------------------------
// The one call the writers make.
// ---------------------------------------------------------------------------

/**
 * Every derived field for one crawl row, as the columns db/207 added. The
 * ingest spreads this onto the row it writes; the backfill writes exactly
 * these columns and nothing else.
 *
 * Region reads country first and falls back to location, matching what the
 * page did before: a posting that names a country has stated the stronger
 * fact, and location is often a city with no country on it.
 */
export function derivedFor(row) {
  const pay = payOf(row.comp_range);
  return {
    derived_tier: tierFromTitle(row.title),
    derived_fam: famFromDepartment(row.department),
    derived_region: regionOf(row.country || row.location || ''),
    derived_friction: frictionOf(row.ats),
    priced: pay.priced,
    comp_min_k: pay.min_k,
    comp_max_k: pay.max_k,
    comp_mid_k: pay.mid_k
  };
}
