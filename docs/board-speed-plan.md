# The board stops counting what it no longer shows

Owner, 2026-10-02 (after the every-place deploy): optimise the board's counting
statement. Branch `board-speed`, from main d22aa16.

## Measured (local, 37,286 live rows, median of 30, the board's own statement)

The statement each board request makes for its counts (`readCounts`, captured
from `listBoardFiltered` for the harness's shapes), run as it is and with parts
removed:

| shape | as is | no country list | no Field counts | neither | + no pay bands, no freshness |
|---|---|---|---|---|---|
| no words | 110.0 ms | 105.8 | 96.5 | 93.0 | **68.0** |
| one word | 6.6 | 3.3 | 6.0 | 2.8 | **2.6** |
| typo (exact pass) | 4.8 | 2.5 | 4.3 | 1.3 | **1.1** |
| words + place + remote + pay | 6.9 | 3.7 | 6.5 | 3.3 | **3.1** |
| a broad word | 29.0 | 25.9 | 24.3 | 21.4 | **19.7** |

## What the board computes and nobody reads

- **The Field counts** (`family_all`, `family_unplaced`, one per family): the
  Field links under the table were removed (d9bcd16); data.ts still builds the
  group under `placement: 'results'` and nothing draws it.
- **The pay bands** (`comp_under-150` … `comp_300-plus`): COMP became floors.
  `comp_all` and `comp_not-listed` stay (the floors' "Any" and "Not listed" read
  them). The bands are read only by data.ts's old three-select path, which is the
  Pre-List's, and the Pre-List builds its own counts (prospect-board.ts), not this
  statement.
- **The freshness counts** (`freshness_*`): no strip control; same old path.

The FILTERS stay: `fam=`, `comp=`, `freshness=` in an address still narrow the
board (their match flags and miss bits are untouched). Only the counting goes.

## The country list

`place_universe` (one GIN probe per ISO code, every request) names every country
the live board holds so the Location list can show a zero. It changes only when
rows change. Cache it in-process for 10 minutes, outside the counting statement;
a cold instance reads it once. A load or backfill shows its new countries within
10 minutes; the counts themselves are never cached.

## Proof it is speed-only

1. Before/after over a fixed set of filters (the harness's 500 seeded cases plus
   the six latency shapes): rows, total, fuzzy, and every count the page reads
   (place, remote, pay, location, the Location zero rows) identical.
2. `npm run eval:search` counts contract 100%; latency before/after.
3. `npm run conform -- --deep` GREEN.
