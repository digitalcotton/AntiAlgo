import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Board from './Board.astro';
import type { FilterGroup, Job } from '../lib/data';
import { DEFAULT_QUERY } from '../lib/board-query';

/**
 * Board.astro's two modes, rendered against the real component. Server mode
 * (the board) holds one page the store sliced, and every control is a form or
 * a link; client mode (the Pre-List) is unchanged and keeps its island pager.
 * Neither mode carries the assurance band's count line or the insight strip.
 */
function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', slug: 'acme-staff-designer', company: 'Acme Corp', title: 'Staff Product Designer', kind: 'posted',
    prospect: null, comp_posted: '$150K - $180K', comp_range: null, published_at: null, location: 'Remote', remote: true,
    source_system: 'greenhouse', source_url: 'https://boards.example.com/acme/1', apply_url: 'https://boards.example.com/acme/1/apply',
    first_observed: '2026-08-01', last_verified: '2026-08-23T07:30:02Z', published_date: '2026-08-01', age_days: 22,
    status: 'live', window: null, risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: null, ...overrides
  };
}
const GROUPS: FilterGroup[] = [
  { key: 'location', label: 'Location', options: [{ value: 'all', label: 'All', count: 3 }, { value: 'remote', label: 'Remote', count: 2 }] }
];
const JOBS = [job(), job({ id: 'job-2', slug: 'acme-lead', title: 'Lead Designer' })];

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Board, { props: { active: 'board', prospectCount: 3, boards: 79, verifiedLive: 1913, ...props } });
}

describe('Board.astro in server mode', () => {
  it('holds one page, links the sort, forms the filters, and carries no band, no strip, no island', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', boardPath: '/jobs/board', groups: GROUPS,
      query: { ...DEFAULT_QUERY, location: 'remote', page: 2 },
      page: { total: 120, page: 2, pages: 3, per: 50 }, ageJobs: JOBS
    });
    expect(html).toContain('data-board-mode="server"');
    expect(html).toContain('data-paging="server"');
    expect(html).not.toContain('data-signature-moment');
    expect(html).not.toContain('Every posted row verified this sweep');
    expect(html).not.toContain('45% of applications');
    expect(html).not.toContain('data-page-step');
    expect(html).not.toContain('data-index-error');
    expect(html).toMatch(/<form class="filters-row"[^>]*method="get"/);
    // The arrangement is written under its canonical name (`remote=`); the
    // query here names only the old `location`, which boardHref reads as the same thing.
    expect(html).toMatch(/<a class="segment"[^>]*href="\/jobs\/board\?remote=remote&(amp;|#38;)?sort=comp"[^>]*data-sort-key="comp"/);
    expect(html).toMatch(/href="\/jobs\/board\?remote=remote" rel="prev"/);
    expect(html).toMatch(/href="\/jobs\/board\?remote=remote&(amp;|#38;)?page=3" rel="next"/);
    expect(html).toContain('Rows 51 to 100 of 120');
    expect(html).toContain('Page 2 of 3');
  });
  it('an empty page offers a link that clears the filters', async () => {
    const html = await render({
      jobs: [], mode: 'server', boardPath: '/jobs/board', groups: GROUPS,
      query: { ...DEFAULT_QUERY, location: 'remote', q: 'zzz' },
      page: { total: 0, page: 1, pages: 1, per: 50 }, ageJobs: JOBS
    });
    expect(html).toMatch(/<a class="clear-filters"[^>]*href="\/jobs\/board"/);
    expect(html).toContain('No rows');
  });
});

describe('Board.astro in client mode (the Pre-List)', () => {
  it('still pages in the browser with the island pager, and carries no band or strip either', async () => {
    const html = await render({ jobs: JOBS });
    expect(html).toContain('data-board-mode="client"');
    expect(html).toContain('data-paging="client"');
    expect(html).toMatch(/<button class="step" type="button" data-page-step="-1"/);
    expect(html).toContain('data-index-error');
    expect(html).not.toContain('45% of applications');
    expect(html).not.toContain('Rows 1-');
  });
});

// ---------------------------------------------------------------------------
// The strip of the stated facts, the Field as links under the results, the
// close-spelling notice, Best, and the ranking sentence on a row (2026-10-02).
// ---------------------------------------------------------------------------

import { facetGroupsFromCounts } from '../lib/data';
import { boardRowToJob, type BoardMatchColumns, type BoardRow } from '../lib/board-jobs';

