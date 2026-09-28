/**
 * job-family.mjs: the occupational family a posting belongs to.
 *
 * WHY THIS EXISTS. `derived_fam` was declared in jobs-derived.mjs and never
 * built: `famFromDepartment()` returned the crawled department string verbatim,
 * so the "family" was 3,350 distinct values including `FLZR`, `Scaling`, `SSAs`
 * and `student-recent graduate-local- home daily-no experience`. A field with
 * 3,350 values cannot group anything, and nothing downstream could use it.
 *
 * WHAT A FAMILY IS FOR, AND WHAT IT IS NOT FOR. It answers one question: is
 * this posting even in this person's field? That is an EXCLUSION test — it
 * stops a designer being shown nursing roles. It deliberately does not try to
 * rank two postings inside one family; seniority, pay, region and remoteness
 * already do that (see derivedFor()), and they do it better because they are
 * measured rather than inferred. A family that tried to be a fit score would be
 * the same overreach `fitNote()` was.
 *
 * RULES, NOT A MODEL. Every mapping below is a word test a person can read,
 * reproduce and argue with. That is a hard requirement rather than a
 * preference: this value decides what a member is not shown, and a member who
 * disagrees must be able to see exactly which word decided it. A model call
 * here would also put a provider in the nightly ingest path, which
 * ingest-on-build.mjs was explicitly written to keep out.
 *
 * THE CORPUS IS MULTILINGUAL, so the word lists are too. The board carries
 * Zahnmedizin, Butikkmedarbeider, Vertriebsaußendienst, Salle de restaurant and
 * Travaux alongside their English equivalents. A family that only reads English
 * would silently file every German and Norwegian posting as unknown, and
 * unknown is the state that gets a member nothing.
 *
 * NULL IS A REAL ANSWER. A department of `FLZR` maps to nothing, and this
 * returns null rather than inventing an `Other` bucket. The repo's own posture,
 * stated in db/207 and in scoreJob()'s freshness comment: a gap in what the
 * employer printed is shown as a gap. `Other` would read as a classification
 * and is not one.
 *
 * ORDER IS THE WHOLE ALGORITHM. Departments are compound — "Operations, IT, &
 * Support Engineering" contains four family words. The first rule that matches
 * wins, so the list below is sorted by how strongly a term identifies a family,
 * not alphabetically. Moving a rule changes classifications; the coverage
 * harness in job-family.test.ts is what catches that.
 */

/**
 * The families. Ids are stable and stored; labels are what a reader sees.
 *
 * Twenty is not a magic number — it is where the corpus stopped splitting into
 * groups that share skills. Health is one family rather than four because a
 * board that shows a nurse other clinical roles is useful; it is separate from
 * Social & Community Care because a psychologist and a nurse share almost
 * nothing but a building.
 */
export const FAMILIES = [
  { id: 'software', label: 'Software Engineering' },
  { id: 'data-ai', label: 'Data & AI' },
  { id: 'it-infra', label: 'IT & Infrastructure' },
  { id: 'security', label: 'Security' },
  { id: 'design', label: 'Design' },
  { id: 'product', label: 'Product' },
  { id: 'sales', label: 'Sales' },
  { id: 'marketing', label: 'Marketing & Communications' },
  { id: 'customer', label: 'Customer Support & Success' },
  { id: 'finance', label: 'Finance & Accounting' },
  { id: 'legal', label: 'Legal' },
  { id: 'people', label: 'People & HR' },
  { id: 'operations', label: 'Operations & Supply Chain' },
  { id: 'trades', label: 'Trades & Maintenance' },
  { id: 'manufacturing', label: 'Manufacturing & Production' },
  { id: 'health', label: 'Healthcare & Medicine' },
  { id: 'social-care', label: 'Social & Community Care' },
  { id: 'education', label: 'Education & Training' },
  { id: 'hospitality', label: 'Hospitality, Retail & Food' },
  { id: 'public-safety', label: 'Public Safety & Defence' },
  { id: 'science', label: 'Science & Research' },
  { id: 'admin', label: 'Administration & Business Support' }
];

export const FAMILY_IDS = FAMILIES.map((f) => f.id);
const LABEL_BY_ID = new Map(FAMILIES.map((f) => [f.id, f.label]));

/** The reader-facing name for a stored id, or null for a null family. */
/**
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
export function familyLabel(id) {
  return id == null ? null : LABEL_BY_ID.get(id) ?? null;
}

/**
 * The rules, in precedence order. Each term is matched as a whole word against
 * a normalised string, so `art` does not match `smart` and `ops` does not match
 * `shops`.
 *
 * Terms carrying a qualifier come before the bare word they contain: `value
 * engineering` and `legal engineering` are not software, so they are claimed by
 * their own families before `engineering` is reached. Likewise `sales
 * engineer`, which is sales.
 */
