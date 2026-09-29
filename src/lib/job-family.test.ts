/**
 * job-family.test.ts: the family classifier, and the coverage it must hold.
 *
 * The valuable test here is the last one. Every other case proves a rule does
 * what its author meant; the corpus coverage floor proves the rules together
 * still classify the board, which is the thing that rots silently as employers
 * change how they file jobs and as the crawl adds companies.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { familyOf, familyLabel, familyFromSearch, FAMILIES, FAMILY_IDS } from './job-family.mjs';

describe('the family list', () => {
  it('has unique ids and a label for each', () => {
    expect(new Set(FAMILY_IDS).size).toBe(FAMILIES.length);
    for (const f of FAMILIES) expect(familyLabel(f.id)).toBe(f.label);
  });

  it('answers null for a family that does not exist, rather than guessing', () => {
    expect(familyLabel(null)).toBeNull();
    expect(familyLabel('not-a-family')).toBeNull();
  });
});

describe('a department names the family', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Nurse', 'health'],
    ['Medical Officer', 'health'],
    ['Zahnmedizin', 'health'],
    ['Software Development', 'software'],
    ['Engineering', 'software'],
    ['Information Technology Management', 'it-infra'],
    ['Data Science', 'data-ai'],
    ['Design', 'design'],
    ['Product Management', 'product'],
    ['Field Sales', 'sales'],
    ['Attorney', 'legal'],
    ['Human Resources', 'people'],
    ['Fulfillment & Operations Management', 'operations'],
    ['Custodial Working', 'trades'],
    ['Police', 'public-safety'],
    ['Social Work', 'social-care'],
    ['Education And Training Technician', 'education'],
    ['Food Service Working', 'hospitality'],
    ['Manufacturing', 'manufacturing']
  ];
  for (const [dept, want] of cases) {
    it(`${dept} -> ${want}`, () => expect(familyOf(dept, '')).toBe(want));
  }
});

describe('precedence, which is the whole algorithm', () => {
  // These four are the reason the rule list is ordered rather than alphabetical.
  // Each contains a word that a later family would claim.
  it('Value Engineering is finance, not software', () => {
    expect(familyOf('Value Engineering', '')).toBe('finance');
  });
  it('Legal Engineering is legal, not software', () => {
    expect(familyOf('Legal Engineering', '')).toBe('legal');
  });
  it('a sales engineer is sales, not software', () => {
    expect(familyOf('Sales Engineer', '')).toBe('sales');
  });
  it('a research engineer is science, not software', () => {
    expect(familyOf('Research Engineer', '')).toBe('science');
  });
  it('Operations, IT, & Support Engineering resolves to one family, not four', () => {
    const f = familyOf('Operations, IT, & Support Engineering', '');
    expect(FAMILY_IDS).toContain(f);
  });
});

describe('words that mean a different job in a different field', () => {
  // All four were found by spot-checking the classified board, not by reading
  // the rules. A rules file is only as good as the cases someone went looking
  // for, so each defect found that way earns a test here.
  it('Silicon Co-Design is hardware, not product design', () => {
    expect(familyOf(null, 'HSIO Validation Lead, Silicon Co-Design')).toBe('manufacturing');
  });
  it('an FPGA engineer is hardware, not software', () => {
    expect(familyOf(null, 'FPGA Engineer')).toBe('manufacturing');
  });
  it('a product designer is still design', () => {
    expect(familyOf('Design', 'Senior Product Designer')).toBe('design');
    expect(familyOf(null, 'Staff Product Designer')).toBe('design');
  });
  it("the employer's own department beats our reading of the title", () => {
    // Filed under Design & Creative, so it is design here even though the title
    // alone would read as a trade. The department is a stated fact; the title
    // is us reading a string, and the stated fact wins.
    expect(familyOf('Design & Creative', 'Senior Electrical BIM/VDC')).toBe('design');
  });
});

describe('the corpus is multilingual and so are the rules', () => {
  // Compound languages are why matching is not whole-word only: butikk is not
  // a word in butikkmedarbeider, it is the start of one.
  it('Butikkmedarbeider (Norwegian, shop assistant) is hospitality', () => {
    expect(familyOf('Butikkmedarbeider', '')).toBe('hospitality');
  });
  it('Anlagenmechanik (German, plant mechanics) is trades', () => {
    expect(familyOf('Anlagenmechanik & Wärmepumpen', '')).toBe('trades');
  });
  it('Undersköterska (Swedish, assistant nurse) is health', () => {
    expect(familyOf('Undersköterska', '')).toBe('health');
  });
  it('an umlaut does not change the answer', () => {
    expect(familyOf('Vertriebsaußendienst', '')).toBe(familyOf('Vertriebsaussendienst', ''));
  });
});

describe('a short term never matches as a prefix', () => {
  // The length floor exists so `it` cannot claim `items`. Without it the widest
  // rules would swallow the board.
  it('items is not IT', () => expect(familyOf('Items', '')).not.toBe('it-infra'));
  it('qatar is not QA', () => expect(familyOf('Qatar', '')).not.toBe('software'));
});

describe('the title is the fallback, and null is a real answer', () => {
  it('reads the title when the department classifies nothing', () => {
    expect(familyOf('FLZR', 'Registered Nurse, ICU')).toBe('health');
  });
  it('reads the title when there is no department at all', () => {
    expect(familyOf(null, 'Senior Software Engineer')).toBe('software');
  });
  it('returns null rather than inventing an Other bucket', () => {
    expect(familyOf('FLZR', '')).toBeNull();
    expect(familyOf('Cody Agency', 'Cody Agency')).toBeNull();
    expect(familyOf(null, null)).toBeNull();
  });
});

/**
 * THE RATCHET. Measured at 87.7% on the 2026-09-26 corpus. The floor is set
 * below that deliberately: the crawl adds companies and employers rename
 * departments, so a few points of drift is normal and is not a defect. A drop
 * THROUGH the floor is, and it means the rules have stopped describing the
 * board.
 *
 * If this fails, do not lower the number. Print the unmapped tail (the harness
 * below reports it) and either add the terms the corpus is asking for, or
 * record that the tail is genuinely unclassifiable and the board has changed
 * shape.
 */
