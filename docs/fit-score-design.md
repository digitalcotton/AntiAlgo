# Fit, redesigned: a comparison, not a score

Companion to [fit-score-architecture.md](fit-score-architecture.md) (how it is
computed) and [thin-match-warning-spec.md](thin-match-warning-spec.md) (the same
judgement at draft time). Owner's ask, 2026-09-27.

## The reframe everything follows from

The number on the board is a completeness score for the crawled record. But the
deeper problem is that **three of its five components are already columns on the
same row.** `freshness` is the Age column. `comp` is the Pay column.
`apply_friction` is the Apply column. `remote_geo` is the Location column. The
score was a weighted re-encoding of facts the reader can already see, plus one
component that only checks the title is longer than two characters.

Strip the duplication and one honest question remains: **what does this posting
share with what this member has told us?** That is not a magnitude. It is a small
set of discrete comparisons, each with two named values on either side.

**Replace the score with four named comparisons, each in one of three states,
shown with both compared values.** No 0-100, no percentage, no bar, no band word.

The governing rule, to be written into the component header:

> A number may appear only when every unit it counts is named on the same screen.

"72/100" fails that. "2 of 4 matched", with the four rows listed underneath,
passes. This is the standard `FitBars` already holds itself to when it refuses to
print a back-filled component.

## The four checks

Fixed order, never varies, anywhere:

| # | check | member side | posting side |
|---|---|---|---|
| 1 | **Title** | titles on the watch list (`listWatches`) | the posted title |
| 2 | **Place** | `remoteOnly` / `country` from `LedgerSelection` | `remote`, `location`, `country` |
| 3 | **Pay** | `compFloor` from `LedgerSelection` | `comp_range.min` |
| 4 | **Words** | every Profile Record entry | posting text, via `relevanceScore` |

Three states, and the third is the important one:

- **Matched** — both values present, they overlap
- **No match** — both values present, they differ
- **Nothing to compare** — one side is missing

"Nothing to compare" is not a failed check and must never be drawn as one. This
is the distinction the codebase already enforces: `ease` is null rather than a
fabricated "Easy, 15 min"; a component outside its weight prints its value and
draws no bar; a cost line is omitted rather than estimated.

## Why not the alternatives

- **Bands (High/Medium/Low)** — still an aggregate verdict with the arithmetic
  hidden. "Low" is a word a member cannot argue with.
