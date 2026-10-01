# What is keeping the mini off production-ready, and off enterprise-stable

Audit of 2026-10-01. Read-only throughout; nothing was changed, committed, pushed or run.

## How much to trust each claim

Three passes, deliberately adversarial against each other:

1. **The gauntlet.** 12 independent dimensions surveyed the mini and both repos in parallel. Every
   finding was then attacked by 2–3 refuters, each with a different lens (does the quoted evidence
   exist; is there already a guard; can the failure chain actually occur). 84 findings reached
   verification, **73 survived**. 55 more were dropped by a cap of seven per dimension, so this is not
   the whole list.
2. **A seed check.** The seven facts the gauntlet was briefed with were verified independently, because
   a bad seed propagates into every finding built on it. Three were wrong and are corrected below.
3. **Nine checkers on the load-bearing claims**, then an arbiter. Of 58 claims examined, **34 held, 24
   were partly wrong, and 20 are withdrawn.** The withdrawn ones are listed at the end so nobody
   resurrects them.

**The most important result of pass 3: the audit's own number-one recommendation is wrong and would
have caused a correctness failure in public.** Details in "What to do, in order".

---

## Right now

The public site is correct and about nine hours stale. It serves sweep instant
`2026-10-01T00:34:48Z`, `data-swept 2026-10-01T00:41:51.000Z`, inside its own 36-hour window. It
crosses into the amber honest-staleness band around **2026-10-02T12:34Z — roughly 08:35 local on
Thursday 2 October.** That is the real deadline, not tonight's 03:30.

Tonight's scheduled run failed. `out/last-run` reads `FAIL 2026-10-01T07:30:04Z exit 1 during export`.
The sweep succeeded — 45 boards, 79 live — and then the export refused with 22 problems and wrote
nothing. The refusal is single-cause: `tail -c +8571 jobmachine.err | grep -c "was read from"` → 22,
and every other per-row check on those 22 rows passed.

**It will refuse again tonight, unchanged.** `python3 -c "import config"` on the mini confirms Apple is
out of `BOARDS` and in `TRACK_ONLY_BOARDS`, the same 22 rows are still closed in `seen.json`, and
nothing ages them out.

Also stopped, and not by any fault of their own: the crawl, the Postgres load, the external-drive
backup and the disk prune were all cancelled by the export's `exit 1`. And the offsite archive has not
advanced since 2026-09-29 and cannot.

---

## The five patterns underneath five bad nights

### 1. One fact, stored twice, with nothing comparing the copies

Tonight it was the list of board names. The mini's `SITE_SOURCE_SYSTEMS` holds seven values
(`export-site-data.py:91`, one commit in its entire history — `cc09b4f`, 2026-08-18). The site has its
own runtime gate with its own list. Nothing on either side tests one against the other: grep for
`source_system` in jobmachine's `tests/` and the site's `test/` both return nothing.

Same shape every other night. A slug derived twice. A publish target hardcoded while the public URL
moved. The plist committed in the repo is the superseded *agent* file, not the installed *daemon*.
`bin/jm:114-115` still selects `INDEX_DATABASE_URL_UNPOOLED` for any edition that is not `everything`,
while `editions.py:125` defines only `everything` and `curated` — and that secret is absent, so the
`curated` edition silently publishes by git and never by DB.

### 2. The guard was built correctly and never wired to the one place that needed it

`/api/rebuild` is deployed and answering correctly right now, and `vercel.json` has never contained a
`crons` key — `git log --oneline -- vercel.json` returns one commit. `export-site-data.py --dry-run`
exists and nothing calls it. The catch-up that heals a missed night still works and no loaded job
passes `--if-stale`. The canary computes its alarm and prints it to a log. The receipt computes four
alarms and writes them to a file nothing delivers — and sits *behind* the export, so the nights you
most need a record of are the nights without one.

*Corrected:* `publish/git.py`'s retry is **not** an unwired guard. It is called at `bin/jm:176`, and
through `git.sync()` at `:93` and `:415`, and `nightly.sh:690` runs `jm sync` nightly. The defect is
one bare `git push` at `nightly.sh:717` that bypasses it. One call site, not a wiring job.

### 3. And then written down as done

`nightly.sh:289-291` tells the next reader the Vercel cron "goes red when the deployed sweep is past
the freshness window." `api/rebuild.ts:7` says `vercel.json` "has declared a cron against this path
since the deploy was set up." `tasks/nudge.ts:3` says it too. Five such comments across both repos.
None has ever run — and `docs/regression-strategy.md:589-591` already records exactly that: "Those
crons have never run."

