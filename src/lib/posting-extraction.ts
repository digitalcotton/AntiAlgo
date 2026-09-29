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

/**
 * THE FACTS A POSTING STATES, BEYOND ITS TITLE AND BODY.
 *
 * WHY THESE EXIST AT ALL. A job on the board carries its location, whether it
 * is remote, when it was posted, its department and its pay. A job a member
 * PASTED carried a title, a company and a body, and nothing else -- on the
 * same posting, from the same platform, read minutes apart. That was never a
 * decision anybody made: `board_build.py` asks its adapters for those fields
 * and `postfetch.py` never did, so the single-posting reader threw away data
 * that was already sitting in the payload it had just parsed. An added
 * posting should look like a job listing because it IS one.
 *
 * EVERY FIELD IS NULLABLE AND NULL IS THE HONEST ANSWER. A reader reports what
 * the source said; a source that does not state its pay gets a null, never a
 * guess. `null` here always means "this source did not say", and never "we did
 * not look".
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *   - `roleFamily` and `tier`. The owner's standing rule is that these are
 *     MEASURED from upstream tags, never regex-parsed out of a title. A pasted
 *     posting has no upstream tag, so it has no family and no tier, and the
 *     views that group by them render an honest empty rather than a guess.
 *     They land here the day the sweep's export carries them.
 *   - `daysUp`, `ghost`, `firstSeen`, `lastSeen`. These are not facts a posting
 *     states; they are what watching it over many nights reveals. One read
 *     cannot produce them at any level of effort, which is exactly what the
 *     added-posting notice already tells the member: it "gets no fate overlay".
 *   - `compMidK` and `priced`. The board stores both as columns; here they are
 *     arithmetic on `compMinK`/`compMaxK` and are derived where they are shown.
 *     A stored copy of a derived value is a thing that can disagree with its
 *     own inputs.
 */
export interface PostingFacts {
  /** The location as published, e.g. "Culver City, California, United States"
      or Greenhouse's bullet-joined "San Francisco, CA • New York, NY". Kept as
      the source's own string rather than split, because every platform splits
      it differently and the board keeps it whole too. */
  location: string | null;
  /** The country, where the source names it as its own field rather than
      leaving it inside `location`. */
  country: string | null;
  /** True when the posting says remote or home-office, false when it says
      explicitly otherwise, null when it does not say. The three are different
      and collapsing null into false would invent an on-site claim. */
  remote: boolean | null;
  /** When the posting was published, ISO 8601, as the source dates it. */
  published: string | null;
  /** The team or department, as the source names it. */
  department: string | null;
  /** Employment type as published, e.g. "Full Time", "Standard". */
  employmentType: string | null;
  /** The pay range in the source's own words -- "between $175,000 and
      $263,300". Kept verbatim because the caveats around the number ("depending
      on location") change what the number means, and because a range we cannot
      parse is still worth showing a person. */
  compPosted: string | null;
  /** Thousands, to match the board's `comp_min_k`/`comp_max_k`. Filled only
      when `compPosted` parses unambiguously; null otherwise, even though
      `compPosted` is set. That pair -- words without numbers -- is the normal
      case for a posting that says "competitive", and is not a failure. */
  compMinK: number | null;
  compMaxK: number | null;
}

/** Every fact absent. The starting point for a reader whose source states
    none of them, so a parser never has to spell out eight nulls. */
export const NO_FACTS: PostingFacts = {
  location: null,
  country: null,
  remote: null,
  published: null,
  department: null,
  employmentType: null,
  compPosted: null,
  compMinK: null,
  compMaxK: null
};

export interface PostingExtraction extends PostingFacts {
  /** Which layer produced this: an ATS id, `jsonld`, or `page`. */
  kind: SourceKind;
  title: string | null;
  company: string | null;
  /** Sanitised HTML, or null when the source carried no body at all. */
  descriptionHtml: string | null;
  /** The URL the read actually landed on, after redirects. */
  finalUrl: string;
}
