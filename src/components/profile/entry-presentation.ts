/**
 * How a Profile Record entry is worded, kept out of the markup that draws it.
 *
 * WHY THIS IS A .ts FILE AND NOT THE TOP OF EntryCard.astro. These constants
 * and helpers lived in that component's frontmatter and were exported from
 * it. Astro's build refused the file outright: hoisting a multi-line
 * `export const ... as const` out of frontmatter left the `as const` tail
 * behind, and esbuild stopped at "Expected ; but found const". The build
 * failed, every time, in a way no test caught, because the test harness in
 * use at the time compiled the component by hand instead of through the
 * pipeline the build uses. Frontmatter is not a general purpose module and
 * must not be asked to be one.
 *
 * The split is the same one the component's own header argued for and is
 * unchanged by the move: record.ts decides the shape of an entry and
 * record-store.ts persists it, and neither renders a word of English. This
 * file holds the English. EntryCard.astro draws it, profile.astro's own
 * forms (the add-entry form, the resume import review screen) read the same
 * maps from here, and there is still exactly one copy.
 */

import type {
  ArtifactKind,
  Classification,
  EntryKind,
  ValidationIssue
} from '../../lib/record';
import type { StoredEntry } from '../../lib/record-store';

export const KIND_LABELS: Record<EntryKind, string> = {
  role_held: 'Role held',
  education: 'Education',
  project: 'Project',
  skill: 'Skill',
  artifact: 'Artifact',
  recognition: 'Recognition'
};

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  live_url: 'Live URL',
  repo: 'Repository',
  case_study: 'Case study',
  file: 'File'
};

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Private'
};

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
] as const;

export function formatDate(year: number, month: number | null): string {
  return month === null ? String(year) : `${MONTH_NAMES[month - 1]} ${year}`;
}

export function formatRange(entry: Pick<StoredEntry, 'start' | 'end'>): string {
  const start = formatDate(entry.start.year, entry.start.month);
  const end = entry.end === null ? 'Present' : formatDate(entry.end.year, entry.end.month);
  return `${start} to ${end}`;
}

export function issueMessage(issues: readonly ValidationIssue[], field: string): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

/** The add/edit form's field values, in string form: the shape a native form
    posts, before validateEntry() ever sees it. Same shape record.astro's own
    EntryFormValues used. */
export interface EntryFormValues {
  kind: string;
  employerOrInstitution: string;
  officialTitle: string;
  startYear: string;
  startMonth: string;
  stillHere: boolean;
  endYear: string;
  endMonth: string;
  location: string;
  description: string;
  classification: string;
}

/** Everything an editable entry needs beyond the entry itself: the edit
    form's live state, the add-artifact form's live state, and the three
    action paths every form here posts to. Absent entirely on a non-editable
    render, which is what keeps this component's forms from existing at all
    outside a page that legitimately owns this record. */
export interface EntryEditState {
  isEditing: boolean;
  values: EntryFormValues;
  issues: ValidationIssue[];
  artifact: { kind: string; url: string; label: string; issues: ValidationIssue[] };
  /** Which page the person is editing from, as a key rather than a path.
      The endpoints map it to an address through a closed list of their own;
      a caller cannot hand them somewhere to redirect to, which is the whole
      difference between returning a reader to the page they were on and an
      open redirect. See RETURN_PATHS in src/pages/profile/entry.ts. One
      page renders these forms now, so this key has exactly one legal
      value; it stays a key, not the inlined path, so a second surface could
      add one without touching every caller. */
  returnKey: 'profile';
  recordPagePath: string;
  entryAction: string;
  artifactActionPath: string;
}
