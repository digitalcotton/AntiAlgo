# Job detail, page-scoped

Everything in this directory belongs to one route family and nothing else
composes it: `/role/[slug]`, its markdown twin at `/role/[slug].md`, and its
share card at `/role/[slug].og.svg`. All three are served under the site's base,
so the URL a reader sees is `/jobs/role/<slug>`. Never write that prefix out:
`jobPath()` in `src/data/nav.ts` is what puts it there.

It exists because those three surfaces have to agree about one posting. A page
that says a role is live and structured data that says it expired last month is
worse than either alone, and that exact defect happened once here and is
recorded in `detail.ts` where it was fixed.

Read `src/components/README.md` and `src/lib/data.ts` first. Nothing here
recomputes anything they already own.

## What is in here

| File | What it is |
| --- | --- |
| `detail.ts` | The three answers the shared layer does not own: the verification window, the row position in the index, and the wording of the apply caption. Plus the JSON-LD builder. |
| `ApplyAction.astro` | The apply button and the line naming where the click goes. Throws if composed on a closed record. |
| `DescriptionSlot.astro` | The employer's own description, or the hatch that marks its absence. |
| `ClosedHistory.astro` | The full history of a closed posting, oldest first, dates only. |
| `ClosureRecord.astro` | The closure facts that only exist on a closed record. |
| `LiveSiblings.astro` | Roles at the same company verified live on the same sweep, computed. |

## The rules this directory adds to the shared five

1. **No apply path exists anywhere on a closed page.** `ApplyAction` throws at
   build time rather than trusting a caller to remember. The markdown twin drops
   its whole apply section for the same reason: a machine reading the file
   cannot be handed a path the page refuses to show a person.

2. **JSON-LD is a claim, so it is only made where it is true.** A closed record
   emits none. `datePosted` appears only on the three rows whose source showed a
   date. `description` appears only when the machine fetched one, which is never
   in this fixture, and Google's complaint about the missing field is the honest
   outcome rather than a reason to write the employer's copy for them.

3. **The verification window is ours and says so.** `validThrough` is the only
   computed date on the page. It runs from the sweep, never from the source's
   published date, because re-verification refreshes it and a window anchored on
   publication put an expiry in a live posting's own past. See `expiryOf()`.

4. **A style that has to reach a shared component reaches it through an element
   this route owns.** A class passed down to a child component arrives without
   this page's scope attribute, so the rule never matches. Wrap it, or use
   `:global()` under a selector from this template. Measured the hard way: the
   ease panel's phone-width rule shipped and did nothing.

## What is blocked upstream

- **The "same family" list on a closed page.** The canvas fills the empty
  siblings case with three roles at other companies in the same role family. The
  records carry no role family, and reading one out of job titles is the
  classification already refused for the kill list taxonomy and the index's
  fourth filter. The absence is stated instead.
- **Per-component fit reasoning.** `FitBars` writes no prose and this route does
  not add any. The sentences on the canvas exist for one hand-worked example.
- **A raster share card.** The two faces ship as woff2 only, and the rasteriser
  already in the tree cannot read a woff2 from a data URI. A ttf or otf cut
  unblocks a build-time PNG with nothing new installed.

From the public canon of tokenstoagents.ai · (c) 2026 Ryan Payne · CC BY-NC-ND 4.0 · see LICENSE.md
