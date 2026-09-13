import { describe, expect, it } from 'vitest';
import { getAuthTables } from '@better-auth/core/db';
import {
  PERSON_TABLES,
  exportShape,
  requiredExportBundleKeys,
  requiredExportReaderFields,
  type ExportInput,
  type RawAccountRow,
  type RawSessionRow,
  type RawUserRow
} from './account';
import type { StoredEntry } from './record-store';
import type { StoredApplication, StoredSavedJob } from './desk-store';
import type { StoredFollow } from './watchlist-store';
import type { StoredFilterState } from './filters-store';
import type { StoredLink } from './profile-links';

// account.ts is the knowledge RUN-MASTER F1 (delete account, export bundle)
// runs on, kept pure specifically so it can be tested with no database. These
// tests pin the four things that actually matter: exportShape() cannot leak a
// live secret no matter how sloppily a future caller assembles its input,
// PERSON_TABLES cannot silently fall behind a Better Auth upgrade that adds a
// table nobody taught this file about, a table PERSON_TABLES marks
// includedInExport: true cannot go silently missing from the bundle's own
// KEYS (or the reverse: a bundle key no table accounts for), and, the newest
// and sharpest of the four, a table marked includedInExport: true cannot go
// silently missing from the bundle's CONTENT while its key is present.
//
// THAT LAST ONE IS WHY THIS FILE GREW A FOURTH describe BLOCK RATHER THAN
// TRUSTING THE THIRD. record_entry and record_artifact were once flagged
// includedInExport: true while src/pages/settings/export.ts queried neither;
// requiredExportBundleKeys() and the tests built on it were written to catch
// exactly that. They did not catch the next instance of the same defect one
// level down: desk_saved_job and desk_application shipped includedInExport:
// true, exportShape() faithfully produced a `desk` key, and
// src/pages/settings/export.ts still never called listSavedJobs() or
// listApplications(), so every real export's desk key held two empty arrays.
// `desk` is a key. `{ savedJobs: [], applications: [] }` satisfies "the key
// is present" perfectly. A test that only checks Object.keys() cannot see
// the difference between that and a person's real data, which is exactly why
// it did not: this file's own history proves a passing key-presence test is
// not evidence the content behind the key is real. See the last describe
// block below for the fix, and this task's own report for the two runs
// (broken, then restored) that were used to confirm the fix actually
// detects the failure it was written for, not merely written after it.

const GENERATED_AT = new Date('2026-08-20T12:00:00.000Z');

/**
 * A row that looks exactly like what a real query against `session`, `account`
 * and `verification` would hand back: every column, secrets included. Building
 * the input this way, rather than a hand-trimmed object with only the safe
 * fields present, is the point. A function that is safe only when its caller
 * remembers to leave the dangerous fields out is not safe.
 */
