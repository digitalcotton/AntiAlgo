# The data contract

The site is a static build of one nightly sweep. Everything a reader sees comes
from four files, and this is what each one has to contain for the build to run
at all.

    src/data/jobs.json     every posting verified this sweep, plus every closure
    src/data/kills.json    every posting killed by rule this sweep
    src/data/stats.json    the sweep's own totals, and the site's only clock
    src/data/facts.json    the eight statistics allowed anywhere on the site

The first three are the machine's output and are replaced wholesale by every
sweep. The fourth is this repository's, changes only when a human adds a source,
and is the reason a new statistic cannot arrive by accident.

Schemas for the three sweep files are in `/schemas`. They are the document the
export script validates against, and they carry the reasoning for each field in
its `description`, so a reader who wants to know why `age_days` exists and is
never read has one place to look.

## What the build enforces, and where

`src/lib/data-contract.ts` runs before a page renders. Four failure modes, and
BUILD.md phase 2 names the first three:

**Missing.** A file with no `jobs`, `kills` or `facts` array is a load that
failed and the build stops. An *empty* `kills` array is not: it is the best
night the machine can have, and the kill list has a designed state that says
"nothing died this sweep, which happens and is worth saying plainly". Missing
and empty are told apart by the key, never by the length. This distinction was
wrong for a while and would have killed the build on the one night the product
worked perfectly.

**Malformed clock.** `stats.swept_at_utc` has to be a UTC instant shaped exactly
like `2026-08-17T02:14:00Z`. Every rendered timestamp on the site is that
string, so a shape the site cannot parse is not a fixable rendering problem.

**Stale.** Data older than 48 hours fails the build. A site whose headline is
"verified last night" cannot be published from a sweep that did not run, and the
failure has to be loud rather than a page quietly showing last week as though it
were last night. A stamp in the future fails too, and it is the more dangerous
of the two because zero hours old reads as fresh.

The one exception is labelled and narrow. A file that declares `_meta.fixture:
true` is a build fixture rather than a push, and a fixture is a photograph of one
night that goes stale by construction. Those report their age loudly on every
build and do not stop it. Data from the machine must never carry that flag.

**Internally inconsistent.** The three files describe one sweep from three
angles and the whole product rests on them agreeing:

    stats.verified_live  ==  jobs.json records with status live or re_verified
    stats.killed         ==  kills.json record count, held records included
    stats.pulled         ==  verified_live + killed
    sum(stats.killed_by_rule) + stats.killed_unattributed  ==  stats.killed
    stats.killed_by_rule holds a count for EVERY rule, zeroes included
    stats.killed_by_rule totals the kills.json records carrying a kill_rule
    every job's last_verified == stats.swept_at_utc
    every job's fit components sum to its fit total
    every job's source_system  ==  the board its source_url and apply_url are on

Each of those is a sentence the fixture's own `_meta` already claimed in prose.
The contract is that claim made checkable.

The last line is the newest and it came from a defect rather than from a claim.
One sweep 001 record named `ashby` while both of its links pointed at the
company's own site, so the site printed "Apply on Ashby" and "Ashby, read direct"
beside a link that went somewhere else, and `/methodology` counted the record
under Ashby in the table that says which boards were read direct. `custom` and
`founder_post` name the absence of a board, so they are the right answer for any
host outside the table in `src/lib/data-contract.ts` and the wrong answer for
every host inside it. Both URLs are checked, because both carry the label.

All four modes are proved by `npm run data:prove`, which runs the contract
against deliberately broken trees in `test/fixtures/should-fail/data/` and then
runs a real build with the clock moved forward to show the freshness check
firing inside the build rather than only in a test. A check that has never
failed is decoration, which is the same argument BUILD.md makes about the gates.

## Held records: in the archive, out of the published list

A kill may carry `held: true` and a `held_reason`. That marks a real record
whose central claim we cannot evidence as our own observation. It renders no row
on `/kills`, gets no share card at `/kills/[slug]/card`, and is counted in no
total of rendered rows. It is not deleted, and it is not edited into something
publishable. The archive keeps everything.

