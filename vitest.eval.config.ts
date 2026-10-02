/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { getViteConfig } from 'astro/config';

/**
 * The evaluation harness's own vitest config (`npm run eval:search`).
 *
 * A SEPARATE CONFIG, NOT A SEPARATE FOLDER OF TESTS. test/eval/search.eval.ts
 * runs the real TypeScript engine (job-store.ts imports extensionless modules
 * Node cannot resolve), so it has to be a vitest file; but it is a measurement,
 * not a check. It reads the whole local board, takes minutes, writes
 * docs/search-engine-metrics.{md,json}, and has no pass or fail that means
 * "the code is right". The normal suite must never run it, and two things
 * guarantee that: vitest.config.ts only picks up `*.test.*` files and this one
 * is named `*.eval.ts`, and this config is the only one that names it.
 *
 * Everything else is the main config's, so the engine sees the same Astro
 * resolution and the same pinned "now" it sees under `npx vitest run`.
 */
const sweptAt = (JSON.parse(readFileSync('src/data/stats.json', 'utf8')) as { swept_at_utc: string }).swept_at_utc;

export default getViteConfig({
  test: {
    include: ['test/eval/**/*.eval.ts'],
    env: { DATA_CONTRACT_NOW: sweptAt },
    // Latency is the one thing here that depends on the machine, so nothing else
    // may share it: one file, one worker, and a timeout measured in minutes.
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 120_000
  }
});
