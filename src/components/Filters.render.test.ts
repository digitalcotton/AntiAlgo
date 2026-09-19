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

  it('keeps the suppression note outside .filters-row, as a sibling in .filters', async () => {
    const html = await renderFilters();
    const rowEnd = html.indexOf('</div>', html.indexOf('class="filters-row"'));
    const noteStart = html.indexOf('data-suppression-note');
    expect(rowEnd).toBeGreaterThan(-1);
    expect(noteStart).toBeGreaterThan(rowEnd);
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

  it('sets data-applied from the same suppressedSlugs array applySuppression() already reads', async () => {
    expect(SOURCE).toContain("row.toggleAttribute('data-applied'");
    expect(SOURCE).toContain('function applyAppliedTag');
    // One array, assigned once, read by both applySuppression() and
    // applyAppliedTag(): no second "suppressedSlugs =" assignment anywhere,
    // which would mean a second, independently-derived set.
    const assignments = SOURCE.match(/\bsuppressedSlugs\s*=[^=]/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(SOURCE).toContain('const appliedSet = new Set(suppressedSlugs)');
    expect(SOURCE).toContain('const suppressedSet = new Set(suppressedSlugs)');
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
