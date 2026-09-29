import { describe, expect, it } from 'vitest';
import { resolvePosting, type Extraction } from './posting-resolvers';
import type { FailureCode } from './posting-fetch-store';

/** Either a full `Resolved` or its `fallback` -- both are "an api and a
    parse", which is all `fail`/`ok` below need. */
type Parseable = { parse: (body: string) => Extraction | FailureCode };

/** Ported from `test_postfetch.py`'s `Resolvers` and `Parsers` classes,
    restricted to the six board systems this pass covers (greenhouse, ashby,
    lever, workable, rippling, workday). BambooHR, Teamtailor and Eightfold
    are in the Python but out of scope for this module -- see
    `docs/posting-fast-read-spec.md`.

    Company is asserted two ways since the "Correction, same day" pass split
    it in two: `parse()`'s own extraction carries only what the payload
    itself gives (often nothing -- most of these six never put a company on
    the job payload), and `companyHint` on the `Resolved` is the fallback the
    CALLER applies when neither the payload nor `companyApi` (Greenhouse
    only) name one. A test that wants "the company a person would see" reads
    both. */

function fail(resolved: Parseable | null | undefined, body: string): FailureCode {
  const result = resolved!.parse(body);
  if (typeof result !== 'string') throw new Error('expected a failure code, got an extraction');
  return result;
}

function ok(resolved: Parseable | null | undefined, body: string): Extraction {
  const result = resolved!.parse(body);
  if (typeof result === 'string') throw new Error(`expected an extraction, got failure code ${result}`);
  return result;
}

describe('resolvePosting: each board system maps to its own API', () => {
  const cases: Array<[string, string, string]> = [
    ['https://boards.greenhouse.io/brex/jobs/8782440002', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/brex/jobs/8782440002'],
    ['https://job-boards.greenhouse.io/figma/jobs/123456', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/figma/jobs/123456'],
    ['https://www.brex.com/careers/8782440002?gh_jid=8782440002', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/brex/jobs/8782440002'],
    ['https://jobs.ashbyhq.com/writer/97d2b656-e084-4910-85a9-ca8d55cd302c', 'ashby', 'https://api.ashbyhq.com/posting-api/job-board/writer?includeCompensation=true'],
    ['https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0', 'lever', 'https://api.lever.co/v0/postings/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0'],
    ['https://apply.workable.com/rivecareers/j/ABC123DEF/', 'workable', 'https://apply.workable.com/api/v2/accounts/rivecareers/jobs/ABC123DEF'],
    ['https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11', 'rippling', 'https://api.rippling.com/platform/api/ats/v1/board/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11'],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000',
      'workday',
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000'
    ]
  ];

  for (const [url, kind, api] of cases) {
    it(`resolves ${url}`, () => {
      const resolved = resolvePosting(url);
      expect(resolved).not.toBeNull();
      expect(resolved!.kind).toBe(kind);
      expect(resolved!.api).toBe(api);
    });
  }

  it('titles the org slug as the company hint', () => {
    const resolved = resolvePosting('https://jobs.lever.co/contentsquare/1b283445-c4cd-4b88-be80-1d3a492bd6c0');
    expect(resolved!.companyHint).toBe('Contentsquare');
  });
});

describe('resolvePosting: an unknown page has no plan', () => {
  const urls = ['https://careers.example.com/jobs/123', 'https://jobs.ashbyhq.com/writer', 'not a url at all'];
  for (const url of urls) {
    it(`returns null for ${url}`, () => {
      expect(resolvePosting(url)).toBeNull();
    });
  }
});

describe('companyHint is present and title-cased on every resolver', () => {
  const cases: Array<[string, string]> = [
    ['https://boards.greenhouse.io/one-password/jobs/8782440002', 'One Password'],
    ['https://jobs.ashbyhq.com/writer/97d2b656-e084-4910-85a9-ca8d55cd302c', 'Writer'],
    ['https://jobs.lever.co/contentsquare/1b283445-c4cd-4b88-be80-1d3a492bd6c0', 'Contentsquare'],
    ['https://apply.workable.com/rive-careers/j/ABC123DEF/', 'Rive Careers'],
    ['https://ats.rippling.com/arcadia_careers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11', 'Arcadia Careers'],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000',
      'Nvidia'
    ]
  ];
  for (const [url, hint] of cases) {
    it(`hints "${hint}" for ${url}`, () => {
      expect(resolvePosting(url)!.companyHint).toBe(hint);
    });
  }
});

describe('fallback is Workable-only', () => {
  const urls: Array<[string, string]> = [
    ['https://boards.greenhouse.io/brex/jobs/8782440002', 'greenhouse'],
    ['https://jobs.ashbyhq.com/writer/97d2b656-e084-4910-85a9-ca8d55cd302c', 'ashby'],
    ['https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0', 'lever'],
    ['https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11', 'rippling'],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000',
      'workday'
    ]
  ];
  for (const [url, kind] of urls) {
    it(`${kind} has no fallback`, () => {
      expect(resolvePosting(url)!.fallback).toBeUndefined();
    });
  }

  it('workable has a fallback against the v1 board-wide widget list', () => {
    const resolved = resolvePosting('https://apply.workable.com/rivecareers/j/ABC123DEF/')!;
    expect(resolved.fallback).toBeDefined();
    expect(resolved.fallback!.api).toBe('https://apply.workable.com/api/v1/widget/accounts/rivecareers?details=true');
  });

  it("the fallback is tried when the primary parse fails, and reads the matching job's shortcode", () => {
    const resolved = resolvePosting('https://apply.workable.com/rivecareers/j/ABC123DEF/')!;
    // The v2 endpoint answered something that is not a usable posting (a
    // live 404 body, or a shape with no title) -- the caller would move on
    // to the fallback at this point.
    expect(fail(resolved, JSON.stringify({ error: 'not found' }))).toBe('no_content');
    const listBody = JSON.stringify({
      jobs: [
        { shortcode: 'ABC123DEF', title: 'Senior Product Manager', description: '<p>We build the thing.</p>' },
        { shortcode: 'ZZZ999', title: 'Someone else', description: '<p>Not this one.</p>' }
      ]
    });
    const found = ok(resolved.fallback!, listBody);
    expect(found.title).toBe('Senior Product Manager');
    expect(found.descriptionHtml).toBe('<p>We build the thing.</p>');
  });

  it('the fallback also fails with no_content when no shortcode matches', () => {
    const resolved = resolvePosting('https://apply.workable.com/rivecareers/j/ABC123DEF/')!;
    const listBody = JSON.stringify({ jobs: [{ shortcode: 'SOMETHING-ELSE', title: 'x' }] });
    expect(fail(resolved.fallback!, listBody)).toBe('no_content');
  });
});

