/**
 * ledger-titles.ts: the Ledger's title matcher, the one place a watched title
 * is turned into a set of board roles. Pure: strings in, a decision out, no I/O
 * and no clock, so it is tested with no connection string.
 *
 * WHY THIS EXISTS. The board has no title taxonomy: src/lib/data.ts's Job.title
 * is "never cleaned up, never normalised", and the only title match the store
 * offers is a raw substring ILIKE. A watch list needs a matcher that is
 * deterministic and explainable (a reader can be told WHY a role is in their
 * lane) and that treats "Product Designer" as matching "Senior Product
 * Designer, AI" without matching "Design Engineer". Token-subset matching does
 * that: every word of the watch must appear as a word of the role, order
 * ignored. It is reproducible, so a count taken over it is exact and the same
 * on the next render.
 */

/** Lowercase, strip punctuation to spaces, collapse runs of space. The one
    normalisation both sides of a match pass through. */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when the watch appears in the role title as a contiguous run of whole
 * words (a WHOLE-PHRASE match, tightened 2026-09-18 from the old any-order
 * token-subset). "Product Designer" matches "Senior Product Designer, AI" and
 * "Staff Product Designer", but no longer "Product Design Engineer" or "Design
 * Product Manager", where the two words are not adjacent in that order. Both
 * sides are normalised (lowercased, punctuation to spaces), then padded so the
 * phrase only matches on word boundaries: " product designer " inside
 * " senior product designer ai ", never as a fragment of a larger word. A watch
 * with no words (all punctuation) matches nothing.
 */
export function matchesTitle(watch: string, roleTitle: string | null): boolean {
  if (!roleTitle) return false;
  const phrase = normalizeTitle(watch);
  if (!phrase) return false;
  const role = normalizeTitle(roleTitle);
  return ` ${role} `.includes(` ${phrase} `);
}

export interface TitleCount {
  /** The role title as the board holds it, unaltered: what a datalist offers so
      a reader picks a title the index actually carries. */
  title: string;
  /** How many rows in the given set carry this exact title. */
  count: number;
}

/**
 * The distinct titles in a set of roles, most common first, then alphabetical.
 * The autocomplete source: the real, current titles the index covers, so the
 * hybrid coverage rule can suggest from what exists while still letting a reader
 * type anything.
 */
export function buildTitleIndex(roles: readonly { title: string | null }[]): TitleCount[] {
  const counts = new Map<string, number>();
  for (const role of roles) {
    const title = role.title?.trim();
    if (!title) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/**
 * True when at least one role in the set matches the watch: the honest coverage
 * test. A watch that covers nothing is not an error, it is a title the index
 * does not carry yet, which the page says plainly and records as demand rather
 * than showing an empty lane as if it were a quiet market.
 */
export function isCovered(watch: string, roles: readonly { title: string | null }[]): boolean {
  return roles.some((role) => matchesTitle(watch, role.title));
}

/**
 * Every role in the set that matches any of the watched titles, each tagged
 * with the titles that pulled it in. Deduplicated: a role matched by two
 * watches appears once, carrying both. Order is preserved from the input, so a
 * caller that sorted by fit or date keeps that order.
 */
export function laneFor<T extends { title: string | null }>(
  roles: readonly T[],
  watches: readonly string[]
): { role: T; matched: string[] }[] {
  const out: { role: T; matched: string[] }[] = [];
  for (const role of roles) {
    const matched = watches.filter((w) => matchesTitle(w, role.title));
    if (matched.length > 0) out.push({ role, matched });
  }
  return out;
}
