# Master design prompt: the board's filter strip

Paste everything below the rule into Claude Design. Companion brief:
`board-picker-research.md`, which holds the evidence, the measurements and the
competitive teardown this brief rests on. Written 2026-10-01 from the site's own
code and copy, plus outside research named at the end.

Owner decisions already made, not open for redesign:

- The work-arrangement filter is called **Remote**, not Workplace. "Location" is
  freed for geography.
- Geography is **derived properly**. The current `derived_region` column calls
  Canada "US West" and the United Kingdom "Unknown"; it is repaired or retired
  before any control ships on top of it.
- **Counts stay**, on every option, and they must be accurate and remain accurate.

---

## 1. Role and brief

You are designing the filter strip for The Index (antialgo.ai), a nightly-verified
job board. The strip sits directly above a dense table of roles and is the only
way a reader narrows ~37,000 live postings across 25 countries.

The site's voice is the constraint: readings, not claims; absences drawn rather
than hidden; nothing modelled; refusals it is proud of. A control on this site is
a statement of fact with a number beside it, not a persuasion device.

Deliver: desktop at 1440, a laptop pass at 1100, and a phone pass at 390, in both
themes, with every state in section 5, on the visual system in section 6.

## 2. The reader, and the decision they are making

One reader, three narrowings, in this order of frequency:

- **"Roles like mine."** They type a word, or pick a field. This is most arrivals.
- **"Roles I could actually take."** Geography, and whether the work is remote.
  This is the one the strip currently cannot answer at all.
- **"Roles worth my time."** Pay band, and how fresh the posting is.

They are not browsing. They are eliminating. Every control must make the size of
what remains obvious before it is clicked, which is what the counts are for.

## 3. What is wrong today, in one paragraph each

**The strip has no geography.** The control labelled LOCATION filters how the work
is done — remote, hybrid, on-site, not stated. A reader wanting the United
Kingdom, or Maryland, or Bangalore has no control. The board carries all three.

**Two controls pick a field.** The Field dropdown picks one, and 22 field names are
also mixed into the search box's suggestion list, where they are not searches at
all: typing one fires a redirect that throws the query away and sets the Field
filter instead, silently. The two carry different numbers for the same thing —
one counts the whole board, the other counts inside the reader's current filter.

**Two renderers, two visual languages.** The dropdowns are a real `<select>` with a
custom listbox drawn over it, and they look like the site. The search suggestions
are a native `<datalist>`, which the browser draws and the page cannot style at
all. That is why one looks right and one looks like an operating-system menu.

## 4. The controls to design

Left to right, one row, cells edge to edge divided by hairlines, no gaps and no
chips. The row wraps; it never scrolls sideways.

| cell | label | value | behaviour |
|---|---|---|---|
| 1 | *(magnifier glyph)* | `Title, company or field` | free text. Suggestions are **query completions only** — no categories, no scopes |
| 2 | `TITLES` | *member's saved titles* | multi-select, members only |
| 3 | `FIELD` | `All fields` | the 22 occupational families, **multi-select** |
| 4 | `LOCATION` | `Worldwide` | **new.** geography |
| 5 | `REMOTE` | `All` | **renamed.** On-site / Hybrid / Remote / Not stated, **multi-select** |
| 6 | `COMP` | `All` | pay bands |
| 7 | `SORT` | `Comp  Age` | ordering |
| 8 | `DIM SEEN` | `on` | toggle |

### The Location control is the design problem

Geography is hierarchical and unbounded. Country is a list of 25. Region and city
are not a list anybody can read. So this control cannot be one dropdown for long.

Design it to open at country level, ordered by count, with `Worldwide` first and
a `Not stated` row last, and design the path to region and city as a **typeahead**
inside the same panel — the reader types "lon" and gets places, the way every
large job site does it. Show both: the country list as it opens, and the panel
after three characters are typed.

Two things to solve in the drawing:

- **`Not stated` is the largest single row today** — 21,573 of 37,286 rows carry no
  resolved country. That is a fact about the data, and the site's rule is that an
  absence is drawn rather than hidden. It must be present, honest, and must not
  look like the recommended choice.
- **A country and a remote role are not exclusive.** A fully remote role belongs to
  no country. The panel has to make "Worldwide" and "Remote" feel like different
  questions, because they are, and they now sit in adjacent cells.

### The search suggestions

Strip them to query completions. One kind of entry in the list, no scope rows, no
mixed vocabulary. If a count appears beside a completion it must be the count that
query returns — see section 5.

Draw the panel in the site's own style. The native `<datalist>` cannot be styled,
so this is the one control whose mechanism changes; the brief for you is the
target, and the engineering cost is noted in the companion research.

## 5. The counts contract

Counts stay on every option. The owner's requirement is that they be accurate and
stay accurate, so they are part of the design, not decoration:

- **Every count in the strip answers one question: how many rows would remain if I
  chose this, with every other filter left exactly as it is.** Leave-one-out, over
  the current result set. The board already computes them this way.
