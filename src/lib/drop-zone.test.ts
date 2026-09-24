import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * drop-zone.ts exists so that dropping a file behaves the same way everywhere.
 * It did not, for as long as /profile carried its own copy of the handlers:
 *
 *   - the shared helper counts drag depth, because dragging over a child of the
 *     band fires dragleave on the band. /profile's copy toggled the wash off, so
 *     the box went dark the moment the pointer crossed the arrow, the heading,
 *     the hint or the chip — while the file was still over it.
 *   - the shared helper handles dragenter; /profile's copy did not.
 *   - neither guarded a MISS until now. A file dropped beside the box is a
 *     navigation: the browser leaves for the file and takes the reader's
 *     half-filled form with it.
 *
 * Three copies of one protocol is what put /profile four days behind on the
 * import status vocabulary as well (see resume-parse-wire.test.ts). This is the
 * same guard for the same disease: there is one implementation, and a client
 * script that touches DataTransfer has to be using it.
 */

const REPO = join(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function clientScript(absolutePath: string): string {
  const source = readFileSync(absolutePath, 'utf8');
  return Array.from(
    source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    (match) => match[1]
  ).join('\n');
}

describe('dropping a file is implemented once', () => {
  it('every client script that touches a file drop uses the shared helper', () => {
    const handRolled = ['src/pages', 'src/components']
      .flatMap((dir) => walk(join(REPO, dir)))
      .filter((file) => file.endsWith('.astro'))
      .map((file) => ({ file: file.slice(REPO.length + 1), script: clientScript(file) }))
      // A script that reads dataTransfer, or listens for a drag event, is doing
      // drop handling of its own.
      .filter(({ script }) => /dataTransfer|addEventListener\(\s*['"]drag/.test(script))
      .filter(({ script }) => !/from ['"][^'"]*drop-zone['"]/.test(script))
      .map(({ file }) => file);

    expect(
      handRolled,
      'These client scripts handle a file drop without wireDropZone from ' +
        'src/lib/drop-zone.ts. A second copy drifts: /profile\'s did, and its ' +
        'drop target went dark while a file was over it.'
    ).toEqual([]);
  });

  it('the helper guards a drop that misses the band', () => {
    // Asserted against the source rather than a DOM, because vitest runs in node
    // here and the whole point of the guard is a document-level listener. The
    // browser sweep exercises the behaviour; this only ensures the guard is not
    // quietly deleted as dead code, which is what it looks like on a read.
    const source = readFileSync(join(REPO, 'src/lib/drop-zone.ts'), 'utf8');
    expect(source).toMatch(/document\.addEventListener\(\s*['"]dragover['"]/);
    expect(source).toMatch(/document\.addEventListener\(\s*['"]drop['"]/);
  });
});
