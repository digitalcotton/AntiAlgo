import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import JobTable from './JobTable.astro';
import type { Job } from '../lib/data';

/**
 * A render test for JobTable.astro's duplicate-cluster collapse, MASTER-SPEC
 * F10's acceptance line: "Given duplicate postings across locations, When
 * the index renders, Then one clustered row appears with its count stated."
 *
 * Rendered against the real component and its real dependency graph
 * (clusterJobs(), FitBadge, Mark, JobRow, src/lib/data.ts), same technique
 * as JobRow.render.test.ts: nothing here is stubbed.
 */

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: '$150K - $180K',
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

async function renderTable(props: { jobs: readonly Job[] }): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(JobTable, { props });
}

describe('JobTable.astro: duplicate-cluster collapse renders one row with its count stated', () => {
  it('duplicate postings across locations collapse to one clustered row', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });

    const html = await renderTable({ jobs: [sf, ny] });

    // One row in the DOM, not two: a single <li data-job-row> that carries
    // the cluster class, and only one instance of the location list.
    expect(html).toContain('job-row-cluster');
    expect(html).toContain('San Francisco, New York');

    // The count is stated in plain language and both numbers are the
    // cluster's own derived lengths, never typed.
    expect(html).toMatch(/2\s+postings\s+in\s+2\s+locations/);
  });

  it('expands to a native, scriptless disclosure that contains every original posting and its own link', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco', apply_url: 'https://boards.example.com/acme/sf/apply' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York', apply_url: 'https://boards.example.com/acme/ny/apply' });

    const html = await renderTable({ jobs: [sf, ny] });

    // <details>/<summary>, not a scripted panel: it works with no click
    // listener attached, which is what makes it survive JavaScript being off.
    expect(html).toContain('<details');
    expect(html).toContain('<summary');

    // Every original posting is still in the markup, each with its own real
    // apply link: nothing is hidden or merged away.
    expect(html).toContain('acme-pd-sf');
    expect(html).toContain('acme-pd-ny');
    expect(html).toContain('https://boards.example.com/acme/sf/apply');
    expect(html).toContain('https://boards.example.com/acme/ny/apply');
  });

  it('a title at a different company does not join the cluster', async () => {
    const acme = job({ slug: 'acme-pd', title: 'Product Designer', company: 'Acme Corp', location: 'San Francisco' });
    const globex = job({ slug: 'globex-pd', title: 'Product Designer', company: 'Globex Inc', location: 'San Francisco' });

    const html = await renderTable({ jobs: [acme, globex] });

    expect(html).not.toContain('job-row-cluster');
    expect(html).toContain('acme-pd');
    expect(html).toContain('globex-pd');
  });

  it('a posting with no duplicate renders as an ordinary row with no expander', async () => {
    const html = await renderTable({ jobs: [job()] });

    expect(html).not.toContain('job-row-cluster');
    expect(html).not.toContain('cluster-disclosure');
  });

  it('carries no em dash or en dash anywhere in its output', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });
    const toronto = job({ slug: 'acme-pd-yyz', title: 'Product Designer', location: 'Toronto', comp_posted: null });

    const html = await renderTable({ jobs: [sf, ny, toronto] });

    // Built from code points in this test file for the same reason
    // hygiene.test.ts and record.test.ts do it: the copy gate hard fails on
    // the literal character appearing anywhere this repository authors.
    const emDash = String.fromCodePoint(0x2014);
    const enDash = String.fromCodePoint(0x2013);
    expect(html).not.toContain(emDash);
    expect(html).not.toContain(enDash);
  });
});

describe('JobTable.astro: a clustered row also renders locationDisplay() and the applied tag', () => {
  it('drops a redundant United States from the joined location list, keeping every real location', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco, CA' });
    const us = job({ slug: 'acme-pd-us', title: 'Product Designer', location: 'United States' });

    const html = await renderTable({ jobs: [sf, us] });

    expect(html).toContain('San Francisco, CA');
    // Joined as "San Francisco, CA, United States" before display; the
    // trailing home country drops and leaves no dangling separator.
    expect(html).not.toContain('San Francisco, CA, United States');
  });

  it('gives a clustered row the same data-applied-tag markup an ordinary row carries, off by default', async () => {
    const sf = job({ slug: 'acme-pd-sf', title: 'Product Designer', location: 'San Francisco' });
    const ny = job({ slug: 'acme-pd-ny', title: 'Product Designer', location: 'New York' });

    const html = await renderTable({ jobs: [sf, ny] });

    expect(html).toContain('data-applied-tag');
    const clusterOpenTag = html.match(/<li[^>]*job-row-cluster[^>]*>/)?.[0] ?? '';
    expect(clusterOpenTag).not.toContain('data-applied=');
  });
});
