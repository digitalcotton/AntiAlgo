import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import EntryCard from './EntryCard.astro';
import type { StoredEntry } from '../../lib/record-store';

// EntryCard.astro is the one place phase 9's handle page will eventually
// render a stranger's own entry, so its `editable` contract is this task's
// most load-bearing seam: `editable={false}` (or `editable={true}` with no
// `edit` object) must never emit a <form> or a <button>, on any entry, in
// any state.
//
// Rendered against the real component and the real Panel.astro. This file
// used to compile EntryCard by hand and stub Panel, because there was no
// vitest config in this repository and so no astro plugin to resolve a
// `.astro` import. vitest.config.ts now routes through astro's own
// getViteConfig(), so the import above resolves exactly as it does in a
// build and the stub is gone.

async function renderEntryCard(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(EntryCard, { props });
}

function entry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    prfId: 'PRF-0001',
    kind: 'role_held',
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Staff Designer',
    start: { year: 2020, month: 3 },
    end: null,
    location: 'Remote',
    description: 'Led the design system rebuild.',
    classification: 'private',
    provenance: 'you_told_us',
    artifacts: [{ id: 1, kind: 'repo', url: 'https://github.com/example/example', label: 'Source' }],
    ...overrides
  };
}

describe('EntryCard.astro, editable={false}: the phase 9 seam', () => {
  it('renders no <form> anywhere', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: false });
    expect(html).not.toContain('<form');
  });

  it('renders no <button> anywhere', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: false });
    expect(html).not.toContain('<button');
  });

  it('still renders the entry itself: title, employer, dates', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: false });
    expect(html).toContain('Staff Designer');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('PRF-0001');
  });

  it('still lists artifacts, with no remove control', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: false });
    expect(html).toContain('github.com/example/example');
    expect(html).not.toContain('Remove');
  });

  it('renders no <form> and no <button> even when `editable` is true but `edit` is absent', async () => {
    // The guard this component's own Props comment documents: `editable`
    // alone must never be enough to reach a form. See EntryCard.astro's own
    // `canEdit` constant.
    const html = await renderEntryCard({ entry: entry(), editable: true });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });
});

describe('EntryCard.astro, editable={true} with a real edit state', () => {
  const editState = {
    isEditing: true,
    values: {
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Staff Designer',
      startYear: '2020',
      startMonth: '3',
      stillHere: true,
      endYear: '',
      endMonth: '',
      location: 'Remote',
      description: 'Led the design system rebuild.',
      classification: 'private'
    },
    issues: [],
    artifact: { kind: '', url: '', label: '', issues: [] },
    returnKey: 'profile',
    recordPagePath: '/profile',
    entryAction: '/profile/entry',
    artifactActionPath: '/profile/artifact'
  };

  it('renders the edit form, with the entry field values carried through', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: true, edit: editState });
    expect(html).toContain('<form');
    expect(html).toContain('Save changes');
    expect(html).toContain('value="Staff Designer"');
  });

  it('renders the delete disclosure and the artifact-add form', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: true, edit: editState });
    expect(html).toContain('Delete this entry');
    expect(html).toContain('Add artifact');
  });
});

describe('EntryCard.astro: an undated entry (db/204) shows no date range', () => {
  it('leaves the dates cell empty rather than printing a "Present" nobody stated', async () => {
    const html = await renderEntryCard({
      entry: entry({ kind: 'skill', employerOrInstitution: null, officialTitle: 'Figma', start: null }),
      editable: false
    });
    expect(html).not.toContain('to Present');
    // The cell stays in the summary grid (the columns are fixed), just empty.
    expect(html).toMatch(/record-summary-dates[^>]*><\/span>/);
  });

  it('still prints the range for a dated entry', async () => {
    const html = await renderEntryCard({ entry: entry(), editable: false });
    expect(html).toContain('March 2020 to Present');
  });
});