const COUNTS = {
  total: 120,
  location: {}, comp: {}, freshness: {},
  remote: { all: 120, remote: 40, hybrid: 10, onsite: 65, unstated: 5 },
  pay: { any: 120, notListed: 60, floors: { '100': 30, '150': 20, '200': 8, '250': 0, '300': 0 } },
  place: { countries: { US: 70, GB: 30, CA: 20 }, notStated: 0 },
  // Seven families with rows, a family with none, and Not placed: the links are the
  // top five, never Not placed, never a zero.
  family: { all: 120, software: 50, design: 30, sales: 12, legal: 9, finance: 7, health: 6, marketing: 3, unplaced: 25, support: 0 }
};
const SERVED = { page: { total: 120, page: 1, pages: 24, per: 5 }, boardPath: '/board' };

function servedGroups(selection: Record<string, unknown> = {}) {
  return facetGroupsFromCounts(COUNTS, { location: 'all', comp: 'all', freshness: 'all', ...selection });
}

describe('Board.astro: the strip is Location, Remote and Comp, and carries the Field it no longer draws', () => {
  it('draws the three cells from the groups, and keeps the Field a reader chose as a hidden fam field', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', ...SERVED,
      groups: servedGroups(),
      query: { ...DEFAULT_QUERY, families: ['design'] }
    });
    expect(html).toContain('data-filter-group="place"');
    expect(html).toContain('data-filter-multi="remote"');
    expect(html).toContain('data-filter-group="pay_min"');
    expect(html).not.toContain('data-filter-group="fam"');
    const form = html.match(/<form class="filters-row"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
    // Field left the strip, so nothing in the form submits fam: it is carried, or
    // choosing a Remote option would drop the field the reader picked.
    expect(form).toMatch(/<input type="hidden" name="fam" value="design"/);
  });

  it('hands the strip the address\'s own place, floor and arrangements as what is chosen', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', ...SERVED,
      groups: servedGroups({ place: 'GB', payMin: 150, remote: ['remote', 'hybrid'] }),
      query: { ...DEFAULT_QUERY, place: 'GB', payMin: 150, remote: ['remote', 'hybrid'], location: 'all' }
    });
    expect(html).toMatch(/<option value="GB"[^>]*selected/);
    expect(html).toMatch(/<option value="150"[^>]*selected/);
    const boxes = [...html.matchAll(/<input type="checkbox"[^>]*name="remote"[^>]*>/g)].map((m) => m[0]);
    expect(boxes.filter((b) => /\schecked/.test(b)).map((b) => b.match(/value="([^"]+)"/)![1])).toEqual(['remote', 'hybrid']);
    // No hidden twin of what the strip submits.
    const form = html.match(/<form class="filters-row"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
    for (const name of ['place', 'remote', 'pay_min', 'comp', 'location']) {
      expect(form).not.toMatch(new RegExp(`<input type="hidden" name="${name}"`));
    }
  });
});

