# Handoff, 2026-10-02

## Where things stand

- **Branch `search-engine`**, 21 commits on top of `main`, **not pushed**. Deep
  gate GREEN 7/7 on the final code. Everything is in `docs/search-engine-report.md`.
- **A dev server is running on :4321** (the browser pane, for the owner to try the
  search). Stop it before any `npm run conform -- --deep`: a running dev server
  on :4321 is reused by the sweep and breaks it.
- **Already on `main` and in production** from earlier today: Your key flagged off,
  header collapses to the burger by measuring itself (no stacking), 20px nav gap,
  Desk lanes rank by the 14-day window instead of hiding, head-start bar with an
  off-the-scale arrow, 4 roles per lane.

## Waiting on the owner

1. **Two typeahead fixes I proposed, not done** (seen live on "product designer lon"):
   - Hide zero-count rows in the typeahead's Places and Companies. The "show the
     zero" rule fits fixed dropdowns (Remote, Comp, Location); in search-as-you-type
     it is clutter — seven dead places under London.
   - Collapse near-duplicate places: "London, Canada" (`CA/London`, any province)
     and "London, ON" (`CA-ON/London`) are the same city listed twice.
2. **Seven decisions** in the report's "Decisions that are yours": EU → Europe and a
   Middle East & Africa region; an applied filter shown twice (chip + dropdown); the
   long Location list; Remote ticks submit one at a time; delete the old
   suggestions JSON / build script / `familyFromSearch()`; ESCO categories (needs a
   dataset download and a model on the mini); an expired accepted gate finding.
3. **Push.** Runbook in the report. The one trap: place columns and corrected
   regions are written by the nightly ingest, not the deploy, so after a daytime
   push they are empty in production until 03:30 ET — deploy in the evening, or
   run `node scripts/backfill-derived.mjs --all` against production once.

## The documents

| file | what |
|---|---|
| `board-picker-research.md` | the research: two pickers, the missing geography, the 44%-ambiguous classifier, Indeed/LinkedIn/Glassdoor inspected live |
| `board-filters-design-prompt.md` | master prompt for Claude Design for the strip's layout |
| `search-engine-design.md` | the design |
| `search-engine-plan.md` | the A-to-Z plan, including the suggest endpoint's contract |
| `search-engine-report.md` | what was built, every number vs target, decisions, deploy runbook |
| `search-engine-metrics.md` / `.json` | `npm run eval:search` output; baseline in `search-engine-baseline*.json` |

## Lessons from this session (also in memory)

- A `git worktree` with `node_modules` symlinked passes the fast gates but the
  browser tier 403s on every page (Vite won't serve outside its root). Deep gate in
  the main tree.
- The sweep's test DB (`antialgo_test`) is not migrated by the gate: run
  `npm run db:test:reset` after adding migrations.
- A speed-only change must leave the eval fingerprint identical (`1d43c69b…`).
- Latency is measured locally only; Neon has not been measured.
- A developer's first fix is often incomplete in a way only measurement shows:
  TRUNCATE → DELETE alone still blocked readers (the explicit lock did it); a plain
  column in one transaction still held the read lock (split the migration).

## How the owner wants to work (said again this session)

- Plain, short language in chat; no walls of text; substance in files.
- Research before a design opinion — including the largest job sites, inspected.
- Counts must be accurate and stay accurate.
- One menu open at a time. No stacked nav.
- See a preview in the site's own style before anything is built.
- A preview must never invent a bug the product doesn't have.
