# Stop breaking page B

**A regression-safety strategy for antialgo.ai.** Written 2026-09-23, on branch `safety-net`.

**Part One is the plan and the evidence behind it, as written before building.** It is left unedited
except for two measurements the build itself corrected, each marked where it stands. **Part Two, at the
end, is what was actually built** — including four live defects the gates found on their first run, one
false positive that changed the design, and three bugs in the harness itself.

---

## 0. THE SHORT VERSION

The complaint was: *"I change something on one page and something else has to change on another page,
and even when I change it back visually it may break something internally, and I don't find out until
I test it."*

That is not vagueness and it is not bad luck. It is four measurable mechanisms in this codebase, and
three of them are already instrumented by tools you own and do not run.

**What you will run, when it is built:**

```bash
npm run conform          # measured: 35s. Before every commit.
npm run conform:deep     # measured: 78s, browser included. Before a push.
npm run conform:accept   # After an intended change. Re-records what you meant to change.
```

*(Those were estimates of ~90s and ~6min when written. The real numbers came in better; see Part Two.)*

and inside Claude Code, `/conform`, which runs the same thing and reports *what you changed, what it
reaches, and what has no test*.

**What it costs:** $0 in tooling. Zero new npm dependencies for the core. One to two working sessions
to build. About 15 minutes a week to maintain.

**The single most important sentence in this document:** the harness must check **agreement between
surfaces**, not the correctness of any one surface. Every bug you have described is two copies of one
contract that stopped agreeing. Screenshots cannot see that. Types, as currently configured, cannot
see it either. Section 4 is the proof.

---

## 1. WHAT IS ACTUALLY WRONG

Measured on this repo, on 2026-09-23, at commit `cfd7277`. Five findings, in order of how much of your
pain they explain.

### 1.1 Your instruments work and you have been trained to ignore them

You have **97 test files, 1,235 tests, 15,954 lines of test code.** (I told you earlier you had six.
I was wrong; I had only looked in `test/`. 71 of them are in `src/lib`.) You are not a person without
tests.

You are a person whose tests are red for a reason that is not your code:

```
Test Files  3 failed | 94 passed (97)
      Tests  17 failed | 1218 passed (1235)
error: column "derived_tier" does not exist
```

Your local database is one migration behind. 46 of 47 files in `db/` have been applied;
`db/207_jobs_derived.sql` has not, and it is the file that adds both `derived_tier` and `j.priced`.
Every Jobs Data test fails on it. Migrations run automatically **only on production builds**
(`scripts/ingest-on-build.mjs:57`), so a local tree drifts silently and stays drifted.

`npm run check` is red too — three type errors, at `src/components/Filters.astro:94`,
`src/components/desk-home/SweepPanel.astro:29` and `src/pages/board/[slug].astro:525`.

And here is the part that matters. Five consecutive commit messages waved this through as
*"tsc clean but for the pre-existing ProviderRow error"* — a known-good baseline that was **no longer
accurate**: the ProviderRow error is gone and three different errors took its place. A baseline nobody
re-measures becomes a lie, and then every real error hides inside it.

**This is the disease.** Not missing tests. A red baseline that cries wolf, so the one signal that
would answer *"did my edit break page B?"* gets waved past. Nothing else in this document is worth
building until `npm test` and `npm run check` are green on an unedited tree.

### 1.2 The number-one mechanism is CSS ownership, not duplication

**241 of 1,472 class names in this repo have their appearance decided in more than one file.**

The clearest instance, and it is almost certainly something you have felt: on `/`, `/how-it-works`,
`/your-key` and `/upgrade`, an Astro-scoped `.cta` rule (specificity 0,2,0 — Astro adds its own
attribute selector) **permanently outranks** the global `.cta` in `src/styles/global.css:487`
(specificity 0,1,0).

So you edit the site's one button, and on four pages nothing happens. You edit it again in the other
place, and now it changes on those four and not the rest. That is the literal mechanism behind
*"I change it and it changes back."* It is not a ghost. It is the cascade.

Two related traps, both live:

- **A second, undeclared token system** in five marketing pages, already drifted from `tokens/`.
- **Hand-editing `src/styles/tokens.css` or `themes.css` is silently reverted** by `npm run dev`,
  because `style-dictionary` regenerates them from `tokens/*.json`. If you have ever fixed a colour
  and watched it come back, this is why.

### 1.3 One shared layout drags the whole app into almost every page

`BaseLayout.astro` → `SiteHeader.astro` → `come-ready-store` pulls **the database and the entire AI
drafting pipeline into 83 of 91 routes.**

This is why an edit anywhere near the chrome can change, slow, or break a page that has nothing to do
with the feature you were working on. `src/lib/data.ts` reaches 30 routes. `BaseLayout.astro` reaches 41.