`README.md:37` tells a rebuilder to install the retired LaunchAgent — the configuration whose failure
cost the 2026-09-06 day — and to verify with `cat /tmp/jobmachine.log`, a path abandoned in `5fa4dd5`.
Following the repo's own install instruction breaks the machine.

### 4. One exit code serves both "do not publish bad data" and "do not do tonight's work"

The refusal is right. Wiring it to `exit 1` at `nightly.sh:575-579` is what turned a 22-row label
mismatch into a cancelled crawl (`:978`), a cancelled database load (`:1072`), a cancelled offsite
backup (`:815`, `:1054`) and a cancelled prune (`:1093`).

The crawl loss is the only unrecoverable part — you cannot re-observe yesterday's boards.
`data/archive` has no `track-2026-09-27.jsonl` at all. That crawl is gone, from an export refusal
three nights ago.

**You already fixed this exact shape 500 lines further down the same file.** `nightly.sh:1095-1107`
defers a publish-check failure to the last line, with the comment: "until 2026-09-29 a failure there
exited on the spot and cancelled every stage after it. Now it sets a flag and the run carries on doing
the work."

### 5. Every watcher lives on the thing it watches, and nothing has a floor

The nightly's alarm, the uptime watcher, the receipt, the canary — all on the mini, all funnelling
into one unauthenticated ntfy topic. `watch-antialgo.sh`'s own header states the choice out loud: it
reuses the machine's alarm rather than a third-party monitor.

And no quantity has a floor. No row-count floor on the ingest, no board-error-rate alarm, no closure
ceiling, no size check before a commit. Combined with an all-or-nothing load, every quantity in the
system can collapse to near-zero and publish cleanly under a fresh timestamp. 172 of 2,999 boards
failed tonight; no alarm exists for any board-failure rate.

---

## Why pushing to the site is a struggle

Six mechanisms wearing one costume. They do not share a fix.

**1. Most of the time nothing was pushed, because the export refused first.** The push is at
`nightly.sh:631`; the export's fatal exit is at `:578`. Tonight, 09-27 and 09-28 all died at 578.
There was never a push to fail. `jobmachine.err` holds five `refused, N problem(s)` blocks. This is the
commonest case and it is not a push problem at all.

**2. The archive repo physically cannot accept a push.** `~/jobmachine/data` is a separate git repo
(remote `tokens-to-agents-archive`) with exactly one stranded commit, `602f561`, whose tree carries
`tracking/all-latest.json.before-pipeline` at **378,207,157 bytes** and
`tracking/all-latest.json.before-apple` at **370,024,928 bytes**. Both are over 3.5× GitHub's
104,857,600-byte hard limit, and `602f561` is an ancestor of every future commit — so it needs history
rewriting and a force-push, not a cleanup. Cause: `.gitignore:14` ignores `tracking/all-*.json`, which
does not match a name ending `.before-apple`, and `git add -A` at `nightly.sh:750` swept them in.
`origin/main` is still `82d75a6`, 2026-09-29.

*Corrected, and worse than reported:* the `WARN: archive backup failed… goes out next run` string at
`nightly.sh:761` has **never been written to any log** — zero hits across `~/Library/Logs`. There is no
durable record of the failure at all. And `jm status` and `jm rehearse` both own an unpushed-commit
detector that iterates only the two *site* repos, so the archive line reads healthy while a commit
sits stranded. Nothing will ever surface this.

**3. The same repo is about to block itself again.** `tracking/state.json` is 104,649,065 bytes —
**208,535 bytes of headroom**, against observed nightly growth of 8–23 MB. GitHub has been warning on
every push since 59.81 MB. Clearing mechanism 2 buys one night, maybe two.

*Corrected:* the earlier 79–81 MB events were **warnings, not rejections**. GitHub accepted those
pushes. This is a near-miss that prompted the `.gitignore` rule, not a prior failure of the same kind.

**4. The sweep's own push has no retry.** `nightly.sh:717` is a bare `git push -q origin "$BRANCH"`
whose failure is `exit 1` at `:730`. The retry you need is already written and already wired
everywhere else. A ten-second network blip costs the night and every stage after it.

**5. A push from your laptop during the window wedges it until you intervene.** `git.py`'s
`NETWORK_HINTS` has no entry for `non-fast-forward`, so `push()` gives up on attempt 1; `sync()` then
correctly refuses to reset over the stranded commit, and `nightly.sh:694` exits 1. Every night after
that dies at the same line. A fetch-and-rebase exists at `:1040` and is unreachable because the run
exits 350 lines earlier. The file's own comments record this happening on 2026-08-19 (`:666-670`) and
2026-09-08 (`:1028-1032`). Twice is not hypothetical. Not currently manifesting — `~/AntiAlgo` is
clean.

