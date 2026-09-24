import { readFileSync } from 'node:fs';

/**
 * The ratchet, for browser specs.
 *
 * test/conform/accepted.mjs already does this for the node gates. A Playwright spec
 * cannot use it directly and shouldn't need a second copy of the policy, so this is
 * the thin read-side: same file, same ids, same rule — a finding already shown to the
 * owner is REPORTED, not fatal; anything else fails.
 *
 * WHY A BROWSER SPEC NEEDS IT AT ALL. The first full deep run went red on
 * `/evidence keeps every label inside its container` — a real, pre-existing mobile
 * defect (a duration bar's label paints ~2.45px below its own fixed-height bar) whose
 * fix is a design decision on a published figure, not a repair. That is exactly the
 * shape the ratchet exists for: without it the browser tier is red from the day it is
 * built, and a gate that is red on arrival is one nobody runs. This project has
 * already lost two instruments that way.
 *
 * THE HALF THAT KEEPS IT HONEST is in accepted.mjs and applies here too: an accepted
 * finding that stops reproducing must be deleted from the file. A spec using this
 * helper still passes when the defect is fixed — the node gates are what notice the
 * stale line, on the next `npm run conform`. So the list cannot quietly accumulate.
 */

interface Finding {
  id: string;
  gate: string;
  verdict: string;
  why: string;
  accepted?: string;
  owner_question?: string;
  review?: string;
}

const PATH = new URL('../conform/accepted.json', import.meta.url);

function findings(): Finding[] {
  try {
    const parsed = JSON.parse(readFileSync(PATH, 'utf8')) as { findings?: Finding[] };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    // A missing or malformed ratchet must NOT make a spec lenient. Returning nothing
    // accepted means every finding is fresh and every spec fails loudly, which is the
    // safe direction.
    return [];
  }
}

/** The recorded entry for this finding, or null if it has never been accepted. */
export function acceptedFinding(id: string): Finding | null {
  return findings().find((finding) => finding.id === id) ?? null;
}

/**
 * Report a finding the owner has already seen, instead of failing on it.
 *
 * Returns true when the finding is accepted (the caller should not assert), false
 * when it is not (the caller must assert and fail). Attaches the verdict and the
 * owner's outstanding question to the Playwright report, so a green run still SHOWS
 * the defect rather than hiding it — the point is that it is known, not that it is
 * acceptable.
 */
export interface Annotation {
  type: string;
  description: string;
}

export function reportIfAccepted(
  id: string,
  detail: string,
  annotate: (annotation: Annotation) => void
): boolean {
  const entry = acceptedFinding(id);
  if (!entry) return false;

  annotate({
    type: `accepted:${entry.verdict}`,
    description:
      `${id}\n${detail}\n\nAccepted ${entry.accepted ?? 'previously'} in test/conform/accepted.json: ${entry.why}` +
      (entry.owner_question ? `\n\nNeeds a decision: ${entry.owner_question}` : '') +
      (entry.review && entry.review !== 'never' ? `\nReview by ${entry.review}.` : '')
  });
  return true;
}