### 1.4 The bugs cross string boundaries, not import boundaries

This kills an entire category of tooling before you spend money on it.

Your **import graph is already clean**: zero page→page imports, zero component→page, zero
lib→component. Every one of the six historical failures I reconstructed crossed a *string* boundary
instead — a `data-*` attribute name, a CSS class name, a filesystem route path, a token name, a status
string on the wire.

Consequences:

- **`madge` and `dependency-cruiser` would have caught none of them.** `dependency-cruiser` cannot
  parse `.astro` at all — it is blind to 248 files here. `knip`'s Astro support is regex-based.
- What pays instead is a ~60-line hand-rolled reverse index (it runs in **75 ms** on this repo — I ran it)
  plus three small string-contract checks.

### 1.5 The untyped edges

- **1,741 lines** in `public/scripts/ledger-v4-app.js` and `ledger-v4-views.js` are outside the build,
  outside type-checking, and outside `astro check` entirely.
- **41 `<script>` blocks / 2,795 lines** inside `.astro` files. `astro check` does type-check most of
  them — but **not** the 147 lines inside the six `<script is:inline>` blocks.
- **185 DOM query call sites across 32 files resolve to 168 distinct static selector literals and only
  2 dynamic ones.** That is **98.8% machine-checkable**, and today not one of them is checked.
- **Ten twin route pairs** (`X.astro` beside an `X/` directory): account, board, desk, jobs-data,
  ledger, prelist, profile, report, settings, waitlist.
- The root **`api/` directory is still armed.** `api/rebuild.ts` and `api/subscribe.ts` are still
  git-tracked, and the platform still gives `/api/*` to them before Astro sees it. `waitlist/join.ts`
  carries the scar in its own header: it *"lived at /api/waitlist until 2026-09-20, where it was never
  reached."*

---

## 2. THE WORKED EXAMPLE: YOUR RESUME UPLOAD

You said: *"I can't upload a resume into the system, but I can upload it on a different page and it
worked previously."* That bug is now **proven**, and it is the best teacher in this document because it
defeats every gate anyone would think to build first.

### 2.1 What is broken

`/profile`'s upload works. The **entries land in your record.** Then the page waits 120 seconds and
tells you the read was too slow.

Confirm it yourself in five seconds, no server, no database:

```bash
grep -n "status === 'ready'" src/pages/profile.astro src/components/come-ready/StepResume.astro src/components/come-ready/StepLetter.astro
```

```
src/pages/profile.astro:890                      if (state && state.status === 'ready') {
src/components/come-ready/StepResume.astro:191   if (body && (body.status === 'ready' || body.status === 'none')) {
src/components/come-ready/StepLetter.astro:132   if (body.status === 'ready' || body.status === 'none') {
```

That difference is the entire bug.

### 2.2 The chain

1. You drop a file. `profile.astro:920` POSTs it to `/profile/import/parse`.
2. `parse.ts:141` starts a background read and answers `{status:'started'}`.
3. `profile.astro:950` starts polling `/profile/import/status` every 3 s, up to 40 times.
4. The background runner finishes three awaits in a row (`resume-parse-runner.ts:121,129,133`):
   marks the row `ready`, **writes your entries into the record**, then **deletes the row**.
5. With the row gone, the status endpoint answers `{status:'none'}` (`status.ts:41`) — forever.
6. `profile.astro:890` accepts only `'ready'`. So `'ready'` is observable for a few **milliseconds**
   and every poll from then on says `'none'`, which the page ignores.
7. Forty polls, ~120 seconds, then: *"The read is taking longer than it should."*
8. Reload and there is no receipt either, because the row the receipt reads was already deleted. So
   the page shows a fresh empty upload box with your new entries sitting unannounced below. **That is
   why it feels intermittent when it is in fact deterministic.**

### 2.3 Who did it

**Commit `ab7b03c`, 2026-09-19** — *"Land a resume upload straight in the Profile Record, no confirm
step."* It added `applyParsedProposals` + `clearParse`, changing the lifetime of `'ready'` from
durable to milliseconds.

`git show --stat ab7b03c` touches **six files, every one of them `src/lib/resume-parse-*.ts` and their
tests.** Not one client file. The server's vocabulary was redefined, its own tests were updated (+51
lines), and the three browser files that speak that vocabulary were never opened. The diff gave no hint.

**Commit `341f8af`, 2026-09-20** fixed exactly this bug — in exactly one file, `StepResume.astro`. Nobody
asked which other files contained the same line. `/profile` has now been broken for **four days**.

### 2.4 Three more live defects found while proving it