**6. A push can land and the build still not publish what you think.** The Vercel author block you
already fixed (`nightly.sh:661-662`). What remains: the landed-push check at `:842` runs forty minutes
before `jm publish` at `:1072`, so a board that never reached Postgres is not what it is checking. And
the ingest's own guard is structurally unreachable — the nightly adds `board-latest.json.gz` in one
commit and deletes it in the next, and **the delete commit is what lands as HEAD**, so the production
build takes the "nothing to load" exit-0 path and ships a fresh sweep stamp over a board it never
verified.

**Dormant but loaded:** `~/jobmachine/push-antialgo.sh` is still executable, still hardcodes
`SITE="$HOME/the-index"` (frozen since 2026-09-16), and still runs `git reset --hard origin/main`
against `~/AntiAlgo` before pushing. One tab-complete publishes two-day-old data from the frozen repo
over production, bypassing every guard added since 09-29. The `~/.ssh/site_index_deploy` credential for
it is still on the box.

---

## Ranked blockers

Ranked by: does the public see something wrong, how often does it fire, how long until a human knows.

### 1. The nightly races itself for the production board table, and already lost once today

**Both bars. Medium.** This outranks everything the audit itself ranked first, and it has nothing to do
with Apple.

`nightly.sh:1035` runs `board_build.py` into `~/AntiAlgo` and git-pushes `board-latest.json.gz`, which
a Vercel production build then ingests. Two minutes later `:1072` runs `jm publish everything`, which
loads the full board directly. Both end in `ingest-jobs.mjs --replace`, which **TRUNCATEs** `jobs`.
Nothing orders them and no row-count floor exists anywhere in the path.

It happened today. At 05:15:41.8Z the build of `105027e` truncated `jobs` and wrote **4,330 rows**,
committing at 05:15:47.0Z. A second `--replace` transaction had already opened at 05:15:44.789Z,
blocked on that lock, then truncated the build's rows away and wrote **57,852**. The everything edition
won by about two seconds of commit ordering.

Reverse that ordering and antialgo.ai serves 4,330 rows instead of 57,852 — a **92.4% collapse, under a
fresh green timestamp, with no alarm.** Which one wins depends on whether Vercel's auto-cancel happens
to kill a build: a dashboard setting, not anything in the repo. `board_build.py` also has no `pipeline`
field, so whenever it wins, every row's evergreen-pool flag is null — the 57,648-null bug fixed on
09-30, reintroduced from the other end.

*Fix:* stop running `board_build.py` into the everything repo. Until then, have `ingest-on-build`
refuse a file whose `_meta.source` is not the edition this site serves.

### 2. The offsite archive is permanently blocked and nothing can ever say so

**Enterprise. Medium.** Mechanism 2 and 3 above. The only copy of the record not in your room stopped
two days ago, needs a history rewrite to resume, left no log entry, and is invisible to the two
commands built to detect exactly this.

### 3. Nothing off the mini is watching

**Both bars. Small.** This is why five nights of different failures each ran unnoticed. Every alarm you
have lives on the machine being watched. The one component designed to watch from outside has no
caller, and five comments say it does.

*Corrected:* even wired, it would **not** have caught tonight. It subtracts the build-time bundled
`stats.json` from now — the sweep clock only. `grep` for board/Postgres in `api/rebuild.ts` returns
nothing. So a night where the sweep push lands and the Postgres load fails leaves it 200-green while
`/board`, `/desk` and `/jobs-data` serve stale rows. That is the `familyOf is not defined` fault
exactly. Wire it anyway — it is the only alarm that survives the mini being off — but know it watches
one of two clocks, and the one being retired.

*Also corrected:* `src/lib/health.ts` is not an endpoint and cannot be polled. Its header records your
own call on 2026-09-24 that a public `/health` was not wanted. It has **one** caller,
`internal/index.astro`, so its four invariants only evaluate when a signed-in internal-tier human loads
a page. That is zero monitoring coverage, not weak coverage — and the module was written to be that
route's body.

### 4. The export's `exit 1` cancels four subsystems that do not depend on it

**Both bars. Small.** Pattern 4 above. One permanently lost crawl already (`track-2026-09-27.jsonl`).
The fix pattern is in the same file at `:1103`.

### 5. A config edit wrote 22 false closures, and the record now contradicts itself

**Both bars. Medium.** The only correctness bug in the list.

`sweep.py:3228` — `silent_boards = set(board_errors)`. A board removed from `config.BOARDS` is never
asked, so it is never an error, so it is not silent, so `:3245-3247` writes `status="closed"` and
`closed_on=TODAY`. The same night's archive holds both shapes: 22 `closure_withheld` at 00:34:48Z
(Apple was asked and failed — the guard worked) and 22 `closed` at 07:30:05Z (Apple was not asked — no
guard). Commit `c902bf4` sits between them.

