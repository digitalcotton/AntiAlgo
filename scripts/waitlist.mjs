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
 * let people in is held for later. The order is first-come, by the immutable
 * created_at each profile carries (user_id breaks a tie so the ordering is fully
 * deterministic), which is the same order a future admission would draw from.
 * Position is computed here, not stored, so it is always accurate and there is
 * no number to keep in sync. Runs where DATABASE_URL is set, like admit.mjs.
 */
import pg from 'pg';
import '../load-local-env.mjs';
import { WAITLIST_TIER } from '../tiers.config.mjs';

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
    `SELECT row_number() OVER (ORDER BY p.created_at ASC, p.user_id ASC)                 AS position,
            u.email,
            trim(concat_ws(' ', p.first_name, p.last_name))                              AS name,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')        AS signed_up_utc,
            coalesce(p.signup_source, '')                                                AS source
       FROM app_user_profile p
       JOIN "user" u ON u.id = p.user_id
      WHERE p.tier = $1
      ORDER BY p.created_at ASC, p.user_id ASC`,
    [WAITLIST_TIER]
  );

  if (rows.length === 0) {
    if (asCsv) console.log('position,email,name,signed_up_utc,source');
    else console.log(`The waitlist is empty (no accounts at tier "${WAITLIST_TIER}").`);
    process.exit(0);
  }

  if (asCsv) {
    console.log('position,email,name,signed_up_utc,source');
    for (const r of rows) {
      console.log([r.position, r.email, r.name, r.signed_up_utc, r.source].map(csvField).join(','));
    }
    process.exit(0);
  }

  // A plain, aligned table. The position column is right-aligned to the widest
  // number so the list reads as an ordered queue rather than a dump.
  const width = String(rows.length).length;
  console.log(`Waitlist, in order, ${rows.length} account(s):\n`);
  for (const r of rows) {
    const pos = String(r.position).padStart(width, ' ');
    const name = r.name ? `  ${r.name}` : '';
    const source = r.source ? `  [${r.source}]` : '';
    console.log(`${pos}. ${r.email}${name}  ${r.signed_up_utc}${source}`);
  }
} finally {
  await client.end();
}