describe('Board.astro: "Fields these roles are filed under" under the results', () => {
  const links = (html: string) => [...html.matchAll(/<a class="same-field-link"[^>]*href="([^"]*)"[^>]*data-field="([^"]*)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g)].map((m) => ({
    href: m[1].replace(/&#38;|&amp;/g, '&'), id: m[2], label: m[3], count: m[4]
  }));

  it('is the five biggest families by count, as links to fam=<id>, with no Not placed and no zero', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: { ...DEFAULT_QUERY, remote: ['remote'], location: 'remote' }
    });
    expect(html).toContain('data-same-field');
    expect(html).toContain('aria-label="Fields these roles are filed under"');
    expect(html).toContain('Fields these roles are filed under');
    const found = links(html);
    expect(found.map((l) => [l.id, l.count])).toEqual([['software', '50'], ['design', '30'], ['sales', '12'], ['legal', '9'], ['finance', '7']]);
    // Each link keeps the reader's other filters and moves the field, from page one.
    expect(found[0].href).toBe('/board?remote=remote&fam=software');
    expect(found.some((l) => l.id === 'unplaced' || l.id === 'support')).toBe(false);
    // And it says what the list is: a classification, not a stated fact.
    expect(html).toContain('A classification of the title, not something the employer stated.');
    // They are navigation, not strip controls: nothing in the form submits them.
    const form = html.match(/<form class="filters-row"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
    expect(form).not.toContain('same-field');
  });

  it('shows the chosen field, even outside the top five, and a way back to every field', async () => {
    const html = await render({
      jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: { ...DEFAULT_QUERY, families: ['marketing'] }
    });
    const found = links(html);
    expect(found.map((l) => l.id)).toEqual(['software', 'design', 'sales', 'legal', 'finance', 'marketing']);
    const current = html.match(/<a class="same-field-link"[^>]*aria-current="true"[^>]*data-field="([^"]*)"/)?.[1];
    expect(current).toBe('marketing');
    // The "All fields" link is the address without fam, with the count of every field.
    expect(html).toMatch(/<a class="same-field-link" href="\/board"[^>]*>\s*<span[^>]*>All fields<\/span>\s*<span[^>]*>120<\/span>/);
  });

  it('is not drawn on the home teaser, without a Field group, or in client mode', async () => {
    const teaser = await render({ jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: DEFAULT_QUERY, teaser: true });
    expect(teaser).not.toContain('data-same-field');
    const noFamily = await render({
      jobs: JOBS, mode: 'server', ...SERVED,
      groups: facetGroupsFromCounts({ ...COUNTS, family: undefined }, { location: 'all', comp: 'all', freshness: 'all' }),
      query: DEFAULT_QUERY
    });
    expect(noFamily).not.toContain('data-same-field');
    expect(await render({ jobs: JOBS })).not.toContain('data-same-field');
  });

  it('"Clear the filters" clears the field too: it is not on the strip, so it cannot be the reason a page stays empty', async () => {
    const html = await render({
      jobs: [], mode: 'server', boardPath: '/board', page: { total: 0, page: 1, pages: 1, per: 5 }, groups: servedGroups(),
      query: { ...DEFAULT_QUERY, families: ['design'], remote: ['remote'], location: 'remote', q: 'zzz' }
    });
    expect(html).toMatch(/<a class="clear-filters"[^>]*href="\/board"/);
  });
});

describe('Board.astro: close spellings are said before the first row', () => {
  it('prints the notice, with the words typed, only when the result is fuzzy', async () => {
    const base = { jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: { ...DEFAULT_QUERY, q: 'prodct desiner', sort: 'best' } };
    const fuzzy = await render({ ...base, fuzzy: true });
    expect(fuzzy).toMatch(/<p class="fuzzy-notice"[^>]*role="status"[^>]*>\s*No exact matches for "prodct desiner"\. Showing close spellings\.\s*<\/p>/);
    expect(fuzzy.indexOf('fuzzy-notice')).toBeLessThan(fuzzy.indexOf('data-job-row'));
    expect(await render({ ...base, fuzzy: false })).not.toContain('fuzzy-notice');
    expect(await render(base)).not.toContain('fuzzy-notice');
    // Nothing to show, nothing to be above: the empty state speaks instead.
    expect(await render({ ...base, fuzzy: true, jobs: [], page: { total: 0, page: 1, pages: 1, per: 5 } })).not.toContain('fuzzy-notice');
    // No words, no notice, whatever the flag says.
    expect(await render({ ...base, fuzzy: true, query: DEFAULT_QUERY })).not.toContain('fuzzy-notice');
    // The notice quotes the words as the reader typed them, escaped like any text.
    const hostile = await render({ ...base, fuzzy: true, query: { ...base.query, q: '<b>x</b>' } });
    const notice = hostile.match(/<p class="fuzzy-notice"[\s\S]*?<\/p>/)?.[0] ?? '';
    expect(notice).not.toContain('<b>');
    expect(notice).toContain('No exact matches for "&lt;b&gt;x&lt;/b&gt;"');
  });
});

