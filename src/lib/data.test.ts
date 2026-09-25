import { describe, expect, it } from 'vitest';
import { clusterJobs, compShortFromText, compTop, locationDisplay, type Job } from './data';

// data.ts's clusterJobs() is MASTER-SPEC F10's duplicate-cluster collapse:
// same title, same company, different locations becomes one row. These tests
// pin the contract that matters most: the match rule is byte-identical, not
// forgiving (no trim, no case fold, no cross-company merge, no "close
// enough" title), a cluster of one is indistinguishable from an ordinary
// row, nothing that goes in is dropped or duplicated on the way out, and the
// function is pure (same rows in, same rows out, every time).

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01T00:00:00Z',
    last_verified: '2026-08-20T00:00:00Z',
    published_date: '2026-08-01',
    age_days: 19,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: null,
    ...overrides
  };
}

describe('clusterJobs(): same title, same company, different locations, collapse to one row', () => {
  it('collapses two postings that share a title and company into one cluster with count 2', () => {
    const sf = job({ slug: 'acme-pd-sf', company: 'Acme Corp', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', company: 'Acme Corp', title: 'Product Designer', location: 'New York' });

    const rows = clusterJobs([sf, ny]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('cluster');
    if (row.kind !== 'cluster') throw new Error('expected a cluster row');
    expect(row.cluster.postings).toHaveLength(2);
    expect(row.cluster.company).toBe('Acme Corp');
    expect(row.cluster.title).toBe('Product Designer');
    expect(row.cluster.locations).toEqual(['San Francisco', 'New York']);
  });

  it('does not collapse the same title at two different companies', () => {
    const acme = job({ slug: 'acme-pd', company: 'Acme Corp', title: 'Product Designer', location: 'San Francisco' });
    const globex = job({ slug: 'globex-pd', company: 'Globex Inc', title: 'Product Designer', location: 'San Francisco' });

    const rows = clusterJobs([acme, globex]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('renders a cluster of one exactly as an ordinary row, with no expander', () => {
    const solo = job({ slug: 'acme-pd-solo' });

    const rows = clusterJobs([solo]);

    expect(rows).toEqual([{ kind: 'single', job: solo }]);
  });

  it('expands to contain every original posting and every original link (slug and apply_url), none dropped', () => {
    const postings = [
      job({ slug: 'acme-pd-sf', location: 'San Francisco', apply_url: 'https://boards.example.com/acme/sf/apply' }),
      job({ slug: 'acme-pd-ny', location: 'New York', apply_url: 'https://boards.example.com/acme/ny/apply' }),
      job({ slug: 'acme-pd-remote', location: 'Remote', apply_url: 'https://boards.example.com/acme/remote/apply' })
    ];

    const rows = clusterJobs(postings);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row.kind !== 'cluster') throw new Error('expected a cluster row');
    expect(row.cluster.postings.map((p) => p.slug)).toEqual(['acme-pd-sf', 'acme-pd-ny', 'acme-pd-remote']);
    expect(row.cluster.postings.map((p) => p.apply_url)).toEqual([
      'https://boards.example.com/acme/sf/apply',
      'https://boards.example.com/acme/ny/apply',
      'https://boards.example.com/acme/remote/apply'
    ]);
  });

  it('is pure and deterministic: the same input array produces byte-identical output, every time', () => {
    const postings = [
      job({ slug: 'acme-pd-sf', location: 'San Francisco' }),
      job({ slug: 'acme-pd-ny', location: 'New York' }),
      job({ slug: 'globex-eng', company: 'Globex Inc', title: 'Staff Engineer', location: 'Remote' })
    ];

    const first = clusterJobs(postings);
    const second = clusterJobs(postings);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The argument itself is never touched: a caller's array (usually the
    // page's own sortJobs() output) has to survive being clustered.
    expect(postings).toEqual([
      job({ slug: 'acme-pd-sf', location: 'San Francisco' }),
      job({ slug: 'acme-pd-ny', location: 'New York' }),
      job({ slug: 'globex-eng', company: 'Globex Inc', title: 'Staff Engineer', location: 'Remote' })
    ]);
  });

  it('does not cluster a title that differs by one word', () => {
    const senior = job({ slug: 'acme-senior-pd', title: 'Senior Product Designer' });
    const plain = job({ slug: 'acme-pd', title: 'Product Designer' });

    const rows = clusterJobs([senior, plain]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('does not fold case: a title that differs only by case does not cluster', () => {
    const lower = job({ slug: 'acme-pd-lower', title: 'product designer' });
    const upper = job({ slug: 'acme-pd-upper', title: 'Product Designer' });

    const rows = clusterJobs([lower, upper]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('does not trim: a title with a trailing space does not cluster with one that has none', () => {
    const padded = job({ slug: 'acme-pd-padded', title: 'Product Designer ' });
    const bare = job({ slug: 'acme-pd-bare', title: 'Product Designer' });

    const rows = clusterJobs([padded, bare]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('never clusters a pre-posting row (title: null), even against another pre-posting row at the same company', () => {
    const a = job({ slug: 'acme-prospect-a', title: null, kind: 'pre_posting', ease: null });
    const b = job({ slug: 'acme-prospect-b', title: null, kind: 'pre_posting', ease: null });

    const rows = clusterJobs([a, b]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('does not require locations to differ: two identical postings still cluster, and the location list holds one entry', () => {
    const a = job({ slug: 'acme-pd-a', location: 'Remote' });
    const b = job({ slug: 'acme-pd-b', location: 'Remote' });

    const rows = clusterJobs([a, b]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row.kind !== 'cluster') throw new Error('expected a cluster row');
    expect(row.cluster.postings).toHaveLength(2);
    expect(row.cluster.locations).toEqual(['Remote']);
  });

  it('preserves the row position of the input array: a cluster lands where its first member did', () => {
    const other = job({ slug: 'globex-eng', company: 'Globex Inc', title: 'Staff Engineer', location: 'Remote' });
    const sf = job({ slug: 'acme-pd-sf', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', location: 'New York' });

    const rows = clusterJobs([other, sf, ny]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: 'single', job: other });
    expect(rows[1].kind).toBe('cluster');
  });

  it('returns an empty array for an empty input', () => {
    expect(clusterJobs([])).toEqual([]);
  });
});

// data.ts's locationDisplay() is the one place this repository trims an
// employer's own words: it drops a redundant "United States" (and its three
// short spellings) from what a location cell renders, and it must never
// touch a country that is not the United States, never leave a dangling
// separator or an empty parenthetical, and never hand back a blank cell.
// The table below is read left to right as "given this employer text, the
// cell should read this", and it is drawn from the actual location strings
// in src/data/jobs.json wherever one exercises a real pattern.
describe('locationDisplay(): drops the redundant home country, keeps everything else', () => {
  it.each([
    // Bare home-country tokens, all four spellings, with nothing else in the
    // string. Removing the only content would leave a blank cell, so each
    // one falls back to the original text rather than rendering nothing.
    ['United States', 'United States'],
    ['USA', 'USA'],
    ['U.S.', 'U.S.'],
    ['US', 'US'],
    ['(United States)', '(United States)'],

    // A parenthetical aside loses the whole aside, parens included, not an
    // empty "()" left behind.
    ['Remote (United States)', 'Remote'],
    ['Hybrid (USA)', 'Hybrid'],

    // The task's own worked example: a three part slash list with the
    // country parenthesised on the middle item.
    ['San Francisco / Remote (United States) / New York City', 'San Francisco / Remote / New York City'],

    // A foreign country is never a candidate for removal, alone or beside a
    // dropped US token.
    ['London', 'London'],
    ['Berlin', 'Berlin'],
    ['Canada', 'Canada'],
    ['Remote within Canada', 'Remote within Canada'],

    // Mixed US and foreign: only the US token drops, the foreign one and its
    // own separator survive untouched.
    ['London / United States', 'London'],
    ['United States / London', 'London'],
    ['Toronto, Canada / United States', 'Toronto, Canada'],

    // A bare token stranded between two real segments in a longer list
    // collapses to one separator, not a doubled one.
    ['SF / United States / NYC', 'SF / NYC'],

    // A US state or city name is not the country and is never touched.
    ['New York, NY', 'New York, NY'],
    ['Mountain View, CA', 'Mountain View, CA'],

    // Real fixture strings from src/data/jobs.json, unmodified apart from
    // the home country: a bullet-separated list with the country as its own
    // trailing item, and a semicolon-separated pair where "U.S." qualifies
    // the second half rather than naming a segment on its own.
    ['San Francisco, CA • New York, NY • United States', 'San Francisco, CA • New York, NY'],
    ['CA Remote (BC & ON only); U.S. Remote', 'CA Remote (BC & ON only); Remote'],

    // A comma and "or" prose list ending in the country as its final,
    // "or"-joined item: the country drops along with the connector word it
    // arrived on, and the untouched "Portland, OR" earlier in the same
    // string (the state code, upper case) is left alone.
    [
      'San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States',
      'San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada'
    ]
  ])('locationDisplay(%j) -> %j', (input, expected) => {
    expect(locationDisplay(input)).toBe(expected);
  });

  it('is pure: called twice on the same input, it returns the same string both times', () => {
    const input = 'San Francisco / Remote (United States) / New York City';
    expect(locationDisplay(input)).toBe(locationDisplay(input));
  });

  it('never mutates the string it is handed', () => {
    const input = 'San Francisco / Remote (United States) / New York City';
    const before = input;
    locationDisplay(input);
    expect(input).toBe(before);
  });
});

describe('facetsOf location for a company that has not posted', () => {
  it('is unknown for a pre_posting row and never for a posting', async () => {
    const { facetsOf, prospectRows, verifiedJobs } = await import('./data');
    const prospects = prospectRows();
    expect(prospects.length).toBeGreaterThan(0);
    for (const row of prospects) expect(facetsOf(row).location).toBe('unknown');
    for (const job of verifiedJobs()) expect(['remote', 'onsite']).toContain(facetsOf(job).location);
  });
});

describe('facetGroupsFromCounts', () => {
  it('builds the three groups from counts, drops empty bands, keeps the selected option', async () => {
    const { facetGroupsFromCounts } = await import('./data');
    const groups = facetGroupsFromCounts(
      {
        location: { all: 10, remote: 4, onsite: 6 },
        comp: { all: 10, 'under-150': 0, '150-200': 3, '200-250': 0, '250-300': 0, '300-plus': 1, 'not-listed': 6 },
        freshness: { all: 10, fresh: 2, older: 8, unknown: 0 }
      },
      { location: 'all', comp: '200-250', freshness: 'all' }
    );
    expect(groups.map((g) => g.key)).toEqual(['location', 'comp', 'freshness']);
    const comp = groups[1].options.map((o) => o.value);
    expect(comp).toEqual(['all', '150-200', '200-250', '300-plus', 'not-listed']);
    expect(groups[1].options.find((o) => o.value === '200-250')?.count).toBe(0);
    expect(groups[2].options.map((o) => o.value)).toEqual(['all', 'fresh', 'older']);
  });
  it('drops every group over an empty set, unless the address names a value in it', async () => {
    const { facetGroupsFromCounts } = await import('./data');
    const counts = { location: { all: 0, remote: 0, onsite: 0 }, comp: { all: 0, 'not-listed': 0 }, freshness: { all: 0, older: 0 } };
    expect(facetGroupsFromCounts(counts, { location: 'all', comp: 'all', freshness: 'all' })).toEqual([]);
    expect(facetGroupsFromCounts(counts, { location: 'remote', comp: 'all', freshness: 'all' }).map((g) => g.key)).toEqual(['location']);
  });
});

// compTop() is the comp SORT key; compShortFromText() is what the comp cell
// DISPLAYS. They used to read comp_posted with two different regexes and
// disagree — a "k"-less, comma-formatted range ("$150,000 - $250,000")
// rendered a real range but sorted as if comp_posted were null. These pin
// that they now agree on which strings carry a stated figure, and that a
// full-dollar figure lands in the same unit as a "k" figure.
describe('compTop(): the comp sort key agrees with what the cell displays', () => {
  it('reads a "k" figure the same as always', () => {
    expect(compTop(job({ comp_posted: '$204k-$348k' }))).toBe(348);
    expect(compTop(job({ comp_posted: '$300k-$450k + equity' }))).toBe(450);
    expect(compTop(job({ comp_posted: '$150K' }))).toBe(150);
    expect(compTop(job({ comp_posted: '$150.5k' }))).toBe(150.5);
  });

  it('reads a full-dollar, comma-formatted figure and normalises it to the same unit as a "k" figure', () => {
    expect(compTop(job({ comp_posted: '$150,000' }))).toBe(150);
    expect(compTop(job({ comp_posted: '$150,000 - $250,000' }))).toBe(250);
    expect(compTop(job({ comp_posted: 'USD $150,000 - $250,000 DOE' }))).toBe(250);
    // Same money, either spelling: this is the normalisation the display
    // already assumed and the old sort key did not apply.
    expect(compTop(job({ comp_posted: '$150,000' }))).toBe(compTop(job({ comp_posted: '$150k' })));
  });

  it('is null for a string with no figure, and for no comp_posted at all', () => {
    expect(compTop(job({ comp_posted: 'Compensation commensurate with experience' }))).toBeNull();
    expect(compTop(job({ comp_posted: null }))).toBeNull();
  });

  it('does not let a small, "k"-less figure (plausibly hourly, not annual) sort as a real salary', () => {
    const hourly = compTop(job({ comp_posted: '$45/hr' }));
    const salary = compTop(job({ comp_posted: '$150,000' }));
    expect(hourly).not.toBeNull();
    expect(hourly as number).toBeLessThan(1);
    expect(hourly as number).toBeLessThan(salary as number);
  });

  // compShortFromText() only ever fires for the few postings with no
  // structured comp_range, and even then only recognises a two-sided range
  // (it requires a separator); a bare single figure like "$150,000" or
  // "$150k" with no dash was already null there before this ticket, and
  // staying null is the display staying exactly as it renders today (the
  // ticket's own constraint). So the guarantee this fix owes is one
  // direction only: whenever the cell WOULD show a figure, the sort must
  // not treat the row as unpaid. The reverse (sort non-null, display null)
  // is the pre-existing "bare figure, no range, no comp_range" case and is
  // untouched by this change.
  it('is non-null whenever compShortFromText() would show a figure (the reported defect, fixed)', () => {
    const strings = [
      '$204k-$348k',
      '$300k-$450k + equity',
      '$150,000 - $250,000',
      'USD $150,000 - $250,000 DOE',
      'Compensation commensurate with experience',
      null
    ];
    for (const text of strings) {
      const displayed = compShortFromText(text);
      const sorted = compTop(job({ comp_posted: text }));
      if (displayed !== null) expect(sorted).not.toBeNull();
    }
  });
});
