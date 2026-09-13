/**
 * skill-aliases.ts: the repo-owned, versioned alias table.
 *
 * RESUME-RULES.md layer 2, "mirror once": use the posting's own term for a
 * skill the person genuinely holds, so recruiter search finds it, and pair the
 * long form with its acronym one time ("Applicant Tracking System (ATS)"). This
 * file is the closed set of pairs that mirroring is allowed to draw on, and the
 * one function that decides, for a record skill and a posting, whether a pairing
 * is warranted.
 *
 * WHY A CURATED TABLE AND NOT THE POSTING'S RAW BYTES. Mirroring's whole risk is
 * that it is the one place the tailor is allowed to add text to a fact that was
 * not verbatim in the record. Two rules keep that safe, and both live here:
 *
 *   1. A pairing fires ONLY for a skill the record already holds. The record's
 *      own token is never altered or re-cased (tailor.ts renders coreOf() the
 *      entry verbatim, and this file only ever APPENDS a paired form in
 *      parentheses to the skill's rendered line). If the record does not hold
 *      the skill, nothing here can put it on the page.
 *   2. The appended form is this table's own curated string, never the posting's
 *      bytes. The posting only decides WHETHER to pair (it must mention the other
 *      form), never WHAT text gets added. So a posting that spells a skill with a
 *      confusable or invisible character cannot smuggle those bytes onto the
 *      resume through this seam: the bytes that land are the ones written below,
 *      reviewed once, in this file.
 *
 * This is not machine data. It lives in src/lib, not src/data (which is
 * machine-owned and frozen), and it is versioned like the rubric so a change to
 * what mirroring may say is a visible, reviewable edit with a new version line.
 */

export const SKILL_ALIASES_VERSION = 'skill-aliases-v1';

/**
 * One pairing. `long` is the spelled-out name, `short` its acronym or common
 * abbreviation. Both are the forms this file is willing to put on a page; a
 * record skill matching either side, against a posting that mentions the other,
 * is rendered as the record's own form with the paired form once in parentheses.
 *
 * Seeded across role families (platform, data, product, design, marketing,
 * finance) so a first pass has something to mirror in the common cases without
 * pretending to be exhaustive. Deliberately excludes two-letter forms that are
 * common substrings of ordinary words (a bare "UI" or "TS"), because the false
 * positives are worse than the missed pairing; add them only with a matcher that
 * has proven it can tell the acronym from the noise.
 */
export interface SkillAlias {
  readonly long: string;
  readonly short: string;
}

export const SKILL_ALIASES: readonly SkillAlias[] = [
  { long: 'Kubernetes', short: 'K8s' },
  { long: 'Continuous Integration and Continuous Delivery', short: 'CI/CD' },
  { long: 'Infrastructure as Code', short: 'IaC' },
  { long: 'Applicant Tracking System', short: 'ATS' },
  { long: 'Search Engine Optimization', short: 'SEO' },
  { long: 'Objectives and Key Results', short: 'OKRs' },
  { long: 'Profit and Loss', short: 'P&L' },
  { long: 'Customer Relationship Management', short: 'CRM' },
  { long: 'Natural Language Processing', short: 'NLP' },
  { long: 'User Experience Research', short: 'UXR' }
];

/** Case-insensitive exact match of a whole skill name against one side of a
    pair. A record skill is only a candidate for mirroring when it IS one of
    these forms, not when it merely contains one. */
function sameForm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * True when `form` appears in `postingText` as its own token, case-insensitively:
 * bounded on each side by a non-alphanumeric character or the string's edge. The
 * boundary check is what stops a short acronym from matching inside an ordinary
 * word (an "SEO" inside "poseidon", say), and it works for forms carrying
 * punctuation (CI/CD, P&L) because those punctuation characters are themselves
 * non-alphanumeric boundaries within the form, matched literally.
 */
function mentions(postingText: string, form: string): boolean {
  const haystack = postingText.toLowerCase();
  const needle = form.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = at + needle.length >= haystack.length ? '' : haystack[at + needle.length];
    const boundedBefore = before === '' || !/[a-z0-9]/.test(before);
    const boundedAfter = after === '' || !/[a-z0-9]/.test(after);
    if (boundedBefore && boundedAfter) return true;
    from = at + 1;
  }
}

/**
 * The mirroring decision, RESUME-RULES layer 2 made a function.
 *
 * Given the record's own skill name and the posting's plain text, returns the
 * paired form to append (this table's curated other-side string) when all of the
 * following hold, and null otherwise:
 *
 *   - the record's skill name IS one side of a curated pair, exactly (not a
 *     substring: "Kubernetes" pairs, "Kubernetes operator" does not), and
 *   - the posting mentions the OTHER side of that pair as its own token, and
 *   - the two sides are actually different text (a posting that already uses the
 *     record's own form needs no pairing).
 *
 * The caller appends the result once, in parentheses, to the skill's rendered
 * line, and nowhere else: "one paired mention, then either form alone" is the
 * whole document carrying exactly one instance of the pairing, which is
 * satisfied because a skill is one entry and its slot is rendered once.
 */
export function pairedFormFor(recordSkillName: string, postingText: string): string | null {
  for (const pair of SKILL_ALIASES) {
    const isLong = sameForm(recordSkillName, pair.long);
    const isShort = sameForm(recordSkillName, pair.short);
    if (!isLong && !isShort) continue;
    const other = isLong ? pair.short : pair.long;
    if (sameForm(recordSkillName, other)) return null;
    if (mentions(postingText, other)) return other;
    return null;
  }
  return null;
}
