# Telling someone their record is thin *for this posting*

**Owner's ask, 2026-09-27.** When a record matches a posting poorly, say so.
Never block the draft. The point is "read this one with a fine-tooth comb, and
consider what your record is missing" — not "you may not apply."

## The distinction that makes this hard

There are two different questions and the codebase currently answers only the
first:

| question | answered by | surfaced |
|---|---|---|
| Is your record thin? | `computeGaps` | yes — the room's `Check` row |
| Is your record thin **for this posting**? | nothing | no |

`computeGaps` counts entries and descriptions. It would report a full, rich
record as perfectly healthy while that record is being aimed at a Dutch
warehouse posting it shares not one word with. That is the live case:
`a-point-commercieel-magazijnmedewerker` drafted against an English
product-design record.

## The signal already exists and is thrown away

`relevanceScore(entry, vocabulary)` (tailor.ts) counts how many of the posting's
own words appear in one entry's title, employer and description. It runs for
every entry on every render — and its only consumer is the sort comparator in
`buildSections()`. The number dies there.

That number **is** the match measurement. No new model call, no new heuristic,
nothing invented.

Three measured values, all already computed per render:

1. **`relevanceScore` per entry.** Top score of 0 means no entry in the record
   shares a single word with the posting.
2. **`changeRecord.mirroredTerms`.** Empty means the posting asked for nothing
   the record holds — this is already the codebase's own "added for this
   posting" case, so its emptiness is the honest inverse.
3. **`changeRecord.counts.rewrote`.** Zero on a model draft means the model
   found nothing worth rephrasing toward this posting.

## What it must not do

**Never narrate a judgment.** This codebase refuses confident diffs everywhere:
the change record is derived by byte-comparison and its own comment says it is
"never narrated"; a cost line is omitted rather than estimated; a render carries
a gap report rather than padding itself out.

"This is a weak match for this role" is exactly the narration the rest of the
system refuses. It is also unfalsifiable and slightly insulting, and a person
who disagrees with it has no way to argue.

State the measurement and let the reader conclude:

> Nothing in your record uses this posting's language, and the model changed
> nothing for it. Every line here is your own words, unchanged.

That is checkable against the document in front of them — the highlight marks
are right there, and there are none. A person reading that draws the conclusion
themselves, and it is the conclusion we wanted, arrived at honestly.

## Where it goes

The room already has the slot. "What it changed for this posting" carries
`Rewrote` / `Added` / `Kept` / `Check` rows, and `Check` currently holds the gap
report. A thinness-for-this-posting row belongs there, beside the evidence,
rather than as a banner over the document.

Reasons to prefer the rail over a banner:

- it sits next to the very counts that justify it, so the claim and its evidence
  are read together
- it cannot be mistaken for an error state, which a banner above a document
  invariably is
- the person reached this page by pressing a button; a warning that interrupts
  the result of their own action reads as a block even when it is not

## The language case is the sharpest version

A posting in a language the record does not speak scores near zero on every
entry by construction, because `extractWords` overlap is the measure. That is
worth naming separately: "this posting is in Dutch and your record is in
English" is far more useful than a generic thinness note, and it is trivially
detectable from the same number.

## What has to change in code

`relevanceScore`'s output has to survive the sort. Carry a small summary onto
`ResumeRender`, optional and last, the same forward-compatible shape
`changeRecord` and `summary` already use, so a payload stored before this
existed reads back as undefined and every reader treats that as "no match
report":

```ts
readonly match?: {
  /** The highest relevanceScore across the record's entries. */
  readonly topScore: number;
  /** How many entries share at least one word with the posting. */
  readonly entriesWithOverlap: number;
  /** How many entries were considered. */
  readonly entriesConsidered: number;
} | null;
```

Everything else reads from values the render already carries.

## Open decisions for the owner

1. **The threshold.** `topScore === 0` is unambiguous and rare. A softer band
   ("fewer than N entries overlap") catches more but needs a number chosen, and
   a number chosen without evidence is the kind of thing this repo writes down
   and regrets. Suggest shipping the unambiguous case first and measuring how
   often it fires before widening it.

2. **Before or after.** This spec puts the warning on the result. It could also
   appear on the posting *before* drafting, where the fit score already lives —
   which would save the person a draft they did not want. That is a different
   feature with a different risk: discouraging an application someone had good
   reason to make.

3. **Whether the letter says it too.** The cover letter has its own evidence
   selection (`selectLetterEvidence`) and its own lint. A letter written from
   thin evidence is arguably the more dangerous document, since it makes claims
   in prose rather than listing facts.

## Not in scope, but found while writing this

`cover-context.ts:268-270` collapses the letter's word-count target when a
band's `softMin` exceeds the clamped `softMax`:

```ts
const softMax = band ? Math.min(base.softMax, band.softMax) : base.softMax;
const softMin = band ? Math.min(band.softMin, softMax) : base.softMin;
```

`softMin` is clamped down to equal `softMax`, producing a target range one word
wide — the live "264 words; the target is 240 to 240" warning. That lint can
essentially never pass, so it is noise that would mask a real length problem.
