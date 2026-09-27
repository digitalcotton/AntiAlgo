# Per-member fit: architecture

Companion to [fit-score-design.md](fit-score-design.md) (what the member sees)
and [thin-match-warning-spec.md](thin-match-warning-spec.md) (the same judgement
at draft time). Owner's ask, 2026-09-27.

## What is wrong

`scoreJob()` in `scripts/ingest-jobs.mjs` scores five things, every one a
property of the posting and none of the person:

| component | max | the actual test |
|---|---|---|
| title_scope | 30 | `title.trim().length > 2` |
| remote_geo | 25 | a location string exists (12 for country only) |
| comp | 20 | the posted pay contains a digit (12 for prose) |
| freshness | 15 | banded by `days_up` |
| apply_friction | 10 | an apply URL exists |

It is a **completeness score for the crawled record**, displayed as "fit". A
Dutch warehouse posting with a title, location, salary and apply link scores
100/100 for a product designer. No `userId` reaches it; it is the same number
for everybody.

## The live lie, worse than the score

`fitNote()` in `src/components/job-detail-v2/JobDetailV2.astro:163` is commented
"An honest one-line note per component, read off the record, never invented",
and then every branch invents:

- `title_scope` full → **"Title and scope match a lane you saved."** Nobody
  saved a lane. It means the title is longer than two characters.
- `comp` full → **"Full range printed, floor above your number."** There is no
  "your number" anywhere in this code path.
- `remote_geo` full → **"inside the metros you allow."** No metros were allowed.

This ships today. **It dies in the same commit as the rename, not later.** A
number that is vague is a smaller wrong than a sentence asserting a check that
never ran.

## Recommendation: read-time in SQL, from a stored per-member artifact, as a band

### Where it is computed — read time, in the existing board CTE

Not precomputed per member, not lazy. **The deciding constraint is sort, not
egress.** `sort=fit` is the board's default (`DEFAULT_QUERY.sort` in
`board-query.ts`), so the score decides *which page you get* and must therefore
exist for every candidate row at query time. That rules out lazy-on-first-view
outright: you cannot compute a score only for the rows you return when the score
chooses the rows you return.

Precomputing per member is the cross product this codebase already fought:
37,765 rows x members, rewritten nightly against a `jobs` table that is fully
re-upserted every night with `--replace`. Every crawl invalidates all of it.
Rejected unless the measurement below forces it.

Read time is affordable **at this scale specifically**, and the evidence is in
the repo: `BOARD_FACET_CTE` already sequentially scans the whole table running
`regexp_matches()` per row plus five CASE ladders, twice per request. A join to
one member row is an increment on a scan that already happens. `db/207` records
the baseline: slowest aggregate 373 ms, most under 70 ms, at 31,310 rows.

### What is computed — a band, not a number

Two reasons not to replace a broken 0-100 with a working one:

1. **An exact score forces exact ranking of 37,765 rows.** Shared-term count is
   roughly 64 x 300 per row x 37,765 ≈ 700M comparisons — not a request-time
   query. Every trick that makes it fast makes it approximate, and an
   approximate sort beside an exact displayed number visibly disagrees: a row
   showing "7 shared words" above one showing "8". A bug the member can see.
2. **Two digits imply a precision this data does not have.** `FitBars.astro`
   already refuses exactly this, suppressing back-filled components rather than
   printing them.

So the board-wide sortable signal is **three exact booleans**, all
index-assisted, each defensible in one sentence:

| signal | source | how it is true |
|---|---|---|
| in your record's language | `jobs.match_lang` vs `record_lang` | derived at ingest |
| shares your record's vocabulary | `jobs.match_terms && member.match_terms` | GIN `array_ops`, exact |
| matches a title you watch | `ledger_watch` via the existing `titleKeepClause` | already shipped, already SQL |

The **exact shared-term count and the words themselves** are computed only for
the rows the page returns (default 5, max 100), where the cost is trivial, and
shown as the evidence. Count > 0 iff the `&&` band is true by construction, so
the band and the number can never disagree.

This is also why it is coherent with the thin-match spec: that spec recommends
shipping the unambiguous `topScore === 0` case first. The `&&` boolean **is**
`topScore === 0`, computed board-wide, needing no threshold chosen without
evidence.

## What represents the member

New table `member_match_profile`, one row per member:

- `match_terms text[]` — `extractWords()` over every entry's title, employer and
  description, **capped to the member's rarest terms by corpus document
  frequency**. Uncapped is 300-800 terms, mostly corpus-universal ("design",
  "team", "product"), which makes `&&` true against nearly everything and
  destroys the signal. The board owns the corpus, so rarity is measurable, not
  guessed. The cap number comes out of the measurement below.
- `terms_total int` — so the page can say what it is not using
- `record_lang text` — nullable; NULL means "not determined", a real state
- `entries_considered`, `entries_with_text` — the denominators the thin-match
  spec already wants
- `built_from_version bigint`, `built_at timestamptz`

**Invalidation by trigger, not by call site.** The record has at least five
writers (`createEntry`, `updateEntry`, `deleteEntry`, `deleteEntriesFrom`, the
resume import). Calling a rebuild from each is five sites that drift the first
time a sixth appears. `db/104` already maintains `updated_at` by trigger with
the stated reasoning that "a timestamp only some code paths update is worse than
none, because it looks authoritative" — which holds with more force here,
because this timestamp decides whether a score is stale.

## Keyword, not vectors — and not for the reason you would guess

**Embeddings are cheap here.** ~30M tokens after HTML stripping, under a dollar
for a full-corpus pass at current small-embedding prices. "37,765 calls is
expensive" is not the argument. The three real arguments, in descending force:

1. **A cosine cannot be explained to the member.** `FitBars.astro`'s header
   states the product's whole position: "A score that shows its working is a
   score a reader can argue with, which is the whole difference between this and
   a relevance ranking." 0.71 has no working and cannot be checked against the
   document in front of the reader.
2. **It puts a provider in the nightly data path.** `ingest-on-build.mjs` is
   explicit that ingest was moved out of GitHub Actions to remove a third party
   after a billing failure silently froze the board for a day. This re-adds that
   failure mode, and it fails the same way: quietly, looking fresh.
3. **Storage.** 232 MB of vectors plus a comparable HNSW index, on a database
   whose entire text corpus is 214 MB.

What vectors would genuinely buy is the multilingual case done properly — a
Dutch *product design* posting scoring high against an English design record.
Keyword cannot do that. But the failure the owner actually named (Dutch
warehouse vs English designer) is solved by the language gate alone.