function fullUserRow(): RawUserRow {
  return {
    id: 'user_1',
    name: 'Rowan Test',
    email: 'rowan@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  };
}

function fullSessionRow(): RawSessionRow & { token: string } {
  return {
    id: 'session_1',
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    token: 'THIS-IS-A-LIVE-BEARER-TOKEN-3f8a9c',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ipAddress: '203.0.113.5',
    userAgent: 'test-agent/1.0',
    userId: 'user_1'
  };
}

function fullAccountRow(): RawAccountRow & { password: string } {
  return {
    id: 'account_1',
    issuer: 'credential',
    accountId: 'user_1',
    providerId: 'credential',
    userId: 'user_1',
    accessToken: 'THIS-IS-A-LIVE-ACCESS-TOKEN',
    refreshToken: 'THIS-IS-A-LIVE-REFRESH-TOKEN',
    idToken: 'THIS-IS-A-LIVE-ID-TOKEN',
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    password: 'scrypt$THIS-IS-A-LIVE-PASSWORD-HASH$deadbeef',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z')
  };
}

/**
 * One Profile Record entry, with one artifact, in exactly the nested shape
 * record-store.ts's listEntries() hands back: this is what stands in for a
 * real database read in these tests, the same role fullSessionRow() and
 * fullAccountRow() play for session and account.
 */
function fullRecordEntry(): StoredEntry {
  return {
    prfId: 'PRF-0001',
    kind: 'role_held',
    employerOrInstitution: 'Rowan Test Studio',
    officialTitle: 'Founding Designer',
    start: { year: 2020, month: 3 },
    end: null,
    location: 'Remote',
    description: 'Led design for the thing.',
    classification: 'private',
    provenance: 'you_told_us',
    artifacts: [
      {
        id: 1,
        kind: 'live_url',
        url: 'https://example.com/case-study',
        label: 'Case study'
      }
    ]
  };
}

/**
 * One saved job, in desk-store.ts's listSavedJobs() return shape: this is
 * what stands in for a real desk_saved_job read, the same role
 * fullRecordEntry() plays for record_entry/record_artifact.
 */
function fullSavedJob(): StoredSavedJob {
  return {
    jobId: 'job_1',
    savedAt: new Date('2026-08-10T00:00:00.000Z'),
    updatedAt: new Date('2026-08-10T00:00:00.000Z')
  };
}

/**
 * One application, in desk-store.ts's listApplications() return shape,
 * state 'clicked' (STM-0002's own starting point, the one every real row
 * begins in), the JD snapshot populated the way F4.2's click capture
 * actually fills it: this is what stands in for a real desk_application
 * read.
 */
function fullApplication(): StoredApplication {
  return {
    id: 1,
    jobId: 'job_1',
    externalUrl: null,
    snapshot: {
      title: 'Founding Engineer',
      company: 'Rowan Test Studio',
      description: 'Build the thing.'
    },
    state: 'clicked',
    interviewSubstage: null,
    abandonReason: null,
    closedReason: null,
    offeredComp: null,
    resumeRenderId: null,
    coverRenderId: null,
    clickedAt: new Date('2026-08-11T00:00:00.000Z'),
    confirmedAt: null,
    archivedAt: null
  };
}

/**
 * One Watchlist follow, in watchlist-store.ts's listFollows() return shape:
 * this is what stands in for a real watchlist read, the same role
 * fullSavedJob() plays for desk_saved_job.
 */
function fullFollow(): StoredFollow {
  return {
    prospectId: 'yc-30943:Iw9ggf8-mts-founding-designer',
    followedAt: new Date('2026-08-12T00:00:00.000Z')
  };
}

/**
 * One profile link, in record-store.ts's listLinks() return shape: this is
 * what stands in for a real profile_link read, the same role fullFollow()
 * plays for watchlist. Its own id is here so a test can prove the store's
 * surrogate key is dropped from the bundle, the same way fullSavedJob's shape
 * lets a test check the desk keys.
 */
function fullLink(): StoredLink {
  return {
    id: 'link_1',
    platform: 'github',
    url: 'https://github.com/rowan-test',
    createdAt: new Date('2026-08-14T00:00:00.000Z')
  };
}

/**
 * One stateful-filter selection, in filters-store.ts's getFilterState()
 * return shape: this is what stands in for a real account_filter_state
 * read, the same role fullFollow() plays for watchlist.
 */
function fullFilterState(): StoredFilterState {
  return {
    selection: { location: 'remote', comp: 'not-listed' },
    updatedAt: new Date('2026-08-13T00:00:00.000Z')
  };
}

function kitchenSinkInput(): ExportInput {
  return {
    user: fullUserRow(),
    sessions: [fullSessionRow()],
    accounts: [fullAccountRow()],
    profile: {
      user_id: 'user_1',
      tier: 'member',
      signup_source: 'drafts',
      first_name: 'Rowan',
      last_name: 'Test',
      resume_email: 'rowan@resumes.example.com',
      resume_email_use_login: false,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z')
    },
    records: [fullRecordEntry()],
    links: [fullLink()],
    savedJobs: [fullSavedJob()],
    applications: [fullApplication()],
    watchlist: [fullFollow()],
    filters: fullFilterState(),
    verifications: [
      {
        id: 'verification_1',
        identifier: 'reset-password:some-hashed-identifier',
        value: 'user_1',
        expiresAt: new Date('2026-08-21T00:00:00.000Z'),
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        updatedAt: new Date('2026-08-20T00:00:00.000Z')
      }
    ],
    generatedAt: GENERATED_AT
  };
}

describe('exportShape(): never leaks a live secret', () => {
  it('drops the account password hash even though the input carries one', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.accounts).toHaveLength(1);
    expect(bundle.accounts[0]).not.toHaveProperty('password');
    // Belt and suspenders: the hash string itself must not survive anywhere
    // in the serialized output, not just off the one field a refactor is
    // likely to remember to check.
    expect(JSON.stringify(bundle)).not.toContain('THIS-IS-A-LIVE-PASSWORD-HASH');
  });

  it('drops the session token even though the input carries one', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]).not.toHaveProperty('token');
    expect(JSON.stringify(bundle)).not.toContain('THIS-IS-A-LIVE-BEARER-TOKEN');
  });

  it('drops third-party account tokens even though the input carries them', () => {
    const bundle = exportShape(kitchenSinkInput());
    const account = bundle.accounts[0] as unknown as Record<string, unknown>;
    expect(account).not.toHaveProperty('accessToken');
    expect(account).not.toHaveProperty('refreshToken');
    expect(account).not.toHaveProperty('idToken');
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('THIS-IS-A-LIVE-ACCESS-TOKEN');
    expect(serialized).not.toContain('THIS-IS-A-LIVE-REFRESH-TOKEN');
    expect(serialized).not.toContain('THIS-IS-A-LIVE-ID-TOKEN');
  });

  it('never surfaces a verification row, even though the input carries one', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle).not.toHaveProperty('verifications');
    expect(bundle).not.toHaveProperty('verification');
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('reset-password:');
    // The verification row's own id is distinctive enough to search for
    // directly, on top of the structural checks above.
    expect(serialized).not.toContain('verification_1');
  });

  it('still exports the sign-in history a session row represents', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.sessions[0]).toEqual({
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent/1.0'
    });
  });

  it('exports the non-secret account and profile fields', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.accounts[0]).toEqual({
      id: 'account_1',
      issuer: 'credential',
      providerId: 'credential',
      accountId: 'user_1',
      scope: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    expect(bundle.profile).toEqual({
      tier: 'member',
      signupSource: 'drafts',
      firstName: 'Rowan',
      lastName: 'Test',
      resumeEmail: 'rowan@resumes.example.com',
      resumeEmailUseLogin: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
  });

  it('resolves profile to null rather than throwing when there is no profile row', () => {
    const input = kitchenSinkInput();
    input.profile = null;
    expect(exportShape(input).profile).toBeNull();
  });

  it('exports the Profile Record, artifacts nested, minus the artifact\'s own surrogate id', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.record.entries).toEqual([
      {
        prfId: 'PRF-0001',
        kind: 'role_held',
        employerOrInstitution: 'Rowan Test Studio',
        officialTitle: 'Founding Designer',
        start: { year: 2020, month: 3 },
        end: null,
        location: 'Remote',
        description: 'Led design for the thing.',
        classification: 'private',
        provenance: 'you_told_us',
        artifacts: [
          {
            kind: 'live_url',
            url: 'https://example.com/case-study',
            label: 'Case study'
          }
        ]
      }
    ]);
    // record_artifact's `id` is a database surrogate key, not a fact about
    // the person; PERSON_TABLES' own exportNote for record_artifact says so
    // explicitly, and this pins that the field is actually absent, not just
    // undocumented.
    expect(bundle.record.entries[0].artifacts[0]).not.toHaveProperty('id');
  });

  it('gives a person with no Profile Record entries an empty array, not a missing field', () => {
    const input = kitchenSinkInput();
    input.records = [];
    expect(exportShape(input).record).toEqual({ entries: [] });
  });
});

