import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import Filters from './Filters.astro';
import type { FilterGroup } from '../lib/data';

// AstroContainer's renderToString(), used below for the markup shape, emits
// the component's own <script> as an external `<script type="module"
// src="...">` reference rather than inlining its source, so the script's
// own contract (one account fetch, one suppressedSlugs array, both bullets
// reading it) is checked against the component's raw source text instead.
const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'Filters.astro'), 'utf-8');

/**
 * A render test for Filters.astro's desktop one-line control row, the
 * folded-in seen dimmer, and the applied tag's data wiring.
 *
 * Rendered against the real component (AstroContainer), same technique as
 * JobRow.render.test.ts and JobTable.render.test.ts: nothing here is
 * stubbed. A render test cannot execute the client <script> (AstroContainer
 * only ever produces server HTML), so what is pinned here is the markup
 * shape a script depends on and the script's own source for the one-fetch,
 * one-slug-set contract this task's report describes; the script's actual
 * runtime behaviour (a signed-in fetch revealing the tag) is what the
 * orchestrator's browser pass verifies.
 */

const GROUPS: FilterGroup[] = [
  {
    key: 'location',
    label: 'Location',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: 'remote', label: 'Remote', count: 2 }
    ]
  },
  {
    key: 'comp',
    label: 'Comp',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: 'stated', label: 'Stated', count: 2 }
    ]
  },
  {
    key: 'freshness',
    label: 'Freshness',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: 'new', label: 'New this sweep', count: 1 }
    ]
  }
];

async function renderFilters(): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Filters, { props: { groups: GROUPS } });
}

describe('Filters.astro: the control row reads as one set, the dimmer folded in', () => {
  it('wraps search, every group select and the seen dimmer inside one .filters-row', async () => {
    const html = await renderFilters();
    // AstroContainer's server render appends its own data-astro-cid and
    // data-astro-source-* attributes after every author-written one, so the
    // opening tag is matched up to its first ">" rather than as a literal
    // `class="filters-row">` string.
    const rowMatch = html.match(/<div class="filters-row"[^>]*>([\s\S]*?)<\/div>/);
    expect(rowMatch).not.toBeNull();
    const row = rowMatch![1];
    expect(row).toContain('data-job-search');
    expect(row).toContain('data-filter-group="location"');
    expect(row).toContain('data-filter-group="comp"');
    expect(row).toContain('data-filter-group="freshness"');
    expect(row).toContain('data-seen-dimmer-toggle');
  });

  it('gives the seen dimmer the same filter-toggle chip class as before (skin change, not removal)', async () => {
    const html = await renderFilters();
    expect(html).toContain('class="filter filter-toggle"');
    expect(html).toContain('data-seen-dimmer-toggle checked');
  });

});

describe('Filters.astro: the applied tag reuses the one account fetch, no second endpoint', () => {
  it('calls fetch only against accountFiltersUrl: no new endpoint introduced for the tag', async () => {
    // Two calls predate this task (the POST that saves a filter selection,
    // the GET that reads it back plus suppressedSlugs) and both already
    // target accountFiltersUrl, i.e. /settings/filters. This pins that count
    // rather than a literal 1, so a real second endpoint added later fails
    // it, while still proving nothing third was introduced here.
    const fetchCalls = SOURCE.match(/\bfetch\(/g) ?? [];
    expect(fetchCalls).toHaveLength(2);

    const fetchTargets = SOURCE.match(/\bfetch\(([^,)\n]+)/g) ?? [];
    expect(fetchTargets).toHaveLength(2);
    for (const call of fetchTargets) {
      expect(call).toContain('accountFiltersUrl');
    }
  });

  it('sets data-applied from the one suppressedSlugs array the account probe fills', async () => {
    expect(SOURCE).toContain("row.toggleAttribute('data-applied'");
    expect(SOURCE).toContain('function applyAppliedTag');
    // One array, assigned once: no second "suppressedSlugs =" assignment
    // anywhere, which would mean a second, independently-derived set.
    const assignments = SOURCE.match(/\bsuppressedSlugs\s*=[^=]/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(SOURCE).toContain('const appliedSet = new Set(suppressedSlugs)');
    // No row is ever hidden for having been applied to (owner decision, 2026-09-19).
    expect(SOURCE).not.toContain('data-suppression-note');
    expect(SOURCE).not.toContain('function applySuppression');
  });
});

describe('Filters.astro: the strip and its options', () => {
  it('prints option labels without counts, carries the count as data, and disables a dead option', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Filters, {
      props: {
        groups: [{ key: 'comp', label: 'Comp', options: [
          { value: 'all', label: 'All', count: 3 },
          { value: '150-200', label: '$150K to $200K', count: 0 },
          { value: 'not-listed', label: 'Not listed', count: 3 }
        ] }]
      }
    });
    expect(html).toMatch(/<option value="all"[^>]*data-count="3"[^>]*>\s*All\s*<\/option>/);
    expect(html).not.toContain('All (3)');
    expect(html).toMatch(/<option value="150-200"[^>]*disabled/);
    expect(html).not.toMatch(/<option value="not-listed"[^>]*disabled/);
    expect(html).toContain('<slot name="sort">'.length ? 'data-seen-dimmer-toggle' : '');
    expect(html).toContain('>Dim seen<');
    expect(html).toContain('data-toggle-on');
  });
});

