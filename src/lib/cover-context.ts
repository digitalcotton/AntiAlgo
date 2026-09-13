/**
 * Context packs: the cover-letter skill's two-axis adaptation layer
 * (skills/cover-letter/references/contexts.md), reduced to a pure runtime.
 *
 * Every letter loads one FIELD pack and one SITUATION overlay. The field axis
 * (tech, corporate, creative, healthcare, sales, academic, federal, general)
 * sets length, register, and what counts as proof. The situation axis
 * (standard, new grad, career changer, internal, executive) sets the narrative
 * frame and what must be explained. Both are detected from the posting and the
 * person's record; the skill says to ask only when you cannot tell, so a clean
 * default (`general` / `standard`) carries the ambiguous case.
 *
 * This module is pure: it reads only the plain strings it is handed and returns
 * a plain config. It mints no facts and never sees a model. The pack it returns
 * shapes the PROMPT (guidance the model is asked to follow) and the verifier's
 * word bounds; it can never add a fact to a letter. Fact-safety stays with the
 * structural provider guarantees and the verifier's fact-trace, untouched here.
 */

import type { ProfileEntry } from './record';

/** The eight fields the skill's field packs cover. `general` is the default
    when nothing else reads clearly (the skill's "70% never changes" case). */
export type CoverField =
  | 'tech'
  | 'corporate'
  | 'creative'
  | 'healthcare'
  | 'sales'
  | 'academic'
  | 'federal'
  | 'general';

/** The five situation overlays the runtime detects. The skill's deeper
    variants (cold outreach) are opt-in only and are not auto-detected. */
export type CoverSituation =
  | 'standard'
  | 'new_grad'
  | 'career_changer'
  | 'internal'
  | 'executive';

/** A resolved pack: the field/situation it came from, the word band the letter
    should sit in (hard bounds reject, soft bounds warn), whether the salutation
    is warm ("Hi <Company> team,") or formal, and the moves the letter must make
    and must avoid. `mandatory` and `forbidden` are plain guidance strings, read
    only by the prompt builder. */
export interface CoverPack {
  readonly field: CoverField;
  readonly situation: CoverSituation;
  readonly hardMin: number;
  readonly hardMax: number;
  readonly softMin: number;
  readonly softMax: number;
  readonly warm: boolean;
  readonly mandatory: readonly string[];
  readonly forbidden: readonly string[];
}

/* -------------------------------------------------------------------------
   Field classification.
   ------------------------------------------------------------------------- */

/* Ordered most-specific first: the first pattern that matches wins, so a
   "federal nurse" reads as federal (its mechanics dominate) and a "software
   engineer" reads as tech before the broad corporate net catches "engineer".
   Each entry is [field, pattern]. */
const FIELD_PATTERNS: readonly (readonly [CoverField, RegExp])[] = [
  ['federal', /\b(usajobs|federal (government|agency)|gs-?\d{1,2}\b|announcement number|ksa|public trust|security clearance)\b/i],
  ['healthcare', /\b(nurse|nursing|\brn\b|\bbsn\b|patient|clinical|hospital|health\s?care|physician|therapist|oncology|\bicu\b|\bemr\b|bedside|care team)\b/i],
  ['academic', /\b(faculty|tenure|tenure-track|professor|postdoc|postdoctoral|dissertation|assistant professor|adjunct|lecturer|principal investigator)\b/i],
  ['sales', /\b(sales|account executive|quota|business development|\bbdr\b|\bsdr\b|pipeline|territory|closing deals|revenue target)\b/i],
  ['tech', /\b(engineer|developer|software|backend|front\s?end|full[\s-]?stack|devops|\bsre\b|platform|\bsaas\b|\bapi\b|infrastructure|machine learning|\bml\b|\bai\b|data (engineer|scientist)|programmer)\b/i],
  ['creative', /\b(designer|design|creative|brand|copywriter|art director|\bux\b|\bui\b|editorial|content (design|strategy)|marketing|visual)\b/i],
  ['corporate', /\b(analyst|consultant|consulting|finance|financial|accounting|banking|investment|\baudit\b|operations|strategy|the firm)\b/i]
];

/** Classify a posting into one field from its title, company, and body text.
    Falls back to `general` (retail, service, admin, or anything unclear), which
    the skill treats as the low-stakes default. Pure over the string given. */
export function classifyField(text: string): CoverField {
  for (const [field, pattern] of FIELD_PATTERNS) {
    if (pattern.test(text)) return field;
  }
  return 'general';
}

/* -------------------------------------------------------------------------
   Situation detection.
   ------------------------------------------------------------------------- */

const SENIOR_TITLE = /\b(chief|c[eft]o|ceo|cfo|coo|cto|cio|vp|vice president|head of|president|managing director|partner|principal|senior director|director)\b/i;

