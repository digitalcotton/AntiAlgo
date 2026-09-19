/**
 * resume-grouping.ts: fold a wall of near-identical credentials into one line,
 * for display only.
 *
 * THE PROBLEM. A person can hold a dozen certifications from the same body
 * (eight flavours of Scrum from one institute, say). Each is a real record
 * entry, so the resume renders each as its own title/employer/date block, and a
 * Recognition section becomes a wall that buries the substance above it. The
 * two-page word cap (tailor.ts) cannot help: it trims BULLETS, and these
 * entries have none to trim.
 *
 * THE FOLD, AND WHAT IT DOES NOT TOUCH. This is a PRESENTATION transform, run
 * by the two renderers (DraftDocuments.astro on screen, pdf-resume.ts in the
 * download) over a section's already-built RenderEntry list. It changes NOTHING
 * in the render data: every entry, every byte-identical immutable core, and the
 * provenance footer's counts are exactly as tailor.ts built them, so the
 * "every line traces to the record" promise stays literally true and the
 * fabrication gate sees an unchanged render. A folded group still cites every
 * one of its entries' PRF ids, and every folded title survives verbatim in the
 * joined line, so the parse-proof gate's "each title is an unbroken run" holds.
 *
 * WHAT FOLDS. Only the Recognition section, and within it only THIN entries
 * (no real detail to lose) that share one ISSUER, and only when at least three
 * of them do. The issuer is not always the employer column: a certification
 * commonly leaves employer_or_institution null and names the issuing body in
 * its description, which renders as the entry's single bullet (db/004 makes the
 * employer mandatory only for role_held and education). So the issuer is read
 * from the employer field when it is set, else from the lone bullet. A
 * substantive recognition entry, or a lone credential, is left exactly as it
 * was. Roles, education, projects, and skills never fold.
 */
import type { RenderEntry, RenderSection } from './tailor';
import type { EntryDate } from './record';

/** At least this many same-issuer thin entries before a wall is worth folding.
    Two is not a wall. */
const MIN_GROUP = 3;

/** A recognition entry with no more than this many bullet words carries no real
    detail to lose in the fold: its title and issuer are its content. */
const THIN_MAX_BULLET_WORDS = 8;

export interface ResumeGroup {
  /** The shared issuing body, the fold's heading (from the employer field, or
      the lone bullet when employer is null). */
  readonly issuer: string;
  /** Each folded entry's official title, in the section's display order. */
  readonly titles: readonly string[];
  /** Every folded entry's PRF id, so the group still cites all of them. */
  readonly prfIds: readonly string[];
  /** The earliest start across the folded entries that have one; null when
      none does (an undated credential, db/204, carries no start to fold). */
  readonly start: EntryDate | null;
  /** null if any folded entry is ongoing, else the latest end. */
  readonly end: EntryDate | null;
}

export type ResumeRow =
  | { readonly kind: 'entry'; readonly entry: RenderEntry }
  | { readonly kind: 'group'; readonly group: ResumeGroup };

function bulletWordCount(entry: RenderEntry): number {
  return entry.bullets.reduce((sum, bullet) => sum + bullet.text.trim().split(/\s+/).filter(Boolean).length, 0);
}

function isThin(entry: RenderEntry): boolean {
  return bulletWordCount(entry) <= THIN_MAX_BULLET_WORDS;
}

/** The issuing body a recognition entry belongs to: its employer when set,
    otherwise its single bullet (where a certification's issuer lives when the
    employer field is null). null when neither gives a stable key. */
function issuerOf(entry: RenderEntry): string | null {
  // Strip a trailing sentence mark either way, so a record mid-migration (some
  // issuers in the employer field, some still the renderer-punctuated bullet)
  // keys "International Scrum Institute" and "International Scrum Institute."
  // to the same group rather than splitting one wall in two.
  const employer = entry.core.employerOrInstitution;
  if (employer && employer.trim().length > 0) {
    return employer.trim().replace(/[.,;:]+$/, '').trim() || null;
  }
  if (entry.bullets.length === 1) {
    const text = entry.bullets[0].text.trim().replace(/[.,;:]+$/, '').trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function monthIndex(date: EntryDate): number {
  return date.year * 12 + (date.month ?? 1);
}

/**
 * A section as a list of render rows: each is a single entry, unchanged, or a
 * fold of same-issuer thin credentials. Every section but Recognition, and
 * every entry that does not qualify, passes straight through as a single row,
 * so a caller can render each row with no special case beyond the two shapes.
 */
export function groupResumeSection(section: RenderSection): readonly ResumeRow[] {
  if (section.kind !== 'recognition') {
    return section.entries.map((entry) => ({ kind: 'entry', entry }));
  }

  // Which issuers have enough thin entries to be worth folding.
  const thinByIssuer = new Map<string, number>();
  for (const entry of section.entries) {
    const issuer = isThin(entry) ? issuerOf(entry) : null;
    if (issuer) thinByIssuer.set(issuer, (thinByIssuer.get(issuer) ?? 0) + 1);
  }
  const foldable = new Set([...thinByIssuer].filter(([, count]) => count >= MIN_GROUP).map(([issuer]) => issuer));

  const rows: ResumeRow[] = [];
  const foldedIssuers = new Set<string>();
  for (const entry of section.entries) {
    const issuer = isThin(entry) ? issuerOf(entry) : null;
    if (!issuer || !foldable.has(issuer)) {
      rows.push({ kind: 'entry', entry });
      continue;
    }
    // First thin member of a foldable issuer emits the group, in place; the
    // rest are folded into it and skipped.
    if (foldedIssuers.has(issuer)) continue;
    foldedIssuers.add(issuer);
    const members = section.entries.filter((candidate) => isThin(candidate) && issuerOf(candidate) === issuer);
    const dated = members.map((member) => member.core.start).filter((date): date is EntryDate => date !== null);
    const start =
      dated.length === 0
        ? null
        : dated.reduce((earliest, next) => (monthIndex(next) < monthIndex(earliest) ? next : earliest));
    const ends = members.map((member) => member.core.end);
    const end = ends.some((value) => value === null)
      ? null
      : (ends as EntryDate[]).reduce((latest, next) => (monthIndex(next) > monthIndex(latest) ? next : latest));
    rows.push({
      kind: 'group',
      group: {
        issuer,
        titles: members.map((member) => member.core.officialTitle),
        prfIds: members.map((member) => member.prfId),
        start,
        end
      }
    });
  }
  return rows;
}
