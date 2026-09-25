# Description coverage repair

Opened 2026-09-24, after a Breezy posting reached the board with an empty
description slot and a byline that called Breezy "the company site".

Two repos, two machines:

- **site** — `~/Documents/Devlopment/AntiAlgo` on the MacBook, branch `fix/come-ready-pass`
- **machine** — `~/jobmachine` on the mini, branch `coverage/run`

## What was actually wrong

The crawl record for 2026-09-24 holds 39,245 rows, 2,487 of them in scope.
86 in-scope rows carry no description:

| system | in scope | no description | why |
|---|---|---|---|
| breezy | 43 | 43 | list endpoint has no description key; `descfill` not allowed to fill it |
| bamboohr | 33 | 33 | same, and the detail page is JS-rendered so the generic read fails |
| personio | 10 of 77 | 10 | same as breezy, intermittently |
| everything else | 2,334 | 0 | — |

`descfill.py` already exists to read text off a posting's own page. Its gate is
an allowlist of four systems written before the Phase C adapters shipped
(2026-09-22), so the new boards were never eligible.

Separately, `sourceSystemOf()` collapses every board the site does not name to
`'custom'`, whose label is "the company site" — 418 in-scope rows, 17% of the
board, misattributed.

Neither fault was reported by anything. The nightly report counts rows per
board and never asks whether the rows have anything in them.

## Tickets

| # | where | what | state |
|---|---|---|---|
| T1 | machine | Field coverage in the nightly report, loud on a zero | done — `f496846` |
| T2 | machine | `descfill`: allow breezy and personio | done — `3619916` |
| T3 | machine | BambooHR: read the detail endpoint | done — `c10b6d3` |
| T4 | machine | `descfill`: ask the general question, not the allowlist | done — `02fe929` |
| T5 | site | Name the board a posting actually came from | done — `3c84b88`, conform green |
| T6 | machine | Audit the eight Phase C capability maps | done — findings below |
| T7 | machine | Carry `comp_posted` through `descfill` | done — `8e53af2` |
| T8 | machine | Teamtailor: the stated pay is one endpoint over | done — `de303f9` |
| T9 | machine | A zero is only news when the adapter said otherwise | done — `0b649f4` |
| T10 | site | A row that shows a salary must not sort as unpaid | done — `ae5dea1` |

T8, T9 and T10 were not on the original list. Each came out of the work:

- **T8** is what T6 found — teamtailor's capability map declares pay absent while
  the per-posting page carries it. Same defect as BambooHR, on the largest of
  the eight boards.
- **T9** is a defect in T1. The first version treated any 0.0% as a finding,
  which is nine false alarms on the first night against two real ones. An alarm
  that cries wolf gets muted, which is where this whole repair started. A
  finding is now a disagreement between what an adapter declares and what the
  record shows — which also catches a map claiming a field is absent while the
  rows carry it, i.e. T6's defect class, found by the machine instead of by
  hand.
- **T10** is what T7 exposed. The comp cell and the comp sort read the same
  string with two different regexes; the display one matches `$150,000` and the
  sort one requires a literal `k`. Pre-existing, and about to affect far more
  rows now that BambooHR postings carry pay in exactly that format.

### T1 — Field coverage in the nightly report

The root cause. A board returning 1,749 rows with every description blank looks
identical, in every report the machine writes, to a board returning 1,749 good
ones.

Measure per board system, after `descfill` has run so it reflects what actually
ships: `description_html`, `published`, comp (`comp_posted` or `comp_range`),
`apply_url`. Write it to `data/reports/`, print it in the nightly log, render it
into the morning crawl report. A system at 0% on a field its adapter claims to
fill raises the alarm that already reaches the phone.

Must not be able to fail the sweep.

### T2 — `descfill`: allow breezy and personio

`FILL_SYSTEMS` at `descfill.py:39`. Verified by hand against live postings on
2026-09-24: breezy returned 5,892 chars, personio 5,586. The machinery works
unchanged; only the allowlist stops it.

### T3 — BambooHR: read the detail endpoint

`{slug}.bamboohr.com/careers/{id}` is JavaScript, so the generic page read
returns `no_content`. `{slug}.bamboohr.com/careers/{id}/detail` returns JSON
carrying `result.jobOpening.description` — 12,127 chars on the posting sampled
2026-09-24 — plus `datePosted` and `compensation`.

Needs a `resolve()` plan in `postfetch.py`, not just an allowlist entry.

