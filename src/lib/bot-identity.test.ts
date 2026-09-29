/**
 * bot-identity.test.ts: the crawler page tells the truth about the crawler.
 *
 * /bot exists because both of our fetchers advertise a URL in their User-Agent
 * and, until 2026-09-29, that URL pointed at /colophon — a page about this
 * site's build, which said nothing about a crawler. A server operator who
 * followed the link we gave them learned nothing. The fix was to write a page
 * that answers their question; the risk the fix creates is that the page and
 * the code drift, and a signpost that used to be true is worse than no
 * signpost, because someone acts on it.
 *
 * So this asserts the one thing that cannot be checked by reading either file
 * alone: the User-Agent that actually goes out on the wire is the string the
 * page shows an operator. It captures the header from a real `readPostingNow`
 * call rather than importing a constant, because the constant is not what a
 * server sees — the header is.
 *
 * THE HONEST LIMIT. The nightly sweep's token (`AntiAlgoBot`) lives in
 * `config.py` on the Mac mini and is not importable from this repo, so the
 * checks below can only confirm that the page documents that name and the
 * robots lines that refuse it. Keeping the mini's string equal to the page is
 * enforced by the comment above `USER_AGENT` in config.py and by nothing else.
 * If the two ever disagree, this file will not catch it — the page's own
 * "keep it true" note is the standing instruction.
 */
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import BotPage from '../pages/bot.astro';
import { readPostingNow } from './posting-read';

/** The User-Agent this site actually sends, taken off a real request. */
async function sentUserAgent(): Promise<string> {
  let seen: string | null = null;
  const impl = async (_url: string, init: RequestInit): Promise<Response> => {
    seen = new Headers(init.headers).get('user-agent');
    return new Response('<html><body><p>nothing</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
  };
  await readPostingNow('https://example.com/a-posting', {
    fetchImpl: impl,
    resolver: async () => ['93.184.216.34']
  });
  if (!seen) throw new Error('no User-Agent was sent at all');
  return seen;
}

async function botPageHtml(): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(BotPage, {});
}

describe('/bot documents the crawler that actually runs', () => {
  it('shows the exact User-Agent this site puts on the wire', async () => {
    const ua = await sentUserAgent();
    const html = await botPageHtml();
    // The whole point: an operator reads this page, then greps their log for
    // what it told them. Those two strings have to be the same string.
    expect(html).toContain(ua);
  });

  it('sends a token a robots.txt can refuse, and a contact that reaches a person', async () => {
    const ua = await sentUserAgent();
    // A product token first, so `User-agent: AntiAlgoReader` in a robots file
    // matches us. A UA that cannot be named cannot be refused.
    expect(ua).toMatch(/^AntiAlgoReader\/\d/);
    expect(ua).toContain('https://antialgo.ai/bot');
    expect(ua).toContain('@');
  });

  it('names the nightly sweep separately, because it is a separate act', async () => {
    const html = await botPageHtml();
    // Two names so a site can refuse the scheduled crawl and still allow the
    // single page a signed-in person asked for. Both must be on the page or
    // the operator cannot act on either.
    expect(html).toContain('AntiAlgoBot');
    expect(html).toContain('AntiAlgoReader');
  });

  it('prints the robots.txt lines that stop each one', async () => {
    const html = await botPageHtml();
    expect(html).toContain('User-agent: AntiAlgoBot');
    expect(html).toContain('User-agent: AntiAlgoReader');
    expect(html).toContain('Disallow: /');
  });

  it('never describes itself as a personal job search again', async () => {
    // The string this page was written to retire. It was true when it was
    // written and stopped being true when this became a product with members,
    // and the difference is what several platforms' terms turn on.
    const html = await botPageHtml();
    const ua = await sentUserAgent();
    expect(html.toLowerCase()).not.toContain('personal job search');
    expect(ua.toLowerCase()).not.toContain('personal job search');
  });
});
