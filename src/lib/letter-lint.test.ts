import { describe, expect, it } from 'vitest';
import { lintLetter, countBuzzwords } from './letter-lint';

// letter-lint.ts ports the cover-letter skill's mechanical checks. Its buzzword
// tells are the skill's own list (spearheaded, orchestrated, and the rest),
// none of which is a copy-gate-banned word, so they can be written here as
// literals; the copy gate scans this file and would flag one that was.
const TELLS = ['spearheaded', 'orchestrated', 'championed', 'unwavering'];

function hasFail(text: string, rule: string): boolean {
  return lintLetter(text).some((f) => f.level === 'fail' && f.rule === rule);
}
function hasWarn(text: string, rule: string): boolean {
  return lintLetter(text).some((f) => f.level === 'warn' && f.rule === rule);
}

// A clean letter of normal length: no stock opener, no dashes, no placeholders,
// no banned words, varied sentences. Long enough to clear the hard length floor.
const CLEAN = [
  'I am applying for the product design role on your team.',
  'You asked for someone who has shipped a checkout flow, and I have.',
  'At my last company I owned that flow from the first sketch through launch.',
  'It lifted conversion over the prior version, and I stayed to tune it.',
  'I care about clear type, fast pages, and copy a reader can actually follow.',
  'I test with real people early, because a hunch is cheaper to kill on paper.',
  'Your posting reads like a team that ships and then listens, which is how I like to work.',
  'I would bring the same habit of small, honest steps to the role.',
  'I write plainly, I show my work, and I ask before I assume.',
  'I would welcome a short call to walk through two of these projects with you.',
  'Thank you for reading, and I hope the timing lines up on your end.',
  'Either way, I admire what your group has put out this year and last.'
].join(' ');

describe('lintLetter(): the mechanical style checks', () => {
  it('a clean letter of normal length raises no fail-level finding', () => {
    expect(lintLetter(CLEAN).some((f) => f.level === 'fail')).toBe(false);
  });

  it('a very short letter fails the length rule', () => {
    expect(hasFail('I want the job. Please hire me.', 'length')).toBe(true);
  });

  it('a stock opening phrase fails', () => {
    expect(hasFail('I am writing to apply for the open role at your company.', 'stock-opener')).toBe(true);
  });

  it('"to whom it may concern" fails the salutation rule', () => {
    expect(hasFail('To whom it may concern, I would like the job.', 'salutation')).toBe(true);
  });

  it('four buzzword tells fail', () => {
    const text = `I ${TELLS[0]} the launch, ${TELLS[1]} the team, ${TELLS[2]} the effort with ${TELLS[3]} focus.`;
    expect(countBuzzwords(text)).toBeGreaterThanOrEqual(4);
    expect(hasFail(text, 'buzzwords')).toBe(true);
  });

  it('two buzzword tells warn rather than fail', () => {
    const text = `I ${TELLS[0]} the launch and ${TELLS[1]} the team next quarter with real care.`;
    expect(hasWarn(text, 'buzzwords')).toBe(true);
    expect(hasFail(text, 'buzzwords')).toBe(false);
  });

  it('an em dash fails the dash rule', () => {
    const emDash = String.fromCodePoint(0x2014);
    expect(hasFail(`I did the work${emDash}and then some more of it.`, 'dash')).toBe(true);
  });

  it('an en dash fails the dash rule', () => {
    const enDash = String.fromCodePoint(0x2013);
    expect(hasFail(`I worked there 2019${enDash}2021 on the design team.`, 'dash')).toBe(true);
  });

  it('placeholder residue fails', () => {
    expect(hasFail('Dear [Company] team, I would like the [Role] position.', 'placeholder')).toBe(true);
  });

  it('a weak verb warns', () => {
    expect(hasWarn('I was responsible for the design of the checkout page.', 'weak-verb')).toBe(true);
  });

  it('generic enthusiasm warns', () => {
    expect(hasWarn('This is my dream job and it would be a perfect fit for me.', 'generic-enthusiasm')).toBe(true);
  });
});
