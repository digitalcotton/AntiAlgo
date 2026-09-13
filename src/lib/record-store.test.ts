import { describe, expect, it } from 'vitest';
import {
  decideHandleView,
  foldHandleCase,
  rowToPersonName,
  rowToStoredArtifact,
  rowToStoredEntry,
  validateHandleFormat,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  type PersonNameRow,
  type RecordArtifactRow,
  type RecordEntryRow
} from './record-store';

// record-store.ts is the impure half of the Profile Record: every exported
// function but two opens a database connection, which is exactly the thing
// a worker in this repository is not allowed to do. rowToStoredEntry() and
// rowToStoredArtifact() are the one seam in that file with no I/O in it at
// all, a row-shaped object in, a StoredEntry/StoredArtifact out, same input
// always the same output. These tests are what "honestly testable without a
// connection" comes to for this file: they pin the row-to-shape mapping,
// not the queries that produce the rows.

function entryRow(overrides: Partial<RecordEntryRow> = {}): RecordEntryRow {
  return {
    user_id: 'user_1',
    prf_id: 'PRF-0001',
    kind: 'role_held',
    employer_or_institution: 'Acme Corp',
    official_title: 'Staff Designer',
    start_year: 2020,
    start_month: 3,
    end_year: null,
    end_month: null,
    location: 'Remote',
    description: 'Led the design system rebuild.',
    classification: 'private',
    provenance: 'you_told_us',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides
  };
}

