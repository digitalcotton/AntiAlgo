import { describe, expect, it } from 'vitest';
import { coreOf, type ProfileEntry } from './record';
import type { Job } from './data';
import { renderResume, type ProfileRecord, type Target } from './tailor';

/**
 * Phase 2 (RUN-DRAFT.md section 3) selection behaviour on the tailor: relevance
 * ordering against a real posting, one paired mention of a skill the posting
 * names for a skill the record holds, and the two-page word cap that trims the
 * least relevant entries to core-only. These are the "ordering and alias
 * mirroring proven by test against a fixture posting" the phase's done-when asks
 * for, plus the length proxy the phase body specifies.
 */

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    prfId: 'PRF-0001',
    kind: 'role_held',
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Staff Designer',
    start: { year: 2020, month: 3 },
    end: null,
    location: 'Remote',
    description: 'Led the checkout redesign.',
    classification: 'private',
    provenance: 'you_told_us',
    artifacts: [],
    ...overrides
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01T00:00:00Z',
    last_verified: '2026-08-20T00:00:00Z',
    published_date: '2026-08-01',
    age_days: 19,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: '<p>We need someone who can redesign checkout.</p>',
    ...overrides
  };
}

const postingTarget = (overrides: Partial<Job> = {}): Target => ({ kind: 'verified_posting', job: job(overrides) });

function bulletTextFor(render: Awaited<ReturnType<typeof renderResume>>, prfId: string): string {
  const found = render.sections.flatMap((s) => s.entries).find((e) => e.prfId === prfId);
  return (found?.bullets ?? []).map((b) => b.text).join(' ');
}

function sectionFor(render: Awaited<ReturnType<typeof renderResume>>, kind: ProfileEntry['kind']) {
  return render.sections.find((s) => s.kind === kind);
}

describe('alias mirroring: one paired mention of a skill the record holds', () => {
  it('appends the posting\'s term in parentheses when the record holds the skill', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', kind: 'skill', employerOrInstitution: null, officialTitle: 'Kubernetes', description: 'Four years running production clusters.' })
    ];
    const target = postingTarget({ description_html: '<p>You will operate our K8s fleet.</p>' });
    const render = await renderResume(record, target);
    const text = bulletTextFor(render, 'PRF-0001');
    expect(text).toContain('Kubernetes (K8s)');
    // The record's own token is byte-identical in the core, never re-cased or
    // replaced by the posting's form.
    const rendered = sectionFor(render, 'skill')?.entries[0];
    expect(rendered?.core.officialTitle).toBe('Kubernetes');
  });

  it('adds no pairing when the posting uses the record\'s own form', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', kind: 'skill', employerOrInstitution: null, officialTitle: 'Kubernetes', description: 'Four years.' })
    ];
    const target = postingTarget({ description_html: '<p>Kubernetes is central here.</p>' });
    const text = bulletTextFor(await renderResume(record, target), 'PRF-0001');
    expect(text).toContain('Kubernetes');
    expect(text).not.toContain('(');
  });

  it('never invents a skill: a posting term the record does not hold stays off the page', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', kind: 'skill', employerOrInstitution: null, officialTitle: 'Python', description: 'Five years, data pipelines.' })
    ];
    const target = postingTarget({ description_html: '<p>Heavy K8s and Kubernetes experience required.</p>' });
    const rendered = JSON.stringify(await renderResume(record, target));
    expect(rendered).not.toContain('K8s');
    expect(rendered).not.toContain('Kubernetes');
    expect(rendered).toContain('Python');
  });
});

describe('ordering: a resume section is reverse-chronological, most recent first', () => {
  it('orders the more recent role before the older one, regardless of relevance or record order', async () => {
    const record: ProfileRecord = [
      entry({
        prfId: 'PRF-0001',
        officialTitle: 'Product Designer',
        employerOrInstitution: 'Fathom',
        start: { year: 2016, month: 1 },
        end: { year: 2019, month: 6 },
        description: 'Led the checkout redesign and rebuilt the design system.'
      }),
      entry({
        prfId: 'PRF-0002',
        officialTitle: 'Barista',
        employerOrInstitution: 'Cafe',
        start: { year: 2022, month: 3 },
        end: null,
        description: 'Poured coffee and balanced the till.'
      })
    ];
    const target = postingTarget({
      description_html: '<p>Own the checkout redesign and the design system for our product.</p>'
    });
    const render = await renderResume(record, target);
    const experience = sectionFor(render, 'role_held');
    // The ongoing 2022 role leads, even though the older 2016 role is the one
    // that answers the posting. Relevance still decides what gets bullets (the
    // two-page cap); date decides the order.
    expect(experience?.entries[0].prfId).toBe('PRF-0002');
    expect(experience?.entries[1].prfId).toBe('PRF-0001');
  });
});

describe('the two-page cap trims the least relevant entries to core-only', () => {
  it('keeps bullets on the most relevant entries and drops them past the word budget', async () => {
    // Twenty roles, each with a long description, far past a two-page budget.
    // Every role shares the posting's vocabulary equally, so relevance is a tie
    // and the prfId order decides which survive: the cap must keep the earliest
    // and trim the rest to core-only, never drop an entry entirely.
    const filler = 'Shipped the redesign and improved the product across many teams and quarters here. '.repeat(6).trim();
    const record: ProfileRecord = Array.from({ length: 20 }, (_, i) =>
      entry({
        prfId: `PRF-${String(i + 1).padStart(4, '0')}`,
        officialTitle: `Designer ${i + 1}`,
        employerOrInstitution: `Company ${i + 1}`,
        description: filler
      })
    );
    const target = postingTarget({
      description_html: '<p>Shipped the redesign and improved the product across teams and quarters.</p>'
    });
    const render = await renderResume(record, target);
    const experience = sectionFor(render, 'role_held');
    const withBullets = (experience?.entries ?? []).filter((e) => e.bullets.length > 0);
    const coreOnly = (experience?.entries ?? []).filter((e) => e.bullets.length === 0);

    // Every entry still renders (its core is intact); some keep bullets, some do
    // not.
    expect(experience?.entries.length).toBe(20);
    expect(withBullets.length).toBeGreaterThan(0);
    expect(coreOnly.length).toBeGreaterThan(0);

    // Every core-only entry still carries its real title and employer.
    for (const rendered of coreOnly) {
      const source = record.find((e) => e.prfId === rendered.prfId)!;
      expect(rendered.core).toEqual(coreOf(source));
    }

    // The kept prose stays within the two-page proxy (about 900 words).
    const bulletWords = withBullets
      .flatMap((e) => e.bullets)
      .reduce((sum, b) => sum + b.text.trim().split(/\s+/).length, 0);
    expect(bulletWords).toBeLessThanOrEqual(900);
  });
});
