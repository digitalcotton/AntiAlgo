/**
 * Shared component prop shapes.
 *
 * Astro components cannot export types from their frontmatter: the compiler
 * runs that block inside the component function, so `import type { Row } from
 * './KeyValueList.astro'` does not resolve. Any prop shape two files have to
 * agree on therefore lives here, beside the data layer rather than inside a
 * component, which also means a page can build one without importing the
 * component that renders it.
 */

/** One term and its value, for KeyValueList. */
export interface KeyValueRow {
  /** The term. Human voice, sentence case. */
  key: string;
  /**
   * The measurement, in the machine voice. Null renders the absence text
   * instead, in the human voice, because an absence is not a machine fact.
   */
  value: string | null;
  /** Shown when value is null. Says what is missing, never guesses at it. */
  absence?: string;
  /**
   * Gate 2's markup contract, for a row carrying a value the gate has to check.
   *
   * HTML is not self-describing: nothing about the string "Aug 29, 2026" says
   * which claim it is. A row that renders a checkable value declares what it
   * means here, and the attributes land on the dd so the gate reads them off the
   * shipped page. Rows carrying prose leave it undefined, which is most of them.
   *
   * The shape is deliberately open rather than a union of every marker gate 2
   * knows: the gate owns that vocabulary and this file should not hold a second
   * copy of it that can fall out of step.
   */
  truth?: { kind: string } & Record<`data-truth-${string}`, string>;
}

/**
 * A small integer written as an English word, for prose that counts something
 * the code already knows the length of.
 *
 * WHY THIS EXISTS. /methodology carried the sentence "when one of the four kill
 * rules below fires" directly above a list of five, because the count was typed
 * and the list was not. A sentence that counts a collection has to count the
 * collection. Anything past the table falls back to digits rather than throwing:
 * a page that counts twelve of something wants "12" in the sentence anyway, and
 * a build should not die over a numeral.
 */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten'
] as const;

export const spellCount = (n: number): string =>
  Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
