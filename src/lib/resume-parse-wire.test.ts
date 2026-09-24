import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_IMPORT_WIRE_STATUSES,
  isImportWireStatus,
  pollEnds,
  readLanded,
  wireStatusOf,
  type ImportWireStatus
} from './resume-parse-wire';

/**
 * Two halves, and the second one is the point.
 *
 * The first half proves the predicates decide every status. That is cheap and it
 * is not what was missing: ab7b03c updated resume-parse-runner.test.ts with 51
 * new lines and still shipped the bug, because every one of those lines asserted
 * what the SERVER wrote and none asked what a BROWSER would then conclude.
 *
 * The second half is the guard that would have caught it: no client script may
 * hold its own opinion about which statuses mean "stop waiting". Agreement
 * between surfaces, not correctness of one surface.
 */

const REPO = join(import.meta.dirname, '..', '..');

/** The three surfaces that poll the import endpoints. All of them ship a
 *  <script> to the browser, and all three independently hand-wrote the same
 *  whitelist until this test existed. */
const POLLING_SURFACES = [
  'src/pages/profile.astro',
  'src/components/come-ready/StepResume.astro',
  'src/components/come-ready/StepLetter.astro'
];

/** Everything inside <script> ... </script> in an .astro file: the half that
 *  runs in the browser. The frontmatter above it is server code and is allowed
 *  to compare a DATABASE row's status (ParseStatus) to a literal, which is a
 *  different and narrower vocabulary. */
function clientScript(path: string): string {
  const source = readFileSync(isAbsolute(path) ? path : join(REPO, path), 'utf8');
  const blocks = source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g);
  return Array.from(blocks, (m) => m[1]).join('\n');
}

describe('the import wire vocabulary', () => {
  it('decides every status it can carry, under both questions', () => {
    // A table rather than a loop over the predicates, so the EXPECTED answers are
    // written down independently of the code that produces them.
    const expected: Record<ImportWireStatus, { pollEnds: boolean; readLanded: boolean }> = {
      none: { pollEnds: true, readLanded: true },
      ready: { pollEnds: true, readLanded: true },
      'signed-out': { pollEnds: true, readLanded: false },
      pending: { pollEnds: false, readLanded: false },
      started: { pollEnds: false, readLanded: false }
    };

    for (const status of ALL_IMPORT_WIRE_STATUSES) {
      expect(pollEnds(status), `pollEnds(${status})`).toBe(expected[status].pollEnds);
      expect(readLanded(status), `readLanded(${status})`).toBe(expected[status].readLanded);
    }

    // And the table covers the union exactly — no member added to the type
    // without a decision recorded here.
    expect(Object.keys(expected).sort()).toEqual([...ALL_IMPORT_WIRE_STATUSES].sort());
  });

  it("treats 'none' as a landed read, because a read that lands deletes its own row", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE FOUR-DAY OUTAGE.
    // resume-parse-runner.ts calls clearParse immediately after
    // applyParsedProposals, so by the time any 3-second poll fires, the row is
    // gone and the endpoint answers 'none'. A poller that reads 'none' as
    // "still working" waits until its own limit and then blames the read.
    expect(readLanded('none')).toBe(true);
    expect(pollEnds('none')).toBe(true);
  });

  it("does not mistake 'signed-out' for success", () => {
    expect(pollEnds('signed-out')).toBe(true);
    expect(readLanded('signed-out')).toBe(false);
  });

  it('narrows a real response and refuses anything else', () => {
    expect(wireStatusOf({ status: 'none' })).toBe('none');
    expect(wireStatusOf({ status: 'ready', hasSomething: true })).toBe('ready');
    // The redirect-to-HTML case: fetch follows the gate's 302, response.ok is
    // true, and the body is a sign-in page. Not a network fault.
    expect(wireStatusOf('<!doctype html><title>Sign in</title>')).toBeNull();
    expect(wireStatusOf({ status: 'invented-later' })).toBeNull();
    expect(wireStatusOf(null)).toBeNull();
    expect(isImportWireStatus('failed')).toBe(false);
  });
});

describe('every polling surface defers to that vocabulary', () => {
  // This is the regression guard. It fails on any client script that decides for
  // itself what the server's success values are — which is how one server commit
  // was able to break three browser surfaces at once without touching them.

  it.each(POLLING_SURFACES)('%s imports the shared predicates', (surface) => {
    expect(clientScript(surface)).toMatch(/from ['"][^'"]*resume-parse-wire['"]/);
  });

  it.each(POLLING_SURFACES)('%s hand-writes no status literal', (surface) => {
    const script = clientScript(surface);
    const handWritten = Array.from(
      script.matchAll(/\bstatus\s*(?:===|!==|==|!=)\s*['"]([a-z-]+)['"]/g),
      (m) => m[0].trim()
    );
    expect(
      handWritten,
      `${surface} compares a wire status to a literal. Use pollEnds/readLanded from ` +
        'src/lib/resume-parse-wire.ts instead, so the next status the server invents is a ' +
        'compile error and not a two-minute hang.'
    ).toEqual([]);
  });

  it('and no NEW surface starts hand-writing a status vocabulary', () => {
    // A repo-wide census rather than a check of the three files above, because
    // the failure being guarded against is a FOURTH surface appearing. Scoping
    // this to a remembered list is how there came to be three copies of one
    // whitelist in the first place.
    //
    // One recorded exception. DraftRail speaks a different contract — the draft
    // render's own 'pending' | 'ready' | 'failed', from
    // desk/job-draft/[slug]/status.ts — and it is structurally safe in the way
    // this module had to be made safe: it ends its wait on NOT-pending
    // (`stillPending(state)`) rather than on a list of success values, so a
    // status invented tomorrow stops it correctly instead of stranding it. Its
    // literals decide what to DISPLAY, never when to stop. If that endpoint ever
    // grows a fourth status, give it its own wire module rather than deleting
    // this line.
    const ALLOWED = ['src/components/job-detail/DraftRail.astro'];

    const handWriters = ['src/pages', 'src/components']
      .flatMap((dir) => walk(join(REPO, dir)))
      .filter((file) => file.endsWith('.astro'))
      .filter((file) => /\bstatus\s*(?:===|!==|==|!=)\s*['"][a-z-]+['"]/.test(clientScript(file)))
      .map((file) => file.slice(REPO.length + 1));

    expect(handWriters.sort()).toEqual([...ALLOWED].sort());
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
