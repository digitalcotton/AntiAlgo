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

/**
 * THE 2026-10-02 REPAIR. docs/board-picker-research.md section 8 measured three
 * defects by reading the stored families: a duplicated term, a prefix that
 * invents a match, and a word that means two things. Each case below is a row
 * the board really carries, pinned at the answer a reader would call right.
 *
 * `[department, title, family]`, with null for "no department" and for "no
 * family". The title column is where the work is: a department is tried first
 * and would hide the rule under test.
 */
describe('a lawyer is a lawyer, and a counselor is not', () => {
  // `counsel` sat in both social-care and legal. Social care comes first, so
  // every Counsel on the board was filed as social care.
  const cases: ReadonlyArray<readonly [string | null, string | null, string]> = [
    [null, 'Corporate Counsel', 'legal'],
    [null, 'General Counsel', 'legal'],
    [null, 'Senior Legal Counsel, Contracts (German speaker)', 'legal'],
    // A lawyer's title names the practice first. Without `counsel` being
    // claimed early, `commercial` and `product` (sales and product sit above
    // legal) would take these the moment social care let go of the word.
    [null, 'Commercial Counsel', 'legal'],
    [null, 'Product Counsel', 'legal'],
    ['G&A', 'Commercial Counsel', 'legal'],
    // And the person who counsels stays in social care, every spelling.
    [null, 'Substance Use Counselor', 'social-care'],
    [null, 'Vocational Rehabilitation Counselor', 'social-care'],
    [null, 'Guidance Counsellor', 'social-care'],
    [null, 'Counseling Psychologist', 'social-care'],
    ['Counseling', 'Case Manager', 'social-care'],
    [null, 'Career Counselors', 'social-care']
  ];
  for (const [dept, title, want] of cases) {
    it(`${dept ? `${dept} / ` : ''}${title} -> ${want}`, () => expect(familyOf(dept, title)).toBe(want));
  }
});

describe('a word that only begins with a term does not match it', () => {
  // The prefix rule lets a long term claim the start of a longer word. Right for
  // engineer / engineering; wrong for sales / Salesforce. NOT_AN_EXTENSION is
  // the list of words that start like a term and are something else.
  const cases: ReadonlyArray<readonly [string | null, string | null, string | null]> = [
    // Salesforce is a CRM product. An administrator of it is IT work (the
    // phrase `salesforce admin`); a developer of it is software; a project
    // manager of it is administration. None of them sells anything.
    [null, 'Salesforce Administrator', 'it-infra'],
    [null, 'Salesforce Admin', 'it-infra'],
    [null, 'Salesforce Developer', 'software'],
    [null, 'Salesforce Project Manager', 'admin'],
    [null, 'Sr Salesforce Partner Marketing Manager', 'marketing'],
    // ...while everything that really is sales stays sales.
    [null, 'Sales Engineer', 'sales'],
    [null, 'Account Executive', 'sales'],
    [null, 'Sales Manager', 'sales'],
    [null, 'Salesperson', 'sales'],
    ['Sales', '', 'sales'],
    // A barred word must not hide a good one beside it: the first `sales`-word
    // here is Salesforce, the second is a salesperson.
    [null, 'Salesforce Salesperson', 'sales'],
    // Production is a factory floor, not product management, and is still
    // claimed by manufacturing's own `production`; Productie is the Dutch.
    ['Production Control', 'PRODUCTION CONTROLLER', 'manufacturing'],
    ['Production', 'Production Supervisor', 'manufacturing'],
    ['Productie', 'Operator', 'manufacturing'],
    [null, 'Productiemedewerker', 'manufacturing'],
    [null, 'Productivity Consultant', null],
    // ...while product management stays product, plural included.
    [null, 'Product Manager', 'product'],
    ['Products', '', 'product'],
    // Developmental services are social care, a nursery is not a nurse, and a
    // Kitchener is a city.
    [null, 'Direct Support Staff - Developmental Services', 'social-care'],
    ['Managers', 'Nursery Manager - North London', null],
    [null, 'Detailer - Kitchener', null],
    [null, 'Kitchen Manager', 'hospitality'],
    [null, 'Registered Nurses', 'health'],
    // Fire protection is not a brand, in three languages.
    [null, 'Specialist inom fysisk sakerhet och brandskydd', null],
    [null, 'Brand Designer', 'design'],
    [null, 'Branding Manager', 'marketing'],
    // A German technician is a tradesman, not a technology worker.
    [null, 'Techniker Gebaudeautomation', 'trades'],
    // An operating-theatre nurse is health, not operations.
    ['Operationssjuksköterska', '', 'health'],
    // A pupil's internship is not a job in a school.
    [null, 'Schülerpraktikum Technischer Systemplaner', null]
  ];
  for (const [dept, title, want] of cases) {
    it(`${dept ? `${dept} / ` : ''}${title} -> ${want ?? 'null'}`, () => {
      const got = familyOf(dept, title);
      if (want === null) expect(got).toBeNull();
      else expect(got).toBe(want);
    });
  }

  it('Salesforce Administrator is not sales', () => {
    // Stated on its own because it is the case the board research named: 96
    // live rows carry "Salesforce", and the Administrator and Project Manager
    // titles among them were filed under sales.
    expect(familyOf(null, 'Salesforce Administrator')).not.toBe('sales');
  });

  it('the stems that ARE stems still match as prefixes', () => {
    // The bars are specific. The reason the prefix rule exists is untouched.
    expect(familyOf(null, 'Engineering Manager')).toBe('software');
    expect(familyOf(null, 'Delivery Drivers')).toBe('operations');
    expect(familyOf('Radiologic Technologist', '')).toBe('health');
    expect(familyOf(null, 'Veterinario')).toBe('health');
    expect(familyOf('Elektroniker für Betriebstechnik', '')).toBe('trades');
    expect(familyOf(null, 'Cybersecurity Analyst')).toBe('security');
  });
});

