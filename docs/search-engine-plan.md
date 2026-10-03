# Search engine: the build plan, A to Z

The executable plan for `docs/search-engine-design.md`. Owner instruction
2026-10-02: work it end to end without intervention, Opus orchestrating, Sonnet
developing; complete, tested, with metrics.

## Ground rules for every ticket

- **Branch `search-engine`.** Nothing is pushed. A push to `main` runs
  migrations against production on build (`scripts/ingest-on-build.mjs`,
  `db/migrate.mjs`), so deploying is the owner's call after review.
- **One ticket, one commit**, written by the orchestrator after review
  (owner rules: small-changes method; no local model for commit messages).
  Developers do not commit, push, or touch files outside their ticket.
- **Developers run unit tests and `npm run check` only.** The browser sweep is
  run by the orchestrator, alone, with no dev server on :4321 (a reused dev
  server breaks the signed-in sweep). Exception: the UI ticket, which runs
  alone in its wave.
- **No developer runs a backfill or writes rows.** Migrations are applied with
  `npm run db:migrate` (it takes an advisory lock, so concurrent runs
  serialise). Backfills are run once by the orchestrator after a wave merges.
- **Repo rules that apply:** every path through `routeFor()` / registered in
  `src/data/nav.ts`; nothing under `src/pages/api`; script-built elements styled
  through `:global` under a rendered ancestor; a dropdown row's `mousedown`
  calls `preventDefault()`; every wait has a terminal state; every control works
  without JavaScript; comments state facts and reasons in the surrounding
  file's voice.
- **Data definitions live in one place.** Derived columns are computed by
  `src/lib/jobs-derived.mjs` `derivedFor()` at ingest and by
  `scripts/backfill-derived.mjs` for rows already on file. Nothing restates a
  rule in SQL.

## Decisions taken while planning (orchestrator)

