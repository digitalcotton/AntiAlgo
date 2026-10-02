/**
 * rank-reason.test.ts: every sentence rankReason() can say, pinned word for word,
 * and the guard that keeps each one true to the ORDER BY it describes.
 *
 * The line exists so that no row sits where it sits for a reason the reader
 * cannot read. A sentence that drifts from the real order is worse than no
 * sentence, so this file does three things: it pins the words for every sort
 * and every text-match rung, it sweeps the whole fact space for the properties
 * that must hold everywhere (a place, an ending, no forbidden punctuation,
 * deterministic), and it reads job-store.ts and fails when an ORDER BY changes
 * under a sentence that still describes the old one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ordinal, rankReason, type MatchField, type RankFacts } from './rank-reason';

function facts(over: Partial<RankFacts> = {}): RankFacts {
  return {
    position: 3,
    sort: 'best',
    tier: 1,
    field: 'title',
    fuzzy: false,
    fuzzyScore: null,
    query: 'product designer',
    deets: 97,
    ageDays: 2,
    payStated: true,
    ...over
  };
}

// Built from code points: the copy gate hard fails on the literal characters
// anywhere this repository authors, this file included.
const FORBIDDEN = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d].map((cp) => String.fromCodePoint(cp));

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [9, '9th'],
    [10, '10th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [14, '14th'],
    [20, '20th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [24, '24th'],
    [100, '100th'],
    [101, '101st'],
    [102, '102nd'],
    [103, '103rd'],
    [104, '104th'],
    [111, '111th'],
    [112, '112th'],
    [113, '113th'],
    [121, '121st'],
    [122, '122nd'],
    [123, '123rd'],
    [1000, '1,000th'],
    [1001, '1,001st'],
    [1011, '1,011th'],
    [1204, '1,204th'],
    [11111, '11,111th'],
    [37000, '37,000th'],
    [1000000, '1,000,000th']
  ])('%i is %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });

  it('floors a fraction and does not pretend a non-place is one', () => {
    expect(ordinal(3.9)).toBe('3rd');
    expect(ordinal(0)).toBe('0');
    expect(ordinal(-4)).toBe('-4');
    expect(ordinal(Number.NaN)).toBe('NaN');
  });
});

describe('rankReason: sort=best with exact words, one sentence per rung', () => {
  it('tier 0: the title is the words', () => {
    expect(rankReason(facts({ tier: 0, field: 'title', position: 1 }))).toBe(
      'Ranked 1st: the title is exactly what you typed, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('tier 1: every word is in the title', () => {
    expect(rankReason(facts({ tier: 1, field: 'title' }))).toBe(
      'Ranked 3rd: every word you typed is in the title, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('tier 2: every word is in the title or the company', () => {
    expect(rankReason(facts({ tier: 2, field: 'company', position: 12 }))).toBe(
      'Ranked 12th: every word you typed is in the title or the company name, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('tier 3 completed by the department', () => {
    expect(rankReason(facts({ tier: 3, field: 'department', position: 22 }))).toBe(
      'Ranked 22nd: a word you typed is found only in the department, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('tier 3 completed by the description: the words are in the posting, not all in the title', () => {
    expect(rankReason(facts({ tier: 3, field: 'description', position: 41 }))).toBe(
      'Ranked 41st: a word you typed is found only in the description, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('tier 3 with no field still says something true, and no more', () => {
    expect(rankReason(facts({ tier: 3, field: null }))).toBe(
      'Ranked 3rd: a word you typed is found outside the title and the company name, then the closer text match, then Deets 97, then newer first.'
    );
  });

  it('a page-two row says its place in the whole result, not on its page', () => {
    // Row 3 of page 2 at 25 a page is the 28th row of the result. The caller does
    // that arithmetic; the sentence must carry the true number through.
    expect(rankReason(facts({ position: 28 }))).toMatch(/^Ranked 28th: /);
    expect(rankReason(facts({ position: 111 }))).toMatch(/^Ranked 111th: /);
    expect(rankReason(facts({ position: 1204 }))).toMatch(/^Ranked 1,204th: /);
  });

  it('states the Deets the row actually has', () => {
    expect(rankReason(facts({ deets: 41 }))).toContain('then Deets 41, then');
    expect(rankReason(facts({ deets: 0 }))).toContain('then Deets 0, then');
  });

  it('drops the Deets step rather than print a number that is not one', () => {
    expect(rankReason(facts({ deets: Number.NaN }))).toBe(
      'Ranked 3rd: every word you typed is in the title, then the closer text match, then newer first.'
    );
  });

  it('a rung the store does not report says nothing', () => {
    expect(rankReason(facts({ tier: 4 }))).toBe('');
    expect(rankReason(facts({ tier: -1 }))).toBe('');
  });
});

describe('rankReason: sort=best on the typo path', () => {
  const fuzzy = (over: Partial<RankFacts> = {}) =>
    facts({ tier: null, field: 'title', fuzzy: true, fuzzyScore: 0.52, query: 'prodct desiner', position: 2, ...over });

  it('names the close spelling, the similarity, then what breaks a tie', () => {
    expect(rankReason(fuzzy())).toBe(
      'Ranked 2nd: a close spelling of "prodct desiner" (similarity 0.52), then Deets 97, then newer first.'
    );
  });

  it('rounds the similarity to two places and keeps it inside 0 to 1', () => {
    expect(rankReason(fuzzy({ fuzzyScore: 0.5 }))).toContain('(similarity 0.50)');
    expect(rankReason(fuzzy({ fuzzyScore: 0.3333333 }))).toContain('(similarity 0.33)');
    expect(rankReason(fuzzy({ fuzzyScore: 1 }))).toContain('(similarity 1.00)');
    expect(rankReason(fuzzy({ fuzzyScore: 1.7 }))).toContain('(similarity 1.00)');
    expect(rankReason(fuzzy({ fuzzyScore: -0.2 }))).toContain('(similarity 0.00)');
  });

  it('leaves the similarity out when the row carries none', () => {
    expect(rankReason(fuzzy({ fuzzyScore: null }))).toBe(
      'Ranked 2nd: a close spelling of "prodct desiner", then Deets 97, then newer first.'
    );
  });

  it('says "your words" when the query is empty', () => {
    expect(rankReason(fuzzy({ query: '   ' }))).toMatch(/^Ranked 2nd: a close spelling of your words \(similarity 0\.52\), /);
  });

  it('quotes safely: spaces collapsed, straight double quotes removed, long words trimmed', () => {
    expect(rankReason(fuzzy({ query: '  prodct    "desiner"  ' }))).toContain('a close spelling of "prodct desiner" (');
    const long = rankReason(fuzzy({ query: 'a'.repeat(120) }));
    expect(long).toContain(`"${'a'.repeat(37)}..."`);
    expect(long).not.toContain('a'.repeat(38));
  });

  it('has no text-match rung in it: a close spelling is on none of them', () => {
    const sentence = rankReason(fuzzy());
    expect(sentence).not.toContain('title');
    expect(sentence).not.toContain('closer text match');
  });

  it('wins over a tier the row somehow also carries: the typo path is the order in force', () => {
    expect(rankReason(fuzzy({ tier: 1 }))).toMatch(/^Ranked 2nd: a close spelling of /);
  });
});

describe('rankReason: the sorts a reader chooses', () => {
  it('Deets: the number, then the tie-break the SQL really uses', () => {
    expect(rankReason(facts({ sort: 'fit' }))).toBe(
      'Ranked 3rd by Deets: 97 of 100, highest first, then company and title A to Z.'
    );
  });

  it('pay, with a figure', () => {
    expect(rankReason(facts({ sort: 'comp', payStated: true }))).toBe(
      'Ranked 3rd by pay: highest posted figure first, then company and title A to Z.'
    );
  });

  it('pay, with none: it says why it is below every row that has one', () => {
    expect(rankReason(facts({ sort: 'comp', payStated: false, position: 41 }))).toBe(
      'Ranked 41st by pay: it posts no figure, so it follows every row that does, then company and title A to Z.'
    );
  });

  it('age, counted from the posted date', () => {
    expect(rankReason(facts({ sort: 'age', ageDays: 2, position: 1 }))).toBe(
      'Ranked 1st by age: posted 2 days ago, newest first, then company and title A to Z.'
    );
  });

  it('age says today, and 1 day, in the singular', () => {
    expect(rankReason(facts({ sort: 'age', ageDays: 0 }))).toContain('posted today, newest first');
    expect(rankReason(facts({ sort: 'age', ageDays: 1 }))).toContain('posted 1 day ago, newest first');
  });

  it('age counted from first sight says "first seen", never "posted"', () => {
    const sentence = rankReason(facts({ sort: 'age', ageDays: 12, ageBasis: 'first_seen' }));
    expect(sentence).toBe('Ranked 3rd by age: first seen 12 days ago, newest first, then company and title A to Z.');
    expect(sentence).not.toContain('posted');
  });

  it('age, with no date: it says why it is after every dated row', () => {
    expect(rankReason(facts({ sort: 'age', ageDays: null, position: 80 }))).toBe(
      'Ranked 80th by age: it has no date to count from, so it follows every dated row, then company and title A to Z.'
    );
  });

  it('a typo-path or text-matched row under a chosen sort is placed by the sort, and the sentence says so', () => {
    // The text facts do not decide order under Deets, pay or age, so they must
    // not appear in the sentence for them.
    for (const sort of ['fit', 'comp', 'age'] as const) {
      const plain = rankReason(facts({ sort, tier: null, field: null }));
      expect(rankReason(facts({ sort, tier: 1, field: 'title' }))).toBe(plain);
      expect(rankReason(facts({ sort, tier: 3, field: 'description' }))).toBe(plain);
      expect(rankReason(facts({ sort, tier: null, fuzzy: true, fuzzyScore: 0.4 }))).toBe(plain);
    }
  });
});

describe('rankReason: sort=best with nothing typed is the default order, Deets', () => {
  it('reads as the Deets sentence', () => {
    const nothingTyped = facts({ sort: 'best', tier: null, field: null, fuzzy: false, query: '' });
    expect(rankReason(nothingTyped)).toBe(rankReason({ ...nothingTyped, sort: 'fit' }));
    expect(rankReason(nothingTyped)).toBe('Ranked 3rd by Deets: 97 of 100, highest first, then company and title A to Z.');
  });
});

describe('rankReason: when it cannot say anything true it says nothing', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('position %s', (position) => {
    expect(rankReason(facts({ position }))).toBe('');
    expect(rankReason(facts({ position, sort: 'fit' }))).toBe('');
  });

  it('Deets sort with no Deets', () => {
    expect(rankReason(facts({ sort: 'fit', deets: Number.NaN }))).toBe('');
  });
});

describe('rankReason: the whole fact space', () => {
  const sorts = ['best', 'fit', 'comp', 'age'] as const;
  const tiers: (number | null)[] = [null, 0, 1, 2, 3];
  const fields: (MatchField | null)[] = [null, 'title', 'company', 'department', 'description'];
  const ages: (number | null)[] = [null, 0, 1, 2, 48, 400];
  const all: RankFacts[] = [];
  for (const sort of sorts)
    for (const tier of tiers)
      for (const field of fields)
        for (const fuzzy of [false, true])
          for (const payStated of [false, true])
            for (const ageDays of ages)
              for (const ageBasis of ['posted', 'first_seen'] as const)
                all.push(
                  facts({
                    sort,
                    tier,
                    field,
                    fuzzy,
                    fuzzyScore: fuzzy ? 0.61 : null,
                    payStated,
                    ageDays,
                    ageBasis,
                    position: 41,
                    query: 'product designer'
                  })
                );

  it('covers a few thousand combinations, so the properties below mean something', () => {
    expect(all.length).toBeGreaterThan(3000);
  });

  it('every combination is one sentence: its true place first, one full stop last', () => {
    for (const f of all) {
      const sentence = rankReason(f);
      expect(sentence, JSON.stringify(f)).toMatch(/^Ranked 41st( by (Deets|pay|age))?: .+\.$/);
      // One sentence: no full stop before the last, a decimal point (0.61) aside.
      expect(sentence.slice(0, -1).replace(/\d\.\d/g, '')).not.toContain('.');
    }
  });

  it('is deterministic: the same facts give the same words', () => {
    for (const f of all) expect(rankReason({ ...f })).toBe(rankReason(f));
  });

  it('never prints an em dash, an en dash or a curly quote', () => {
    for (const f of all) {
      const sentence = rankReason(f);
      for (const char of FORBIDDEN) expect(sentence.includes(char), JSON.stringify(f)).toBe(false);
    }
  });

  it('only the Deets sort and the default order print "of 100"; only pay and age name their column', () => {
    for (const f of all) {
      const sentence = rankReason(f);
      const effective = f.sort === 'best' && !f.fuzzy && f.tier === null ? 'fit' : f.sort;
      expect(sentence.includes('by Deets'), JSON.stringify(f)).toBe(effective === 'fit');
      expect(sentence.includes('by pay'), JSON.stringify(f)).toBe(effective === 'comp');
      expect(sentence.includes('by age'), JSON.stringify(f)).toBe(effective === 'age');
    }
  });

  it('the typo path is named exactly when the facts say fuzzy and the sort is best', () => {
    for (const f of all) {
      const sentence = rankReason(f);
      expect(sentence.includes('a close spelling of'), JSON.stringify(f)).toBe(f.sort === 'best' && f.fuzzy);
    }
  });
});

/**
 * THE DRIFT GUARD. Each sentence above was written from one ORDER BY in
 * job-store.ts. This reads that file and fails the moment one changes, so the
 * words and the order cannot part company unnoticed. When it fails: change the
 * ORDER BY and the sentence in rank-reason.ts together, then update the string
 * here.
 */
