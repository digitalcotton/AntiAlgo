# Master design prompt: The Weekly Read

Paste everything below the rule into Claude Design. It is written to be self-contained: the product, the reader, every number the site can honestly show, the visual system with exact values, the page architecture, and the rules a design must not break.

Research basis (2026-09-19): live reads of antialgo.ai/drop, /kills and /report; source of those three pages and every component they render; src/lib/readings.ts, data.ts, ledger-market.ts, desk-home.ts, desk.ts; db/*.sql; scripts/ingest-jobs.mjs.

---

## 1. Role and brief

You are designing one page for The Index (antialgo.ai), a nightly-verified job index for designers. The page is called **The Weekly Read**. It replaces three pages that today hold the same material in three registers: The Drop (what entered and died this week), the Kill List (every posting the machine closed and the rule it tripped) and The Report (the sweep's own counts beside cited research).

The job is to turn that spread into a single page a job seeker opens on Monday and acts on, and that makes a paid account feel worth paying for. Design it as one page with a public half and a signed-in half. The split between the two halves is the product's paywall, so it has to be legible at a glance.

Deliver: desktop at 1440 and one narrow pass at 900, in both light (paper) and dark (ink) themes, as high-fidelity mockups on this site's own system. No new colours, no new type, no new chart grammar beyond what section 5 lists.

## 2. Who is reading, and what they need on Monday

The reader is a product or brand designer looking for work. They are applying to five to twenty roles a week, they suspect a lot of postings are not real, and they have no way to tell which of their applications are still alive. They do not want a dashboard about our crawler. They want four answers, in this order:

1. **What is new that I should spend my first 48 hours on.** The research the site already cites says 45% of applications arrive inside 48 hours and 60% by 96 hours, and the median posting lives 7 days. New postings under the reader's titles, with a fit score and a head-start reading, are the most valuable thing on the page.
2. **What I should stop waiting on.** Postings under their titles that came down this week, and (signed in) the specific roles they applied to or saved that came down. A dead posting is not a job, but knowing it died is still useful: it closes the loop, stops the reader counting it, and tells them whether to follow up or move on. Treat it as a "close the loop" signal, never as an opportunity.
3. **Who to trust.** Which companies recycle postings (repost churn, touched-not-refreshed) and which companies also hold verified live roles this week. This is a trust read before the reader spends an hour on an application.
4. **Proof that the numbers are real.** Where every count came from and when. This matters to this audience but it is provenance, not insight, so it sits low on the page and small.

The reader is not interested in: how many boards we swept as a headline, the philosophy of kill rules as a lead section, or figures with nothing under their titles.

## 3. The data you may show (nothing else exists)

Every number below is real and available today. Anything not in this list cannot be on the page. Where a design needs a number that is not here, draw the absence (see section 6) rather than inventing one.

### 3a. Readings: measured by the sweep, true only of one night

All stamped with the sweep instant, formatted like `Swept Sep 19, 2026, 07:30 UTC`. Integers, no separators.

| Reading | Meaning | Today's value |
|---|---|---|
| boards swept | company feeds read tonight | 45 |
| postings pulled | postings read before verification | 82 |
| verified live | postings confirmed live at source tonight | 79 |
| killed by rule this sweep | postings a named rule caught tonight | 3 |
| kills on the record | every kill kept, all sweeps | 159 |
| kills on the record, per rule | repost churn 103, misrepresented 2, zombie 2, phantom and touched-not-refreshed also counted | as listed |
| killed by rule this sweep, per rule | same five rules, tonight only | repost churn 3, others 0 |
| entered this week | verified postings first observed in the seven days ending the sweep date | 5 of 79 |
| died this week | kills recorded in the same seven days | 90 |
| closed this week | verified postings whose own status moved live to closed | computed, count not printed today |
| stage clock | read, verify, kill, save instants for the sweep | arrives when the sweep writes it; show the empty state until then |

### 3b. Per-posting fields (live rows)

Fit score 0 to 100 with five components (title and scope, remote and geo, comp, freshness, apply friction, each with a one-line basis). Role as posted. Company. Pay as the employer printed it, or "Not listed". Location, plus Remote / Hybrid / On-site. Age in days with its basis ("Posted Sep 15, 2026" or "First seen Sep 16, 2026"). Apply ease ("Easy · ~12 min · no account") and the source system ("Apply on Greenhouse"). Verification mark: verified this sweep, re-verified, closed.

### 3c. Per-kill fields (the record)

Company and title. The rule tripped, one of five: repost churn, misrepresented, zombie, phantom, touched not refreshed. A plain one-sentence finding built from evidence scalars, e.g. "Brex took this role down and put the identical text back up 16 days later, under a new link, dated Sep 3, 2026." First published date. Killed date. Days open (killed minus first published) drawn against a reference line of 7 days, the cited median posting life. Times fired (how many nights the same posting tripped a rule). Found by: verified sweep or wide crawl. Live siblings: other roles at the same company verified live tonight, each with its fit score. Links: the archived posting, share this record.

### 3d. Per-company reads (computed today on the Jobs Data page, reusable here)

Kill count, repost-churn count and worst times-fired per company. Live count per company. Region and representative source system.

### 3e. Cited research (static, quoted word for word, source under it)

- "45% of applications arrive within 48 hours of a posting going up, and 60% within 96 hours" (Davis and Samaniego de la Parra, NBER Working Paper 32320, 125 million applications).
- "Median posting life is 7 days; only a quarter stay up past two weeks" (same source).
- "The average job now draws about 254 applications" (Greenhouse, via Fortune, July 2026).
- "40% of hiring managers admit posting a job they never intended to fill" (ResumeBuilder survey).
- "49% of hiring managers name AI-generated sameness a top red flag" (Resume Genius, 1,500 hiring managers, August 2026).

Readings and citations are two kinds of number and never sit on one axis or in one sentence as if they were the same thing.

### 3f. Member data (signed in only)

Watched titles on two shelves, core and stretch. Saved roles. Applications with a state (clicked, applied, abandoned, still working, interviewing, offer, closed), confirmed date, and the reader's own close reason. A per-member "last looked" clock that defines "new since you last looked". Desk preferences: remote only, comp floor.

What the member data can be joined to, today: watched titles against tonight's live rows and against kills (this exists, it is the Desk's "Died on your list" lane). Applications against kills by company and title (exists on the Opportunities tracker as a one-line fate: "The posting came down: repost churn").

What does not exist yet and must be designed as a state, not assumed: a direct join of the reader's applications to the kill record by posting URL, and any week-over-week trend. The sweep keeps one night of counts, so there is no time series. Do not draw a line chart, a sparkline or a delta arrow anywhere.

## 4. Page architecture: one page, two halves

Order is by usefulness to the reader, not by what the crawler did first.

**Masthead.** Eyebrow in the machine voice: `Swept Sep 19, 2026, 07:30 UTC`. Title in the human voice, one line, e.g. "The week, read at source." Lede: what entered, what died, what changed, all from the same files every other page reads, nothing estimated.

**A. Your week (signed in; signed out it is the shop window).** Four cells on one row, each a number with a label, sized like the report's hero numbers: new under your titles, died under your titles, applications that came down, still open of what you applied to. Signed out, the same four cells render as hatched empty slots with the one-line reason ("Sign in and these are yours") and a single Save my spot action in signal orange. This row is the paywall.

**B. Spend your first 48 hours here.** The entered-this-week list, narrowed to the reader's titles when signed in, the whole set when not. Each row: fit score with the why panel, role, company, pay, location, age with basis, apply ease. A head-start chip on rows two days old or younger, derived from the arrival curve and labelled as an estimate from the cited source. Beside the list, one distribution figure: the arrival curve (45 / 60 / not published) with the 7-day median as a note. This is the only place research sits next to live rows, and the figure carries its own source line.

**C. Stop waiting on these.** Signed in, two stacked lists: roles you applied to or saved that came down this week (company, role, your state and date, the rule, the plain finding, days open bar), then died under your titles. Signed out, only the second list, company names shown as they are on the public kill list. Empty states are written, not blank: "Nothing you applied to came down this week."

**D. Who recycles.** A ranked-bars figure of companies by kills on the record this week, one scale, with repost churn and times fired stated per row, and a "also holds N verified live roles" line where true. Not a leaderboard: the copy says the order is by count and the count is a reading. Link each company to its live roles.

**E. What the rules found.** The five-rule tally, this sweep and on the record, side by side, with the one-line observation each rule makes. Demoted to a compact strip; the long form stays on the kill list.

**F. Proof.** The four sweep tiles (boards swept, verified live, kills on the record, killed by rule this sweep), the stage clock when present, and the method list in short form: read direct, one clock, nothing modelled, every figure sourced. Links to the kill list, the report and methodology.

**Sponsor slot** stays as an aside below F, labelled as one, never among rows.

If a split into two pages is ever needed, the seam is between C and D: A to C is "your week" and D to F is "the market's week". Do not split elsewhere.

## 5. The visual system (exact values, do not restyle)

**Type.** Sans: N27 for everything human (titles, ledes, labels, absences). Mono: Basier Square Mono for everything the machine says (numbers, dates, statuses, scores, source lines, rule names). Weights: 300 display only above 40px, 400 body, 500 labels and chrome, 700 titles. Sizes in rem: 0.78 caption, 0.82 mono labels, 0.875 small, 0.95 narration, 1.0625 body, 1.25, 1.625, 2.25 tile figures, 3.25, 4.75 page hero number. Leading 1.7 body, 1.05 display. Mono labels are uppercase with 0.14em tracking. Numerals are tabular.

**Colour, paper theme.** Paper #F6F5F2, white panel #FFFFFF, ink text #0B0B0D, muted text #6B6966, hairline #D8D5CE, heavy border #B9B6AF, hover wash #ECEAE5, hatch stripes #ECEAE5 / #EDEBE6. Live green #1E7945. Loss red #A53A2E (statistics and duration bars only, never a row mark). Stale amber #7E5200 (our own freshness only). Signal orange #FF5A1F for the one thing that acts (the sign-up or save-my-spot action), same value in both themes.

**Colour, ink theme.** Surface #0B0B0D, raised #141416, text #F6F5F2, muted #A8A5A0, hairline #2A2A2C, heavy #6B6966, hatch #141416 / #1B1B1E. Live #57C288. Loss #E58D7F. Stale #E8B15A. Signal #FF5A1F.

**Structure.** 1px hairlines everywhere inside panels, one heavy rule under section headings, 2px radius, no shadows, no gradients. Section heading: human-voice h2 over a heavy top rule. Panel title: mono label band. Rows sit flush to the panel edge. Stat tiles: four across with hairline dividers, 2 by 2 at phone width. Page shell 86rem wide with 16 to 36px side gutters.

**Charts, the whole allowed vocabulary.**
- Hero number: mono bold numeral, label in sans muted, loss or live tone.
- Ranked bars: single-hue horizontal bars on a hover-wash track, label left, mono value right, no axis, no gridlines, one shared scale.
- Distribution: one full-width track split into segments (ink, muted, hover wash), hairline cut marks, a three-key legend, an absent segment labelled "Not published" in sans.
- Duration bar: loss-red fill on a hover-wash track with one heavy reference line and a caption naming the reference and its source.
- Stat tile and rule tally: number plus caption, no bars.
- Hatched slot: diagonal two-tone stripes for an empty or gated cell.
No pie, no donut, no line, no sparkline, no stacked column, no icon set, no illustration.

**Motion.** One curve, cubic-bezier(0.5, 0, 0.2, 1). 150ms colour transitions, one 320ms signature moment at most, none under reduced motion.

## 6. Rules the design must not break

1. Every number is either a reading (stamped with the sweep) or a citation (source line directly under it). Never mix the two on one axis.
2. Absence is drawn, never filled: "Not listed", "No date shown", "Not published", a hatched slot. No placeholder data, no "~", no estimates without the cited source named.
3. One clock: the sweep instant. No "updated 2 minutes ago", no render time.
4. Nothing modelled: no trend, no projection, no line between two points, no delta arrows. There is one night of counts.
5. Red belongs to loss statistics and duration bars only. Row status marks are green (live) or grey (closed). Orange is for the single action.
6. Kill copy states what the machine observed, never why a company did it.
7. Dead postings are never presented as opportunities. Section C's action is closure, not apply.
8. Contrast AA on every text and figure in both themes (the token values above already clear it).
9. Copy uses straight quotes and no dashes of any kind. "Resumé" is spelled with the accent wherever it appears.
10. Company names: shown on public kill rows today; on signed-in member surfaces they are held back by owner policy. Design section C with the name and with a "company held" chip so both states exist.

## 7. What to hand back

Desktop 1440 and 900, paper and ink, for: the full page signed in with real-looking data drawn only from section 3; the same page signed out with sections A and C in their gated states; the empty states for A, B and C (nothing entered, nothing died, nothing you applied to came down); the stage-clock cell before and after the sweep writes it. Annotate each figure with the reading or citation it draws and the source line text.
