# A posting counts under every place it lists

Owner decision, 2026-10-02 (report decision 8, option B): a posting that lists
several places is found under each of them, and each place's count includes it.
The Location numbers then no longer add up to the total; each number is still
exactly the rows you get when you choose it.

Branch `search-engine`, on top of 49c479d. Not pushed.

---

## What is wrong today

`readPlace()` reads a list ("United States / Canada / London") as ONE place: the
upstream country plus the one city the list names. 24 of the 99 " / " lists that
were given a city are wrong ("London, Canada" for London, UK; "New York, Canada";
a city called "Europe"). And a job listing London and Berlin is found under
neither city.

## Measured on the local board (37,286 live rows)

A reference implementation was run over every live row before any code changed.
It lives outside the repo, in the session scratchpad:

```
SP=/private/tmp/claude-501/-Users-PyanPayne-Documents-Devlopment-AntiAlgo/e6f9d70b-a215-4bab-adc8-c9e9a30a32ce/scratchpad/proto
$SP/token-rules.diff     the token-level changes to jobs-derived.mjs (unified diff)
$SP/places.mjs           placesOf() and summaryOf(), the list rules
$SP/expected-keys.json   { job id: [sorted place keys] } for every live row
$SP/run3.mjs             the measurement (compare with today, regions)
```

| | today | new |
|---|---|---|
| rows read as a list | — | 2,201 |
| lists spanning several countries | — | 477 |
| rows with no place ("Not stated") | 6,712 | 6,602 |
| countries on the board | 95 | 109 |
| London, UK | 676 | 903 |
| rows that lose the country they had | — | 7, all wrong today (below) |
| one-place rows whose answer changes | — | 177, all junk cities removed or a city found |
| region changes | — | 28 (below) |
| country list for the strip | 1 ms | 1.7 ms (index probe; a plain DISTINCT is 12 ms) |

The 7 rows that lose today's country: one Latin America posting filed under the
US (2 rows), one European posting filed under the US, and "Vancouver,
Washington" filed under Canada (4 rows; it is in the US).

---

## The reading rule (src/lib/jobs-derived.mjs)

### Token-level changes, shared by every row (`token-rules.diff`)

These change one-place rows too, measured at 177 rows, every one an improvement:

1. Region words are not places: europe, eu, european union, emea, apac, asia
   pacific, latam, latin america, americas, north america, south america, asia,
   nordics, dach, benelux, middle east, mena, africa, ile de france,
   deutschlandweit join NOISE (folded spellings, since `fold()` turns hyphens
   into spaces). A folded token ending in " region" or " wide" is noise.
2. "Anywhere in France", "All France", "across Spain", "throughout Belgium": the
   prefix is dropped when what follows is a country or a state.
3. `cityLike()` refuses a token with `! ? & @ #`, the word "only" or "timezone".
4. "Hamburg-Germany", "Barcelona- Spain": a trailing country joined by a hyphen
   is split off, only when the hyphen has a space on one side or the head is a
   city the table knows ("Île-de-France" is not split). Applied to each piece
   after the PART_SPLIT.
5. `cleanText()`: "a/d" becomes "aan den" (Capelle a/d IJssel, 17 rows) and
   "Frankfurt / Main" becomes "Frankfurt am Main", before the slash splits them.
6. `COUNTRY_ALIASES`: BA gets 'Bosnia'.

### placesOf(location, country) → Place[] (`places.mjs`)

- **One place.** When the string has at most one piece and that piece is not a
  list, the answer is `[placeOf(location, country)]` (or `[]` when it has no
  country). Identical to today by construction.
- **A list.** Every piece is read on its own, WITHOUT the upstream code
  (`readPart(piece, null)`): its own text, then the city table. The upstream
  code is the crawl's pick of one place in the list, so it is not lent to the
  others. "London / Germany" is London, UK and Germany.
  - A piece that is itself a comma list (`readPart` returns `listed`):
    - two-letter codes: a code followed by a country it does not belong to is
      that country's subdivision and is dropped ("La Ceiba, AT, HN"); one followed
      by its own country is a state ("GA, US"); in a list naming other countries a
      code that is also a country and is not followed by its own is the country;
    - two or more state codes: each takes the token just before it as its city
      when that token is city-like ("Chicago, IL, Evanston, IL");
    - otherwise two or more countries: each country;
    - otherwise two or more cities the table knows: each city.
  - A lone "Georgia" or "Victoria" piece counts only when another piece of the
    list is in the same country (a London list ends in "Victoria").
  - "Germany & Netherlands": two country names joined by & or "and" are both.
  - A piece with no country of its own (a city the table does not know) takes
    the upstream code ONLY when no piece of the list names a country in its text
    and every place found is in the upstream country. Otherwise it is dropped:
    "Haarlem; Lugano; Singapore" is Singapore, not Haarlem, Singapore.
  - A list that resolves to nothing, with a valid upstream code, is that country.
  - One entry per leaf key (below).
