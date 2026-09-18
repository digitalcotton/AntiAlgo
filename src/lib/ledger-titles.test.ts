import { describe, expect, it } from 'vitest';
import { buildTitleIndex, isCovered, laneFor, matchesTitle, normalizeTitle } from './ledger-titles';

// ledger-titles.ts is the pure half of the Ledger: it turns a watched title
// into a set of board roles with no I/O, which is exactly the seam worth
// testing without a connection string. The counts the page prints are taken
// over laneFor()'s output, so if this matcher is right the counts are exact and
// reproducible; if it drifts, a reader sees a role in the wrong lane or a count
// that does not match a hand count of the rows. Everything asserted here is a
// claim the report rests a number on.

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation and collapses space', () => {
    expect(normalizeTitle('  Senior Product Designer, AI  ')).toBe('senior product designer ai');
    expect(normalizeTitle('Design/Dev & AI Tools')).toBe('design dev ai tools');
  });
});

describe('matchesTitle', () => {
  it('matches the watch as a contiguous run of whole words, in order', () => {
    expect(matchesTitle('Product Designer', 'Senior Product Designer, AI')).toBe(true);
    expect(matchesTitle('Product Designer', 'Staff Product Designer')).toBe(true);
    // Order matters now (whole-phrase, not any-order tokens).
    expect(matchesTitle('designer product', 'Product Designer')).toBe(false);
  });

  it('does not match when the phrase is broken by another word or reordered', () => {
    // "Product Designer" must not match "Design Engineer": the phrase is absent.
    expect(matchesTitle('Product Designer', 'Design Engineer')).toBe(false);
    // Tightened: the two words are present but not adjacent in that order.
    expect(matchesTitle('Product Designer', 'Product Design Engineer')).toBe(false);
    expect(matchesTitle('Design Engineer', 'Design Systems Engineer')).toBe(false);
    // A profession the index does not carry matches nothing.
    expect(matchesTitle('welder', 'Staff Brand Designer')).toBe(false);
  });

  it('never matches a null title or an all-punctuation watch', () => {
    expect(matchesTitle('Product Designer', null)).toBe(false);
    expect(matchesTitle(',', 'Product Designer')).toBe(false);
  });
});

describe('buildTitleIndex', () => {
  it('counts distinct titles, most common first', () => {
    const index = buildTitleIndex([
      { title: 'Product Designer' },
      { title: 'Product Designer' },
      { title: 'Brand Designer' },
      { title: null }
    ]);
    expect(index[0]).toEqual({ title: 'Product Designer', count: 2 });
    expect(index).toHaveLength(2);
  });
});

describe('isCovered', () => {
  it('is true only when some role matches the watch', () => {
    const roles = [{ title: 'Staff Product Designer' }, { title: 'Brand Designer' }];
    expect(isCovered('product designer', roles)).toBe(true);
    expect(isCovered('welder', roles)).toBe(false);
  });
});

describe('laneFor', () => {
  it('returns each matched role once, tagged with the watches that pulled it', () => {
    const roles = [
      { title: 'Senior Product Designer' },
      { title: 'Design Engineer' },
      { title: 'Brand Designer' }
    ];
    const lane = laneFor(roles, ['Product Designer', 'Designer']);
    // The product-design role is matched by both watches; the brand role by the
    // broad "Designer"; the engineer role by neither.
    expect(lane).toHaveLength(2);
    expect(lane[0].matched).toContain('Product Designer');
    expect(lane[0].matched).toContain('Designer');
    expect(lane.map((l) => l.role.title)).not.toContain('Design Engineer');
  });
});