describe('companyApi/companyParse is Greenhouse-only', () => {
  const urls: Array<[string, string]> = [
    ['https://jobs.ashbyhq.com/writer/97d2b656-e084-4910-85a9-ca8d55cd302c', 'ashby'],
    ['https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0', 'lever'],
    ['https://apply.workable.com/rivecareers/j/ABC123DEF/', 'workable'],
    ['https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11', 'rippling'],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000',
      'workday'
    ]
  ];
  for (const [url, kind] of urls) {
    it(`${kind} has neither companyApi nor companyParse`, () => {
      const resolved = resolvePosting(url)!;
      expect(resolved.companyApi).toBeUndefined();
      expect(resolved.companyParse).toBeUndefined();
    });
  }

  it('greenhouse points companyApi at the board-list endpoint', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002')!;
    expect(resolved.companyApi).toBe('https://boards-api.greenhouse.io/v1/boards/brex');
    expect(typeof resolved.companyParse).toBe('function');
  });

  it("companyParse reads the board's own name out of a _parse_greenhouse_board-shaped payload", () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002')!;
    expect(resolved.companyParse!(JSON.stringify({ name: 'Brex' }))).toBe('Brex');
  });

  it('companyParse is defensive about a payload with no usable name', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002')!;
    expect(resolved.companyParse!(JSON.stringify({}))).toBeNull();
    expect(resolved.companyParse!('not json')).toBeNull();
  });
});

