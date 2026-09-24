/**
 * The ratchet, as a function every gate can ask.
 *
 * A gate calls `partition(gateName, findings)` with the findings it produced, each
 * carrying a stable `id`, and gets back three lists:
 *
 *   fresh     not in accepted.json. These are what the gate FAILS on.
 *   accepted  in accepted.json, still reproducing. Printed, never fatal.
 *   stale     in accepted.json for this gate and NOT reproducing any more.
 *
 * `stale` is the half that keeps this honest. A ratchet with no upward pressure is
 * just a list of things nobody will ever fix again, so a gate reports a stale entry
 * loudly and tells the owner to delete the line. Deleting it is the only way the
 * list shrinks, and shrinking is the point.
 *
 * IDS MUST BE STABLE. An id with a line number in it changes when the file above it
 * changes, and then an accepted finding reappears as fresh and the gate goes red for
 * no reason — which is how a gate loses its reader. Prefer file + the thing's own
 * name (a selector, a token, a check id) and include a line number only when there
 * is nothing else to identify it by.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, 'accepted.json');

/** Every accepted finding, or an empty list if the file is missing.
 *
 *  A missing ratchet must NOT silently make every gate green — that would be the
 *  worst possible failure of this module — so it returns nothing accepted, which
 *  makes every finding fresh and every gate red. Loud, and the right direction. */
export function acceptedFindings() {
  let raw;
  try {
    raw = readFileSync(PATH, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch (error) {
    // A malformed ratchet is a broken instrument, not an empty one. Say so.
    throw new Error(
      `test/conform/accepted.json is not valid JSON (${error.message}). ` +
        'Every gate reads it, so nothing can be trusted until it parses.'
    );
  }
}

/**
 * Split this gate's findings against the ratchet.
 *
 * @param {string} gate     the gate's name, matching the `gate` field in accepted.json
 * @param {Array<{id: string} & Record<string, unknown>>} findings  what the gate found now
 */
export function partition(gate, findings) {
  const mine = acceptedFindings().filter((entry) => entry.gate === gate);
  const acceptedIds = new Set(mine.map((entry) => entry.id));
  const foundIds = new Set(findings.map((finding) => finding.id));

  return {
    fresh: findings.filter((finding) => !acceptedIds.has(finding.id)),
    accepted: findings
      .filter((finding) => acceptedIds.has(finding.id))
      .map((finding) => ({ ...finding, entry: mine.find((entry) => entry.id === finding.id) })),
    stale: mine.filter((entry) => !foundIds.has(entry.id))
  };
}

/** The lines a gate prints about its accepted and stale findings, so all of them
 *  say it the same way and a reader learns one format. */
export function report({ accepted, stale }, { log = console.log } = {}) {
  if (accepted.length) {
    log(`\n  ${accepted.length} known finding${accepted.length === 1 ? '' : 's'}, accepted in test/conform/accepted.json:`);
    for (const finding of accepted) {
      const entry = finding.entry ?? {};
      const verdict = entry.verdict ?? 'accepted';
      log(`    [${verdict}] ${finding.id}`);
      if (entry.review && entry.review !== 'never') log(`        review by ${entry.review}`);
      if (entry.owner_question) log(`        needs your decision: ${entry.owner_question}`);
    }
  }
  if (stale.length) {
    log(`\n  ${stale.length} accepted finding${stale.length === 1 ? '' : 's'} NO LONGER REPRODUCE. Delete these lines from test/conform/accepted.json:`);
    for (const entry of stale) log(`    ${entry.id}`);
    log('    (An accepted entry that no longer happens is how a ratchet rots into an excuse.)');
  }
}
