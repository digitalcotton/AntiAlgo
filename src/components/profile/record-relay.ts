/**
 * What a failed submission carries back, and how a page rebuilds a form from
 * it. Shared by every page that renders the Profile Record's forms.
 *
 * WHY THIS IS ITS OWN MODULE. profile/entry.ts and profile/artifact.ts answer
 * a native form POST with a 303, and a redirect carries no body, so a
 * validation failure has to survive the trip in a short-lived, httpOnly
 * cookie. Reading that cookie back is not one line: it is a parse that must
 * treat a tampered or truncated value as absent rather than throwing, plus
 * three form-state builders that decide, per form, whether to show what the
 * person just typed or what is actually stored.
 *
 * ALL OF IT LIVED IN src/pages/account/record.astro WHILE THAT PAGE, AND A
 * SEPARATE src/pages/account/profile.astro, BOTH CARRIED THESE FORMS. The two
 * pages have since merged into the single src/pages/profile.astro, which is
 * the only caller left, but the module stays separate rather than folding
 * back into that page's own frontmatter: a relay this specific belongs next
 * to the components whose state it rebuilds, not inside the page that
 * happens to be the one caller today.
 *
 * THE COOKIE IS PATH-SCOPED BY THE ENDPOINT, NOT BY THIS FILE. entry.ts and
 * artifact.ts scope it to whichever page posted (see RETURN_PATHS there), so
 * a page reads it at its own address and deletes it at that same address:
 * the page itself calls Astro.cookies.delete() with that path, immediately
 * after handing the raw cookie value to parseRelay() below. Keeping the
 * delete call in the page rather than in this module is what keeps the
 * page from forgetting it: a relay left undeleted at the wrong path stays
 * set, and the next visit to that page shows a stale validation error over
 * values the person never typed.
 */

import type { ValidationIssue } from '../../lib/record';
import type { StoredEntry } from '../../lib/record-store';
import type { EntryFormValues } from './entry-presentation';

export const RELAY_COOKIE = 'record_form_relay';

export interface EntryRelay {
  scope: 'entry';
  intent: 'create' | 'update';
  prfId: string | null;
  fields: Record<string, string>;
  issues: ValidationIssue[];
}

export interface ArtifactRelay {
  scope: 'artifact';
  intent: 'add';
  prfId: string;
  fields: Record<string, string>;
  issues: ValidationIssue[];
}

export type Relay = EntryRelay | ArtifactRelay;

export function parseRelay(raw: string | undefined): Relay | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Relay>;
    if (parsed.scope === 'entry' || parsed.scope === 'artifact') {
      return parsed as Relay;
    }
    return null;
  } catch {
    // A cookie that fails to parse is treated as absent, never as a thrown
    // error: it can only mean the cookie was tampered with or truncated,
    // and either way there is nothing here for a page to recover.
    return null;
  }
}

export function blankValues(): EntryFormValues {
  return {
    kind: '',
    employerOrInstitution: '',
    officialTitle: '',
    startYear: '',
    startMonth: '',
    stillHere: false,
    endYear: '',
    endMonth: '',
    location: '',
    description: '',
    classification: 'private'
  };
}

export function valuesFromEntry(entry: StoredEntry): EntryFormValues {
  return {
    kind: entry.kind,
    employerOrInstitution: entry.employerOrInstitution ?? '',
    officialTitle: entry.officialTitle,
    startYear: String(entry.start.year),
    startMonth: entry.start.month === null ? '' : String(entry.start.month),
    stillHere: entry.end === null,
    endYear: entry.end === null ? '' : String(entry.end.year),
    endMonth: entry.end?.month == null ? '' : String(entry.end.month),
    location: entry.location ?? '',
    description: entry.description,
    classification: entry.classification
  };
}

export function valuesFromFields(fields: Record<string, string>): EntryFormValues {
  return {
    kind: fields.kind ?? '',
    employerOrInstitution: fields.employerOrInstitution ?? '',
    officialTitle: fields.officialTitle ?? '',
    startYear: fields.startYear ?? '',
    startMonth: fields.startMonth ?? '',
    stillHere: fields.stillHere === 'on',
    endYear: fields.endYear ?? '',
    endMonth: fields.endMonth ?? '',
    location: fields.location ?? '',
    description: fields.description ?? '',
    classification: fields.classification ?? 'private'
  };
}

/** Values plus issues for the add-entry form: relayed values on a failed
    create, blank otherwise. */
export function addFormState(relay: Relay | null): { values: EntryFormValues; issues: ValidationIssue[] } {
  if (relay && relay.scope === 'entry' && relay.intent === 'create' && relay.prfId === null) {
    return { values: valuesFromFields(relay.fields), issues: relay.issues };
  }
  return { values: blankValues(), issues: [] };
}

/** Values plus issues for one entry's edit form: relayed values on a failed
    update to that same entry, its own current values otherwise. */
export function editFormState(
  relay: Relay | null,
  entry: StoredEntry
): { values: EntryFormValues; issues: ValidationIssue[] } {
  if (relay && relay.scope === 'entry' && relay.intent === 'update' && relay.prfId === entry.prfId) {
    return { values: valuesFromFields(relay.fields), issues: relay.issues };
  }
  return { values: valuesFromEntry(entry), issues: [] };
}

/** The add-artifact form state for one entry: relayed values on a failed add
    to that entry, blank otherwise. */
export function artifactFormState(
  relay: Relay | null,
  entry: StoredEntry
): { kind: string; url: string; label: string; issues: ValidationIssue[] } {
  if (relay && relay.scope === 'artifact' && relay.prfId === entry.prfId) {
    return {
      kind: relay.fields.kind ?? '',
      url: relay.fields.url ?? '',
      label: relay.fields.label ?? '',
      issues: relay.issues
    };
  }
  return { kind: '', url: '', label: '', issues: [] };
}
