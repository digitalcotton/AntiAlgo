/**
 * defer-work.ts: run work past the end of the request, on a platform that is
 * allowed to kill you the moment you answer.
 *
 * THE LANDMINE THIS DEFUSES. Two routes on this site answer immediately and
 * finish their real work afterwards: the resume read (profile/import/parse
 * 303s to the review while the model reads) and the job draft (desk/job-draft
 * 303s to the draft room while the documents render). Both were fired with a
 * bare `void promise`, which works in a long-lived Node process and is a coin
 * flip on Vercel serverless: once the response is returned, the platform may
 * freeze the function before the fetch to the provider ever resolves. The
 * symptom is a row stuck 'pending' forever and a person watching a wait state
 * that will never end, intermittently, only in production, depending on how
 * fast the provider answers relative to the freeze.
 *
 * waitUntil() is the platform's own primitive for exactly this: it keeps the
 * function alive until the handed-in promise settles (bounded by the
 * function's maxDuration, set in astro.config.mjs). Local dev and vitest have
 * no such runtime, and @vercel/functions' waitUntil quietly no-ops where the
 * platform context is absent, but this wrapper still guards the call and
 * falls back to the plain fire, so a change in that behaviour can never turn
 * "defer some work" into a thrown error on a dev machine.
 *
 * THE CALLER STILL OWNS ITS FAILURES. This catches nothing about the work
 * itself; hand in a promise that already has its own .catch guard, exactly as
 * both call sites always did. A rejection escaping the work is the caller's
 * bug, not this seam's.
 */
import { waitUntil } from '@vercel/functions';

/** Keep `work` running after the response goes out. Never throws. */
export function deferWork(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    // No platform context (local dev, tests) or a runtime that refuses the
    // call: the plain fire is the old behaviour and the right fallback.
    void work;
  }
}