describe('exportShape(): _meta names what is absent and why', () => {
  it('names both systems outside this database that the bundle cannot reach', () => {
    const bundle = exportShape(kitchenSinkInput());
    const unreachable = bundle._meta.unreachable_from_this_database;
    expect(Object.keys(unreachable)).toEqual(expect.arrayContaining(['beehiiv', 'resend']));
    expect(unreachable.beehiiv.length).toBeGreaterThan(0);
    expect(unreachable.resend.length).toBeGreaterThan(0);
  });

  it('names the five exclusions and gives a reason for each', () => {
    const bundle = exportShape(kitchenSinkInput());
    const excluded = bundle._meta.excluded_and_why;
    expect(Object.keys(excluded)).toEqual(
      expect.arrayContaining([
        'account_password',
        'session_token',
        'verification_table',
        'record_prf_ids_issued',
        'user_provider_key'
      ])
    );
    for (const reason of Object.values(excluded)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('excludes user_provider_key in the same register as the live-credential exclusions above', () => {
    // "A live credential is not a record of what you did" is the exact
    // phrase the account table's own exportNote in PERSON_TABLES uses for
    // account.password and account's third-party tokens; user_provider_key
    // is excluded for the identical reason, and this pins the register
    // matches rather than drifting into a different justification.
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle._meta.excluded_and_why.user_provider_key).toContain('live credential');
  });

  it('stamps generated_at_utc from the passed-in clock, not a hidden one', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle._meta.generated_at_utc).toBe('2026-08-20T12:00:00.000Z');
  });
});