describe('parse: greenhouse unescapes exactly once', () => {
  it('decodes the doubly-encoded content; the payload never names a company', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002');
    const body = JSON.stringify({
      title: 'Senior Brand Designer',
      content: '&lt;div&gt;&lt;p&gt;Brex is hiring a Senior Brand Designer.&lt;/p&gt;&lt;/div&gt;'
    });
    const found = ok(resolved, body);
    expect(found.kind).toBe('greenhouse');
    expect(found.title).toBe('Senior Brand Designer');
    expect(found.descriptionHtml?.startsWith('<div><p>Brex')).toBe(true);
    expect(found.descriptionHtml).not.toContain('&lt;');
    // Company is never on this payload -- resolvePosting's companyApi is
    // the caller's next step, and companyHint ("Brex") is the last resort.
    expect(found.company).toBeNull();
    expect(resolved!.companyHint).toBe('Brex');
    expect(found.finalUrl).toBe('https://boards.greenhouse.io/brex/jobs/8782440002');
  });

  it('fails with no_content when the payload has no title', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002');
    expect(fail(resolved, JSON.stringify({ content: 'x' }))).toBe('no_content');
    expect(fail(resolved, 'not json')).toBe('no_content');
  });
});

describe('parse: lever reassembles the three parts', () => {
  it('builds the heading/list block and appends the boilerplate', () => {
    const resolved = resolvePosting('https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0');
    const body = JSON.stringify({
      text: 'Infrastructure engineer (UK)',
      description: '<p>Run the platform that keeps everything else up.</p>',
      lists: [{ text: 'What you will do', content: '<li>Run the training pipelines</li>' }],
      additional: '<p>Writer is an equal opportunity employer.</p>',
      categories: { team: 'Platform' }
    });
    const found = ok(resolved, body);
    expect(found.title).toBe('Infrastructure engineer (UK)');
    expect(found.descriptionHtml).toContain('<h3>What you will do</h3><ul><li>Run the training');
    expect(found.descriptionHtml?.endsWith('equal opportunity employer.</p>')).toBe(true);
    // categories.team ("Platform") is read by the Python and discarded --
    // both branches of its own conditional yield None -- so this file's
    // company is null too, and the caller falls back to companyHint.
    expect(found.company).toBeNull();
    expect(resolved!.companyHint).toBe('Writer');
  });

  it('fails with no_content when there is no text field', () => {
    const resolved = resolvePosting('https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0');
    expect(fail(resolved, JSON.stringify({ description: 'x' }))).toBe('no_content');
  });
});

describe('parse: rippling orders role before company', () => {
  it('puts the role paragraph ahead of the about-the-company paragraph', () => {
    const resolved = resolvePosting('https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11');
    const body = JSON.stringify({
      name: 'Product Designer',
      companyName: 'Arcadia',
      description: {
        role: 'As a Product Designer at Arcadia you will shape the whole product surface.',
        company: 'About Arcadia: we build tools that keep the lights on.',
        benefits: 'Health, dental and a real vacation policy.'
      }
    });
    const found = ok(resolved, body);
    expect(found.title).toBe('Product Designer');
    // Rippling's own companyName IS on the payload, so parse() itself
    // carries it -- no fallback needed here.
    expect(found.company).toBe('Arcadia');
    const html = found.descriptionHtml ?? '';
    expect(html.indexOf('As a Product Designer')).toBeLessThan(html.indexOf('About Arcadia'));
    expect(html).toContain('Health, dental');
  });

  it('accepts a plain string description too, and falls back to the org-slug hint with no companyName', () => {
    const resolved = resolvePosting('https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11');
    const found = ok(resolved, JSON.stringify({ name: 'Product Designer', description: '<p>x</p>' }));
    expect(found.descriptionHtml).toBe('<p>x</p>');
    expect(found.company).toBeNull();
    expect(resolved!.companyHint).toBe('Arcadiacareers');
  });

  it('fails with no_content when there is no name', () => {
    const resolved = resolvePosting('https://ats.rippling.com/arcadiacareers/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11');
    expect(fail(resolved, JSON.stringify({ description: 'x' }))).toBe('no_content');
  });
});

