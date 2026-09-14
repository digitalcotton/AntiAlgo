# The nightly data pipeline

How the board, kills, and stats on antialgo.ai stay fresh, and what feeds them.

## The shape of it

    Mac mini (nightly sweep)
      -> writes board-latest.json.gz, kills-archive.json, stats.json, kills.json
      -> commits them into this repo's src/data/ and pushes to digitalcotton/AntiAlgo
      -> the push triggers a Vercel PRODUCTION build
          -> npm run build  ==  tokens && astro build && node scripts/ingest-on-build.mjs
          -> ingest-on-build (production only): db/migrate.mjs, then ingest-jobs.mjs --replace
          -> the production Postgres now holds the new sweep
      -> every page reads that database per request and serves the fresh sweep

Data lives in git. The deploy that publishes the sweep is the deploy that loads
it, so the page and the numbers can never come apart.

## The build side (done, in this repo)

- `package.json` build: `npm run tokens && astro build && node scripts/ingest-on-build.mjs`
- `scripts/ingest-on-build.mjs` runs ONLY when `VERCEL_ENV === 'production'` and a
  `DATABASE_URL`/`DATABASE_URL_UNPOOLED` is present. It:
  1. applies any un-run `db/*.sql` (idempotent, advisory-locked) — so schema
     changes ship with the deploy that needs them, no manual `db:migrate`;
  2. loads `src/data/board-latest.json.gz` (+ kills, stats) via
     `scripts/ingest-jobs.mjs --replace`, in one transaction;
  3. **fails the build** if migrate or load fails, so a stale or half-loaded
     board is never published. Preview and local builds skip it.

## What has to be set up once (outside this repo)

1. **A production Postgres for AntiAlgo** (Neon or similar). Set in the AntiAlgo
   Vercel project's env: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `SITE_ORIGIN` (= https://antialgo.ai).
   The first production build applies every migration itself.
2. **Write access for the mini** to `digitalcotton/AntiAlgo` (a deploy key or a
   fine-scoped token).
3. **A step in the mini's nightly job** that pushes the data files here. It
   already produces them for the Index; it now also lands them in this repo. For
   example, after the sweep writes the files:

       cd /path/to/AntiAlgo-checkout
       git pull --ff-only
       cp $SWEEP_OUT/board-latest.json.gz  src/data/
       cp $SWEEP_OUT/kills-archive.json    src/data/
       cp $SWEEP_OUT/stats.json            src/data/
       cp $SWEEP_OUT/kills.json            src/data/
       git add src/data/board-latest.json.gz src/data/kills-archive.json src/data/stats.json src/data/kills.json
       git commit -m "sweep $(date -u +%Y-%m-%dT%H:%MZ)" && git push origin main

   The push is the trigger; Vercel builds on it and the ingest loads the sweep.
   No GitHub Action and no cron on this side — the mini's push is the clock.

## Sequencing (important)

`ingest-on-build.mjs` **fails a production build that has no database**, on
purpose (a prod deploy with no DB is a misconfiguration, not a quiet night). So
set the Vercel `DATABASE_URL` **before** the build-time-ingest change reaches a
production build, or production deploys will fail until it is set. The live site
keeps its last good deploy in the meantime; nothing regresses, but nothing new
ships either.
