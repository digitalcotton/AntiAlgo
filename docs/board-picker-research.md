# The board's pickers: what we have, what the field does, what to build

Status: **research only. Nothing in here has been built.**
Written 2026-10-01 (sev 1). Restructured after the owner noted that the first
pass ignored geography entirely — which turned out to be the larger finding.

Three questions, not one:

1. Which control is the reader meant to use to pick a field, and why are there two?
2. **Where is geography?** The board is multinational and has no country or
   region control at all.
3. What should a world-class picker for this board actually be?

---

## 1. The control inventory, and what each one really filters

| Strip control | Looks like | What it actually filters | Mechanism |
|---|---|---|---|
| Search box | input + suggestions | free text over title/company | native `<input type=search>` + **native `<datalist>`** |
| Titles | chevron menu | the member's own saved titles | checkboxes in a custom panel |
| Field | styled dropdown | occupational family (22) | real `<select>` + **custom listbox** drawn over it |
| **Location** | styled dropdown | **work arrangement — remote / hybrid / on-site / not stated** | real `<select>` + custom listbox |
| Comp | styled dropdown | pay band | real `<select>` + custom listbox |
| Sort, Dim seen | links / toggle | ordering, dimming | — |

**The control labelled LOCATION does not filter location.** It filters how the
work is done. A reader who wants "jobs in the UK", "jobs in Maryland" or "jobs in
Bangalore" has no control on this page at all — and the board carries all three.

LinkedIn names this same control **Remote**, and keeps Location as a separate
geography field. We gave the arrangement filter the geography filter's name, and
then shipped nothing behind the name.

NN/g's [filter categories and values](https://www.nngroup.com/articles/filter-categories-values/)
guidance is that category labels must be concrete and precise, and warns against
vague ones. Ours is not vague, it is **wrong**: it promises a dimension it does
not filter.

---

## 2. The geography gap, measured

The schema already has the columns. `jobs` carries `location` (free text),
`country`, and `derived_region`. `job-store.ts` even compiles a country matcher:

```
($9::text IS NULL OR country = $9::text) AS match_country
```

**Nothing in the UI ever sets it.** `country` does not appear in
`board-query.ts`, `Filters.astro` or `board.astro`. The filter exists in SQL and
is unreachable from the page.

### Why we cannot simply switch it on

Measured against the live board (37,286 rows, status ≠ killed):

| | rows | share |
|---|---|---|
| total live | 37,286 | — |
| **no `country` value** | **21,573** | **58%** |
| distinct countries present | 25 | — |
| no `location` **text** | 192 | 0.5% |

A country filter built today would be blind to 58% of the board. But the raw
location text is present on 99.5% of rows — so this is an **extraction problem,
not a collection problem**. The geography is sitting in a string we already hold.

### `derived_region` is worse than missing — it is wrong

| country | derived_region | rows |
|---|---|---|
| `(null)` | Unknown | 16,080 |
| **US** | **US West** | **9,063** |
| `(null)` | US East | 1,653 |
| **CA** | **US West** | **979** |
| **GB** | **Unknown** | **891** |
| **FR** | **Unknown** | **709** |
| `remote_unresolved` | US West | 690 |

Canada is classified as **US West**. The United Kingdom and France are
**Unknown**. And every single US row is "US West", so the column is not
sub-regioning the US at all — it is defaulting. Two geography columns that
disagree, and the derived one cannot be trusted by anything.

Any location control has to stand on repaired data. That is step one of step two.

---

## 3. The two field pickers (the original question)

Both of these let a reader land on a field, by two different mechanisms, with two
different numbers.

**A — the search box's suggestions.** `Filters.astro:166`. A **native
`<datalist>`** of 312 entries: 290 keyword shortcuts and **22 field names**. The
browser draws and filters it, and the page **cannot style it** — that is the
"system dropdown with a long scroll". It was chosen deliberately to avoid a
custom combobox, after the Safari/Firefox press that blurred its own field
(`.claude/rules/dropdown-focus.md`).