The crawl has the identical hole with a dead guard: `trackstate.py:119-121` needs a `counts_tonight`
entry equal to 0, and neither producer can ever emit a zero, so that branch is unreachable from every
caller. At crawl scale, one list edit does this across 2,542 boards.

*Corrected, and better than reported:* `seen.json` is working memory and is **uncommitted** — HEAD of
the data repo still holds all 22 as open, so the state is recoverable. The irreversible write is
`data/archive/sweep-2026-10-01.jsonl`. Also, these were not long-tracked rows: all 22 have
`first_seen 2026-10-01`, created at 00:15:58Z the same day. Their entire history is about seven hours.

*And a trap:* `c902bf4`'s own message says "moving the line back into BOARDS reverses it and nothing
else changes." That is no longer true. `sweep.py:2567-2577` appends a `reappeared` event with
`gap_days` whenever the prior status is `closed`, so returning Apple to `BOARDS` writes 22 false
reappearances on top of 22 false closures — and the live rows hit the same enum fault anyway.

### 6. Nothing has a floor

**Both bars. Medium.** `ingest-jobs.mjs:551` TRUNCATEs; the only consistency check at `:385` compares
the file against the file's own header, never against the board already in the table. Grep for
`MIN_ROWS`/floor across `scripts/` and `src/lib/` finds one unrelated hit; on the mini the only floor is
`MIN_FREE_GB`, which is disk. A crawl reading 10% of boards publishes 10% of the board in one clean
transaction under a current stamp. A reader sees "these companies stopped hiring" — a false statement
about the labour market rather than a true one about an outage.

### 7. The scheduler is 0-for-5, and a failed night is never retried

**Both bars. Small.** `StartCalendarInterval {Hour 3, Minute 30}`, no `RunAtLoad`, no `KeepAlive`, no
catch-up daemon. The only thing that ever passed `--if-stale` is the renamed
`com.ryan.jobmachine-catchup.plist.replaced-by-daemon`. The sibling pipeline kept its catch-up —
`com.ryan.prospects-catchup` is loaded. The staleness window keys on `last-run`'s mtime, which a FAILED
run refreshes, so a failed night is also never retried inside 24 hours. Automatic macOS updates are on
with reboot-class updates pending.

