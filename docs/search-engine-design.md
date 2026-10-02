# The search engine: one box, stated facts, honest counts

Status: design, complete end to end. Nothing built. Written 2026-10-02 after the
research in `board-picker-research.md`, which holds the evidence this rests on.

## The idea

**One box. You type what you want in plain words. The box recognises the facts
the employers actually stated — title, company, place, pay, remote, age — and
turns each into a chip with a count. Nothing in the filter is guessed.**

```
⌕ product designer   [London, UK 406]  [remote 4,169]  [$150k+ 1,483]   →  61 roles
```

Every number on screen is counted from postings verified at the employer's own
page last night. Every ranking rule is shown on the row it ranked. No inferred
category sits anywhere a count sits.

That is the product sentence and the press sentence: **the job search that
doesn't guess.** Indeed infers nothing in its filter bar either, but it cannot
say "verified last night" about a single row. LinkedIn can say neither.

---

## 1. Why this beats the field

| | Indeed | LinkedIn | this design |
|---|---|---|---|
| what + where | two boxes, decided before search | two boxes | **one box**, place is a chip |
| liveness | unknown | unknown | **verified nightly, kill on the record** |
| counts | none in search; some in facets | some | **on every suggestion and every chip, leave-one-out, exact** |
| categories | navigation links, not a filter | facet | **navigation links, not a filter** |
| ranking | opaque | opaque | **deterministic, shown per row** |
| multinational | one site per country | one global site | one global site, place resolved from text |

NN/g's scoped-search research names the two-box "what / where" split as a
forced premature decision. Nobody at scale has collapsed it, because nobody at
scale has a result set small and clean enough to count honestly on every
keystroke. Ours is ~37,000 rows that change once a night. That constraint is the
advantage: **everything can be counted exactly and cached until the next sweep.**

---

## 2. The box

One `<input type="search">`, full width of the strip's first cell, the existing
magnifier glyph, placeholder `Try "senior designer london remote 150k"`.

### What typing does

The server parses the text into **facts** and **words**:

| you type | becomes |
|---|---|
| `london` | place chip: London, UK · 406 |
| `remote` | remote chip · 4,169 |
| `150k`, `$150k`, `150k+`, `150-200k` | pay chip: $150k+ · 1,483 |
| `this week`, `today`, `new` | age chip: posted ≤ 7d |
| `figma` | company chip: Figma · 14 (when it matches a company exactly) |
| `product designer` | words: title search |
| `@greenhouse` | ATS chip (power users; never suggested unprompted) |

Anything not recognised as a fact is a word, and words search the title and the
description. A token that *could* be a fact (`london` is also a word) is offered
both ways in the typeahead; nothing is converted silently. **The silent 302 that
turns a field name into a filter today is the behaviour this replaces.**

### Chips

A recognised fact becomes a chip inside the box, left of the caret. Each chip
carries its count. Backspace at the caret removes the last chip; ✕ removes any.
Chips are the applied-filter overview Baymard asks for, and they are the URL:
every chip is a query parameter, so every search is a link.

### The strip beside it

The box does not replace the strip; it absorbs the guessed control and leaves the
stated ones:

```
⌕ [chips] words…  │ REMOTE All ⌄ │ COMP All ⌄ │ SORT Deets Comp Age │ DIM SEEN on
```

- **Field is gone from the strip.** It was the only control filtering on an
  inference (see `board-picker-research.md` §8: 44% of rows ambiguous).
- **Location is the place chip**, not a dropdown — 7,640 distinct place strings
  is a typeahead problem, not a list.
- **Remote** stays as a dropdown because it has four fixed answers and a reader
  may want to see all four counts without typing.
- **Comp** stays for the same reason.

The dropdowns and the chips are the same filters; choosing Remote in the dropdown
places the chip, and removing the chip resets the dropdown. One state, two
handles.

---

## 3. The typeahead

Opens on the first character. Grouped, so a place never looks like a title —
which is the exact condition Baymard found scope suggestions fail without, and
which a native `<datalist>` cannot meet.

```
PLACES
  London, UK                 406
  London, KY                   3
TITLES
  product designer           120
  product design manager      38
COMPANIES
  Londonderry Mills            2
FACTS
  remote                   4,169
```

- Label left, count right, mono, in the site's own menu style (the Field menu
  today is the reference drawing).
- Groups are the four fact types plus Titles. A group with nothing in it is
  not drawn. A zero-count option is drawn and disabled, never hidden.
- Keyboard: ↑↓ move across groups as one list; Enter commits the highlighted row
  as a chip (or, with nothing highlighted, submits the words); Esc closes; Tab
  commits and moves on.