- **A short phrase per row** — most honest, but unreadable at 25 rows, and it
  forces generated prose, which `FitBars` explicitly refuses ("writing it here
  would be inventing the machine's reasoning").
- **A recalibrated 0-100** — the precision problem is intrinsic to the form.
- **No signal at all** — loses the owner's stated purpose.

## What it costs, plainly

1. **Ordering gets coarse.** Many rows tie at 2 of 4. Default order becomes
   matched-count then age. Some apparent sophistication of a ranked board goes
   away, and that is a real product loss.
2. **It needs a legend.** One look at the footer to learn. Native to this
   codebase (`MarkLegend`, "a mark never stands alone") but still a cost paid
   once by every member.
3. **A new member's column is mostly dashes.** Honest, and visually
   unimpressive beside a column of confident numbers.
4. **Pay and Place restate columns already on the row.** The added value is only
   the comparison to the member's own threshold. Someone will call them
   redundant; the argument is winnable but you will have it.
5. **Losing "100/100" loses an easy demo number.** Owner's call whether that
   matters commercially.

## What a low state means, as rules

1. **A low state is an absence, not an alarm.** Muted, sans, no colour, no icon,
   no border. `Mark.astro` reserves red for kill statistics and says so.
2. **Never a verdict noun.** Never "weak", "poor", "low", "unlikely", "stretch",
   "reach". Those narrate a judgement, which the thin-match spec rules out.
3. **The affordances do not move.** Draft and Apply identical in position,
   label, size and emphasis in every state. No dimming, no re-ordering, no
   confirmation step, no interstitial. An implementer will be tempted; this is
   written down so they do not.
4. **The only action offered is to the record, never to the decision.** The link
   reads **"Add to your Profile Record"** — the identical string the draft
   room's `Check` row already uses. Never "browse similar roles", never "see
   better matches".
5. **Prose appears only in the zero state.** Matched and partially-matched get
   rows and a stamp, nothing else. A paragraph about a middling result is
   narration.
6. **The anti-discouragement device is a statement about the measurement's
   limits, not encouragement.** This is the whole trick. You cannot reassure
   someone without judging them; you *can* state the truthful scope of what you
   measured:

   > This compares your record as it stands today. It knows nothing about why
   > you want this job.

   Checkable, not flattery, does not argue with their decision, and correctly
   locates the low state as a fact about a text comparison. Once per surface,
   never per row.

## Two moments, one judgement

**Same measurement, twice, the second holding evidence the first did not. Not an
escalation, not a different claim.**

The board's **Words** check and the draft room's thin-match row must read the
same `relevanceScore` top value, over the same record and posting text, through
one function with two call sites. If they can disagree, that is a bug.

Two legitimate differences:

- The draft room knows what the model actually did (`counts.rewrote`,
  `mirroredTerms`), so it may say **more**. It may never point the **other way**.
- The board runs four checks, the room runs one. Once someone has committed to
  writing, pay and location are settled and must not be re-litigated.

**Enforce coherence with a shared stem**, so the reader recognises the sentence
rather than receiving a second opinion:

> Board: *Nothing in your record uses this posting's language.*
>
> Draft room: *Nothing in your record uses this posting's language, and the
> model changed nothing for it. Every line here is your own words, unchanged.*

On the thin-match spec's open question 2 (before or after): **ship both, with one
condition.** The board version is safe *only* because it is named comparisons
with no aggregate verdict and no changed affordance. The moment an aggregate word
appears on the board, the risk the spec worries about becomes real. **The
aggregate word is the thing to refuse, not the early placement.**

## The empty record

| case | board |
|---|---|
| signed out | no column, sign-in prompt in the rail — **unchanged, already shipped** |
| signed in, nothing saved | column **not rendered**; one line above the table |
| signed in, titles but no record | column renders; Words shows "Nothing to compare" |

An all-dash column looks broken; an all-hollow column reads as "every job is
wrong". So for a member with nothing saved, one line above the table, not
per-row, not a modal:

> **Nothing is compared yet.** Name the titles you want and add your Profile
> Record, and every row starts showing what it shares with them.

The "titles but no record" case is the routing mechanism, and it beats a nag: the
member watches a dash turn into a real answer as they fill the record in.
Following the Come Ready rule — completion is the dismissal — there is no
dismiss control.

Detail page, empty record: `Against your record / Nothing to compare yet`. Never
`0 of 4`. A denominator with no numerator is both failure modes at once.

## Honesty: show both values, always

Every rendered check shows **both values**, not a conclusion. This is the single
most important implementation requirement.

```
Title    Matched
         You watch "Product Designer".
         This posting is "Senior Product Designer, Growth".

Place    No match
         You allow remote, and the Netherlands.
         This is on-site in Austin, TX.

Pay      Nothing to compare
         This posting prints no pay.

Words    Matched
         3 of your 14 entries use this posting's words:
         figma, onboarding, design systems.
```

A member who disagrees sees exactly which two strings were compared, and the fix
is always visible: change a watch title, change a floor, add an entry.

Two further requirements:

- **Stamp the record version used.** `4 compared · 2 matched · your record,
  27 Sep 2026`. Mono, same register as `FitBars`' working line. A member who
  edits their record and sees an answer change then knows why.
- **Keep the gate contract.** `FitBadge` carries `data-truth="fit"` today, and
  the gate header says a page that renders scores and declares none is a page it
  verified nothing on. Each rendered check needs the equivalent marker carrying
  the two values it claims to have compared.

## The language case: "not comparable", not a low score

A word-overlap measure against a Dutch posting has not *failed* — it **could not
be run**.

- On the board, **Title** and **Words** render as **"Nothing to compare"**, not
  "No match". Pay and Place still run honestly: a Dutch posting with a printed
  salary above the floor genuinely matched on pay.
- The board does not shout the language — the Dutch title is already in the Role
  cell two columns away. Its job is not to *lie* by scoring it zero.
- The explicit statement appears where they open it:

  > **This posting is written in Dutch. Your record is in English.**
  > The Title and Words comparisons read for shared words, so there was nothing
  > for them to compare.

**Why that phrasing survives its own false positive:** it is a claim about two
documents, never about the person's ability. A member who reads Dutch fluently
but keeps an English record reads a true sentence.

**Confidence rule:** name a language only on high-confidence deterministic
evidence. Below the threshold, fall back to *"No word in this posting appears in
your record."* Naming Dutch wrongly is a visible embarrassment; a half-claim is
worse than the generic one.

## Copy, by state

### Board column header
**`Matched`** (mono). Cell: four glyphs in fixed order, plus the existing `why`
button. Visually-hidden text per glyph: `Title, matched` / `Place, no match`.

### Board footer legend
```
Matched              Your record and this posting share this
No match             Compared, and they differ
Nothing to compare   One side is missing
Order: Title · Place · Pay · Words
```
And once per page:
> Four comparisons against what your record holds today. Nothing here filters
> the board or stops an application.

### Detail page stat

| state | dt | dd |
|---|---|---|
| comparisons ran | `Against your record` | `2 of 4 matched` |
| one check not comparable | `Against your record` | `2 of 3 compared, 2 matched` |
| nothing saved | `Against your record` | `Nothing to compare yet` |
| signed out | `Against your record` | `Sign in` |

The denominator shrinks when a check could not run. A denominator counting
comparisons nobody made is the same lie as a bar against an unmeasured
component.

### Detail rail card — title **What was compared**

High (everything comparable matched): the four rows, the stamp, nothing else. No
congratulation, no summary sentence. The rows are the statement.

Medium: the rows and the stamp. No prose — nothing is unexplained, so nothing
needs explaining.

Low:
```
Title   No match          You watch "Product Designer" and "Design Lead"
                          This posting is "Commercieel Magazijnmedewerker"
Place   No match          You allow remote and the UK · This is on-site in Rotterdam
Pay     Nothing to compare    This posting prints no pay
Words   No match          No word in this posting appears in any of your 14 entries

3 compared · 0 matched · your record, 27 Sep 2026

Nothing your record holds appears in this posting. This compares your record as
it stands today. It knows nothing about why you want this job.
Add to your Profile Record →
```

### Signed-out card (rewrite; "score" is gone)
Title: **This is compared to your record**
> Signed in, this posting is compared with the titles you watch, your pay floor,
> the places you allow, and the words in your Profile Record. Each comparison is
> shown with both values, so you can see what was read.

### Sort control
`Fit` → **`Matched`**, ordering by matched count, ties by age. `SortControl.astro`
currently carries an apology that "Fit blends the rubric with freshness, so a
sort named Fit is not a sort by seniority". **That apology can be deleted** — the
new label describes exactly what the new sort does, for the first time.

## Where each element sits

| element | file |
|---|---|
| column header, footer legend, no-data line, no-column variant | `src/components/JobTable.astro` |
| cell glyphs, `why` button, expander | `src/components/JobRow.astro` |
| the glyph (replaces the numeral) | `src/components/FitBadge.astro` |
| the four-row comparison block | `src/components/FitBars.astro` (bars go — a boolean has no fraction) |
| stat row, rail card, signed-out card | `src/components/job-detail-v2/JobDetailV2.astro` |
| sort label, deleted apology | `src/components/SortControl.astro` |
| the shared-stem line | `src/components/tailor/DraftRoomV2.astro` |
| "How this is compared" | `src/pages/methodology.astro` |

## What NOT to build

1. Any 0-100 personal score, including a recalibrated one.
2. Colour coding of state. Red belongs to kill statistics.
3. Hiding, dimming, down-ranking or default-filtering low-match rows. The board
   is never pre-filtered (owner, 2026-09-19) and the product is named for
   refusing exactly this.
4. A pre-draft warning, confirm step or modal.
5. Generated prose per check ("your leadership experience is light for this
   role").
6. A model call anywhere in the comparison. Every check must be reproducible by
   eye — that is what makes "argue with it" real.
7. Keeping the old rubric under a new name **on the member surface**. Two
   indicators on one row — one about them, one about crawl quality — is more
   confusing than either alone.
8. A percentage anywhere, including inside the expander.

## Owner's taste, not the designer's

1. The words: "Matched" as the column, "What was compared" as the card,
   "Against your record" as the stat.
2. Whether the old rubric survives at all on member surfaces. Lean: delete from
   member surfaces, keep internally.
3. Whether `Matched` is the default sort or opt-in. Defaulting to a personal
   ordering is itself a small algorithmic act.
4. Whether to name the posting's language at all. The fallback line works with
   no detector, so this is genuinely optional.
5. Whether **Words** is one of four or is primary. It is the only check reading
   the record rather than a preference, and the only one tying to the draft
   room. Kept equal here because unequal weighting reintroduces a rubric.
6. Whether four is the right number. A fifth is addable without redesign — the
   form is a list — at the cost of a legend line.
7. **Whether this line ships:** *"It knows nothing about why you want this
   job."* One degree warmer than the rest of the site, and doing the heaviest
   lifting in the low state. Worth fighting for; still a voice call.
8. Whether the empty-record line sits above the board, or only on the Desk and
   Come Ready, keeping the board free of onboarding entirely.
