import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import RuleTally from './RuleTally.astro';
import { reading } from '../lib/readings';

// The tally's two sources. The kill list lists the whole record, so its tally
// counts the record (both machines, all time) and prints tonight's sweep
// figure small beside it; the report and the methodology keep the sweep's.
async function render(props: Record<string, unknown> = {}): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(RuleTally, { props });
}

describe('RuleTally.astro', () => {
  it('counts the sweep by default', async () => {
    const html = await render();
    expect(html).toContain('data-truth-metric="killed_by_rule.repost_churn"');
    expect(html).not.toContain('kills_on_record_by_rule');
    expect(html).not.toContain('This sweep');
  });
  it('in record mode counts the record, one figure per rule, and never the sweep', async () => {
    const html = await render({ count: 'record' });
    for (const rule of ['repost_churn', 'misrepresented', 'zombie', 'phantom', 'touched_not_refreshed']) {
      expect(html).toContain(`data-truth-metric="kills_on_record_by_rule.${rule}"`);
      expect(html).not.toContain(`data-truth-metric="killed_by_rule.${rule}"`);
    }
    expect(html).not.toContain('This sweep');
    // The record's figure is the archive's own count, not the sweep's.
    const onRecord = reading('kills_on_record_by_rule.repost_churn').value;
    const tonight = reading('killed_by_rule.repost_churn').value;
    expect(onRecord).toBeGreaterThanOrEqual(tonight);
  });
  it('carries no dashes', async () => {
    expect(await render({ count: 'record' })).not.toMatch(/[\u2013\u2014]/);
  });
});