- **`profile.astro:927`** parses any 200 as JSON with no content-type check. `fetch` follows redirects,
  so middleware's 302 to `/sign-in` arrives as a 200 HTML page, `.json()` throws, and an **expired
  session is reported to you as "check your connection."** Both twins guard this
  (`StepResume.astro:244`); `/profile` does not.
- **`profile.astro:950` is the only call site of `watch()`.** Reload mid-read and you get a spinner
  that polls nothing, forever. `StepResume.astro:202` has the branch that fixes this.
- **`profile.astro:943`** is a second hand-written whitelist in the same file, on the POST response.

### 2.5 What it teaches — the class

> **UNTYPED WIRE CONTRACT WITH DUPLICATED CLIENT CONSUMERS.**
> The browser whitelists the server's success values, by hand, in more than one place.

Three properties, all present:

1. **The wire vocabulary is wider than any type in the repo.** `ParseStatus = 'pending' | 'ready'`
   (`resume-parse-store.ts:36`) types the *database row*. The wire also emits `'none'`, `'started'`
   and `'signed-out'` as inline literals. Three of five values exist nowhere in the type system.
2. **Both ends are stringly typed**, linked by nothing but memory.
3. **The protocol is hand-implemented N times** (N=3), and the server change lands in a commit that
   touches only `src/lib`.

This is the general answer to your complaint. It is not spooky action at a distance. It is one contract
copy-pasted into several surfaces with no shared definition, so **every server change silently
invalidates the copies you did not happen to open that day.**

And note: the two "fixed" pollers are not safe, they are **lucky**. They still hand-write a whitelist,
now `'ready' || 'none'`. The runner already has a path that leaves a row `'pending'` forever on failure
(`resume-parse-runner.ts:137`), and the obvious next fix is a `'failed'` status — the moment that ships,
**both** of them hang for 120 seconds with no code change of their own. Widening a whitelist does not
fix a whitelist.

---

## 3. YOUR TWO QUESTIONS, ANSWERED DIRECTLY

### 3.1 "If we take screenshot comparisons, how do they stay up to date? It could be right today and wrong tomorrow."

This is the correct objection and it is exactly what killed the last attempt. The Index's Gate 5
("visual: screenshots match committed baselines") was **retired on 2026-09-06 and its baselines
deleted.** It did not die of flaky fonts. It died of **data nondeterminism**: it photographed 384 shots
against 60 baselines across 15 routes, and **85 of those were one job-page template whose content
changed every night.** Every comparable baseline failed the day after it was re-recorded. So the answer
was always "accept everything," which means it measured nothing.

Three rules follow, and they are the whole design:

**Rule 1 — Never photograph content you do not author.** `/board`, `/board/[slug]`, `/jobs-data`,
`/desk`, `/opportunities`, `/kills` all render data that changes nightly. They get **zero pixel
baselines**, forever. They get behavioural checks instead (§5, Layer 1–2).

**Rule 2 — Photograph the gallery, not the pages.** You already have `src/review/specimen.astro` and
`src/review/states.astro` — 611 lines of authored component states: empty, loading, error, dark,
mobile. They are **currently dead code**: AntiAlgo never copied the `injectRoute` integration that the
Index used to serve them, so they have never been built in this repo. Ten lines of
`astro.config.mjs` brings them back. These are **authored** surfaces, so their pixels only change when
you change a component. That is a baseline that does not rot.

**Rule 3 — Cap it, and make accepting a change one command.** Start at 14 baselines (7 sections × 2
themes). Hard ceiling of 40. When you change something on purpose:

```bash
npm run conform:accept
```

That re-records the baselines and puts the change in your **git diff**, where you review it like code
and it lands in the same commit as the change that caused it. That is the answer to "how does it stay
up to date": **the baseline is not a separate artefact you maintain, it is part of the commit.** If the
diff shows a page you did not touch, that is your regression — visible before you push, not after.

Most of the reviewing is not pixels at all. Layer 2 uses **ARIA snapshots**, which are *text*. A
regression shows up as a readable line in a git diff, not as a picture you have to squint at:

```diff
- - button "Save filters"
+ - button "Save filters" [disabled]
```

**And one honest limit:** pixel baselines recorded on your Mac are only valid on your Mac. That is fine
while the gate runs locally, which is the plan. The day you want it in GitHub Actions, pixels must be
re-recorded inside a pinned container. Layers 0–2 have no such constraint and can go to CI immediately.

### 3.2 "This doesn't cover actual functionality."

**Correct, and this is the most important thing in the document.** I asked the diagnostician directly
whether a screenshot would have caught your resume bug. The answer was no, for three independent
reasons:

