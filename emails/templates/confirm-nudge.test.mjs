import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTokens } from '../lib/tokens.mjs';
import { typeRoles } from '../lib/shell.mjs';
import { buildConfirmNudge } from './confirm-nudge.mjs';
import { SITE } from '../../src/data/site.ts';

/**
 * Exercises the real confirm-loop nudge template through the real compiled
 * tokens at src/styles/tokens.css. Nothing is mocked: the template reads no
 * database and mints no URL, so the sender's inputs are the whole surface.
 */
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const t = loadTokens(resolve(REPO, 'src/styles/tokens.css'));
const roles = typeRoles(t);
const deskUrl = 'https://tokenstoagents.ai/jobs/desk';

// The house forbids these characters in source; a test asserting their absence
// must not write one, so they are built from code points. Mirrors the same
// guard in weekly-digest.test.mjs.
const FORBIDDEN = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d].map((cp) => String.fromCodePoint(cp));
function assertClean(text) {
  for (const ch of FORBIDDEN) {
    expect(text.includes(ch), `found forbidden character ${JSON.stringify(ch)}`).toBe(false);
  }
}

describe('buildConfirmNudge', () => {
  it('names one role in the singular and links the Desk', () => {
    const out = buildConfirmNudge({
      t,
      roles,
      site: SITE,
      pending: [{ title: 'Staff Product Designer', company: 'Ambience', days: 5 }],
      deskUrl
    });
    expect(out.subject).toBe('One application to confirm on your Desk');
    expect(out.html).toContain('Staff Product Designer');
    expect(out.html).toContain('Ambience');
    expect(out.html).toContain(deskUrl);
    expect(out.text).toContain('Staff Product Designer');
    expect(out.text).toContain(deskUrl);
    assertClean(out.html);
    assertClean(out.text);
  });

  it('counts in the plural and lists every pending role', () => {
    const out = buildConfirmNudge({
      t,
      roles,
      site: SITE,
      pending: [
        { title: 'Design Lead', company: 'Commure', days: 2 },
        { title: 'Brand Designer', company: 'Decagon', days: 9 }
      ],
      deskUrl
    });
    expect(out.subject).toBe('2 applications to confirm on your Desk');
    expect(out.text).toContain('Design Lead');
    expect(out.text).toContain('Brand Designer');
    assertClean(out.html);
    assertClean(out.text);
  });

  it('falls back gracefully when a snapshot title or company is missing', () => {
    const out = buildConfirmNudge({
      t,
      roles,
      site: SITE,
      pending: [{ title: null, company: null, days: 1 }],
      deskUrl
    });
    // A null title becomes a plain "A role" rather than an empty line, and the
    // one-day case reads "yesterday" rather than "1 days ago".
    expect(out.text).toContain('A role');
    expect(out.text).toContain('yesterday');
    assertClean(out.html);
    assertClean(out.text);
  });
});