const CURRENT_YEAR = 2026;

function isRecent(end: ProfileEntry['end']): boolean {
  return end === null || end.year >= CURRENT_YEAR - 1;
}

/** The person's dominant field, read from their own titles and descriptions, so
    a target in a different field reads as a career change. Skills-only records
    stay `general` (no dominant field to change from). */
function recordField(entries: readonly ProfileEntry[]): CoverField {
  const substance = entries
    .filter((e) => e.kind === 'role_held' || e.kind === 'education' || e.kind === 'project')
    .map((e) => `${e.officialTitle} ${e.employerOrInstitution ?? ''} ${e.description}`)
    .join(' ');
  return classifyField(substance);
}

/**
 * Infer the person's situation from their record against the target. Ordered by
 * specificity: an internal move is the strongest, most particular signal, then
 * seniority, then a thin record (new grad), then a field change. Anything else
 * is the default `standard`, which the skill's base skeleton already carries.
 * Pure and deterministic; a per-draft override can be layered on later.
 */
export function detectSituation(
  entries: readonly ProfileEntry[],
  targetField: CoverField,
  targetCompany: string | null
): CoverSituation {
  const company = (targetCompany ?? '').trim().toLowerCase();
  if (company.length > 0) {
    // Only a ROLE at the target company is an internal move. A credential
    // ISSUED BY the target company (a recognition or skill whose issuer is now
    // the employer field) must not read as "works there": you did not become an
    // OpenAI insider by earning an OpenAI certificate.
    const worksThere = entries.some(
      (e) => e.kind === 'role_held' && (e.employerOrInstitution ?? '').trim().toLowerCase() === company
    );
    if (worksThere) return 'internal';
  }

  const roles = entries.filter((e) => e.kind === 'role_held');
  const hasSeniorRole = roles.some((e) => SENIOR_TITLE.test(e.officialTitle));
  if (hasSeniorRole) return 'executive';

  const hasRecentEducation = entries.some((e) => e.kind === 'education' && isRecent(e.end));
  if (hasRecentEducation && roles.length <= 1) return 'new_grad';

  const from = recordField(entries);
  if (from !== 'general' && targetField !== 'general' && from !== targetField) {
    return 'career_changer';
  }

  return 'standard';
}

/* -------------------------------------------------------------------------
   The pack table.
   ------------------------------------------------------------------------- */

interface FieldBase {
  readonly hardMin: number;
  readonly hardMax: number;
  readonly softMin: number;
  readonly softMax: number;
  readonly warm: boolean;
  readonly mandatory: readonly string[];
  readonly forbidden: readonly string[];
}

/* Field packs (contexts.md section 2). Word bands are the skill's length rule
   turned into hard/soft numbers; `warm` is true only where the skill blesses
   the "Hi <Company> team," salutation. Academic and federal are deep variants
   the runtime does not ship, so they fall back to the corporate pack: a formal,
   one-page letter with no variant-specific moves (no KSA verbatim mirroring,
   which would break the core no-fabrication rule). */
const FIELD_PACKS: Record<CoverField, FieldBase> = {
  tech: {
    hardMin: 120, hardMax: 380, softMin: 150, softMax: 320, warm: true,
    mandatory: ['Lead with why this company, and name something concrete they build (a product, a doc, a recent launch).'],
    forbidden: ['language so generic it would fit any company', 'an unexplained job hop']
  },
  creative: {
    hardMin: 200, hardMax: 420, softMin: 280, softMax: 400, warm: true,
    mandatory: ['Point to the one or two pieces of work most relevant to this role.'],
    forbidden: ['careless writing that contradicts the creative claim']
  },
  corporate: {
    hardMin: 220, hardMax: 420, softMin: 280, softMax: 400, warm: false,
    mandatory: ['State two or three quantified achievements matched to the role, in plain confident prose.'],
    forbidden: ['templated praise of the firm', 'an unquantified claim']
  },
  healthcare: {
    hardMin: 220, hardMax: 420, softMin: 280, softMax: 400, warm: false,
    mandatory: ['Carry a care philosophy tied to this facility or unit, shown through a specific incident, not claimed as an adjective.'],
    forbidden: ['any typo (this field reads an error as a safety signal)']
  },
  sales: {
    hardMin: 120, hardMax: 280, softMin: 150, softMax: 240, warm: false,
    mandatory: ['Open with your strongest number, then one proof story, then a direct close.'],
    forbidden: ['a platitude where a quota or conversion number belongs']
  },
  general: {
    hardMin: 120, hardMax: 280, softMin: 150, softMax: 240, warm: false,
    mandatory: ['Signal reliability, availability, and the relevant experience, tightly.'],
    forbidden: ['an overworked formal letter that reads copy-pasted']
  },
  // Deep variants, packed conservatively as corporate (see the note above).
  academic: {
    hardMin: 220, hardMax: 420, softMin: 280, softMax: 400, warm: false,
    mandatory: ['State credentials and relevant work plainly, matched to the role.'],
    forbidden: ['an unquantified claim']
  },
  federal: {
    hardMin: 220, hardMax: 460, softMin: 300, softMax: 440, warm: false,
    mandatory: ['State credentials and relevant work plainly, matched to the announced duties.'],
    forbidden: ['an unquantified claim']
  }
};

