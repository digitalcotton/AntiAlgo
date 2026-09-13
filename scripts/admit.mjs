#!/usr/bin/env node
/**
 * admit.mjs: move one account from the waitlist to member.
 *
 *   node scripts/admit.mjs --email <address> [--dry-run]
 *
 * Runs where the database credentials live (a terminal with DATABASE_URL set,
 * or this repo's .env.local), never on the Mac mini. Idempotent: an address
 * that is already a member, or above, is reported and left alone. The tier
 * arithmetic is tiers.config.mjs's admittedTier(), the same function the unit
 * tests cover, so this script holds no rule of its own.
 */
import pg from 'pg';
import '../load-local-env.mjs';
import { admittedTier, WAITLIST_TIER } from '../tiers.config.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailIndex = args.indexOf('--email');
const email = emailIndex === -1 ? null : (args[emailIndex + 1] ?? '').trim().toLowerCase();

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/admit.mjs --email <address> [--dry-run]');
  process.exit(2);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED or DATABASE_URL in the environment.');
  process.exit(1);
}

const { Client } = pg;
const client = new Client({ connectionString: url });
await client.connect();

try {
  const { rows } = await client.query(
    `SELECT u.id, u.email, p.tier
       FROM "user" u
       LEFT JOIN app_user_profile p ON p.user_id = u.id
      WHERE lower(u.email) = $1
      LIMIT 1`,
    [email]
  );

  const row = rows[0];
  if (!row) {
    console.error(`No account for ${email}.`);
    process.exit(1);
  }
  if (row.tier === null) {
    console.error(`${email} has no profile row, so it has no tier to admit from. Nothing changed.`);
    process.exit(1);
  }

  const next = admittedTier(row.tier);
  if (next === row.tier) {
    console.log(`${email} is already ${row.tier}. Nothing to do.`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`DRY RUN: would move ${email} from ${WAITLIST_TIER} to ${next}. Nothing changed.`);
    process.exit(0);
  }

  await client.query('UPDATE app_user_profile SET tier = $2 WHERE user_id = $1', [row.id, next]);
  console.log(`Admitted ${email}: ${WAITLIST_TIER} to ${next}.`);
} finally {
  await client.end();
}