describe('parse: ashby picks the matching id', () => {
  const url = 'https://jobs.ashbyhq.com/writer/97d2b656-e084-4910-85a9-ca8d55cd302c';
  const body = JSON.stringify({
    jobs: [
      { id: '97d2b656-e084-4910-85a9-ca8d55cd302c', title: 'Infrastructure engineer', descriptionHtml: '<p>Build the infra.</p>' },
      { id: 'other-job-id', title: 'Some other role', descriptionHtml: '<p>Not this one.</p>' }
    ]
  });

  it('returns the job whose id matches the URL, with no company on the payload', () => {
    const found = ok(resolvePosting(url), body);
    expect(found.title).toBe('Infrastructure engineer');
    expect(found.company).toBeNull();
    expect(resolvePosting(url)!.companyHint).toBe('Writer');
  });

  it('matches the id case-insensitively', () => {
    const upper = JSON.stringify({
      jobs: [{ id: '97D2B656-E084-4910-85A9-CA8D55CD302C', title: 'Infrastructure engineer', descriptionHtml: null }]
    });
    expect(ok(resolvePosting(url), upper).title).toBe('Infrastructure engineer');
  });

  it('fails with no_content when nothing in the board matches the id', () => {
    const resolved = resolvePosting('https://jobs.ashbyhq.com/writer/00000000-0000-0000-0000-000000000000');
    expect(fail(resolved, body)).toBe('no_content');
  });
});

describe('parse: workable joins description, requirements and benefits', () => {
  const url = 'https://apply.workable.com/rivecareers/j/ABC123DEF/';

  it('joins the three text fields present; no company on the v2 payload', () => {
    const body = JSON.stringify({
      title: 'Senior Product Manager',
      description: 'We build the thing.',
      requirements: 'Five years of it.',
      benefits: 'Good benefits.'
    });
    const found = ok(resolvePosting(url), body);
    expect(found.title).toBe('Senior Product Manager');
    expect(found.descriptionHtml).toBe('We build the thing.\nFive years of it.\nGood benefits.');
    expect(found.company).toBeNull();
    expect(resolvePosting(url)!.companyHint).toBe('Rivecareers');
  });

  it('fails with no_content when the payload has no title', () => {
    expect(fail(resolvePosting(url), JSON.stringify({ description: 'x' }))).toBe('no_content');
  });
});

describe('parse: workday reads the posting info', () => {
  const url =
    'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-UX-Designer_JR1990000';

  it('reads the title out of jobPostingInfo; no company on the payload', () => {
    const body = JSON.stringify({
      jobPostingInfo: { title: 'Senior UX Designer', startDate: '2026-06-01', jobDescription: '<p>Design the UX.</p>' }
    });
    const found = ok(resolvePosting(url), body);
    expect(found.title).toBe('Senior UX Designer');
    expect(found.descriptionHtml).toBe('<p>Design the UX.</p>');
    expect(found.company).toBeNull();
    expect(resolvePosting(url)!.companyHint).toBe('Nvidia');
  });

  it('fails with no_content when jobPostingInfo is missing or title-less', () => {
    expect(fail(resolvePosting(url), JSON.stringify({}))).toBe('no_content');
    expect(fail(resolvePosting(url), JSON.stringify({ jobPostingInfo: {} }))).toBe('no_content');
  });
});

describe('DESCRIPTION_MAX_CHARS and NAME_MAX_CHARS caps', () => {
  it('caps a title at NAME_MAX_CHARS', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/brex/jobs/8782440002');
    const found = ok(resolved, JSON.stringify({ title: 'x'.repeat(600) }));
    expect(found.title?.length).toBe(500);
  });

  it('caps a description at DESCRIPTION_MAX_CHARS', () => {
    const resolved = resolvePosting('https://jobs.lever.co/writer/1b283445-c4cd-4b88-be80-1d3a492bd6c0');
    const huge = 'a'.repeat(130_000);
    const found = ok(resolved, JSON.stringify({ text: 'Role', description: huge }));
    expect(found.descriptionHtml?.length).toBe(120_000);
  });
});

/** A jobs.apple.com page carrying the payload the way Apple carries it: a
    JavaScript string literal whose contents are JSON, so `JSON.stringify` of
    the JSON text produces exactly the `\"`-escaped literal the real page has.
    Everything outside the script is the shell the generic extractor sees --
    and finds nothing in, which is why this resolver exists. */
function applePage(jobsData: unknown, routeId = 'jobDetails'): string {
  const payload = JSON.stringify({ loaderData: { root: { locale: 'en-us' }, [routeId]: { jobsData } } });
  return [
    '<!doctype html><html lang="en-US"><head><title data-rh="true">Jobs at Apple</title></head>',
    '<body><nav>Apple nav</nav><div id="jobdetails-wrapper"></div>',
    `<script nonce="DOmQh3DqQ9CMYXLiNrVf9g==">window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(payload)});</script>`,
    '<footer>Apple is an equal opportunity employer.</footer></body></html>'
  ].join('');
}

