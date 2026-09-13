/**
 * confirm-nudge.mjs: the confirm-loop nudge email (F4.1's third channel, the
 * scheduled one). A person clicked apply on one or more roles and never came
 * back to say what happened; this is the single, gentle reminder to resolve them
 * on the Desk. It is NOT a marketing email: every line is about the person's own
 * pending applications, the ones desk_application is still waiting on
 * (confirmed_at IS NULL), and it is sent once per card (db/029's
 * confirm_nudged_at), never on a schedule that repeats on the same card.
 *
 * Same tokenised shell as the transactional emails (emails/lib/), so it reads as
 * one family with the verification and change-email messages, and it is rendered
 * and sent through the same seam (src/lib/email.ts's sendMail), never a second
 * copy of a provider call.
 *
 * The caller passes the already-resolved list; this template mints no URL and
 * reads no database. `pending` is a small array of { title, company, days },
 * already capped by the sender, and `deskUrl` is the absolute link to the Desk.
 */
import { esc, style, role, rule, spacer, block, bleed, document_, sectionLabel } from '../lib/shell.mjs';

/** One human phrase for how long a card has waited. Days in, a short label out;
    no clock read, so it renders identically wherever it runs. */
function waited(days) {
  if (days <= 1) return 'yesterday';
  return `${days} days ago`;
}

export function buildConfirmNudge({ t, roles, site, pending, deskUrl }) {
  const count = pending.length;
  const subject =
    count === 1 ? 'One application to confirm on your Desk' : `${count} applications to confirm on your Desk`;
  const preheader =
    count === 1
      ? 'You clicked apply and never said what happened. Two taps on your Desk closes the loop, or ignore this.'
      : 'You clicked apply on a few roles and never said what happened. Close the loop on your Desk, or ignore this.';

  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `${esc(site.name)} <span${style({ color: t.raw('color-line-strong') })}>·</span> Your Desk</div>` +
    `<h1${style(role(roles.title, { 'padding-bottom': `${t.px('space-300')}px` }))}>Did you finish applying?</h1>`;

  const intro =
    `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    (count === 1
      ? 'You clicked apply on this role and never told your Desk how it went. A quick answer keeps your tracker honest.'
      : 'You clicked apply on these roles and never told your Desk how they went. A quick answer on each keeps your tracker honest.') +
    '</div>';

  const rowsHtml = pending
    .map((item) => {
      const title = item.title ? esc(item.title) : 'A role';
      const company = item.company ? esc(item.company) : 'a company';
      return (
        `<tr><td${style({ 'padding-bottom': `${t.px('space-100')}px` })}>` +
        `<span${style(role(roles.body))}>${title}</span></td></tr>` +
        `<tr><td${style({ 'padding-bottom': `${t.px('space-300')}px` })}>` +
        `<span${style(role(roles.kicker, { color: t.raw('color-muted') }))}>${company} <span${style({ color: t.raw('color-line-strong') })}>·</span> clicked ${esc(waited(item.days))}</span></td></tr>`
      );
    })
    .join('');
  const list =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}>` +
    rowsHtml +
    `</table>`;

  const action =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${style({ 'border-collapse': 'collapse' })}>` +
    `<tr><td${style({ 'background-color': t.raw('color-surface-inverse'), padding: `${t.px('space-300')}px ${t.px('space-500')}px` })}>` +
    `<a href="${esc(deskUrl)}"${style(
      role(roles.kicker, { color: t.raw('color-foreground-inverse'), 'text-decoration': 'none', display: 'inline-block' })
    )}>Open your Desk</a>` +
    `</td></tr></table>` +
    spacer(t.px('space-300')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>` +
    `A click is not an application, and your Desk keeps the two apart. Telling it what happened is the only ` +
    `way the second column becomes true.</div>`;

  const ignore =
    sectionLabel(t, roles, 'Not applying to these') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px` }))}>` +
    `Ignore this message. Nothing changes on your Desk, the cards stay exactly as they are, and this is the ` +
    `only nudge each one gets.</div>`;

  const footer =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted') }))}>${esc(site.name)} <span${style({ color: t.raw('color-line-strong') })}>·</span> ${esc(site.contact)}</div>`;

  const body = [
    block(t, masthead, { paddingTop: t.px('space-600'), paddingBottom: t.px('space-400') }),
    bleed(rule(t, { heavy: true })),
    block(t, intro + list),
    bleed(rule(t)),
    block(t, action),
    bleed(rule(t)),
    block(t, ignore, { background: t.raw('color-surface') }),
    bleed(rule(t, { heavy: true })),
    block(t, footer)
  ].join('\n');

  const textLines = [
    `${site.name.toUpperCase()} / YOUR DESK`,
    '='.repeat(56),
    '',
    count === 1
      ? 'You clicked apply on this role and never told your Desk how it went:'
      : 'You clicked apply on these roles and never told your Desk how they went:',
    ''
  ];
  for (const item of pending) {
    textLines.push(`- ${item.title || 'A role'} (${item.company || 'a company'}), clicked ${waited(item.days)}`);
  }
  textLines.push(
    '',
    'Open your Desk to confirm:',
    deskUrl,
    '',
    'A click is not an application, and your Desk keeps the two apart. Telling',
    'it what happened is the only way the second column becomes true.',
    '',
    '-'.repeat(56),
    '',
    'NOT APPLYING TO THESE',
    'Ignore this message. Nothing changes on your Desk, and this is the only',
    'nudge each card gets.',
    '',
    `${site.name}`,
    `${site.contact}`
  );

  return {
    subject,
    preheader,
    html: document_(t, { subject, preheader, body }),
    text: textLines.join('\n')
  };
}