1. **Every frame of that bug is a correctly-styled, designed state.** A spinner at 3 s is right. "The
   read is taking longer than it should" is a real authored message. Nothing is wrong *pixel-wise*. The
   defect is that a correct-looking state is reached when it should not be. **It lives in time and in
   protocol, and a screenshot has no time axis.**
2. **A route screenshotter never enters the flow.** Reaching that state needs a signed-in paid account
   with a stored provider key and an actual file upload. The screenshot of `/profile` is the idle state,
   forever.
3. **The same page renders identically** whether the row says `ready`, `none` or `pending`.

Now the sentence that should decide how you spend this budget:

> This repo has **97 test files** and the Index had **11 gates**, including axe on every route in both
> themes at two viewports — and **not one of them executes a single line of client-side JavaScript.**

The `.render.test.ts` idiom is `AstroContainer.renderToString()`, which returns a **string**. A string
cannot run a `<script>` block. There is no test for `profile.astro`, `ImportBand.astro`,
`StepResume.astro` or `StepLetter.astro`. Eleven gates, ninety-six test files, and the broken line sits
in the blind spot of all of them.

So functionality is covered by three things pixels cannot do, and they are the *first* things built:

- **Layer 1 — a real browser loads every route as three roles** and fails on any uncaught page error,
  any console error, any unexpected status, any `/api/*` that 404s. This is the cheapest, most valuable
  layer in the whole design. It has **no baselines to rot** and it catches five of your six recorded bugs.
- **Wire-contract tests** (§5, Layer 3) that assert every value an endpoint can emit is decided by
  every consumer. ~2 ms. Pure Node. This is the one that catches the resume class.
- **Journey tests** that drive the money paths end to end with a real session and a real database:
  sign-up → Come ready → upload → board → job detail → draft → DOCX download.

---

## 4. WHAT WE ARE NOT BUILDING, AND WHY

Refusals matter as much as the plan. Each of these was researched and rejected on evidence.

| Rejected | Why |
|---|---|
| `dependency-cruiser` / `madge` import rules | Cannot parse `.astro` (blind to 248 files). Your import graph is already clean. Would have caught **0 of 6** historical failures. |
| A hosted visual-diff service, now | You said $0. Argos' free tier (5,000 shots/month) would fit, and it is the runner-up if you find yourself skipping the local accept step. Not first. |
| Porting the Index's 11 gates | Four of them read a directory of built `.html` files. **75 of ~95 routes here are `prerender = false`.** A straight port would inspect 110 pages of which 100 are one job template, and would never once load the board, desk, drafting, profile, billing or `/internal`. That is the same structural blindness that killed Gate 5. |
| The Index's CI job | Its last green run was **2026-09-15**; 22 successes in 200 runs; 46–60 minutes each. Copying it copies the failure. |
| Storybook / Histoire / Ladle | `src/review/` already is a gallery, built from the real components. A second render path is a second truth. |
| Claude in CI as a reviewer | Bills per push, ~20 min, and reviews the diff — the layer five of your six bugs are **not** in. Local `/code-review` is free and already available. (Managed Code Review is Team/Enterprise only — not available on this account.) |
| A new test runner dependency | `playwright@1.62.1` **already bundles the runner.** I verified: `npx playwright test --help` works, `expect().toHaveScreenshot` is present, Chromium + WebKit are already downloaded. Import from `'playwright/test'`, not `'@playwright/test'`. |
| A slow pre-commit hook | You will route around it. Fast checks pre-commit, the real gate pre-push. |

---

## 5. THE DESIGN

Six layers. Each is independently useful and independently shippable. Cost figures are measured where
marked, estimated otherwise.

### Layer 0 — Make the baseline true *(30 min, prerequisite for everything)*

```bash
npm run db:migrate     # applies db/207_jobs_derived.sql
npx vitest run         # must be 1235 passed
npm run check          # must be 0 errors — fix the 3
```

Plus a `test/db-columns.test.ts` that diffs the column set implied by `db/*.sql` against
`information_schema.columns` and fails with **one sentence**: *"db/207_jobs_derived.sql has not been
applied — run npm run db:migrate."* Seventeen cryptic stack traces become one instruction.

**Catches:** today's red suite, and the `db/204` dateless-entries incident you already lived through.

### Layer 1 — The browser sweep *(no baselines, ~90 s, catches 5 of your 6 bugs)*

A real browser visits every route in a generated manifest as **signed-out, member, paid, internal** and
asserts four things per route: no uncaught `pageerror`, no `console.error`, status as expected, and a
non-empty `main`.

The route manifest is **generated from the build output, never hand-kept** — that is the lesson
`test/gates/a11y.mjs:24` in the Index already records.

**Catches:** `edfc2ec` outright (its message says *"Every board load threw a ReferenceError"* — one
assertion, one second). The root `api/` shadowing that killed your waitlist form for a week. Empty-shell
and lost-rows failures. **It would have caught the resume bug's sibling defects.**

