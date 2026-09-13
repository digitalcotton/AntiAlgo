import { describe, expect, it } from 'vitest';
import {
  sanitizeExportText,
  detectHostileCharacters,
  foldHygiene,
  EMPTY_HYGIENE_SUMMARY,
  type HygieneResult
} from './hygiene';

// hygiene.ts is the gate's own instrument now, not a filter over anyone's
// document: RUN-FINISH.md section 2.2, "we are not the police." Its
// functions are tested here exactly as before, because the functions
// themselves are unchanged; what changed is who calls them (test/gates/
// fabrication.mjs, never record.ts, tailor.ts, or voice.ts; see
// hygiene.ts's own header). These tests are written in the voice of
// record.test.ts: adversarial, and every hostile character built from a
// numeric code point via String.fromCodePoint, never typed as a literal,
// because gate 3 (test/gates/copy.mjs) hard fails on an unusual character
// appearing literally anywhere in this repository's own source.

function cp(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

describe('clean text: nothing found, nothing changed', () => {
  it('passes ordinary prose through unchanged and reports clean: true', () => {
    const result = sanitizeExportText('Shipped the checkout redesign. Cut page weight by half.');
    expect(result.text).toBe('Shipped the checkout redesign. Cut page weight by half.');
    expect(result.findings).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it('leaves tab, line feed and carriage return alone', () => {
    const input = 'One\tTwo\nThree\r\nFour';
    const result = sanitizeExportText(input);
    expect(result.text).toBe(input);
    expect(result.clean).toBe(true);
  });
});

describe('STRIPPED: zero-width and invisible spacing characters (plausibly accidental)', () => {
  it('strips a zero-width space (U+200B) from inside a word, and reports it', () => {
    const hostile = 'Managed the' + cp(0x200b) + ' migration';
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('Managed the migration');
    expect(result.clean).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].action).toBe('stripped');
    expect(result.findings[0].category).toBe('zero_width_or_invisible');
    expect(result.findings[0].count).toBe(1);
    expect(result.findings[0].message.length).toBeGreaterThan(0);
  });

  it('strips a left-to-right mark, a right-to-left mark, word joiners, invisible separators, and a byte order mark, all in one pass', () => {
    const hostile =
      'Led the team' +
      cp(0x200e) + // left-to-right mark
      cp(0x200f) + // right-to-left mark
      cp(0x2060) + // word joiner
      cp(0x2063) + // invisible separator
      cp(0xfeff) + // byte order mark
      '.';
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('Led the team.');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('zero_width_or_invisible');
    expect(result.findings[0].count).toBe(5);
  });
});

describe('STRIPPED: control characters (plausibly accidental)', () => {
  it('strips a stray NUL and other C0 controls, leaving ordinary whitespace alone', () => {
    const hostile = 'Cut costs' + cp(0x0000) + cp(0x000b) + ' by half.\n';
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('Cut costs by half.\n');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].action).toBe('stripped');
    expect(result.findings[0].category).toBe('control_characters');
    expect(result.findings[0].count).toBe(2);
  });

  it('strips a C1 control character', () => {
    const hostile = 'Wrote the runbook' + cp(0x0085) + '.';
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('Wrote the runbook.');
    expect(result.findings[0].category).toBe('control_characters');
  });
});

describe('REFUSED: bidirectional override controls (can only be deliberate)', () => {
  it('refuses a right-to-left override and reports it distinctly from a strip', () => {
    const hostile = 'Staff Designer' + cp(0x202e) + 'reegnE PV' + cp(0x202c);
    const result = sanitizeExportText(hostile);
    expect(result.text).not.toContain(cp(0x202e));
    expect(result.text).not.toContain(cp(0x202c));
    expect(result.text).toBe('Staff DesignerreegnE PV');
    const finding = result.findings.find((f) => f.category === 'bidi_override');
    expect(finding).toBeDefined();
    expect(finding?.action).toBe('refused');
    expect(finding?.count).toBe(2);
  });

  it('refuses a left-to-right embedding and a pop directional formatting mark', () => {
    const hostile = cp(0x202a) + 'hidden' + cp(0x202c);
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('hidden');
    expect(result.findings[0].category).toBe('bidi_override');
    expect(result.findings[0].action).toBe('refused');
  });
});

describe('REFUSED: Unicode tag characters (can only be deliberate)', () => {
  it('refuses a run of tag characters spelling a hidden instruction', () => {
    // U+E0061 = TAG LATIN SMALL LETTER A, etc. This spells "hi" in tag
    // characters, entirely invisible when rendered by anything that does
    // not specifically decode the tag block.
    const hostile = 'Genuine bullet text' + cp(0xe0068) + cp(0xe0069);
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('Genuine bullet text');
    const finding = result.findings.find((f) => f.category === 'unicode_tag_characters');
    expect(finding).toBeDefined();
    expect(finding?.action).toBe('refused');
    expect(finding?.count).toBe(2);
  });

  it('refuses a tag character at the boundary of the block', () => {
    const hostile = 'x' + cp(0xe0000) + 'y' + cp(0xe007f);
    const result = sanitizeExportText(hostile);
    expect(result.text).toBe('xy');
    expect(result.findings[0].category).toBe('unicode_tag_characters');
  });
});

