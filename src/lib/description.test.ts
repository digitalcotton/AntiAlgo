import { describe, expect, it } from 'vitest';
import { sanitizeCrawledHtml, renderableDescription, safeDescription } from './description';

/**
 * description.ts is the seam where the site stops trusting the crawler. These
 * tests pin the XSS cut this repo now owns: crawled markup that reaches set:html
 * carries no script, no event handler, and no dangerous URL, while the text and
 * the formatting an employer actually wrote survive.
 */

describe('sanitizeCrawledHtml: the XSS cut', () => {
  it('drops a script element and its code, leaving no stray text', () => {
    const out = sanitizeCrawledHtml('<p>Real duties.</p><script>alert(document.cookie)</script>');
    expect(out).toContain('Real duties.');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(');
  });

  it('strips an inline event handler but keeps the element and text', () => {
    const out = sanitizeCrawledHtml('<img src="https://x/y.png" onerror="fetch(\'/settings/delete\',{method:\'POST\'})">after');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain('fetch(');
    expect(out).toContain('after');
  });

  it('removes a javascript: href, keeping the link text', () => {
    const out = sanitizeCrawledHtml('<a href="javascript:alert(1)">Apply</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('Apply');
  });

  it('removes an svg-wrapped script and a data: URL', () => {
    const out = sanitizeCrawledHtml('<svg><script>alert(1)</script></svg><a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/data:text\/html/i);
  });

  it('strips style, link, base, and meta', () => {
    const out = sanitizeCrawledHtml('<base href="//evil"><link rel="stylesheet" href="//evil"><style>*{}</style><meta http-equiv="refresh">keep');
    expect(out).not.toMatch(/<(base|link|style|meta)\b/i);
    expect(out).toContain('keep');
  });

  it('keeps the formatting tags employers use', () => {
    const html = '<h2>Role</h2><p>We want <strong>senior</strong> people.</p><ul><li>Ship things</li></ul><a href="https://co/apply">Apply</a>';
    const out = sanitizeCrawledHtml(html);
    for (const tag of ['<h2>', '<p>', '<strong>', '<ul>', '<li>', 'href="https://co/apply"']) {
      expect(out).toContain(tag);
    }
  });
});

describe('the rendered consumers apply the cut', () => {
  const hostile = '<p>Own the redesign.</p><img src=x onerror=alert(1)><script>steal()</script>';

  it('renderableDescription (the page) is inert', () => {
    const out = renderableDescription(hostile, 3).html ?? '';
    expect(out).not.toMatch(/onerror|<script|steal\(/i);
    expect(out).toContain('Own the redesign.');
  });

  it('safeDescription (JSON-LD and markdown twin) is inert', () => {
    const out = safeDescription(hostile) ?? '';
    expect(out).not.toMatch(/onerror|<script|steal\(/i);
    expect(out).toContain('Own the redesign.');
  });

  it('a null description stays null', () => {
    expect(safeDescription(null)).toBeNull();
    expect(renderableDescription(null).html).toBeNull();
  });
});
