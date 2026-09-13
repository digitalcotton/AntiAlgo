import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

import RecordView from './RecordView.astro';
import type { StoredEntry } from '../../lib/record-store';

// RecordView.astro's own job: does it pass `editable={false}` straight
// through to every EntryCard, with no `edit` object attached, for every
// entry, with no composition mistake.
//
// AGAINST THE REAL EntryCard, WHICH IS A CHANGE WORTH NOTING. This file used
// to render RecordView against a stub standing in for EntryCard, because the
// hand-rolled compile harness it depended on could not nest one compile
// inside another, and its own header conceded that the two test files
// "together are equivalent to testing the real composition end to end."
// Equivalent is not the same as actual: a stub agrees with the component it
// imitates only until somebody changes one of them. vitest.config.ts now
// routes through astro's own getViteConfig(), so this renders the real
// composition, and the equivalence argument is no longer needed.

async function renderRecordView(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(RecordView, { props });
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
    artifacts: [],
    ...overrides
  };
}

describe('RecordView.astro, editable={false}', () => {
  it('renders every entry with no form and no button', async () => {
    const entries = [entry({ prfId: 'PRF-0001' }), entry({ prfId: 'PRF-0002' })];
    const html = await renderRecordView({ entries, editable: false });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    // Panel's own title band prints entry.prfId verbatim, for every entry,
    // whether or not it is editable: proof both entries actually rendered
    // rather than the assertions above passing on an empty page.
    expect(html).toContain('PRF-0001');
    expect(html).toContain('PRF-0002');
  });

  it('passes editable=false and no edit object to every card, even when edit props are supplied', async () => {
    // A page that means to render read-only must not have that undone by
    // leftover edit-shaped props still being passed in; RecordView's own
    // `canEdit` guard (see that component's header) is what this proves.
    const html = await renderRecordView({
      entries: [entry()],
      editable: false,
      editParam: 'PRF-0001',
      editFormState: () => ({ values: {}, issues: [] }),
      artifactFormState: () => ({ kind: '', url: '', label: '', issues: [] }),
      recordPagePath: '/profile',
      entryAction: '/profile/entry',
      artifactActionPath: '/profile/artifact'
    });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    // No Edit affordance either: EntryCard only prints its "Edit" link
    // (href built from `${recordPagePath}?edit=...`) when its own canEdit
    // is true. Checking for that href fragment, rather than the word
    // "Edit", is what actually proves editable=false reached EntryCard
    // itself and was not undone by the leftover edit-shaped props above.
    expect(html).not.toContain('?edit=');
  });

  it('renders nothing at all for an empty record', async () => {
    const html = await renderRecordView({ entries: [], editable: false });
    expect(html.trim()).toBe('');
  });
});

describe('RecordView.astro, editable={true} with every required prop supplied', () => {
  it('attaches a well-formed edit object to each card, and a form appears', async () => {
    // editParam stays null (no entry is mid-edit), the same choice this
    // test made before: it proves RecordView's own composition (canEdit,
    // and a correctly-shaped edit object reaching EntryCard), not
    // EntryCard's own edit-form rendering, which is that component's own
    // test file's job.
    const entries = [entry({ prfId: 'PRF-0001' })];
    const html = await renderRecordView({
      entries,
      editable: true,
      editParam: null,
      editFormState: () => ({ values: {}, issues: [] }),
      artifactFormState: () => ({ kind: '', url: '', label: '', issues: [] }),
      returnKey: 'profile',
      recordPagePath: '/profile',
      entryAction: '/profile/entry',
      artifactActionPath: '/profile/artifact'
    });
    // The Edit link's href, built from the edit object's own
    // recordPagePath, proves EntryCard actually received a well-formed
    // edit object rather than merely editable=true with nothing behind it.
    expect(html).toContain('?edit=PRF-0001');
    // The artifact-add form renders whenever EntryCard's own canEdit is
    // true, regardless of which entry (if any) is mid-edit, so its
    // presence is real proof a <form> reached the page.
    expect(html).toContain('<form');
    expect(html).toContain('Add artifact');
  });

  it('falls back to the view state, not a thrown error, when editable=true but a required prop is missing', async () => {
    // RecordView's own guard (`canEdit`, documented in that component's
    // header) rather than a runtime crash: see this file's own note on why
    // that trade-off is deliberate.
    const entries = [entry()];
    const html = await renderRecordView({ entries, editable: true });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('?edit=');
    // Falls back to the view state, not to a blank page: the entry itself
    // still renders.
    expect(html).toContain('Staff Designer');
  });
});
