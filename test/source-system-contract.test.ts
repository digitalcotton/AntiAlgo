import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDataContract, systemOfHost, type ContractDocs } from '../src/lib/data-contract';
import realJobs from '../src/data/jobs.json';
import realKills from '../src/data/kills.json';
import realKillArchive from '../src/data/kills-archive.json';
import realStats from '../src/data/stats.json';
import realFacts from '../src/data/facts.json';
import realProspects from '../src/data/prospects.json';

/**
 * source_system is one fact kept in four lists, and nothing compared any two of
 * them until 2026-10-01.
 *
 * Two of the four are here: the SourceSystem union in data.ts, which decides
 * what the site will compile and label, and ATS_HOSTS in data-contract.ts, which
 * decides what the site will *believe* — it proves a row's claimed system
 * against the host its links actually go to, and refuses the build where the two
 * disagree. The other two are on the mini, in export-site-data.py:
 * SITE_SOURCE_SYSTEMS, the names it will send, and its own ATS_HOSTS, the host
 * table it labels rows by. The mini's tests/test_source_system_contract.py holds
 * that pair against this one; it can, because the mini has both checkouts.
 *
 * This file holds this repository's half, which is the half that can be checked
 * without reaching across a machine:
 *
 *   - the two lists here agree with each other, and
 *   - the runtime gate accepts exactly the systems ATS_HOSTS proves.
 *
 * WHY THE SECOND ONE IS NOT A RESTATEMENT OF THE FIRST. The union is a type and
 * is gone by the time the site runs; ATS_HOSTS is a runtime table. A name can sit
 * in the union, compile everywhere, carry a label in SOURCE_LABELS, and still be
 * a name this site refuses to serve, because no host in ATS_HOSTS proves it and
 * assertSourceSystems treats "claims a system, and no link supports it" as a
 * stopped build. `lever` is exactly that today: the union names it, the label map
 * names it, and a single row labelled `lever` would refuse the whole build. That
 * is not a bug to paper over — it is the gate doing its job — but it is the kind
 * of fact that has to be written down in a test rather than discovered at 03:30.
 *
 * WHY THESE READ THE SOURCE AS TEXT. Both lists are unreachable at runtime: the
 * union is erased by the compiler and ATS_HOSTS is module-private. The honest way
 * to compare them is to read the two literals out of the files — and then to
 * check the parse itself against the exported systemOfHost, so a regex that
 * quietly matched nothing fails here instead of turning the whole file green.
 * A contract test that keeps its own copy of the lists is just a fifth copy.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The (system, suffix) pairs out of data-contract.ts's ATS_HOSTS literal. */
function atsHosts(): Array<{ system: string; suffix: string }> {
  const text = read('../src/lib/data-contract.ts');
  const block = /\bATS_HOSTS\b[^=]*=\s*\[(.*?)\]\s*;/s.exec(text);
  const pairs = [...(block?.[1] ?? '').matchAll(/system:\s*'([^']+)'\s*,\s*suffix:\s*'([^']+)'/g)];
  return pairs.map(([, system, suffix]) => ({ system, suffix }));
}

/**
 * The NAMED members of the SourceSystem union.
 *
 * The union ends in `| (string & {})` on purpose, so a board the site has not
 * named yet is still assignable rather than being coerced to 'custom'. That
 * widening is why this reads the named members only: they are the ones the label
 * map and the three literal comparisons in this repository actually know about.
 */
function namedSystems(): string[] {
  const text = read('../src/lib/data.ts');
  const block = /export type SourceSystem\s*=(.*?);/s.exec(text);
  return [...(block?.[1] ?? '').matchAll(/\|\s*'([^']+)'/g)].map(([, name]) => name);
}

/** The keys of data.ts's SOURCE_LABELS, which is what a reader is shown. */
function labelledSystems(): string[] {
  const text = read('../src/lib/data.ts');
  const block = /const SOURCE_LABELS: Record<string, string> = \{(.*?)\};/s.exec(text);
  return [...(block?.[1] ?? '').matchAll(/^\s*([A-Za-z_][\w]*):/gm)].map(([, key]) => key);
}

/** The pair of labels that describe the absence of an ATS rather than one of them. */
const NO_ATS = ['custom', 'founder_post'] as const;

const HOSTS = atsHosts();
const NAMED = namedSystems();
const LABELLED = labelledSystems();

describe('the source-system lists in this repository describe one thing', () => {
  // Before anything is compared, the readings have to be worth comparing. A
  // regex that matched nothing would make every assertion below trivially true,
  // which is the precise shape of the failure that cost five nights: a check
  // that passes because it measured nothing.
  it('reads all three lists out of the source, and none of them come back empty', () => {
    expect(HOSTS.length).toBeGreaterThan(0);
    expect(NAMED.length).toBeGreaterThan(0);
    expect(LABELLED.length).toBeGreaterThan(0);
  });

  it('agrees with the runtime about what each host proves, so the parse can be trusted', () => {
    for (const { system, suffix } of HOSTS) {
      expect(systemOfHost(`https://${suffix}/role/1`), suffix).toBe(system);
      expect(systemOfHost(`https://boards.${suffix}/role/1`), suffix).toBe(system);
    }
  });

  it('names every system it has a host for, so a proven row is also a compilable one', () => {
    const unnamed = HOSTS.map((h) => h.system).filter((s) => !NAMED.includes(s));
    expect(unnamed, 'ATS_HOSTS proves a system the SourceSystem union does not name').toEqual([]);
  });

  it('has a reader-facing label for every system it names', () => {
    // atsLabel falls back to the key, title-cased, so a missing entry does not
    // render as undefined — it renders as a guess. 'successfactors' would come
    // out "Successfactors". The union and the label map are two lists of one
    // fact and belong in step.
    expect(NAMED.filter((s) => !LABELLED.includes(s))).toEqual([]);
    expect(LABELLED.filter((s) => !NAMED.includes(s))).toEqual([]);
  });

  it('keeps both absence labels unproven by any host, because they deny an ATS', () => {
    for (const label of NO_ATS) {
      expect(NAMED).toContain(label);
      expect(HOSTS.map((h) => h.system)).not.toContain(label);
    }
  });
});

