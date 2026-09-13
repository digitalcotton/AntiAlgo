import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import ArchivedRow from './ArchivedRow.astro';

/**
 * A render test for ArchivedRow.astro, no stubbing, same technique as
 * SponsorSlot.render.test.ts. The component takes plain props only (no
 * desk-store.ts or data.ts reads), so a fixture is just an object literal.
 *
 * What this pins: one row, title, company, archive date, one Unarchive
 * button on the right, posting the existing 'unarchive' intent; nothing of
 * the fuller active-application card (the two tracks, the employer clock,
 * the state-machine buttons) leaks back in here.
 */

interface Props {
  // An index signature, matching astro/container's own renderToString()
  // prop type: without one here, TypeScript refuses to pass this named
  // interface where that structurally-indexed type is expected, even
  // though every field it actually reads is declared below.
  [key: string]: unknown;
  title: string;
  company: string;
  archivedAtLabel: string | null;
  applicationId: number;
  action: string;
  view: 'board' | 'table';
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    title: 'Staff Product Designer',
    company: 'Acme Corp',
    archivedAtLabel: 'Aug 20, 2026',
    applicationId: 42,
    action: '/desk/application',
    view: 'board',
    ...overrides
  };
}

async function renderArchivedRow(overrides: Partial<Props> = {}): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(ArchivedRow, { props: props(overrides) });
}

describe('ArchivedRow.astro: one tight row, not the full card', () => {
  it('states the title, company, and archive date', async () => {
    const html = await renderArchivedRow();
    expect(html).toContain('Staff Product Designer');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Aug 20, 2026');
  });

  it('omits the date line entirely when no label was given, rather than printing an empty one', async () => {
    const html = await renderArchivedRow({ archivedAtLabel: null });
    expect(html).not.toMatch(/archived-row-date/);
  });

  it('posts the existing unarchive intent, scoped to this application id', async () => {
    const html = await renderArchivedRow({ applicationId: 99, action: '/desk/application' });
    expect(html).toMatch(/<form[^>]*method="POST"[^>]*action="\/desk\/application"/);
    expect(html).toMatch(/name="intent"\s+value="unarchive"/);
    expect(html).toMatch(/name="applicationId"\s+value="99"/);
  });

  it('carries the view prop through as a hidden field', async () => {
    const html = await renderArchivedRow({ view: 'table' });
    expect(html).toMatch(/name="view"\s+value="table"/);
  });

  it('renders exactly one action: Unarchive, nothing from the active-card button set', async () => {
    const html = await renderArchivedRow();
    expect(html).toContain('Unarchive');
    expect(html).not.toMatch(/name="intent"\s+value="(confirm|abandon|transition|close|comp|archive)"/);
  });

  it('carries no two-track labels: an archived row states identity and date, not You told us / We observed', async () => {
    const html = await renderArchivedRow();
    expect(html).not.toContain('You told us');
    expect(html).not.toContain('We observed');
  });

  it('renders as a single list item, one row', async () => {
    const html = await renderArchivedRow();
    expect(html.trim().startsWith('<li')).toBe(true);
    expect(html).not.toMatch(/<table[\s>]/);
  });

  it('carries no em dash, en dash, or curly quote', async () => {
    const html = await renderArchivedRow();
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});