**B — the Field control.** `Filters.astro:252`. A real `<select>` as the source
of truth with a custom button+listbox drawn over it: label left, count right.
That is the one that looks right.

Three measured defects:

1. **The counts answer different questions.** `Sales field · 3,640` counts the
   whole board; `IT & Infrastructure 48` counts within the reader's current
   filter. Same concept, two populations, nothing says so.
2. **"Sales" appears twice** — the only duplicate visible value in the 312: once
   as a field (3,640), once as a keyword (3,063).
3. **Picking a field in the search box is a silent 302.** `board.astro:74` throws
   the query away and sets the Field filter. The typed word vanishes and the page
   never says a scope was applied.

---

## 4. What the largest job sites actually do

Inspected directly in a browser on 2026-10-01 by reading each page's DOM, not by
taking a blog's word for it.

| | keyword field | geography field | arrangement filter | native `<select>` | `<datalist>` |
|---|---|---|---|---|---|
| **Indeed** | custom combobox | custom combobox, own typeahead | separate **Remote** facet | 0 | 0 |
| **LinkedIn** | custom combobox | custom combobox, own typeahead | separate **Remote** facet | 0 | 0 |
| **Glassdoor** | custom combobox | custom combobox | facet buttons | 0 | 0 |

**None of the three uses a native `<select>` or a `<datalist>` anywhere in the
search strip.** Every control is custom, so every control is theirs to style.
That is the structural reason our two controls cannot be made to match.

### Keyword suggestions are query completions, nothing else

Typed `des` into Indeed's job search box:

```
design · desk · desktop support · designer · desk job no experience ·
desktop support technician · design engineer · design assistant ·
desk receptionist · desktop support specialist
```

Every entry is a string you could have typed. **No categories. No counts. One
kind of thing in the list.** Categories exist on Indeed, on the results page, as
"Similar job categories" and "Jobs with similar titles".

### Geography is its own field, with its own gazetteer

Typed `lon` into Indeed's location box:

```
Longview, TX · London, KY · Long Beach, CA · Long Island, NY · Longmont, CO ·
Longwood, FL · Long Island City, NY · London, OH · Long Beach, MS · Long Branch, NJ
```

City + state, ranked, from a geographic gazetteer. Not a dropdown of options — a
typeahead over a large place vocabulary, which is the only way to pick from a set
nobody can enumerate.

### Two different answers to "multinational"

- **Indeed: one site per country.** indeed.com is the US site; the nav carries a
  🇺🇸 locale switcher, and the location typeahead returns only US places. Country
  is chosen *before* search, by changing site.
- **LinkedIn: one global site.** A single location typeahead covering the world,
  and it accepts **`location=Worldwide`** as an explicit scope. Rows render place
  and arrangement together — "Solana Beach, CA (On-site)", "(Remote)",
  "San Francisco Bay Area (Hybrid)".

AntiAlgo is one global site with a 25-country corpus, so **LinkedIn's model is
the relevant one** and Indeed's is not available to us.

### Arrangement is a separate, multi-select filter

LinkedIn's **Remote** filter opens to exactly:

```
[ ] On-site   [ ] Hybrid   [ ] Remote
```

Checkboxes — **multi-select**. Ours is single-select and misnamed.

### An honest note: even Indeed has our redundancy

Indeed's location placeholder is `City, state, zip code, or "remote"` *and* there
is a separate Remote facet. So the biggest site in the world also has two ways to
say remote. The lesson is not that the big sites are flawless; it is that they
separate **place** from **arrangement** as distinct controls, and keep the
keyword box free of scope entries.

---

## 5. What the research says

### Our two field pickers are a named anti-pattern

NN/g's [Scoped Search: Dangerous, but Sometimes Useful](https://www.nngroup.com/articles/scoped-search/)
describes exactly two implementations of scoped search — **drop-down scope
selection** (our Field control) and **autocomplete scope suggestions** (our 22
field names in the datalist). We ship both, for the same dimension.

