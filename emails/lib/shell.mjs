/**
 * The email shell and its parts.
 *
 * Everything here is built the way a mail client can actually render it:
 *
 *   - Tables for layout. Not nostalgia: Outlook 2016 through 2021 on Windows
 *     renders mail through Word, which has no flexbox and no grid, and that is
 *     still a large share of any professional list.
 *   - Inline styles on every element that carries one. Gmail strips <head>, and
 *     several webmail clients rewrite or drop <style> blocks. The one <style>
 *     block this file emits carries the responsive rules only, and the layout is
 *     correct without it.
 *   - No custom properties. See lib/tokens.mjs for the whole argument.
 *   - No background images, no web fonts, no scripts, no SVG. SVG is stripped by
 *     Gmail and Outlook, which is why the verification marks ship as text glyphs
 *     with their meaning written next to them.
 *
 * Two rules from the site carry over unchanged, and they are the ones worth
 * protecting: a machine assertion is set in the mono voice, and a value we do
 * not hold renders as a truthful absence in the human voice.
 */

/**
 * The message width.
 *
 * 600px is a mail client constraint, not a design value: it is what Outlook's
 * default reading pane fits without a horizontal scrollbar, and no token owns it
 * because the site has no 600px measure to point at. Flagged rather than
 * disguised as a token, because inventing `--layout-email` would claim the
 * design system had a considered opinion here when what it has is a client
 * limitation. See DECISIONS.md.
 */
export const EMAIL_WIDTH = 600;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Escapes text for HTML.
 *
 * Job titles, company names and reasons arrive from 60+ feeds with nobody
 * reading them first, so any of them can carry an ampersand or an angle bracket.
 * Single quotes are deliberately not escaped: the repo ships straight quotes
 * only and `&#39;` in an email body reads as a bug to anyone who views source.
 */
