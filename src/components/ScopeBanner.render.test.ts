import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import ScopeBanner from './ScopeBanner.astro';

/**
 * A render test for ScopeBanner.astro against the real component.
 *
 * The board release replaced the old three-number, self-reading banner
 * (RUN-MASTER amendment 7: boards swept, postings observed, reached a verdict,
 * each a data-population marker the banner read for itself) with a two-number
 * funnel whose numbers are passed in from the sweep by the page, never read
 * here. The tiles and the eyebrow already carry the boards count and the sweep
 * stamp, so the banner's one remaining job a reader cannot get elsewhere is the
 * scale: how many postings the crawl read against how many are design, AI, or
 * research roles, so a reader never mistakes the board's count for the whole
 * market. These tests pin that shipped contract.
 */

async function renderBanner(props: { postingsObserved: number; verifiedLive: number }): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(ScopeBanner, { props });
}

describe('ScopeBanner.astro: the funnel banner', () => {
  it('states both numbers passed from the sweep, formatted with thousands separators', async () => {
    const html = await renderBanner({ postingsObserved: 13319, verifiedLive: 415 });
    expect(html).toContain('13,319');
    expect(html).toContain('415');
  });

  it('names the funnel in plain language: postings read, then the slice in scope', async () => {
    const html = await renderBanner({ postingsObserved: 13319, verifiedLive: 415 });
    expect(html).toContain('job postings last night');
    expect(html).toContain('design, AI, or research roles');
  });

  it('carries no em dash, en dash, or curly quote', async () => {
    const html = await renderBanner({ postingsObserved: 13319, verifiedLive: 415 });
    const forbidden = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d];
    for (const codePoint of forbidden) {
      expect(html.includes(String.fromCodePoint(codePoint))).toBe(false);
    }
  });

  it('renders as a single labeled aside, not a table or list', async () => {
    const html = await renderBanner({ postingsObserved: 13319, verifiedLive: 415 });
    expect(html.trim().startsWith('<aside')).toBe(true);
    expect(html).not.toMatch(/<table[\s>]/);
    expect(html).not.toMatch(/<ul[\s>]/);
  });
});
