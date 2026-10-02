#!/usr/bin/env node
/**
 * build-place-table.mjs: learn which country (and state) a city belongs to from
 * the rows that already say, and write it to src/data/place-cities.json.
 *
 * WHY A LEARNED TABLE. placeOf() (src/lib/jobs-derived.mjs) resolves a country
 * from the text when the text names one: "Paris, France", "Seattle, Washington",
 * "Toronto, ON". It cannot resolve "Paris" on its own, and 59.7% of the board
 * has no upstream country, so most of the unplaced rows are exactly that: a bare
 * city. The crawl DOES carry a country on 40.3% of rows, so the same city
 * appears hundreds of times with its country attached. This reads those rows
 * and keeps what is safe to repeat. No gazetteer is downloaded, and a city the
 * board never printed with a country stays unresolved.
 *
 * WHAT IS KEPT. A city (its folded name, see cityKey) is written only with at
 * least MIN_ROWS rows behind it and at least MIN_AGREE of them agreeing on the
 * country. "Cambridge" and "Birmingham" fail the second test and are left out:
 * a table that is right about London and wrong about Cambridge is worse than
 * one that does not know Cambridge. The state is kept on the same terms, over
 * the rows that name one, and only for the countries the parser reads states
 * for.
 *
 * WHAT IS NOT EVIDENCE. A row whose text names a country that contradicts its
 * own upstream country is skipped (the crawl has put "Albuquerque, New Mexico"
 * under Mexico), and so is a row that names several places, because there is no
 * telling which of them the country belongs to.
 *
 * IT REPORTS, AND THE REPORT IS PART OF THE JOB. A table that cannot say how
 * often it is right is a guess with a file name. Two measurements are printed:
 *   - a seeded 80/20 holdout over the rows that carry a country: learn on 80%,
 *     blank the country on the other 20%, and say how many of those placeOf
 *     resolves and how many of the resolved ones are right. This is the number
 *     that says whether the table generalises. The same strings recur night
 *     after night, so a SECOND holdout is cut by distinct location string:
 *     every string the table is tested on is one it never saw.
 *   - overall coverage: the share of all live rows for which placeOf(location,
 *     country) yields a country, against the share that had a country upstream.
 *
 * Usage:
 *   node scripts/build-place-table.mjs            read the local DB, write the file
 *   node scripts/build-place-table.mjs --dry-run  report only, write nothing
 *
 * Reads DATABASE_URL (load-local-env.mjs supplies it locally). Read only: it
 * never writes a row.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPlace, placeOf, isoCountry, cityKey } from '../src/lib/jobs-derived.mjs';

export const MIN_ROWS = 3;
export const MIN_AGREE = 0.95;
export const HOLDOUT_SEED = 220;
export const HOLDOUT_SHARE = 0.2;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'src', 'data', 'place-cities.json');

/** A small seeded generator (mulberry32), so the holdout is the same rows every
 *  run and the numbers in a report can be reproduced. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The most frequent key of a Map, ties broken by the key so the answer never
 *  depends on insertion order. */
