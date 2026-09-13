import { describe, expect, it } from 'vitest';
import { deterministicProvider, templateText, type LockedFactSet, type LockedFactSlot, type StyleResult } from './provider';

// provider.ts is the style-pass seam: a provider receives already-locked
// facts (a LockedFactSet) and returns phrasing only (a StyleResult keyed by
// slot id). These tests pin the two things that matter about the one
// implementation this run ships: it is deterministic, and its output shape
// carries no field a provider could use to assert a new employer, skill,
// title, date, metric, or credential. The deeper proof that a malicious
// provider still cannot make a new *bullet* appear in a render lives in
// tailor.test.ts, where the merge back into a Render actually happens.

function slot(overrides: Partial<LockedFactSlot> = {}): LockedFactSlot {
  return {
    slotId: 'PRF-0001#0',
    sourcePrfIds: ['PRF-0001'],
    kind: 'role_held',
    fragments: ['Shipped the checkout redesign', 'Cut page weight by half'],
    ...overrides
  };
}

describe('templateText(): the one templating rule', () => {
  it('joins non-skill fragments as sentences, terminating the last one', () => {
    expect(templateText('role_held', ['Led the migration', 'Wrote the runbook'])).toBe(
      'Led the migration. Wrote the runbook.'
    );
  });

  it('does not double a mark on a fragment that already ends in one', () => {
    // The "experiences.. Recruit" defect: a description line that already
    // ends in a period must not gain a second one at the join.
    expect(templateText('role_held', ['Managed diverse experiences.', 'Recruit top talent'])).toBe(
      'Managed diverse experiences. Recruit top talent.'
    );
    expect(templateText('role_held', ['What broke?', 'We fixed it!'])).toBe('What broke? We fixed it!');
  });

  it('renders a skill with no description as just its label', () => {
    expect(templateText('skill', ['Python'])).toBe('Python');
  });

  it('renders a skill with a description after a colon', () => {
    expect(templateText('skill', ['Python', 'Five years, mostly data pipelines'])).toBe(
      'Python: Five years, mostly data pipelines'
    );
  });

  it('returns an empty string for zero fragments, and never throws', () => {
    expect(templateText('role_held', [])).toBe('');
  });

  it('is a pure function of its own arguments: same input, same output, called twice', () => {
    const a = templateText('role_held', ['One', 'Two', 'Three']);
    const b = templateText('role_held', ['One', 'Two', 'Three']);
    expect(a).toBe(b);
  });
});

describe('deterministicProvider.style(): determinism', () => {
  it('produces byte-identical output for the same LockedFactSet, called twice', async () => {
    const locked: LockedFactSet = { slots: [slot(), slot({ slotId: 'PRF-0002#0', sourcePrfIds: ['PRF-0002'] })] };
    const a = await deterministicProvider.style(locked);
    const b = await deterministicProvider.style(locked);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces byte-identical output for two structurally equal but non-identical LockedFactSets', async () => {
    const a = await deterministicProvider.style({ slots: [slot()] });
    const b = await deterministicProvider.style({ slots: [slot()] });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('styles exactly one slot per input slot, keyed by the same slotId, never inventing an extra one', async () => {
    const locked: LockedFactSet = {
      slots: [slot({ slotId: 'a' }), slot({ slotId: 'b' }), slot({ slotId: 'c' })]
    };
    const result: StyleResult = await deterministicProvider.style(locked);
    expect(result.styledSlots.map((s) => s.slotId)).toEqual(['a', 'b', 'c']);
  });

  it('an empty LockedFactSet styles to an empty result', async () => {
    expect(await deterministicProvider.style({ slots: [] })).toEqual({ styledSlots: [] });
  });
});

// StyledSlot and StyleResult carry no field for an employer, a skill, a
// title, a date, a metric, a credential, or an id list: this is enforced by
// the type declarations in provider.ts, checked by `npx tsc --noEmit`, not
// by a runtime assertion here. A styledSlot literal with an extra property
// (`{ slotId, text, employer: 'Acme' }`) fails to compile as a StyledSlot,
// because that type declares exactly `slotId` and `text`.
describe('StyleResult: the shape itself carries no fact-bearing field', () => {
  it('a real StyleResult round-trips through JSON with exactly slotId and text on each entry', async () => {
    const result = await deterministicProvider.style({ slots: [slot()] });
    for (const styled of result.styledSlots) {
      expect(Object.keys(styled).sort()).toEqual(['slotId', 'text']);
    }
  });
});
