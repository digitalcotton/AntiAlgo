# The three hooks

Registered in `.claude/settings.json`, which is committed on purpose: a hook that
lives in `settings.local.json` is git-ignored and does not follow the repo into a
worktree or a fresh clone, which is exactly where an unwired guard goes unnoticed.

| Hook | Event | What it does | Cost |
|---|---|---|---|
| `blast-radius.mjs` | `PostToolUse` | After an edit, names every route that renders the changed file and every test that covers it. | 75 ms measured |
| `owner-chosen.mjs` | `PreToolUse` | Turns an edit to a file on `.claude/owner-chosen.json` into a permission prompt that quotes why. | ~10 ms |
| `conform-gate.mjs` | `Stop` | Refuses to end a turn while `src/` has changes newer than the last green gate run. | ~40 ms |

## What each one is actually for

**blast-radius** answers the question this whole repository is bad at: *if I change
this, what else changes?* The import graph here is clean — zero page-to-page
imports — so the answer is computable, and it takes 75 ms. Editing
`Filters.astro` reports `/`, `/board` and `/prelist`, which is the coupling behind
commit `54435b9`, where a saved-filter restore fired on pages it had no business
firing on.

It also knows about the files no import graph can see: `tokens/*.json`,
`public/scripts/*.js`, `vercel.json`, `astro.config.mjs`, `src/middleware.ts`,
`flags.config.mjs`, `tiers.config.mjs` and `db/*.sql`. Each of those reaches
further than any module in `src/`, and none of them is imported by anything.

**owner-chosen** exists because of a specific, repeated failure: the home page's
comparison section was added and removed four times, the last removal (`8e05097`)
landing hours after a restore (`1da3f59`). An agent reading the page cannot tell a
deliberate absence from an oversight. The manifest says which absences are
deliberate, and quotes the commit.

**conform-gate** is the backstop, and it is the weakest of the three for a reason
worth writing down: **a Stop hook's block reason does not reach the model as an
instruction.** It prevents the turn ending; it does not explain itself to the
model. That is why the "sweep has not run" reminder also lives in
`blast-radius.mjs`, whose `additionalContext` *is* read. The gate stops a
premature "done"; the PostToolUse line is what actually informs the next action.

## Two deliberate choices that look like bugs

**The second `PostToolUse` entry has no matcher.** A matcher on `Edit|Write` never
fires when a file is rewritten by `sed -i`, a heredoc, or a script run from Bash —
and those are the edits most likely to be careless. The unmatched entry runs after
every tool and discovers what changed from `git status` instead (`--from-git`). It
goes silent when more than twelve files are dirty, because mid-task that is the
normal state and a twelve-line report every tool call is noise.

**Failing open.** Every hook exits 0 and says nothing when it cannot do its job — no
git, unreadable manifest, unreadable receipt. A guard that blocks an edit because it
could not read its own config is worse than no guard.

**No marker file, deliberately.** The Stop gate used to compare a receipt against
`.claude/.last-edit`, which `blast-radius.mjs` stamped with `Date.now()`. A
PostToolUse hook runs AFTER its tool call, so a single Bash call of
`sed -i … && npm run conform` wrote the green receipt and *then* stamped the marker —
the marker was always newer, and the gate blocked a turn whose work had been measured.
It cried wolf, and a guard that cries wolf gets disabled. The gate now reads the
newest mtime under the watched paths directly: nothing writes it, so nothing can write
it in the wrong order. One second of slack absorbs a formatter touching a file within
the same second as the run.

## Debugging one that does nothing

Hooks fail silently by design, so test them by hand with the JSON they receive on
stdin:

```bash
echo '{"tool_input":{"file_path":"'$PWD'/src/components/Filters.astro"}}' | node .claude/hooks/blast-radius.mjs
```

A working hook prints a single line of JSON. No output means it decided it had
nothing to say — which is correct for a file outside `src/` and not on the wide
list.