describe('PERSON_TABLES: covers every table Better Auth declares, checked against the library itself', () => {
  it('has one entry for every table getAuthTables() returns under this app\'s own rateLimit config', () => {
    // Read from the library at test time, not copied by hand. src/lib/auth.ts
    // sets rateLimit.storage: 'database', which is the one option that changes
    // which tables Better Auth declares (get-tables.mjs only adds `rateLimit`
    // when that flag is set), so this reproduces that one relevant option
    // rather than importing auth.ts itself, which would require the runtime
    // secrets auth.ts's build() throws without.
    const libraryTables = getAuthTables({ rateLimit: { storage: 'database' } });
    const libraryTableNames = Object.values(libraryTables).map((table) => table.modelName);

    const known = new Set(PERSON_TABLES.map((entry) => entry.table));
    const missing = libraryTableNames.filter((name) => !known.has(name));

    expect(
      missing,
      `Better Auth declares a table PERSON_TABLES does not know about: ${missing.join(', ')}. ` +
        'A library upgrade added or renamed a table; account.ts must account for it (pun intended) ' +
        'before delete-account can be trusted again.'
    ).toEqual([]);
  });

  it('also carries app_user_profile, which is ours and not Better Auth\'s', () => {
    expect(PERSON_TABLES.map((entry) => entry.table)).toContain('app_user_profile');
  });

  it('gives every table a delete reach and, unless it is not-user-linked, a verify column', () => {
    for (const entry of PERSON_TABLES) {
      expect(entry.deleteReach).toBeTruthy();
      if (entry.deleteReach === 'not-user-linked') {
        expect(entry.verifyColumn).toBeNull();
      } else {
        expect(entry.verifyColumn).not.toBeNull();
      }
    }
  });

  it('marks verification explicit-statement and excluded from export, exactly as auth.ts and password.mjs require', () => {
    const verification = PERSON_TABLES.find((entry) => entry.table === 'verification');
    expect(verification?.deleteReach).toBe('explicit-statement');
    expect(verification?.includedInExport).toBe(false);
  });

  it('marks user, session and account as reached by deleteUser, not by a statement this app writes', () => {
    for (const name of ['user', 'session', 'account']) {
      const entry = PERSON_TABLES.find((t) => t.table === name);
      expect(entry?.deleteReach).toBe('better-auth-delete-user');
    }
  });

  it('marks app_user_profile as reached by cascade, not by a statement this app writes', () => {
    const profile = PERSON_TABLES.find((entry) => entry.table === 'app_user_profile');
    expect(profile?.deleteReach).toBe('cascade');
  });

  it('also carries record_entry and record_artifact, the Profile Record tables', () => {
    const names = PERSON_TABLES.map((entry) => entry.table);
    expect(names).toContain('record_entry');
    expect(names).toContain('record_artifact');
  });

  it('marks record_entry and record_artifact as reached by cascade, not by a statement this app writes', () => {
    // Both cascade from user(id), one directly (db/004's record_entry FK)
    // and one through record_entry (record_artifact's FK to record_entry's
    // own composite key), the same pattern account.ts already documents for
    // app_user_profile. Neither needs a DELETE this app writes, and the
    // survivor check in src/pages/settings/delete.ts is a generic loop over
    // every PERSON_TABLES entry with a verifyColumn, so listing them here
    // with the right column is what actually wires that check on, with no
    // change needed to delete.ts itself.
    for (const name of ['record_entry', 'record_artifact']) {
      const entry = PERSON_TABLES.find((t) => t.table === name);
      expect(entry?.deleteReach).toBe('cascade');
      expect(entry?.verifyColumn).toBeTruthy();
    }
  });

  it('marks record_entry and record_artifact as included in export, matching MASTER-SPEC\'s view of the record', () => {
    const entry = PERSON_TABLES.find((t) => t.table === 'record_entry');
    const artifact = PERSON_TABLES.find((t) => t.table === 'record_artifact');
    expect(entry?.includedInExport).toBe(true);
    expect(artifact?.includedInExport).toBe(true);
  });

  it('also carries user_provider_key (D7 BYOK) and watchlist (MASTER-SPEC 3.6), both reached by cascade', () => {
    const names = PERSON_TABLES.map((entry) => entry.table);
    expect(names).toContain('user_provider_key');
    expect(names).toContain('watchlist');
    for (const name of ['user_provider_key', 'watchlist']) {
      const entry = PERSON_TABLES.find((t) => t.table === name);
      expect(entry?.deleteReach).toBe('cascade');
      expect(entry?.verifyColumn).toBeTruthy();
    }
  });

  it('marks user_provider_key excluded from export and watchlist included, per D7 and MASTER-SPEC 3.6', () => {
    const key = PERSON_TABLES.find((t) => t.table === 'user_provider_key');
    const watchlist = PERSON_TABLES.find((t) => t.table === 'watchlist');
    expect(key?.includedInExport).toBe(false);
    expect(key?.exportBundleKey).toBeNull();
    expect(watchlist?.includedInExport).toBe(true);
    expect(watchlist?.exportBundleKey).toBe('watchlist');
  });

  it('also carries account_filter_state (MASTER-SPEC F10), reached by cascade and included in export', () => {
    const names = PERSON_TABLES.map((entry) => entry.table);
    expect(names).toContain('account_filter_state');
    const entry = PERSON_TABLES.find((t) => t.table === 'account_filter_state');
    expect(entry?.deleteReach).toBe('cascade');
    expect(entry?.verifyColumn).toBeTruthy();
    expect(entry?.includedInExport).toBe(true);
    expect(entry?.exportBundleKey).toBe('filters');
  });

  it('gives every includedInExport table an exportBundleKey, and every excluded table null', () => {
    for (const entry of PERSON_TABLES) {
      if (entry.includedInExport) {
        expect(entry.exportBundleKey, `${entry.table} is includedInExport but has no exportBundleKey`).toBeTruthy();
      } else {
        expect(entry.exportBundleKey, `${entry.table} is excluded but still names an exportBundleKey`).toBeNull();
      }
    }
  });

  it('gives record_entry, record_artifact, profile_link, desk_saved_job, desk_application, desk_posting_fetch, watchlist and account_filter_state an exportField, and every other table null', () => {
    // The reader-function half of the same inventory exportBundleKey covers
    // for the bundle shape. user, session, account and app_user_profile are
    // included in export but read by export.ts's own raw queries, not a
    // store-module function, so they carry no exportField even though they
    // carry an exportBundleKey; verification, rateLimit, user_provider_key and
    // generated_render carry neither, being excluded outright.
    const withReader: Record<string, string> = {
      record_entry: 'records',
      record_artifact: 'records',
      profile_link: 'links',
      desk_saved_job: 'savedJobs',
      desk_application: 'applications',
      desk_posting_fetch: 'postingFetches',
      watchlist: 'watchlist',
      account_filter_state: 'filters'
    };
    for (const entry of PERSON_TABLES) {
      const expected = withReader[entry.table] ?? null;
      expect(entry.exportField, `${entry.table} should carry exportField ${JSON.stringify(expected)}`).toBe(
        expected
      );
    }
  });
});

