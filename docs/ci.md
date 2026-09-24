# CI: what `.github/workflows/conform.yml` does

One job, `conform-fast-tier`, on every push and every pull request. It runs
`npm run conform` — the six deterministic gates (types, unit, invariants,
dom-contracts, tokens, routes) — on a clean Ubuntu checkout, Node 24, `npm ci`.
Nothing else. Measured locally at 24.9s; the job's own timeout is 10 minutes.

Full reasoning — why this job and not another shape, why the concurrency
group is keyed the way it is, why `ubuntu-latest` — is written as comments
inside the workflow file itself, next to the thing each decision affects.
This page is the short version, for someone who does not want to read YAML
comments first.

## What it deliberately does not do

It does not run `npm run conform -- --deep`. That tier adds a seventh
gate, `browser` — Playwright, five signed-in audiences, two pixel
baselines — and it needs a running dev server plus a seeded `antialgo_test`
Postgres. CI has neither: no database service is wired into this workflow,
and this repo is also still missing four Preview environment variables
(`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SITE_ORIGIN`,
`KEY_ENCRYPTION_SECRET` — see `docs/regression-strategy.md`, section 6) that
signed-in Playwright runs would need even once a database exists.

It does not run the browser tier as a second, `continue-on-error` job either.
A step that is allowed to fail and *will* fail every single time, because
the thing it needs is permanently absent from this environment, is a green
checkmark next to permanently red output. That reads as coverage on a pull
request and is not. When a seeded Postgres and those four env vars exist in
CI, add `--deep` here as a real, unconditional gate — not an advisory one
nobody reads.

It does not run on macOS. Nothing in the fast tier needs it, and running on
macOS anyway would just adopt the previous mistake at ten times the price
for nothing.

## How to read a red run

GitHub Actions only has two colors, and `scripts/conform.mjs` has three
outcomes. Read the "Run npm run conform" step's own printed line — it says
the outcome in words — before reading the red X:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | GREEN. All six gates ran and found nothing new. | Nothing — this is the only case with no artifact upload. |
| 1 | RED. A gate ran to completion and found something not already in `test/conform/accepted.json`. | Read the gate output in the log. Fix the code, or if the change was intentional, run `npm run conform:accept` locally and re-push. |
| 2 | COULD NOT RUN. A gate never got to measure anything — missing binary, launch failure, environment problem. | This is not the code failing. Find which gate could not launch and fix the instrument (or the runner image) before concluding anything about the diff. |

Exit 1 and exit 2 both show as a failed job in GitHub's UI — there is no
third badge to put "unknown" in — which is exactly why the step logs the
distinction explicitly instead of leaving it to be inferred from a number.
Treating exit 2 as exit 1 sends whoever is on call chasing a regression that
was never actually observed; treating it as exit 0 is worse, and is the one
failure mode this whole runner exists to make impossible.

On a red run, two files are uploaded as artifacts if they exist:
`.sweep/routes.json` (the route manifest the `routes`, `dom-contracts`, and
`invariants` gates are all checked against) and `playwright-report/` (empty
today, kept for when the browser tier is added here).

## "Why is CI not running my browser tests?"

Because there is no database in CI yet for them to run against, and a gate
that always fails for an environment reason, not a code reason, is worse
than a gate that does not run. Run `npm run conform -- --deep` locally
before you push — that is where the browser tier lives until a seeded
Postgres and the missing Preview env vars are wired into this workflow.
