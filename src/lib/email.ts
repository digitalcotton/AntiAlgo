/**
 * email.ts: sending verification and password reset mail.
 *
 * WHY THIS IS A THIN SEAM AND NOT A DIRECT RESEND CALL. The provider is the one
 * genuinely swappable piece of this system, and the decision between Resend,
 * Postmark, SES and an existing mailbox was still open while the rest was being
 * built. Everything above this file talks to sendVerificationEmail and
 * sendPasswordResetEmail. Changing provider is changing send() and nothing else.
 *
 * IT USES fetch AND NOT AN SDK on purpose. The Resend REST API is one POST with
 * a bearer token. An SDK here would add a dependency, a version to track and a
 * bundle to ship, to save writing eight lines.
 *
 * WHAT THE COPY DOES NOT SAY. Neither template states whether an address has an
 * account. The reset flow in particular is triggered by anyone typing any
 * address, so the mail itself has to be safe to receive when you did not ask
 * for it.
 */

const FROM = process.env.EMAIL_FROM || 'help@tokenstoagents.ai';
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'hello@tokenstoagents.ai';

interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The same message as markup, so the link survives the trip. See below. */
  html: string;
}

/**
 * A link that survives a mail client, and why plain text alone did not.
 *
 * THIS SHIPPED BROKEN AND THE SYMPTOM WAS BAFFLING. Verification mail went out
 * as text only, with Better Auth's URL on its own line. That URL carries a
 * token and a callbackURL and runs well past the 78 characters plain text wraps
 * at, so the client linkified only as far as the break. Clicking it reached the
 * right endpoint with the token missing entirely, and the reader saw
 * "[query.token] Invalid input: expected string, received undefined", which
 * reads like the token was wrong rather than absent.
 *
 * An anchor cannot be wrapped: the href is an attribute, not flowed text. The
 * plain text part stays for clients that refuse HTML, with the URL kept on one
 * line and nothing after it on that line to encourage a break.
 */
function linkHtml(intro: string, url: string, note: string): string {
  return [
    `<p>${intro}</p>`,
    `<p><a href="${url}">${url}</a></p>`,
    `<p>${note}</p>`,
    '<p>Tokens to Agents<br>tokenstoagents.ai</p>'
  ].join('');
}

/**
 * The provider call. The only function that knows which service is in use.
 *
 * A send that fails throws, and the caller lets it. Better Auth surfaces the
 * failure at signup rather than creating an account whose verification mail
 * silently never went, which would strand the user with an account they cannot
 * verify and no way to tell why.
 */
/*
 * EXPORTED, BECAUSE THE SECOND SENDER ALREADY DUPLICATED IT ONCE. The
 * change-email confirmation (src/lib/auth.ts) needed to send a message this
 * file had no builder for, could not reach this function because it was
 * module-private, and so copied the provider call: the same key lookup, the
 * same endpoint, the same from and reply-to, the same error handling, fifteen
 * lines out of step with this one the moment either changed. The header above
 * calls this the only function that knows which service is in use, and that
 * sentence was quietly false while a second copy existed. Exporting it makes
 * the sentence true again. A caller that has already built its own subject,
 * text and html passes them here; a caller that wants this file's standard
 * link layout uses the two builders below.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      'RESEND_API_KEY is not set, so no mail can be sent. Set it in Vercel ' +
        'environment variables.'
    );
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `Tokens to Agents <${FROM}>`,
      reply_to: REPLY_TO,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    })
  });

  if (!response.ok) {
    // The body carries the provider's reason. The recipient address is not
    // logged: an error log is not a place to accumulate people's email.
    const detail = await response.text().catch(() => '');
    throw new Error(`Email send failed: HTTP ${response.status}. ${detail.slice(0, 300)}`);
  }
}

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  await sendMail({
    to,
    subject: 'Confirm your email',
    html: linkHtml(
      'Confirm your email to finish setting up your account.',
      url,
      'The link works once and expires in an hour. If you did not sign up, ignore this and nothing happens.'
    ),
    text: [
      'Confirm your email to finish setting up your account.',
      '',
      url,
      '',
      'The link works once and expires in an hour.',
      'If you did not sign up, ignore this and nothing happens.',
      '',
      'Tokens to Agents',
      'tokenstoagents.ai'
    ].join('\n')
  });
}

export async function sendPasswordResetEmail(to: string, url: string): Promise<void> {
  await sendMail({
    to,
    subject: 'Reset your password',
    html: linkHtml(
      'Someone asked to reset the password for this address.',
      url,
      'The link works once and expires in an hour. If it was not you, ignore this. Your password does not change.'
    ),
    text: [
      'Someone asked to reset the password for this address.',
      '',
      url,
      '',
      'The link works once and expires in an hour.',
      'If it was not you, ignore this. Your password does not change.',
      '',
      'Tokens to Agents',
      'tokenstoagents.ai'
    ].join('\n')
  });
}
