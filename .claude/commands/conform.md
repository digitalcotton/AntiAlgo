---
description: Run the pre-ship gate and report exactly what changed, what it reaches, and what is not covered
argument-hint: "[--deep]"
allowed-tools: Bash(npm run conform), Bash(npm run conform --), Bash(git status --porcelain), Bash(git diff *), Bash(git log *), Read, Grep, Glob
---

The working tree:

```!
git status --porcelain
git diff --stat HEAD
```

The gate, already run:

```!
cd "$CLAUDE_PROJECT_DIR" && npm run conform $ARGUMENTS 2>&1 | tail -120; echo "===CONFORM_EXIT=${PIPESTATUS[0]}==="
```

The output above is already in front of you. **Do not run it again.**

Report in this order, and nothing else:

1. **The verdict.** `CONFORM_EXIT=0` is green, `1` is red, `2` means a gate could not run and the answer is
   unknown — which is not a pass. Say which, in one line. Never claim the gate passed on any basis other
   than that exit code: not on the individual PASS lines, not on your reading of the output, not on the
   tests having passed earlier in the conversation.

2. **What changed, and what it reaches.** For each changed file, the routes it renders on. The
   blast-radius hook has already reported this after every edit in this conversation — use what is
   already in context rather than recomputing it. If an edit happened outside this session, say so and
   work it out.

3. **What is not covered.** For each route in that blast radius, whether a test exercises it. Name the
   routes that nothing covers and say what a test would have to assert. This is the most useful part of
   this report: a green gate over an untested route is not evidence.

4. **Known findings.** `test/conform/accepted.json` holds findings already shown to the owner. If any
   carries an `owner_question`, and the current change touches the same surface, surface the question now
   — that is the moment it can actually be answered. Do not re-report the rest.

5. **Owner-chosen files.** If any changed file appears in `.claude/owner-chosen.json`, quote the note and
   say plainly which of its protected parts you did or did not touch.

If the gate is red, do not offer to fix everything. Name the single failure most likely to be the cause of
the others, and stop there.

If the gate is green and the change is visual, say which of the 14 pixel baselines moved and whether that
was intended — `npm run conform:accept` re-records them, and the new PNGs belong in the same commit as the
change that caused them.
