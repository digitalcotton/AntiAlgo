# The shared components

Every page composes these. None of them is a suggestion: if a page renders a
score, an age, a duration, a statistic or a mark, it renders it through the
component below that owns it, because that is the only way seven pages built in
parallel say the same thing about the same number.

Read `src/lib/data.ts` first. Every derived value on this site is computed
there, and a page that recomputes one has already introduced the disagreement
this layer exists to prevent.

## The five rules these components encode

1. **Structure may be derived. Facts may not.** Nothing here invents a company,
   a role, a salary, a date, a duration or a statistic.
2. **A number renders only when its provenance can be shown.** Where the record
   carries no date to compute from, the component renders a truthful absence.
   Never a guess, never a fallback.
3. **One clock.** Every timestamp is `stats.swept_at_utc`, through
   `sweptStamp()`. There is no `Date.now()` in this repository.
4. **Two voices.** Basier Square Mono for machine assertions: numbers,
   timestamps, statuses, scores, source names. N27 for everything else,
   **including absences**, because "No date shown" is us saying what we do not
   know rather than the machine stating a reading. A reader can tell a
   measurement from a gap by the typeface before reading a word.
5. **Observations, never intent.** No component prints a motive, and none takes
   a prop that would let a page add one.

## Data layer, `src/lib/data.ts`

| Call | Returns |
| --- | --- |
| `loadJobs()` `loadKills()` `loadStats()` `loadFacts()` | the frozen fixtures, typed. `loadKills()` returns the **publishable** kills: a record marked `held` is not in it |
| `killArchive()` | every kill the sweep recorded, held ones included. Only for a sentence about the sweep rather than about the list |
| `heldKills()` | the records held back from publication, with their reasons |
| `verifiedJobs()` | the 37 live and re-verified rows |
| `closedJobs()` | the closed rows (Uplight) |
| `jobBySlug(slug)` `killBySlug(slug)` | one record or null |
| `sweptAt()` `sweepDate()` `sweptStamp()` | the clock, and the sweep's only identifier |
| `reading()` in `src/lib/readings.ts`, rendered by `<Reading>` | every number the site states about its own sweep |
| `ageOf(job)` | `{ days, basis, from, to }` or **null** |
| `postedDate(job)` `firstSeen(job)` | the two date facts |
| `firstSeenVisible()` | the gate on the index's First seen **column** |
| `firstSeenShowable(job)` | whether **one record's** first-observed date may print |
| `formatAge(job)` | `"40d"`, `"13d of 30"`, or null |
| `compParts(comp)` | the comp string cut at its spaces, so a cell wraps without splitting a number |
| `killDuration(kill)` | `{ days, from, to }` or **null**, computed |
| `killSlug(kill)` | the share card's URL segment |
| `killBySlug(slug)` | resolves publishable records only, so a held slug has no card |
| `companiesOnBothLists()` | computed intersection, kills with their live siblings |
| `liveSiblingsOf(kill)` `liveJobsAtCompany(company)` | the live rows at one company |
| `repeatOffenders()` | companies with more than one kill |
| `paginate(rows, perPage)` | every page, 1 based, with row ranges |
| `fitComponents(job)` | the five components, the total, and the working out |
| `sortJobs(jobs, key)` `sortRanks(jobs)` `compTop(job)` | ordering |
| `filterGroups(jobs)` `facetsOf(job)` | the filter options and a row's buckets |
| `fact(id)` `factSource(id)` `assertLicensed(id, route)` `factsFor(route)` | the eight statistics |
| `referenceDays()` | 9.8, read out of the fact string |
| `ABSENCE.date` `ABSENCE.value` | "No date shown", "Not listed" |
| `applyLabel(job)` `easeSummary(job)` `sourceLabel(job)` `markStateOf(job)` | row furniture |

Two stored fields are **never read**: `duration_open_days` and `age_days`. Both
are derived observations, and a derived observation gets derived. Gate 2 asserts
the computation rather than the stored value for the same reason.

Three things are **blocked upstream** and no component works around them:

- `kill_rule` is not in the fixture, so the reason taxonomy and its per-group
  counts do not ship. Do not classify from the `reason` prose.