/* Situation overlays (contexts.md section 3). `range` overrides the field's
   length band (internal is the shortest letter in the skill; executive is
   deliberately short for its seniority). `mandatory`/`forbidden` are added to
   the field's, never replacing them (must-explain content: the overlay wins). */
interface SituationOverlay {
  readonly range?: { readonly hardMin: number; readonly hardMax: number; readonly softMin: number; readonly softMax: number };
  readonly mandatory: readonly string[];
  readonly forbidden: readonly string[];
}

const SITUATION_OVERLAYS: Record<CoverSituation, SituationOverlay> = {
  standard: { mandatory: [], forbidden: [] },
  new_grad: {
    mandatory: ['Frame potential with substitute evidence: class projects, campus leadership, volunteer or freelance work with real outcomes. Map what exists; never apologize for inexperience.'],
    forbidden: ['"what this job would do for me" framing', 'weak verbs like "helped with" or "assisted in"']
  },
  career_changer: {
    mandatory: [
      'Include one motive paragraph, written as pull toward this field (what you kept gravitating to), never as escape from the last one.',
      'Bridge one past win into this field\'s terms.'
    ],
    forbidden: ['leaving the change unexplained']
  },
  internal: {
    range: { hardMin: 120, hardMax: 240, softMin: 150, softMax: 200 },
    mandatory: [
      'Skip any company introduction; go straight to internal wins tied to company goals, with numbers.',
      'Name the endorsement early if a leader suggested applying.'
    ],
    forbidden: ['entitlement or presumption']
  },
  executive: {
    range: { hardMin: 250, hardMax: 420, softMin: 300, softMax: 380 },
    mandatory: ['Tell one scaled narrative arc (scope, governance, outcomes), not a list of wins.'],
    forbidden: ['generic enthusiasm', 'any mention of compensation', 'a skill list']
  }
};

/**
 * Compose the field pack and situation overlay into one resolved pack, applying
 * the skill's intersection rules (contexts.md section 1): the field sets the
 * register; the situation adds must-explain content; and the LENGTH takes the
 * smaller cap of the two (the direction that is right in every context, since a
 * shorter, more specific letter never hurts).
 */
export function packFor(field: CoverField, situation: CoverSituation): CoverPack {
  const base = FIELD_PACKS[field];
  const overlay = SITUATION_OVERLAYS[situation];
  const band = overlay.range;

  // Smaller cap wins on the ceiling (the skill's rule); when a situation states
  // its own band (internal is short, executive is deliberately tight), that
  // band sets the floor, clamped never to exceed the resolved ceiling.
  const hardMax = band ? Math.min(base.hardMax, band.hardMax) : base.hardMax;
  const softMax = band ? Math.min(base.softMax, band.softMax) : base.softMax;
  const hardMin = band ? Math.min(band.hardMin, hardMax) : base.hardMin;
  const softMin = band ? Math.min(band.softMin, softMax) : base.softMin;

  return {
    field,
    situation,
    hardMin,
    hardMax,
    softMin,
    softMax,
    warm: base.warm,
    mandatory: [...base.mandatory, ...overlay.mandatory],
    forbidden: [...base.forbidden, ...overlay.forbidden]
  };
}

/** Render a pack as the house-rules block the letter prompt appends: the word
    band, the register, and the must-do / avoid moves. Plain text, no facts. */
export function packGuidanceText(pack: CoverPack): string {
  const lines: string[] = [
    `House rules for this letter (field: ${pack.field}, situation: ${pack.situation}):`,
    `Aim for about ${pack.softMin} to ${pack.softMax} words.`,
    pack.warm
      ? 'Register: warm and direct, the way you would write to the team itself.'
      : 'Register: formal, specific, and confident.'
  ];
  if (pack.mandatory.length > 0) {
    lines.push('Must do:');
    for (const move of pack.mandatory) lines.push(`- ${move}`);
  }
  if (pack.forbidden.length > 0) {
    lines.push('Avoid:');
    for (const move of pack.forbidden) lines.push(`- ${move}`);
  }
  return lines.join('\n');
}
