import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import SponsorSlot from './SponsorSlot.astro';

/**
 * A render test for SponsorSlot.astro, against the real component with its
 * real dependency graph: it imports src/data/site.ts and src/lib/flags.ts and
 * nothing else, so nothing here is stubbed.
 *
 * This file used to compile the component by hand. There was no vitest config
 * in this repository, so vitest had no astro plugin and a bare `.astro` import
 * could not resolve, and the only way to prove a rendered component was to
 * drive @astrojs/compiler directly and patch its output. vitest.config.ts now
 * exists and routes through astro's own getViteConfig(), so the import above
 * resolves the same way it does in a build, and the harness is gone.
 */

async function renderSponsorSlot(props: Record<string, unknown> = {}): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(SponsorSlot, { props });
}

describe('SponsorSlot.astro: labeled in both states, never shaped like a listing row', () => {
  it('unsold: labeled "Sponsor slot", says it is unsold, names the contact address, no price anywhere', async () => {
    const html = await renderSponsorSlot();
    expect(html).toContain('Sponsor slot');
    expect(html).toContain('unsold');
    expect(html).toContain('ryan@tokenstoagents.ai');
    expect(html).toMatch(/data-sponsor-filled="false"/);
    // No dollar sign, no digit-percent, nothing that reads as a price or a
    // plan: RUN-MASTER amendment 2 keeps checkout out of this run entirely.
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toMatch(/\bplan\b/i);
    expect(html).not.toMatch(/\bcheckout\b/i);
    expect(html).not.toMatch(/<form/i);
  });

  it('sold: still labeled "Sponsor slot", and states who holds it', async () => {
    const html = await renderSponsorSlot({ filled: true, sponsorName: 'Acme Corp' });
    expect(html).toContain('Sponsor slot');
    expect(html).toContain('Acme Corp');
    expect(html).toMatch(/data-sponsor-filled="true"/);
    // The unsold copy does not leak into the sold state.
    expect(html).not.toContain('unsold');
  });

  it('renders as a single labeled block, not a list: no <ul>, <li>, <table> row, or job/kill row markup', async () => {
    const unsold = await renderSponsorSlot();
    const sold = await renderSponsorSlot({ filled: true, sponsorName: 'Acme Corp' });
    for (const html of [unsold, sold]) {
      expect(html).not.toMatch(/<ul[\s>]/);
      expect(html).not.toMatch(/<li[\s>]/);
      expect(html).not.toMatch(/<table[\s>]/);
      expect(html.trim().startsWith('<aside')).toBe(true);
    }
  });

  it('carries no bell, badge, or unread-count markup in either state', async () => {
    const unsold = await renderSponsorSlot();
    const sold = await renderSponsorSlot({ filled: true, sponsorName: 'Acme Corp' });
    for (const html of [unsold, sold]) {
      const lower = html.toLowerCase();
      expect(lower).not.toContain('badge');
      expect(lower).not.toContain('unread');
      // Word boundary, not substring: "aria-labelledby" contains "bell" as a
      // substring ("la-bell-edby"), which this component's own accessible
      // label attribute would otherwise trip.
      expect(/\bbell\b/.test(lower)).toBe(false);
      expect(lower).not.toContain('notification-dot');
    }
  });

  it('carries no em dash, en dash, or curly quote', async () => {
    const html = await renderSponsorSlot();
    // Built from code points, never written as literals. test/gates/copy.mjs
    // scans src/ for exactly these characters and does not care that a file
    // names one only to assert its absence, which is correct: a gate that
    // reads intent is a gate that can be talked out of a finding. A test for
    // the rule has to obey the rule.
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });
});