/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const RULES = [
  // --- claimed early, because a later bare word would take them wrongly ---
  ['legal', ['legal engineering', 'contract law']],
  ['finance', ['value engineering', 'financial engineering',
    'budget analysis', 'budget'
  ,
    'insurance', 'assurance', 'versicherung'
  ]],
  ['sales', ['sales engineer', 'solutions engineer', 'pre-sales', 'presales']],
  ['science', ['research engineer', 'research scientist']],

  // --- health, ahead of everything that shares its words ---
  ['health', [
    'medical officer', 'physician', 'nurse', 'nursing', 'dental', 'dentist', 'zahnmedizin',
    'pharmacy', 'pharmacist', 'veterinary', 'clinical', 'clinic', 'patient', 'therapist',
    'therapy', 'radiolog', 'surgeon', 'surgical', 'midwife', 'paramedic', 'medizin',
    'health science', 'health aid', 'medical support', 'medical', 'healthcare', 'health care',
    'diagnostic', 'optometr', 'podiatr', 'psychiatr', 'anesthesi', 'oncolog', 'pflege'
  ,
    'underskoterska', 'undersköterska', 'pflegefachkraft', 'altenpflege', 'krankenpflege'
  ,
    'health', 'soins', 'therapeutique', 'occupational health', 'sante'
  ]],
  ['social-care', [
    'social work', 'social science', 'psychology', 'psycholog', 'counsel', 'chaplain',
    'community care', 'direct support', 'caregiver', 'care worker', 'youth work',
    'rehabilitation', 'welfare'
  ]],
  ['education', [
    'education', 'teacher', 'teaching', 'tutor', 'instructor', 'professor', 'lecturer',
    'faculty', 'curriculum', 'school', 'academic', 'training technician', 'bildung'
  ,
    'educatif', 'pedagogi', 'formation'
  ]],

  // --- public safety, before generic operations words ---
  ['public-safety', [
    'police', 'law enforcement', 'criminal investigation', 'intelligence', 'defence',
    'defense', 'firefight', 'air traffic', 'border', 'corrections', 'military', 'armed forces',
    'emergency management', 'customs'
  ,
    'aviation safety', 'safety inspection'
  ]],

  // --- hardware, before `design` reaches it ---
  // Silicon, circuit and building design are engineering disciplines that
  // happen to contain the word. Found by spot-check: `HSIO Validation Lead,
  // Silicon Co-Design` was filed as product design, which would show a chip
  // validation engineer a board of UX roles.
  ['manufacturing', [
    'silicon', 'semiconductor', 'asic', 'fpga', 'chip design', 'circuit design',
    'hardware design', 'co design', 'vlsi', 'pcb'
  ]],
  ['trades', ['bim', 'vdc', 'cad', 'architectural design', 'structural design']],

  // --- the technology block, most specific first ---
  ['data-ai', [
    'data science', 'data scientist', 'machine learning', 'applied ai', 'artificial intelligence',
    'deep learning', 'data engineering', 'data engineer', 'analytics', 'data analyst',
    'business intelligence', 'data platform', 'mlops', 'data'
  ]],
  ['security', [
    'security engineering', 'cyber', 'infosec', 'information security', 'appsec',
    'trust and safety', 'trust & safety', 'security'
  ]],
  ['it-infra', [
    'information technology', 'it management', 'it operations', 'it support', 'helpdesk',
    'help desk', 'service desk', 'systems administration', 'sysadmin', 'network',
    'infrastructure', 'devops', 'site reliability', 'cloud', 'platform engineering', 'it'
  ,
    'solutions architect', 'architect'
  ]],
  ['software', [
    'software development', 'software engineering', 'software engineer', 'software',
    'engineering', 'engineer', 'developer', 'development', 'programming', 'mobile',
    'frontend', 'front end', 'backend', 'back end', 'full stack', 'fullstack', 'qa',
    'quality assurance', 'technology', 'technical', 'tech', 'entwicklung', 'technik'
  ]],
  ['design', [
    'design', 'ux', 'ui', 'user experience', 'user research', 'creative', 'brand design',
    'graphic', 'industrial design', 'gestaltung'
  ]],
  ['product', ['product management', 'product manager', 'product owner', 'product']],

  // --- commercial ---
  ['sales', [
    'sales', 'account executive', 'account management', 'business development',
    'go to market', 'gtm', 'revenue', 'commercial', 'vertrieb', 'partnerships',
    'merchant development', 'field sales'
  ]],
  ['marketing', [
    'marketing', 'communications', 'brand', 'content', 'seo', 'growth', 'public relations',
    'social media', 'demand generation', 'kommunikation'
  ]],
  ['customer', [
    'customer success', 'customer experience', 'customer support', 'customer service',
    'client services', 'support', 'kundenservice'
  ]],

  // --- corporate functions ---
  ['finance', [
    'finance', 'accounting', 'accountant', 'controller', 'treasury', 'audit', 'tax',
    'payroll', 'procurement', 'contracting', 'buchhaltung'
  ]],
  ['legal', ['legal', 'attorney', 'counsel', 'paralegal', 'compliance', 'regulatory', 'recht']],
  ['people', [
    'human resources', 'people operations', 'people', 'recruiting', 'recruitment',
    'talent acquisition', 'talent', 'hr', 'personal'
  ]],

  // --- physical work ---
  ['operations', [
    'supply chain', 'logistics', 'fulfillment', 'fulfilment', 'warehouse', 'magazijn',
    'distribution', 'transportation', 'transport', 'delivery', 'driver', 'courier',
    'inventory', 'shipping', 'freight', 'order fulfillment', 'operations', 'logistik'
  ,
    'motor vehicle', 'vehicle operating', 'fahrer', 'chauffeur'
  ]],
  ['trades', [
    'maintenance', 'mechanic', 'electric', 'plumb', 'welder', 'welding', 'carpenter',
    'construction', 'civil engineering', 'facilities', 'custodial', 'janitor', 'hvac',
    'technician', 'repair', 'installation', 'travaux', 'handwerk'
  ,
    'cleaning', 'cleaner', 'custodian', 'laboring', 'labourer', 'anlagenmechanik', 'warmepumpen', 'mechanik', 'sanitar', 'elektro'
  ]],
  ['manufacturing', [
    'manufacturing', 'production', 'assembly', 'machining', 'fabrication', 'plant',
    'quality control', 'produktion'
  ]],

  // --- service ---
  ['hospitality', [
    'retail', 'store', 'cashier', 'barista', 'restaurant', 'food service', 'hospitality',
    'hotel', 'kitchen', 'chef', 'cook', 'server', 'bartender', 'butikk', 'salle de restaurant',
    'gastronomie', 'einzelhandel'
  ,
    'recreation', 'leisure', 'meatcutting', 'meat cutting', 'catering', 'housekeeping', 'comercio'
  ]],

  // --- research, after the specific sciences above ---
  ['science', ['research', 'laboratory', 'scientist', 'science', 'forschung']],

  // --- the widest net, last, so it only catches what nothing else claimed ---
  ['admin', [
    'administration', 'administrative', 'office management', 'executive assistant',
    'clerk', 'clerical', 'reception', 'secretary', 'business support', 'program analysis',
    'project management', 'program management', 'projektmanagement', 'verwaltung',
    'general business', 'business', 'corporate', 'consulting', 'strategy'
  ]]
];