describe('Filters.astro: carries no em dash, en dash, or curly quote', () => {
  it('renders with none of the forbidden characters anywhere in its output', async () => {
    const html = await renderFilters();
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});

describe('Filters.astro: server mode is one GET form, the address is the state', () => {
  async function renderServer(): Promise<string> {
    const container = await AstroContainer.create();
    return container.renderToString(Filters, {
      props: {
        groups: GROUPS,
        mode: 'server',
        action: '/jobs/board',
        query: 'design',
        selected: { location: 'remote', comp: 'all', freshness: 'all' },
        hidden: [['sort', 'age'], ['per', '100']]
      }
    });
  }
  it('renders the control row as a GET form with named fields and an Apply button', async () => {
    const html = await renderServer();
    expect(html).toMatch(/<form class="filters-row"[^>]*method="get"[^>]*action="\/jobs\/board"/);
    expect(html).toContain('data-filters-mode="server"');
    expect(html).toContain('data-board-path="/jobs/board"');
    expect(html).toMatch(/<input type="search"[^>]*name="q"[^>]*value="design"/);
    expect(html).toMatch(/<select[^>]*data-filter-group="location"[^>]*name="location"[^>]*data-autosubmit/);
    expect(html).toMatch(/<input type="hidden" name="sort" value="age"/);
    expect(html).toMatch(/<input type="hidden" name="per" value="100"/);
    expect(html).toMatch(/<button class="filter-apply mono-label"[^>]*type="submit"[^>]*>Apply<\/button>/);
    expect(html).toMatch(/<option value="remote"[^>]*selected/);
  });
  it('keeps the seen dimmer in the row but out of the submission (no name), and never a page field', async () => {
    const html = await renderServer();
    const dimmer = html.match(/<input type="checkbox"[^>]*data-seen-dimmer-toggle[^>]*>/)?.[0] ?? '';
    expect(dimmer).not.toContain('name=');
    expect(html).not.toContain('name="page"');
  });
  it('client mode is unchanged: a div, no names, no Apply', async () => {
    const html = await renderFilters();
    expect(html).toMatch(/<div class="filters-row"/);
    expect(html).not.toContain('name="location"');
    expect(html).not.toContain('filter-apply');
    expect(html).toContain('data-filters-mode="client"');
  });
});

describe('Filters.astro: the title menu (server mode, a member with Desk titles)', () => {
  async function renderServer(props: Record<string, unknown>): Promise<string> {
    const container = await AstroContainer.create();
    return container.renderToString(Filters, { props: { groups: GROUPS, mode: 'server', action: '/board', ...props } });
  }

  it('renders no chevron and no title field when there are no titles, or in client mode', async () => {
    expect(await renderServer({})).not.toContain('data-title-menu');
    expect(await renderServer({ titleChoices: { core: [], stretch: [] } })).not.toContain('data-title-menu');
    const container = await AstroContainer.create();
    const client = await container.renderToString(Filters, {
      props: { groups: GROUPS, titleChoices: { core: ['Product Designer'], stretch: [] } }
    });
    expect(client).not.toContain('data-title-menu');
  });

  it('lists core then stretch as title= checkboxes inside the form, with the address\'s picks checked', async () => {
    const html = await renderServer({
      titleChoices: { core: ['Product Designer'], stretch: ['Design Lead', 'Head of Design'] },
      selectedTitles: ['Design Lead']
    });
    expect(html).toContain('data-title-menu');
    const formMatch = html.match(/<form class="filters-row"[^>]*>([\s\S]*?)<\/form>/);
    expect(formMatch).not.toBeNull();
    const form = formMatch![1];
    const boxes = form.match(/<input type="checkbox" name="title" value="[^"]+"[^>]*>/g) ?? [];
    expect(boxes.map((b) => b.match(/value="([^"]+)"/)![1])).toEqual(['Product Designer', 'Design Lead', 'Head of Design']);
    expect(boxes.filter((b) => / checked/.test(b)).map((b) => b.match(/value="([^"]+)"/)![1])).toEqual(['Design Lead']);
    expect(form.indexOf('>Core<')).toBeLessThan(form.indexOf('>Stretch<'));
  });
});

// ---------------------------------------------------------------------------
// The strip of the stated facts (2026-10-02): Location, Remote, Comp. Rendered
// from the groups facetGroupsFromCounts builds, so the markup under test is the
// markup the board gets, zero options and all.
// ---------------------------------------------------------------------------

const COUNTS = {
  total: 6,
  location: {}, comp: {}, freshness: {},
  remote: { all: 6, remote: 1, hybrid: 0, onsite: 5, unstated: 0 },
  pay: { any: 6, notListed: 3, floors: { '100': 3, '150': 1, '200': 0, '250': 0, '300': 0 } },
  place: { countries: { US: 3, CA: 1, IN: 1, GB: 1 }, notStated: 0 },
  family: { all: 6, design: 4, software: 2, unplaced: 0 }
};
const NONE = { location: 'all', comp: 'all', freshness: 'all' };

async function renderStripGroups(
  selection: Record<string, unknown> = {},
  props: Record<string, unknown> = {}
): Promise<string> {
  const { facetGroupsFromCounts } = await import('../lib/data');
  const container = await AstroContainer.create();
  return container.renderToString(Filters, {
    props: {
      groups: facetGroupsFromCounts(COUNTS, { ...NONE, ...selection }),
      mode: 'server',
      action: '/board',
      selected: { place: (selection.place as string) ?? 'all', pay_min: 'all' },
      ...props
    }
  });
}

/** One cell of the strip, by what it is called, as the markup between its opening tag and the next cell's. */
function cellOf(html: string, label: string): string {
  const start = html.search(new RegExp(`<(label|div) class="filter(?: filter-multi)?"[^>]*>\\s*<span class="filter-label mono-label[^"]*"[^>]*>${label}<`));
  expect(start, `no cell labelled ${label}`).toBeGreaterThan(-1);
  const next = html.slice(start + 10).search(/<(label|div) class="filter[ "]/);
  return html.slice(start, next === -1 ? undefined : start + 10 + next);
}

describe('Filters.astro: the strip is Location, Remote and Comp, and the Field is not on it', () => {
  it('draws three cells in that order and no Field cell, though the Field group rides in the same list', async () => {
    const html = await renderStripGroups();
    const labels = [...html.matchAll(/<span class="filter-label mono-label[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // Titles is the member's menu; Dim seen is the dimmer. Neither is a group.
    expect(labels.filter((label) => !['Dim seen', 'Titles'].includes(label))).toEqual(['Location', 'Remote', 'Comp']);
    expect(html).not.toContain('data-filter-group="fam"');
    expect(html).not.toContain('name="fam"');
    expect(html).not.toContain('All fields');
    expect(html).not.toContain('>Field<');
  });

  it('writes no em dash, en dash or curly quote anywhere in the strip', async () => {
    const html = await renderStripGroups({ place: 'GB/London', payMin: 175 }, { checked: { remote: ['remote'] } });
    for (const codePoint of [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d]) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});

describe('Filters.astro: Location is geography, one select named for the place parameter', () => {
  it('is a real select named place, Worldwide first, the countries by count, Not stated last (a zero here, so muted)', async () => {
    const cell = cellOf(await renderStripGroups(), 'Location');
    expect(cell).toMatch(/<select[^>]*data-filter-group="place"[^>]*name="place"[^>]*data-autosubmit/);
    const options = [...cell.matchAll(/<option value="([^"]*)"([^>]*)>\s*([^<]*?)\s*<\/option>/g)].map((m) => ({ value: m[1], attrs: m[2], label: m[3] }));
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ['all', 'Worldwide'],
      ['US', 'United States'],
      // Three countries with one row each: ties are broken by name.
      ['CA', 'Canada'],
      ['IN', 'India'],
      ['GB', 'United Kingdom'],
      ['unstated', 'Not stated']
    ]);
    expect(options[0].attrs).toMatch(/\sselected/);
    // The counts ride as data for the script's rows.
    expect(options.map((o) => o.attrs.match(/data-count="(\d+)"/)?.[1])).toEqual(['6', '3', '1', '1', '1', '0']);
    // Not stated is a choice now, so it is refused only the way a zero is: here it has no rows.
    expect(options.at(-1)!.attrs).toMatch(/\sdisabled/);
    expect(options.slice(0, -1).every((o) => !/\sdisabled/.test(o.attrs))).toBe(true);
  });

  it('draws Not stated as a live choice named place=unstated whenever it has rows, and keeps its own label when chosen', async () => {
    const { facetGroupsFromCounts } = await import('../lib/data');
    const withRows = { ...COUNTS, place: { countries: { US: 3, CA: 1, IN: 1, GB: 1 }, notStated: 4 } };
    const render = async (place: string, chips: Record<string, unknown>[] = []) => {
      const container = await AstroContainer.create();
      return container.renderToString(Filters, {
        props: {
          groups: facetGroupsFromCounts(withRows, { ...NONE, place }),
          mode: 'server', action: '/board', selected: { place, pay_min: 'all' }, chips, chipRemoveHrefs: chips.map(() => '/board')
        }
      });
    };
    const optionOf = (cell: string, value: string) => cell.match(new RegExp(`<option value="${value}"([^>]*)>\\s*([^<]*?)\\s*</option>`));
    // Live, selectable, and carrying its count.
    let not = optionOf(cellOf(await render('all'), 'Location'), 'unstated')!;
    expect(not[1]).not.toMatch(/\sdisabled/);
    expect(not[1]).toMatch(/data-count="4"/);
    expect(not[2]).toBe('Not stated');
    // Chosen: the selected option, and the chip beside it ("Location not stated") does not rename it.
    const chip = { kind: 'place', key: 'unstated', label: 'Location not stated' };
    const chosen = cellOf(await render('unstated', [chip]), 'Location');
    not = optionOf(chosen, 'unstated')!;
    expect(not[1]).toMatch(/\sselected/);
    expect(not[2]).toBe('Not stated');
    expect(chosen).toMatch(/<option value="all"(?![^>]*selected)/);
    // The strip owns place, so the box carries no hidden copy of it.
    expect(await render('unstated', [chip])).not.toMatch(/<input type="hidden" name="place"/);
  });

  it('draws every country it is handed, a zero muted and refused, and a chosen zero live so it can be undone', async () => {
    const { facetGroupsFromCounts } = await import('../lib/data');
    const zeros = { ...COUNTS, total: 5, place: { countries: { US: 5, FR: 0, DE: 0, CA: 0 }, notStated: 0 } };
    const render = async (place: string) => {
      const container = await AstroContainer.create();
      return container.renderToString(Filters, {
        props: { groups: facetGroupsFromCounts(zeros, { ...NONE, place }), mode: 'server', action: '/board', selected: { place, pay_min: 'all' } }
      });
    };
    const options = (cell: string) => [...cell.matchAll(/<option value="([^"]*)"([^>]*)>\s*([^<]*?)\s*<\/option>/g)].map((m) => ({ value: m[1], attrs: m[2], label: m[3] }));
    const none = options(cellOf(await render('all'), 'Location'));
    // Present, in the list, after the country with rows, in name order (Canada, France, Germany).
    expect(none.map((o) => o.value)).toEqual(['all', 'US', 'CA', 'FR', 'DE', 'unstated']);
    expect(none.map((o) => o.attrs.match(/data-count="(\d+)"/)![1])).toEqual(['5', '5', '0', '0', '0', '0']);
    // ... and disabled: a zero is drawn and refused.
    expect(none.filter((o) => /\sdisabled/.test(o.attrs)).map((o) => o.value)).toEqual(['CA', 'FR', 'DE', 'unstated']);
    // The one the address already names stays live, so the reader can see what is chosen and undo it.
    const chosen = options(cellOf(await render('FR'), 'Location'));
    expect(chosen.find((o) => o.value === 'FR')!.attrs).toMatch(/\sselected/);
    expect(chosen.find((o) => o.value === 'FR')!.attrs).not.toMatch(/\sdisabled/);
    expect(chosen.filter((o) => /\sdisabled/.test(o.attrs)).map((o) => o.value)).toEqual(['CA', 'DE', 'unstated']);
  });

  it('holds a city the address chose as its own selected option, labelled like the chip beside it', async () => {
    const html = await renderStripGroups(
      { place: 'GB/London' },
      { chips: [{ kind: 'place', key: 'GB/London', label: 'London, UK' }], chipRemoveHrefs: ['/board'] }
    );
    const cell = cellOf(html, 'Location');
    expect(cell).toMatch(/<option value="GB\/London"[^>]*selected[^>]*>\s*London, UK\s*<\/option>/);
    // The list still offers the countries, and Worldwide is no longer the chosen one.
    expect(cell).toMatch(/<option value="GB"/);
    expect(cell).toMatch(/<option value="all"(?![^>]*selected)/);
    // With no chip to name it, the key's own reading is used.
    const bare = cellOf(await renderStripGroups({ place: 'US-MD' }), 'Location');
    expect(bare).toMatch(/<option value="US-MD"[^>]*selected[^>]*>\s*Maryland\s*<\/option>/);
  });

  it('is one state with the chip: the strip submits place, so the box carries no hidden copy of it', async () => {
    const html = await renderStripGroups(
      { place: 'GB/London', remote: ['remote'], payMin: 150 },
      {
        chips: [
          { kind: 'place', key: 'GB/London', label: 'London, UK' },
          { kind: 'remote', value: 'remote' },
          { kind: 'pay', minK: 150 },
          { kind: 'company', name: 'Acme' },
          { kind: 'age', maxDays: 7 }
        ],
        chipRemoveHrefs: ['/a', '/b', '/c', '/d', '/e'],
        selected: { place: 'GB/London', pay_min: '150' }
      }
    );
    const hidden = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => m[0].match(/name="([^"]+)"/)![1]);
    // The strip's own fields submit place, remote and pay_min; a hidden twin of any of them is
    // the stale second answer that makes an unticked box tick itself again.
    expect(hidden).not.toContain('place');
    expect(hidden).not.toContain('remote');
    expect(hidden).not.toContain('pay_min');
    // What the strip does not own, the box still carries.
    expect(hidden).toContain('company');
    expect(hidden).toContain('age_max');
    // The controls show place, remote and pay, so the box draws no chip for them
    // (owner, 2026-10-02: the same words twice, stacked over the field); company
    // and age have no control, and their chips stay, with their remove links.
    expect(html).not.toMatch(/data-chip-kind="(place|remote|pay)"/);
    expect(html).toContain('href="/d"');
    expect(html).toContain('href="/e"');
  });
});

describe('Filters.astro: Remote is real checkboxes that work without script', () => {
  it('draws one checkbox per arrangement, each named remote, with its own count, and no All box', async () => {
    const cell = cellOf(await renderStripGroups(), 'Remote');
    expect(cell).toContain('data-filter-multi="remote"');
    const boxes = [...cell.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(4);
    expect(boxes.map((b) => b.match(/value="([^"]+)"/)![1])).toEqual(['remote', 'hybrid', 'onsite', 'unstated']);
    for (const box of boxes) expect(box).toContain('name="remote"');
    expect(boxes.map((b) => b.match(/data-count="(\d+)"/)![1])).toEqual(['1', '0', '5', '0']);
    // The printed counts are the same numbers, thousands-separated, beside the names.
    const printed = [...cell.matchAll(/class="multi-name"[^>]*>([^<]*)<\/span>\s*<span class="multi-count"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    expect(printed).toEqual([['Remote', '1'], ['Hybrid', '0'], ['On-site', '5'], ['Not stated', '0']]);
    // It is not a select, and it submits no `location=`.
    expect(cell).not.toContain('<select');
    expect(cell).not.toContain('name="location"');
  });

  it('ticks what the address chose; a zero is disabled unless it is ticked, and then it can be unticked', async () => {
    const html = await renderStripGroups({ remote: ['remote', 'hybrid'] }, { checked: { remote: ['remote', 'hybrid'] } });
    const boxes = [...cellOf(html, 'Remote').matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
    const by = (kind: string) => boxes.find((b) => b.includes(`value="${kind}"`))!;
    expect(by('remote')).toMatch(/\schecked/);
    expect(by('hybrid')).toMatch(/\schecked/);
    expect(by('onsite')).not.toMatch(/\schecked/);
    // Hybrid is zero AND ticked: still live, so the reader can take it off.
    expect(by('hybrid')).not.toMatch(/\sdisabled/);
    // Not stated is zero and unticked: drawn, counted, refused.
    expect(by('unstated')).toMatch(/\sdisabled/);
    expect(by('remote')).not.toMatch(/\sdisabled/);
  });

  it('carries the All answer and its count for the script\'s clear row', async () => {
    const cell = cellOf(await renderStripGroups(), 'Remote');
    expect(cell).toContain('data-all-label="All"');
    expect(cell).toContain('data-all-count="6"');
  });

  it('is submitted by the form, whose Apply button is the way through without script', async () => {
    const html = await renderStripGroups();
    const form = html.match(/<form class="filters-row"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
    expect(form).toContain('data-filter-multi="remote"');
    expect(form).toMatch(/<button class="filter-apply mono-label"[^>]*type="submit"[^>]*>Apply<\/button>/);
  });
});

describe('Filters.astro: Comp is floors in one select named for the pay parameter', () => {
  it('offers Any, the floors with their counts, and Not listed last, a zero floor drawn and disabled', async () => {
    const cell = cellOf(await renderStripGroups(), 'Comp');
    expect(cell).toMatch(/<select[^>]*data-filter-group="pay_min"[^>]*name="pay_min"[^>]*data-autosubmit/);
    const options = [...cell.matchAll(/<option value="([^"]*)"([^>]*)>\s*([^<]*?)\s*<\/option>/g)].map((m) => ({ value: m[1], attrs: m[2], label: m[3] }));
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ['all', 'Any'],
      ['100', '$100k+'],
      ['150', '$150k+'],
      ['200', '$200k+'],
      ['250', '$250k+'],
      ['300', '$300k+'],
      ['not-listed', 'Not listed']
    ]);
    expect(options.map((o) => o.attrs.match(/data-count="(\d+)"/)?.[1])).toEqual(['6', '3', '1', '0', '0', '0', '3']);
    // The zero floors are present and refused; nothing else is.
    expect(options.filter((o) => /\sdisabled/.test(o.attrs)).map((o) => o.value)).toEqual(['200', '250', '300']);
  });

  it('selects the floor the address chose, and Not listed when that is what it chose', async () => {
    const html = await renderStripGroups({ payMin: 150 }, { selected: { place: 'all', pay_min: '150' } });
    expect(cellOf(html, 'Comp')).toMatch(/<option value="150"[^>]*selected/);
    const none = await renderStripGroups({ compNotListed: true }, { selected: { place: 'all', pay_min: 'not-listed' } });
    expect(cellOf(none, 'Comp')).toMatch(/<option value="not-listed"[^>]*selected/);
  });
});

describe('Filters.astro: the strip\'s menus follow the repo\'s dropdown rules', () => {
  it('refuses the default of mousedown on every row it builds, one place for the select rows and the checkbox rows', () => {
    // One builder makes every row (menuRow), and it carries the guard, so a new
    // kind of row cannot be added without it.
    expect(SOURCE).toMatch(/function menuRow[\s\S]*?addEventListener\('mousedown', \(event\) => event\.preventDefault\(\)\)/);
    expect(SOURCE.match(/document\.createElement\('button'\)/g) ?? []).toHaveLength(2); // the trigger, and menuRow
    expect(SOURCE).not.toMatch(/addEventListener\('focusout'/);
    expect(SOURCE).not.toMatch(/addEventListener\('blur'/);
  });

  it('opens every menu through the one claim, so opening any closes the search panel and every other menu', () => {
    // The select menus and the checkbox menu are mounted by the same function,
    // which is the only place a strip menu is opened.
    expect(SOURCE.match(/mountMenu\(/g)).toHaveLength(3); // the definition and its two callers
    expect(SOURCE.match(/claimMenu\('strip'\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SOURCE).toContain('closeMenus(cell)');
  });
});

describe('Filters.astro: a saved selection comes back whole, including what the bare board does not list', () => {
  it('marks Location and Comp as open: the address accepts a city, a region and a typed floor the list never draws', async () => {
    const html = await renderStripGroups();
    expect(cellOf(html, 'Location')).toMatch(/<select[^>]*data-filter-group="place"[^>]*data-open-values/);
    expect(cellOf(html, 'Comp')).toMatch(/<select[^>]*data-filter-group="pay_min"[^>]*data-open-values/);
  });

  it('marks no other select: a list drawn exhaustively (the Pre-List\'s Comp and Location) keeps its own rule', async () => {
    const html = await renderFilters();
    for (const group of ['location', 'comp', 'freshness']) {
      expect(html, group).toMatch(new RegExp(`<select[^>]*data-filter-group="${group}"`));
    }
    expect(html).not.toContain('data-open-values');
  });

  it('restores an open select\'s saved value without asking whether the bare board lists it, and a closed one only if it still does', () => {
    const restore = SOURCE.slice(SOURCE.indexOf('function applySelection'), SOURCE.indexOf('function persistSelection'));
    expect(restore).toMatch(/!select\.hasAttribute\('data-open-values'\) && !Array\.from\(select\.options\)\.some\(/);
    // One navigation, and only from the board's own bare address: the guard the home page's "flip" needed.
    expect(restore).toContain("if (window.location.search !== '' || !boardPath) return;");
    expect(restore).toContain('if (here !== boardPath.replace(/\\/$/, \'\')) return;');
  });

  it('keeps the cleared-on-the-board rule: a bare board reached from the board is an empty selection, not an arrival', () => {
    expect(SOURCE).toContain('function clearedOnTheBoard');
    expect(SOURCE).toContain("if (serverMode && (window.location.search !== '' || cleared)) persistSelection();");
  });

  it('lets only a strip that has the saved controls write the record: the Pre-List\'s own Comp select must not save over it', () => {
    // One definition of who owns the record, and both writes (the account's and the browser's copy) ask it.
    expect(SOURCE.match(/const savesTheStrip = /g)).toHaveLength(1);
    expect(SOURCE).toContain("const savesTheStrip = !serverMode || multis.length > 0 || selects.some((select) => select.hasAttribute('data-open-values'));");
    expect(SOURCE).toMatch(/function persistSelection\(\): void \{\s*if \(!savesTheStrip\) return;/);
    expect(SOURCE).toContain('if (savesTheStrip) writeJSON(window.localStorage, FILTERS_KEY, currentSelection());');
    // And no other write of the record exists.
    expect(SOURCE.match(/writeJSON\(window\.localStorage, FILTERS_KEY/g)).toHaveLength(2);
    expect(SOURCE.match(/method: 'POST'/g)).toHaveLength(1);
  });

  it('writes the strip as the three names the account keeps, and writes no freshness', () => {
    const current = SOURCE.slice(SOURCE.indexOf('function currentSelection'), SOURCE.indexOf('THE READER EMPTIED THE BOARD'));
    // Every key comes from a control on the page: a select's group or a checkbox group's. The strip has
    // Location (place), Remote (remote) and Comp (pay_min); there is no Freshness control to write one.
    expect(current).toContain("selection[group] = select.value;");
    expect(current).toContain("selection[group] = tickedOf(cell).join(',') || 'all';");
    expect(current).not.toContain('freshness');
  });
});
