import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import JobRow from './JobRow.astro';
import { locationShort, sourceLabel, sweepDate, sweptStamp, type Job } from '../lib/data';
import type { RankFacts } from '../lib/rank-reason';

/**
 * A render test for JobRow.astro's scoped verification label, MASTER-SPEC
 * F10: "every row carries its scoped verification label: observed on the
 * employer's own feed, last verified timestamp, age with its stated basis."
 *
 * WHERE THE LABEL LIVES. The board release moved the verification receipt off a
 * visible per-row line and onto the Mark's own accessible label. The visible
 * line repeated the top banner's sweep stamp on every row and named a source the
 * Apply button already names, which cluttered the overview, so that detail moved
 * to the /board detail page and the row keeps the mark. Standing rule 5 says a
 * mark never stands without its meaning, so the Mark is always passed a `label`:
 * a screen reader hears the full statement, said once, in one shape, on every row
 * regardless of status or where the row is mounted. These tests pin that shipped
 * contract: one label, on the mark, present on every status, never conditioned on
 * whether an age exists.
 *
 * Rendered against the real component and its real dependency graph (FitBadge,
 * FitBars, Mark, src/lib/data.ts), same technique as SponsorSlot.render.test.ts:
 * nothing here is stubbed.
 */

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: '$150k-$180k',
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01',
    last_verified: '2026-08-23T07:30:02Z',
    published_date: '2026-08-01',
    age_days: 22,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: null,
    ...overrides
  };
}

async function renderRow(props: { job: Job; because?: RankFacts; fit?: boolean }): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(JobRow, { props });
}

