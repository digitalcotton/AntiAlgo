/**
 * cover-letter.ts: the engine side of a cover letter, the counterpart of the
 * bullet machinery in tailor.ts.
 *
 * WHAT THIS FILE OWNS. Given entries tailor.ts already SELECTED (the proof
 * entry, the fit entry, and a few supporting skills, chosen by tailor's own
 * relevanceScore), this file LOCKS them into a LockedLetter: one core sentence
 * plus description lines per evidence paragraph, the person's reason, and the
 * engine-selected target strings. After a provider styles that lock into four
 * paragraph strings, this file MINTS them into branded LetterParagraphs whose
 * provenance is computed from the lock, never from the provider's output, the
 * exact discipline createBullet() keeps in tailor.ts.
 *
 * WHY SELECTION LIVES IN tailor.ts, NOT HERE. relevanceScore() and the target
 * vocabulary are tailor.ts's, and this file imports only record.ts, provider.ts
 * and entry-dates.ts, so there is no import cycle: tailor.ts hands this file the
 * entries it chose, and this file never reaches back for a Job or a score.
 *
 * MASTER-SPEC 3.3 HOLDS THE SAME WAY IT DOES FOR A BULLET. A paragraph's
 * fragments come only from ProfileEntry fields (a core sentence built by
 * template interpolation of the immutable core, then description lines); the
 * provider never receives the immutable core itself, only the sentence; and the
 * PRF ids a paragraph cites travel with the slot INTO the provider and are read
 * back off the lock, never off the provider's return value. The one thing a
 * cover letter carries that a resume does not, the employer's requirement lines
 * and the person's reason, are enforced by the verifier (letter-verify.ts), not
 * by this file's shape: here they are simply strings the lock carries.
 */

import { coreOf, type ProfileEntry } from './record';
import { dateRange } from './entry-dates';
import {
  LETTER_ROLES,
  deterministicLetter,
  type LetterRole,
  type LetterStyleResult,
  type LetterTarget,
  type LockedLetter,
  type LockedLetterSlot
} from './provider';
import type { ProvenanceSummary } from './tailor';
import type { CoverPack } from './cover-context';

// Re-exported so callers and tests read the deterministic letter from the
// cover-letter module, its conceptual home, though it is defined in provider.ts
// (beside deterministicProvider, which falls back to it) to keep this file free
// of any runtime dependency on that provider.
export { deterministicLetter };

/* -------------------------------------------------------------------------
   Selection, as tailor.ts hands it over.
   ------------------------------------------------------------------------- */

/**
 * The entries tailor.ts chose for a letter. `proof` is the strongest evidence
 * entry, `fit` the next distinct one, `skills` up to a few skill entries that
 * share vocabulary with the posting and ride on the fit paragraph. Any of them
 * may be null/empty for a thin record; lockLetter() still returns all four
 * slots so the model always sees four roles and the verifier can prove an
 * evidence-less paragraph adds nothing.
 */
export interface LetterSelection {
  readonly proof: ProfileEntry | null;
  readonly fit: ProfileEntry | null;
  readonly skills: readonly ProfileEntry[];
}

/* -------------------------------------------------------------------------
   The core sentence: the immutable core as one line of prose.
   ------------------------------------------------------------------------- */

/**
 * "Staff Designer at Acme, March 2021 to Present", or "Staff Designer, March
 * 2021 to Present" when the entry names no organization. Template interpolation
 * of the immutable core only: officialTitle and employerOrInstitution appear
 * verbatim with no call chained onto either (gate 8), and the dates come from
 * dateRange(coreOf(entry)), the same rule the resume's meta line uses.
 */
export function coreSentence(entry: ProfileEntry): string {
  const range = dateRange(coreOf(entry));
  return entry.employerOrInstitution
    ? `${entry.officialTitle} at ${entry.employerOrInstitution}, ${range}`
    : `${entry.officialTitle}, ${range}`;
}

/** An entry's description as trimmed, non-empty lines. Reads entry.description
    (free text, not core) only, the same split fragmentsFor() uses in tailor.ts
    for a non-skill bullet. */