- Five verified rows carry an `age_days` with no date behind it, so `ageOf()`
  returns null for them and the cell shows an absence.
- Eight rows carry a fit component outside its rubric weight, so `FitBars` draws
  no bar for those components and says why.
- The fit component splits themselves are back-filled from the rubric weights in
  this export, which `jobs.json` `_meta` declares as
  `fit_component_provenance: "derived_from_weights"`. While that is anything
  other than `measured`, `fitComponents()` returns a null value per component and
  `FitBars` renders each one as a truthful absence against its real weight. The
  totals are the machine's and render everywhere.

## Routes, `src/data/nav.ts`

`PAGES` drives the header's own inventory of this site's routes. The header and
the footer are both ported straight from the marketing site (see
`SiteHeader.astro` and `SiteFooter.astro`); the footer reads its links from
`src/data/shell-nav.ts`, not from this file. `ROUTES` is the complete registry of
everything the site emits, including the dynamic routes and the published text
file. **Never type a path in a page**: call `routeFor(key)`,
`jobPath(slug)`, `killCardPath(slug)`, `hrefFor(page)` or `publicAsset(path)`. A
build-time check throws if the header links somewhere `ROUTES` does not know
about, or if a route claims a page key `PAGES` does not have.

That rule got teeth when the site moved under a base. This is served at
`tokenstoagents.ai/jobs`, and Astro does not prefix a path typed into markup, so
a hand-written `href="/kills"` builds cleanly and 404s in front of a reader. Every
accessor above returns a path with the base already on it; the `pattern` stored
in `ROUTES` does not carry it, because it describes the `src/pages` tree and the
`dist/` tree, neither of which is nested under the base. `test/route-census.mjs`
crawls the built tree and fails on any site-absolute link that does not carry the
base or does not resolve.

`sitemapRoutes()` is the static, indexable set, and `src/pages/sitemap.xml.ts`
is the one thing that reads it.

---

## The components

### `JobTable.astro`

The index table: the sweep assurance banner, the column labels, the rows, the
mark legend and the footnote. Props: `jobs` (required), `paging`
(`'server'` default, or `'client'`), `perPage` (8), `verifiedBanner`,
`emptyTitle`, `emptyDetail`. Slots: `count` (beside the banner), `pagination`
(in the footer), `empty-action`.

It is a list, not a `<table>`, because at 375px every row becomes a card and a
real table cannot do that without shipping the rows twice. Column labels are
presentational; every cell carries its own hidden label instead.

Under `paging="client"` it becomes the island controller: pass every row, and it
listens for `index:filter`, `index:sort` and `index:page` on `document` and
announces `index:rows` back. Rows past the first page are rendered with `hidden`
already set, so the first paint equals the script's first state and nothing
moves on load. Under `paging="server"` (the default) it renders exactly what it
is given, ships no controller, and one URL is one page.

### `JobRow.astro`

One row. Props: `job` (required), `surface`, `ranks` (from `sortRanks`),
`hidden`. Renders fit with its why expander, role as posted with its company and
mark, comp as posted, location, age with its basis, and the apply action naming
its destination. Closed rows have no apply path at all.

Writes the filter island's whole interface as data attributes:
`data-facet-location`, `data-facet-comp`, `data-facet-freshness`,
`data-rank-fit|comp|age`, plus `data-slug`, `data-company`, `data-status`,
`data-fit`, `data-comp-top`, `data-age`. A Pre-List row carries
`data-facet-location="unknown"` and JobTable lets it through any Location
choice: a company that has not posted has no workplace to filter on.

The why panel is in the markup and hidden by the `hidden` attribute, so
`JobTable`'s `<noscript>` rule can open every panel and remove every toggle. The
expander works or it is not there; it is never a dead button.

### `FitBadge.astro`

The score. Props: `job` (required), `size` (`'row'` or `'detail'`). Emits
`data-truth="fit"` with the slug and total, which gate 2 reads. The `/100`
suffix appears at `detail` size only.

### `FitBars.astro`

