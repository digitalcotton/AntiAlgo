---
paths:
  - "src/components/Board.astro"
  - "src/components/Filters.astro"
  - "src/components/CaptureModule.astro"
  - "src/pages/index.astro"
  - "src/pages/board.astro"
  - "src/pages/prelist.astro"
---
`Board.astro` is rendered by three routes: `/` (the home page), `/board` and
`/prelist`. `Filters.astro` reaches all three through it. **An edit here changes
the home page**, which is the highest-churn file in the repo.

Commit `54435b9` exists because a saved-filter restore fired on pages it should
not have. The cause was upstream of that: `e81f651` copied the job-board app into
this repo wholesale and brought board-page-shaped behaviour to a component three
pages render.

`CaptureModule.astro` reads `.filter-label` out of `Filters.astro`'s markup — a
cross-file selector contract with no import between them. Renaming that class
breaks the capture module and nothing will fail to compile.

Tests that already cover this subtree: `src/components/Board.render.test.ts`,
`src/components/Filters.render.test.ts`.
