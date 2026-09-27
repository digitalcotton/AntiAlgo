# The draft room drafts in place

**Ticket.** Replace the empty waiting band on `/desk/job-draft/[slug]` with the
focus-pull reveal from `ani.html`. One ticket, one commit.

**Design source.** `~/Downloads/ani.html`, a bundled artifact. The page lives in
its `__bundler/template` script tag; the state machine is the inline `<script>`
at the end of that template. Decoded copies used while building:
`template.html` in this session's scratchpad. Nothing in the bundle's three
JavaScript blobs is design — they are the artifact runtime.

## What is wrong today

`src/pages/desk/job-draft/[slug].astro:255` refreshes the whole page every three
seconds and, until a document lands, shows `LoadingState` — a white band reading
"Drafting your resumé and cover letter against this posting", an escape hatch,
and nothing else. The draft room the person is waiting for
(`DraftRoomV2.astro`) only mounts once `useRoomV2` is true, which needs a real
payload. So the wait shows none of the thing being waited for, and the arrival
is a hard cut from empty band to full document.

## What replaces it

The draft room renders from the first paint. Every styled slot starts blurred
under a travelling shimmer and snaps into focus when the real text lands.

Three states, on `data-state` per paragraph, exactly as the example names them:

| state | what it shows |
|---|---|
| `drafting` | placeholder text, `blur(6px)` at `opacity:0.45`, shimmer sweeping |
| `settled` | the finished document. Inert by default — sharp, instant, no animation |

The reveal is not a third state. It is `settled` under a one-shot marker on
`<html>`, described next.

## The animation reports work, not page loads

**Decision (owner, 2026-09-27).** The motion means "this is being made right
now", so it fires when a document is actually being written and at no other
time:

| what happens | what the reader sees |
|---|---|
| draft is generated | blur, shimmer, then the reveal cascade |
| plain refresh of a finished draft | nothing. Sharp, instant. A refresh is not work |
| press Regenerate | the animation again — a resume is genuinely being written again |

A reveal that replayed on every page load would be decoration: it re-blurs text
the person already read, and it stops the motion being evidence, because seeing
it would no longer tell you anything is happening.

The mechanism is one flag. The poll writes `dr-revealed:<slug>` to
`sessionStorage` only after it has watched a run finish, then reloads. An
`is:inline` script at the top of the room reads it *before the document markup
is parsed*, sets `data-dr-revealed` on `<html>`, and clears the flag. Every
reveal selector is scoped to that attribute, so:

- the first paint after arrival is already blurred — no flash of sharp text
- the flag is consumed, so the next refresh renders sharp
- Regenerate goes through the pending state again, so it earns a new flag
  without any special case
- storage blocked or unavailable → no marker, sharp document. The degraded
  state is the calm one, which is the right way round for a decoration

## The placeholder is a real document

**Decision (owner, 2026-09-27): the blur shows the person's own text, not
filler.**

`renderResume(entries, target)` and `renderCover(entries, target)` in
`src/lib/tailor.ts` default to `deterministicProvider`. They are pure — no
clock, no randomness, no network, no model — and they return a real
`ResumeRender` / `CoverRender` built from the profile record. That is what the
built-in writer produces, and it is exactly what the person gets if the model
draft fails.

So the blurred shape under the shimmer is a genuine fallback document, not a
mock. Running it costs CPU and two reads, no tokens.

This also makes the swap invisible. The placeholder and the arrival share the
document's structure, so text changes underneath the blur and only the focus
pull is visible.

## What we are not pretending

The backend has no per-paragraph progress. `jobDraftState` goes `pending` →
`ready` in one step. The example fakes a timeline with `setTimeout` across a
`draftSeconds` prop; we cannot, and will not print a progress number we cannot
measure.

What carries over verbatim is the **motion**: the same keyframes, the same
durations, the same easings, the same per-paragraph `animation-delay` stagger,
the same reduced-motion fallback. During the wait the shimmer travels
continuously across every blurred paragraph on its staggered offset, which is
what the example shows while drafting. On arrival the reveals cascade at 120ms
apart rather than spread across eight seconds.

The one honest difference from the example, stated plainly: the cascade is
motion, not progress. No paragraph claims to have been written at the moment it
unblurs.

## Motion, ported exactly

```
@keyframes shimmer { from{transform:translateX(-100%)} to{transform:translateX(100%)} }
@keyframes focusIn { from{filter:blur(6px);opacity:0.45} to{filter:blur(0);opacity:1} }
@keyframes sweep   { from{background-size:0% 100%} to{background-size:100% 100%} }
@keyframes pulse   { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.78)} }
```

- shimmer `1.6s ease-in-out infinite`, `animation-delay` = paragraph index × 120ms
- focusIn `260ms cubic-bezier(0.2,0.8,0.2,1)`, only under `data-dr-revealed`
- sweep `350ms ease-out 260ms` — only on `data-hl="true"`
- pulse `1.2s ease-in-out infinite` on the status dot
- height animated `260ms cubic-bezier(0.2,0.8,0.2,1)` on reveal, cleared after
  320ms, so nothing above a paragraph jumps
- no settle timer: `animation-fill-mode: both` holds the end state

`--shimmer` is a new token: `rgba(255,255,255,0.75)` light,
`rgba(255,255,255,0.08)` dark.

Under `prefers-reduced-motion: reduce` the example drops the shimmer entirely,
holds the placeholder at flat `opacity:0.3` with no blur, and replaces the
focus pull with a 150ms linear fade. Ported as written.

## Which lines highlight

`data-hl="true"` is not decoration. It comes from `changeRecord` — the
byte-comparison of what the model rephrased inside its locked slot versus what
came from the record unchanged. `DraftRoomV2` already derives this for the
ready state. The drafting state carries the same flag, so the highlight sweep
on arrival marks real rewrites.

## The rail and the actions

Following the example: steering and Apply are visible but locked at reduced
opacity while drafting, captioned "Steering opens when the draft lands." and
"Apply opens when the draft lands." — never hidden, so the person can see what
is coming. `pointer-events:none` and `tabindex="-1"` while locked, so neither
mouse nor keyboard reaches a control that is not ready.

"Taking too long? Start the draft over." survives, demoted to small muted text
beside the pulsing dot, and it stays a real form POST.

## Polling

The `<meta http-equiv="refresh" content="3">` goes. A full document reload
every three seconds restarts every animation mid-sweep and throws away scroll
position.

Replaced with a client poll against the page's own state, reloading once when
the draft flips to ready. The blur holds across the whole wait, which is honest:
nothing has arrived.

**Every wait needs a terminal state.** The poll gives up after a bounded number
of attempts and says so, rather than shimmering forever.

## Blast radius

- `src/pages/desk/job-draft/[slug].astro` — the drafting branch
- `src/components/tailor/DraftRoomV2.astro` — gains a drafting mode
- `src/pages/desk/draft/[id].astro` — the twin page, same room, must not break
- `tokens/` — the `--shimmer` token

`DraftRoomV2` is shared by both draft pages. The drafting mode must default off
so the apply-flow room at `/desk/draft/[id]` is untouched unless we opt it in.

## Gate

`npm run conform` green before the commit. `dom-contracts` is the one that
matters here: every selector a client script queries must still be provided by
the markup that provides it, and this change adds both.
