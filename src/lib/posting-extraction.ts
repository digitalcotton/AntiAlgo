/**
 * posting-extraction.ts: what a read of one job posting yields, named once.
 *
 * WHY THIS FILE IS SEPARATE FROM BOTH READERS. Two modules produce this shape
 * and neither owns it. `posting-resolvers.ts` produces it from an ATS's own
 * JSON endpoint; `posting-extract.ts` produces it from a page's HTML. They were
 * written against the same spec and still drifted on one field — one declared
 * `descriptionHtml: string`, the other `string | null` — which is exactly the
 * drift a shared declaration prevents. Putting it here rather than in either
 * reader also keeps the dependency acyclic: both readers point at this file,
 * and this file points at nothing but the store's own vocabulary.
 *
 * WHY NOT IN posting-fetch-store.ts. That file owns the vocabulary that
 * describes a STORED row — SOURCE_KINDS, FAILURE_CODES, the char caps — and an
 * extraction is not a row. It is what a reader hands the caller before anything
 * is stored, and it may never be stored at all (a failed inline read falls
 * through to the mini and this value is discarded). The two are adjacent, not
 * the same, and `kind` below is imported from there rather than re-listed so
 * the adjacency stays honest.
 *
 * DESCRIPTION MAY BE NULL, AND THAT IS NOT AN ERROR HERE. A real ATS payload
 * sometimes carries a title and a company with an empty body. A reader's job is
 * to report what the source actually said; deciding whether a posting with no
 * body is good enough to settle on is policy, and policy belongs to the caller
 * that owns the time budget and the fallback. For the record, the caller's
 * answer is no: `tailor.ts` and `posting-requirements.ts` read
 * `description_html` and have nothing to work with without it, so an extraction
 * with no description is treated as a failed read and falls through to the
 * mini. That rule lives at the call site, deliberately, so this type can stay
 * a description of a source rather than a judgement about one.
 */
import type { SourceKind } from './posting-fetch-store';

export interface PostingExtraction {
  /** Which layer produced this: an ATS id, `jsonld`, or `page`. */
  kind: SourceKind;
  title: string | null;
  company: string | null;
  /** Sanitised HTML, or null when the source carried no body at all. */
  descriptionHtml: string | null;
  /** The URL the read actually landed on, after redirects. */
  finalUrl: string;
}