1. **Region is repaired, not retired** (owner: "derive region, don't call
   Canada US West"). Root cause, measured: `derivedFor` calls
   `regionOf(row.country || row.location)`, preferring the ISO code, and the
   word list reads `CA` as California and `US` as US West and does not know
   `GB`/`FR`/`DE`. `regionOf('Toronto, ON')` already answers Canada correctly.
2. **Places are resolved from text we hold, with no download.** Country names
   come from `Intl.DisplayNames`; admin areas (US states, Canadian provinces,
   Australian states) are a small hand table; city → country is learned from
   rows whose upstream `country` is set, committed as a data file, and measured
   on a held-out split. GeoNames would need a download the owner has not
   approved; the board only needs places it actually carries.
3. **Pay becomes one definition.** The Desk already filters on
   `comp_range.min >= floor`. The board adopts the same floor (`pay_min`, in
   thousands) for both the typed chip (`150k`) and the Comp control, which
   changes from bands to floors (Any, $100k+, $150k+, $200k+, $250k+, $300k+,
   Not listed). Two pay filters with two meanings would rebuild the overlap
   this work removes.
4. **"Best match" is the default sort only when words are typed.** Text match
   tier first (title phrase, all words in title, then weighted rank), then
   Deets, then age, then id. With no words the board's current default holds.
5. **The suggest endpoint is `/board/suggest`**, a static route beside
   `/board/[slug]` (static wins in Astro's routing); registered in `nav.ts`.
6. **Categories (ESCO, multi-label, embeddings) are not in this run.** They
   need an external dataset download and a model on the Mac mini, both of which
   need the owner. Field leaves the strip and returns as "in the same field"
   navigation under results, drawn from the bug-fixed classifier.

## Waves and tickets

### Wave 1 — data repair (parallel; disjoint files)

**A. Geography** — `jobs-derived.mjs`, `upsert-sql.mjs`, `ingest-jobs.mjs`,
`backfill-derived.mjs`, `test-db.mjs`, `db/220_jobs_place.sql`, tests.
- Fix region: resolve from the ISO code when present (CA→Canada, GB→UK, EU
  members→EU, APAC→APAC, LATAM→LATAM, US→sub-region read from the location
  text, else the existing answer). Never a US region for a non-US country.
- Add `placeOf(location, country)` → `{ country, admin1, city, label }`.
  Migration 220 adds `place_country`, `place_admin1`, `place_city`,
  `place_label` to `jobs` with partial indexes on live rows.
- `scripts/build-place-table.mjs` learns city → (country, admin1) from rows
  with an upstream country (≥3 occurrences, ≥95% agreement), writes
  `src/data/place-cities.json`, and reports holdout accuracy on a seeded 20%.
- Accept: unit tests for region and place; no non-US country maps to a US
  region; holdout accuracy reported; coverage reported on the local board.

**B. Classifier repair** — `src/lib/job-family.mjs`, `job-family.test.ts`.
- `'counsel'` leaves the social-care rule.
- Prefix matching stops firing on unrelated longer words. Measure every
  prefix-match event on the corpus fixture as (term, word, count), fix the bad
  ones (e.g. `sales`→`salesforce`), and add specific terms where a phrase
  belongs to another family (`data center` → IT & Infrastructure).
- Accept: coverage floor ≥ 0.90 holds; a table test pins Corporate Counsel →
  Legal, Salesforce Administrator → not Sales, Data Center Technician → IT &
  Infrastructure; the reclassified rows are listed in the report.

**C. Search text** — `db/219_search_text.sql`.
- `pg_trgm`, `unaccent`, an `IMMUTABLE` unaccent wrapper; `jobs.search`
  `tsvector GENERATED ALWAYS … STORED` over title (A), company (B), department
  (C), description (D) with the `simple` config; GIN on `search` for live rows;
  trigram GIN on `title` and `company`.
- Accept: migration applies locally; `EXPLAIN` shows the GIN index used for a
  tsquery on live rows.

Orchestrator after wave 1: run `npm run db:migrate`, run the backfill, measure,
commit A, B, C separately.

### Wave 2 — the engine (parallel, then one)

**D. Parser** — new `src/lib/search-parse.ts` + table test. Pure, dictionaries
injected. Recognises remote/hybrid/on-site, pay (`150k`, `$150k`, `150k+`,
`150-200k`, `150,000`), age (`today`, `this week`, `new`), places (country
names/aliases/ISO, admin names/codes, learned cities), companies (exact).
Unambiguous syntax (pay, remote, age) becomes a chip; a place or company that
is also a word is offered both ways and kept as a word unless chosen.
Accept: ≥ 60 table cases, all green.

**E. Query and SQL** — `board-query.ts`, `job-store.ts`, their tests.
- New params: `place` (ISO country, `US-MD`, or `city:<label>`), `remote`
  (with `location` accepted as the legacy name), `pay_min`, `company`; the
  `comp` bands give way to the floor (decision 3), `not-listed` kept.
- Text match: weighted tsquery (words, last one `:*` prefix) OR trigram
  `word_similarity` on title ≥ 0.5 for typos; `sort=best` default when words
  are present (decision 4).
- Leave-one-out counts for every new facet.
- Accept: existing board tests green; new tests for each param and for best
  match ordering; `title ILIKE` no longer used for `q`.

**F. Suggest + redirect** (after D, E) — `src/pages/board/suggest.ts`,
`nav.ts`, `board.astro`.
- `GET /board/suggest?q&…filters&v=<sweptAt>` → grouped JSON (places, titles,
  companies, facts), ≤ 8 per group, counts leave-one-out over the current
  filters; `Cache-Control: public, s-maxage=86400` because `v` changes when the
  sweep does.
- The silent `familyFromSearch` 302 is removed. A no-JS submit is parsed
  server-side and redirected to the canonical URL with chips as params **and
  the words kept**.
- Accept: endpoint tests; a field name typed as words is searched, not
  converted.

### The suggest contract (fixed 2026-10-02, so F2 and G build in parallel)

`GET /board/suggest?q=<text>&<every current board param>&v=<sweep instant>`

```json
{
  "v": "<sweep instant the counts are for>",
  "q": "<the text as received, capped at 200>",
  "parsed": { "words": [], "chips": [], "offers": [] },
  "total": 1234,
  "groups": [
    { "type": "titles",    "label": "Titles",    "items": [] },
    { "type": "places",    "label": "Places",    "items": [] },
    { "type": "companies", "label": "Companies", "items": [] },
    { "type": "facts",     "label": "Facts",     "items": [] }
  ]
}
```

Each item:

```json
{
  "id": "place:GB/London",
  "label": "London, United Kingdom",
  "count": 406,
  "disabled": false,
  "apply": { "chip": { "kind": "place", "key": "GB/London", "label": "London, United Kingdom" } },
  "href": "/board?..."
}
```

- `total` is what pressing Enter on the current text returns.
- **Titles are whole-query completions** (Indeed's model): rows whose title
  matches every word of `q`, the last as a prefix; `apply` is
  `{ "words": "<title phrase>" }`, replacing the words part of the query.
- **Places and companies complete the trailing fragment** (the last one to
  three tokens); `apply` is `{ "chip": … }` and the fragment is removed.
- **Facts** are the parser's pay / remote / age chips found in the text, plus
  its offers (an ambiguous place or company shown as a choosable chip).
- **`count` is exact**: it equals the `total` of `/board` at the item's
  `href`, leave-one-out over the current filters. A zero is `disabled: true`
  and is returned, never dropped. Ticket I asserts this over 500 random cases.
- At most 8 items per group; an empty group is returned empty, and the client
  does not draw it.
- Caching: when `v` equals the current sweep instant,
  `Cache-Control: public, max-age=60, s-maxage=86400, stale-while-revalidate=600`;
  otherwise answer for the current sweep with its `v` and `no-store`.
- Errors: input over 200 characters is truncated, not refused; a server error
  is `500 {"error": "<message>"}` and the client shows its error state.
- Latency budget: p95 ≤ 100 ms on the local board.

**File ownership for the parallel build:** F2 owns `src/pages/board/suggest.ts`,
the route entry in `src/data/nav.ts`, any new SQL module it needs, and the
frontmatter of `src/pages/board.astro` (lexicon wiring, the visible parse
redirect, removal of the `familyFromSearch` 302). G owns `Filters.astro`, the
new `SearchBox.astro`, their styles and the sweep specs, and edits
`board.astro` markup only after F2 is merged.

### Wave 3 — the box (one developer, alone)

**G. Search box and strip** — `Filters.astro`, a new
`src/components/SearchBox.astro`, `board.astro`, sweep specs.
- Custom combobox: `role=combobox`, listbox grouped by type, label left and
  count right in the existing menu style, zero rows disabled not hidden,
  chips inside the box with remove buttons, keyboard (↑↓ across groups, Enter,
  Esc, Tab, Backspace at caret), 80 ms debounce, aborted stale requests,
  loading and error states, `mousedown` guard, one menu open at a time across
  the box and the strip.
- Strip: Field cell removed; the arrangement cell labelled **Remote**; Comp as
  floors; Sort and Dim seen unchanged; "In the same field" links under results.
- Phone (390): full-width panel, three rows per group plus "more".
- No-JS: the box is a plain `name=q` input; the server parse places chips.
- Accept: `test/sweep/search.interaction.spec.ts` green in webkit and firefox;
  responsive spec green at 390; screenshots in both themes.

### Wave 4 — ranking shown

**H. Ranked because** — `JobRow.astro` (the `why ▾` panel) and the sort
helper. One line per row naming the rule that placed it.

### Wave 5 — proof (parallel)

**I. Counts contract** — DB-backed tests: a suggestion's count equals the rows
returned when it is applied, over 500 seeded random filter combinations;
exclusive groups sum to the total; the suggest cache key carries the sweep
instant.

**J. Evaluation harness** — `scripts/search-eval.mjs` → 
`docs/search-engine-metrics.md`:
- known-item retrieval, old (`ILIKE`) vs new: MRR, hit@1, hit@10 over 500
  seeded postings, queried by title and by title + company;
- typo tolerance: one-character edit per query, hit@10 old vs new;
- typeahead recall: first four characters of the title's last word, is the
  title in the top 8;
- place coverage before/after and holdout accuracy; region fix counts;
- classifier reclassification counts;
- parser table pass rate; counts-contract exactness;
- latency p50/p95/p99 for search and suggest on the local board, warm.

### Wave 6 — ship-ready

Orchestrator: `npm run conform -- --deep`, fix anything red through a
developer, write the final report. Stop before push.

## Targets

| measure | target |
|---|---|
| live rows with a resolved country | from 42% to ≥ 85% |
| place holdout accuracy | ≥ 97% |
| non-US countries in a US region | 0 |
| known-item hit@10, new | ≥ 95%, and ≥ old |
| typo hit@10, new | ≥ 80% |
| counts contract exactness | 100% |
| parser table | 100% |
| classifier coverage floor | ≥ 0.90 |
| suggest p95, local | ≤ 100 ms |
| search p95, local | ≤ 150 ms |

Local latency is not Neon latency; the report says so and gives the local
numbers only.
