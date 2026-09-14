#!/usr/bin/env node
/**
 * waitlist.mjs: the clean, numbered, ordered list of everyone on the waitlist.
 *
 *   node scripts/waitlist.mjs            # a numbered table to the terminal
 *   node scripts/waitlist.mjs --csv      # the same list as CSV, to redirect to a file
 *   node scripts/waitlist.mjs --csv > waitlist-2026-09-13.csv
 *
 * READ ONLY. This never admits, promotes, or changes a single row: it exists so
 * the waitlist order is always in hand while the decision about how and when to
 * let people in is held for later.
 *
 * Reads waitlist_email (db/201_waitlist_email.sql), the "Save my spot" landing
 * page's own table, not app_user_profile. Those are two different waitlists:
 * this one is email addresses collected before anyone has an account. The
 * order is first-come, by the immutable created_at each row carries (id
 * breaks a tie so the ordering is fully deterministic, matching the position
 * math src/pages/api/waitlist.ts uses when it answers a submission). Position
 * is computed here, not stored, so it is always accurate and there is no
 * number to keep in sync.
 */
import pg from 'pg';
import '../load-local-env.mjs';

const asCsv = process.argv.slice(2).includes('--csv');

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED or DATABASE_URL in the environment.');
  process.exit(1);
}

const { Client } = pg;
const client = new Client({ connectionString: url });
await client.connect();

/** Minimal RFC-4180 CSV field: quote when needed, double any inner quotes. */
function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

try {
  const { rows } = await client.query(
    `SELECT row_number() OVER (ORDER BY created_at ASC, id ASC)               AS position,
            email,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS joined_utc,
            coalesce(referral_code, '')                                        AS referral_code
       FROM waitlist_email
      ORDER BY created_at ASC, id ASC`
  );

  if (rows.length === 0) {
    if (asCsv) console.log('position,email,joined_utc,referral_code');
    else console.log('The waitlist is empty (no rows in waitlist_email).');
    process.exit(0);
  }

  if (asCsv) {
    console.log('position,email,joined_utc,referral_code');
    for (const r of rows) {
      console.log([r.position, r.email, r.joined_utc, r.referral_code].map(csvField).join(','));
    }
    process.exit(0);
  }

  // A plain, aligned table. The position column is right-aligned to the widest
  // number so the list reads as an ordered queue rather than a dump.
  const width = String(rows.length).length;
  console.log(`Waitlist, in order, ${rows.length} email(s):\n`);
  for (const r of rows) {
    const pos = String(r.position).padStart(width, ' ');
    const code = r.referral_code ? `  [${r.referral_code}]` : '';
    console.log(`${pos}. ${r.email}  ${r.joined_utc}${code}`);
  }
} finally {
  await client.end();
}