Three consequences, and each one is deliberate:

**`stats.killed` still counts it**, and so does the reconciliation above. A hold
is a publication decision, not a measurement. The sweep killed what it killed,
and the ghost rate is that count over what was pulled. Correcting the
measurement to match the rows would be fixing the instrument to fit the edit.

**The gap is stated on the page.** `/kills` prints the published count beside the
sweep total and says in one sentence that a record is held and why. A page that
publishes a count and a ghost rate while quietly dropping a row is doing the
thing this site was built to name. Both numerals carry gate 2's truth markers
(`kills_published` and `killed`), so neither can be typed and neither can drift.

**The filter lives in `src/lib/data.ts`, once.** `loadKills()` returns the
publishable records and is what every rendering surface reads. `killArchive()`
returns everything and may only be read by a sentence that is about the sweep
rather than about the list. `heldKills()` is the held set, which is how the
notice knows it has something to say.

## What renders, and what an absence means

Two rules decide everything downstream, and they are the product's rules rather
than style preferences.

**Structure may be derived. Facts may not.** `src/lib/data.ts` computes ages,
durations, intersections, page counts and orderings. It invents no company, no
role, no salary, no date and no statistic.

**A number renders only when its provenance can be shown.** Where a record does
not carry the date a figure was computed from, the accessor returns null and the
page renders a truthful absence: "No date shown", "Not listed". Never a guess,
never a fallback, never a plausible default.

That rule is why several things the data technically carries do not appear:

| What | Why it does not render |
|---|---|
| Five `age_days` values with no supporting date | An age with no basis is a number a reader cannot check. Reported upstream as a defect. |
| The five fit components | `_meta.fit_component_provenance` says `derived_from_weights`: the totals are real sweep scores and the splits were back-filled. They render as absences against their real weights until the machine exports its own readings. |
| Every kill row in the fixture | Publishing a kill needs a `kill_rule` the site still stands behind. All fourteen sweep 001 records were closed by the evergreen rule, retired on 2026-08-19 for inferring intent from a duration, so they stay in the archive, they stay counted in `stats.killed`, and /kills says how many there are and why none of them is a row. |
| A role family filter | Same argument. There is no `role_family` field, and deriving one from job titles is a classifier nobody asked for. |
| The Finta record, entirely | `held: true`. Its one substantive figure came from outside research rather than from our sweep and nobody can name the source, so the record is kept in the archive and out of every published surface. The kill list says on the page that a record is held and why. |

**The First seen column used to be on that list and came off it on 2026-08-19.**
It is suppressed while most rows were first seen on the sweep that rendered them,
because a column of identical dates would imply every posting appeared overnight.
64 of the 65 records now carry a `first_observed` older than the sweep, so
`firstSeenVisible()` returns true and the column renders on all 64 live rows. It
was never a count of nights: the earlier gate was `sweep_number` reaching three,
which was a proxy for this question and a worse one, since three sweeps of a
machine that saw nothing new would have satisfied the counter and still printed
one repeated date. Nothing was switched on by hand.

Every one of those is a defect for the export script rather than a limitation of
the site, and every one of them fills in with no change to a page the night the
data arrives.

## Where the data comes from

`scripts/export-site-data.py` is the script the machine runs. It reads the
jobmachine repository's `seen.json` and its archive, and writes the three files
into this repository's `fixtures/`. It validates its own output against
`/schemas` and against the same reconciliation rules the build enforces, and it
refuses to write anything if that validation fails, because a half-written
export is worse than yesterday's data: yesterday's data is at least consistent
with itself, and the build's freshness check will say how old it is.

The input shape that script expects is documented at the top of the file. It is
an assumption, and it is flagged in `DECISIONS.md`: this repository cannot see
the jobmachine repository, so the field names it reads were derived from what the
fixtures already contain rather than confirmed against `sweep.py`. Running it
once against a real `seen.json` is the check that settles it, and it fails loudly
rather than guessing when a field it needs is absent.
