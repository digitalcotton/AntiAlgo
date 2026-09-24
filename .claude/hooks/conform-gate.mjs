#!/usr/bin/env node
/**
 * Stop hook: refuse to end the turn while src/ has edits newer than the last
 * green sweep receipt. Reads Stop hook JSON on stdin.
 *   receipt: .claude/.sweep-receipt.json  {"sha":"<git sha>","at":<ms>,"green":true}
 *   marker:  .claude/.last-edit          (mtime = last edit under src/)
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
let hook = {};
try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch {}

// Never fight the loop protection: if we already blocked once, let it stop.
if (hook.stop_hook_active) process.exit(0);

const marker = join(ROOT, '.claude', '.last-edit');
const receipt = join(ROOT, '.claude', '.sweep-receipt.json');
if (!existsSync(marker)) process.exit(0);           // nothing edited this session
const editedAt = statSync(marker).mtimeMs;

let ok = false, why = 'no sweep has run in this working tree';
if (existsSync(receipt)) {
  try {
    const r = JSON.parse(readFileSync(receipt, 'utf8'));
    if (r.green !== true) why = 'the last sweep finished red';
    else if (r.at <= editedAt) why = 'the last sweep predates the most recent edit';
    else ok = true;
  } catch { why = 'the sweep receipt is unreadable'; }
}
if (ok) process.exit(0);

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason:
    `Files under src/ changed and ${why}. Run /ship-sweep (or \`npm run sweep\`) and ` +
    `report its result before ending the turn. If the sweep is genuinely not wanted ` +
    `for this change, say so explicitly and delete .claude/.last-edit.`
}) + '\n');