describe('multiple categories in one string: every one is found and reported', () => {
  it('reports one finding per category, not one finding per character', () => {
    const hostile =
      'Bullet' + cp(0x200b) + ' text' + cp(0x202e) + 'reversed' + cp(0x202c) + cp(0xe0068);
    const result = sanitizeExportText(hostile);
    expect(result.findings).toHaveLength(3);
    const categories = result.findings.map((f) => f.category).sort();
    expect(categories).toEqual(['bidi_override', 'unicode_tag_characters', 'zero_width_or_invisible']);
  });
});

describe('idempotent: running it twice changes nothing the second time', () => {
  it('the second pass over already-cleaned text finds nothing', () => {
    const hostile = 'Bullet' + cp(0x200b) + cp(0x202e) + cp(0xe0068) + ' text';
    const first = sanitizeExportText(hostile);
    const second = sanitizeExportText(first.text);
    expect(second.text).toBe(first.text);
    expect(second.findings).toEqual([]);
    expect(second.clean).toBe(true);
  });

  it('is idempotent on already-clean ordinary text too', () => {
    const clean = 'Nothing hostile here.';
    const first = sanitizeExportText(clean);
    const second = sanitizeExportText(first.text);
    expect(second).toEqual(first);
  });
});

describe('foldHygiene(): combining results across a whole render', () => {
  it('starts clean and stays clean when nothing is found', () => {
    const summary = foldHygiene(EMPTY_HYGIENE_SUMMARY, sanitizeExportText('clean text'));
    expect(summary).toEqual(EMPTY_HYGIENE_SUMMARY);
  });

  it('accumulates findings from more than one sanitized string, in order', () => {
    const a: HygieneResult = sanitizeExportText('one' + cp(0x200b));
    const b: HygieneResult = sanitizeExportText('two' + cp(0x202e) + cp(0x202c));
    const summary = foldHygiene(foldHygiene(EMPTY_HYGIENE_SUMMARY, a), b);
    expect(summary.clean).toBe(false);
    expect(summary.findings).toHaveLength(2);
    expect(summary.findings[0].category).toBe('zero_width_or_invisible');
    expect(summary.findings[1].category).toBe('bidi_override');
  });
});

describe('detectHostileCharacters(): reports without touching the string', () => {
  it('returns no findings for clean ordinary prose', () => {
    expect(detectHostileCharacters('Shipped the checkout redesign.')).toEqual([]);
  });

  it('finds a zero-width space but does not remove it', () => {
    const hostile = 'Managed the' + cp(0x200b) + ' migration';
    const findings = detectHostileCharacters(hostile);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('zero_width_or_invisible');
    expect(findings[0].action).toBe('stripped');
    expect(findings[0].count).toBe(1);
    // Detection only: the input this function was handed is untouched.
    // record.ts and tailor.ts both call it precisely because they are not
    // allowed to edit the value they are asking about.
    expect(hostile).toBe('Managed the' + cp(0x200b) + ' migration');
  });

  it('finds a bidirectional override and reports it as refused, without removing it', () => {
    const hostile = 'Staff Designer' + cp(0x202e) + 'reegnE PV' + cp(0x202c);
    const findings = detectHostileCharacters(hostile);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('bidi_override');
    expect(findings[0].action).toBe('refused');
    expect(findings[0].count).toBe(2);
  });

  it('finds Unicode tag characters', () => {
    const hostile = 'Genuine title' + cp(0xe0068) + cp(0xe0069);
    const findings = detectHostileCharacters(hostile);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('unicode_tag_characters');
  });

  it('reports every category present in one string, same as sanitizeExportText()', () => {
    const hostile = 'Bullet' + cp(0x200b) + ' text' + cp(0x202e) + 'reversed' + cp(0x202c) + cp(0xe0068);
    const findings = detectHostileCharacters(hostile);
    const categories = findings.map((f) => f.category).sort();
    expect(categories).toEqual(['bidi_override', 'unicode_tag_characters', 'zero_width_or_invisible']);
  });

  it('does not flag characters no category above covers: a smart quote, an em dash, accented and non-Latin letters', () => {
    // Written as \u escapes, never as the literal character: gate 3
    // (test/gates/copy.mjs) hard fails on a curly quote, an em dash, or an
    // unusual byte typed directly into source, and is right to. These are
    // the exact adversarial-but-legitimate bytes record.test.ts and
    // tailor.test.ts hold coreMatches() and the render to byte-identical: a
    // smart quote, an em dash, a decomposed accent (a plain "e" plus a
    // combining acute accent), and precomposed non-ASCII letters.
    // detectHostileCharacters() must never flag any of these; a detector
    // this eager would refuse a person's own name.
    const legitimate = 'Ren\u0065\u0301\u2019s Caf\u0065\u0301\u2014L\u00e9on \u00d3 Riain';
    expect(detectHostileCharacters(legitimate)).toEqual([]);
  });
});
