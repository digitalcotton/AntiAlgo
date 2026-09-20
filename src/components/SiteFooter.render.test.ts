import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteFooter from './SiteFooter.astro';

describe('SiteFooter.astro: no sign-up action, and the product row follows the flags', () => {
  it('signed out, carries no Save my spot, no Index link, and no link to a dark page', async () => {
    const container = await AstroContainer.create();
    const out = await container.renderToString(SiteFooter, { locals: { viewer: null } });
    expect(out).not.toContain('Save my spot');
    expect(out).not.toContain('>The Index<');
    // The kill list and the report are dark (both flags off in both editions),
    // so the signed-out product row carries no link to either.
    expect(out).not.toContain('Kill list');
    expect(out).not.toContain('The Report');
    expect(out).toContain('>Methodology<');
    expect(out).not.toContain('soon');
    const signedIn = await container.renderToString(SiteFooter, {
      locals: { viewer: { userId: 'u1', tier: 'member', firstName: 'Ryan', emailVerified: true } }
    });
    expect(signedIn).not.toContain('Save my spot');
  });

  it('signed in, carries only the member surfaces and none of the marketing links', async () => {
    const container = await AstroContainer.create();
    const out = await container.renderToString(SiteFooter, {
      locals: { viewer: { userId: 'u1', tier: 'member', firstName: 'Ryan', emailVerified: true } }
    });
    for (const label of ['The Board', 'The Desk', 'Opportunities', 'Jobs Data', 'Profile', 'Settings']) {
      expect(out).toContain(`>${label}<`);
    }
    for (const label of ['Home', 'How it works', 'Evidence', 'Your key', 'The Index', 'Kill list', 'The Report', 'Not here', 'Methodology', 'soon']) {
      expect(out).not.toContain(label);
    }
    expect(out).toContain('aria-label="Your surfaces"');
    expect(out).not.toContain('aria-label="The story"');
  });
});