**One definition, not two.** Do **not** use `to_tsvector`: its stemming and its
own stopword list would immediately diverge from `extractWords()`, invisibly,
and the board would rank by one rule while the draft room explained it with
another. This repo has been bitten by that shape and says so in three places
(`vocabulary.ts`, `compTopSql`, `desk-agg.ts`'s "THE MATCHER IS THE SAME
MATCHER"). Instead: `jobs.match_terms text[]` written at ingest by the same
`extractWords()`, via `jobs-derived.mjs`, the file that exists to be the single
owner of derivations. The tokenizer moves to `src/lib/vocabulary.mjs` with
`vocabulary.ts` re-exporting, so there stays exactly one implementation.

`pg_trgm` is not needed; `db/117` already scopes it to "hundreds of thousands"
of rows, and fuzzy string similarity answers a different question.

## Language: a gate, not a component

Near-zero overlap against a Dutch posting is not a low fit — it is an
**inapplicable measurement**. Scoring it "0/25 language" asserts a reading
nobody took.

The repo already holds this posture twice: `scoreJob`'s own freshness comment
("Unknown age scores zero rather than guessing a recency the record cannot
support") and `db/207` ("Those are gaps in what employers printed, and the page
shows them as gaps").

- `jobs.match_lang text`, nullable, derived at ingest by stopword-frequency
  signature. No npm dependency. **Must return NULL below a confidence floor.**
- Both known and different → the board shows **no fit** and the reason, in the
  existing FitBars absence pattern. Not a zero.
- Either NULL → no fit, "we could not tell what language this posting is in."

**A gate that hides rows must be more reliable than a number that is wrong**, so
the detection measurement is a ship blocker, not a nice-to-have.

## Migration: rename, do not delete

`fit_total` measures how complete and fresh the crawled record is. That is real
and useful, and `jobs-data-agg.ts:278` consumes it for the public Jobs Data
page's aggregates, where completeness is genuinely what is wanted. Deleting it
breaks a legitimate reader.

Three steps, additive and reversible, in the posture `db/204` and `db/207`
already use:

1. `db/212` adds `completeness_total` / `completeness_components`, backfilled
   from `fit_total` / `fit_components`; ingest dual-writes both.
2. Readers move one at a time: `job-store.ts`, `desk-agg.ts`, `jobs-data-agg.ts`,
   `board-jobs.ts`, `desk-home.ts`.
3. `db/215` drops the old columns.

The new per-member signal is a **separate optional field** on `Job`
(`match?: MemberMatch | null`), forward-compatible in the same shape the
thin-match spec specifies, so every existing reader and stored payload is
unaffected.

Note the type-level cost honestly: `Job.fit` is shared with the static
design-board fixture (`src/data/jobs.json`, rendered by `/role/[slug]`), whose
totals are real sweep scores from a different pipeline. `Fit`, `RUBRIC`,
`FitKey`, `fitComponents()`, `FitComponentProvenance` and the two sum-checks all
move together and all keep meaning "the completeness rubric."

**Who sees what:**

| viewer | board |
|---|---|
| signed out | no Fit column, age sort — **already shipped**, `board.astro` does this today |
| member, empty record | same, plus one line: "Fit compares your Profile Record to a posting. Yours is empty." |
| member, language mismatch | the absence and the reason |
| member, comparable record | the band; on returned rows, the exact count and the shared words |

The signed-out half of the migration question is already solved, and the
precedent extends exactly to "member with an empty record."

## Build order, riskiest assumption first

### Step 0 — the measurement spike. Ships nothing. Decides everything.

**The riskiest assumption is not performance. It is that record-word overlap
separates good postings from bad ones at all.** If a product designer's record
shares at least one word with 28,000 of 37,765 postings, the boolean is always
true, the signal is worthless, and every step below is wasted.

This is answerable **today, offline**, from `src/data/board-latest.json.gz` plus
one real Profile Record, with nothing shipped and no database touched:

1. Term document frequency across all 37,765 postings. How many terms are
   corpus-universal?
2. Overlap distribution for a real record at various caps (all / rarest-256 /
   rarest-64 / rarest-32). **The cap falls out of this table.**
3. **Separation check.** 20 postings the owner would apply to, 20 they obviously
   would not. Does the measure rank them apart? If the distributions overlap,
   stop — no amount of SQL fixes a measure that does not separate.
4. Language detection accuracy on ~200 hand-labelled postings, especially the
   false-positive rate on English read as non-English — that is the failure that
   hides a job the member wanted.
5. Column and index sizing at 37,765 rows.

### Steps 1-7

1. Posting-side columns (`db/212`), no reader. Verify size, backfill time and
   index behaviour on a Neon branch first.
2. Member-side artifact (`db/213`) plus the `record_entry` trigger.
3. The SQL band, and the hard perf gate: `EXPLAIN ANALYZE` before and after
   against `db/207`'s recorded baseline. **State the budget before measuring.**
   If p95 regresses past it, stop and decide deliberately.
4. Exact count on the returned page only. Note `BOARD_LIST_COLUMNS`
   deliberately nulls `description` so the heavy column never leaves the
   database in bulk — select the count, not the arrays.
5. The rename.
6. Render, and **delete `fitNote()`**.
7. Coherence with the thin-match spec: the board and the draft room read the
   same numbers from the same function.

## What to measure before reconsidering vectors

Only if step 0.3 shows keyword does not separate:

1. Does keyword overlap separate at all?
2. Where does it fail, and is that failure common? If misses are dominated by
   same-language vocabulary mismatch ("IC6" vs "staff"), a synonym list is
   cheaper. Only cross-language matches the owner wants surfaced need vectors.
3. Live embedding pricing against actual stripped token count.
4. Neon storage and compute at +232 MB (or +77 MB truncated) plus HNSW build
   time.
5. Incremental churn — the upsert rewrites every row, so "changed" needs a
   content hash to be answerable. This decides whether recurring cost is 3% of a
   full pass or 100%.
6. **How would a vector score be explained to the member?** With no answer here,
   1-5 are moot.

## Owner decisions

1. Does the exact shared-word count **sort** the board, or only display?
   Recommend display-only for v1; sorting is the expensive option.
2. Is the Desk watch list part of fit, or a separate filter? It is stated
   intent; the record is demonstrated history. Different claims.
3. The term cap number (falls out of step 0.2, final choice is a product call).
4. Empty record: "no fit", or the relabelled completeness number? Recommend "no
   fit", matching the signed-out treatment already shipped.
5. Does `fit_total` keep its name on the public Jobs Data page?
6. Confirmation of the thin-match spec's open question 2 — warning before
   drafting, which this feature answers by existing.