describe('Board.astro: the order in force is said once, above the rows, for a reader with no why panel', () => {
  // The browser reads &quot; as the straight quote it is; the test reads it the same way.
  const lineOf = (html: string) => html.match(/<p class="order-notice"[^>]*data-order-reason[^>]*>\s*([\s\S]*?)\s*<\/p>/)?.[1]?.replace(/&quot;/g, '"');
  const BLIND = { jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), fit: false };

  it('says best match, in rankReason\'s words and in the order the SQL uses, for a signed-out reader who typed words', async () => {
    const html = await render({ ...BLIND, query: { ...DEFAULT_QUERY, q: 'designer', sort: 'best' } });
    expect(lineOf(html)).toBe(
      'Ordered by best match: where your words are found (the title, then the company name, then the rest of the posting), then the closer text match, then newer first.'
    );
    // Exactly one, server-rendered, above the first row, and it never names the number they cannot see.
    expect(html.match(/data-order-reason/g)).toHaveLength(1);
    expect(html.indexOf('data-order-reason')).toBeLessThan(html.indexOf('data-job-row'));
    expect(lineOf(html)).not.toMatch(/Deets/);
    for (const codePoint of [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d]) expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
  });

  it('says age for the bare board, because their unwritten Deets default is served as the age order', async () => {
    const bare = await render({ ...BLIND, query: DEFAULT_QUERY });
    expect(lineOf(bare)).toBe('Ordered by age: newest first, roles with no date last, then company and title A to Z.');
    // The sort they chose is the sort said.
    expect(lineOf(await render({ ...BLIND, query: { ...DEFAULT_QUERY, sort: 'age' } }))).toBe(lineOf(bare));
    expect(lineOf(await render({ ...BLIND, query: { ...DEFAULT_QUERY, sort: 'comp' } }))).toBe(
      'Ordered by pay: highest posted figure first, roles that post none last, then company and title A to Z.'
    );
    // And a chosen sort wins over best while words are typed.
    expect(lineOf(await render({ ...BLIND, query: { ...DEFAULT_QUERY, q: 'designer', sort: 'comp' } }))).toMatch(/^Ordered by pay:/);
  });

  it('says the typo path\'s order under the close-spelling notice, quoting what was typed once, escaped', async () => {
    const html = await render({ ...BLIND, fuzzy: true, query: { ...DEFAULT_QUERY, q: 'prodct desiner', sort: 'best' } });
    expect(lineOf(html)).toBe('Ordered by best match: the closest spelling of "prodct desiner" first, then newer first.');
    // The notice says which population this is; the order line says how it is ordered; both above the rows, in that order.
    expect(html.indexOf('fuzzy-notice')).toBeLessThan(html.indexOf('data-order-reason'));
    expect(html.indexOf('data-order-reason')).toBeLessThan(html.indexOf('data-job-row'));
    const hostile = await render({ ...BLIND, fuzzy: true, query: { ...DEFAULT_QUERY, q: '<b>x</b>', sort: 'best' } });
    expect(lineOf(hostile)).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(lineOf(hostile)).not.toContain('<b>');
  });

  it('is not drawn for a signed-in reader, who has the per-row line and is not told twice', async () => {
    const rows = [boardRowToJob(storedRow('1', { match_tier: 1, match_field: 'title' }))];
    const html = await render({
      jobs: rows, mode: 'server', boardPath: '/board', groups: servedGroups(), fit: true,
      page: { total: 1, page: 1, pages: 1, per: 5 }, query: { ...DEFAULT_QUERY, q: 'product designer', sort: 'best' }
    });
    expect(html).not.toContain('data-order-reason');
    expect(html).not.toContain('order-notice');
    // They keep the per-row sentence, in the panel.
    expect([...html.matchAll(/data-rank-reason/g)]).toHaveLength(1);
    // And the blind reader has the line and no per-row sentence: one statement of the order each, never both.
    const blind = await render({
      jobs: rows, mode: 'server', boardPath: '/board', groups: servedGroups(), fit: false,
      page: { total: 1, page: 1, pages: 1, per: 5 }, query: { ...DEFAULT_QUERY, q: 'product designer', sort: 'best' }
    });
    expect(blind).toContain('data-order-reason');
    expect(blind).not.toContain('data-rank-reason');
  });

  it('is not drawn where there is nothing to be above or nothing to order: no rows, the teaser, the Pre-List', async () => {
    const query = { ...DEFAULT_QUERY, q: 'designer', sort: 'best' };
    expect(await render({ ...BLIND, jobs: [], page: { total: 0, page: 1, pages: 1, per: 5 }, query })).not.toContain('data-order-reason');
    expect(await render({ ...BLIND, teaser: true, query })).not.toContain('data-order-reason');
    expect(await render({ jobs: JOBS, fit: false })).not.toContain('data-order-reason');
  });
});

