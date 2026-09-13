/**
 * vocabulary.ts: the one word-extraction rule, shared.
 *
 * tailor.ts orders a render by how much an entry's own words overlap the
 * target's words, and posting-requirements.ts (the cover letter's requirement
 * picker) scores a posting line by how much it overlaps the person's record.
 * Both need the same three primitives: strip a posting's HTML to plain text,
 * lowercase-tokenize a string into words, and drop the same stopwords. They
 * used to live privately inside tailor.ts; the moment a second caller needed
 * them, copying them would have been two rules that drift, the exact shape
 * sharedVocabulary()'s own comment in tailor.ts warns against. So they live
 * here, imported by both, and neither file imports the other.
 *
 * NOTHING HERE REACHES A READER. Every value these functions return is a Set
 * or a lowercased string used only to count overlap for ordering or scoring.
 * No output of this file is ever placed into a Bullet, a paragraph, a core, or
 * anything a person sees: it is measurement, not prose. plainTextFromHtml() in
 * particular is deliberately lossy (it does not decode every entity or balance
 * tags), because it only feeds a word counter; safe HTML handling for display
 * is description.ts's separate job.
 */

/** A tag-stripping pass good enough to build a word list from, nothing more.
    Never shown to a person and never lands in a Bullet, so it does not need to
    be safe HTML handling (see description.ts for that, separate job). */
export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'will', 'this',
  'that', 'from', 'have', 'has', 'our', 'who', 'can', 'all', 'not',
  'was', 'were', 'been', 'but', 'they', 'their', 'about', 'into'
]);

/** The words in a string, lowercased, three characters or more, stopwords
    dropped. A Set, so membership and intersection are the only operations a
    caller performs; order and count of repeats are deliberately discarded. */
export function extractWords(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const set = new Set<string>();
  for (const w of words) {
    if (w.length >= 3 && !STOPWORDS.has(w)) set.add(w);
  }
  return set;
}