- **No two controls may count different populations.** Today the search suggestions
  count the whole board and the Field dropdown counts the filtered set, and the
  same word carries two numbers two orders of magnitude apart. One population.
- **A zero is shown, not hidden**, and is not selectable. The research is explicit
  that removing options as they empty costs the reader their place; the site
  already pins "Not listed" at zero on the pay filter for exactly this reason.
- Counts are set in the same mono face as the rest of the numbers on this site,
  right-aligned in the row, thousands separated.

Design the zero state and the "every row is in one option" state, because both are
common once a reader has narrowed twice.

## 6. States to deliver

1. Resting, nothing chosen, both themes.
2. One dropdown open — Location at country level.
3. Location open with three characters typed, showing place results.
4. Two filters applied, with whatever you propose for showing what is applied.
5. A control where one option has zero rows.
6. A control where every row falls in a single option.
7. 1100 wide — the row wraps rather than scrolls.
8. 390 wide — the phone arrangement.
9. Focus-visible on every interactive cell, and the open cell's outline.

## 7. The visual system

Read it from the live site; these are the tokens it is built from.

- **Faces.** `N27` for sans, `Basier Square Mono` for mono. Labels in the strip are
  mono, uppercase, `--tracking-loose` (0.14em). Values are mono at `--size-100`
  (0.875rem).
- **Space.** 4px ramp: `--space-100` 4, `--space-200` 8, `--space-300` 12,
  `--space-350` 20, `--space-400` 16, `--space-500` 24.
- **Rules.** `--border-hairline` 1px between cells, `--border-heavy` 2px for the
  open cell's outline, drawn **inward** so the strip does not move when it opens.
  `--radius` is 2px. This is a sharp, square interface; nothing is rounded.
- **Colour.** Everything is a token and every token has a dark and a light value:
  `--color-surface`, `--color-foreground`, `--color-muted`, `--color-line`,
  `--color-line-strong`. Signal orange is reserved for one action per screen and
  the red `--color-stat-loss` is reserved for loss and kills. **Do not spend
  either on a filter.**
- **The menu.** Label left, count right, the chosen row and the hovered row on the
  hover surface, a dead option in the muted voice.

## 8. Non-negotiables

- **One menu is open at a time, ever.** Opening any control closes every other.
  The product already enforces this (`closeMenus()`); a design that shows two
  panels overlapping is not a design of this strip. The one place it has to be
  thought about rather than inherited is the phone pass, where a panel is wide
  enough to cover the controls that opened it.
- The row **wraps, never scrolls sideways.** A strip that scrolls hides the reader's
  own controls behind an edge, which is the one thing it exists not to do.
- **No chips, no gaps** in the row itself. Cells meet on hairlines.
- Every control must work **without JavaScript**: the strip is progressive
  enhancement over real form fields today, and a design that cannot degrade to a
  plain select and a submit button is not buildable here.
- **44×44pt minimum** hit target on phone.
- Nothing invented. If a number is on screen the product must be able to compute
  it from the night's sweep.

## 9. What not to do

- Do not put categories, fields or any other scope back into the search
  suggestions. That is the defect being removed.
- Do not default any control to a narrow scope. Everything defaults to all.
- Do not hide a control when it has one real answer — say the number.
- Do not introduce a second accent colour, a rounded corner, or a drop shadow.
- Do not design a modal filter panel for desktop. The strip is always visible.

## 10. Research this rests on

- NN/g, [Scoped Search: Dangerous, but Sometimes Useful](https://www.nngroup.com/articles/scoped-search/) —
  names the two implementations of scoped search and why running both is a defect;
  recommends multiselect refinement on the results page over a pre-search scope.
- NN/g, [Defining Helpful Filter Categories and Values](https://www.nngroup.com/articles/filter-categories-values/) —
  category labels must be concrete and precise; large value sets want hierarchy.
- NN/g, [Dropdowns: Design Guidelines](https://www.nngroup.com/articles/drop-down-menus/) —
  grey out unavailable options rather than removing them; users are confused when
  options come and go.
- Baymard, [search scope](https://baymard.com/blog/search-scope) — scope suggestions
  work, but only when styled distinctly from queries; a defaulted narrow scope was
  linked to site abandonment.
- Baymard, [filter UI](https://baymard.com/blog/ecommerce-filter-ui) — counts beside
  options are among the highest-impact improvements available to a filter UI.
- Baymard, [applied filters](https://baymard.com/blog/how-to-design-applied-filters).
- Observed live 2026-10-01: **Indeed**, **LinkedIn**, **Glassdoor**. All three use
  zero native selects and zero datalists; all three separate a keyword field from a
  geography typeahead from an arrangement facet. LinkedIn's arrangement filter is
  called Remote and is multi-select (On-site / Hybrid / Remote); it accepts
  `Worldwide` as a location. Indeed's keyword suggestions are pure query
  completions with no counts and no categories, and it solves multinational with a
  separate site per country — a route not available to us.
