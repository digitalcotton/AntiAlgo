/**
 * draft-placeholder.ts: the document a person looks at while their draft is
 * still being written.
 *
 * WHY THERE IS A DOCUMENT AT ALL DURING THE WAIT. The draft room used to show
 * nothing until a payload landed — an empty white band reading "Drafting your
 * resumé and cover letter against this posting", then a hard cut to a full
 * document. docs/draft-loading-spec.md replaces that with the focus-pull
 * reveal: the room renders from the first paint with every styled line blurred
 * under a travelling shimmer, and the lines snap into focus when the real text
 * arrives.
 *
 * THE BLUR IS NOT A MOCK, AND THAT IS THE WHOLE POINT. What sits under it is
 * renderResume()/renderCover() run on their own default provider — tailor.ts's
 * deterministicProvider. Those functions are pure: no clock, no randomness, no
 * network, no model (see tailor.ts's determinism note and its tests). What they
 * return is the built-in writer's real output for this record and this posting,
 * which is exactly the document the person gets if the model draft fails. So
 * the shape under the shimmer is a genuine fallback draft, not filler, and no
 * tokens are spent to draw it.
 *
 * Owner decision, 2026-09-27: the blur shows the person's own text rather than
 * a lorem filler, because a reader squinting at a blurred paragraph should
 * learn something true from its shape.
 *
 * IT ALSO MAKES THE SWAP INVISIBLE. Placeholder and arrival share the
 * document's structure — same sections, same entries, same bullet counts — so
 * across the reload the text changes underneath the blur and the only thing the
 * eye catches is the focus pull.
 *
 * NEVER STORED. This is a view-time convenience, computed per request and
 * thrown away. completeDraft() is the only thing that writes a render, and a
 * placeholder must never be mistaken for one: a stored placeholder would read
 * back as a finished draft and the room would stop waiting.
 */
import { listEntries } from './record-store';
import { buildRenderHeader } from './generation-preference-store';
import { renderCover, renderResume, type CoverRender, type ResumeRender, type Target } from './tailor';

export interface DraftPlaceholder {
  readonly resume: ResumeRender | null;
  readonly cover: CoverRender | null;
}

/**
 * The deterministic pair for one target, or nulls.
 *
 * NULLS ARE A REAL ANSWER, NOT AN ERROR. An empty record renders an empty
 * document, and a person whose Profile Record has no entries has nothing to
 * blur; the caller falls back to the plain waiting state rather than showing an
 * eerie blurred blank. A throw here (a database hiccup, a record the renderer
 * cannot read) is caught and answered the same way: the wait is already the
 * degraded state, so failing to decorate it must never take the page down with
 * it.
 *
 * `want` lets the caller skip the document that has already landed. When a
 * resumé is ready and only the cover is still pending, there is no reason to
 * spend the render on the resumé.
 */
export async function buildDraftPlaceholder(
  userId: string,
  target: Target,
  want: { resume: boolean; cover: boolean }
): Promise<DraftPlaceholder> {
  if (!want.resume && !want.cover) return { resume: null, cover: null };
  try {
    const entries = await listEntries(userId);
    if (entries.length === 0) return { resume: null, cover: null };
    const header = await buildRenderHeader(userId);
    // `undefined` for provider (and voice) is what keeps this deterministic:
    // it takes tailor.ts's own default rather than any connected key. This
    // function must never accept a provider argument — a placeholder that
    // could call a model would spend tokens to draw a blur.
    const [resume, cover] = await Promise.all([
      want.resume ? renderResume(entries, target, undefined, header) : Promise.resolve(null),
      want.cover ? renderCover(entries, target, undefined, undefined, header) : Promise.resolve(null)
    ]);
    return { resume, cover };
  } catch (error) {
    console.error('draft-placeholder: could not build the waiting document; falling back to the plain wait.', error);
    return { resume: null, cover: null };
  }
}
