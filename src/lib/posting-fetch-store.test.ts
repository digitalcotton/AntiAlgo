/**
 * posting-fetch-store.test.ts: the pure half of the "Add a posting" store.
 * No connection string: the row mapping, the url_key, and the display clock.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIMED_GIVE_UP_MS,
  PENDING_GIVE_UP_MS,
  QUEUED_NOTICE_MS,
  SOURCE_KINDS,
  SLOW_NOTICE_MS,
  boardNoteFrom,
  fetchDisplayState,
  machineNotesFrom,
  normaliseUrlKey,
  rowToStoredPostingFetch,
  type PostingFetchRow,
  type StoredPostingFetch
} from './posting-fetch-store';

const ROW: PostingFetchRow = {
  id: '0f4e2b6a-1b2c-4d5e-8f90-1234567890ab',
  user_id: 'user_1',
  application_id: '42',
  url: 'https://jobs.example.com/x',
  url_key: 'https://jobs.example.com/x',
  status: 'pending',
  origin: null,
  source_kind: null,
  title: null,
  company: null,
  description_html: null,
  final_url: null,
  http_status: null,
  failure_code: null,
  fetched_at: null,
  claimed_at: null,
  completed_at: null,
  created_at: '2026-09-10T10:00:00.000Z',
  updated_at: '2026-09-10T10:00:00.000Z'
};

function stored(over: Partial<StoredPostingFetch> = {}): StoredPostingFetch {
  return { ...rowToStoredPostingFetch(ROW), ...over };
}

describe('rowToStoredPostingFetch', () => {
  it('reads the bigint application id as a number and the clocks as Dates', () => {
    const row = rowToStoredPostingFetch(ROW);
    expect(row.applicationId).toBe(42);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.fetchedAt).toBeNull();
  });
});

describe('machine notes (db/036)', () => {
  it('reads the board note through the allowlist and drops what it does not know', () => {
    const row = rowToStoredPostingFetch({
      ...ROW,
      machine_notes: { board: { verdict: 'added', name: ' Writer ', ats: 'Ashby', postings_seen: 12 }, later: { x: 1 } }
    });
    expect(row.machineNotes).toEqual({ board: { verdict: 'added', name: 'Writer', ats: 'ashby', postingsSeen: 12 } });
    expect(rowToStoredPostingFetch(ROW).machineNotes).toEqual({});
    expect(machineNotesFrom('nope')).toEqual({});
    expect(machineNotesFrom({ board: { verdict: 'invented' } })).toEqual({});
  });
  it('a board note needs a listed verdict; the count must be a whole number', () => {
    expect(boardNoteFrom({ verdict: 'known', name: 'Brex', ats: 'greenhouse' })).toEqual({ verdict: 'known', name: 'Brex', ats: 'greenhouse', postingsSeen: null });
    expect(boardNoteFrom({ verdict: 'added', postings_seen: 1.5 })?.postingsSeen).toBeNull();
    expect(boardNoteFrom({ verdict: 'added', postings_seen: -1 })?.postingsSeen).toBeNull();
    expect(boardNoteFrom({ verdict: 'no-board' })).toEqual({ verdict: 'no-board', name: null, ats: null, postingsSeen: null });
    expect(boardNoteFrom({ name: 'Brex' })).toBeNull();
    expect(boardNoteFrom([])).toBeNull();
    expect(boardNoteFrom({ verdict: 'added', name: 'x'.repeat(900) })?.name).toHaveLength(500);
  });
});

describe('normaliseUrlKey', () => {
  it('drops the fragment and campaign tags, lowercases the host, sorts the rest', () => {
    expect(normaliseUrlKey('https://Jobs.Example.com/a?utm_source=x&b=2&a=1&ref=li#top')).toBe('https://jobs.example.com/a?a=1&b=2');
  });
  it('keeps gh_jid, which names the posting on an embedded Greenhouse board', () => {
    expect(normaliseUrlKey('https://www.brex.com/careers/1?gh_jid=1&gh_src=abc')).toBe('https://www.brex.com/careers/1?gh_jid=1');
  });
  it('returns what it cannot parse unchanged', () => {
    expect(normaliseUrlKey('not a url')).toBe('not a url');
  });
});

describe('fetchDisplayState', () => {
  const t0 = Date.parse('2026-09-10T10:00:00.000Z');
  it('a fresh pending row is reading; an old one is queued', () => {
    expect(fetchDisplayState(stored(), t0 + 1000)).toBe('reading');
    expect(fetchDisplayState(stored(), t0 + QUEUED_NOTICE_MS + 1)).toBe('queued');
  });
  it('a claimed row is reading until the slow notice', () => {
    const claimed = stored({ status: 'claimed', claimedAt: new Date(t0 + 5000) });
    expect(fetchDisplayState(claimed, t0 + 6000)).toBe('reading');
    expect(fetchDisplayState(claimed, t0 + 5000 + SLOW_NOTICE_MS + 1)).toBe('slow');
  });
  it('calls the wait off once nothing has read it for long enough', () => {
    // The lesson of September 2026: a row nobody ever read said "still queued"
    // for nine days, which is how a dead reader looks exactly like a busy one.
    expect(fetchDisplayState(stored(), t0 + PENDING_GIVE_UP_MS + 1)).toBe('abandoned');
  });
  it('calls it off for a claimed row too: a claim held this long is a dead reader', () => {
    // Measured from when the person added it, not from the claim, so a machine
    // that claims at minute twenty-nine cannot restart their clock.
    const claimed = stored({ status: 'claimed', claimedAt: new Date(t0) });
    // Still reading at the pending ceiling: a machine is genuinely on this one.
    expect(fetchDisplayState(claimed, t0 + PENDING_GIVE_UP_MS + 1)).toBe('slow');
    expect(fetchDisplayState(claimed, t0 + CLAIMED_GIVE_UP_MS + 1)).toBe('abandoned');
  });
  it('a settled row is never abandoned, however old', () => {
    const old = t0 + CLAIMED_GIVE_UP_MS * 100;
    expect(fetchDisplayState(stored({ status: 'ready', origin: 'machine' }), old)).toBe('ready');
    expect(fetchDisplayState(stored({ status: 'pasted', origin: 'pasted' }), old)).toBe('pasted');
    expect(fetchDisplayState(stored({ status: 'unreadable', failureCode: 'timeout' }), old)).toBe('unreadable');
  });
  it('settled rows read as themselves', () => {
    expect(fetchDisplayState(stored({ status: 'ready', origin: 'machine' }), t0)).toBe('ready');
    expect(fetchDisplayState(stored({ status: 'pasted', origin: 'pasted' }), t0)).toBe('pasted');
    expect(fetchDisplayState(stored({ status: 'unreadable', failureCode: 'no_content' }), t0)).toBe('unreadable');
  });
});

describe('SOURCE_KINDS', () => {
  it('carries browser, the kind a rendered page reports, and pasted, the kind a person reports', () => {
    expect(SOURCE_KINDS).toContain('browser');
    expect(SOURCE_KINDS).toContain('pasted');
  });
});