describe('words that mean two things in two fields', () => {
  // `data` is the word for analysis and is also the first word of a data
  // center, where the people rack servers. Data Center Technician was filed
  // under Data & AI next to the data scientists.
  const cases: ReadonlyArray<readonly [string | null, string | null, string]> = [
    [null, 'Data Center Technician', 'it-infra'],
    [null, 'Datacenter Technician', 'it-infra'],
    [null, 'Data Centre Operations Manager', 'it-infra'],
    [null, 'Data Center Infrastructure Specialist', 'it-infra'],
    ['Datacenter', 'Technical Project Manager', 'it-infra'],
    // ...while the data work stays data work.
    [null, 'Data Engineer', 'data-ai'],
    [null, 'Data Scientist', 'data-ai'],
    [null, 'Data Analyst', 'data-ai'],
    [null, 'Senior Data Engineering Manager', 'data-ai'],
    ['Data Science', '', 'data-ai']
  ];
  for (const [dept, title, want] of cases) {
    it(`${dept ? `${dept} / ` : ''}${title} -> ${want}`, () => expect(familyOf(dept, title)).toBe(want));
  }
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
  /**
   * WHERE THE CORPUS COMES FROM, AND WHY THERE ARE TWO.
   *
   * This read only src/data/board-latest.json.gz, which is the live board — and
   * that file is committed only when something has gone WRONG. The nightly
   * loads the board into Postgres and `jm publish everything` then `git rm`s
   * it; it appears in the tree only on a night the database load failed and the
   * board had to travel by git. So the ratchet ran when the pipeline was broken
   * and skipped on every healthy commit, which is exactly backwards, and it is
   * why coverage drifted from 92.93% to 88.97% over two days with a green
   * suite the whole way.
   *
   * So the fixture is the default and the test never skips. It is the same
   * board, reduced to what this test actually reads: distinct department/title
   * pairs with a count, which makes weighted coverage identical to the row by
   * row number (verified at capture: 47,735/52,739 = 90.5118% both ways) at
   * 516 KB instead of 44 MB. No urls, no companies, no pay.
   *
   * The live board still wins when it is present, so a night that leaves one
   * behind is measured against the real thing rather than a snapshot.
   *
   * REFRESHING IT is a deliberate act, not a chore: the fixture is a 2026-09-30
   * photograph of the board, so it catches a rule that breaks classification
   * forever, and it cannot catch the board changing shape underneath the rules.
   * That second question belongs to the machine, which has the live data —
   * `jm rehearse everything` reports it. Rebuild this file when a tail block is
   * added, and say in the commit what the number moved from and to.
   */
  const LIVE_CORPUS = 'src/data/board-latest.json.gz';
  const FIXTURE = 'test/fixtures/family-corpus.json.gz';
  const CORPUS = existsSync(LIVE_CORPUS) ? LIVE_CORPUS : FIXTURE;
  // RATCHETED 0.84 -> 0.90 on 2026-09-28, when the long-tail block took the
  // corpus from 87.77% to 92.93%. It sits below the measured number on
  // purpose: the floor's job is to catch a rule that BREAKS classification, not
  // to pin a figure that moves a little every night as the crawl reaches new
  // employers. Raise it when a block of terms earns it; never lower it to make
  // a red build green.
  //
  // 2026-10-02, the classifier repair: 90.51% -> 90.45%. Not a defect in the
  // rules and not a reason to move the floor. Thirty-seven postings lost a
  // family they were given by mistake (Salesforce read as sales, Brandenburg
  // as a brand, a Schülerpraktikum as a school) and five gained one (Datacenter
  // read as IT). A gap shown as a gap is the cheaper error than a wrong label.
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
    const doc = JSON.parse(gunzipSync(readFileSync(CORPUS)).toString()) as {
      jobs?: ReadonlyArray<{ department?: string | null; title?: string | null }>;
      pairs?: ReadonlyArray<readonly [string | null, string | null, number]>;
    };
    // The live board lists every posting; the fixture lists each distinct
    // department/title once with the number of postings behind it. Both are
    // read as a weight, so the two produce the same percentage.
    const rows: ReadonlyArray<{ department?: string | null; title?: string | null; weight: number }> =
      doc.pairs
        ? doc.pairs.map(([department, title, weight]) => ({ department, title, weight }))
        : (doc.jobs ?? []).map((r) => ({ ...r, weight: 1 }));
    total = rows.reduce((n, r) => n + r.weight, 0);
    for (const r of rows) {
      const f = familyOf(r.department ?? null, r.title ?? null);
      if (f) {
        classified += r.weight;
        counts.set(f, (counts.get(f) ?? 0) + r.weight);
      } else {
        const k = (r.department ?? '').trim() || '(no department)';
        unmapped.set(k, (unmapped.get(k) ?? 0) + r.weight);
      }
    }
  }, 60_000);

  // IT ALWAYS RUNS NOW. It used to skip unless the live board happened to be
  // committed, which only happens when the database load has failed — so the
  // one check on classification ran on broken nights and skipped on healthy
  // ones. See the CORPUS comment above.
  it(`classifies at least ${Math.round(FLOOR * 100)}% of the board`, () => {
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
