/**
 * ingest-replace-lock.test.mjs: the nightly replace must not take a lock a
 * reader waits for.
 *
 * WHY A TEST OF THE SOURCE TEXT. scripts/ingest-jobs.mjs does its work at
 * import, so no statement in it can be reached from a test, and what this
 * guards is a property of which statements it sends, not of a value it
 * computes. The behaviour itself was measured against a real database on
 * 2026-10-02 and the numbers are at the statement in that file; this test is
 * the cheap half that keeps the measurement from being undone by an edit that
 * looks harmless.
 *
 * THE EDIT IT EXISTS TO STOP. --replace used to TRUNCATE jobs after an explicit
 * LOCK TABLE ... ACCESS EXCLUSIVE, and every read of the board waited from the
 * lock to the COMMIT: about 34 s once db/219's search trigger made each inserted
 * row compute its vector, on a site that is serving during the build. The
 * obvious fix, swapping TRUNCATE for DELETE, does nothing on its own: measured
 * with the lock left as it was, a reader still waited 48 s, because the explicit
 * lock is what shuts the board and the TRUNCATE was only the next statement
 * under it. So the guard asks for the pair, and for the VACUUM after the commit
 * that a DELETE needs and a TRUNCATE did not.
 *
 * WHAT IT DOES NOT PROVE. That Postgres behaves as measured. That is the probe
 * run recorded in the file, and re-running it is the way to check it again.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('../scripts/ingest-jobs.mjs', import.meta.url);

/** The executable text of a script: block comments, whole-line comments and
 *  trailing `// ...` comments removed, because the file explains itself at length
 *  and says TRUNCATE and ACCESS EXCLUSIVE in doing so. */
export function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '');
}

/** What is wrong with a replace, as sentences. Empty means it holds. */
export function problems(source) {
  const code = codeOf(source);
  const found = [];
  const at = (needle) => code.indexOf(needle);

  if (/\bTRUNCATE\b/i.test(code)) {
    found.push('sends TRUNCATE, which takes ACCESS EXCLUSIVE and holds every read of the board until the COMMIT');
  }
  if (/ACCESS EXCLUSIVE/i.test(code)) {
    found.push('asks for ACCESS EXCLUSIVE, which every SELECT on jobs waits for; the weakest lock that keeps other writers out is SHARE ROW EXCLUSIVE');
  }
  const lock = at("LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE");
  const del = at("DELETE FROM jobs");
  if (lock === -1) found.push('never takes LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE, so the floor reads a count a rival can still change');
  if (del === -1) found.push('never sends DELETE FROM jobs, so nothing clears the old board');
  if (lock !== -1 && del !== -1) {
    // The real load's floor read passes the transaction's client; the dry run's
    // passes its own probe connection, so this tells them apart.
    const floorRead = at('await readBaselines(client)');
    if (!(lock < floorRead && floorRead < del)) {
      found.push('does not take the lock, then read the floor, then delete, in that order');
    }
  }
  const commit = at("client.query('COMMIT')");
  // The call, not the definition: the function is declared above the transaction
  // and would always sit before the COMMIT in the text.
  const tidy = at('await tidyAfterReplace(client)');
  if (tidy === -1) found.push('never runs the housekeeping VACUUM, so last night\'s rows stay in the table');
  else if (commit === -1 || tidy < commit) found.push('runs the housekeeping VACUUM before the COMMIT, where VACUUM is refused and the dead rows are not yet dead');
  return found;
}

describe('the nightly replace in scripts/ingest-jobs.mjs', () => {
  it('holds no lock a reader waits for, and vacuums after the commit', () => {
    expect(problems(readFileSync(SCRIPT, 'utf8'))).toEqual([]);
  });

  // The guard is only worth having if it fails on the shapes it exists for.
  describe('and the guard itself refuses', () => {
    const good = `
      await client.query('BEGIN');
      await client.query('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');
      const verdict = floorVerdict({ ...(await readBaselines(client)) });
      await client.query('DELETE FROM jobs');
      await client.query('COMMIT');
      if (REPLACE) await tidyAfterReplace(client);`;

    it('passes the shape it wants', () => {
      expect(problems(good)).toEqual([]);
    });

    it('the old shape: TRUNCATE under ACCESS EXCLUSIVE', () => {
      const old = good
        .replace('SHARE ROW EXCLUSIVE', 'ACCESS EXCLUSIVE')
        .replace('DELETE FROM jobs', 'TRUNCATE jobs');
      expect(problems(old).length).toBeGreaterThanOrEqual(3);
    });

    it('the swap that measured as a no-op: DELETE under the old lock', () => {
      const naive = good.replace('SHARE ROW EXCLUSIVE', 'ACCESS EXCLUSIVE');
      const found = problems(naive);
      expect(found.join('\n')).toMatch(/ACCESS EXCLUSIVE/);
      expect(found.join('\n')).toMatch(/never takes LOCK TABLE jobs IN SHARE ROW EXCLUSIVE/);
    });

    it('a VACUUM before the commit', () => {
      const early = good.replace(
        "await client.query('COMMIT');\n      if (REPLACE) await tidyAfterReplace(client);",
        "if (REPLACE) await tidyAfterReplace(client);\n      await client.query('COMMIT');"
      );
      expect(problems(early).join('\n')).toMatch(/before the COMMIT/);
    });

    it('no VACUUM at all', () => {
      expect(problems(good.replace('if (REPLACE) await tidyAfterReplace(client);', '')).join('\n')).toMatch(/never runs the housekeeping/);
    });

    it('a delete before the lock', () => {
      const wrong = good.replace(
        "await client.query('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');",
        "await client.query('DELETE FROM jobs');\n      await client.query('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');"
      ).replace("      await client.query('DELETE FROM jobs');\n      await client.query('COMMIT');", "      await client.query('COMMIT');");
      expect(problems(wrong).join('\n')).toMatch(/in that order/);
    });

    it('does not mind the words in a comment', () => {
      const commented = `/* TRUNCATE and ACCESS EXCLUSIVE, explained */\n// TRUNCATE jobs\n${good}\nawait x(); // ACCESS EXCLUSIVE here too`;
      expect(problems(commented)).toEqual([]);
    });
  });
});
