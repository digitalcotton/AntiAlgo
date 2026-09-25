/**
 * board-jobs.ts: the one adapter from a tracked posting to the site's Job shape.
 *
 * The unified board renders the same rows the design board always has, through
 * the same JobRow and JobTable. Those components read a Job (src/lib/data.ts):
 * a title, a company, a fit, a status, an age, an apply path. A tracker row from
 * the jobs table (db/017, db/018) carries the facts but not that shape, so this
 * turns one into the other, and it is the only place that mapping is written.
 *
 * WHAT IT INVENTS: nothing. A field the tracker did not capture becomes the same
 * honest absence the design rows already use. ease is null, because we did not
 * measure the apply flow, so the row shows its apply link and no fabricated
 * "Easy, 15 min". risk is LOW because the tracker asserts no risk and LOW is the
 * quiet default the Mark does not colour. The fit is read from the row, scored
 * once at ingest by the same rubric keys the design board draws its bars from
 * (scripts/ingest-jobs.mjs computes it; this never rescores).
 *
 * VERIFICATION IS ONE THING, NOT TWO. A tracked row seen in last night's crawl
 * is verified the same way a swept row is: we checked it, it was there. So a
 * row is 'live' unless the record says otherwise, and last_verified is the
 * night the crawl last saw it (last_seen), which is the crawl's clock and not
 * the design sweep's: the two run an hour apart and printing one for the other
 * was the wrong instant on every board row.
 *
 * A ROW THE RECORD NAMES IS CLOSED. Since 2026-09-08 the ingest joins each row
 * to board_kills (the machine's all-time kill archive, both pipelines) and
 * writes status 'killed' with the kill of record. Here that becomes the same
 * 'closed' Job the design /role pages render, with closed_on and closed_reason
 * read straight off the kill, so ClosedHistory and ClosureRecord draw it with
 * no new component. The ghost flag (listed 90 days) is gone: age is never a
 * finding.
 */
import {
  sweptAt,
  type Ease,
  type Fit,
  type Job,
  type PostedYcRole,
  type SourceSystem
} from './data';

/** One row as the board store hands it back: the tracker record plus db/018. */
export interface BoardRow {
  id: string;
  slug: string | null;
  company: string;
  title: string;
  url: string | null;
  location: string | null;
  country: string | null;
  remote: boolean;
  published: Date | string | null;
  ats: string;
  posting_id: string | null;
  department: string | null;
  comp_posted: string | null;
  comp_range: { min: number; max: number | null; currency: string | null; interval: string | null; source: string | null } | null;
  days_up: number | null;
  first_seen: Date | string | null;
  last_seen: Date | string | null;
  fit_total: number;
  fit_components: Partial<Fit> | null;
  source: string | null;
  description: string | null;
  /** 'live', or 'killed' when a published kill names this row's URL (db/031). */
  status: string | null;
  kill_id: string | null;
  /** The kill of record, LEFT JOINed from board_kills; all null on a live row. */
  kill_rule: string | null;
  kill_reason: string | null;
  killed_on: Date | string | null;
  kill_first_published: Date | string | null;
  kill_pipeline: string | null;
}

/**
 * The tracker's own ats key, passed through as the site's SourceSystem.
 *
 * Used to flatten anything outside a hardcoded set to 'custom', which is wrong
 * twice over: it prints the wrong sentence ("Read direct from the company
 * site's board" for a posting that is on Breezy, or iCIMS, or whatever the
 * eighth adapter turns out to be), and it silently mis-files every board the
 * set does not name, with no build-time signal that it happened. Six adapters
 * shipped on 2026-09-22 and hit exactly that: 418 rows, 17% of the board,
 * mislabelled with no test able to catch it because nothing here compared the
 * ats column to the set.
 *
 * So this no longer checks a list. A named board passes through as itself, and
 * sourceLabel/atsLabel in data.ts do the naming (their own SOURCE_LABELS entry,
 * or a title-cased fallback for a board neither list has learned yet). 'custom'
 * is reserved for what it always meant before KNOWN_SOURCES existed: a posting
 * with no ats at all, i.e. genuinely on the employer's own site
 * (src/lib/added-posting.ts:70 relies on that meaning and is untouched here).
 */
function sourceSystemOf(ats: string): SourceSystem {
  const key = (ats || '').trim().toLowerCase();
  return key ? (key as SourceSystem) : 'custom';
}

/** A stored date (Date or string) reduced to a plain YYYY-MM-DD, or null. */
function dateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  const s = value instanceof Date ? value.toISOString() : String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : null;
}

