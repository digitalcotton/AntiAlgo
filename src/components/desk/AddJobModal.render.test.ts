import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import AddJobModal from './AddJobModal.astro';

async function render(): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(AddJobModal, { props: { action: '/jobs/desk/posting', view: 'board' } });
}

describe('AddJobModal.astro: Add a job, the one control, a native <dialog>', () => {
  it('is a dialog opened by its own trigger, with one https URL field and intent=add', async () => {
    const html = await render();
    expect(html).toContain('data-add-open');
    expect(html).toContain('>Add a job<');
    expect(html).toContain('<dialog');
    expect(html).toContain('id="add-job"');
    expect(html).toContain('>Posting link<');
    expect(html).toContain('name="intent" value="add"');
    expect(html).toContain('name="url"');
    expect(html).toContain('pattern="https://.*"');
    expect(html).toContain('action="/jobs/desk/posting"');
    expect(html).toContain('>Read this posting<');
    expect(html).not.toContain('Track an application');
  });
  it('says what the machine does, that the reason comes next, and what happens when the page cannot be read', async () => {
    const html = (await render()).replace(/\s+/g, ' ');
    expect(html).toContain('fills in the role and the company');
    expect(html).toContain('Then you add why this company');
    expect(html).toContain('you can paste the text instead');
  });
  it('carries no dashes', async () => {
    const html = await render();
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
