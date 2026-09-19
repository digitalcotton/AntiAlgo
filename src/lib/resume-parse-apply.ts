/**
 * resume-parse-apply.ts: put a finished resume read straight into the Profile
 * Record.
 *
 * WHY THIS EXISTS (owner decision, 2026-09-19). The upload used to stop at a
 * review screen ("What we read") and wait for a confirm click; a member who
 * uploaded and walked away had a name on file, zero entries, and a blank
 * resume the next time they drafted. The owner wants an upload to land in the
 * record the way it once did: parse, then the roles, links and name simply
 * appear as record rows. So resume-parse-runner.ts calls this the moment a
 * read completes, and clears the working buffer once it has landed.
 *
 * WHAT STILL STANDS BETWEEN THE MODEL AND THE RECORD. The anti-fabrication
 * guard was never the click; it is resume-parse.ts's source check, which drops
 * any value the model returns that does not occur verbatim in the resume text
 * before it can become a proposal. Everything that reaches this file has
 * already passed that check, and each candidate is re-run through
 * validateEntry() here exactly as profile/import.ts's confirm did, so a row
 * that lands is one the hand-entry form would have accepted. A member can
 * still open, edit or delete any row afterwards; what changes is only that
 * they no longer have to say yes first.
 *
 * NEVER THROWS. One bad proposal is counted, not fatal: the others still land.
 * A caller that needs to know whether anything landed reads the counts.
 */
import { validateEntry } from './record';
import { addLink, createEntry, personName, setPersonName } from './record-store';
import { isLinkPlatform, normaliseLinkUrl } from './profile-links';
import { clearParse, getParse } from './resume-parse-store';
import type { ResumeProposals } from './resume-parse';

/**
 * Lands a finished read that is still sitting in the buffer: one that
 * completed before the runner learned to land reads itself, or one whose
 * background apply failed. Called by the profile page before it reads the
 * record and by the draft endpoint before it drafts, so a read never waits
 * behind a click. Returns what landed, or null when nothing was waiting.
 * Never throws: a buffer that cannot be read or cleared is logged and left,
 * and the next call tries again.
 */
export async function landReadyParse(userId: string): Promise<AppliedProposals | null> {
  try {
    const parse = await getParse(userId);
    if (!parse || parse.status !== 'ready' || !parse.outcome) return null;
    const applied = await applyParsedProposals(userId, parse.outcome.proposals);
    console.log(
      `resume-parse-apply: landed a waiting read for user ${userId}: ${applied.created} entries created, ${applied.failed} failed, ${applied.links} links, name ${applied.name ? 'set' : 'kept'}.`
    );
    await clearParse(userId);
    return applied;
  } catch (error) {
    console.error(`resume-parse-apply: could not land the waiting read for user ${userId}.`, error);
    return null;
  }
}

export interface AppliedProposals {
  /** Entries created. */
  readonly created: number;
  /** Proposals that no longer validated or whose write threw; not created. */
  readonly failed: number;
  /** Links added. */
  readonly links: number;
  /** Whether the person's name was set from the parse (only when it was empty). */
  readonly name: boolean;
  /** The prfIds created, in order. */
  readonly createdIds: readonly string[];
}

export async function applyParsedProposals(userId: string, proposals: ResumeProposals): Promise<AppliedProposals> {
  let failed = 0;
  const createdIds: string[] = [];

  for (const proposal of proposals.entries) {
    // Re-validated from scratch, the confirm endpoint's own rule: the buffer
    // is trusted for nothing, and a candidate that no longer validates is not
    // written.
    const result = validateEntry(proposal.candidate);
    if (!result.ok) {
      failed++;
      continue;
    }
    try {
      const stored = await createEntry(userId, result.entry);
      createdIds.push(stored.prfId);
    } catch (error) {
      failed++;
      console.error(`resume-parse-apply: could not create an entry for user ${userId}.`, error);
    }
  }

  let links = 0;
  for (const link of proposals.links) {
    if (!isLinkPlatform(link.platform)) continue;
    const normalised = normaliseLinkUrl(link.url);
    if (!normalised.ok) continue;
    try {
      await addLink(userId, link.platform, normalised.url);
      links++;
    } catch (error) {
      console.error(`resume-parse-apply: could not add a link for user ${userId}.`, error);
    }
  }

  // The name, set ONLY when the profile has none: an upload fills an empty
  // identity but never silently overwrites a name the person chose.
  let name = false;
  if (proposals.name) {
    const first = proposals.name.first.trim();
    const last = proposals.name.last.trim();
    if (first.length > 0 || last.length > 0) {
      try {
        const current = await personName(userId);
        const alreadyNamed = current !== null && (current.firstName.trim().length > 0 || current.lastName.trim().length > 0);
        if (!alreadyNamed) {
          await setPersonName(userId, proposals.name.first, proposals.name.last);
          name = true;
        }
      } catch (error) {
        console.error(`resume-parse-apply: could not set the name for user ${userId}.`, error);
      }
    }
  }

  return { created: createdIds.length, failed, links, name, createdIds };
}
