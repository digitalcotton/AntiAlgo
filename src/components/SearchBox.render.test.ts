import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import Filters from './Filters.astro';
import SearchBox from './SearchBox.astro';
import type { FilterGroup } from '../lib/data';
import type { Chip } from '../lib/search-parse';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_SOURCE = readFileSync(path.join(HERE, 'SearchBox.astro'), 'utf-8');
const FILTERS_SOURCE = readFileSync(path.join(HERE, 'Filters.astro'), 'utf-8');

/**
 * The server-rendered half of the search box: what has to be true with no
 * script at all, and the markup the script and the browser spec both depend on.
 * The behaviour (typing, keys, the panel's states) is
 * test/sweep/search.interaction.spec.ts, under real WebKit and Firefox; a render
 * test cannot run the script, so it pins the markup it reads.
 *
 * THE CHIP TEST BELONGS HERE BECAUSE NO PAGE CAN LOAD ONE YET: /board does not
 * pass chips, so the browser spec injects chip markup by hand. This is the test
 * that the server really renders the markup it injects.
 */

const CHIPS: Chip[] = [
  { kind: 'place', key: 'GB/London', label: 'London, United Kingdom' },
  { kind: 'company', name: 'Acme' },
  { kind: 'remote', value: 'hybrid' },
  { kind: 'pay', minK: 150 },
  { kind: 'age', maxDays: 7 }
];
const REMOVE = ['/board?a=1', '/board?a=2', '/board?a=3', '/board?a=4', '/board?a=5'];

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(SearchBox, { props });
}

const GROUPS: FilterGroup[] = [
  {
    key: 'location',
    label: 'Location',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: 'remote', label: 'Remote', count: 2 }
    ]
  }
];

async function renderStrip(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(Filters, { props: { groups: GROUPS, mode: 'server', action: '/board', ...props } });
}