The five rubric components. Props: `job` (required), `heading`. **Writes no
prose**: the canvas's per-component reasoning sentences exist for one hand-worked
example and the fixture carries no such field, so generating them would be
inventing the machine's reasoning.

Two absences, and they are different:

- **No published split.** While `fitComponentsPublished()` is false, each
  component renders its name, its real rubric weight and "Not listed", with no
  bar and no `data-truth="fit-component"` marker, because there is no machine
  reading to check. The total line carries `data-truth="fit"`, so gate 2's sum
  check still runs against the export.
- **A published value outside its weight.** The value prints, the bar does not,
  and the row says why. Clipping 37 to a full 30 bar would draw a picture that
  says "at the maximum" about a number that is past it.

### `DurationBar.astro`

The kill list signature. Props: `kill` (required), `scaleMax` (defaults to the
longest measured duration across **all** kills, so one scale holds on the list
and on the share card), `referenceCaption`.

Three states, and they are the point of the component:

- `observed_by_us` with a `first_published`: draws the bar, against one
  reference line at 9.8 days.
- `reported_elsewhere`: **no bar**. The bar is a measurement and we have none.
  Renders attributed text naming the source, and where the source has not been
  named to us, holds the claim back entirely.
- no `first_published`: renders the slot as a truthful absence.

The 9.8 comes from `referenceDays()`, read out of the fact string, and the
caption carries its source in mono. It never appears as a bare number.

### `KillRow.astro`

One kill, on the list and on the share card, so the two cannot disagree. Props:
`kill` (required), `scaleMax`, `referenceCaption`, `shareLink`. Renders the
company, the title, the observation prose, both dates, the duration bar, and the
computed both-lists cross-link where the company also holds a live posting. Each
cross-linked sibling carries its own `FitBadge`: it is the reason a reader
follows the link, and it is also what gives gate 2 a declared score to check on a
page that names companies and prints score-shaped numbers.

### `StatTiles.astro`

Boards, verified, killed, ghost rate, from `stats.json`. Props: `linkKills`.
Every tile carries `data-truth="tile"` with its metric name and value, which is
what gate 2 checks the rendered number against. Green is the live count, red is
the kill count and the ghost rate, and nothing else on the site is either
colour.

### `InsightStrip.astro`

The education layer. Props: `factId` (required), `route` (required), `soWhat`
(required), `storageKey`. Quotes the fact verbatim from `facts.json` and cites
its source in mono. Dismissed forever in one click.

Three build-time guards: the fact must be licensed for `route`, the `soWhat`
line may contain no numeral, and the source renders from the fact's own `source`
field. One strip per page, maximum.

### `NewHereStrip.astro`

The three-beat orientation strip, first visit anywhere, dismissed forever. Props:
`surface`, `storageKey`. **Takes no copy props**: seven pages must render the
same three sentences.

### `Filters.astro`

Props: `groups` (from `filterGroups(jobs)`), `selected`. Native selects, sized by
a hidden sizer holding the widest option so choosing a shorter one moves
nothing. Announces `index:filter` on `document`. Three groups, not the canvas's
four: role family needs a field the sweep does not emit.

### `SortControl.astro`

Props: `current`, `hrefFor` (link mode). Segmented group with `aria-pressed`.
Announces `index:sort`, and takes its pressed state from `index:rows` rather
than from what was clicked. The pressed segment differs by background and colour
only, so the group never changes width.

### `Pagination.astro`

Props: `current`, `total`, `prevHref`, `nextHref`. Passing either href makes it
links (crawlable, works with scripting off); passing neither makes it buttons
that announce `index:page`. Both ends are always rendered, disabled rather than
removed, and the count line is tabular, so nothing reflows on a page change.

### `ProvenancePanel.astro`

Props: `job`. First observed, last verified, age and its basis, source, status,
and the observation timeline. The timeline contains only entries the record
holds: filling in the sweeps between two known dates would be inventing
observations on the panel whose whole job is proving we do not. First observed
is suppressed while the archive is shallow, and the row says so rather than
vanishing.

### `EasePanel.astro`

