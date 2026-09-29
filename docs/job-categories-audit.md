# How this site says what kind of job a job is

> **SHIPPED 2026-09-28, branch `fix/one-vocabulary-for-job-kind`, nine commits.**
> Everything in §6 is done except where noted. Numbers below are the numbers
> BEFORE the fix, kept as the record of what was wrong.
>
> | § | What changed | Commit |
> |---|---|---|
> | A | Location reads the structured flag; hybrid and unstated split out. Remote 1,469 → 4,169 | `937e421` |
> | C | The age strip respects the reader's filters; its heading says when it is narrowed | `944921a` |
> | B | "Not placed" sorts by its count | `f19b28b` |
> | 3b(d), F, F2 | `RoleFamily` IS the 22 families now; the job page shows a Field cell | `ff4c514` |
> | F | One seniority ladder; the fifth regex renamed `EXECUTIVE_TITLE` | `4269023` |
> | A2 | The five `/jobs-data` groups name real families and are told apart by title words: 64 / 32 / 11 / 6 / 2 | `0bc11f7` |
> | D | 312 suggestions inline; a typed field name selects that field. The department clause was measured and REJECTED (+1.3%, and wrong where it gains) | `17adb1e` |
> | — | **New, found while fixing:** `board_kills` gets a family (db/214), so watching a title stops emptying the archive | `9e1b95a` |
> | E | 190 terms: coverage 87.8% → 92.9%, ratchet 0.84 → 0.90 | `117de93` |
>
> **Two things production needs after this deploys:** db/214 lands on build
> (ingest-on-build runs migrate.mjs), but the values need
> `node scripts/backfill-derived.mjs --all` once, or the board filters on
> yesterday's classification until the next nightly ingest.
>
> **Still open, on the mini and not in this repo:** Workday sends no department
> (3,522 rows), USAJOBS' `RemoteIndicator` is unread (9,940 rows, 20 remote),
> Amazon reports no remote at all (2,846 rows). Those three fix more numbers
> than anything in the site code.
>
> **Not done, and a product question rather than a bug:** `/jobs-data` is still
> five design groups on a board that now covers 22 families and every kind of
> work. That is a leftover from when this site was design-only and it sits
> against "this site is for everyone".

An audit of every surface that categorises, searches or selects work, written
2026-09-28 after the owner reported that the counts in the Field dropdown do not
match the jobs the board says it has.

All figures below are counted against the local dev copy of the board,
37,286 live rows, which tracks production to within ~20 rows.

---

## 1. The screenshot, read literally

One screen, three numbers, three different denominators, and nothing on the page
says they are different:

| What it says | What it counts | Value |
|---|---|---|
| **Verified live — 37,306** | every live row, no filters | whole board |
| **Showing 36,868 of 36,868 roles** | every live row **with a measurable age** | whole board minus 829 undated |
| **All fields — 1,463** | every live row **under the reader's current filters** | the board narrowed to Location=Remote |

The tiles and the age strip ignore the filter strip completely. `board.astro`
calls `listBoardAgeHistogram(sweepDate())` with no filter arguments at all
(`src/lib/job-store.ts:499`), so the age plot is always the whole sweep even when
the reader has narrowed to one field in one location. The Field dropdown is the
only number on the page that respects the reader's choices.

So the dropdown is not disagreeing with the board. It is answering a question
nobody asked it out loud.