describe('requiredExportReaderFields(): which store-module reader must run, derived the same way requiredExportBundleKeys() is', () => {
  it('names exactly records, links, savedJobs, applications, postingFetches, watchlist and filters, given the current inventory', () => {
    expect(requiredExportReaderFields()).toEqual([
      'applications',
      'filters',
      'links',
      'postingFetches',
      'records',
      'savedJobs',
      'watchlist'
    ]);
  });

  it('is a subset of every value PERSON_TABLES actually assigns to exportField', () => {
    // Loose on purpose, unlike the exact-array check above: this one keeps
    // meaning something if a future table adds a fourth ExportField member,
    // where the exact check above would need updating right alongside it.
    const declaredFields = new Set(
      PERSON_TABLES.filter((entry) => entry.includedInExport && entry.exportField).map((entry) => entry.exportField)
    );
    for (const field of requiredExportReaderFields()) {
      expect(declaredFields.has(field)).toBe(true);
    }
  });
});

describe('exportShape(): a table flagged includedInExport cannot go missing from the bundle\'s KEYS, and vice versa', () => {
  // Phase 2 flagged record_entry and record_artifact includedInExport: true
  // in PERSON_TABLES while src/pages/settings/export.ts kept querying only
  // user, session, account and app_user_profile: the flag stated a policy
  // and the route did something else. requiredExportBundleKeys() reads the
  // same PERSON_TABLES entries exportShape() is built from, so the two
  // tests below compare a REAL produced bundle's own keys against that
  // derived expectation rather than against a second, hand-kept list of
  // what "should" be in the bundle.
  //
  // KEYS ONLY. This block does not, and structurally cannot, catch a table
  // whose key is present but whose content is empty: desk_saved_job and
  // desk_application shipped includedInExport: true with exportBundleKey
  // 'desk', exportShape() faithfully produced a `desk` key, both tests
  // below passed, and src/pages/settings/export.ts still never called either
  // reader for the rest of that task. See the next describe block, which
  // exists specifically because these two were not, and never could be,
  // enough on their own.

  it('the bundle carries a key for every table PERSON_TABLES marks includedInExport: true', () => {
    const bundle = exportShape(kitchenSinkInput());
    const bundleKeys = new Set(Object.keys(bundle));
    const missing = requiredExportBundleKeys().filter((key) => !bundleKeys.has(key));

    expect(
      missing,
      `PERSON_TABLES marks a table includedInExport: true whose bundle key never showed up in a ` +
        `produced bundle: ${missing.join(', ')}. exportShape() (or the ExportInput it was given) is ` +
        'not actually reading what the inventory says it should.'
    ).toEqual([]);
  });

  it('the bundle carries no key that no PERSON_TABLES entry accounts for', () => {
    const bundle = exportShape(kitchenSinkInput());
    const required = new Set(requiredExportBundleKeys());
    const unaccounted = Object.keys(bundle).filter((key) => !required.has(key));

    expect(
      unaccounted,
      `The bundle has a top-level key no PERSON_TABLES entry's exportBundleKey names: ` +
        `${unaccounted.join(', ')}. A bundle should not quietly grow a field nobody declared.`
    ).toEqual([]);
  });
});