**This ships first and alone, and you live with it for a week.** It has no accept step, so it cannot be
abandoned at the accept step — which is where the last attempt died.

### Layer 2 — ARIA snapshots *(text baselines, reviewable in a git diff)*

`toMatchAriaSnapshot` on the main landmark of every route, per role. Platform-independent, so they
commit safely and can run in CI on day one.

**Catches:** the saved-filter restore firing on the wrong pages (`54435b9`) — the filter bar appears in
the snapshot of a page that should not have it. The home-page section added and removed four times.

### Layer 3 — Wire contracts and invariants *(~milliseconds, no browser, no DB)*

The layer that catches your resume class. Four parts:

1. **Wire vocabulary modules.** For each endpoint family, one typed union of every value it can emit,
   and one `readIsFinished()`-style function with a `switch` that has **no `default`** — so adding a
   status becomes a **compile error** instead of a 120-second hang in three browsers.
2. **A DOM-contract check.** 168 static selector literals across 32 files; assert each one exists in
   the markup that is supposed to provide it. Priority: the two genuinely *cross-file* cases
   (`CaptureModule.astro` reading `.filter-label` from `Filters.astro`; `jobs-data.astro:119` reading
   `header.hdr` from `SiteHeader.astro`).
3. **`scripts/gate-invariants.mjs`** — pure filesystem assertions: `src/pages/api` must not exist; every
   gated route resolves to a `ROUTE_POLICY` entry; every gate id in `test/gates.config.mjs` either is
   retired or has a runner here; no orphan routes (this is what would have flagged that
   `states.astro` is unreachable).
4. **A token-resolution check**, ported from the Index's `scripts/check-token-usage.mjs`, which this
   repo does not run. First run should flag four already-dead `var(--space-150)` / `--space-050`
   references.

### Layer 4 — Journeys with a real session and a real database *(~4 min)*

`better-auth@1.7.1` **already ships a `testUtils` plugin** that mints signed session cookies with no
email flow. A setup project writes one `storageState` file per role; every later test starts already
signed in. Never fill the sign-in form; never hand-roll the cookie name.

Database: a local `antialgo_test` Postgres, created and migrated by one script. You already have
Homebrew Postgres 17 running, `psql` on PATH, and an `antialgo_dev` database with 24 tables — so this is
plumbing, not archaeology.

**Journeys to cover, in this order:** the resume upload that is broken right now · sign-up → Come ready
→ `/desk` · board → job detail → draft → DOCX download · waitlist join · each settings mutation ·
billing last (see §6).

### Layer 5 — Deliberate visual checks *(run on demand, not in the fast gate)*

- **Pixels**, capped at 40 baselines, on `/_states` and `/_specimen` **only**, both themes, Chromium only.
  Clock frozen, `document.fonts.ready` awaited, animations disabled, scrollbars hidden via `stylePath`.
- **`scripts/prove-styles.mjs`**, which you already own and which nothing runs. It drives Chromium *and*
  WebKit in both themes and diffs **computed styles** — the only instrument in either repo that can see
  the Astro-scoped-CSS-versus-script-built-element bug, because the element renders and the pixels can be
  identical while the cascade is wrong. It needs three changes: a committed baseline instead of a
  two-capture ritual, the noisy timing fields dropped, and `/_states` added to its page list.

### Layer 6 — Claude Code enforcement *(the part that makes it automatic)*

Three hooks in a committed `.claude/settings.json`:

| Hook | Event | What it does |
|---|---|---|
| `blast-radius.mjs` | `PostToolUse` on Edit\|Write | After every edit, prints the routes that file reaches and the tests that cover them. **Measured at 75–88 ms.** Editing `Filters.astro` reports `/`, `/board`, `/prelist` plus the two render tests. |
| `owner-chosen.mjs` | `PreToolUse` | Blocks edits to files you have declared owner-chosen (the home hero, the covenant copy, `entitlement.ts`, `middleware.ts`) unless acknowledged — naming the commit, e.g. `8e05097`. **This is how the home section stops flipping a fifth time.** |
| `conform-gate.mjs` | `Stop` | Refuses to call a turn done if the gate has not run green since the last edit. |

Plus **`.claude/rules/*.md` with `paths:` frontmatter** — the real answer to *"how does an agent editing
page A know about page B without reading 91k lines?"* A rule fires when a matching file is read, and
costs nothing otherwise. One rule per invariant you have already written down: the shared Board
component, the Astro-scoped-CSS trap, the owner-chosen home sections, no `src/pages/api`, the route
policy, the dropdown focusout bug.

Working prototypes of all three hooks exist and were tested during this research. They are not in the
repo yet.

