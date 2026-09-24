---
paths:
  - "public/scripts/**"
  - "src/pages/jobs-data.astro"
  - "src/pages/profile.astro"
  - "src/components/profile/**"
  - "src/components/come-ready/**"
  - "src/components/job-detail/**"
---
**The most expensive bug class in this repo: markup and browser JavaScript agreeing
by convention only.** 185 DOM query sites across 32 files resolve to 168 distinct
static selector literals. Rename one side and the page still renders perfectly
while the behaviour dies silently. `astro check` cannot see it, and a screenshot
cannot either.

Three instances have already cost real time:

- `edfc2ec` — the board filter script lost the account endpoint it read from a
  `data-` attribute. Every board load threw a `ReferenceError`.
- `/profile`'s resume upload waited on a status value the server had stopped
  sending, for four days, while the upload actually succeeded. The vocabulary now
  lives once in `src/lib/resume-parse-wire.ts`, and
  `src/lib/resume-parse-wire.test.ts` refuses any client script that hand-writes a
  status literal.
- `/profile` carried its own copy of the drag-and-drop handlers instead of
  `src/lib/drop-zone.ts`, and the copy turned its own highlight off while a file
  was over it. `src/lib/drop-zone.test.ts` now censuses that.

**The rule:** when a protocol has more than one consumer, put the vocabulary in one
module with an exhaustive `switch` that has no `default`, and have every consumer
import it. Then the next value the server invents is a compile error instead of a
silent hang. Never widen a hand-written whitelist — that leaves a whitelist.

`public/scripts/ledger-v4-app.js` and `ledger-v4-views.js` are 1,741 lines outside
the build and outside `astro check`. `src/lib/jobs-data-render.test.ts` executes
them, but it is `describe.skip` without a `DATABASE_URL` — so on a machine with no
database that guard vanishes and the suite still reports green.