describe('SearchBox.astro: a real q field first', () => {
  it('is a type=search input named q, holding the words, with the ARIA 1.2 combobox attributes', async () => {
    const html = await render({ q: 'designer' });
    const input = html.match(/<input type="search"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('name="q"');
    expect(input).toContain('value="designer"');
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-autocomplete="list"');
    expect(input).toContain('aria-expanded="false"');
    expect(input).toContain('autocomplete="off"');
    expect(input).not.toMatch(/\slist=/);
    // The input names its listbox, the listbox exists, and it starts shut.
    const controls = input.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toMatch(new RegExp(`<div[^>]*id="${controls}"[^>]*role="listbox"[^>]*hidden`));
    // A status line for assistive tech, because the listbox holds no "Searching".
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
  });

  it('shows the plan\'s placeholder when there are no chips, and none when there are', async () => {
    expect(await render({ q: '' })).toContain('placeholder="Try &#34;senior designer london remote 150k&#34;"');
    const withChips = await render({ q: '', chips: CHIPS, chipRemoveHrefs: REMOVE });
    const input = withChips.match(/<input type="search"[^>]*>/)?.[0] ?? '';
    // An empty attribute is written bare, so the check is that no text is there.
    expect(input).not.toContain('Try');
    expect(input).toMatch(/\splaceholder(\s|>)/);
  });

  it('carries the endpoint, the sweep instant and the board\'s params as data for the script', async () => {
    const html = await render({
      q: '',
      suggestPath: '/board/suggest',
      sweepV: '2026-10-02T04:00:00Z',
      baseParams: { sort: 'age', per: '25' }
    });
    expect(html).toContain('data-suggest-path="/board/suggest"');
    expect(html).toContain('data-suggest-v="2026-10-02T04:00:00Z"');
    expect(html).toContain('data-suggest-params="{&#34;sort&#34;:&#34;age&#34;,&#34;per&#34;:&#34;25&#34;}"');
  });

  it('defaults the endpoint to /board/suggest and draws no chips when given none', async () => {
    const html = await render({ q: 'x' });
    expect(html).toContain('data-suggest-path="/board/suggest"');
    expect(html).not.toContain('sb-chips');
    expect(html).not.toContain('data-chip-field');
  });

  it('is exactly as plain as the old box about its words: no em dash, en dash or curly quote', async () => {
    const html = await render({ q: '', chips: CHIPS, chipRemoveHrefs: REMOVE });
    for (const codePoint of [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d]) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});

describe('SearchBox.astro: applied chips are server-rendered links that carry no count', () => {
  it('draws one chip per fact, in order, each a label and a remove link to its own address', async () => {
    const html = await render({ q: '', chips: CHIPS, chipRemoveHrefs: REMOVE });
    const items = html.match(/<li class="sb-chip"[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(5);
    const labels = items.map((item) => item.match(/class="sb-chip-label[^"]*"[^>]*>([^<]*)</)?.[1]);
    expect(labels).toEqual(['London, United Kingdom', 'Acme', 'Hybrid', '$150k+', 'This week']);
    items.forEach((item, index) => {
      expect(item).toMatch(new RegExp(`<a class="sb-chip-x[^"]*" href="${REMOVE[index].replace('?', '\\?')}"`));
      expect(item).toContain('aria-label="Remove ');
    });
    expect(html).toContain('aria-label="Applied filters"');
  });

  it('puts no count anywhere on an applied chip', async () => {
    const html = await render({ q: '', chips: CHIPS, chipRemoveHrefs: REMOVE });
    const list = html.match(/<ul class="sb-chips"[\s\S]*?<\/ul>/)?.[0] ?? '';
    expect(list).not.toContain('menu-count');
    expect(list).not.toContain('data-count');
  });

  it('writes each chip as a hidden field named as the address names it, so Enter keeps them', async () => {
    const html = await render({ q: 'designer', chips: CHIPS, chipRemoveHrefs: REMOVE });
    const fields = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    expect(fields).toEqual([
      ['place', 'GB/London'],
      ['company', 'Acme'],
      ['remote', 'hybrid'],
      ['pay_min', '150'],
      ['age_max', '7']
    ]);
  });

  it('draws a chip with no remove address as a label with no link', async () => {
    const html = await render({ q: '', chips: [{ kind: 'remote', value: 'remote' }], chipRemoveHrefs: [] });
    expect(html).toContain('sb-chip-label');
    expect(html).not.toContain('sb-chip-x');
  });

  it('names every remote kind and the common age windows in words', async () => {
    const html = await render({
      q: '',
      chips: [
        { kind: 'remote', value: 'remote' },
        { kind: 'remote', value: 'onsite' },
        { kind: 'age', maxDays: 1 },
        { kind: 'age', maxDays: 30 }
      ],
      chipRemoveHrefs: ['/a', '/b', '/c', '/d']
    });
    const labels = [...html.matchAll(/class="sb-chip-label[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // The two remote kinds share one address parameter, so they come out as one
    // chip each in the box only if the caller passed one each; here it did.
    expect(labels).toEqual(['Remote', 'On-site', 'Today', 'Last 30 days']);
  });
});

describe('Filters.astro with the search box', () => {
  it('draws no datalist and no list attribute, and renders the box in server mode', async () => {
    const html = await renderStrip({ query: 'design' });
    expect(html).not.toContain('<datalist');
    expect(html).not.toContain('board-suggest');
    expect(html).toContain('data-search-box');
    expect(html).toMatch(/<input type="search"[^>]*name="q"[^>]*value="design"/);
    expect(html).not.toMatch(/<input type="search"[^>]*\slist=/);
  });

  it('defaults the endpoint, and passes the page\'s own through', async () => {
    expect(await renderStrip({})).toContain('data-suggest-path="/board/suggest"');
    expect(await renderStrip({ suggestPath: '/elsewhere/suggest', sweepV: 'v1' })).toContain('data-suggest-path="/elsewhere/suggest"');
  });

  it('hands the box its chips and drops a hidden field a chip already names', async () => {
    const html = await renderStrip({
      chips: [{ kind: 'place', key: 'GB/London', label: 'London, United Kingdom' }],
      chipRemoveHrefs: ['/board'],
      hidden: [
        ['place', 'STALE'],
        ['sort', 'age']
      ]
    });
    const hidden = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    expect(hidden).toContainEqual(['sort', 'age']);
    expect(hidden.filter(([name]) => name === 'place')).toEqual([['place', 'GB/London']]);
  });

  it('leaves client mode (/prelist) on the plain box its table controller listens to', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Filters, { props: { groups: GROUPS } });
    expect(html).toContain('data-job-search');
    expect(html).not.toContain('data-search-box');
    expect(html).not.toContain('role="combobox"');
  });
});

describe('one menu at a time: both scripts speak through src/lib/menu-claim.ts', () => {
  it('imports the module in both components and spells the event name in neither', () => {
    expect(SEARCH_SOURCE).toContain("from '../lib/menu-claim'");
    expect(FILTERS_SOURCE).toContain("from '../lib/menu-claim'");
    expect(SEARCH_SOURCE).not.toContain('antialgo:menu-claim');
    expect(FILTERS_SOURCE).not.toContain('antialgo:menu-claim');
  });

  it('claims as "search" in the box and as "strip" in the strip', () => {
    expect(SEARCH_SOURCE).toContain("claimMenu('search')");
    expect(SEARCH_SOURCE).toContain("onMenuClaimed('search'");
    expect(FILTERS_SOURCE).toContain("claimMenu('strip')");
    expect(FILTERS_SOURCE).toContain("onMenuClaimed('strip'");
  });
});

describe('the dropdown-focus rule (.claude/rules/dropdown-focus.md)', () => {
  it('refuses the default of mousedown on every row it builds, and on the panel', () => {
    // The browser spec proves the behaviour in WebKit; this is the cheap guard
    // that the lines are still there when nobody has run a browser.
    const guards = SEARCH_SOURCE.match(/addEventListener\('mousedown', \(event\) => event\.preventDefault\(\)\)/g) ?? [];
    // an option row, the More row, and the panel itself
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('does not close the panel on focusout, which is what eats a click in Safari and Firefox', () => {
    expect(SEARCH_SOURCE).not.toMatch(/addEventListener\('focusout'/);
    expect(SEARCH_SOURCE).not.toMatch(/addEventListener\('blur'/);
  });
});