function top(map) {
  let best = null;
  for (const [k, n] of [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (best === null || n > best[1]) best = [k, n];
  }
  return best;
}

/**
 * Learn the city table from rows of { location, country }. Only rows with a
 * valid upstream country are evidence. Returns { key: { city, country, admin1,
 * n } } with sorted keys, so the file it becomes is byte-for-byte reproducible.
 */
export function learnCities(/** @type {{ location?: string|null, country?: string|null }[]} */ rows) {
  const byKey = new Map();
  for (const row of rows) {
    const upstream = isoCountry(row.country);
    if (!upstream) continue;
    // An empty table on purpose: the structural read, not one already
    // influenced by what the table believes.
    const r = readPlace(row.location, upstream, {});
    if (r.parts !== 1 || !r.city) continue;
    if (r.textCountry && r.textCountry !== upstream) continue;
    // "Berlin, DE" under an upstream US is Delaware to the parser and Germany to
    // anyone reading the posting: a row whose only geography is a bare two
    // letter code does not vote.
    if (r.weak) continue;
    const key = cityKey(r.city);
    if (!key) continue;
    let e = byKey.get(key);
    if (!e) {
      e = { n: 0, surfaces: new Map(), countries: new Map(), admins: new Map() };
      byKey.set(key, e);
    }
    e.n += 1;
    e.surfaces.set(r.city, (e.surfaces.get(r.city) || 0) + 1);
    e.countries.set(upstream, (e.countries.get(upstream) || 0) + 1);
    if (r.admin1) e.admins.set(`${upstream}|${r.admin1}`, (e.admins.get(`${upstream}|${r.admin1}`) || 0) + 1);
  }

  /** @type {Record<string, { city: string, country: string, admin1: string|null, n: number }>} */
  const out = {};
  for (const key of [...byKey.keys()].sort()) {
    const e = byKey.get(key);
    if (e.n < MIN_ROWS) continue;
    const [country, countryRows] = top(e.countries);
    if (countryRows / e.n < MIN_AGREE) continue;
    let admin1 = null;
    const named = [...e.admins.entries()].filter(([k]) => k.startsWith(country + '|'));
    const namedRows = named.reduce((s, [, n]) => s + n, 0);
    if (namedRows >= MIN_ROWS) {
      const [adminKey, adminRows] = top(new Map(named));
      if (adminRows / namedRows >= MIN_AGREE) admin1 = adminKey.split('|')[1];
    }
    out[key] = { city: top(e.surfaces)[0], country, admin1, n: e.n };
  }
  return out;
}

/** Shuffle rows with the seeded generator and cut off the holdout share. */
/**
 * @template T
 * @param {T[]} rows
 * @returns {{ train: T[], test: T[] }}
 */
export function splitRows(rows, seed = HOLDOUT_SEED, share = HOLDOUT_SHARE) {
  const rand = seeded(seed);
  const order = rows.map((_, i) => [rand(), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cut = Math.round(rows.length * share);
  const held = new Set(order.slice(0, cut).map(([, i]) => i));
  return { train: rows.filter((_, i) => !held.has(i)), test: rows.filter((_, i) => held.has(i)) };
}

/** The same cut, but by distinct location string: no string in the test set
 *  appears in the training set. */
/**
 * @template {{ location?: string|null }} T
 * @param {T[]} rows
 * @returns {{ train: T[], test: T[] }}
 */
export function splitByString(rows, seed = HOLDOUT_SEED, share = HOLDOUT_SHARE) {
  const rand = seeded(seed + 1);
  const strings = [...new Set(rows.map((r) => r.location || ''))].sort();
  const order = strings.map((s) => [rand(), s]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  const held = new Set(order.slice(0, Math.round(strings.length * share)).map(([, s]) => s));
  return {
    train: rows.filter((r) => !held.has(r.location || '')),
    test: rows.filter((r) => held.has(r.location || ''))
  };
}

/**
 * Learn on `train`, blank the country on `test`, and score what placeOf says.
 * `viaText` counts the resolved rows whose country came from the string itself
 * and not from the table, so a high resolve rate cannot hide that the table did
 * nothing.
 */
export function scoreHoldout(train, test) {
  const table = learnCities(train);
  let resolved = 0;
  let right = 0;
  let viaText = 0;
  let contradicted = 0;
  // The rows the string alone cannot place, so only the table can: the case it
  // was built for, and the honest test of it. Most held-out rows name their
  // country and would resolve with no table at all.
  const tableOnly = { n: 0, resolved: 0, right: 0 };
  const wrong = new Map();
  for (const row of test) {
    const truth = isoCountry(row.country);
    const got = placeOf(row.location, null, table);
    const alone = readPlace(row.location, null, {}).country;
    if (!alone) {
      tableOnly.n += 1;
      if (got.country) { tableOnly.resolved += 1; if (got.country === truth) tableOnly.right += 1; }
    }
    if (!got.country) continue;
    resolved += 1;
    if (alone) viaText += 1;
    if (got.country === truth) right += 1;
    else {
      // The upstream code is the answer key here, and it is sometimes the
      // wrong side: when the string itself spells out another country
      // (readPlace's override), the miss is counted as contradicted.
      const against = readPlace(row.location, truth, table).overrode;
      if (against) contradicted += 1;
      const k = `${row.location} => ${got.country} (truth ${truth})${against ? ' [text contradicts upstream]' : ''}`;
      wrong.set(k, (wrong.get(k) || 0) + 1);
    }
  }
  return {
    test: test.length, resolved, right, viaText, contradicted, tableOnly, cities: Object.keys(table).length,
    wrong: [...wrong.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12)
  };
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');

function printHoldout(title, h) {
  console.log(`${title}`);
  console.log(`  held out           ${h.test} rows (table learned on the rest: ${h.cities} cities)`);
  console.log(`  country resolved   ${h.resolved} (${pct(h.resolved, h.test)}), of which ${h.viaText} from the text alone`);
  console.log(`  country correct    ${h.right} of ${h.resolved} resolved (${pct(h.right, h.resolved)}) against the upstream code`);
  console.log(`  of the ${h.resolved - h.right} misses, ${h.contradicted} are rows where the text spells out the other country`);
  const t = h.tableOnly;
  console.log(`  table-only rows    ${t.n} the string alone cannot place; the table placed ${t.resolved} (${pct(t.resolved, t.n)}), ${t.right} correct (${pct(t.right, t.resolved)} of those placed)`);
  if (h.wrong.length) {
    console.log('  most common misses (location => answer, truth):');
    for (const [k, n] of h.wrong) console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
}

async function main() {
  await import('../load-local-env.mjs');
  const { default: pg } = await import('pg');
  const dry = process.argv.includes('--dry-run');
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error('build-place-table: no DATABASE_URL in the environment.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query(
    `SELECT location, country FROM jobs WHERE status <> 'killed' ORDER BY id`
  );
  await client.end();

  const withCountry = rows.filter((r) => isoCountry(r.country));
  console.log(`build-place-table: ${rows.length} live rows, ${withCountry.length} with a valid upstream country`);

  const cities = learnCities(withCountry);
  const keys = Object.keys(cities);
  console.log(`  learned ${keys.length} cities (>= ${MIN_ROWS} rows, >= ${MIN_AGREE * 100}% agreeing on the country)`);
  console.log(`  with a state: ${keys.filter((k) => cities[k].admin1).length}`);

  const byRow = splitRows(withCountry);
  printHoldout(`holdout A: seeded ${HOLDOUT_SEED}, 80/20 by row`, scoreHoldout(byRow.train, byRow.test));
  const byString = splitByString(withCountry);
  printHoldout(`holdout B: 80/20 by DISTINCT STRING, so the test strings were never seen`,
    scoreHoldout(byString.train, byString.test));

  // Overall coverage, with the table learned on every row. Rows that carry an
  // upstream country resolve trivially, so the number that matters is how many
  // of the rest move.
  let upstreamCountry = 0;
  let resolvedAll = 0;
  let resolvedNoUpstream = 0;
  let resolvedByTable = 0;
  let noUpstream = 0;
  let overridden = 0;
  const unresolved = new Map();
  for (const r of rows) {
    const had = Boolean(isoCountry(r.country));
    if (had) upstreamCountry += 1; else noUpstream += 1;
    const p = placeOf(r.location, r.country, cities);
    if (p.country) {
      resolvedAll += 1;
      if (!had) {
        resolvedNoUpstream += 1;
        if (!readPlace(r.location, null, {}).country) resolvedByTable += 1;
      }
    } else {
      unresolved.set(r.location || '', (unresolved.get(r.location || '') || 0) + 1);
    }
    if (had) {
      const t = readPlace(r.location, null, cities);
      if (t.country && t.country !== isoCountry(r.country) && t.parts === 1) overridden += 1;
    }
  }
  console.log('coverage over every live row');
  console.log(`  upstream country   ${upstreamCountry} of ${rows.length} (${pct(upstreamCountry, rows.length)})   <- the baseline`);
  console.log(`  placeOf country    ${resolvedAll} of ${rows.length} (${pct(resolvedAll, rows.length)})`);
  console.log(`  newly resolved     ${resolvedNoUpstream} of the ${noUpstream} rows with no upstream country (${pct(resolvedNoUpstream, noUpstream)}), ${resolvedByTable} of them only because of the learned table`);
  console.log(`  text contradicts upstream on ${overridden} rows with a country (text reads a different one, single place)`);
  const un = [...unresolved.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15);
  console.log('  largest unresolved strings:');
  for (const [s, n] of un) console.log(`    ${String(n).padStart(5)}  ${JSON.stringify(s)}`);

  if (dry) {
    console.log('--dry-run: nothing written.');
    return;
  }
  const doc = {
    _about:
      'City to country (and state) learned from live rows that carry an upstream country: >= ' +
      MIN_ROWS + ' rows, >= ' + MIN_AGREE * 100 + '% agreeing. Built by scripts/build-place-table.mjs; ' +
      'do not edit by hand. n is the number of rows behind the entry.',
    cities
  };
  await writeFile(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
}

// Importable for the tests without touching a database; runs only when invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