const APPLE_URL = 'https://jobs.apple.com/en-us/details/200680033-0670/product-designer-design-systems?team=DESGN';

describe('resolvePosting: apple', () => {
  it('resolves a posting URL to the page itself, since there is no JSON endpoint', () => {
    const resolved = resolvePosting(APPLE_URL);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe('apple');
    expect(resolved!.api).toBe(APPLE_URL);
    // Verbatim: the slug-less form 301s, and a hop is a third of the budget.
    expect(resolved!.companyHint).toBe('Apple');
    expect(resolved!.fallback).toBeUndefined();
    expect(resolved!.companyApi).toBeUndefined();
  });

  it('resolves a posting with no slug on the end, and a non-English locale', () => {
    expect(resolvePosting('https://jobs.apple.com/de-de/details/200680033-0670')!.kind).toBe('apple');
  });

  const notPostings = [
    'https://jobs.apple.com/en-us/search?team=DESGN',
    'https://jobs.apple.com/en-us/details',
    'https://jobs.apple.com/en-us/details/not-a-number/some-role',
    'https://jobs.apple.com/details/200680033-0670/some-role',
    'https://www.apple.com/en-us/details/200680033-0670/some-role'
  ];
  for (const url of notPostings) {
    it(`does not claim ${url}`, () => {
      expect(resolvePosting(url)).toBeNull();
    });
  }
});

