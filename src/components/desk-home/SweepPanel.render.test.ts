import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SweepPanel from './SweepPanel.astro';

const base = { boardsSwept: 81, verifiedLive: 21323, liveUnderTitles: 13, newCoreCount: 0, diedCount: 1, sweptAt: '2026-09-19T07:30:44Z' };

describe('SweepPanel.astro: a clock only where the sweep measured one', () => {
  it('prints the real finish instant and no time column when the sweep logged no stages', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(SweepPanel, { props: base });
    expect(html).toContain('finished 07:30:44, 2026-09-19');
    expect(html).not.toContain('sp-time');
    expect(html).not.toContain('sp-steps-clock');
  });

  it('draws the time column from the logged stages, blank on the two member lines', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(SweepPanel, {
      props: { ...base, stages: { read: '2026-09-19T07:30:01Z', verify: '2026-09-19T07:30:12Z', kill: '2026-09-19T07:30:31Z', save: '2026-09-19T07:30:38Z' } }
    });
    expect(html).toContain('sp-steps-clock');
    const times = [...html.matchAll(/class="sp-time"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(times).toEqual(['07:30:01', '07:30:12', '', '', '07:30:31', '07:30:38']);
  });

  it('ignores a stage value that is not an instant', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(SweepPanel, { props: { ...base, stages: { read: 'soon' } } });
    expect(html).not.toContain('sp-steps-clock');
  });
});