function artifactRow(overrides: Partial<RecordArtifactRow> = {}): RecordArtifactRow {
  return {
    id: '42',
    entry_user_id: 'user_1',
    entry_prf_id: 'PRF-0001',
    kind: 'repo',
    url: 'https://github.com/example/example',
    label: 'Source',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('rowToStoredEntry(): the row-to-shape mapping, not the query', () => {
  it('bundles start_year/start_month back into one EntryDate', () => {
    const stored = rowToStoredEntry(entryRow({ start_year: 2019, start_month: 6 }), []);
    expect(stored.start).toEqual({ year: 2019, month: 6 });
  });

  it('treats end_year NULL as "still there", not a zeroed date', () => {
    const stored = rowToStoredEntry(entryRow({ end_year: null, end_month: null }), []);
    expect(stored.end).toBeNull();
  });

  it('keeps a present end_year with no end_month as a partial date, not an error', () => {
    const stored = rowToStoredEntry(entryRow({ end_year: 2022, end_month: null }), []);
    expect(stored.end).toEqual({ year: 2022, month: null });
  });

  it('carries every other field across unchanged', () => {
    const row = entryRow();
    const stored = rowToStoredEntry(row, []);
    expect(stored.prfId).toBe(row.prf_id);
    expect(stored.kind).toBe(row.kind);
    expect(stored.employerOrInstitution).toBe(row.employer_or_institution);
    expect(stored.officialTitle).toBe(row.official_title);
    expect(stored.location).toBe(row.location);
    expect(stored.description).toBe(row.description);
    expect(stored.classification).toBe(row.classification);
    expect(stored.provenance).toBe(row.provenance);
  });

  it('attaches whatever artifact list it is handed, without touching it', () => {
    const artifacts = [rowToStoredArtifact(artifactRow())];
    const stored = rowToStoredEntry(entryRow(), artifacts);
    expect(stored.artifacts).toBe(artifacts);
  });

  it('attaches an empty artifact list for an entry with no evidence', () => {
    const stored = rowToStoredEntry(entryRow(), []);
    expect(stored.artifacts).toEqual([]);
  });
});

describe('rowToStoredArtifact(): the bigint id boundary', () => {
  it('converts a string id, as node-postgres returns a bigint, to a number', () => {
    const stored = rowToStoredArtifact(artifactRow({ id: '42' }));
    expect(stored.id).toBe(42);
    expect(typeof stored.id).toBe('number');
  });

  it('leaves an already-numeric id alone', () => {
    const stored = rowToStoredArtifact(artifactRow({ id: 7 }));
    expect(stored.id).toBe(7);
  });

  it('carries kind, url and label across unchanged', () => {
    const row = artifactRow({ kind: 'case_study', url: 'https://example.com/case-study', label: 'Write-up' });
    const stored = rowToStoredArtifact(row);
    expect(stored.kind).toBe('case_study');
    expect(stored.url).toBe('https://example.com/case-study');
    expect(stored.label).toBe('Write-up');
  });

  it('carries a null label as null, not as an empty string', () => {
    const stored = rowToStoredArtifact(artifactRow({ label: null }));
    expect(stored.label).toBeNull();
  });
});

describe('rowToPersonName(): the row-to-shape mapping, not the query', () => {
  function personNameRow(overrides: Partial<PersonNameRow> = {}): PersonNameRow {
    return { first_name: 'Ryan', last_name: 'Payne', ...overrides };
  }

  it('carries first_name and last_name across unchanged', () => {
    const name = rowToPersonName(personNameRow());
    expect(name).toEqual({ firstName: 'Ryan', lastName: 'Payne' });
  });

  it('carries empty strings through as empty strings, never as a placeholder', () => {
    // db/002_profile_names.sql: NOT NULL DEFAULT '' on purpose, and its own
    // comment is explicit that empty means "not captured", not "guess
    // something". This mapper must not paper over that with a fallback name.
    const name = rowToPersonName(personNameRow({ first_name: '', last_name: '' }));
    expect(name).toEqual({ firstName: '', lastName: '' });
  });

  it('does not require both names to be present or absent together', () => {
    const name = rowToPersonName(personNameRow({ first_name: 'Ryan', last_name: '' }));
    expect(name).toEqual({ firstName: 'Ryan', lastName: '' });
  });
});

describe('foldHandleCase(): the case decision, run on plain ASCII only', () => {
  it('folds Ryan to ryan: this is the enforcement of "Ryan and ryan are the same handle"', () => {
    expect(foldHandleCase('Ryan')).toBe('ryan');
  });

  it('folds every ASCII uppercase letter, not just the first', () => {
    expect(foldHandleCase('RYAN')).toBe('ryan');
  });

  it('leaves an already-lowercase handle unchanged', () => {
    expect(foldHandleCase('ryan')).toBe('ryan');
  });

  it('leaves digits and hyphens untouched', () => {
    expect(foldHandleCase('Ryan-P-99')).toBe('ryan-p-99');
  });

  it('leaves a non-ASCII character unchanged rather than guessing a fold for it', () => {
    // Not a legal handle character either way (HANDLE_PATTERN is ASCII
    // only), so this is refused downstream by validateHandleFormat(), by
    // name, on the next call: this function's own job is only to prove it
    // does not silently invent a fold for a code point outside A-Z.
    expect(foldHandleCase('ryançs')).toBe('ryançs');
  });

  it('never uses locale-aware folding: the Turkish dotted-I pair does not apply here', () => {
    // toLocaleLowerCase('tr') would fold "I" to "ı" (dotless), not "i".
    // foldHandleCase() must fold plain ASCII "I" to plain ASCII "i" always,
    // regardless of runtime locale, because it never consults one.
    expect(foldHandleCase('RIO')).toBe('rio');
  });
});

describe('validateHandleFormat(): mirrors db/010_profile_handle.sql\'s own CHECK constraint', () => {
  it('refuses an empty string with its own named issue', () => {
    expect(validateHandleFormat('')).toEqual({ ok: false, issue: 'empty' });
  });

  it(`refuses a handle shorter than ${HANDLE_MIN_LENGTH} characters`, () => {
    expect(validateHandleFormat('ry')).toEqual({ ok: false, issue: 'length' });
  });

  it(`refuses a handle longer than ${HANDLE_MAX_LENGTH} characters`, () => {
    expect(validateHandleFormat('r'.repeat(HANDLE_MAX_LENGTH + 1))).toEqual({ ok: false, issue: 'length' });
  });

  it(`accepts a handle at exactly the ${HANDLE_MIN_LENGTH}-character floor`, () => {
    expect(validateHandleFormat('r'.repeat(HANDLE_MIN_LENGTH))).toEqual({ ok: true, issue: null });
  });

  it(`accepts a handle at exactly the ${HANDLE_MAX_LENGTH}-character ceiling`, () => {
    expect(validateHandleFormat('r'.repeat(HANDLE_MAX_LENGTH))).toEqual({ ok: true, issue: null });
  });

  it('accepts lowercase letters, digits and an interior hyphen', () => {
    expect(validateHandleFormat('ryan-payne-99')).toEqual({ ok: true, issue: null });
  });

  it('refuses uppercase: this function has no notion of case, the caller must fold first', () => {
    expect(validateHandleFormat('Ryan')).toEqual({ ok: false, issue: 'characters' });
  });

  it('refuses a leading hyphen', () => {
    expect(validateHandleFormat('-ryan')).toEqual({ ok: false, issue: 'characters' });
  });

  it('refuses a trailing hyphen', () => {
    expect(validateHandleFormat('ryan-')).toEqual({ ok: false, issue: 'characters' });
  });

  it('refuses whitespace', () => {
    expect(validateHandleFormat('ryan payne')).toEqual({ ok: false, issue: 'characters' });
  });

  it('refuses "_": the legal alphabet is a-z0-9 and hyphen only', () => {
    expect(validateHandleFormat('ryan_payne')).toEqual({ ok: false, issue: 'characters' });
  });

  it('accepts the plain-ASCII control for the next test, so the refusal below is known to be about the accent', () => {
    expect(validateHandleFormat('rayan')).toEqual({ ok: true, issue: null });
  });

  it('refuses a non-ASCII character', () => {
    expect(validateHandleFormat('rayán')).toEqual({ ok: false, issue: 'characters' });
  });
});

describe('decideHandleView(): owner or not-found, and the three not-found cases are one path', () => {
  it('renders when the viewer is the owner', () => {
    expect(decideHandleView('user_1', 'user_1')).toBe('render');
  });

  it('is not-found for an unclaimed handle (no owner at all), viewer or not', () => {
    expect(decideHandleView(null, 'user_1')).toBe('not-found');
    expect(decideHandleView(null, null)).toBe('not-found');
  });

  it('is not-found for a signed-out visitor on a claimed handle', () => {
    expect(decideHandleView('user_1', null)).toBe('not-found');
  });

  it('is not-found for a signed-in stranger on someone else\'s claimed handle', () => {
    expect(decideHandleView('user_1', 'user_2')).toBe('not-found');
  });

  it('the three not-found cases are byte-identical as a return value: "not-found" every time', () => {
    // decideHandleView() itself only proves the three inputs collapse to the
    // same string. src/pages/u/[handle].astro is what turns that single
    // value into one literal Response (status, headers and body all fixed
    // at one call site), which is what makes the HTTP responses
    // byte-identical; see test/pages/u/handle-page.render.test.ts for that
    // half, proved against the real rendered page.
    const unclaimed = decideHandleView(null, 'user_1');
    const signedOut = decideHandleView('user_1', null);
    const stranger = decideHandleView('user_1', 'user_2');
    expect(unclaimed).toBe(signedOut);
    expect(signedOut).toBe(stranger);
  });
});