Props: `job`. Friction, estimated time, account, destination. The tilde marks an
estimate and the footnote says so once. No default time estimate.

### `AppealLine.astro`

"Posting still live and we got it wrong? Tell us and we will re-verify tonight."
Props: `href` (defaults to `SITE.contact`). **Fixed wording, no copy props**: a
page rewording the appeal is a page softening it, and it is the line that makes
the kill list a courtroom rather than a pillory.

### `Panel.astro`

The bordered box every panel on the site is made of. Props: `title`, `footnote`,
`surface` (`'raised'` or `'page'`). Slots: default, `aside` (opposite the
title), `footnote`.

### `KeyValueList.astro`

The term and value grid inside those panels. Props: `rows` of
`KeyValueRow` from `src/lib/ui.ts`: `{ key, value, absence? }`. A null `value`
renders `absence` in the human voice. This is where rule 4 above is enforced.

### `EmptyState.astro` / `LoadingState.astro` / `ErrorState.astro`

Real components, used by pages, not an afterthought.

- **Empty**: props `title`, `detail`, slot `action` for exactly one control.
- **Loading**: prop `label`. No skeleton and no pulse, deliberately: a skeleton
  draws content that may not exist, and gate 6 fails any keyframe animation
  outside the one declared signature moment.
- **Error**: props `title`, `detail`, slot `action`. Carries the sweep stamp,
  because the question a reader actually has is whether what they saw a minute
  ago is still trustworthy.

### `CaptureModule.astro`

The site's only module that asks a reader for anything, composed by `/desk` and,
inside the index's own panel, by `/`. Props: `source` (which surface carried it),
`heading`, `lead`, `watchFilters`, `state`, `class`.

It reads one constant, `SUBSCRIBE_ENDPOINT` in `src/data/site.ts`. Null means
there is nowhere to post an address, so no form renders at all: the module ships
the announcement, what the two consents would offer, and a mail path that works
today. A string renders the two-consent form. That is the whole of the switch,
and it is the reason no surface can ship a field that swallows an address.

`state` is for the review surface only. The four outcomes (`joined`, `pending`,
`pick`, `retry`) are reached by the endpoint's redirect fragment and `:target`,
so a reader can only ever light one and only after a real submit. `/_states`
names each in turn so all four are read by gate 1.

### `Mark.astro` / `MarkLegend.astro` (phase 1, extended here)

Three states: `verified`, `re-verified`, `closed`. Red is never a row mark.
`Mark` gained one thing in this layer: the re-verified knockout fill now reads
`--mark-knockout-fill` with the declared `surface` as its fallback, so a table
row that changes background on hover can set the property once and every mark
inside it follows. Call sites that do not set it are unchanged.

---

## The island contract, in full

Controls know nothing about rows. They announce intent on `document`; the table
listens and announces the result back, so a control's own state describes what
happened rather than what it asked for.

```
index:filter  { group, value }        group is a data-facet-* name
index:sort    { key }                 'fit' | 'comp' | 'age'
index:page    { page } or { delta }
index:rows    { shown, total, page, pages, firstRow, lastRow, sort, filters }
```

Sorting in the browser uses the integer ranks `sortRanks()` wrote onto each row.
What "sort by comp" means (top of the posted range, rows with no posted range
last, ties by company) is written once, in `sortJobs()`, and the island inherits
it. A comparator in a `<script>` block would be a second opinion.

## Gate obligations a page inherits

- **Gate 2** reads `data-truth` markers. Render a score through `FitBadge` or
  `FitBars`, a stat through `StatTiles`, a statistic through `InsightStrip`, and
  the markers are already correct. Roll your own and the gate fails the route
  for declaring nothing.
- **Gate 3** hard fails on em dashes, en dashes, curly quotes and the banned
  vocabulary, in `.astro` source as well as in rendered HTML.
- **Gate 6** fails any transition with a non-zero duration under
  `prefers-reduced-motion: reduce`. Every transition in this directory is inside
  a `@media (prefers-reduced-motion: no-preference)` block. Keep it that way.
- **Gate 5** compares committed screenshots. A visual change and its updated
  baseline belong in the same commit.