The adapter's capability map states as fact that no posted date and no salary
field exist anywhere in the feed. That is true of the list endpoint and false of
the detail one. The map has to be corrected, with the date of the re-check, or
it goes on misleading the kill rules.

### T4 — `descfill`: ask the general question

The allowlist is the actual defect: it asks "is this row from one of four boards
I was told about in September" when the honest question is "does this row have a
url and no description". Every adapter written from here hits the same wall
silently.

Flip it, keep a small opt-out for boards known not to answer, and leave the
per-night budget doing what it already does — a board fills in over a few
nights.

### T5 — Name the board a posting actually came from

`KNOWN_SOURCES` (`src/lib/board-jobs.ts:85`) and `SOURCE_LABELS`
(`src/lib/data.ts:2555`) never learned the Phase C systems, so
`sourceSystemOf()` drops them all into `'custom'`. The page then reads "Read
direct from Alectrona Llc's the company site board".

Adding six names is a patch; adapter nine breaks it again. `atsLabel()`, twenty
lines below in the same file, already does the right thing with a board it does
not know. The fix is to make `sourceLabel` behave the way `atsLabel` already
does, and to let `sourceSystemOf` pass an unknown board through rather than
flattening it — `'custom'` goes back to meaning what it says, a posting on the
employer's own site.

Blast radius checked: `source_system` is read in three places
(`applyLabel`, the `'custom'` branch in `added-posting.ts`, and
`assertSourceSystems`). The contract runs over the static design fixture, not
the DB board, so it is not in this change's path.

### T6 — Audit the eight Phase C capability maps

BambooHR's map was written from the list endpoint and is confidently wrong about
two fields. The kill rules read those declarations. Any adapter written the same
way carries the same risk: check each of the eight for a detail endpoint holding
a field the map calls absent.

### T7 — Carry `comp_posted` through `descfill`

`descfill` carries description and published date. BambooHR's detail endpoint
also states pay in a dedicated field — not prose, so the standing rule against
parsing pay out of prose does not bar it. `comp_posted` takes the stated text;
`comp_range` stays null, because nothing structured was given.

## Rules for this repair

- One ticket, one commit.
- Nothing about the design changes. T5 changes which words a byline prints
  because the current words are false; no layout, no styling, no sections.
- `npm run conform` is the gate on the site side; the mini's own test files are
  the gate there.
- The mini is edited by copying the file down, editing it, copying it back — no
  whole-file rewrites over ssh.

## T6 findings

Read-only audit, 2026-09-24. BambooHR excluded (already known wrong, already
being fixed elsewhere — it's the worked example, not a target here).

Method: read each adapter's docstring and `CAPABILITY` dict, checked whether
`postfetch.py`'s `resolve()`/`board_of()` know a detail route for it (they
don't — none of these eight platforms are wired there yet; T3's bamboohr fix
will be the first), read `ACCESS-LEDGER.md`'s entry for the platform, and
where the ledger didn't forbid it, fetched two live postings. Every claim was
also checked against `data/tracking/all-latest.json` (39,245 rows,
2026-09-24).

### Coverage table

| system | rows | tenants | description_html | published | comp_posted / comp_range | apply_url |
|---|---|---|---|---|---|---|
| bamboohr | 1,193 | 142 | 0% | 0% | 0% / 0% | 100% |
| breezy | 1,749 | 95 | 0% | 100% | 0% / 0% | 100% |
| icims | 2,960 | 90 | 100% | 100% | 0% / 0% | 100% |
| jobvite | 28 | 2 | 100% | 100% | 0% / 0% | 100% |
| recruitee | 1,697 | 145 | 100% | 100% | 27% / 27% | 100% |
| successfactors | 0 | 0 | — | — | — | — |
| taleo | 0 | 0 | — | — | — | — |
| teamtailor | 3,767 | 293 | 100% | 100% | 0% / 0% | 0% |
| personio (pre-Phase-C, not one of the eight) | 1,685 | 148 | 95% | 100% | 0% / 0% | 100% |

### Verdicts

**breezy — CORRECT.** `printed_deadline` ABSENT and `first_seen` AVAILABLE
both match the record exactly: `published` is 100% across 1,749 rows/95
tenants, and nothing anywhere names a deadline field. `structured_comp`
ABSENT matches too (0% at 1,749 rows). The description gap (0%) is real but
isn't a capability-map claim — there's no description key in `CAPABILITY` —
that's T2's territory, not this one. Ledger status is blocked (a ToS
reading, not robots); nothing new was fetched, none was owed.