describe('rankReason: each sentence still describes the ORDER BY job-store.ts runs', () => {
  const source = readFileSync(new URL('./job-store.ts', import.meta.url), 'utf8');

  const ORDERS = {
    best: 'tier_n ASC, rank_n DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC',
    typo: 'text_sim DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC',
    fit: 'detail_total DESC, company ASC, title ASC, id ASC',
    comp: 'comp_top DESC NULLS LAST, company ASC, title ASC, id ASC',
    age: 'age_days ASC NULLS LAST, company ASC, title ASC, id ASC'
  };

  it('the five orders are still the ones the sentences were written from', () => {
    expect(source).toContain(`order = '${ORDERS.best}'`);
    expect(source).toContain(`order = '${ORDERS.typo}'`);
    expect(source).toContain(`fit: '${ORDERS.fit}'`);
    expect(source).toContain(`comp: '${ORDERS.comp}'`);
    expect(source).toContain(`age: '${ORDERS.age}'`);
  });

  /** Where each phrase falls in a sentence, in the order it is said. */
  const inOrder = (sentence: string, phrases: string[]) => {
    const at = phrases.map((p) => sentence.indexOf(p));
    expect(at.every((i) => i >= 0), `${sentence} is missing one of ${phrases.join(' | ')}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };

  it('best: tier, then text rank, then Deets, then newer first (tier_n, rank_n, detail_total, age_days)', () => {
    inOrder(rankReason(facts({ tier: 1 })), ['title', 'closer text match', 'Deets 97', 'newer first']);
  });

  it('typo path: similarity, then Deets, then newer first (text_sim, detail_total, age_days)', () => {
    inOrder(rankReason(facts({ tier: null, fuzzy: true, fuzzyScore: 0.5 })), ['similarity', 'Deets 97', 'newer first']);
  });

  it('Deets: high first, then company and title (detail_total DESC, company, title)', () => {
    inOrder(rankReason(facts({ sort: 'fit' })), ['highest first', 'company and title A to Z']);
  });

  it('pay: highest first, none last, then company and title (comp_top DESC NULLS LAST, company, title)', () => {
    inOrder(rankReason(facts({ sort: 'comp', payStated: true })), ['highest posted figure first', 'company and title A to Z']);
    inOrder(rankReason(facts({ sort: 'comp', payStated: false })), ['no figure', 'follows every row that does', 'company and title A to Z']);
  });

  it('age: newest first, none last, then company and title (age_days ASC NULLS LAST, company, title)', () => {
    inOrder(rankReason(facts({ sort: 'age', ageDays: 3 })), ['newest first', 'company and title A to Z']);
    inOrder(rankReason(facts({ sort: 'age', ageDays: null })), ['no date', 'follows every dated row', 'company and title A to Z']);
  });
});
