import { routeFor } from '../data/nav';

/**
 * The "Getting started" steps, in one place, so /profile and /desk render the
 * same checklist and can never drift on order, labels, or completion rules.
 *
 * This is a pure function of three counts the caller already has (or fetches):
 * how many provider keys, record entries, and applications the reader has. Each
 * step's `done` is derived from those counts, so a step checks itself off the
 * moment the reader completes that section, on every page load, with no client
 * state. `complete` is true once every non-optional step is done — the signal to
 * stop showing the checklist.
 */
export interface OnboardingStep {
  /** The short imperative label, e.g. "Add your work history". */
  label: string;
  /** One plain sentence: what this step is, or what to do next. */
  hint: string;
  /** Whether the reader has already done it. */
  done: boolean;
  /** Where the action goes when the step is not done. */
  href?: string;
  /** The call to action shown on an undone step with an href. */
  action?: string;
  /** A step that helps but does not block completion (kept out of the count). */
  optional?: boolean;
  /** A short badge after the label (e.g. "Preferred"), independent of optional. */
  badge?: string;
}

export interface OnboardingCounts {
  /** Provider keys on file. */
  keys: number;
  /** Record entries (work history, education, etc.). */
  entries: number;
  /** Applications tracked on the Desk. */
  applications: number;
}

export function buildOnboarding(counts: OnboardingCounts): { steps: OnboardingStep[]; complete: boolean } {
  // Absolute hrefs so the same steps work from /profile and /desk alike.
  const steps: OnboardingStep[] = [
    {
      label: 'Verify your email',
      hint: 'Done. You confirmed your address to reach your profile.',
      done: true
    },
    {
      label: 'Turn on tailored drafting',
      hint: 'Connect your own AI provider key so a draft is written in your voice, billed to your key.',
      done: counts.keys > 0,
      optional: true,
      badge: 'Preferred',
      href: routeFor('settings'),
      action: 'Add a provider key'
    },
    {
      label: 'Add your work history',
      hint: 'Upload a resume to fill it in seconds, or add a role by hand.',
      done: counts.entries > 0,
      href: `${routeFor('profile')}#get-started`,
      action: 'Upload a resume or add a role'
    },
    {
      label: 'Apply to your first role',
      hint: 'Applying from a posting tracks it on your Desk and drafts your application.',
      done: counts.applications > 0,
      href: routeFor('board'),
      action: 'Browse roles'
    }
  ];
  const complete = steps.filter((step) => !step.optional).every((step) => step.done);
  return { steps, complete };
}