---

## 6. WHAT IS YOURS TO DECIDE

Five things I cannot do for you. Three of them block part of the plan.

1. **Neon preview branching — BLOCKING for preview tests.** `vercel env ls` shows **one**
   `DATABASE_URL` covering *Production, Preview*. Unless Neon's per-preview branching is on, a test
   that writes against a preview URL **writes to your live database**. One checkbox in the Neon
   integration; I cannot read it from the CLI. Until it is confirmed, journeys run **local only**.
2. **Four missing Preview env vars — BLOCKING for signed-in preview tests.**
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SITE_ORIGIN`, `KEY_ENCRYPTION_SECRET` are
   Production-only. Sign-in is dead on every preview deploy today.
3. **Stripe test keys — BLOCKING for the billing journey.** No `STRIPE_*` keys exist in `.env.local`.
   Billing is flag-dark, so it cannot break a visitor today; I will build the journey and leave it
   skipped with a one-line reason until you paste test keys.
4. **Firefox.** Your dropdown bug was Safari **and** Firefox. Chromium and WebKit are installed;
   Firefox was not, and now is — installed 2026-09-24, with a `firefox-interactions` project.
5. **`/colophon` is publishing a claim this repo cannot support.** It renders 11 gates from
   `test/gates.config.mjs` and tells the reader to *"Run npm run conform"* — a script that does not
   exist here. `src/data/conformance-run.ts` calls a report like that *"the worst file in the
   repository: a conformance report that conforms to nothing."* Either the new gate gets registered
   there and the page becomes true, or the page says out loud that it describes the Index. **That is
   your ruling, not mine.**

Also worth knowing: your Vercel project's **Framework Preset is still "Vite"** from the old landing
page 228 days ago. `vercel.json` overrides it, so it works — but the day that key is edited, the deploy
silently falls back to a Vite build. Same species as the root `api/` directory.

---

## 7. BUILD ORDER

Each step has a pass condition. Nothing proceeds on a step that did not pass.

| # | Step | Pass condition | Time |
|---|---|---|---|
| 1 | Apply the migration, fix the 3 type errors, add the column-drift test | `npm test` 1235/1235 · `npm run check` 0 errors | 45 min |
| 2 | `gate-invariants.mjs` + route census + token check | exits 0, and provably exits 1 on a broken fixture | 3 h |
| 3 | Wire-contract modules + the DOM-contract check | the resume bug's test **fails on today's code** | 3 h |
| 4 | Layer 1 browser sweep, signed-out only | every public route green, in under 60 s | 3 h |
| 5 | `injectRoute` for `/_states` + `/_specimen`; `build:gated` | `npm run build:gated` succeeds; both routes serve | 2 h |
| 6 | Auth setup project; 4 roles; local test DB | 4 `storageState` files; `/desk` loads as member | 4 h |
| 7 | Layer 1 extended to all roles; Layer 2 ARIA snapshots | all ~45 routes × 4 roles green | 3 h |
| 8 | Journeys, resume upload **first** | the upload journey **fails**, proving it catches the live bug | 5 h |
| 9 | Pixels on the galleries, capped at 40 | `conform:accept` round-trips; a hand-broken component fails | 3 h |
| 10 | `prove-styles.mjs` → committed baseline | detects the `.cta` specificity inversion | 2 h |
| 11 | The three hooks, `.claude/rules/`, `/conform` command | Stop hook blocks a turn with a red gate | 3 h |
| 12 | `.github/workflows` running Layers 0–3 only | green on a clean checkout | 1 h |

**Step 3 and step 8 have the unusual pass condition of *failing*.** A gate that cannot demonstrate it
catches a known bug is decoration. This is the `conform:prove` idea from your own Index harness, and it
is the single best thing in there: *the instruments get tested before the site does.*

---

## 8. HOW THIS ANSWERS THE ORIGINAL COMPLAINT

| What you said | What catches it | Layer |
|---|---|---|
| "I change one page and another changes" | blast-radius hook at edit time; ARIA snapshots; the `.cta` specificity check | 6, 2, 5 |
| "I change it back visually and it breaks internally" | wire contracts; DOM contracts; `astro check` green for the first time | 3, 0 |
| "I don't find out until I test it" | 90-second gate, blocked by a Stop hook | 1, 6 |
| "I can't upload a resume" | proven, §2 — and its test is step 3 | 3, 4 |
| "How do screenshots stay up to date?" | authored galleries only, capped, accepted in the same commit | 5 |
| "This doesn't cover functionality" | console/error sweep, wire contracts, real journeys | 1, 3, 4 |
| public **and** behind a password | four roles, real sessions, `/internal` included | 4 |

---

## APPENDIX A — MEASUREMENTS

Every number verified on 2026-09-23 at `cfd7277`. Counts marked ✎ were corrected by an adversarial
verification pass after a first agent got them wrong.

- 97 test files ✎ · 1,235 tests ✎ · 15,954 lines
- 3 test files / 17 tests failing · cause: `db/207_jobs_derived.sql` unapplied (46 of 47 applied)
- `npm run check`: 3 errors ✎ (not the "pre-existing ProviderRow error" five commits claimed)
- 91 route files · **74** with `prerender = false` (I wrote 75; the census counted the real directive rather than comment mentions) · 17 prerendered → 110 `.html`, 100 of them `/role/`
- 1,472 class names · 241 styled in more than one file
- `BaseLayout` → 41 routes · `SiteHeader` → 83 of 91 · `src/lib/data.ts` → 30
- 185 DOM query sites / 32 files / 168 static selectors / 2 dynamic
- 1,741 lines of unchecked `public/scripts` · 41 `<script>` blocks / 2,795 lines ✎ · 147 lines in 6
  `is:inline` blocks not type-checked ✎
- 10 twin route pairs ✎ · 11 routes absent from `nav.ts` ✎
- `blast-radius.mjs` on `Filters.astro`: **88 ms**, correct answer
- `playwright@1.62.1` bundles the runner · Chromium, WebKit **and Firefox** installed (Firefox added 2026-09-24)
- Index CI: last green **2026-09-15** · 22 successes in 200 runs · 46–60 min per run
- Argos free tier 5,000 shots/month, Pro $100/mo · Chromatic free 5,000, Starter $179/mo ✎ (Percy no
  longer publishes pricing)

## APPENDIX B — THE TRAP THAT ALREADY CAUGHT YOU ONCE

`src/lib/jobs-data-render.test.ts` is the **one** test in this repo that executes
`public/scripts/ledger-v4-*.js` and asserts its render contract. It is `describe.skip` unless
`DATABASE_URL` is set (lines 22–23).

So on any machine or CI runner without a database, **the only guard on 1,741 lines of untyped browser
code silently disappears, and the suite still reports green.** Every new check in this plan must fail
loudly when it cannot run, never skip quietly. The Index learned this and wrote it down as exit code 2:
*"a gate that could not run has measured nothing, and the dangerous failure mode for any test suite is
looking green when it measured nothing."*

That sentence is the whole strategy in one line.

---

# PART TWO: WHAT WAS BUILT

Written 2026-09-24, after building it. Everything below is measured on this machine,
on branch `safety-net`, and every claim is something a command will reproduce.

## The one command

```bash
npm run conform          # 6 gates, 35s. Before every commit.
npm run conform:deep     # 7 gates, 63s. Adds the browser. Before every push.
npm run conform:accept   # re-record the pixel baselines you meant to change
npm run conform:list     # what each gate is and why
```

Plus `/conform` inside Claude Code, which runs the same thing and reports what
changed, what it reaches, and which routes in that blast radius nothing covers.

## What is green

| Gate | Time | What it proves |
|---|---|---|
| `types` | 25.4s | `astro check`, 0 errors — including the `<script>` blocks inside `.astro` files |
| `unit` | 8.6s | 1,248 tests |
| `invariants` | 0.1s | 5 structural checks: nothing under `src/pages` can be shadowed by the root `api/`; every gated route has a `ROUTE_POLICY`; no orphan partials; `nav.ts` and the filesystem agree |
| `dom-contracts` | 0.2s | every selector a client script queries is still provided by the markup that must provide it |
| `tokens` | 0.4s | every `var(--x)` resolves; `tokens.css` matches a fresh `style-dictionary` build |
| `routes` | 0.2s | the manifest, regenerated from the filesystem, audience matrix included |
| `browser` | 53.2s | 290 assertions: every route as 5 audiences, both directions, + 14 pixel baselines, WebKit + Firefox interactions, mobile geometry, print, and the upload and draft journeys |

**78 seconds for all of it**, 24 for the fast tier. The budget was 90.

## The four defects the gates found on their first run

None of these were introduced by this work. All four were already live.

1. **`Board.astro:288-289`** reads `[data-count-rows]` and `[data-count-page]`.
   Neither attribute exists anywhere in the repo. They arrived with `e81f651` and the
   markup that provided them did not. The row-count and page-count labels on `/`,
   `/board` and `/prelist` **have never updated, once, since the first import** —
   guarded by an `if`, so silently.
2. **Four `var(--space-150)` / `var(--space-050)` references** resolve to nothing and
   render as `gap: 0`. The ramp has no 050 or 150 step. Someone wrote a gap; no
   reader has ever seen one.
3. **`/colophon` publishes a PASS/FAIL verdict to every visitor for 10 gates** and
   `test/gates/` does not exist in this repository.
4. **`vercel.json` declares no `crons` key**, while `tasks/nudge.ts` and
   `api/rebuild.ts` both document a daily cron against themselves. Those crons have
   never run.

Plus four routes hand-typing their own paths instead of using `nav.ts` — and
`/jobs-data/summary` is typed by hand in an `.astro` file *and* in an untyped browser
script, which is the exact string-boundary shape that has already cost two outages.

## And one false positive, which is why the ratchet exists

The DOM gate flagged `NewHereStrip`'s missing `[data-new-here-dismiss]`. It is not a
defect: the control was removed on 2026-08-20 by your own decision and the script's
`if (!button) continue;` is the deliberate guard. The component says so in a comment.

**A gate that cries wolf is a gate you stop reading.** So
`test/conform/accepted.json` records every finding already seen, with a verdict, a
date, and for the real ones an explicit question for you. A gate fails on findings
**not** in it — and also fails on an accepted finding that **no longer reproduces**,
because a stale entry is how a ratchet rots into an excuse. Both behaviours were
adversarially verified, not assumed.

## Three bugs in the harness itself

Worth recording, because each one would have made the suite agree with itself about a
lie — the single worst thing a test harness can do.

1. The signed-out project's `testMatch` also matched `*.signedin.spec.ts`. Those
   specs would have run **signed out** while their names claimed otherwise.
2. `auth.setup.ts` minted cookies with better-auth's own `secure` flag. A secure
   cookie is never sent over the dev server's http, so the storageState file was 36
   bytes of `{"cookies":[]}` — **and the setup passed.**
3. The minting process and the dev server signed with **different**
   `BETTER_AUTH_SECRET`s. A signature mismatch reads exactly like "not signed in", so
   every *allowed* assertion failed and **every *denied* assertion passed.** The suite
   would have reported 29 green and called the gates proven.

All three were caught by one assertion that exists for precisely this: each role
proves it is really signed in before asserting anything about what it can see. That
assertion is the most important line in the sweep.

## What is still open

### Yours to decide (three of these block real coverage)

1. **Neon preview branching.** `vercel env ls` shows one `DATABASE_URL` covering
   Production *and* Preview. Unless per-preview branching is on, a write-path test
   against a preview writes to your live database. One checkbox; I cannot read it.
2. **Four Preview env vars.** `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SITE_ORIGIN`,
   `KEY_ENCRYPTION_SECRET` are Production-only, so **sign-in is dead on every preview
   deploy.** Nothing signed-in can be tested there until they exist.
3. **Stripe test keys.** No `STRIPE_*` in `.env.local`. Billing is flag-dark, so it
   cannot break a visitor today; the journey is built and skipped with a stated reason.
4. ~~`npx playwright install firefox`~~ **Done 2026-09-24.** `firefox-interactions` now
   runs the interaction specs. Measured caveat: Playwright's Firefox automation would not
   reproduce the focus race even with the guard removed by hand, so a green Firefox run is
   not evidence about *that* bug — WebKit is. The Firefox half wants one human check.
5. **The `/colophon` ruling.** Port the gates so the page is true, or change the page
   to describe what this repo measures.

### Still to build

- **Journey tests for the money paths**: sign-up → Come ready → upload → board → job
  detail → draft → DOCX. The upload journey needs a seeded provider key, which needs
  `KEY_ENCRYPTION_SECRET` and the keychain's encryption — plumbing, not archaeology.
- **The interaction specs under WebKit** (3 of them: the Come-ready dropdown, a saved
  filter, the waitlist form). This is where the Safari focusout bug lives.
- **Mobile and print.** Nothing in the plan had a viewport dimension until the critic
  pointed it out: `prove-styles.mjs` never calls `setViewportSize`, and `/report` has
  `@media print` rules that a `global.css` edit could destroy with no on-screen effect.
- **`emails/` is excluded from vitest entirely** — `vitest.config.ts` includes only
  `{src,test}/**`, so the two email tests that exist have never run. One line.
- **Stripe's webhook has no test and is the only writer of `app_user_profile.tier`**,
  which every gate in the app keys off. Three tests, no Stripe account needed.
- **`/internal` — the privilege-escalation surface — has no negative test.**
  `internal/tier.ts` grants paid and internal via `ON CONFLICT UPDATE`. Nothing asserts
  a member cannot call it.
- **Degraded third parties.** Nothing tests the failure branch of Resend, Anthropic,
  OpenAI or Neon. The one that already took the site down was Neon.
- **`.github/workflows`** running the deterministic tier on a clean checkout. Held
  until the local gate has been trusted for a week, deliberately.