describe('exportShape(): a table flagged includedInExport cannot go missing from the bundle\'s CONTENT', () => {
  // THE FIX FOR THE HOLE THE PREVIOUS BLOCK NAMES. kitchenSinkInput() gives
  // every includedInExport table at least one real row (fullSessionRow(),
  // fullAccountRow(), fullRecordEntry(), fullSavedJob(), fullApplication()),
  // so a reader that silently returned nothing, the actual shape of the
  // desk_saved_job/desk_application defect this task closes, has somewhere
  // to be caught: these tests read the bundle's own arrays and objects, not
  // its Object.keys().
  //
  // THIS WAS PROVEN TO ACTUALLY FAIL, NOT JUST WRITTEN TO LOOK LIKE IT
  // WOULD. As part of this task, kitchenSinkInput()'s `savedJobs` field was
  // changed from `[fullSavedJob()]` to `[]`, simulating desk-store.ts's
  // listSavedJobs() returning nothing for a person who really has saved
  // jobs, with the rest of this file untouched. `npx vitest run` was run
  // against that change: 'carries content for every includedInExport table'
  // below failed ("expected 0 to be greater than 0"), and 'the saved job...
  // actually lands in desk.savedJobs' below failed alongside it (expected
  // one row, got none). The edit was then reverted and `npx vitest run` run
  // again: the full suite passed. See this task's own report for both runs'
  // exact output.
  //
  // THE SAME PROOF WAS RE-RUN FOR THE WATCHLIST, WHICH THIS TASK ADDS.
  // kitchenSinkInput()'s `watchlist` field was changed from `[fullFollow()]`
  // to `[]`, simulating watchlist-store.ts's listFollows() returning
  // nothing for a person who really follows a prospect. `npx vitest run`
  // against that change failed the same two tests below for the same
  // reason ('carries content...' and 'the followed prospect... actually
  // lands in watchlist.follows'). The edit was reverted and the suite ran
  // green again. See this task's own report for both runs' exact output.
  it('carries content for every includedInExport table, not just an empty shell', () => {
    const bundle = exportShape(kitchenSinkInput());

    expect(bundle.user.id).toBe('user_1');
    expect(bundle.sessions.length).toBeGreaterThan(0);
    expect(bundle.accounts.length).toBeGreaterThan(0);
    expect(bundle.profile).not.toBeNull();
    expect(bundle.record.entries.length).toBeGreaterThan(0);
    expect(bundle.links.length).toBeGreaterThan(0);
    expect(bundle.desk.savedJobs.length).toBeGreaterThan(0);
    expect(bundle.desk.applications.length).toBeGreaterThan(0);
    expect(bundle.watchlist.follows.length).toBeGreaterThan(0);
    expect(bundle.filters).not.toBeNull();
  });

  it('the profile link PERSON_TABLES marks includedInExport actually lands in links, its surrogate id dropped', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.links).toEqual([
      { platform: 'github', url: 'https://github.com/rowan-test', createdAt: '2026-08-14T00:00:00.000Z' }
    ]);
  });

  it('the saved job PERSON_TABLES marks includedInExport actually lands in desk.savedJobs', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.desk.savedJobs).toEqual([{ jobId: 'job_1', savedAt: '2026-08-10T00:00:00.000Z' }]);
  });

  it('the application PERSON_TABLES marks includedInExport actually lands in desk.applications, JD snapshot included', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.desk.applications).toEqual([
      {
        jobId: 'job_1',
        externalUrl: null,
        snapshot: {
          title: 'Founding Engineer',
          company: 'Rowan Test Studio',
          description: 'Build the thing.'
        },
        state: 'clicked',
        interviewSubstage: null,
        abandonReason: null,
        closedReason: null,
        offeredComp: null,
        resumeRenderId: null,
        coverRenderId: null,
        clickedAt: '2026-08-11T00:00:00.000Z',
        confirmedAt: null,
        archivedAt: null
      }
    ]);
  });

  it('the followed prospect PERSON_TABLES marks includedInExport actually lands in watchlist.follows', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.watchlist.follows).toEqual([
      { prospectId: 'yc-30943:Iw9ggf8-mts-founding-designer', followedAt: '2026-08-12T00:00:00.000Z' }
    ]);
  });

  it('the filter selection PERSON_TABLES marks includedInExport actually lands in bundle.filters', () => {
    const bundle = exportShape(kitchenSinkInput());
    expect(bundle.filters).toEqual({
      selection: { location: 'remote', comp: 'not-listed' },
      updatedAt: '2026-08-13T00:00:00.000Z'
    });
  });

  it('resolves filters to null, not an empty object, when this person has never saved a selection', () => {
    const input = kitchenSinkInput();
    delete input.filters;
    const bundle = exportShape(input);
    expect(bundle.filters).toBeNull();
  });
});
