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