/** A stored instant reduced to an ISO string, or null. */
function instantOf(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The five rubric parts, defaulting a missing component to zero. */
function fitOf(row: BoardRow): Fit {
  const c = row.fit_components ?? {};
  return {
    total: Number.isFinite(row.fit_total) ? row.fit_total : 0,
    title_scope: c.title_scope ?? 0,
    remote_geo: c.remote_geo ?? 0,
    comp: c.comp ?? 0,
    freshness: c.freshness ?? 0,
    apply_friction: c.apply_friction ?? 0
  };
}

/**
 * A tracked posting as a Job. Ease stays null on purpose (see the file header),
 * which JobRow renders as an apply link with no fabricated friction line.
 */
export function boardRowToJob(row: BoardRow): Job {
  const apply = row.url ?? '';
  const ease: Ease | null = null;
  const closed = row.status === 'killed';
  const job: Job = {
    id: row.id,
    slug: row.slug ?? row.id,
    company: row.company,
    title: row.title,
    kind: 'posted',
    prospect: null,
    comp_posted: row.comp_posted,
    // Job.comp_range.max is a number; where the ATS gave a floor and no ceiling
    // the floor stands in, so a single-ended range still sorts and bands.
    comp_range: row.comp_range
      ? {
          min: row.comp_range.min,
          max: row.comp_range.max ?? row.comp_range.min,
          currency: row.comp_range.currency,
          interval: row.comp_range.interval,
          source: row.comp_range.source
        }
      : null,
    published_at: instantOf(row.published),
    location: row.location ?? 'Not stated',
    remote: Boolean(row.remote),
    source_system: sourceSystemOf(row.ats),
    source_url: row.url ?? apply,
    apply_url: apply,
    first_observed: dateOnly(row.first_seen),
    last_verified: dateOnly(row.last_seen) ?? sweptAt(),
    published_date: dateOnly(row.published) ?? dateOnly(row.kill_first_published),
    age_days: null,
    status: closed ? 'closed' : 'live',
    window: null,
    risk: 'LOW',
    ease,
    fit: fitOf(row),
    // The employer's own description when the crawl captured one, rendered
    // verbatim by DescriptionSlot; null draws the honest empty slot.
    description_html: row.description ?? null
  };
  if (closed) {
    const closedOn = dateOnly(row.killed_on);
    if (closedOn) job.closed_on = closedOn;
    if (row.kill_reason) job.closed_reason = row.kill_reason;
  }
  return job;
}

/** The machine that found a board row's kill, for the page that says so. */
export function killPipelineLabel(pipeline: string | null | undefined): string {
  return pipeline === 'crawl' ? 'the wide crawl' : 'the verified sweep';
}

/**
 * A YC role already posted on Work at a Startup, as a board Job.
 *
 * These sit in the main table now, not a section of their own. They are checked
 * every night by the pre-posting pass, so they are verified like any other row.
 * Two differences travel with them: the source is 'yc', so the apply label reads
 * "Apply on Work at a Startup" and the title links out to YC (there is no
 * internal page for a listing we mirror), and the fit is scored here by the same
 * rubric the board uses, from the fields the YC record carries (no posting date,
 * so freshness scores zero). comp_posted keeps YC's own string, which compShort
 * reads for the clean range.
 */
export function ycRoleToJob(role: PostedYcRole): Job {
  const hasComp = role.compPosted ? /\d/.test(role.compPosted) : false;
  const hasLocation = Boolean(role.location);
  const hasApply = Boolean(role.ycUrl);
  const components = {
    title_scope: 30,
    remote_geo: hasLocation ? 25 : 0,
    comp: hasComp ? 20 : 0,
    freshness: 0,
    apply_friction: hasApply ? 10 : 0
  };
  const fit: Fit = {
    total: components.title_scope + components.remote_geo + components.comp + components.freshness + components.apply_friction,
    ...components
  };
  const slug = `yc-${role.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    id: role.id,
    slug,
    company: role.company,
    title: role.title,
    kind: 'posted',
    prospect: null,
    comp_posted: role.compPosted,
    comp_range: null,
    published_at: null,
    location: role.location ?? 'Not stated',
    remote: hasLocation ? /remote/i.test(role.location as string) : false,
    source_system: 'yc',
    source_url: role.ycUrl ?? '',
    apply_url: role.ycUrl ?? '',
    first_observed: null,
    last_verified: sweptAt(),
    published_date: null,
    age_days: null,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: null,
    fit,
    // A posted YC role is an actual job, so it carries its actual description
    // once the export reads one. Null until then, and the slot says so.
    description_html: role.descriptionHtml ?? null
  };
}