**The arithmetic inside the dropdown is sound.** Every family column is counted
with the identical clause (`facetCountSql`'s `onFam`, job-store.ts:281), so
`All fields` really is the sum of the options. Verified: under Location=Remote,
1,469 = 1,329 placed + 140 not placed.

**But it does not look sound, for two reasons.**

*The list is sorted by count and then breaks its own sort at the bottom.*
`facetGroupsFromCounts` sorts the 22 families descending and then appends
**Not placed** last regardless of size (`src/lib/data.ts:2276-2288`). Under
Location=Remote that is 140 — fourth largest — sitting below Hospitality's 2.
A reader scanning a descending list sees it run 287, 281, 101, 94 … 3, 2, and
then jump to 140. That reads as a bug even though it is a deliberate choice, and
the choice is right (hiding an eighth of the sweep would be the pre-filtering
this product is named for refusing). It is the *placement* that is wrong.

*And nothing sums to the top line on screen.* The visible options total ~1,258 of
1,463 because the rest are below the fold. A count line that cannot be checked
by eye invites exactly the suspicion the owner had.

---

## 2. The real number bug: Remote is wrong, and it makes every field count wrong

This is the substantive defect, and it is bigger than the presentation problem.

The Location facet is a regex over the location **text**:

```sql
CASE WHEN j.location ~* '\yhybrid\y' THEN 'onsite'
     WHEN j.location ~* '\yremote\y' THEN 'remote'
     ELSE 'onsite' END AS facet_location
```
`src/lib/job-store.ts:220-222`

Meanwhile the `jobs` table carries a **`remote` boolean**, written by the crawl
from the ATS's own structured field. The facet never reads it.

| | rows |
|---|---|
| live rows the facet calls remote | **1,469** |
| live rows the crawl flagged `remote = true` | **4,119** |
| flagged remote, text names a city, **currently filed as on-site** | **2,650** |

**The Remote filter hides 64% of the remote board.**

It is not one bad adapter. The flag is structured-only wherever the ATS exposes
it separately from the location string:

| ATS | live | `remote=true` | text says "remote" | structured only |
|---|---|---|---|---|
| ashby | 3,964 | 2,233 | 295 | **1,986** |
| teamtailor | 3,722 | 251 | 39 | 185 |
| icims | 2,328 | 191 | 37 | 154 |
| breezy | 1,628 | 195 | 0 | **195** |
| lever | 289 | 73 | 1 | 72 |
| recruitee | 1,678 | 257 | 195 | 64 |
| greenhouse, rippling, workday, personio | — | flag == text, exactly | | 0 |
| **usajobs** | **9,940** | **20** | 20 | 0 |
| **amazon** | **2,846** | **0** | 0 | 0 |

The bottom two rows are their own finding. USAJOBS is 26.7% of this board and
publishes a `RemoteIndicator`; we record 20 remote federal jobs out of 9,940.
Amazon is 2,846 rows and we record zero remote, which is false on its face.
Those are crawl gaps on the mini, not site bugs, but they are the reason a
reader who filters to Remote sees a board that looks like it only has startups.

### What the reader loses, by field

Counting `remote = true OR text says remote`:

| Field | shown now | actually remote | |
|---|---|---|---|
| Software Engineering | 287 | **914** | 3.2× |
| Sales | 281 | **861** | 3.1× |
| Marketing & Communications | 60 | **308** | 5.1× |
| Customer Support & Success | 55 | **230** | 4.2× |
| Operations & Supply Chain | 94 | 226 | 2.4× |
| Finance & Accounting | 101 | 203 | 2.0× |
| Data & AI | 50 | **193** | 3.9× |
| Product | 65 | 183 | 2.8× |
| People & HR | 55 | 152 | 2.8× |
| IT & Infrastructure | 56 | 131 | 2.3× |
| Design | 31 | **95** | 3.1× |
| **Whole remote board** | **1,469** | **4,177** | **2.8×** |

The owner's sentence — *the numbers in the form field don't match up with the
jobs we have available* — is literally true. There are 95 remote design roles on
this board and the dropdown offers 31.

### And "on-site" is a garbage bucket

`ELSE 'onsite'` swallows everything the regex did not claim, including **192 live
rows with no location string at all** and **149 that say hybrid**. Hybrid is
filed as on-site by an explicit first branch, so a reader who wants hybrid
cannot ask for it and a reader who wants on-site is given hybrid anyway.

---

## 3. Six vocabularies, none of which talk to each other

The site answers *"what kind of work is this?"* six separate ways. Three are
reader-facing and disagree in public; three more run underneath. Start with the
three on the board.

**(a) The Field dropdown** — `derived_fam`, 22 closed families, rule-matched from
the crawled department and then the title (`src/lib/job-family.mjs`). Stored on
the row, counted in SQL, 87.7% populated.

**(b) The search box** — free text, `autocomplete="off"`, no suggestions
(`src/components/Filters.astro:165-166`), compiled to

```sql
title ILIKE $3 OR company ILIKE $3
```
`src/lib/job-store.ts:241`

It searches **title and company only**. Not the department. Not the family.
Not the description. So the two controls on the same strip disagree in both
directions:

| typed | search finds | the field says |
|---|---|---|
| `nurse` | 747 | Healthcare & Medicine: **4,430** |
| `healthcare` | 169 | Healthcare & Medicine: **4,430** |
| `design` | 676 | Design: **313** |
| `marketing` | 583 | Marketing & Comms: **868** |

Typing the *name of a field* into the search box is the most natural thing a
reader will do, and it returns a sixth of the field. Typing `design` returns
twice the Design field, because it catches Design Engineers who are software.

**(c) The Desk titles** — the member types their own titles, stored in
`ledger_watch`, matched as a whole-word phrase against the role title
(`titleKeepClause`, job-store.ts:319). A third vocabulary: the member's words,
against titles only, with no relationship to the 22 families.

A member whose Desk says "Product Designer" and whose Field filter says Design
is running two unrelated tests, and the board gives no sign of that.

---

### 3b. It is actually six vocabularies, not three

A full sweep of the repo found three more, all of them writing or reading a
"kind of job" that no other surface agrees with.

**(d) `RoleFamily` — four values, snake_case, never populated.**
`src/lib/data.ts:182` declares `'product' | 'design_engineering' | 'brand' |
'design_systems'`, carried through `Job.role_family`, `KillRecord.role_family`
and all three JSON Schemas (`schemas/jobs.schema.json:77-80`,
`kills.schema.json:44-46`, `kills-archive.schema.json:81-83`). **No migration
ever created these columns and nothing writes them.** They wait on an exporter
that never shipped. Several features are dark because of it: the family tabs and
the "More &lt;family&gt;" row on Job Detail v2
(`src/components/job-detail-v2/JobDetailV2.astro:30-32`), the "same family" list
on `/role` (`src/pages/role/[slug].astro:84`).

Note the spelling: `design_engineering` in this vocabulary, `design` in
Taxonomy A, and neither `brand` nor `design_systems` exists in `FAMILIES` at all.

**(e) `CoverField` — eight fields, applied to the member, invisible.**
`src/lib/cover-context.ts:24-32`: `tech | corporate | creative | healthcare |
sales | academic | federal | general`. `classifyField()` buckets the *posting*
and `recordField()` buckets the *person* with the same eight, and the result
picks the cover letter's vocabulary pack and even its salutation
(`posting-requirements.ts:57` — tech and creative get a warm salutation, the
rest get formal). The reader never sees this and cannot set it. It is disjoint
from the 22 families: `creative` merges Design and Marketing, `corporate` merges
Finance, Legal and Operations, `general` absorbs Hospitality, Trades and Admin.

**(f) `GROUP_DEFS` on /jobs-data — five design groups, a third spelling, and a
number that moved without anyone deciding it should.**

`src/lib/jobs-data-filters.ts:54-60` defines the five watched groups the paid
page is built on, and compares their `fam` against `jobs.derived_fam`:

| group | `fam` it tests | rows it matches today |
|---|---|---|
| Product Designer | `'product'` | **218** |
| Design Engineer | `'design engineering'` | 0 |
| Brand Designer | `'brand'` | 0 |
| Design Systems Designer | `'design systems'` | 0 |
| Design Leadership | `null` — seniority only | **2,830** |

The file's own header (`:44-52`) says *"every one of these groups matches zero
rows today… reproduced here exactly rather than fixed, because the parity check
this build has to pass compares against the old numbers. Fixing it is a one-word
change (a lower() on both sides)."*

**Both halves of that comment are now false, and db/212 is why.** That migration
changed `derived_fam` from the raw crawled department to the 22 closed ids.
`'product'` happens to be one of them, so Product Designer silently went from 0
to 218 — a page's headline number moved because a migration did not know this
column was being read this way. And the documented one-word fix no longer works:
`lower()` on both sides still matches nothing, because `'brand'`,
`'design engineering'` and `'design systems'` are not family ids in any casing.
The nearest real id is `'design'`, which holds 80 Senior/Staff rows.

Worse, **Design Leadership has no family test at all**, so it matches every
Lead or Director on the board in every field — 2,830 rows. On a page about
design titles it is counting Directors of Nursing and Legal Directors.

**This is the one thing in this audit that is actively wrong on a paid page.**

### 3c. And the reader is still shown the pre-taxonomy value

`src/pages/board/[slug].astro:196` prints the raw crawled `department` under the
label **"Team"** — the same 3,350-value field (`FLZR`, `Scaling`, `SSAs`) that
`job-family.mjs` was written to replace. So the board filters by the clean
taxonomy and the job page displays the dirty one, on the same posting.

The legacy `listJobs()` (`src/lib/job-store.ts:646`) is meanwhile the *only*
search in the repo that looks at `department` — and it is not the board's.

---

## 4. Coverage: the 12.3% that is not placed

4,578 live rows carry no family. The top of that pile is not unclassifiable
work — it is vocabulary the rules have not been taught:

| department | rows | belongs in |
|---|---|---|
| *(no department at all)* | 1,016 | title fallback already failed |
| FLZR | 126 | genuinely nothing |
| Miscellaneous Food Preparation and Serving | 23 | Hospitality |
| Sjuksköterska *(sv, nurse)* | 21 | Healthcare |
| Ärzteteam *(de, doctors)* | 21 | Healthcare |
| Küche *(de, kitchen)* | 18 | Hospitality |
| Speech Pathology And Audiology | 17 | Healthcare |
| Correctional Officer | 17 | Public Safety |
| Bygg / Anläggning / Rakennusala *(no/fi, construction)* | 52 | Trades |
| Materials Handler, Dispatching, Traffic Management | 56 | Operations |
| Loan Specialist | 17 | Finance |
| Aviation | 16 | Operations |
| Techniek *(nl)* | 22 | Trades / IT |

The module already commits to being multilingual and already carries German,
Swedish and Norwegian terms. The gap is the *next* hundred terms, mostly Nordic,
Dutch and US-federal department names, and it is ordinary maintenance against
the corpus rather than a design change.

**One upstream gap worth naming:** Workday is **3,522 live rows with zero
department recorded** — the adapter captures none. Title fallback rescues most
(only 243 Workday rows are unplaced) but every one of those 3,522 is classified
on the weaker signal.

---

## 5. Compare and contrast: how the rest of the industry does this

### The grain is already right

| system | top-level groups |
|---|---|
| US SOC 2018 major groups | **23** |
| LinkedIn job functions | **26** |
| ESCO / ISCO-08 major groups | 10 (sub-major: 43) |
| **AntiAlgo families** | **22** |

Twenty-two is not the problem. It sits exactly where the two most-used
professional taxonomies sit, and the family list maps onto SOC major groups
almost one-for-one (our Trades ≈ SOC 47/49, our Hospitality ≈ SOC 35/39, our
Public Safety ≈ SOC 33/55). If anything the module is better tuned for this
corpus than LinkedIn's is, because LinkedIn's functions were designed to
describe *members*, not postings, which is why they carry oddities like
"Entrepreneurship" and "Real Estate" as peers of "Engineering".

### So what is LinkedIn actually doing better?

Not the taxonomy. **The entry point.**

On LinkedIn the category filter is *secondary*. The primary control is a
keyword field with **title-level suggestion** backed by a standardised title
taxonomy — you type "prod" and it offers *Product Manager, Product Designer,
Production Supervisor*, each a real standardised title with a real count behind
it. The reader never has to guess whether their work is called a "field", a
"function" or a "department", because they are answering in the only vocabulary
they actually own: **their job title.**

The category dropdown then exists to catch the case the title misses.

That is the whole difference the owner is feeling as *variety*. Our board is the
mirror image: a strong, closed, well-built category control and a search box
with `autocomplete="off"` that greps two columns.

### And LinkedIn's category filter is widely considered its weakest part

Worth knowing before copying it. The standing complaint about LinkedIn's
Industry/Function filters is that choosing "Information Technology" misses roles
filed under "Internet", "Computer Software" or "Financial Services" — because
the tag is applied to the *company*, not the posting, and because a single
posting can only carry one. Our families are applied per posting and are
mutually exclusive by construction, which is the stricter and better design.
`fam=` is already repeatable in the address and the SQL already takes an array
(`board-query.ts:155`, `job-store.ts:267`); only the UI is single-choice.

### The standard we are closest to

`schema.org/occupationalCategory` asks for a term from **O*NET-SOC or ISCO-08**,
label *and* code. If the families were ever given a SOC major-group crosswalk —
a one-line addition to each entry in `FAMILIES` — the board could emit valid
`occupationalCategory` in its JobPosting markup, which is what Google for Jobs
reads. That is not a rewrite; it is 22 strings.

---

## 6. What to change

Ordered by how much of the owner's complaint each one answers, against how much
it can break.

### A. Fix the Location facet (biggest number error, smallest change)

Read the structured flag as well as the text:

```sql
CASE WHEN j.remote OR j.location ~* '\yremote\y' THEN 'remote'
     WHEN j.location ~* '\yhybrid\y'            THEN 'hybrid'
     WHEN j.location IS NULL OR btrim(j.location) = '' THEN 'unstated'
     ELSE 'onsite' END
```

Remote goes 1,469 → 4,177. Hybrid becomes askable (149). 192 rows stop claiming
to be on-site when the employer said nothing.

*Blast radius:* `facet_location` is read by the count SQL and the row query in
the same CTE, so both move together. The `location=` parameter gains two values;
`board-query.ts` allowlists them, so old bookmarks are unaffected and unknown
values already fall back to `all`. `/desk` and `/opportunities` do not filter on
location. **One file, one CASE, plus two allowlist entries.**

### A2. Fix /jobs-data's five groups (wrong on a paid page, right now)

Three of the five match zero rows against ids that do not exist; one matches
2,830 rows in every field because it has no family test; one is quietly
returning 218 rows it was never meant to return. Point them at real
`FAMILY_IDS`, give Design Leadership a family test, and re-baseline the parity
check — the old numbers it is pinned to are numbers from a defect.

*Blast radius:* the counts on `/jobs-data` will move, visibly, which is the
point. `test/` carries a parity fixture that will need re-recording. **Do this
one deliberately and tell me before it ships**, because it changes what a paying
reader sees.

### B. Put "Not placed" where its count says it goes

Sort it with the families instead of pinning it last. Keep the label and keep it
never-hidden — that decision was right. This is one line in
`facetGroupsFromCounts` and it removes the single strongest visual signal that
the numbers are broken.

### C. Say what the counts are counting

The dropdown is the only filtered number on the page. Either:
- put the reader's narrowing in the trigger label — *"Field · in 1,463 remote roles"*; or
- make the tiles and the age strip respect the filters too.

The second is the honest one and the site already has the machinery: the age
histogram query would take the same `matched` CTE. It is also the more expensive
change, and it alters a surface (the age strip) the owner has iterated on. **Ask
before doing the second.**

### D. Teach the search box the taxonomy

Two steps, independent:

1. **Search the department too.** `title ILIKE … OR company ILIKE …` becomes
   `… OR department ILIKE …`. Typing `nurse` then finds the nursing departments
   as well as the nursing titles. One clause, one index to check.
2. **Suggest.** A `<datalist>` or a small suggestion endpoint over the corpus's
   own frequent title phrases plus the 22 family labels, so typing `des` offers
   *Designer*, *Design*, and the Design field itself. This is the LinkedIn
   difference, and it is the one change that would make the board feel like it
   has the variety it actually has.

*Note:* step 2 has a hard constraint — `no-pages-api` (never create
`src/pages/api/`). A suggestion endpoint goes under `src/pages/desk/` like the
rest, or ships as a static list built at ingest.

### E. Close the coverage gap

Add the next ~100 terms to `RULES` against the unplaced corpus (§4). The test
harness already ratchets coverage at a FLOOR of 0.84 with a
no-family-above-half guard, so this is safe, measurable work. Target: 92%+.

Separately, on the mini: capture Workday's department, USAJOBS' `RemoteIndicator`
and whatever Amazon exposes for remote. Those three fix more numbers than
anything in the site code.

### F. Delete or wire the dead vocabulary

`RoleFamily` (4 values, snake_case) exists in TypeScript and in three JSON
Schemas and is written by nothing. Either point those fields at `derived_fam`
and light up the Job Detail v2 family tabs and the `/role` "same family" row, or
take them out. Leaving a declared-but-empty classification in the schemas is how
`GROUP_DEFS` ended up testing `'design_engineering'` in the first place.

Same for the seniority words: **four separate declarations** of
`['Senior','Staff','Lead','Director']` (`jobs-derived.mjs:34`,
`jobs-data-agg.ts:49`, `data.ts:185`, `public/scripts/ledger-v4-app.js:53`), a
**fifth, different** seniority regex in `cover-context.ts:93` that also claims
*partner*, *president* and *managing director* — and `TIERS` separately meaning
**account tier** in `tiers.config.mjs:12`. One export, imported everywhere.

### F2. Show the clean value on the job page

`/board/[slug]` prints the raw crawled `department` as "Team". Show the family
label there, or show both and say which is ours.

### G. One vocabulary, eventually

The end state is that the Desk titles, the search box and the Field filter are
three doors into **one** vocabulary: a member's Desk title resolves to a family,
the search box suggests from the same list, and the board can say *"your Desk
titles sit in Design and Product — 313 and 799 roles"*. That is a design
decision, not a refactor, and it should be specced before it is built.

---

## 7. What not to change

- **The 22 families.** The grain is right, it matches SOC and LinkedIn, and it
  is tuned to this corpus. Nothing here argues for more or fewer.
- **Rules, not a model.** The module's stated reason holds: this value decides
  what a member is *not* shown, and a member who disagrees must be able to see
  which word decided it. A model call would also put a provider in the nightly
  ingest path, which `ingest-on-build.mjs` exists to keep out.
- **NULL as a real answer.** No `Other` bucket. A gap the employer left is shown
  as a gap.
- **Mutually exclusive, per posting.** This is stricter than LinkedIn and better.

---

## Appendix: where each number came from

Every figure above was counted against the local `antialgo_dev` copy on
2026-09-28, 37,286 live rows. The board's family distribution:

```
software      5456  14.6%      finance        1421   3.8%
(unplaced)    4578  12.3%      customer       1044   2.8%
health        4430  11.9%      marketing       868   2.3%
sales         3503   9.4%      product         799   2.1%
operations    2654   7.1%      legal           725   1.9%
it-infra      2109   5.7%      social-care     718   1.9%
admin         1767   4.7%      education       707   1.9%
trades        1640   4.4%      data-ai         697   1.9%
hospitality   1494   4.0%      people          681   1.8%
                              security         507   1.4%
                              public-safety    475   1.3%
                              manufacturing    379   1.0%
                              science          321   0.9%
                              design           313   0.8%
```

Family source: department 25,241 · title 7,467 · none 4,578.

---

## Appendix B: the full surface sweep

Every place in the product where a reader picks or sees a kind of work, and
which vocabulary it uses.

| Surface | Vocabulary | Agrees with the 22 families? |
|---|---|---|
| Board **Field** select (`data.ts:2276`, `Filters.astro:202`) | A — 22 families | **Yes** — the only reader-facing surface that does |
| Board **search** (`Filters.astro:165`, `job-store.ts:242`) | none — raw `title`/`company` substring | No |
| Board **Titles menu** (`Filters.astro:179`) | member free text | No, by design |
| `/` home teaser strip (`index.astro:78`) | A | Yes |
| `/prelist` filter strip (`data.ts:2346`) | **no Field group at all** | n/a |
| `/prelist` prospect cards (`ProspectCard.astro:48`) | F — free-text company `industry` | No |
| `/desk` watch editor (`WatchList.astro:63-88`) | member free text; copy at `:66` explicitly refuses a category list | No, by design |
| `/start` steps 3–4 (`StepTitles.astro:112`, `:172`) | member free text, same `ledger_watch` | No |
| `/jobs-data` watch/cut editor + search (`jobs-data-filters.ts:54`, `ledger-v4-app.js:259`) | C — five hardcoded design groups | **No — and three of five match nothing** |
| `/jobs-data` kill-archive "cut to your families" (`ledger-v4-app.js:497`) | label only — `board_kills` has **no** `derived_fam` column | No |
| `/jobs-data` provenance note (`ledger-v4-app.js:643`) | names B by name | Contradicts A |
| `/board/[slug]` "Team" row (`board/[slug].astro:196`) | raw 3,350-value `department` | No — shows the value A replaces |
| `/role/[slug]` (`:84`) | B — omitted, unpopulated | n/a |
| Job Detail v2 family tabs (`JobDetailV2.astro:30-32`) | B — omitted, unpopulated | n/a |
| Draft room / tailor (`tailor.ts:1275`, `posting-requirements.ts:170`) | **D — eight cover fields**, invisible, sets the salutation | No |
| `/opportunities` | none — groups by application fate | n/a |
| `/profile` (`profile.astro:310`) | `ENTRY_KINDS`, not job kinds. **The member is never asked what field they are in.** | n/a |
| `/sign-up`, `/waitlist`, `/how-it-works` | none | n/a |

### Classification columns that exist

`jobs.department` (raw, 3,335 distinct) · `jobs.derived_fam` (A, 87.7% filled) ·
`jobs.derived_fam_source` (`department` 25,241 / `title` 7,467) ·
`jobs.derived_tier` (**79.6% NULL** — only Senior/Staff/Lead/Director, no
entry/mid band, so seniority is not yet filterable) ·
`jobs.derived_region` (**56.5% "Unknown"**) · `jobs.derived_friction` ·
`board_kills.derived_tier` (but **no** `derived_fam`) ·
`ledger_watch.shelf` (`core`/`stretch`, storing a free-text title).

### Columns that do not exist but are declared

`role_family`, `role_family_source`, `tier`, `tier_source` — TypeScript and
three JSON Schemas, no migration, no writer.

No `category` or `discipline` column exists anywhere. The only `categories`
value the crawl sees is Lever's `categories.team`, read and deliberately
discarded at `src/lib/posting-resolvers.ts:426-432`.
