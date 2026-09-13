/**
 * The change-email confirmation. One step of Better Auth's own two-step
 * flow, and the only one this repository writes a template for.
 *
 * WHICH STEP THIS IS. Verified by reading node_modules/better-auth/dist/api/
 * routes/update-user.mjs (the /change-email handler) and node_modules/
 * better-auth/dist/api/routes/email-verification.mjs (what a token consumes
 * into) directly, not assumed from documentation:
 *
 *   1. A signed-in reader with a verified email posts a new address. Better
 *      Auth mints a token embedding {email: OLD, updateTo: NEW,
 *      requestType: "change-email-confirmation"} and calls this app's own
 *      `user.changeEmail.sendChangeEmailConfirmation` (src/lib/auth.ts),
 *      which renders THIS template and sends it to the OLD, already-verified
 *      address. Nothing in the database has changed yet.
 *   2. Clicking this email's link hits GET /verify-email. Because the token
 *      carries requestType "change-email-confirmation", Better Auth does not
 *      update anything: it mints a SECOND token (requestType
 *      "change-email-verification") and sends a second mail, this one to the
 *      NEW address, through the ordinary sendVerificationEmail() this app
 *      already uses for sign-up (src/lib/email.ts). That second mail is not
 *      built from this template; it is the existing verification email,
 *      reused, because Better Auth's own code reuses it.
 *   3. Only clicking THAT second link actually calls updateUserByEmail() and
 *      the address changes.
 *
 * So this template's whole job is step 1: tell the OLD address a change was
 * requested, name the new address in full so a reader can catch a typo or a
 * hijack attempt before approving anything, and say plainly that ignoring it
 * changes nothing. It carries no statistic from facts.json: there is no
 * teaching strip in a security-relevant transactional email, the same
 * restraint instant-alert.mjs's own header already states for a different
 * reason.
 *
 * WHY THIS FILE IS NOT IN scripts/build-emails.mjs's EMAILS MAP. That map
 * builds two mailing-list emails from a nightly data export at a fixed
 * clock; this one is transactional, triggered by a live request at whatever
 * moment a reader asks to change their email, the same reason nightly-
 * receipt.mjs's own header gives for not being in that map either. It still
 * uses the same tokenised shell (emails/lib/) so the two families read as
 * one system rather than as a mailing-list voice and a transactional voice
 * that happen to share a sender address; src/lib/auth.ts is what actually
 * calls buildChangeEmailConfirmation() and sends the result, at request
 * time, not through this script.
 */
import { esc, style, role, rule, spacer, block, bleed, document_, sectionLabel } from '../lib/shell.mjs';

/**
 * Builds the email: subject, preview line, HTML and text.
 *
 * `oldEmail` is named in the body so a reader confirms which account this
 * is about; `newEmail` is named in full, not truncated or masked, because
 * the entire point of sending this to the OLD address is to let its owner
 * catch a new address they do not recognise. `confirmUrl` is Better Auth's
 * own token URL (see this file's own header): this template does not mint
 * it, only renders it.
 */
export function buildChangeEmailConfirmation({ t, roles, site, oldEmail, newEmail, confirmUrl }) {
  const subject = 'Confirm the email change on your account';
  const preheader = `Someone asked to change this account's email to ${newEmail}. Confirm from here, or ignore this and nothing changes.`;

  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `${esc(site.name)} <span${style({ color: t.raw('color-line-strong') })}>·</span> Account security</div>` +
    `<h1${style(role(roles.title, { 'padding-bottom': `${t.px('space-300')}px` }))}>Confirm the email change</h1>`;

  const request =
    `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `A request was made to change the email on this account.</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}>` +
    `<tr><td${style({ 'padding-bottom': `${t.px('space-100')}px` })}>` +
    `<span${style(role(roles.kicker, { color: t.raw('color-muted') }))}>This account</span></td></tr>` +
    `<tr><td${style({ 'padding-bottom': `${t.px('space-300')}px` })}>` +
    `<span${style(role(roles.mono))}>${esc(oldEmail)}</span></td></tr>` +
    `<tr><td${style({ 'padding-bottom': `${t.px('space-100')}px` })}>` +
    `<span${style(role(roles.kicker, { color: t.raw('color-muted') }))}>Requested new address</span></td></tr>` +
    `<tr><td>` +
    `<span${style(role(roles.mono))}>${esc(newEmail)}</span></td></tr>` +
    `</table>`;

  const action =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${style({ 'border-collapse': 'collapse' })}>` +
    `<tr><td${style({ 'background-color': t.raw('color-surface-inverse'), padding: `${t.px('space-300')}px ${t.px('space-500')}px` })}>` +
    `<a href="${esc(confirmUrl)}"${style(
      role(roles.kicker, { color: t.raw('color-foreground-inverse'), 'text-decoration': 'none', display: 'inline-block' })
    )}>Confirm this change</a>` +
    `</td></tr></table>` +
    spacer(t.px('space-300')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>` +
    `Confirming here sends a second link to the new address, and the change only takes effect once that ` +
    `one is opened too. Nothing changes from this email alone.</div>`;

  const ignore =
    sectionLabel(t, roles, 'If this was not you') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px` }))}>` +
    `Ignore this message. The link above expires on its own, the email on this account stays exactly as ` +
    `it is, and nothing further happens without another request like this one.</div>`;

  const footer =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted') }))}>${esc(site.name)} <span${style({ color: t.raw('color-line-strong') })}>·</span> ${esc(site.contact)}</div>`;

  const body = [
    block(t, masthead, { paddingTop: t.px('space-600'), paddingBottom: t.px('space-400') }),
    bleed(rule(t, { heavy: true })),
    block(t, request),
    bleed(rule(t)),
    block(t, action),
    bleed(rule(t)),
    block(t, ignore, { background: t.raw('color-surface') }),
    bleed(rule(t, { heavy: true })),
    block(t, footer)
  ].join('\n');

  const text = [
    `${site.name.toUpperCase()} / ACCOUNT SECURITY`,
    '='.repeat(56),
    '',
    'A request was made to change the email on this account.',
    '',
    `This account:            ${oldEmail}`,
    `Requested new address:   ${newEmail}`,
    '',
    'Confirm this change:',
    confirmUrl,
    '',
    'Confirming sends a second link to the new address, and the change only',
    'takes effect once that one is opened too. Nothing changes from this',
    'email alone.',
    '',
    '-'.repeat(56),
    '',
    'IF THIS WAS NOT YOU',
    'Ignore this message. The link above expires on its own, the email on',
    'this account stays exactly as it is, and nothing further happens',
    'without another request like this one.',
    '',
    `${site.name}`,
    `${site.contact}`
  ].join('\n');

  return {
    subject,
    preheader,
    html: document_(t, { subject, preheader, body }),
    text
  };
}
