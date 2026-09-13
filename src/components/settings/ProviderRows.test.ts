import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import ProviderRows, { type ProviderRow } from './ProviderRows.astro';
import { PROVIDER_REGISTRY } from '../../lib/generation-providers';

/**
 * ProviderRows unifies each provider's key and its writing model on one row.
 * Two contracts matter most here and both are security-adjacent: the model
 * choice is a selection from OUR list posted by the name settings/model.ts
 * reads (D7), and the key field never carries a value on any path (the one
 * leak this section exists to refuse). Rendered against the real component and
 * registry through Astro's container, the same setup the other component tests
 * use.
 */
async function render(rows: readonly ProviderRow[]): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(ProviderRows, {
    props: {
      rows,
      modelAction: '/jobs/settings/model',
      keysSaveAction: '/jobs/settings/keys/save',
      keysRemoveAction: '/jobs/settings/keys/remove',
      modelUpdated: false,
      modelError: false,
      settingsPath: '/jobs/settings',
      // Open the one row so the model picker and key field are in the output
      // to assert on; a closed row shows only its grid line.
      openModel: rows[0]?.provider ?? null,
      openKey: rows[0]?.provider ?? null
    }
  });
}

const anthropicDef = PROVIDER_REGISTRY.anthropic;
function anthropicRow(connected: boolean): ProviderRow {
  const chosen = anthropicDef.defaultWritingModel;
  return {
    provider: 'anthropic',
    name: anthropicDef.label,
    connected,
    tail: connected ? 'wxyz' : null,
    added: connected ? 'March 3, 2026' : null,
    replaced: null,
    writingLabel: connected
      ? (anthropicDef.writingModels.find((m) => m.id === chosen)?.label ?? chosen)
      : null,
    readModelLabel: anthropicDef.writingModels.find((m) => m.id === anthropicDef.copyModel)?.label ?? anthropicDef.copyModel,
    models: anthropicDef.writingModels.map((m) => ({ id: m.id, label: m.label, note: m.note, current: m.id === chosen })),
    relayError: null
  };
}

describe('ProviderRows.astro', () => {
  it('a connected row offers each writing model as a submit button posting name="model"', async () => {
    const html = await render([anthropicRow(true)]);
    expect(html).toContain('Connected');
    expect(html).toContain('name="model"');
    for (const model of anthropicDef.writingModels) {
      expect(html).toContain(`value="${model.id}"`);
    }
    // The chosen model is marked pressed; the section states the read tier.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('copying, not writing');
    // The key field never carries a value, even on the connected (replace) row.
    expect(html).toContain('type="password"');
    expect(html).not.toMatch(/type="password"[^>]*value=/);
  });

  it('a not-connected row shows Connect and a key field, and offers no model to spend a key it lacks', async () => {
    const html = await render([anthropicRow(false)]);
    expect(html).toContain('Not connected');
    expect(html).toContain('type="password"');
    expect(html).not.toMatch(/type="password"[^>]*value=/);
    // No writing-model choice is offered for a provider with no key.
    expect(html).not.toContain('name="model"');
  });
});
