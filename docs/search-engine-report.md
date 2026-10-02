# Search engine: what was built, how well it works, how to ship it

Branch `search-engine`, on top of `main` (61d2487). **Not pushed** — a push to
`main` runs five migrations (219–223) against production on build; see the
runbook below. Built 2026-10-02 to `search-engine-plan.md`, Opus orchestrating,
Sonnet developing, every commit gated.

Every number here is from `npm run eval:search` on the finished tree (`c7beeaf`)
against the local copy of the nightly board, 37,286 live rows. Full output:
`search-engine-metrics.md` / `.json`. Fingerprint `de36a421…`.

---

## What a reader gets now

- **One box, typed the way you'd say it.** "senior designer london remote 150k"
  becomes the words *senior designer*, with Location set to *London, United
  Kingdom*, Remote to *Remote* and Comp to *$150k+*. A fact with no control of its
  own (a company, a posted-within window) becomes a chip in the box. Facts the
  employer stated become filters; nothing is guessed.
  A place that is also a common title word ("Mobile, AL" vs "mobile engineer") is
  *offered*, never converted silently — the board's own counts decide which.
- **Typeahead with exact counts.** Grouped Titles / Places / Companies / Facts,
  in the site's own menu style. Every count is the number of rows you get when
  you choose it — proved, not hoped.
- **Search that finds things.** Words in any order, title plus company, typos,
  skills mentioned in descriptions. Ranked by where the words are found.
- **A strip that means what it says.** LOCATION is geography (it was mislabelled
  work arrangement). REMOTE is several-at-once. COMP is a pay floor, defined
  exactly as the Desk already defines it. Field left the strip and returns as
  links under the results, labelled as a classification.
- **A job is found under every place it lists.** "London / Germany" is in
  London, UK and in Germany; "Chicago, IL, Evanston, IL" is in both cities. Each
  place's number is exactly the jobs you get when you choose it, so the Location
  numbers add up to more than the total when a job lists two countries.
- **Every order is explained.** Signed-in: each row's `why ▾` opens with "Ranked
  3rd: every word you typed is in the title, then …". Signed-out: one line above
  the list says how it is ordered, and the order uses nothing they cannot see.

---

## How well it works

### Finding a known posting (500 fixed postings, same inputs old and new)

| how it was typed | old hit@10 | new hit@10 | new: right title in top 10 |
|---|---|---|---|
| exact title | 87.4% | 90.4% | **100%** |
| title + company | **0%** (100% zero results) | **92.2%** | **100%** |
| words reordered | **0%** | **86.6%** | **96.7%** |
| one typo | **0%** | **88.0%** | **96.0%** |

The old engine only worked when you typed an exact substring of the title.

### Typeahead

| typed | result |
|---|---|
| "Senior Product Desi" — earlier words + 4 letters | right title in top 8: **96.8%** (first: 86.0%) |
| first 3–5 letters of a city | right place offered: **90.5%** |
| first 4 letters of a company | right company offered: **99.5%** |

### Counts are exact

| check | result |
|---|---|
| every suggestion's count vs the rows its link returns | **3,787 of 3,787 exact**, 500 random cases, 0 mismatches |
| strip invariants: Remote and Comp sum to their totals; every Location count equals the rows its own filter returns | **2,500 checks, 0 violations** |
| memoised answers vs cold answers | 500 of 500 identical |

### Speed (local Postgres, warm, p95)

| | before this work | now |
|---|---|---|
| no words (the whole board, every count) | — | **112.3 ms** |
| one word ("designer") | 288 ms | **7.7 ms** |
| three words | 345 ms | **7.9 ms** |
| a typo ("prodct desiner") | 306 ms, **0 rows** | **29.9 ms, 251 rows** |
| words + place + remote + pay | 301 ms | **8.2 ms** |
| a broad word ("engineer", 6,218 matches) | ~190 ms | **58.5 ms** |
| typeahead, cold | — | **53.1 ms** (100% of requests under 100 ms) |
| typeahead, warm | — | **3.6 ms** |