describe('parse: apple reads the hydration blob', () => {
  const jobsData = {
    postingTitle: 'Product Designer, Design Systems',
    // Hard-wrapped at ~85 columns, with a real paragraph break, exactly as
    // Apple ships it.
    jobSummary: 'Apple Services: App Store, Apple Music, Apple TV, and many more\nare among the most exciting in the world.',
    description: 'The Services Design Systems team is seeking an experienced systems designer to shape\nour design system.\n\nThe position requires deliverables under tight deadlines.',
    // One whole item per line, not wrapped.
    responsibilities: 'Design, build, and maintain design system components.\nPartner closely with design and engineering teams.',
    minimumQualifications: '7+ years of design experience.\nA portfolio of work that showcases excellence.',
    preferredQualifications: 'Able to work independently and in a team environment.',
    postingFooters: [{ localizations: { en_US: [{ name: 'Pay & Benefits', content: 'The base pay range is between $175,000 and $263,300.<br>Apple is an equal opportunity employer.' }] } }],
    selectedLocale: 'en_US',
    translations: { en_US: { 'jobsite.jobdetails.summary': 'Summary', 'jobsite.jobdetails.responsibilities': 'Responsibilities' } }
  };

  it('builds the five sections in the order the page shows them', () => {
    const extraction = ok(resolvePosting(APPLE_URL), applePage(jobsData));
    expect(extraction.kind).toBe('apple');
    expect(extraction.title).toBe('Product Designer, Design Systems');
    // The payload never names the employer; `companyHint` is the caller's job.
    expect(extraction.company).toBeNull();
    const html = extraction.descriptionHtml!;
    const order = ['Summary', 'Description', 'Responsibilities', 'Minimum Qualifications', 'Preferred Qualifications']
      .map((heading) => html.indexOf(`<h3>${heading}</h3>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('undoes the hard wrap in prose and keeps the paragraph break', () => {
    const html = ok(resolvePosting(APPLE_URL), applePage(jobsData)).descriptionHtml!;
    expect(html).toContain('<p>Apple Services: App Store, Apple Music, Apple TV, and many more are among the most exciting in the world.</p>');
    expect(html).toContain('<p>The Services Design Systems team is seeking an experienced systems designer to shape our design system.</p>');
    expect(html).toContain('<p>The position requires deliverables under tight deadlines.</p>');
  });

  it('makes one list item per line in the three list fields, and never a paragraph', () => {
    const html = ok(resolvePosting(APPLE_URL), applePage(jobsData)).descriptionHtml!;
    expect(html).toContain('<ul><li>Design, build, and maintain design system components.</li><li>Partner closely with design and engineering teams.</li></ul>');
    expect(html).toContain('<ul><li>7+ years of design experience.</li><li>A portfolio of work that showcases excellence.</li></ul>');
    expect(html).toContain('<ul><li>Able to work independently and in a team environment.</li></ul>');
  });

  it("leaves out the pay-and-benefits footer, boilerplate and range together", () => {
    const html = ok(resolvePosting(APPLE_URL), applePage(jobsData)).descriptionHtml!;
    expect(html).not.toContain('equal opportunity');
    expect(html).not.toContain('263,300');
  });

  it('takes each heading from the payload and falls back to English for the rest', () => {
    const html = ok(resolvePosting(APPLE_URL), applePage({
      ...jobsData,
      selectedLocale: 'de_DE',
      translations: { de_DE: { 'jobsite.jobdetails.summary': 'Zusammenfassung' } }
    })).descriptionHtml!;
    expect(html).toContain('<h3>Zusammenfassung</h3>');
    expect(html).toContain('<h3>Description</h3>');
  });

  it('survives a quotation mark in the body, which a lazy regex would truncate on', () => {
    const extraction = ok(resolvePosting(APPLE_URL), applePage({
      ...jobsData,
      description: 'We call it "the system" here.',
      preferredQualifications: 'A last field, after the quote.'
    }));
    expect(extraction.descriptionHtml).toContain('We call it &quot;the system&quot; here.');
    expect(extraction.descriptionHtml).toContain('A last field, after the quote.');
  });

  it('escapes the prose rather than trusting it as markup', () => {
    const html = ok(resolvePosting(APPLE_URL), applePage({
      ...jobsData,
      responsibilities: 'Ship <script>alert(1)</script> safely.'
    })).descriptionHtml!;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('finds the posting by the shape of the route data, not by the route id', () => {
    const extraction = ok(resolvePosting(APPLE_URL), applePage(jobsData, 'routes/details-renamed'));
    expect(extraction.title).toBe('Product Designer, Design Systems');
  });

  it('fails with no_content on a page with no hydration blob', () => {
    expect(fail(resolvePosting(APPLE_URL), '<!doctype html><html><body><p>Nothing here.</p></body></html>')).toBe('no_content');
  });

  it('fails with no_content when the blob carries no posting', () => {
    expect(fail(resolvePosting(APPLE_URL), applePage({ postingTitle: '' }))).toBe('no_content');
    expect(fail(resolvePosting(APPLE_URL), '<script>window.__staticRouterHydrationData = JSON.parse("{ not json");</script>')).toBe('no_content');
  });

  it('reports a title with no readable section as an extraction with no description, not a failure', () => {
    // The convention every parser in this file keeps, stated in
    // posting-extraction.ts: a reader says what the source said, and the
    // caller decides a body-less posting is not worth settling on
    // (`usable()` in posting-read.ts, which falls through to the mini).
    const extraction = ok(resolvePosting(APPLE_URL), applePage({ postingTitle: 'A role', description: '   ' }));
    expect(extraction.title).toBe('A role');
    expect(extraction.descriptionHtml).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   THE FACTS EACH PAYLOAD STATES.

   Shapes below are trimmed copies of real responses recorded on 2026-09-29,
   keeping the fields that matter and the exact spellings each platform uses
   (Ashby's "1 YEAR", Rippling's "HOUR", Lever's epoch-millisecond dates).
   ------------------------------------------------------------------------- */

describe('facts: a stated string is never a parsed one', () => {
  it('Apple states its range in a sentence, so it carries words and no numbers', () => {
    const page = applePage({
      postingTitle: 'A role',
      description: 'Body text long enough to keep.',
      locations: [{ city: 'Culver City', stateProvince: 'California', countryName: 'United States' }],
      teamNames: ['Design'],
      employmentType: 'Standard',
      homeOffice: false,
      postDateInGMT: '2026-08-26T02:33:27.734+00:00',
      postingFooters: [{ localizations: { en_US: [{
        name: 'Pay & Benefits',
        content: 'The base pay range for this role is between $175,000 and $263,300, and your base pay will depend on your skills.<br><br>Apple employees also have the opportunity to become an Apple shareholder, and receive medical and dental coverage.'
      }] } }]
    });
    const e = ok(resolvePosting(APPLE_URL), page);
    expect(e.compPosted).toContain('$175,000 and $263,300');
    // The numbers are RIGHT THERE and are still not taken: the rule is the
    // mini's, above _comp_job -- a stated string is not a parsed one.
    expect(e.compMinK).toBeNull();
    expect(e.compMaxK).toBeNull();
    // Only the pay paragraph, not the benefits blurb that follows it.
    expect(e.compPosted).not.toContain('dental');
    expect(e.location).toBe('Culver City, California, United States');
    expect(e.country).toBe('United States');
    expect(e.remote).toBe(false);
    expect(e.department).toBe('Design');
    expect(e.employmentType).toBe('Standard');
    expect(e.published).toBe('2026-08-26T02:33:27.734Z');
  });

  it('says how many other places a posting names rather than claiming one', () => {
    const e = ok(resolvePosting(APPLE_URL), applePage({
      postingTitle: 'A role',
      description: 'Body text long enough to keep.',
      locations: [
        { city: 'Culver City', stateProvince: 'California', countryName: 'United States' },
        { city: 'Austin', stateProvince: 'Texas', countryName: 'United States' }
      ]
    }));
    expect(e.location).toBe('Culver City, California, United States and 1 more');
  });
});

describe('facts: an interval is never assumed', () => {
  const RIPPLING = 'https://ats.rippling.com/acme/jobs/8b6b1b4e-4a7a-4d6a-9d34-3b2f8c1a0f11';
  const ripplingBody = (frequency: string) => JSON.stringify({
    name: 'Intake Specialist',
    companyName: 'Mindset Care, Inc.',
    description: { role: 'A body long enough to be worth keeping on this posting.' },
    workLocations: ['Remote'],
    department: { name: 'Intake' },
    employmentType: { id: 'Hourly, full-time', label: 'HOURLY_FT' },
    createdOn: '2026-08-10T11:43:28.684000-07:00',
    payRangeDetails: [{ location: 'Remote', currency: 'USD', frequency, rangeStart: 18.0, rangeEnd: 25.0, isRemote: true }]
  });

  it('refuses an hourly range rather than filing $18/hour as an $18K salary', () => {
    const e = ok(resolvePosting(RIPPLING), ripplingBody('HOUR'));
    expect(e.compMinK).toBeNull();
    expect(e.compMaxK).toBeNull();
    // Everything else on the payload still lands.
    expect(e.location).toBe('Remote');
    expect(e.remote).toBe(true);
    expect(e.department).toBe('Intake');
    expect(e.employmentType).toBe('Hourly, full-time');
    expect(e.published).toBe('2026-08-10T18:43:28.684Z');
  });

  it('refuses $18-$25 even when the platform calls it annual, rather than storing 0', () => {
    // The second line of defence, and the one that catches a platform lying
    // about its own interval: 18 divided into thousands rounds to 0, and a
    // job filed at 0 is worse than a job filed at nothing.
    const e = ok(resolvePosting(RIPPLING), ripplingBody('YEAR'));
    expect(e.compMinK).toBeNull();
    expect(e.compMaxK).toBeNull();
  });

  it('takes a real annual range when the platform says it is annual', () => {
    const body = JSON.parse(ripplingBody('YEAR'));
    body.payRangeDetails[0].rangeStart = 95000;
    body.payRangeDetails[0].rangeEnd = 130000;
    const e = ok(resolvePosting(RIPPLING), JSON.stringify(body));
    expect(e.compMinK).toBe(95);
    expect(e.compMaxK).toBe(130);
  });

  it('treats an interval nobody has seen as unknown, not as annual', () => {
    const e = ok(resolvePosting(RIPPLING), ripplingBody('FORTNIGHT'));
    expect(e.compMinK).toBeNull();
  });
});

describe('facts: ashby, the richest payload of the six', () => {
  const ASHBY = 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245';
  const board = (components: unknown) => JSON.stringify({
    jobs: [{
      id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      title: 'Security Engineer, Cloud',
      descriptionHtml: '<p>A body long enough to be worth keeping on this posting.</p>',
      location: 'New York, NY (HQ)',
      isRemote: true,
      publishedAt: '2026-04-07T17:12:35.753+00:00',
      department: 'Engineering',
      employmentType: 'FullTime',
      compensation: { compensationTierSummary: '$211.4K – $290.6K • Offers Equity', summaryComponents: components }
    }]
  });

  it('reads the annual salary component and rounds to the board\'s thousands', () => {
    const e = ok(resolvePosting(ASHBY), board([
      { compensationType: 'EquityPercentage', interval: 'NONE', minValue: null, maxValue: null },
      { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 211400, maxValue: 290600 }
    ]));
    expect(e.compMinK).toBe(211);
    expect(e.compMaxK).toBe(291);
    expect(e.compPosted).toBe('$211.4K – $290.6K • Offers Equity');
    expect(e.location).toBe('New York, NY (HQ)');
    expect(e.remote).toBe(true);
    expect(e.department).toBe('Engineering');
  });

  it('never mistakes the equity component for the salary, whatever its order', () => {
    const e = ok(resolvePosting(ASHBY), board([
      { compensationType: 'EquityPercentage', interval: 'NONE', minValue: 5, maxValue: 10 }
    ]));
    expect(e.compMinK).toBeNull();
    expect(e.compMaxK).toBeNull();
    // The summary Ashby wrote still shows: the words survive a missing number.
    expect(e.compPosted).toBe('$211.4K – $290.6K • Offers Equity');
  });
});

describe('facts: the fields the header said were lost', () => {
  it("Workday's startDate lands in published, and postedOn prose is not read", () => {
    const e = ok(
      resolvePosting('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1'),
      JSON.stringify({ jobPostingInfo: {
        title: 'PCB Design Layout Engineer',
        jobDescription: '<p>A body long enough to be worth keeping on this posting.</p>',
        location: 'US, CA, Santa Clara',
        startDate: '2026-09-04',
        postedOn: 'Posted 25 Days Ago',
        timeType: 'Full time',
        country: { descriptor: 'United States of America' }
      } })
    );
    expect(e.published).toBe('2026-09-04T00:00:00.000Z');
    expect(e.location).toBe('US, CA, Santa Clara');
    expect(e.country).toBe('United States of America');
    expect(e.employmentType).toBe('Full time');
  });

  it("Lever's department stops being read and thrown away", () => {
    const e = ok(
      resolvePosting('https://jobs.lever.co/spotify/c152d042-642d-4a48-862b-8be8d6cdc819'),
      JSON.stringify({
        text: 'Communications Lead',
        description: 'A body long enough to be worth keeping on this posting.',
        categories: { commitment: 'Permanent', department: 'Public Affairs', location: 'Dubai', team: 'PR' },
        country: 'AE',
        workplaceType: 'onsite',
        createdAt: 1787579785428
      })
    );
    expect(e.department).toBe('Public Affairs');
    expect(e.location).toBe('Dubai');
    expect(e.country).toBe('AE');
    expect(e.employmentType).toBe('Permanent');
    // onsite is a stated no, not a silence.
    expect(e.remote).toBe(false);
    expect(e.published).toBe('2026-08-24T13:56:25.428Z');
  });

  it('a workplace type nobody has seen is silence, not an on-site claim', () => {
    const e = ok(
      resolvePosting('https://jobs.lever.co/spotify/c152d042-642d-4a48-862b-8be8d6cdc819'),
      JSON.stringify({ text: 'X', description: 'A body long enough to be worth keeping here.', workplaceType: 'lunar' })
    );
    expect(e.remote).toBeNull();
  });
});

describe('facts: greenhouse names its own company now', () => {
  it('reads company_name off the job payload instead of spending a second request', () => {
    const e = ok(
      resolvePosting('https://boards.greenhouse.io/figma/jobs/5426468004'),
      JSON.stringify({
        title: 'Account Executive, Enterprise',
        company_name: 'Figma',
        content: '&lt;p&gt;A body long enough to be worth keeping on this posting.&lt;/p&gt;',
        location: { name: 'San Francisco, CA • New York, NY' },
        departments: [{ name: 'Sales' }],
        first_published: '2025-01-28T18:57:29-05:00',
        pay_input_ranges: null
      })
    );
    expect(e.company).toBe('Figma');
    expect(e.location).toBe('San Francisco, CA • New York, NY');
    expect(e.department).toBe('Sales');
    expect(e.published).toBe('2025-01-28T23:57:29.000Z');
  });

  it('still offers the board call, for a board that omits the field', () => {
    const resolved = resolvePosting('https://boards.greenhouse.io/figma/jobs/5426468004');
    expect(resolved!.companyApi).toBe('https://boards-api.greenhouse.io/v1/boards/figma');
  });
});
