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
 * harness in job-family.test.ts is what catches that. The one other input is
 * NOT_AN_EXTENSION, below: the short list of words the prefix rule may not read
 * as a stem, which keeps `Salesforce` from being `sales`.
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
export const FAMILIES = /** @type {const} */ ([
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
]);

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
 * The family a reader NAMED, as opposed to one the classifier derived.
 *
 * The search box is a substring match over title and company, so a reader who
 * types the name of a field gets almost none of it: "Healthcare" returned 169
 * rows against a Healthcare field of 4,430, and "Marketing" 583 against 868.
 * Typing the name of a field is the most natural thing a person will do with a
 * box that sits next to a control called Field, and it was the worst thing they
 * could do.
 *
 * So a search that IS a field name is read as choosing that field. Exact match
 * on the label only, case and surrounding space ignored — never a substring,
 * because "design" must stay a search for the word design (676 rows across
 * software, marketing and design) rather than being silently turned into the
 * Design field (313). Only the whole label, which nobody types by accident.
 *
 * @param {string | null | undefined} q
 * @returns {string | null} a family id, or null when the text names no field
 */
export function familyFromSearch(q) {
  if (typeof q !== 'string') return null;
  const wanted = q.trim().toLowerCase();
  if (!wanted) return null;
  for (const family of FAMILIES) {
    if (family.label.toLowerCase() === wanted) return family.id;
  }
  return null;
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
  // `counsel` is here and not in the legal rule further down because a lawyer's
  // title usually names the practice first: Commercial Counsel, Product
  // Counsel and Marketing Counsel would each be taken by sales, product and
  // marketing, which sit above that rule, the moment social care stopped
  // claiming the word. It does not reach the person who counsels: Counselor
  // and Counselling are barred from it (see NOT_AN_EXTENSION) and are read by
  // social-care's own terms.
  ['legal', ['legal engineering', 'contract law', 'counsel']],
  ['finance', ['value engineering', 'financial engineering',
    'budget analysis', 'budget'
  ,
    'insurance', 'assurance', 'versicherung'
  ]],
  ['sales', ['sales engineer', 'solutions engineer', 'pre-sales', 'presales']],
  ['science', ['research engineer', 'research scientist']],
  // A data center is a building full of servers, and the people in it rack,
  // cable and replace hardware. The bare `data` that follows is the word for
  // analysis, so `Data Center Technician` was filed under Data & AI, next to
  // the data scientists, for as long as the word `center` was not read.
  ['it-infra', ['data center', 'data centre', 'datacenter', 'datacentre']],

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
    'social work', 'social science', 'psychology', 'psycholog', 'counselor', 'counsellor',
    'counseling', 'counselling', 'chaplain',
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
  ,
    // A Salesforce administrator configures a platform, which is IT work. It
    // is not a seller (the prefix rule filed it under sales, reading
    // `Salesforce` as `sales`) and not office administration, where the bare
    // `administrator` would put it once the prefix is barred.
    // The phrase stops at `admin` so Salesforce Admin and Administrator both
    // land here, and it is NOT a bare `salesforce`, which would also take
    // Salesforce Developer out of software.
    'salesforce admin'
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
  ['legal', ['legal', 'attorney', 'paralegal', 'compliance', 'regulatory', 'recht']],
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
  ]],

  // -------------------------------------------------------------------------
  // THE LONG TAIL, CLAIMED LAST (2026-09-28). 12.3% of the board carried no
  // family, and the top of that pile was not unclassifiable work — it was
  // vocabulary these rules had not been taught. Sjuksköterska, Ärzteteam,
  // Küche, Rakennusala, Correctional Officer, Materials Handler, Loan
  // Specialist. The module already committed to being multilingual; this is
  // the next two hundred words of that commitment, mined from the rows nothing
  // above claimed and measured against the whole corpus one term at a time.
  //
  // WHY THE BLOCK IS LAST AND NOT MERGED UP. Order is the algorithm here, and
  // a term placed inside its family's existing group would be reached BEFORE
  // the more specific rules above it. Measured: a bare `financial` re-files
  // 107 already-placed rows from here, against 16 at the end; `aviation`
  // re-files 26 there against 0. Sitting last, a term can only place a row
  // that is currently unplaced, or re-file one whose DEPARTMENT (not title)
  // names it, because familyOf reads the department first.
  //
  // Coverage 87.8% -> 92.8% on the committed corpus. Twelve already-placed
  // rows move, and three of those are pre-existing mis-files this fixes:
  // "Firefighter (Paramedic)" was health, "Mobiler Autoglasmonteur" was
  // software (the `mobile` term prefix-matched `mobiler`), and a
  // "Chef d'équipe Fibre Optique" was hospitality because of `chef`.
  //
  // The rest stays null on purpose: unsolicited applications, student and
  // intern postings, and titles in non-Latin scripts, which normalise() cannot
  // reach at all. Null is a real answer here and always has been.
  // -------------------------------------------------------------------------
  ['health', [
    'sjukskoterska', 'vardbitrade', 'vardcentral', 'lakare', 'arzt', 'arzte', 'facharzt',
    'medico', 'medici', 'medisch', 'speech pathology', 'orthotist', 'ophthalmology',
    'dermatolog', 'anaesthesi', 'advanced practice provider', 'lpn', 'veterin', 'tierarzt',
    'tiermedizin', 'dierenarts', 'verpleegkund', 'verzorgende', 'helpende', 'somatiek',
    'dementie', 'ouderenzorg', 'apothek', 'farmaceut', 'fisioterap', 'sundhed', 'sykepleier',
    'klinik'
  ]],
  ['social-care', [
    'personlig', 'bpa', 'hjemmehjelper', 'gehandicaptenzorg', 'begeleider', 'hulpverlening',
    'betreuung', 'case manager', 'social services', 'live in care', 'visiting care'
  ]],
  ['education', [
    'lehrkraft', 'fahrlehrer', 'schule', 'training instruction'
  ]],
  ['public-safety', [
    'luchtmacht', 'explosives safety',
    // Both re-file already-placed rows, and every one of those is a fix: a
    // Correctional Officer was unplaced, and `fire protection` takes
    // "Firefighter (Paramedic)" back off health, where `paramedic` had it.
    'correctional officer', 'fire protection'
  ]],
  ['sales', [
    'account manager', 'account partner', 'account director', 'deal desk', 'saljare',
    'forsaljning', 'myynti', 'ventes', 'leasing consultant', 'leasing professional', 'lettings'
  ]],
  ['marketing', [
    'public affairs', 'media optimization', 'paid search', 'community manager'
  ]],
  ['customer', [
    'call center', 'kundtjanst', 'kundendienst', 'customer outcomes'
  ]],
  ['finance', [
    'loan', 'transaction services', 'restructuring', 'valuation', 'ekonom', 'economist',
    'jahresabschluss', 'steuerfach', 'steuerberat', 'lohn', 'kyriba', 'cfo', 'teller',
    'actuarial', 'underwriting', 'underwriter', 'purchasing', 'financial management',
    'financial aid', 'financial analysis', 'financial analyst', 'asset management',
    'portfolio management', 'capital markets'
  ]],
  ['people', [
    'employee relations', 'equal employment opportunity', 'benefits specialist'
  ]],
  ['operations', [
    'materials handler', 'general supply', 'traffic management', 'dispatching', 'dispatcher',
    'cdl', 'truck driving', 'forklift', 'kommissionierer', 'chauffor', 'budbil', 'bargare',
    'autoredder', 'logistiek', 'logistica', 'logistique', 'helicopter pilot', 'airplane pilot',
    'aviation', 'bodenpersonal', 'schiffsbetrieb', 'ship operating', 'deckhand',
    'small craft operating', 'tools and parts', 'parts advisor'
  ]],
  ['trades', [
    'anlaggning', 'rakennus', 'bouw', 'dachdecker', 'werkstatt', 'lackiererei', 'peinture',
    'installatietechniek', 'hitsaaja', 'pipefitt', 'painting', 'painter', 'concrete',
    'insulating', 'plastering', 'scaffold', 'crane operat', 'heavy equipment', 'shipfitting',
    'woodwork', 'utility systems operating',
    // `monteur` re-files 8 placed rows and all 8 are fixes: "Mobiler
    // Autoglasmonteur" is a mobile auto-glass fitter, filed as software
    // because `mobile` prefix-matches `mobiler`.
    'monteur'
  ]],
  ['manufacturing', [
    'sewing machine', 'fabric working', 'fabricating', 'cnc', 'printer operator', 'prepress',
    'print shop'
  ]],
  ['hospitality', [
    'verkaufer', 'verkaufsberater', 'kundenberater', 'fachberater', 'food preparation',
    'food and beverage', 'beverage', 'kuche', 'cuisine', 'waiter', 'servitor', 'kock',
    'souschef', 'barkeeper', 'bartending', 'barman', 'culinary', 'restaurang', 'butik',
    'gouvernante', 'servicekraft', 'housekeeper', 'cafe', 'bakery'
  ]],
  ['science', [
    'meteorology', 'physics', 'hydrology', 'biolog', 'microbiology', 'cartography',
    'environmental protection', 'ecologie', 'industrial hygiene'
  ]],
  ['admin', [
    'linguistic', 'project manager', 'program manager', 'projectleider', 'administrator',
    'administratif', 'secretarieel'
  ]],

  // -------------------------------------------------------------------------
  // THE SECOND TAIL, 2026-09-30. Same method as the block above and the same
  // reason for sitting last.
  //
  // Nothing broke to cause this. The 09-30 discovery pass found 2,917 new live
  // tenants and the board went from 1,666 sources to 2,998 -- 37,765 postings
  // to 52,739 -- and coverage fell from 92.93% to 88.97%, through a floor set
  // two days earlier against a board a third smaller. The rules did not stop
  // describing the board; the board changed shape under them. What arrived was
  // European and physical: Dutch couriers, German bakeries and warehouses,
  // Norwegian cleaning, Swedish construction.
  //
  // Every term below was read off the unmapped tail of the real corpus and
  // measured against all 52,739 rows. Terms that were tempting and are NOT
  // here, because the rows behind them are not one family: bare `management`
  // (75 rows spanning Betriebsleitung, Front of House and General Manager),
  // `service` (39, spanning airport catering, Ford aftersales and Swedish
  // service technicians), `engagement`, `fachkraft` and `ausbildung` -- the
  // last two are German for "skilled worker" and "apprenticeship", which say
  // the shape of the contract and nothing about the work.
  //
  // Still null on purpose, and rightly: Initiativbewerbung and Open
  // Application (unsolicited applications, 29 rows), company names filed as
  // departments (Bikeshift Nederland, Bambinositters, Ballast Nedam), and
  // placeholders like `Hidden (18045)`. A gap is shown as a gap.
  // -------------------------------------------------------------------------
  ['health', [
    // `therapy` and `therapist` were here; the German and Dutch spelling was
    // not, and it is the single largest named department in the tail.
    'therapie', 'physiotherapeut', 'ergotherapeut', 'logopad', 'fysiotherap'
  ]],
  ['education', [
    // A German school-inclusion assistant is education. `pedagogi` did not
    // reach `Pädagogik`, which folds to `padagogik`, not `pedagogik`.
    'schulbegleitung', 'inklusionsassistenz', 'padagogik', 'erzieher', 'kinderopvang'
  ]],
  ['finance', [
    // Workers' Compensation Claim Consultant, Claims Examiner, Multi-Line
    // Claim Representative. `insurance` was already finance; the claims desk
    // that pays it out was not.
    'claims', 'claim', 'comptabilite'
  ]],
  ['sales', ['commercieel', 'aftersales', 'after sales', 'ventas', 'adviseur binnendienst']],
  ['hospitality', [
    // Retail, consistent with `verkaufer` and `einzelhandel` already being
    // hospitality: the department Verkauf here is bakeries and shop branches
    // (Bäckereifachverkäufer, Filialleitung), not B2B sales, which is
    // `vertrieb` and stays where it is.
    // NOT a bare `verkauf`: the prefix rule made it match the department
    // `Plakat-verkauft.de`, a company name, and filed two Regional Sales
    // Managers as retail. The specific words cost a handful of rows and tell
    // the truth. `fachverkaufer` also reaches `Bäckereifachverkäufer`, which
    // folds to `backereifachverkaufer`, only because the prefix rule fires on
    // `backerei`.
    'filialleitung', 'backerei', 'fachverkaufer', 'kassenkraft', 'hostess', 'front of house'
  ]],
  ['operations', [
    // `courier`, `chauffeur` and `driver` were all present and all missed
    // these: Dutch and German glue the noun on the front, so `buschauffeur`
    // does not start with `chauffeur` and the prefix rule never fires.
    'bezorger', 'folderbezorger', 'fietskoerier', 'koerier', 'orderpicker',
    'lager', 'fachlagerist', 'buschauffeur', 'betriebsleitung', 'schichtleitung',
    'shift supervisor'
  ]],
  ['trades', [
    // `labourer` was here in the British spelling only; `laborer` is 11 rows
    // of the no-department pile on its own.
    'laborer', 'techniek', 'autotechnicus', 'servicemonteur', 'servicetekniker',
    'handyman', 'waterproofing', 'renhold', 'bygg', 'nybyggnation', 'entreprenad', 'btp',
    // Dutch mechanical/building-services engineering. Trades and not
    // manufacturing: the rows behind it are Monteur KLP, BIM Engineer and
    // Kostendeskundige Installatietechniek, and `installatietechniek` is
    // already trades.
    'werktuigbouw'
  ]],

  // -------------------------------------------------------------------------
  // THE REPAIR BLOCK, 2026-10-02. Not new vocabulary: these are the homes for
  // words that NOT_AN_EXTENSION stopped the prefix rule from misfiling, so a
  // barred word lands in the family it belongs to and not in none. Last, like
  // the blocks above, so each can only place a row that nothing earlier claims.
  // -------------------------------------------------------------------------
  ['health', [
    // Operating-theatre nurse and technician, which `operations` was claiming
    // through the prefix rule (Operationssjuksköterska, OTA).
    'operationssjukskoterska', 'operationstechnische'
  ]],
  ['manufacturing', [
    // Dutch for production. `product` was claiming it as a prefix, which filed
    // every Productie Operator and Productiemedewerker under Product.
    'productie'
  ]],
  ['trades', [
    // German for technician, which `technik` was claiming as a prefix and
    // filing under software. Whole-word and prefix, so Techniker:in and
    // Technikerarbeit come with it; Servicetechniker is a different word.
    'techniker'
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

/**
 * WORDS THAT ONLY BEGIN WITH A TERM (2026-10-02). The prefix rule is right
 * about stems and blind to coincidence, and a length floor cannot tell them
 * apart: `sales` is the stem of `salespeople` and also the first five letters
 * of `Salesforce`, a CRM product that has nothing to do with selling.
 * `Salesforce Administrator` was a sales job on the strength of it.
 *
 * Measured over the corpus fixture, 577 (term, word) pairs matched ONLY as a
 * prefix. Nearly all are what the rule is for: engineer / engineering, driver /
 * drivers, and the stems chosen to be stems (veterin, elektro, medizin, radiolog).
 * The ones below are a different word. Each was found by reading every pair and
 * checking which family the match decided. Each entry carries its reason, and
 * a count, where one is given, is the number of prefix matches on that fixture.
 *
 * A TABLE, NOT A SMARTER RULE, on purpose. A minimum suffix length or a
 * dictionary would be one more thing a member cannot read, and this value
 * decides what a member is not shown. This list can be argued with line by line.
 *
 * WHAT A BAR DOES AND DOES NOT DO. It closes the PREFIX route only: a barred
 * word is skipped, and any later rule that wants it still gets it, so
 * `production` leaves `product` and is picked up by manufacturing's own
 * `production`, and a lone `Sales` is still sales. A word is barred when it
 * STARTS with an entry, which is how one entry covers the plural and the
 * compounds (`productie` also bars `productiemedewerker`). Entries are single
 * words, written the way normalise() writes them, and a new false positive is
 * one more line here, never a re-ordering of the rules.
 *
 * @type {ReadonlyMap<string, readonly string[]>}
 */
const NOT_AN_EXTENSION = new Map(
  Object.entries({
    // A product, not the act of selling. 121 matches; it filed a Salesforce
    // Administrator and a Salesforce Project Manager under sales.
    sales: ['salesforce'],
    // The factory floor, the Dutch word for it, and productivity are not
    // product management. `production` alone was 449 matches and filed every
    // Production Controller and Production Team Member under Product.
    product: ['production', 'productie', 'productiv'],
    // Fire protection in German, Dutch and Swedish, and two place names.
    // Brandschutz is not a brand.
    brand: [
      'brandschutz', 'brandveilig', 'brandskydd', 'brandtatning', 'brandenburg', 'brandermill'
    ],
    // A children's nursery is not a nurse.
    nurse: ['nursery'],
    // Developmental disabilities services are social care, not software.
    development: ['developmental'],
    // Designated Managing Broker is not design.
    design: ['designated'],
    // Personalization and personality; the German Personal (staff) is kept.
    personal: ['personaliz', 'personalis', 'personalit'],
    // A city in Ontario, which turns up in titles ("Detailer - Kitchener").
    kitchen: ['kitchener'],
    // A town in Illinois ("Maintenance Technician - Carpentersville").
    carpenter: ['carpentersville'],
    // A medical-school clerkship is not office clerking.
    clerk: ['clerkship'],
    // Spanish for a staff template, and Swedish for planting.
    plant: ['plantilla', 'plantering'],
    // The adjective, not the HR noun: "Talented Driven Professional".
    talent: ['talented'],
    // German for a mobile service ("Mobiler Autoglasmonteur"), not mobile apps.
    mobile: ['mobiler'],
    // Developing countries, not software development.
    entwicklung: ['entwicklungsland'],
    // German `Schüler` is a pupil, so a Schülerpraktikum is an internship FOR
    // pupils, not a job in a school. Intern postings are left null on purpose
    // (see the first tail block), and these now are.
    schule: ['schuler'],
    // The German technician is a tradesman; `technik` is the technology.
    // Filed Kfz-Techniker and Gebäudeautomation technicians under software.
    // `techniker` is a trades term in the last block below, beside `technician`.
    technik: ['techniker'],
    // The operating-theatre nurse and technician are health, not operations;
    // both are health terms in the last block below.
    operations: ['operationssjukskoterska', 'operationstechnische'],
    // The person who counsels is social care's, and `counsel` is the lawyer.
    // Without this the early legal rule would claim every Counselor.
    counsel: ['counselor', 'counsellor', 'counseling', 'counselling']
  }).map(([term, words]) => [normalise(term).trim(), words])
);

/**
 * Whether `term` occurs in `haystack` as a whole word, or (for a long enough
 * term) at the start of a word that NOT_AN_EXTENSION does not bar.
 */
function matches(haystack, term) {
  const t = normalise(term).trim();
  if (haystack.includes(' ' + t + ' ')) return true;
  if (t.length < PREFIX_MIN) return false;
  const barred = NOT_AN_EXTENSION.get(t);
  if (!barred) return haystack.includes(' ' + t);
  // A bar belongs to a word, and a haystack can hold the term twice, so every
  // occurrence is tried: one barred word must not hide a good one beside it.
  for (let at = haystack.indexOf(' ' + t); at !== -1; at = haystack.indexOf(' ' + t, at + 1)) {
    const word = haystack.slice(at + 1, haystack.indexOf(' ', at + 1));
    if (!barred.some((b) => word.startsWith(b))) return true;
  }
  return false;
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
