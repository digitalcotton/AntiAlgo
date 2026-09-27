/**
 * job-draft-wire.ts: the one place that reads the job draft's wire status.
 *
 * WHY THIS EXISTS. src/lib/resume-parse-wire.test.ts holds a repo-wide census:
 * no .astro client script may compare a wire status to a string literal,
 * because a surface that stops on a list of SUCCESS values hangs forever the
 * day the server invents a fourth status. That census caught the draft room's
 * poll when it was added (docs/draft-loading-spec.md), and its own comment
 * names the remedy — "give it its own wire module" — which is this file.
 *
 * DraftRail.astro speaks the same endpoint and is the census's one recorded
 * exception, with its own local copy of the predicate below. This module does
 * not delete that line or touch DraftRail; it keeps the NEXT surface from
 * becoming a third copy.
 *
 * THE RULE THE PREDICATE ENCODES. A wait ends on NOT-pending, never on a list
 * of endings. 'ready' and 'failed' are both terminal today; a status invented
 * tomorrow is terminal too, and a poll built on this stops correctly for it
 * instead of stranding somebody on a shimmer that never resolves.
 */

/** The shape the status endpoint returns, read defensively: this crosses the
    wire, so every field is unknown until proven otherwise. */
export interface JobDraftWireState {
  readonly status?: unknown;
}

/** The one status that means "keep waiting". Everything else, including a
    status this build has never heard of, ends the wait. */
const PENDING = 'pending';

export function stillPending(state: JobDraftWireState | null | undefined): boolean {
  return typeof state?.status === 'string' && state.status === PENDING;
}

/**
 * Whether a poll should stop and redraw.
 *
 * A body that could not be read at all is NOT terminal: a dropped request says
 * nothing about the draft, which is still running on the server whether or not
 * this tab can reach it. Only a state that parsed and is not pending ends it.
 */
export function pollEnds(state: JobDraftWireState | null | undefined): boolean {
  if (!state || typeof state.status !== 'string') return false;
  return !stillPending(state);
}