Findings that land on us:

- **Users overlook scope selectors.** "Most often, they start typing in the
  search box and click Go without bothering to look around for drop-downs or
  autosuggestions." Returning users "often overlook the previously selected scope".
- Scoped search forces a premature decision and raises cognitive load.
- **Single selection is named as a limitation** when a reader wants two categories.
- Unclear or overlapping labels add strain.

Recommendations: default the scope to everything; strong cues near the box **and
on the results page**; the unscoped query as the **default** autocomplete option;
and **multiselect filters on the results page rather than a pre-search scope**.

### Scope-in-autocomplete is valuable but conditional, and we fail the condition

[Baymard on search scope](https://baymard.com/blog/search-scope): searching within
a category "dramatically" improved result quality and success rates, and the best
moment to offer it is while someone is typing. But scope entries must be
**visually distinct** — different colour, italics, indentation, a separator — or
"they'll be overlooked by many users". And a defaulted narrow scope was linked to
outright site abandonment.

**A native `<datalist>` cannot be styled at all.** The one mandatory condition for
the pattern is unreachable in the mechanism we chose.

### Filters over large sets

- Counts beside filter options are "one of the single highest-impact improvements
  you can make to a filter UI" ([Baymard](https://baymard.com/blog/ecommerce-filter-ui)) —
  which supports counts on the Field/Location controls, not necessarily in the
  keyword suggestions.
- Large value sets want **hierarchy**: broad values first, specifics after
  selection ([NN/g](https://www.nngroup.com/articles/filter-categories-values/)).
  Geography is the canonical case — country → region/state → city.
- Applied filters need an explicit overview so a reader can see and undo what is
  narrowing them ([Baymard](https://baymard.com/blog/how-to-design-applied-filters)).

---

## 6. The shape this points to

Separate the three dimensions the board actually has, and give each one control:

1. **Keyword** — the search box. Query completion only. The 22 field names come
   out of the suggestion list; they are the half of the overlap that research
   supports least and that our mechanism can style least.
2. **Place** — a new geography control, typeahead over a gazetteer, with an
   explicit "Worldwide" scope, hierarchical (country → region → city). Blocked
   on the data: 58% of rows have no country, and `derived_region` is wrong.
3. **Arrangement** — today's "Location" control, **renamed** (LinkedIn calls it
   Remote; "Workplace" also reads) and made **multi-select**.
4. **Field** — stays as the one place a field is chosen, and becomes multi-select.
   The URL already takes repeated `fam=` and the SQL already takes an array; only
   the control is single-choice.
5. **The silent 302 becomes visible or goes.** If typing a field name keeps
   working, the page says so with an applied-filter chip.

The styling split is the deeper problem underneath all of it: two renderers means
two visual languages, and the three biggest sites use zero native pickers for
exactly that reason. Closing it means a custom combobox for search — which is the
bug this repo already paid for once, and that cost must be counted honestly, not
waved at.

---

## 7. Decisions, made 2026-10-01

| | decision |
|---|---|
| **Geography data** | **Derive it properly.** `derived_region` does not get to call Canada "US West". Repaired or retired before any control ships on it. |
| **Rename** | The arrangement filter is **Remote**, LinkedIn's word. Not "Workplace". "Location" is freed for geography. |
| **Counts** | **Kept, on every option — and they must be accurate and stay accurate.** That makes the one-population rule an engineering invariant, not a preference. |
| **Preview first** | No implementation until the strip has been seen in the site's own style. Preview rendered 2026-10-01; see below. |
| **Layout** | Goes out as a master design prompt: `board-filters-design-prompt.md`. |

Still open, carried into the design prompt rather than settled here: whether Field
and Remote become multi-select, and whether the search suggestions keep their
native `<datalist>` (unstylable, but free of the focus bug) or become a custom
combobox (stylable, but re-pays the bug).

### The preview

Rendered by cloning the real cells on the real board, so it carries the site's own
styling exactly rather than a lookalike:

```
⌕ Title, company or field │ FIELD All fields ⌄ │ LOCATION Worldwide ⌄ │ REMOTE All ⌄ │ COMP All ⌄ │ SORT Comp Age │ DIM SEEN on
```

With Location open at country level, counts measured from the board:
Worldwide 37,286 · United States 9,063 · Canada 979 · United Kingdom 891 ·
France 709 · Germany 585 · India 364 … and `Not stated` 21,573 last.

Images: `strip-closed-{dark,light}.png`, `strip-open-{dark,light}.png`.

### The counts invariant this creates

"Accurate and stay accurate" is only true if it is enforced, so it is written down
as a rule rather than an intention: **every count in the strip is leave-one-out
over the current result set, and no two controls may count different populations.**
Today they do — the search suggestions count the whole board while the Field
dropdown counts the filtered set, and "Sales" carries 3,640 in one and a different
number in the other. That is the thing that has to stop, and it wants a gate.

---

## 8. The Field taxonomy is wrong, and reordering cannot fix it

The owner's reading — "too much overlap for it to be useful" — is correct, and it
is measurable. This section is the measurement.

### What the classifier actually is

`src/lib/job-family.mjs` is **first-keyword-match-wins over a hand-ordered list**:
50 rule groups, 599 terms, matched against the department first and the title
second. The file states the mechanism plainly: *"ORDER IS THE WHOLE ALGORITHM."*

### Measured over all 37,286 live rows

| | rows | share |
|---|---|---|
| match **no** family (→ "Not placed") | 2,529 | 6.8% |
| match **exactly one** | 18,357 | 49.2% |
| **match two or more** | **16,400** | **44.0%** |

For 44% of the board the stored family is decided **by list position alone**. The
distribution has a long tail: 3,705 rows match three families, 978 match four,
382 match five, and one row matches eight.

And where a row carries both a department and a title, **the two disagree about
the family 23.5% of the time** (7,486 of 31,918).

### Three named defects, each reproducible

**1. `'counsel'` is in two rules.** It appears in `social-care` (line 154) and in
`legal` (line 234). social-care comes first, so:

```
Corporate Counsel  ->  Social & Community Care
General Counsel    ->  Social & Community Care
```

Every lawyer whose title says Counsel is filed as social care. That is a
duplicated term, not a judgement call.

**2. Prefix matching invents matches.** `PREFIX_MIN = 5` lets a term match the
start of a longer word, so `' sales'` matches `' salesforce'`:

```
Salesforce Administrator  ->  Sales          (96 live rows carry "Salesforce")
Data Center Technician    ->  Data & AI      (' data' prefix-matches "data center")
```

**3. The result is unstable across near-identical jobs.**

```
Salesforce Administrator  ->  Sales
Salesforce Developer      ->  Software Engineering
```

Same product, same team, two different families, decided by which rule happens to
sit higher in the file.

### The top collisions

| rows | the two families both matched |
|---|---|
| 1,818 | IT & Infrastructure + Software Engineering |
| 1,099 | Software Engineering + Trades & Maintenance |
| 1,086 | Sales + Software Engineering |
| 1,047 | Operations & Supply Chain + Software Engineering |
| 966 | Administration & Business Support + Software Engineering |
| 958 | Product + Software Engineering |
| 940 | Customer Support & Success + Operations & Supply Chain |

### Why reordering is not the fix

Reordering moves the errors; it does not reduce them. 44% of rows genuinely carry
signals from more than one family, and **any total order over a single-label
taxonomy is wrong for whichever families it did not pick**. The defect is not the
order, it is that one stored label cannot represent what 44% of the corpus is.

---

## 9. What the field does instead

**Standard taxonomies exist, and they are hierarchical.** ISCO-08 is the
international classification; [ESCO](https://esco.ec.europa.eu/) extends it with
3,008 occupations across 28 languages, its first four levels mapping exactly onto
ISCO; O*NET-SOC covers 923 occupations for the US and
[crosswalks to ESCO](https://esco.ec.europa.eu/system/files/2022-12/ONET%20ESCO%20Technical%20Report.pdf).
A hierarchy is what lets "Salesforce Administrator" sit under IT with a parent
rather than compete with Sales for one slot. ESCO's multilinguality matters here
specifically: our rules already hand-roll German, Dutch and French terms
(`logistik`, `recht`, `bezorger`, `vertriebsaußendienst`) — a multilingual
occupational vocabulary we are rebuilding badly and that ESCO already publishes.

**The industry abandoned this approach.** Rule bases and TF-IDF similarity gave
way to transformer embeddings. ZipRecruiter, a board of our category, published
that moving off its previous solution produced
[about a 20% overall accuracy increase](https://www.ziprecruiter.com/blog/classifying-job-titles-at-ziprecruiter/).
[JAMES](https://arxiv.org/abs/2202.10739) reports +10.06% Precision@10 over the
best baseline; [VacancySBERT](https://arxiv.org/pdf/2307.16638) +10–21.5%. The
production pattern is two layers: a fast dictionary/fuzzy layer, and an accuracy
layer over embeddings.

**And the big boards do not lead with the taxonomy.** Indeed's primary mechanism
is the search box; categories appear on the results page as "Similar job
categories", a refinement rather than the way in. That is the owner's own
instinct — *other places let you search and root it out* — and it is what the
largest site in the world actually does.

---

## 10. The conclusion

**Is the file wrong? Yes.** Not stylistically: it files corporate lawyers under
social care and Salesforce admins under Sales, and for 44% of the board the
answer it stores is an artefact of line numbers.

Three honest options.

**A. Build it properly.** Map to ESCO/O*NET, allow a row to carry more than one
family, classify with embeddings and keep the keyword table as the fast layer.
This is the correct destination and it is real work — a model, a crosswalk, an
evaluation set, and a ratchet to hold accuracy.

**B. Demote the control.** Search leads; Field becomes a secondary refinement on
the results page, as it is on Indeed. Cheap, immediate, and honest about what the
classification is worth.

**C. Remove it until it is accurate.**

**The deciding argument is the product's own covenant, not taste.** This site
says: readings, not claims; nothing modelled; a gap is shown as a gap. A dropdown
that prints `Sales 3,640` asserts a precision the underlying classification does
not have — 44% of those rows matched another family just as well. By this
product's own standard, **printing that number is the violation**. Not the missing
feature.

So: **B now, A as the real fix, C if neither is funded** — because a confident
wrong number is the one thing this product has always said it would not ship.

### Two repairs worth making whatever is decided

Both are bugs rather than design trade-offs, and both are small:

1. `'counsel'` is duplicated across the `social-care` and `legal` rules. Remove it
   from one. Today it sends every Counsel title to social care.
2. Prefix matching should not fire where a term is the prefix of an unrelated
   common word. `sales`/`salesforce` and `data`/`data center` are the two measured
   cases; there are likely more, and the measurement script finds them.

---

## Method and limits

Sites were inspected live on 2026-10-01 by reading the DOM and driving the real
controls, not from secondary write-ups. **Indeed** and **Glassdoor** were
inspected signed-out; **LinkedIn** signed-in. **SEEK**, **Dice** and
**ZipRecruiter** were behind bot walls and could not be read — their patterns are
not represented here. No Chinese or Indian boards (Naukri, 51job) were inspected,
which is a real gap for a product claiming multinational coverage.

The taxonomy measurement in sections 8 and 9 re-applies the module's own matcher
to every live row, counting **every** family a row matches rather than the one
list order assigned. The rule table is module-private, so it is parsed out of the
source text; the parse recovered 50 rule groups and 599 terms, and the per-row
first-match results were checked against `familyOf()` directly.

Board figures are from the local development database, which is a copy of the
nightly crawl, not production. The proportions are what matter and they are
unlikely to differ materially, but they have not been checked against production.