describe('coverage against the real corpus', () => {
  const CORPUS = 'src/data/board-latest.json.gz';
  // RATCHETED 0.84 -> 0.90 on 2026-09-28, when the long-tail block took the
  // corpus from 87.77% to 92.93%. It sits below the measured number on
  // purpose: the floor's job is to catch a rule that BREAKS classification, not
  // to pin a figure that moves a little every night as the crawl reaches new
  // employers. Raise it when a block of terms earns it; never lower it to make
  // a red build green.
  const FLOOR = 0.9;

  /**
   * READ AND CLASSIFY ONCE. Both cases below need the same 37,765 rows, and the
   * first version of this file gunzipped 33 MB twice — fine alone, and a
   * timeout under a full parallel suite, where it failed while passing on its
   * own. A test that only fails when other tests are running teaches people to
   * re-run rather than to look.
   */
  let classified = 0;
  let total = 0;
  const unmapped = new Map<string, number>();
  const counts = new Map<string, number>();

  beforeAll(() => {
    if (!existsSync(CORPUS)) return;
    const rows = JSON.parse(gunzipSync(readFileSync(CORPUS)).toString()).jobs as ReadonlyArray<{
      department?: string | null;
      title?: string | null;
    }>;
    total = rows.length;
    for (const r of rows) {
      const f = familyOf(r.department ?? null, r.title ?? null);
      if (f) {
        classified += 1;
        counts.set(f, (counts.get(f) ?? 0) + 1);
      } else {
        const k = (r.department ?? '').trim() || '(no department)';
        unmapped.set(k, (unmapped.get(k) ?? 0) + 1);
      }
    }
  }, 60_000);

  // IT SKIPS WHEN THE CORPUS IS NOT COMMITTED, and that is worth knowing before
  // trusting a green run: the nightly data commits ADD board-latest.json.gz with
  // the board and REMOVE it with the stats a few hours later (72ec490 adds,
  // d174e28 deletes), so on most commits this ratchet is not running at all.
  // Measure a rules change against the database when the file is absent.
  it.skipIf(!existsSync(CORPUS))(`classifies at least ${Math.round(FLOOR * 100)}% of the board`, () => {
    const share = classified / total;
    const worst = [...unmapped]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${v} x ${k}`)
      .join('\n  ');
    expect(
      share,
      `family coverage fell to ${(share * 100).toFixed(1)}% of ${total} postings. ` +
        `The largest unmapped groups are:\n  ${worst}\n` +
        'Add the terms the corpus is asking for in job-family.mjs, or record that the tail ' +
        'is genuinely unclassifiable. Do not lower this floor to make the gate pass.'
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it.skipIf(!existsSync(CORPUS))('puts no family above half the board', () => {
    // A rule that over-claims is invisible in a coverage number: everything is
    // classified, and all of it is wrong. This is the guard for that.
    const [biggest, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    expect(n / total, `${biggest} claims ${((n / total) * 100).toFixed(1)}% of the board`).toBeLessThan(0.5);
  });
});

describe('the published contract names the same families the code does', () => {
  // THE GUARD THAT WOULD HAVE CAUGHT THIS. schemas/jobs.schema.json carried a
  // four-value design vocabulary (product / design_engineering / brand /
  // design_systems) that nothing wrote, for long enough that /jobs-data's
  // watched groups were built against it and matched zero rows. Two lists of
  // family names with no test between them is how that happens.
  it('the jobs schema role_family enum IS FAMILY_IDS, in order', () => {
    const schema = JSON.parse(readFileSync('schemas/jobs.schema.json', 'utf8'));
    const prop = schema.$defs?.job?.properties?.role_family ?? schema.properties?.job?.properties?.role_family;
    const branch = (prop.oneOf as { enum?: string[] }[]).find((b) => Array.isArray(b.enum));
    expect(branch?.enum).toEqual([...FAMILY_IDS]);
  });

  it('a kill carries no family, because board_kills has no column for one', () => {
    for (const file of ['schemas/kills.schema.json', 'schemas/kills-archive.schema.json']) {
      expect(readFileSync(file, 'utf8')).not.toContain('role_family');
    }
  });
});

describe('familyFromSearch: a search that names a field chooses it', () => {
  it('matches a whole label, case and space ignored', () => {
    expect(familyFromSearch('Healthcare & Medicine')).toBe('health');
    expect(familyFromSearch('  software engineering ')).toBe('software');
    expect(familyFromSearch('DESIGN')).toBe('design');
  });

  it('never matches a substring, so a word stays a search', () => {
    // "design" is the whole Design label, so it resolves. "designer" is not,
    // and must stay a search for the word — the board holds 676 rows matching
    // it across software, marketing and design against a Design field of 313.
    expect(familyFromSearch('designer')).toBeNull();
    expect(familyFromSearch('Healthcare')).toBeNull();
    expect(familyFromSearch('nurse')).toBeNull();
    expect(familyFromSearch('senior product designer')).toBeNull();
  });

  it('is null for nothing at all', () => {
    expect(familyFromSearch('')).toBeNull();
    expect(familyFromSearch('   ')).toBeNull();
    expect(familyFromSearch(null)).toBeNull();
    expect(familyFromSearch(undefined)).toBeNull();
  });

  it('every label resolves to its own id', () => {
    for (const family of FAMILIES) expect(familyFromSearch(family.label)).toBe(family.id);
  });
});

describe('the suggestion list', () => {
  it('offers every field, and its ids are real', async () => {
    const list = JSON.parse(readFileSync('src/data/search-suggestions.json', 'utf8')) as {
      t: string; k: string; id?: string; n: number;
    }[];
    const fields = list.filter((e) => e.k === 'f');
    expect(fields).toHaveLength(FAMILIES.length);
    for (const f of fields) expect(FAMILY_IDS).toContain(f.id);
    // Every field entry must be resolvable by the rule board.astro applies,
    // or the option would run as a substring search and return nothing.
    for (const f of fields) expect(familyFromSearch(f.t)).toBe(f.id);
  });

  it('stays small enough to inline', () => {
    const bytes = readFileSync('src/data/search-suggestions.json').byteLength;
    expect(bytes).toBeLessThan(24_000);
  });
});