**icims — CORRECT, and the best-evidenced of the eight.** This adapter
already reads a per-posting page (the iframe variant), not a list, and its
own research caught that the JSON-LD's `datePosted`/`validThrough` are
server-generated (measured to move between two fetches three minutes apart)
rather than real dates — the exact check bamboohr's authors skipped.
`printed_deadline` ABSENT and `first_seen` (published from the sitemap's
`lastmod`, a ceiling, said plainly) both hold at 2,960 rows across 90
tenants: 100% published, real dates. `structured_comp` ABSENT holds at
0/2,960. Ledger status is blocked (Terms of Use, not robots); respected — no
new fetch, and none was needed, the existing evidence is already solid at
scale.

**jobvite — UNDER-EVIDENCED.** `CAPABILITY` was written entirely from
`Xml.aspx`'s bulk XML (a tag-level keyword scan across all 28 CARFAX
postings) and says so honestly. But every posting also has its own detail
page — `app.jobvite.com/CompanyJobs/Job.aspx?c={id}&j={id}` — which is the
same `detail-url` field the adapter already extracts and uses as the row's
`url`, and never fetches for anything else. Fetched two live postings from a
second tenant (2B Residential, the ledger's own "cheap to keep current"
example) to check: both detail pages carry a full schema.org `JobPosting`
JSON-LD with a `baseSalary` field (a structured `MonetaryAmount`/
`QuantitativeValue` block) and a clean ISO `datePosted` — neither of which
`Xml.aspx` has, since the keyword scan that produced "absent" never looked
here. Both sampled `baseSalary` blocks were empty templates (currency,
minValue, maxValue all `""`), so this isn't a demonstrated case of a
populated field like bamboohr's — the schema key exists, whether it's ever
filled is still unmeasured. `printed_deadline` ABSENT: `validThrough` was
also `None` on both samples, so that half of the claim survives even on the
detail page. Settle it by pulling detail pages across a wider, more diverse
sample (CARFAX plus others, once discovery grows past two known tenants) and
checking whether `baseSalary` is ever non-empty.

**recruitee — CORRECT.** The list endpoint already returns everything a
detail endpoint would (`close_at`, `published_at`, a structured salary
object are all inline), so the hidden-detail-route failure mode can't happen
here. The map's own sample numbers (13/23 kravet, 0/28 greatminds) generalize
cleanly: 466/1,697 (27%) of every recruitee row in the live record carries
comp, matching "tenant-dependent." Worth noting for the record: the ledger
shows an *earlier draft* of this entry made a bamboohr-shaped mistake —
claiming no tenant ever discloses a range, when 13 of kravet's 23 offers do —
and it was caught and corrected before it reached the adapter. What shipped
in `CAPABILITY` reflects the correction, not the mistake.

**successfactors — UNDER-EVIDENCED, self-flagged.** Every claim in
`CAPABILITY` is written "n=1" against one tenant (adidas) and says so
in the text — this is the most honestly-hedged of the eight, not the most
wrong. Two things worth recording that aren't capability-map bugs: (1) there
are zero successfactors rows anywhere in today's live record — the adapter
has no configured employer, so nothing here has been checked against reality
since the night it was built; (2) the docstring documents a real, separate
bug: the job page's `date` span is an actual posted date (e.g. "Sep 8,
2026") but `sweep.parse_date` doesn't accept that shape, so `first_seen`
silently falls back to the sitemap's last-modified ceiling every time. That's
a parser gap worth its own ticket, not a false capability claim. Ledger
permission is unclassified and recommends not building further; respected —
nothing new fetched.

**taleo — NOT CHECKED, correct by default.** The adapter has never
successfully pulled a job record from any tenant — zero rows in the live
record confirms it. Every `CAPABILITY` value already reads "not verified,"
so there's no false claim to find because no claim has been made yet.
Ledger permission is unclassified and the one located governing-terms host
returned 403 under never-retry-a-403; nothing fetched.