describe('JobRow.astro: the scoped verification label travels on the mark, uniform across status', () => {
  it('a live row carries the source and the sweep stamp on the mark, in one label', async () => {
    const j = job({ status: 'live', source_system: 'greenhouse' });
    const html = await renderRow({ job: j });
    const label = `Verified on the ${sourceLabel(j)} source, ${sweptStamp()}`;
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toContain(`aria-label="${label}"`);
    // The stamp is the one clock every other surface reads, never a second one
    // typed here. Derived from sweptStamp() so it tracks the current sweep.
    expect(html).toContain(sweptStamp());
    // The old visible per-row verification line is gone from the overview.
    expect(html).not.toContain('Observed on Greenhouse');
  });

  it('a re-verified row says so on the mark even when the record carries no measurable age', async () => {
    // No published_date and a first_observed equal to the sweep date: ageOf()
    // returns null for exactly this shape (see data.ts, ageOf's own docstring).
    // first_observed is read from sweepDate() rather than a literal, so the
    // null-age premise holds against whatever sweep the data carries.
    const j = job({
      status: 're_verified',
      published_date: null,
      first_observed: sweepDate(),
      age_days: null
    });
    const html = await renderRow({ job: j });
    // Confirm the premise: this record really does carry no measurable age.
    // Astro's server renderer collapses an empty-string attribute to the bare
    // name, so a null age prints as `data-age` with nothing after it.
    expect(html).toMatch(/data-age(?:=""|\s)/);
    // The word "re-verified" is stated unconditionally on the mark, not nested
    // inside the age cell where a null age would drop it.
    expect(html).toContain(`aria-label="Re-verified on the ${sourceLabel(j)} source, ${sweptStamp()}"`);
  });

  it('a closed row states the source and a confirmed stamp on the mark, in the same shape as a live row', async () => {
    const j = job({
      status: 'closed',
      closed_on: '2026-08-22',
      closed_reason: 'Not on the board in the sweep of 2026-08-23.'
    });
    const html = await renderRow({ job: j });
    expect(html).toContain(`aria-label="Closed, confirmed on the ${sourceLabel(j)} source, ${sweptStamp()}"`);
  });

  it('gives the mark its meaning as an accessible name: it never stands as a bare glyph', async () => {
    const html = await renderRow({ job: job() });
    // With the visible line gone, the mark is the verification's only home, so it
    // is labelled (role="img" + an aria-label naming the source), never decorative.
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toMatch(/<svg[^>]*aria-label="[^"]*source[^"]*"/);
  });

  it('carries no em dash, en dash, or curly quote', async () => {
    const html = await renderRow({ job: job({ status: 're_verified' }) });
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});

describe('JobRow.astro: the location cell shows the primary place with a +N more, not the whole list', () => {
  it('shows the first place and counts the rest, dropping a redundant home country', async () => {
    const j = job({ location: 'San Francisco / Remote (United States) / New York City' });
    const html = await renderRow({ job: j });
    // The cell renders locationShort(job.location): the primary place, then a
    // "+N more" for the rest, which lives on the detail page. The redundant home
    // country is dropped from what is displayed, never from the stored field.
    const place = locationShort(j.location);
    expect(place.primary).toBe('San Francisco');
    expect(place.more).toBe(2);
    expect(html).toContain('San Francisco');
    expect(html).toContain('+2 more');
    expect(html).not.toContain('United States');
  });

  it('leaves a single foreign location whole, with no +N more', async () => {
    const j = job({ location: 'Remote within Canada' });
    const html = await renderRow({ job: j });
    expect(html).toContain('Remote within Canada');
    // One place, so no overflow hint is rendered.
    expect(html).not.toContain('location-more');
  });
});

describe('JobRow.astro: the applied tag is always in the markup and off by default', () => {
  it('renders the tag text, but the row carries no data-applied attribute to reveal it', async () => {
    const html = await renderRow({ job: job() });
    expect(html).toContain('data-applied-tag');
    expect(html).toContain('Applied');
    // The <li data-job-row ...> itself must not carry data-applied on a
    // server render: only Filters.astro's client script, reading a signed-in
    // reader's own account, ever sets it. Matches the opening tag only, so a
    // coincidental "data-applied" substring elsewhere (there is none) could
    // not produce a false pass.
    const openTag = html.match(/<li[^>]*data-job-row[^>]*>/)?.[0] ?? '';
    expect(openTag).not.toContain('data-applied');
  });
});

/**
 * THE RANKED-BECAUSE LINE. The first line of the why panel says which rule put
 * the row where it is, from the facts the table hands the row. It is rendered on
 * the server, inside the panel that is already in the markup, so it reads with
 * scripting off (JobTable's noscript rule opens every panel).
 */
function because(over: Partial<RankFacts> = {}): RankFacts {
  return {
    position: 3,
    sort: 'best',
    tier: 1,
    field: 'title',
    fuzzy: false,
    fuzzyScore: null,
    query: 'product designer',
    deets: 80,
    ageDays: 22,
    payStated: true,
    ...over
  };
}

/** The text of the rank line, with the entity Astro escapes a quote to turned back into the quote. */
function rankLineOf(html: string): string | null {
  const match = html.match(/<p[^>]*data-rank-reason[^>]*>([\s\S]*?)<\/p>/);
  return match ? match[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"') : null;
}

describe('JobRow.astro: the ranked-because line opens the why panel', () => {
  it('a tier 1 row says every word is in the title, its true place, and what breaks a tie', async () => {
    const html = await renderRow({ job: job(), because: because() });
    expect(rankLineOf(html)).toBe(
      'Ranked 3rd: every word you typed is in the title, then the closer text match, then Deets 80, then newer first.'
    );
  });

  it('a close-spelling row says so, with the words as typed and the similarity', async () => {
    const html = await renderRow({
      job: job(),
      because: because({ position: 2, tier: null, field: 'title', fuzzy: true, fuzzyScore: 0.52, query: 'prodct desiner' })
    });
    expect(rankLineOf(html)).toBe(
      'Ranked 2nd: a close spelling of "prodct desiner" (similarity 0.52), then Deets 80, then newer first.'
    );
  });

  it('a chosen sort is worded as that sort', async () => {
    const html = await renderRow({ job: job(), because: because({ sort: 'fit', tier: null, field: null }) });
    expect(rankLineOf(html)).toBe('Ranked 3rd by Deets: 80 of 100, highest first, then company and title A to Z.');
  });

  it('sits inside the why panel, ahead of the Deets breakdown, and the panel stays closed until opened', async () => {
    const html = await renderRow({ job: job(), because: because() });
    // The panel is in the markup with `hidden`, which is what the noscript rule
    // opens. The line is its first child, so it is the first thing a reader sees
    // and a screen reader reads on opening it.
    expect(html).toMatch(/<div[^>]*data-why-panel[^>]*>\s*<p[^>]*data-rank-reason/);
    expect(html).toMatch(/<div[^>]*hidden[^>]*data-why-panel|<div[^>]*data-why-panel[^>]*hidden/);
    expect(html.indexOf('data-rank-reason')).toBeLessThan(html.indexOf('fit-bars'));
    // And it is one line: one element, once.
    expect(html.match(/data-rank-reason/g)).toHaveLength(1);
  });

  it('a row handed no facts renders no line and no empty element', async () => {
    const html = await renderRow({ job: job() });
    expect(html).not.toContain('data-rank-reason');
    expect(html).not.toContain('rank-reason');
    // The panel itself is untouched: the Deets breakdown is still there.
    expect(html).toContain('data-why-panel');
    expect(html).toContain('fit-bars');
  });

  it('facts that cannot be worded truthfully render no line either', async () => {
    expect(await renderRow({ job: job(), because: because({ position: 0 }) })).not.toContain('rank-reason');
    expect(await renderRow({ job: job(), because: because({ tier: 4 }) })).not.toContain('rank-reason');
  });

  it('a reader who does not see Deets gets no panel and so no line', async () => {
    const html = await renderRow({ job: job(), because: because(), fit: false });
    expect(html).not.toContain('data-why-panel');
    expect(html).not.toContain('rank-reason');
  });

  it('carries no em dash, en dash or curly quote, with the line in', async () => {
    const html = await renderRow({
      job: job(),
      because: because({ tier: null, fuzzy: true, fuzzyScore: 0.4, query: 'prodct desiner' })
    });
    expect(html).toContain('data-rank-reason');
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });

  it('escapes what the reader typed rather than rendering it', async () => {
    const html = await renderRow({
      job: job(),
      because: because({ tier: null, fuzzy: true, fuzzyScore: 0.4, query: '<script>alert(1)</script>' })
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