/**
 * The gate itself, against the real documents.
 *
 * Same reasoning as data-contract.test.ts: a fixture consistent enough to reach
 * assertConsistent is a copy of src/data anyway, so these clone the real files
 * and change the one row under test. The clock is pinned for the whole suite by
 * vitest.config.ts to the instant stats.json records, so freshness never decides
 * the outcome of a test about labels.
 */
describe('the runtime gate accepts a system exactly when a link proves it', () => {
  const docs = (): ContractDocs => ({
    jobs: structuredClone(realJobs) as unknown as ContractDocs['jobs'],
    kills: structuredClone(realKills) as unknown as ContractDocs['kills'],
    killArchive: structuredClone(realKillArchive) as unknown as ContractDocs['killArchive'],
    stats: structuredClone(realStats) as unknown as ContractDocs['stats'],
    facts: structuredClone(realFacts) as unknown as ContractDocs['facts'],
    prospects: structuredClone(realProspects) as unknown as ContractDocs['prospects']
  });

  /** The real documents with one row relabelled and repointed, and nothing else touched. */
  function withRow(system: string, url: string): ContractDocs {
    const built = docs();
    const rows = (built.jobs as { jobs: Record<string, unknown>[] }).jobs;
    rows[0] = { ...rows[0], source_system: system, source_url: url, apply_url: url };
    return built;
  }

  // A host no table in this repository proves. Asserted rather than assumed: if
  // a future ATS_HOSTS entry ever swallowed this domain, every "unproven host"
  // case below would start passing for the wrong reason.
  const NOWHERE = 'https://careers.example.com/jobs/1';

  it('is reading real rows, so these cases are not asserting over an empty list', () => {
    const rows = (docs().jobs as { jobs: unknown[] }).jobs;
    expect(rows.length).toBeGreaterThan(0);
    expect(systemOfHost(NOWHERE)).toBeNull();
    expect(() => assertDataContract(docs())).not.toThrow();
  });

  it('accepts each proven system when both links are on the host that proves it', () => {
    for (const { system, suffix } of HOSTS) {
      expect(() => assertDataContract(withRow(system, `https://boards.${suffix}/role/1`)), system).not.toThrow();
    }
  });

  it('refuses a proven system whose links are on a different board', () => {
    const [first, ...rest] = HOSTS;
    const other = rest.find((h) => h.system !== first.system);
    expect(other, 'ATS_HOSTS needs two distinct systems for this case to mean anything').toBeDefined();
    expect(() => assertDataContract(withRow(first.system, `https://boards.${other!.suffix}/role/1`))).toThrow(
      /disagrees with its source_system/
    );
  });

  it('refuses a proven system whose links are on no board at all', () => {
    // The openai.com case that put this gate here in the first place: a record
    // labelled with an ATS over a link to the company's own site.
    for (const { system } of HOSTS) {
      expect(() => assertDataContract(withRow(system, NOWHERE)), system).toThrow(
        /is not on any board this site knows/
      );
    }
  });

  it('accepts the absence labels on an unproven host and refuses them on an ATS host', () => {
    for (const label of NO_ATS) {
      expect(() => assertDataContract(withRow(label, NOWHERE)), label).not.toThrow();
      expect(() => assertDataContract(withRow(label, `https://boards.${HOSTS[0].suffix}/role/1`)), label).toThrow(
        /says it is not on a board at all/
      );
    }
  });

  /**
   * The finding this file exists to write down.
   *
   * A system the union names and ATS_HOSTS does not prove cannot be served at
   * all: every URL is either on some other board or on none, and both of those
   * refuse. So `lever`, `rippling`, `workday` and the rest are names this site
   * can compile, label and sort by, and cannot accept a single row of.
   *
   * That matters for the twin lists on the mini. The export refuses those boards
   * today at SITE_SOURCE_SYSTEMS, which is loud and recoverable. Adding the name
   * there WITHOUT adding the host to both ATS_HOSTS tables does not fix it — it
   * relabels those rows 'custom', which this gate accepts, and the page then
   * prints "Apply on the company site" over a Lever link. The fix is four edits,
   * two per repository: the name and the host, on each side.
   */
  it('cannot serve a system it names but has no host for, so naming one is never the whole fix', () => {
    const unprovable = NAMED.filter(
      (s) => !NO_ATS.includes(s as (typeof NO_ATS)[number]) && !HOSTS.some((h) => h.system === s)
    );
    // The loop below asserts nothing if this list is empty, so the list is
    // checked first: a case that passes by iterating over nothing is the failure
    // mode this whole file was written against. If every named system has a host
    // one day, that is good news and this case should be deleted, not widened.
    expect(
      unprovable.length,
      'no named system is missing a host any more, so the loop below would assert nothing — delete this case'
    ).toBeGreaterThan(0);

    for (const system of unprovable) {
      expect(() => assertDataContract(withRow(system, NOWHERE)), system).toThrow(
        /is not on any board this site knows/
      );
      expect(() => assertDataContract(withRow(system, `https://boards.${HOSTS[0].suffix}/role/1`)), system).toThrow(
        /disagrees with its source_system/
      );
    }
  });
});