function descriptionLines(entry: ProfileEntry): readonly string[] {
  return entry.description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/* -------------------------------------------------------------------------
   Locking: selection to LockedLetter.
   ------------------------------------------------------------------------- */

export function lockLetter(
  selection: LetterSelection,
  target: LetterTarget,
  reason: string | null,
  recordAllowlist?: string,
  pack?: CoverPack
): LockedLetter {
  return {
    document: 'cover_letter',
    slots: [
      { role: 'opener', sourcePrfIds: [], fragments: [] },
      proofSlot(selection.proof),
      fitSlot(selection.fit, selection.skills),
      { role: 'close', sourcePrfIds: [], fragments: [] }
    ],
    target,
    reason,
    // The whole record, for the verifier's fact allowlist only (never sent to a
    // model). See LockedLetter.recordAllowlist in provider.ts.
    ...(recordAllowlist ? { recordAllowlist } : {}),
    // The context pack (field x situation): prompt guidance and word bounds.
    // See LockedLetter.pack in provider.ts.
    ...(pack ? { pack } : {})
  };
}

/** The whole record as one plain-text block, for the verifier's fact allowlist:
    every entry's title, employer, and description. This is the person's own
    data; it is read by letter-verify.ts to tell a real record fact from a
    fabrication, and never reaches a model. */
export function recordAllowlistText(entries: readonly ProfileEntry[]): string {
  return entries
    .map((e) => [e.officialTitle, e.employerOrInstitution ?? '', e.description].join(' '))
    .join(' ');
}

function proofSlot(proof: ProfileEntry | null): LockedLetterSlot {
  if (!proof) return { role: 'proof', sourcePrfIds: [], fragments: [] };
  return {
    role: 'proof',
    sourcePrfIds: [proof.prfId],
    fragments: [coreSentence(proof), ...descriptionLines(proof)]
  };
}

function fitSlot(fit: ProfileEntry | null, skills: readonly ProfileEntry[]): LockedLetterSlot {
  // Skills ride on the fit paragraph and only when there IS a fit entry to
  // anchor them; with no fit entry the slot is empty (empty fragments and no
  // ids), so the verifier can prove the paragraph carries no fact.
  if (!fit) return { role: 'fit', sourcePrfIds: [], fragments: [] };
  return {
    role: 'fit',
    sourcePrfIds: [fit.prfId, ...skills.map((s) => s.prfId)],
    fragments: [coreSentence(fit), ...descriptionLines(fit), ...skills.map((s) => s.officialTitle)]
  };
}

/* -------------------------------------------------------------------------
   Paragraphs: not constructible without resolving their source ids.
   The LetterParagraph counterpart of Bullet/createBullet in tailor.ts.
   ------------------------------------------------------------------------- */

const PARAGRAPH_BRAND: unique symbol = Symbol('cover-letter.LetterParagraph');

/**
 * One rendered paragraph. Like Bullet, it cannot be built outside this module:
 * PARAGRAPH_BRAND is not exported, so no other file can write a value
 * structurally assignable to this type, and createParagraph() is the only
 * producer. Unlike Bullet, sourcePrfIds may be empty (the opener and close cite
 * no record fact); createParagraph() enforces that proof and fit, which do,
 * carry a non-empty list.
 */
export interface LetterParagraph {
  readonly role: LetterRole;
  readonly text: string;
  readonly sourcePrfIds: readonly string[];
  readonly [PARAGRAPH_BRAND]: true;
}

/**
 * The only way to build a LetterParagraph. Throws, rather than returning a
 * result type, on two conditions that are both bugs in this file and never
 * reachable from a person's own input: a proof or fit paragraph with no source
 * ids, and any id that does not resolve in the record being rendered. Same
 * reasoning as createBullet() in tailor.ts.
 */
export function createParagraph(
  role: LetterRole,
  text: string,
  sourcePrfIds: readonly string[],
  knownPrfIds: ReadonlySet<string>
): LetterParagraph {
  if ((role === 'proof' || role === 'fit') && sourcePrfIds.length === 0) {
    throw new Error(
      `cover-letter: a ${role} paragraph was minted with no source PRF ids. ` +
        'A proof or fit paragraph asserts record evidence and must cite at least one entry. ' +
        'This is a bug in cover-letter.ts, not something a person did.'
    );
  }
  for (const id of sourcePrfIds) {
    if (!knownPrfIds.has(id)) {
      throw new Error(
        `cover-letter: a paragraph cited PRF id "${id}", which is not in the record it was rendered from. ` +
          'This is a bug in cover-letter.ts (a slot was built with an id that does not belong to the ' +
          'record being rendered), not something a person did.'
      );
    }
  }
  return { role, text, sourcePrfIds, [PARAGRAPH_BRAND]: true };
}

/**
 * Turn a provider's four styled strings into branded paragraphs. Empty roles
 * are skipped (a provider that said nothing for a role, and the deterministic
 * letter's empty proof/fit on a thin record, produce no paragraph), and a
 * proof or fit role whose slot cites nothing is skipped too rather than minted,
 * so createParagraph()'s throw stays a pure invariant check. Each surviving
 * paragraph takes its source ids straight off the lock, never off the styled
 * result: a provider cannot rewrite which entries a paragraph cites.
 */
export function buildLetterParagraphs(
  result: LetterStyleResult,
  locked: LockedLetter,
  knownPrfIds: ReadonlySet<string>
): readonly LetterParagraph[] {
  const slotByRole = new Map(locked.slots.map((slot) => [slot.role, slot] as const));
  const paragraphs: LetterParagraph[] = [];
  for (const role of LETTER_ROLES) {
    const text = result[role];
    if (!text || text.trim().length === 0) continue;
    const slot = slotByRole.get(role);
    const sourcePrfIds = slot ? slot.sourcePrfIds : [];
    if ((role === 'proof' || role === 'fit') && sourcePrfIds.length === 0) continue;
    paragraphs.push(createParagraph(role, text, sourcePrfIds, knownPrfIds));
  }
  return paragraphs;
}

/** The receipts footer for a letter, computed the same way tailor.ts computes
    it for a resume: every PRF id a fact-bearing paragraph cites, deduped and
    sorted, and the count of fact-bearing paragraphs. Opener and close cite
    nothing, so they add neither an id nor to the count. */
export function summarizeLetterProvenance(paragraphs: readonly LetterParagraph[]): ProvenanceSummary {
  const cited = new Set<string>();
  let bulletCount = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.sourcePrfIds.length === 0) continue;
    bulletCount++;
    for (const id of paragraph.sourcePrfIds) cited.add(id);
  }
  return { citedPrfIds: [...cited].sort(), bulletCount };
}