*Corrected:* 2026-09-30 was **not** a missing run. The daemon fired on time, found pid 37295 (the
manual run's crawl) holding `out/nightly.lock`, and left — `nightly.sh:235-241` names the event. That
deferral path has since been changed to notify, so it is partly addressed already. A schedule that
fires and defers is a different fault from one that does not exist.

*Also corrected, and worse:* "every publish for five days was by hand" understates it. AntiAlgo's
entire history holds exactly two sweep publishes, 09-29T21:26 and 09-30T20:40, both from manual runs.
On 09-27, 09-28 and 09-29 **nobody published anything at all**. The 09-26 scheduled run did complete
and did publish — into the frozen `~/the-index` repo, so it never reached antialgo.ai. The publisher
has since been repointed, so this part is history, not a live fault.

*And:* the run ledger records only that a sweep *started* (`sweep.py:3322` archives mid-sweep, long
before export); pre-sweep failures write no run line at all. It cannot tell you whether a run
completed.

### 8. Alerting is one unauthenticated channel, and an undelivered alarm exits 0

**Both bars. Small.** `~/.jobmachine-notify` has one live key, `NOTIFY_NTFY_TOPIC`; `NOTIFY_PHONE` and
`RESEND_API_KEY` sit commented out. `bin/jm:259` is `return (0 if reached else 1) if strict else 0`,
and neither caller passes `--strict` — `nightly.sh:210` and `watch-antialgo.sh:64` both have an
`|| log "ALARM COULD NOT BE SENT"` branch that can only fire if Python itself crashes. `nightly.sh:10`
already sets `pipefail`, so adding `--strict` makes the existing branch work as written. A 200 from
ntfy means ntfy accepted the POST, not that a device was subscribed.

*Corrected from my earlier note to you:* alerts **do** reach a phone. ntfy delivered tonight and the
machine's own `REACHING` set counts it. The accurate finding is one channel with no redundancy and no
delivery confirmation.

### 9. The page with the Apply button promises freshness it does not measure

**Both bars. Medium.** `JobDetailV2.astro:271` — `{isClosed ? 'Closed, last read at the source' :
'Verified today at the source'}`; `:316` the same; `:436` "still live as of this morning's sweep." The
only branch in all three is `isClosed`. The component never imports `FRESH_WINDOW_HOURS`. `ageDays` is
measured to the build-time sweep instant, so it does not count up either.

*Corrected:* `/opportunities` **does** carry the band server-side off the same 36-hour constant, and
`/desk` prints `swept <date>`. The real undisclosed routes are **`/jobs-data`**, which labels 57,050
crawl rows "Verified live tonight" with no instant, and **`/prelist`**, which renders board rows with
no stamp at all and which the audit never named. Gate check 7's floor is `stamps.length < 2`, so it
passes at exactly two and will never notice a new route shipping without disclosure.

*Settled, no decision needed:* the home page has only **one** `data-swept`, carrying the crawl instant.
`Board.astro:235` passes `verifiedBanner={false}` and every Board is `mode="server"`, so JobTable's
sweep-clock band never renders. But the home page sets `data-stale` on an element its own amber CSS
does not match — a stale board on `/` changes the sentence and gets no colour.

### 10. One file in one home directory owns the production database, and the only backup is on the desk

**Enterprise. Large.** `~/.jobmachine-db` holds `neondb_owner`: a member of `neon_superuser` with
`rolcreaterole`, `rolbypassrls` and `rolreplication`, owning all 25 tables including `user`, `account`,
`session` and `user_provider_key`. It is the only application login role, so nothing server-side can
attribute a write; `log_statement` is `none`; RLS is enabled on 0 of 25 tables. 43 live sessions and 3
BYOK keys sit in those tables.

Any process running as `computersex2` can read that file — including an unrelated agent framework whose
cron fires every 15 minutes as the same user. `fdesetup status` → FileVault is **Off**, so a stolen
disk needs no password. `tmutil destinationinfo` → no destinations. restic/borg/rclone → not found.
`pg_dump`, `pg_dumpall`, `psql` → not found on the mini. Both backup copies — an `rsync -a --delete`
mirror, so corruption propagates, and 45 dated `tar.zst` files — are on the one USB drive in the same
enclosure as the machine.

And the DDL path has no gate: `package.json`'s build runs `migrate.mjs` on **every production build**
by design, `main` has **no branch protection**, so any push applies forward-only DDL as that role to
the cluster holding people's accounts and API keys, with no review and no pre-migration snapshot. The
mini's `~/.ssh/antialgo_deploy` is therefore a schema-change credential.

### 11. No gate catches any of this before 03:30

**Enterprise. Small.** You edited `config.py` at 21:10 and found out at 03:32. `nightly.sh:520-526`
exits before the sweep, so `--preflight-only` structurally cannot produce or validate a row — and it
reports "every gate passed" on a configuration that will refuse. `jm rehearse` step 5 sha256-compares
files already in `out/site-data`; it never invokes the export. `~/jobmachine` has no `.github`, no git
hooks, and the nightly runs none of its 33 test files.

*Corrected, and this matters:* `--dry-run` would **not** have caught tonight. It reads only the
previous sweep's outputs and keys everything to `archive.runs[-1]`. At 01:10Z the newest run was
00:34:48Z, whose `board_errors` was `['Apple']`, which routes every Apple row into the unverified or
silent buckets before `build_job` runs. It would have exited 0. The fault was reachable only after a
sweep ran under the new config. Wiring `--dry-run` is still worth doing, but **the check that would
have caught this does not exist**: compare the adapter names in `config.BOARDS` + `TRACK_ONLY_BOARDS`
against `SITE_SOURCE_SYSTEMS`.

*Also:* wiring the Python suite as-is would manufacture a false green. `tests/test_config.py` asserts
against `jobmachine/config.py` while the sweep reads the **root** `config.py`, and no test in `tests/`
mentions `source_system`.

### 12. Billing and quota are single points of total failure that nothing reads

**Both bars. Small.** Two of the five historical outages were billing, not code, and the repo says so.
`scripts/ingest-on-build.mjs:9-17`: on 2026-09-07 GitHub stopped starting jobs because account
payments had failed, "every run failed in seconds with no runner assigned, and the board silently kept
the previous night's rows… produced by a billing page nobody was looking at." `conform.yml` adds the
cause — a macOS runner at 10× Ubuntu cost. The second was Neon's Free compute cap taking the site down
on 2026-09-20.

GitHub Actions billing, Neon compute hours, the Vercel plan, the `antialgo.ai` registration and BYOK
model spend each have a cap or a renewal, and nothing in the system reads any of them.

### 13. The export refuses all 106 rows over rows it was going to exclude anyway

**Both bars. Medium.** `export-site-data.py:1639-1643` — on any failure, print and return 1. Tonight's
summary printed "79 verified live + 3 killed" and "27 closures published" moments before refusing all
of it.

*Corrected:* the export is **not** without a hold-back mechanism. `:105-116` holds a row back and names
it, with `UNCLASSIFIED_CEILING = 0.10` as the safety net, plus six named hold-back buckets — that is
the file's central design, and its comment records why: "ONE such row refused the entire export, so 31
rows the machine was certain about went nowhere on account of a single unrecognised host."
`migrate-evergreen-retirement.py` is a precedent repair tool. The real defect is narrower: **the
`source_system` check never got the pattern the same file already uses.**

---

## What to do, in order

### Tonight: nothing to the enum. Leave `export-site-data.py:91` alone.

The one-line edit is mechanically correct and would clear the refusal. **It is not safe.** All 22 Apple
rows are `status: closed`, `closed_on 2026-10-01`, sitting in the export's `closures` bucket, which the
code annotates as a real closure. Widening the enum ships them to the public as closed rows, each
carrying a reader-visible sentence of the form "Last observed on this board on 2026-10-01. Not on it in
the sweep of 2026-10-01."

Apple closed nothing. The board was never fetched. Nothing downstream catches it: the only validator
rule touching `closed_on` is a date-shape test at `:1079`, there is no closure-volume ceiling, and the
site has no rule about closed rows. Of the 26 closed rows published today, zero have `first_observed`
equal to `closed_on` — these 22 would be the first of that shape ever shipped, on a site whose subject
is ghost jobs.

**The refusal is doing its job, for a reason its own message does not state.** A night stale is cheaper
than 22 false public claims about a named employer.

Two more corrections to that recommendation:

- **The export would never write `apple` anyway.** `:625`'s else branch is
  `proven = system_of_host(url); system = proven or "custom"`. All 22 URLs are on `jobs.apple.com`,
  which is not in the mini's `ATS_HOSTS`, so the rows ship as `custom` — which is honest, since that is
  Apple's own site. The site accepts it: `data-contract.ts:328 assertSourceSystems` sets `named = null`
  for `custom` and `systemOfHost` also returns null, so `proven === named` passes.
- **`lever` and `rippling` are not tonight's work and must not be added alone.** `seen.json` holds zero
  Contentsquare and zero Arcadia rows, so neither can refuse. And neither `jobs.lever.co` nor
  `ats.rippling.com` is in `ATS_HOSTS`, so adding just the names makes the site print "Apply on the
  company site" over a Lever link — the exact mislabel the refusal warns about. When it is done it is
  three places: the tuple, the mini's `ATS_HOSTS` at `:94-101`, and the site's at
  `data-contract.ts:294-301`.

Also note: the site's TypeScript union ending `| (string & {})` is compile-time only. There **is** a
runtime gate, and a genuinely new board name would hard-fail the site build. The file that has to
change is `data-contract.ts:294-301`, which the refusal message does not name.

### The honest fix for the Apple fault — before Thursday morning, not before 03:30

Two halves, or the night refuses again, which is the safe outcome:

1. A board present in neither the night's `board_errors` nor `config.BOARDS` falls into `silent` at
   `export-site-data.py:1206`, not `closures`. And `sweep.py:3228-3250` stops closing rows for a board
   it never asked about.
2. Repair the 22 rows' status. HEAD of the data repo still holds all 22 as open, so this is
   recoverable. Do **not** reach for returning Apple to `BOARDS` — that now writes 22 false
   `reappeared` events on top.

### This week, in this order

3. **Stop `board_build.py` writing into the everything repo.** Blocker 1. Likely one line, and it ends
   a nightly race against the production board table that has already run the wrong way once.
4. **Unblock the archive.** Rewrite past `602f561`, untrack both `.before-*` files, add
   `tracking/all-latest.json.before-*` to `data/.gitignore`, force-push. Then give the archive-push
   failure a notify, and point `jm status`'s unpushed detector at the data repo too — non-fatal must
   not also mean unreported.
5. **Add `crons` to `vercel.json` against `/api/rebuild`.** The endpoint, the threshold and the
   `CRON_SECRET` check are written. Treat an actual invocation in the Vercel log as the acceptance
   test, not the file existing. Then delete the five comments that say it already runs. Do this before
   any refactor — it is what tells you whether a refactor worked.
6. **Second alert channel, and `--strict` at both `jm alert` call sites.** Put a token on the ntfy
   topic.
7. **Make the export refusal deferred, not fatal.** Copy `PUBLISH_CHECK_FAILED` from `:1103`. Skip only
   the stages that need a fresh export; let the crawl, the archive and the prune run.
8. **Reinstate the catch-up as a LaunchDaemon with `RunAtLoad` and `--if-stale`,** mirroring
   `com.ryan.prospects-catchup`. Then make the window read the run's *outcome* rather than the file's
   mtime, so a FAIL gets one retry.

### On a deadline — `state.json` has 208 KB of headroom

9. Decide where `tracking/state.json` lives: out of git, or a repo per year as your own comment at
   `nightly.sh:744-746` proposes. Do nothing and this breaks within a night or two, and the second time
   needs another history rewrite.
10. Route `nightly.sh:717` through `publish/git.py`, and make its failure deferred. Add
    `non-fast-forward` to `NETWORK_HINTS` or make `sync()` reachable, so a laptop push costs one night
    rather than every night.

### Structural — a month, not a night

11. **One source of truth for the source-system contract.** The site publishes its accepted values as
    data, the mini reads them, and a test on each side asserts the board lists are a subset. This is
    the only item that stops pattern 1 recurring.
12. **Volume floors.** A night-over-night row-count check inside the ingest transaction with an
    override for a deliberate shrink; an alarm on board-error rate; a closure ceiling.
13. **Age disclosure becomes structural.** Lift the band into `BaseLayout`, give `/jobs-data` and
    `/prelist` a stamp, derive job detail's wording from the same `data-swept` pair JobTable uses, and
    change gate 7's floor from a count to "every route that renders a sweep- or crawl-derived figure."
14. Apply the hold-back pattern to the `source_system` check, so one bad row costs one row.
15. CI on the jobmachine repo — but fix `tests/test_config.py`'s wrong import target first, or it
    manufactures a green check.
16. A scoped Postgres role for the mini (TRUNCATE + INSERT/UPDATE/SELECT on three tables is the whole
    workload; it never migrates). Branch protection on `main`. One offsite destination for the
    tarballs — they are already the right primitive, just all in one room. FileVault on.

**One thing not to do:** do not reach for `push-antialgo.sh`.

---

## What is already solid

The list above is long, so this needs saying plainly.

The export refusing rather than publishing something it cannot stand behind is the right call, and it
is why the public has correct data tonight instead of wrong data. The ingest is one transaction —
TRUNCATE, every upsert and the `board_stats` write roll back together — so a failed load leaves the
previous board intact. The closure logic distinguishes a board that *failed* from one that *answered
empty*, per adapter, and writes `closure_withheld` with a human-readable reason; that is unusually
careful work, and it is why the 00:34 run held Apple's rows back correctly. The 36-hour honest-staleness
band on `/`, `/board` and `/opportunities` is real, and choosing to report rather than throw genuinely
fixed the 09-28 fault where a stale number took down `/sign-in`.

Every guard added after each incident works: the publish-target preflight, the lock ageing and
takeover, the progress-based crawl watchdog, the apex redirect check, gate checks 7 and 8, and the
deferred publish-check failure. The dated tarballs are the right primitive and are verified on read
before any prune — `raw_is_archived` reads the archive back rather than trusting a filename, and the
comment notes the first draft would have deleted 1,049 files on the strength of a name. 45 tarballs, no
gaps, across three outages, because `catch_up` backfills.

Secret custody is good: per-repo deploy keys with `IdentitiesOnly`, mode-600 files, `jm secrets set`
reading from stdin so values never touch shell history or `ps`, DSN scrubbing in error paths. And
`publish/git.py` is correctly designed — retries transient failures with backoff, classifies
non-transient ones, refuses to reset over a commit it failed to deliver. It is simply not called by the
one push that matters.

Things I expected to be wrong and are not: the clock (`sntp` → +0.011s, NTP configured, TZ correct);
disk (81 GiB free against a real `MIN_FREE_GB=5` floor with a warn-at-double, G-DRIVE 5.3 TiB free);
sleep and power (`SleepDisabled 1`, `autorestart 1`, `womp 1`, 23 days up — the reboot risk is pending
macOS updates, not sleep); memory contention (86% free; the 09-30 crawl hang was not pressure). And the
external-drive backup works — 6,573 of 6,573 files tonight; the "Operation not permitted" lines are
macOS TCC refusing `du` and direct `rsync`, while the real copy goes via `ssh localhost` and the drive's
`state.json` is byte-current.

**This is not a badly built system. It is a well-built system with a wiring problem and one duplicated
fact.**

---

## Open questions — stated, not answered

Nobody could settle these read-only. They are not findings.

1. **Neon's point-in-time-restore retention window.** No figure anywhere in either repo; it is a
   control-plane setting. This is the single unknown that decides whether the absent `pg_dump`
   matters at all.
2. Whether the export actually completes with the enum widened, or surfaces a second fault class. The
   inference is strong — the refusal holds exactly 22 problems of one kind, and `build_job` appends one
   sentence per fault rather than stopping at the first — but running it was out of scope.
3. Whether Vercel built `105027e` and ingested the 4,330-row curated board successfully before
   `a51a28f` superseded it. The race is proven from code and artifacts; which side wins on a given
   night is not.
4. Who ran the 05:15:44Z direct ingest and the 00:34:47Z manual run. Neither appears in
   `jobmachine.log`, so both were hand-started, but the caller cannot be named from logs.
5. Whether the stranded archive push failed for size or for transport. The run was hand-started so its
   stderr is gone. The size wall is there either way and fires on the next attempt.
6. What created `tracking/all-latest.json.before-apple` and `.before-pipeline`. Nothing in
   `~/jobmachine` references those names; daytime mtimes and a size identical to `all-2026-09-30.json`
   point to hand-made copies.
7. Whether bootstrapping `README.md:37`'s LaunchAgent alongside the live daemon produces two concurrent
   03:30 runs. Both plists share `Label`, `ProgramArguments`, `StartCalendarInterval` and both log
   paths, so the collision follows from the files — but loading a job is outside read-only.
8. Whether `/api/rebuild` has ever returned 503. It sets `no-store` and keeps no readable log.
9. Whether any live job-detail page currently renders "Verified today at the source" over days-old
   rows. The nightly TRUNCATE-and-reload restamps every row, so no instance could be produced. The code
   path is unguarded either way.
10. Whether the 2026-09-28T20:58:25Z preflight failure (floor 999999 GB) was launchd-started or a person
    at the keyboard.
11. Whether the daemon at `/Library/LaunchDaemons/com.ryan.jobmachine.plist` is *loaded*. `sudo` over
    ssh has no TTY. Indirect proof is strong: the run fired at 03:30:04 local matching `Hour 3 /
    Minute 30`, its stdout landed at exactly that plist's `StandardOutPath`, and the user domain does
    not list the label. Note the fire time is local wall-clock with no DST handling, so the published
    sweep hour moves by one hour in UTC at the next changeover.

---

## Withdrawn — do not resurrect these

Twenty claims the gauntlet produced that did not survive checking.

1. The one-line edit to `export-site-data.py:91` is the correct fix for tonight.
2. `lever` and `rippling` should be added to `SITE_SOURCE_SYSTEMS` as part of that edit.
3. The site's union accepts any string, therefore the site has no `source_system` gate.
4. A `--dry-run` at 21:10 on 09-30 would have caught tonight's refusal.
5. Wiring `--dry-run` into a hook would prevent this class of failure.
6. There was no scheduled run at all on 2026-09-30.
7. The run ledger in `data/archive` shows whether a run *completed*.
8. `nightly.sh` never reading `JOBMACHINE_RUN_KIND` is a defect. (launchd puts it in the daemon
   environment and `corpus.run_kind()` reads it there; every 07:30 line is correctly labelled.)
9. `git.py`'s push retry is an unwired guard.
10. The committed plist differs from the installed daemon in fire time, log paths, `RESEND_API_KEY` or
    catch-up. (A canonical diff shows four added keys: `HOME`, `PATH`, `GroupName`, `UserName`. The real
    difference is agent versus daemon.)
11. The archive backup failure is recorded in a log.
12. `jobmachine.err` shows a prior push *rejected* for file size.
13. The home page carries two `data-swept` elements on two clocks.
14. `health.ts` is called from `index.astro` and `desk.astro`. (One caller: `internal/index.astro`.)
15. `/opportunities` and `/desk` render data with no age disclosure.
16. The 22 Apple postings were long-tracked rows the config edit killed.
17. `data/seen.json` is the permanent record that now holds a false fact.
18. The export has no quarantine mechanism and no repair tool.
19. Gate 7 is only a count.
20. A failed Postgres load leaves `/api/rebuild` 200-green on a single build. (`ingest-on-build.mjs:107-109`
    fails the build. The real hole is structural — the board-less delete commit lands as HEAD.)

---

## Method, and one disclosure

242 agents across three passes. Dimensions surveyed: scheduling and supervision, alerting, the
export-refusal surface, the push path, the data chain, crawl robustness, host and disk, test coverage,
secrets, public degradation, state and recovery, enterprise absences. Verdict tally from the nine
checkers: 34 CONFIRMED, 24 PARTLY WRONG.

Capped coverage, stated so it is not mistaken for completeness: seven findings verified per dimension,
so 55 lower-severity findings were surveyed and never verified — push-path produced 15, host-infra 14,
enterprise-gaps 14, state-recovery 14.

**One read-only violation.** A checker working on the unwired-guards cluster wrote two files on the
mini via shell redirection — `/tmp/cfgchk/root_before.py` and `/tmp/cfgchk/jm_before.py` — which the
brief forbade. Nothing under audit was touched and the check was redone with pipes. Those two files
still exist and can be deleted.
