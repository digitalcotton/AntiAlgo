import { describe, expect, it } from 'vitest';
import { rowToStoredParse, type StoredParseOutcome } from './resume-parse-store';

// rowToStoredParse is the one pure function in resume-parse-store.ts: a
// node-postgres row in, the shape the review page reads out. Its siblings
// (beginParse/completeParse/getParse/clearParse) each open a db() connection
// this worker may not open (constraint 3), so they are out of scope here on
// purpose; this file exercises only the pure row-to-shape mapping, which needs
// no database at all.

describe('rowToStoredParse', () => {
  it('maps a ready row with an outcome object through with the outcome intact', () => {
    const outcome: StoredParseOutcome = {
      method: 'llm',
      providerLabel: 'Anthropic (claude-sonnet-5)',
      fallbackReason: null,
      proposals: { entries: [], links: [], name: null },
      notes: ['read your resume']
    };

    const stored = rowToStoredParse({
      status: 'ready',
      source_name: 'resume.pdf',
      import_source: 'resume',
      outcome,
      updated_at: new Date('2026-08-01T00:00:00Z')
    });

    expect(stored.status).toBe('ready');
    expect(stored.sourceName).toBe('resume.pdf');
    // The very object handed in, unwrapped and un-copied: the column is jsonb
    // and node-postgres has already decoded it, so nothing here re-parses it.
    expect(stored.outcome).toBe(outcome);
  });

  it('maps a pending row whose outcome is null to outcome null', () => {
    const stored = rowToStoredParse({
      status: 'pending',
      source_name: 'resume.docx',
      import_source: 'resume',
      outcome: null,
      updated_at: new Date('2026-08-01T00:00:00Z')
    });

    expect(stored.status).toBe('pending');
    expect(stored.outcome).toBeNull();
  });

  it('turns a string updated_at into a Date', () => {
    const stored = rowToStoredParse({
      status: 'ready',
      source_name: null,
      import_source: 'resume',
      outcome: null,
      updated_at: '2026-08-01T12:00:00Z'
    });

    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(stored.updatedAt.toISOString()).toBe('2026-08-01T12:00:00.000Z');
  });

  it('maps source_name null to sourceName null', () => {
    const stored = rowToStoredParse({
      status: 'pending',
      source_name: null,
      import_source: 'resume',
      outcome: null,
      updated_at: new Date('2026-08-01T00:00:00Z')
    });

    expect(stored.sourceName).toBeNull();
  });

  // db/209. The buffer is the only thing that survives between the upload
  // request and the background apply, so this field is what tells the apply
  // which document's Remove will be able to take the entries back. A letter
  // read through this same buffer must not come out tagged as a resume.
  it('carries import_source through, so a letter read is not landed as a resume', () => {
    const stored = rowToStoredParse({
      status: 'ready',
      source_name: 'letter.docx',
      import_source: 'cover_letter',
      outcome: null,
      updated_at: new Date('2026-08-01T00:00:00Z')
    });

    expect(stored.importSource).toBe('cover_letter');
  });
});
