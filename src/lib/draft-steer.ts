/**
 * draft-steer.ts: a person's steer for a re-draft, and the guidance it becomes.
 *
 * The draft room's "Steer it" panel lets a person point a regenerate in a
 * direction: a few allowlisted chips (shorter, lead with agent work, plainer
 * voice, more technical) and a free-text note in their own words. This module is
 * the one place that untrusted input is validated into a DraftSteer and turned
 * into guidance text.
 *
 * THE PROMPT-INJECTION BOUNDARY IS THE WHOLE POINT. A steer, chips and note
 * alike, is DATA a connected model may weigh, never an instruction it must obey:
 * steerGuidance() below produces a paragraph that the generator appends to the
 * provider's DATA message (generation-providers.ts's buildDataMessage), the same
 * channel the person's "why this company" reason already rides, and NEVER to the
 * system message. A steer cannot add a fact the record does not hold (the facts
 * are locked before any style pass), rename the person, or change which slots
 * exist; it can only ask the model to reshape prose it was already going to
 * write. The note is length-capped so it cannot flood the context.
 *
 * A steer only ever reaches a connected model. The deterministic built-in writer
 * has no prose to restyle, so a steer is a no-op there, which the room states
 * plainly rather than pretending a chip did something.
 */

/** The chips the panel offers, as stable ids (the labels live in the UI). Any
    value not in this tuple is dropped by parseSteer, so a crafted form field
    cannot smuggle a fifth "chip" through. */
export const STEER_CHIPS = ['shorter', 'lead-agent', 'plainer', 'technical'] as const;
export type SteerChip = (typeof STEER_CHIPS)[number];

const CHIP_SET: ReadonlySet<string> = new Set(STEER_CHIPS);

/** The free-text note's ceiling: enough for a sentence or two of direction, far
    short of anything that could crowd out the record in the context window. */
export const STEER_NOTE_MAX = 400;

export interface DraftSteer {
  readonly chips: readonly SteerChip[];
  readonly note: string | null;
}

/**
 * A DraftSteer from untrusted form input, or null when there is nothing to steer
 * (no allowlisted chip, no note), so a plain Regenerate stays a plain
 * regenerate. Only ids in STEER_CHIPS survive; the note is trimmed and capped.
 */
export function parseSteer(rawChips: readonly string[], rawNote: string | null): DraftSteer | null {
  const chips = [...new Set(rawChips.filter((c): c is SteerChip => CHIP_SET.has(c)))];
  const note = (rawNote ?? '').trim().slice(0, STEER_NOTE_MAX);
  if (chips.length === 0 && note.length === 0) return null;
  return { chips, note: note.length > 0 ? note : null };
}

/**
 * The guidance a steer becomes in the provider's DATA message. Plain sentences,
 * one per active chip, then the person's own note quoted as their request. This
 * is the only text a steer contributes, and it is data, not an instruction: see
 * the file header on the boundary. Empty string when the steer is empty (which
 * parseSteer never returns, but a caller may still guard on).
 */
export function steerGuidance(steer: DraftSteer): string {
  const lines: string[] = [];
  if (steer.chips.includes('shorter')) lines.push('Prefer a shorter, tighter draft.');
  if (steer.chips.includes('lead-agent')) lines.push('Lead with agent and automation work where the record supports it.');
  if (steer.chips.includes('plainer')) lines.push('Use plainer, simpler language.');
  if (steer.chips.includes('technical')) lines.push('Lean more technical where the record supports it.');
  if (steer.note) lines.push(`The person also asked, in their own words: ${steer.note}`);
  return lines.join(' ');
}