export function esc(text) {
  return String(text).replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/** An inline style attribute from an object, skipping anything unset. */
export function style(declarations) {
  const body = Object.entries(declarations)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
  return body ? ` style="${body}"` : '';
}

/**
 * The five type roles, as inline style objects.
 *
 * The same five the site sets, from the same tokens: page title, section
 * heading, body, kicker, machine voice. tokens/README.md is the table these come
 * from. Sizes step down from the site's, because 76px is a masthead measurement
 * on a 1280px canvas and this column is 600px wide; the role and its tokens are
 * unchanged, only the step taken off the ramp.
 */
export function typeRoles(t) {
  const sans = t.sansStack();
  const mono = t.monoStack();

  return {
    /** Masthead. size.500 rather than size.700: 76px does not fit a 600px column. */
    title: {
      'font-family': sans,
      'font-size': `${t.px('size-500')}px`,
      'line-height': `${Math.round(t.px('size-500') * t.number('leading-tight'))}px`,
      'font-weight': String(t.number('weight-bold')),
      'letter-spacing': t.raw('tracking-tight'),
      color: t.raw('color-foreground'),
      margin: '0'
    },
    /** Section heading. */
    section: {
      'font-family': sans,
      'font-size': `${t.px('size-400')}px`,
      'line-height': `${Math.round(t.px('size-400') * t.number('leading-snug'))}px`,
      'font-weight': String(t.number('weight-bold')),
      'letter-spacing': t.raw('tracking-tight'),
      color: t.raw('color-foreground'),
      margin: '0'
    },
    /** Body copy. */
    body: {
      'font-family': sans,
      'font-size': `${t.px('size-200')}px`,
      'line-height': `${Math.round(t.px('size-200') * t.number('leading-normal'))}px`,
      'font-weight': String(t.number('weight-regular')),
      color: t.raw('color-foreground'),
      margin: '0'
    },
    /** Kicker and small caps: nav register, section labels. */
    kicker: {
      'font-family': sans,
      'font-size': `${t.px('size-100')}px`,
      'line-height': `${Math.round(t.px('size-100') * t.number('leading-snug'))}px`,
      'font-weight': String(t.number('weight-medium')),
      'letter-spacing': t.raw('tracking-loose'),
      'text-transform': 'uppercase',
      color: t.raw('color-muted'),
      margin: '0'
    },
    /** The machine voice. Numbers, timestamps, statuses, scores, source names. */
    mono: {
      'font-family': mono,
      'font-size': `${t.px('size-100')}px`,
      'line-height': `${Math.round(t.px('size-100') * t.number('leading-normal'))}px`,
      'font-weight': String(t.number('weight-regular')),
      color: t.raw('color-foreground'),
      margin: '0'
    }
  };
}

/** One role with overrides. Keeps a template from restating a whole role to change a colour. */
export const role = (base, overrides = {}) => ({ ...base, ...overrides });

/**
 * The verification marks, as text.
 *
 * The site draws these as SVG. Gmail and Outlook strip SVG, so the email uses
 * the glyphs DESIGN-BRIEF.md standing rule 5 writes the legend with. The rule
 * that marks never stand alone does more work here than it does on the site:
 * every row prints its state as a word in the machine voice beside the glyph,
 * and the legend sits in the footer of every email that uses one, so meaning
 * never depends on whether a reader's mail client found a font with U+2295 in
 * it.
 */
export const MARKS = {
  verified: { glyph: '⊙', text: 'Verified this sweep' },
  're-verified': { glyph: '⊕', text: 'Re-verified' },
  closed: { glyph: '⊘', text: 'Closed' }
};

/**
 * A glyph stack, which is deliberately not the machine voice's stack.
 *
 * U+2295, U+2298 and U+2299 are circled operators from the mathematical
 * operators block. Text faces do not carry them, so asking for the mark in the
 * mono stack would land on whatever the client substituted, silently and
 * differently per platform. Naming the symbol faces that do carry them means the
 * substitution is a decision rather than an accident: Apple Symbols on macOS and
 * iOS, Segoe UI Symbol on Windows, Noto Sans Symbols on Android, DejaVu Sans on
 * Linux. If all four miss, the word beside the glyph still says which state it
 * is, which is why the legend rule is written the way it is.
 */
export const glyphStack = () =>
  'Apple Symbols, Segoe UI Symbol, Noto Sans Symbols 2, Noto Sans Symbols, DejaVu Sans, monospace';

export function markInline(t, state, roles) {
  const mark = MARKS[state];
  if (!mark) throw new Error(`emails: no mark state "${state}". The legend canon has three: verified, re-verified, closed.`);
  const colour = state === 'closed' ? t.raw('color-mark-closed') : t.raw('color-mark-live');
  return (
    `<span${style(role(roles.mono, { 'font-family': glyphStack(), color: colour }))}>${mark.glyph}</span>` +
    `<span${style(role(roles.mono, { color: t.raw('color-muted'), 'padding-left': `${t.px('space-200')}px` }))}>${esc(mark.text.toUpperCase())}</span>`
  );
}

/** The legend line, in the footer of every email that renders a mark. */
export function markLegend(t, roles) {
  const cells = Object.entries(MARKS)
    .map(([state, mark]) => {
      const colour = state === 'closed' ? t.raw('color-mark-closed') : t.raw('color-mark-live');
      return (
        `<span${style({ 'white-space': 'nowrap' })}>` +
        `<span${style(role(roles.mono, { 'font-family': glyphStack(), color: colour, 'font-size': `${t.px('size-075')}px` }))}>${mark.glyph}</span> ` +
        `<span${style(role(roles.mono, { color: t.raw('color-muted'), 'font-size': `${t.px('size-075')}px`, 'letter-spacing': t.raw('tracking-loose'), 'text-transform': 'uppercase' }))}>${esc(mark.text)}</span>` +
        `</span>`
      );
    })
    .join(`<span${style(role(roles.mono, { color: t.raw('color-line-strong'), 'font-size': `${t.px('size-075')}px`, padding: `0 ${t.px('space-200')}px` }))}>·</span>`);

  return `<div${style({ 'line-height': '1.9' })}>${cells}</div>`;
}

/** A full-width hairline. A bordered td, because an <hr> is styled differently by every client. */
export function rule(t, { heavy = false } = {}) {
  const width = heavy ? t.px('border-heavy') : t.px('border-hairline');
  const colour = heavy ? t.raw('color-line-strong') : t.raw('color-line');
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%', 'border-collapse': 'collapse' })}>` +
    `<tr><td${style({ 'font-size': '0', 'line-height': '0', height: `${width}px`, 'background-color': colour })}>&nbsp;</td></tr>` +
    `</table>`
  );
}

