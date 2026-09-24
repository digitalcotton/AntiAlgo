#!/usr/bin/env node
/**
 * PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit: force a permission
 * prompt before touching a file the owner has marked owner-chosen, and tell
 * Claude why in the same breath.
 * Manifest: .claude/owner-chosen.json  [{ "path": "src/pages/index.astro", "note": "..." }]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
let hook = {};
try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const manifestPath = join(ROOT, '.claude', 'owner-chosen.json');
if (!existsSync(manifestPath)) process.exit(0);
let entries = [];
try { entries = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { process.exit(0); }

const ti = hook.tool_input || {};
const targets = [ti.file_path, ...(Array.isArray(ti.edits) ? ti.edits.map(e => e.file_path) : [])]
  .filter(p => typeof p === 'string' && p)
  .map(p => relative(ROOT, resolve(p)));

const hits = entries.filter(e => targets.includes(e.path));
if (hits.length === 0) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason:
      'Owner-chosen file. ' + hits.map(h => `${h.path}: ${h.note}`).join(' | '),
    additionalContext:
      'This file is on the owner-chosen list in .claude/owner-chosen.json. ' +
      hits.map(h => `${h.path} — ${h.note}`).join(' ') +
      ' Do not change these parts as a side effect of another task. If the edit is not about them, say which lines you are touching and why they are outside the protected content.'
  }
}) + '\n');