- **Counts are leave-one-out over the current result set**, so they are what
  you will get, not what the board holds. "London, UK 406" means 406 after
  every other chip already applied.
- Mouse: `mousedown` on a row calls `preventDefault()` so the field never loses
  focus — the Safari/Firefox race this repo already documented
  (`.claude/rules/dropdown-focus.md`). That rule is why a custom combobox is
  affordable now: the bug is known and the fix is one line.

### Why a custom combobox, and what it costs

The three largest boards use zero native pickers. A datalist cannot group, cannot
style, cannot show counts in the site's face, and cannot be keyboard-ordered
across groups. The cost is owning focus and ARIA ourselves: `role="combobox"`,
`aria-expanded`, `aria-activedescendant`, `role="listbox"` / `role="option"`
with `aria-selected`, and the `mousedown` guard. The existing Filters.astro
menu script already does most of this for the dropdowns; the typeahead reuses
it rather than growing a second implementation.

---

## 4. Ranking, and showing it

Deterministic. No learned relevance, no personalisation the reader cannot see.
In order:

1. **Fit**, when signed in (the existing `detail_total`).
2. **Head start** — position on the arrival curve (the existing `age_days`).
3. **Pay stated** before pay not stated.
4. **Text match quality** — title match before description match, phrase before
   scattered words.
5. Company name, then id, so ties are stable.

Every row already has a `why ▾`. It gains one line: *"ranked 3rd: fit 97, inside
the first 48 hours, pay stated."* That is the anti-algo promise made literal.
Readers can change the order with SORT; the shown reason follows the sort.

---

## 5. Architecture

Postgres does all of it. No search service, no vector database, no new
infrastructure. At 37,000 rows that is not a compromise; at 500,000 it still
would not be.

### 5.1 Text search

```sql
ALTER TABLE jobs ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', unaccent(coalesce(title,''))),       'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(company,''))),     'B') ||
    setweight(to_tsvector('simple', unaccent(coalesce(department,''))),  'C') ||
    setweight(to_tsvector('simple', unaccent(coalesce(description,''))), 'D')
  ) STORED;
CREATE INDEX jobs_search_idx ON jobs USING gin (search) WHERE status <> 'killed';
CREATE INDEX jobs_title_trgm_idx   ON jobs USING gin (title gin_trgm_ops);
CREATE INDEX jobs_company_trgm_idx ON jobs USING gin (company gin_trgm_ops);
```

- `tsvector` with weights: a word in the title outranks the same word in the
  description. `ts_rank` gives the text-match component of §4.
- `pg_trgm` gives prefix and fuzzy matching for the typeahead: `desi` finds
  "designer" and "Design Lead"; `prodct` finds "product".
- `unaccent` so `Vertriebsaußendienst` and `Vertriebsaussendienst` are one word.
- `'simple'` dictionary, not `'english'`: titles are multilingual and stemming
  English would mangle the rest. Both extensions are available on Neon and
  locally (checked).

This replaces `title ILIKE '%q%' OR company ILIKE '%q%'`, which has no index and
no ranking.

### 5.2 Places: the gazetteer

The board carries a location string on 99.5% of rows but a resolved country on
42%. The strings number **7,640 distinct**. That is the whole job.

```
place(id, country, admin1, city, name, aliases[])          -- the gazetteer
job_place(job_id, place_id, resolved_from, confidence)     -- one row per posting
```

- Seed from GeoNames (public domain) for the countries present; load only what
  the 7,640 strings need, not 12 million rows.
- Resolve each distinct string once, on the Mac mini, in the nightly pipeline:
  exact alias → trigram nearest with a confidence floor → otherwise unresolved,
  stored as unresolved, shown as "Not stated". New strings resolve nightly; on
  these numbers that is dozens, not thousands.
- `derived_region` is **retired**, not repaired: it is a lossy copy of what
  `job_place` now holds properly. Nothing may read it after the migration.
- A remote posting with no place is `Worldwide`, which is a chip and a fact, not
  a country.

### 5.3 The facts table

One materialised view, rebuilt after the sweep, so every count reads one place:

```
posting_facts(job_id, title, company, place_id, country, remote_kind,
              pay_min_k, pay_max_k, posted_on, first_seen, age_days, ats,
              department, search tsvector)
```

Every chip is a predicate on this view. Every count is `count(*)` over it with
every other chip applied — the leave-one-out the board already does for the
dropdowns, now for every suggestion too.

### 5.4 The parser

Server-side, deterministic, no ML. `parseSearch(text, currentChips) →
{ chips[], words[] }`.

- Tokenise on whitespace; keep quoted phrases.
- Try each token and each adjacent pair against, in order: pay patterns
  (`\$?\d{2,3}k\+?`, ranges), age words, `remote|hybrid|onsite|on-site`,
  company exact match, place alias exact match.