Local numbers are not Neon numbers. Neon adds network round trips; the
relative gains hold. Counting a job under every place it lists cost 1–5 ms per
search (from 108.8 / 6.1 / 24.8 ms): most of it is the list of every country on
the board, one index probe per country (~5 ms, where the old one-place column
took 0.6). It is the same for every request until the next nightly load, so a
cache keyed on the load instant would take it back; not done.

### Where jobs are

| | before | now |
|---|---|---|
| live rows with a resolved country | 40.3% | **82.0%** |
| Canada filed in a US region | 979 rows | **0** |
| region "Unknown" | 21,061 | **6,607** |
| rows with no place at all ("Not stated") | 22,263 | **6,602** |
| countries on the board | — | **109** |
| jobs under London, UK | — | **903** (676 before lists counted every place) |
| postings that list several places, each found under all of them | — | **2,201** (477 across countries) |
| place accuracy on held-out rows | — | **97.85%** (99.97% excluding rows whose upstream code contradicts the text) |

### Targets

| target | result | |
|---|---|---|
| search p95 ≤ 150 ms | 108.8 ms worst shape | PASS |
| typeahead p95 ≤ 100 ms | 50.1 ms cold | PASS |
| counts exact 100% | 3,677 / 3,677 | PASS |
| typo hit@10 ≥ 80% | 88.0% | PASS |
| place accuracy ≥ 97% | 97.85% | PASS |
| non-US in a US region = 0 | 0 | PASS |
| parser 100% | 356 / 356 | PASS |
| classifier floor ≥ 0.90 | 0.9045 | PASS |
| right title in top 10 ≥ 95% | 100% | PASS |
| **exact posting in top 10 ≥ 95%** | 90.4% | **MISS — the target was wrong.** 14% of sampled postings share their title with more than ten others, so no engine can exceed 91.8%. This one is at the ceiling. |
| **country coverage ≥ 85%** | 82.0% | **MISS.** What remains is mostly placeless by nature: "Multiple Locations" (1,290), "N Locations", "Remote", blanks. |

---

## Things the build found that nobody asked about, now fixed

- **The nightly load froze the live board.** It took `ACCESS EXCLUSIVE` before a
  `TRUNCATE`; every reader waited for the whole load. Worst reader wait **33.7 s →
  18.5 ms**.
- **Corporate Counsel was filed as social care**, Salesforce admins as Sales, and
  449 production roles as Product, by a first-keyword-wins classifier.
- **The server silently discarded** a member's saved Location/Remote/pay, and
  opening the Pre-List **erased** their saved board filters.
- **Removing your last filter was impossible** — a bare board restored the saved
  selection.
- **106 Indiana jobs were in APAC** (the word list read "Indiana" as India).

---

## Decisions I took without you (reversible, stated in the commits)

1. Region is **derived from the resolved place** (one definition), not repaired as
   a word list.
2. A country **named in full words beats a contradicting upstream code**
   (the crawl files Albuquerque, New Mexico under Mexico) — 302 rows.
3. **Pay is one definition**: the Desk's `comp_range.min ≥ floor`. COMP became
   floors instead of bands.
4. **Applied chips carry no count**; counts sit on choices. A count on an applied
   filter is a number with no clear question behind it.
5. **Typo correction only runs when the exact words match nothing**, and the page
   says so ("No exact matches … showing close spellings").
6. **Places come from the board's own data**, no GeoNames download.
7. A **planner setting** (`random_page_cost`) is scoped to statements with words,
   because Postgres flipped between a 15 ms and a 200 ms plan on a cost tie.

---

## Decisions that are yours

1. **Region names.** 173 rows in non-EU Europe (Norway, Switzerland, Serbia …)
   are labelled **EU**, the only European value. 511 rows in Israel, South Africa
   and the Gulf have **no region at all**. Rename EU → Europe? Add Middle East &
   Africa?