describe('Board.astro: Best is the pressed sort while words are typed', () => {
  const segments = (html: string) => [...html.matchAll(/<a class="segment"[^>]*>/g)].map((m) => ({
    key: m[0].match(/data-sort-key="([^"]+)"/)![1], pressed: m[0].includes('aria-current="true"'), href: m[0].match(/href="([^"]*)"/)![1].replace(/&#38;|&amp;/g, '&')
  }));

  it('offers Best first with words, pressed when sort=best, and Deets, Comp and Age after it', async () => {
    const html = await render({ jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: { ...DEFAULT_QUERY, q: 'designer', sort: 'best' } });
    const found = segments(html);
    expect(found.map((s) => s.key)).toEqual(['best', 'fit', 'comp', 'age']);
    expect(found.filter((s) => s.pressed).map((s) => s.key)).toEqual(['best']);
    // Best is the default for words, so its link is the bare address with the words.
    expect(found[0].href).toBe('/board?q=designer');
    expect(found[2].href).toBe('/board?q=designer&sort=comp');
    expect(html).toMatch(/>\s*Best\s*</);
  });

  it('presses the sort the reader chose over Best, and has no Best without words', async () => {
    const chose = segments(await render({ jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: { ...DEFAULT_QUERY, q: 'designer', sort: 'comp' } }));
    expect(chose.filter((s) => s.pressed).map((s) => s.key)).toEqual(['comp']);
    const bare = segments(await render({ jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), query: DEFAULT_QUERY }));
    expect(bare.map((s) => s.key)).toEqual(['fit', 'comp', 'age']);
    expect(bare.filter((s) => s.pressed).map((s) => s.key)).toEqual(['fit']);
  });

  it('leaves Best out for a reader who cannot see Deets, and still presses it', async () => {
    const html = await render({ jobs: JOBS, mode: 'server', ...SERVED, groups: servedGroups(), fit: false, query: { ...DEFAULT_QUERY, q: 'designer', sort: 'best' } });
    const found = segments(html);
    expect(found.map((s) => s.key)).toEqual(['best', 'comp', 'age']);
    expect(found.filter((s) => s.pressed).map((s) => s.key)).toEqual(['best']);
  });
});

/** A row as the store returns it, so the adapter stamps the match facts the
    ranking sentence reads (a hand-built Job carries none, and draws no line). */
function storedRow(id: string, over: Partial<BoardRow> & BoardMatchColumns = {}): BoardRow & BoardMatchColumns {
  return {
    id: `greenhouse|${id}`, slug: `acme-designer-${id}`, company: 'Acme', title: 'Product Designer',
    url: 'https://boards.greenhouse.io/acme/jobs/1', location: 'Remote', country: 'US', remote: true,
    published: '2026-08-20T09:00:00.000Z', ats: 'greenhouse', posting_id: id, department: 'Design',
    comp_posted: null, comp_range: null, days_up: 5, first_seen: '2026-08-30', last_seen: '2026-09-08',
    detail_total: 80, detail_components: { title_scope: 30, remote_geo: 25, comp: 0, freshness: 15, apply_friction: 10 },
    source: 'tracked', description: null, status: 'live', kill_id: null, kill_rule: null, kill_reason: null,
    killed_on: null, kill_first_published: null, kill_pipeline: null,
    match_tier: null, match_field: null, fuzzy_score: null,
    ...over
  };
}

describe('Board.astro: each row says why it sits where it sits', () => {
  it('opens a row\'s why panel on a "Ranked ..." line, numbered from the page\'s offset', async () => {
    const html = await render({
      jobs: [boardRowToJob(storedRow('1')), boardRowToJob(storedRow('2', { company: 'Bolt' }))],
      mode: 'server', boardPath: '/board', groups: servedGroups(),
      page: { total: 120, page: 3, pages: 24, per: 5 },
      query: { ...DEFAULT_QUERY, page: 3 }
    });
    const lines = [...html.matchAll(/<p class="rank-reason"[^>]*data-rank-reason[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
    // Page 3 at five a page starts at the eleventh row.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Ranked 11th by Deets: /);
    expect(lines[1]).toMatch(/^Ranked 12th by Deets: /);
  });

  it('names the words\' own order when words are typed, and never claims one the rows are not in', async () => {
    const html = await render({
      jobs: [boardRowToJob(storedRow('1', { match_tier: 1, match_field: 'title' }))],
      mode: 'server', boardPath: '/board', groups: servedGroups(),
      page: { total: 1, page: 1, pages: 1, per: 5 },
      query: { ...DEFAULT_QUERY, q: 'product designer', sort: 'best' }
    });
    const lines = [...html.matchAll(/<p class="rank-reason"[^>]*data-rank-reason[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(lines).toEqual(['Ranked 1st: every word you typed is in the title, then the closer text match, then Deets 80, then newer first.']);
  });

  it('writes no ranking sentence for a reader who cannot see Deets', async () => {
    const html = await render({
      jobs: [boardRowToJob(storedRow('1'))], mode: 'server', boardPath: '/board', groups: servedGroups(), fit: false,
      page: { total: 2, page: 1, pages: 1, per: 5 }, query: DEFAULT_QUERY
    });
    expect(html).not.toContain('data-rank-reason');
  });
});