- A token that matches a fact is still kept as a word candidate; the typeahead
  offers both and the chip wins only when chosen or when the token matches
  **exactly one** fact and no title word. `london` therefore suggests the place
  and searches the word; `remote` becomes a chip outright.
- Tested by a table of `input → expected parse`, one line per rule, so a change
  to the parser is a diff a reviewer can read.

### 5.5 The suggest endpoint

`GET /board/suggest?q=…&<current chips>` → grouped suggestions with counts.

- Debounced 80 ms client-side; answered from Postgres in one statement that
  unions the four fact lookups with `LIMIT 8` each and counts each candidate
  leave-one-out.
- **Cached by (q, chips) until the next sweep.** The result set changes once a
  night, so the cache key includes `sweptAt`; nothing is ever stale and nothing
  is recomputed twice. This is the structural advantage over the big boards:
  their data moves constantly, so they cannot count; ours moves nightly, so we
  can count everything.
- Lives beside `/board`, not under `/api` (the root `api/` directory shadows
  Astro routes — `.claude/rules` and the registry both say so).

### 5.6 State and degradation

- **The URL is the state.** Chips are query parameters, which the board already
  does for its filters. Back button, share, bookmark, alert — all free.
- **No JavaScript**: the box is a real `<input name="q">` in the real form; the
  parser runs on submit and places the chips server-side. The typeahead and
  the in-box chips are enhancement. The repo's rule that every control works
  without script holds.
- Phone: same box, the panel is full-width, groups collapse to the first three
  rows each with "more".

---

## 6. Categories, honestly

Field leaves the strip and comes back as **navigation**, the way Indeed does it:
under the results, "In the same field: Design (1,276) · Product (796)". The
counts there are counts of a *classification*, and the label says so.

The classification is rebuilt separately (`board-picker-research.md` §10): ESCO
taxonomy, a row may carry several families, keyword table for the unambiguous
49%, meaning-based matching for the rest, and a gate on a hand-labelled set. It
returns to being a *filter* only when the gate says it is accurate, and it
never returns to the primary strip.

---

## 7. The counts contract, enforced

The owner's rule — counts must be accurate and stay accurate — becomes three
invariants with a gate each:

1. **One population.** Every count in the strip, the typeahead and the chips is
   computed over `posting_facts` with the same chip set. A test asserts that the
   sum of a group's option counts equals the group's total.
2. **Leave-one-out.** A test applies a chip and asserts the row count equals the
   count the suggestion showed.
3. **Nothing stale.** The cache key is the sweep instant; a test asserts a
   suggestion answered after a new sweep carries the new instant.

These join the existing `npm run conform` gates rather than living beside them.

---

## 8. Phases

| phase | deliverable | depends on |
|---|---|---|
| **0 — data** (days) | gazetteer + `job_place` for 7,640 strings; `derived_region` retired; `counsel` and prefix bugs fixed; tsvector/trgm/unaccent migration | nothing |
| **1 — engine** (1–2 wks) | `posting_facts`; parser with its table test; `/board/suggest`; search by `ts_rank`; Field off the strip; Remote renamed; place as a chip | 0 |
| **2 — box** (1–2 wks) | the combobox typeahead, grouped, with counts; chips in the box; keyboard; phone pass; counts contract gates | 1 |
| **3 — ranking shown** (days) | the "ranked because" line in `why ▾`; sort follows | 1 |
| **4 — categories back** (scoped separately) | ESCO classification, multi-label, gated; "in the same field" links | 0, gate |

Phase 0 is pure repair and is worth doing whatever happens to the rest.

---

## 9. What we will be able to say, and prove

- Every role was verified at the employer's own page last night.
- Every number beside a choice is exact, counted that night.
- Nothing in the filter is a guess about what a job is.
- The order is a rule you can read, on every row.
- One box. Type it the way you'd say it.

Each line has a gate behind it in §7 or in the existing conform run. The press
line is the first and the last together.

---

## 10. What I do not know yet

- **GeoNames resolution rate.** 7,640 strings include free text like
  "Andrews AFB, Maryland" and "San Francisco Bay Area (Hybrid)". I expect most
  to resolve on alias + trigram; I have not run it. Phase 0 is the spike.
- **Description coverage.** The weighted tsvector assumes `description` is
  populated for most rows. Not yet measured.
- **Phone typeahead.** The grouped panel is designed for 1440; the 390 pass
  needs a drawing before it is coded.
- **Neon query cost** for the leave-one-out counts on every keystroke. The
  nightly cache makes it bounded, but the first-hit latency of each new (q,
  chips) pair needs measuring against the owner's patience rule.