2. **DECIDED 2026-10-02: shown once.** An applied filter showed twice, as a chip
   in the box and as the dropdown's value; the chip took the row's room and
   stacked over the field until the box stopped reading as a search box. The box
   now draws a chip only for a fact no control shows (company, posted-within).
   With it the strip stopped wrapping: one line where the values truncate
   ("London, Unit…"), tighter padding when that is not enough, and the phone's
   column only when even that does not fit, decided by measuring, as the header
   is.
3. **The Location list is long** (95 countries; zeros muted at the bottom). The
   design prompt asks Claude Design for a type-to-filter inside it.
4. **Remote ticks submit one at a time** — choosing two arrangements is two page
   loads.
5. **Leftovers from the old box:** `src/data/search-suggestions.json`, its build
   script and `familyFromSearch()` are now used only by their own tests. Delete?
6. **Categories done properly** (ESCO taxonomy, a posting in several fields,
   meaning-based matching) — not started. It needs a dataset download and a model
   on the Mac mini, both of which need your approval.
7. A pre-existing accepted gate finding (`gate-invariants` check 3) passed its
   "review by" date on 2026-10-01.
8. **DECIDED 2026-10-02: option B, built** (`docs/every-place-plan.md`). Every
   live row's stored places were checked against the reference run, 37,286 of
   37,286; the wrong places below are gone, and so are cities called "Europe",
   "APAC", "All France" and "Anywhere in the U.S.". Not done: filing the three real
   "London, Canada" rows under London, ON. The finding as first reported: **a
   posting that lists several places is given one city, often the wrong one.** Found after this report, checking "London, Canada" in the typeahead.
   99 live postings list places separated by " / "; each was given a single
   city, and 24 of those are wrong: a city from the list paired with a different
   country from the list or from the upstream code.
   - "United States / Canada / London" → *London, Canada* (2 rows; London, UK)
   - "London / Germany" → *London, Germany*; "London / Ireland / … / United
     States" → *London, United States* (2)
   - "New York / Canada / United States" → *New York, Canada*; "United Kingdom /
     New York / …" → *New York, United Kingdom* (2)
   - "Canada / Europe / United States" → a city called *Europe* (9 rows across
     Poland, Canada, United States); also *Apac* (2), *All France* (3)

   Postings that name one place were checked the same way (the 30 largest groups
   of a city filed under an unusual country): all real places — London, ON;
   Cambridge, ON; Melbourne, FL; London, OH.

   The fix is a choice: **(a)** a posting that lists several places gets no city
   and reads "Multiple locations" — small; or **(b)** it counts under every place
   it names, which is what someone searching London wants, but one posting then
   has several places and the count rules change with it.

   Separately, the real "London, Canada" rows (3 of the 5; the posting says
   "London, Canada" and the title says London, Ontario) are the same city as
   *London, ON* and should be filed there: a city named with its country but no
   province takes the province when the board knows only one city of that name
   in that country.

---

## Deploy runbook

**What a push to `main` does.** The Vercel production build runs `db/migrate.mjs`
then `scripts/ingest-on-build.mjs`. The board file is no longer committed, so the
build applies migrations and **keeps the rows already in Postgres**. The Mac mini's
nightly publish (03:30 ET) is the only writer of rows; it fast-forwards its copy
of this repo to `main` before it loads, so it picks up the new code by itself.

**Migrations, in order:** 219 (search vector + trigram), 220 (place columns),
221 (title/company vector), 222 (`place_keys` and `place_leaves`: every place a
posting lists; docs/every-place-plan.md), 223 (`place_countries`: the countries
among them as one string, which the Location counts group by). Each takes its exclusive lock for milliseconds and
waits at most 5 s for in-flight reads, then fails the build rather than freeze
the board; the fills run under row locks (readers unaffected). Expect ~40 s of
build time on 37k rows. Both extensions (`pg_trgm`, `unaccent`) are trusted on
Neon.

**The one gap to close.** The migrations fill the search vectors themselves, but
the place columns, the `place_keys` / `place_leaves` arrays and `place_countries`
(db/222 and db/223 add them empty, and empty reads as "Not stated") and the corrected regions come
from the ingest code. Until the next nightly load they are **empty in
production** — the Location list would be bare. Close it either way:

- **A.** Deploy in the evening and let 03:30 ET fill them; or
- **B.** Right after the deploy, once, against production:
  ```bash
  DATABASE_URL_UNPOOLED='<production unpooled URL>' node scripts/backfill-derived.mjs --all
  ```
  (~30 s locally; it rewrites derived columns only. It writes the two arrays as
  well as the place columns; its receipt ends with how many rows list a place
  and how many list several.) Then run `VACUUM (ANALYZE) jobs` once: a bulk
  rewrite leaves the planner's statistics stale, and a plan test failed on
  exactly that locally until it ran.

**Then check:**
```bash
ssh mini '~/jobmachine/nightly.sh --preflight-only'
```
and on the site: type "designer london remote" — it should land with three chips
and counts in the dropdowns.

**Do not deploy during the crawl window** (03:30 ET): a migration fill and the
nightly load would queue behind each other.

**Rolling back** is `git revert` of the merge. The migrations are additive
(new columns, functions, indexes, a trigger); old code ignores them.

---

## How it was verified

- `npm run conform -- --deep`: **GREEN, 7 of 7** on the final code (`2c9e8b5`,
  274 s, main tree, no dev server running, test database at 223) — types, the
  unit tests (including the database-backed search and suggest invariants),
  invariants, DOM contracts, tokens, route census, and the browser tier: every
  route as five audiences, interaction specs in WebKit and Firefox, the galleries
  in both themes.
- Every commit was gated on its own: the first 21 in a clean checkout of `HEAD`,
  the every-place commits with `npm run conform` in the main tree as each landed.
- Every live row's stored places (`place_keys`) equal an independent reference
  run of the rule, 37,286 of 37,286, checked from the database twice (once by the
  developer, once by the orchestrator); `place_countries` agrees with
  `place_keys` on every row; region changes are exactly the 28 measured.
- Every engine change that should only change speed was required to leave the
  evaluation fingerprint identical; it did, through three such changes
  (`1d43c69b…`).

## The commits

```
2c9e8b5 The harness's numbers after "Anywhere in the U.S." and the country string: fingerprint de36a421c612
c7beeaf The Location counts group by a short country string, and the board is back near its old speed
592f8af "Anywhere in the U.S." is the country, not a city of that name
d0f5393 The harness's numbers after a posting counts under every place it lists: fingerprint 7bfe30cb79c1
c789102 The board finds a posting under every place it lists, and each place's count is exactly the rows its own filter returns
1b35164 Every place a posting lists is stored: place_keys and place_leaves, written by the ingest and the backfill
d445282 A list of places is read place by place: "London / Germany" is London, UK and Germany
e972474 Plan: a posting counts under every place it lists
49c479d Report: multi-place postings are given one city, often the wrong one
968864f Comments and lists that described the old mechanisms, corrected
ff902d7 The list tells the truth: no hidden zeros, Not stated choosable, no unseen order
c5b5f8a Prefix matching through a small title-and-company index
de9930c A member's saved board now keeps the new strip, and the Pre-List stops erasing it
b1cba4c The harness measures the typeahead and proves the counts at 500 cases
79943ab /board/suggest: typeahead with counts that are exactly what you'll get
2edbb37 The strip: Location is geography, Remote is a choice of several, pay is a floor
0973b05 A harness that measures the search, old against new, on fixed inputs
415971e Every row can say why it sits where it sits
46ee6ab The board searches words, not a substring, and ranks what it finds
f8e236f The search box declares the timeout hook its script reads
7bd79f6 The search box: one field, chips inside it, suggestions grouped and counted
fe65a71 The search box's vocabulary, built from the board itself
6faf657 The nightly load stops freezing the board
536f480 Search plan: the suggest endpoint's contract
e32d3e0 Where a job is: places resolved from the text, and Canada is not US West
fc0781b The classifier stops filing lawyers under social care
974d2a2 Full-text search over title, company, department and description
fa9d584 One parse of the search box: stated facts become chips, nothing is guessed
0caebff Search engine: the research, the design and the build plan
```