/** Vertical space. A td with a height, which is the only spacer every client honours. */
export function spacer(px) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr><td${style({ height: `${px}px`, 'font-size': '0', 'line-height': '0' })}>&nbsp;</td></tr>` +
    `</table>`
  );
}

/**
 * The one action.
 *
 * A table cell with a background colour rather than a styled anchor, because
 * Outlook will not paint padding or a background on an inline element. Emphasis
 * by inversion, which is the site's only emphasis: ink fill, paper text. The
 * label names its destination, per standing rule 4, and the label is passed in
 * rather than written here so the wording stays `applyLabel()`'s job.
 */
export function actionButton(t, roles, { href, label }) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${style({ 'border-collapse': 'collapse' })}>` +
    `<tr><td${style({ 'background-color': t.raw('color-surface-inverse'), padding: `${t.px('space-300')}px ${t.px('space-500')}px` })}>` +
    `<a href="${esc(href)}"${style(
      role(roles.kicker, { color: t.raw('color-foreground-inverse'), 'text-decoration': 'none', display: 'inline-block' })
    )}>${esc(label)}</a>` +
    `</td></tr></table>`
  );
}

/** A section label: the kicker register, with a rule under it. */
export function sectionLabel(t, roles, text) {
  return (
    `<div${style(role(roles.kicker, { color: t.raw('color-foreground'), 'padding-bottom': `${t.px('space-200')}px` }))}>${esc(text)}</div>` +
    rule(t, { heavy: true })
  );
}

/**
 * The document.
 *
 * The <style> block carries three things and the email is correct without all
 * three: a width override for phone widths, the two colour-scheme declarations
 * that stop Apple Mail and Outlook.com auto-inverting a light-only design, and
 * the link colour reset that keeps iOS from painting dates and addresses blue.
 * Everything structural is inline.
 */
export function document_(t, { subject, preheader, body }) {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
  /* Light only, deliberately. The site ships both themes; an email does not,
     because a mail client's dark mode rewrites colours it was never given the
     token map for, and the result is a machine voice that no longer reads as
     one. Declaring the scheme is how a client is told not to try. */
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin: 0; padding: 0; width: 100% !important; }
  table { border-collapse: collapse; }
  img { border: 0; outline: none; }
  /* iOS turns dates, addresses and numbers into blue links. This keeps the
     machine voice the colour it was assigned. */
  a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
  @media only screen and (max-width: 620px) {
    .shell { width: 100% !important; }
    .pad { padding-left: ${t.px('space-400')}px !important; padding-right: ${t.px('space-400')}px !important; }
  }
  /* There is no column-stacking rule here on purpose. The usual email trick is a
     .stack class that flips a td to display:block at phone width, and it was
     written, shipped, and then measured: the two column heads hold perfectly
     well at 476px, Outlook's Word engine ignores display on a td so it does
     nothing there anyway, and the browser's own handling of a block td inside a
     table produced a layout that did not match what the class name promised. A
     rule whose name says one thing and whose effect is another is worse than no
     rule, so both columns are narrow enough to hold instead. */
</style>
</head>
<body${style({ margin: '0', padding: '0', 'background-color': t.raw('color-surface'), color: t.raw('color-foreground') })}>
<!-- The preview line: what an inbox shows beside the subject. Hidden in the
     body, and followed by enough zero-width space that the client does not
     scrape the masthead into the preview after it. -->
<div${style({
    display: 'none',
    'font-size': '1px',
    'line-height': '1px',
    'max-height': '0',
    'max-width': '0',
    opacity: '0',
    overflow: 'hidden'
  })}>${esc(preheader)}${'&#8203;&nbsp;'.repeat(30)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({
    width: '100%',
    'background-color': t.raw('color-surface')
  })}>
<tr><td align="center"${style({ padding: `${t.px('space-600')}px ${t.px('space-300')}px` })}>
<table role="presentation" class="shell" cellpadding="0" cellspacing="0" border="0" width="${EMAIL_WIDTH}"${style({
    width: `${EMAIL_WIDTH}px`,
    'max-width': `${EMAIL_WIDTH}px`,
    'background-color': t.raw('color-surface-raised')
  })}>
${body}
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/** One padded row of the shell table. Every block of an email is one of these. */
export function block(t, contents, { background, paddingTop, paddingBottom } = {}) {
  return (
    `<tr><td class="pad"${style({
      padding: `${paddingTop ?? t.px('space-500')}px ${t.px('space-600')}px ${paddingBottom ?? t.px('space-500')}px`,
      'background-color': background
    })}>${contents}</td></tr>`
  );
}

/** An edge-to-edge row, for rules that should meet the shell's sides. */
export function bleed(contents) {
  return `<tr><td${style({ padding: '0' })}>${contents}</td></tr>`;
}