- **summaryOf(places, country)**: the one place for the `place_*` columns and the
  region. One country: that country, its state if all agree, its city if there is
  one. Several countries: the upstream code if it is one of them, otherwise none;
  no state, no city. `derivedFor()` writes `place_*` and `derived_region` from it,
  so place_* and the list are one definition.

### Keys

A place `{country, admin1, city}` has the keys the board's `place=` grammar
already uses (place-key.ts), every level:

```
GB                      GB/London
US  US-MD  US/Baltimore  US-MD/Baltimore
```

`US/Baltimore` is there because the filter `US/Baltimore` means "Baltimore, any
state" today; keeping it keeps every existing URL's meaning. The LEAF key is
the most specific one (`US-MD/Baltimore`, `GB/London`, `GB`).

---

## Storage: db/222_job_places.sql

- `place_keys text[] NOT NULL DEFAULT '{}'`: every key of every place, distinct,
  sorted. Empty means "Not stated".
- `place_leaves text[] NOT NULL DEFAULT '{}'`: one leaf key per place.
- GIN index on `place_keys` `WHERE status <> 'killed'`.
- Same lock discipline as 219/220: separate transactions (`COMMIT; BEGIN;`),
  `SET LOCAL lock_timeout = '5s'`, the index built without holding the table.
- The migration does NOT fill them; the ingest and the backfill do (as with
  220). The deploy runbook's backfill step already covers this; add the new
  columns to it.

Writers: `derivedFor()` returns `place_keys` and `place_leaves`;
`src/lib/upsert-sql.mjs`, `scripts/ingest-jobs.mjs`,
`scripts/backfill-derived.mjs` (and its IS DISTINCT FROM change check and its
receipt), `scripts/test-db.mjs` write them.

## Readers (src/lib/job-store.ts, src/lib/search-lexicon.ts)

- `placeMatchSql()`: `unstated` → `cardinality(place_keys) = 0`; otherwise
  `country IS NULL OR place_keys @> ARRAY[<key built from the three params>]`.
  Parameter positions do not move (tests pin them).
- `boardFacetCte` base and the `flags` CTE carry `place_keys`.
- The `places` facet: `unnest(place_keys)` country-level keys (two letters) under
  `keep('place')`, plus the `''` entry for rows with no keys.
- `place_universe`: one GIN probe per ISO code (`ISO_COUNTRIES` from
  jobs-derived.mjs, written into the SQL from the constant, never from input):
  `SELECT array_agg(c) FROM unnest(ARRAY[...]) c WHERE EXISTS (SELECT 1 FROM jobs
  WHERE status <> 'killed' AND place_keys @> ARRAY[c])`. Measured 1.7 ms.
- The sargable path in `countBoardTotals` (~line 1818): `place_keys @>
  ARRAY[$key]`, unstated `place_keys = '{}'`.
- `loadLexiconRows()`: city groups from `unnest(place_leaves)` (label from
  `placeKeyLabel`, which must equal today's `place_label` for every leaf; test
  it), country and admin totals from exact key counts (`unnest(place_keys)`
  GROUP BY), so no job is counted twice in a country.
- Anything else reading `place_country/admin1/city` for the board.

## The invariants that change

- "Countries + Not stated sum to the total" (`job-store.db.test.ts:626`,
  `test/eval/search.eval.ts:1287`) is no longer true. It becomes: every country's
  count equals the rows its own filter returns, Not stated equals the rows with
  no keys, and the sum is ≥ the total, equal exactly when no live row spans two
  countries.
- The counts contract (suggestion count = rows its link returns) is unchanged
  and must stay 100%.

## Acceptance

1. For every live row on the local board, `place_keys` equals
   `expected-keys.json`, 37,286 of 37,286. Any difference is reported with the
   row and the reason, not silently accepted.
2. `npm run conform` GREEN on every commit. Run `npm run db:migrate`,
   `node scripts/backfill-derived.mjs --all` (local dev DB) and
   `npm run db:test:reset` after the migration lands.
3. `npm run eval:search`: counts contract 100% exact, place offered ≥ 90.5%,
   latency within the targets. The fingerprint changes (this is not a speed-only
   change); record the new one.
4. The decision 8 examples are gone: no "London, Canada" from a list, no "New
   York, Canada", no city called Europe, Apac or All France.
5. Region changes are exactly the 28 measured.

## Out of scope

- Filing the three real "London, Canada" rows under London, ON.
- `regionFor` reading "Washington" in "Vancouver, Washington" as US East.
- Hiding zero-count rows in the typeahead.