**teamtailor — WRONG, the same shape as bamboohr.** `structured_comp` says
"ABSENT ... no schema.org baseSalary ... exists anywhere in this route,"
correctly scoped to the RSS feed — but the same docstring separately admits
the per-job page carries a schema.org `JobPosting` JSON-LD it "deliberately
does not fetch." Fetched two live postings (123pousse, a real tenant in the
record) to check: both job pages carry a full `JobPosting` JSON-LD with a
**populated** `baseSalary` (EUR, monthly — one posting 2,100–2,300, the other
1,900 flat) and a real `datePosted`. Unlike jobvite's empty template, these
are live numbers a comp feature could use today, and the capability map
tells the kill rules they don't exist. `printed_deadline` (`validThrough`)
was `None` on both samples, so that half of the claim is unresolved either
way, not shown wrong. Ledger status is not blocked (P1, "build regardless,"
the RSS route reproduces cleanly) so this fetch was in bounds.

**personio (not one of the eight; pre-Phase-C, found per instructions in
`sweep.py`'s `pull_personio`) — no formal capability map to grade,** just an
inline comment ("No comp field exists in this feed"). It matches the record:
0/1,685 rows carry comp. `description_html` is 95% (1,593/1,685), consistent
with the intermittent gap already tracked (T1/T2), not a new finding. Ledger
permission is unclassified (the governing terms document sits behind a 429
checkpoint, never retried); nothing fetched.

### Worth fixing, ranked

1. **teamtailor `structured_comp`.** Highest value: confirmed, populated
   salary data sitting on a per-job page the adapter already has the URL for
   (from the RSS `<link>`) and never reads. Cost is small — one more GET per
   posting (293 tenants, ~3,767 postings today), a JSON-LD parse close to
   icims's own, and correcting the `CAPABILITY` dict plus wiring
   `comp_posted`/`comp_range`. Same shape as T3/T7's bamboohr fix; likely
   reuses the pattern directly.
2. **jobvite's Job.aspx detail page.** Worth the same per-job fetch for
   `datePosted` alone (a clean ISO date, better than `Xml.aspx`'s ambiguous
   one-day-granularity `date` tag with undocumented semantics), even before
   `baseSalary` is proven ever-populated. Cost is low, but the payoff is
   thin today — only two tenants are known, and jobvite discovery is
   manual, one employer at a time (per the ledger).
3. **successfactors' `parse_date` gap.** Not a capability-map bug, but a
   cheap win once the platform has a configured employer: teach
   `sweep.parse_date` (or a scoped fallback) the "Mon D, YYYY" shape and
   `first_seen` stops being an always-a-ceiling `lastmod` proxy on a
   platform that otherwise has no way to get a real posted date.
4. **breezy, icims, recruitee, taleo, personio** — no capability-map
   correction owed right now; each map already matches what its own
   evidence and the live record show.


## Closed 2026-09-24

All ten done. Seven commits on the machine (`3619916`, `c10b6d3`, `02fe929`,
`f496846`, `8e53af2`, `0b649f4`, `de303f9`), two on the site (`3c84b88`,
`ae5dea1`). Nothing pushed.

Proof: the machine's full suite is 156 passed with every commit in place — run
once at the end, because each agent had only ever run its own tests. `tests/`
carries 4 failures in `test_archive.py` and `test_config.py`; those are
reproduced at `44ba8e4`, the commit before this repair began, and are not
ours. The site is `npm run conform -- --deep` GREEN, 7 of 7.

The coverage alarm against the live record went from 11 findings to 2, and the
2 are breezy and bamboohr on description — the faults this repair fixed at the
source, which clear on the next sweep.

### Left open, deliberately

- **successfactors and taleo pull zero rows in production.** Two shipped
  adapters, nothing coming through either, so their capability maps have never
  been tested against anything. A bigger hole than a wrong field declaration
  and not in this repair's scope.
- **Teamtailor's `printed_deadline` is the same defect a third time.** The map
  declares no deadline exists; the detail page carried a populated
  `validThrough` on one of six tenants sampled. The zombie-deadline kill rule
  depends on that declaration, so a real rule is switched off by a false claim.
- **Teamtailor's detail `datePosted` truncates to midnight** while the list
  keeps the real instant, contradicting the docstring's claim that the two
  carry the same moment. Harmless today because the list wins; wrong on the
  record.
- **The disagreement rule has a blind spot.** T9 catches a map that lies about
  its platform. It cannot catch a map that accurately describes an adapter
  which never looks — teamtailor's map and teamtailor's behaviour agreed
  perfectly and were both wrong about what Teamtailor offers. That class still
  needs someone to go and look.
- **`comp_range` from a structured `baseSalary`.** Teamtailor and BambooHR both
  hand over real numeric min/max with a currency and a period. `descfill` has
  no path for it, so only the text went to `comp_posted`.