/**
 * Whole-word containment. The haystack is pre-normalised to lowercase with
 * non-letter runs collapsed to single spaces and a space at each end, so a
 * single indexOf of the space-padded needle is an exact word-boundary test and
 * handles multi-word terms for free.
 *
 * Accents are folded first (NFD, strip combining marks) so `Vertriebsaußendienst`
 * and `Zahnmedizin` match the same way an ASCII term would, and a posting is
 * never filed as unknown because of a diacritic.
 */
function normalise(text) {
  return (
    ' ' +
    String(text == null ? '' : text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() +
    ' '
  );
}

/**
 * COMPOUND LANGUAGES BROKE WHOLE-WORD MATCHING, so a long term may also match
 * at the START of a word. Norwegian, German and Swedish glue their nouns
 * together: `butikkmedarbeider` (shop assistant) contains `butikk` but is not
 * the word `butikk`, and `Anlagenmechanik` is one word, not two. Whole-word
 * matching filed all of them as unknown, which is the state that gets a member
 * nothing.
 *
 * The length floor is the guard. A prefix rule on a short term is a trap —
 * `it` would claim `items`, `hr` would claim `hrvatski`, `qa` would claim
 * `qatar`. Five characters is where a prefix stops being a coincidence and
 * starts being a stem, so terms below it stay strictly whole-word. Both halves
 * of the rule are still one sentence a member can be told: the word is this, or
 * the word starts with this.
 */
const PREFIX_MIN = 5;

function matches(haystack, term) {
  const t = normalise(term).trim();
  if (haystack.includes(' ' + t + ' ')) return true;
  return t.length >= PREFIX_MIN && haystack.includes(' ' + t);
}

/**
 * @param {string} haystack
 * @returns {string | null}
 */
function firstFamilyIn(haystack) {
  for (const [id, terms] of RULES) {
    for (const term of terms) {
      if (matches(haystack, term)) return id;
    }
  }
  return null;
}

/**
 * The family for one posting.
 *
 * THE DEPARTMENT IS TRIED FIRST because it is what the employer filed the job
 * under — a stated fact rather than a reading of a title. 85.7% of the board
 * carries one. The title is the fallback for the other 14.3%, and for the
 * departments that classify nothing (`FLZR`, `Scaling`, `Cody Agency`): a
 * department that means nothing to us must not stop the title from being read.
 *
 * Both null is null. See the header: a gap is shown as a gap.
 */
/**
 * @param {string | null | undefined} department
 * @param {string | null | undefined} title
 * @returns {string | null}
 */
export function familyOf(department, title) {
  const fromDept = firstFamilyIn(normalise(department));
  if (fromDept) return fromDept;
  return firstFamilyIn(normalise(title));
}
