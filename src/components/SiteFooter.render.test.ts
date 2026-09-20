import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteFooter from './SiteFooter.astro';

describe('SiteFooter.astro: the sign-up action is for signed-out readers only', () => {
  it('shows Save my spot signed out and drops it signed in', async () => {
    const container = await AstroContainer.create();
    const out = await container.renderToString(SiteFooter, { locals: { viewer: null } });
    expect(out).toContain('Save my spot');
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
