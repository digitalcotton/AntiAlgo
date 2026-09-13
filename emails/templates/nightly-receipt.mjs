/**
 * The nightly receipt, as an email.
 *
 * RUN-FINISH section 5: "I need some assurance that the database is working
 * daily and is taking in the information it is supposed to take in." One
 * message a day, whether or not anything went wrong, because a message that
 * only arrives on failure cannot be told apart from a message system that is
 * broken.
 *
 * WHY THIS TEMPLATE IS NOT IN scripts/build-emails.mjs's EMAILS MAP.
 *
 * Every other email on this property carries exactly one clock: the sweep
 * instant, asserted by build-emails.mjs so a digest can never print a second
 * time and read as though two nights had been folded into one. This receipt's
 * entire job is to compare two instants, the sweep and the moment the receipt
 * was generated, and state the gap between them as the sweep's age. Registering
 * it in the shared EMAILS map would trip that assertion every single night by
 * design, not by defect, so scripts/nightly-receipt.mjs builds this template
 * directly and runs its own, smaller set of checks: the banned vocabulary,
 * the forbidden characters, no var(), a real text part. What it does not check
 * is the one clock rule, because this is the one surface on the property with
 * a second clock and a stated reason for carrying it.
 *
 * WHERE THE CONTENT COMES FROM.
 *
 * Nothing here is computed. scripts/nightly-receipt.mjs reads the published
 * files (stats.json, jobs.json, kills.json, conformance-run.ts,
 * DECISIONS-NEEDED.md) and a small history file under reports/receipts/, and
 * hands this template one finished `model` object. The template's only job is
 * to lay that model out the way a mail client can render it, exactly the
 * separation content.mjs keeps for the other two emails.
 *
 * WHO READS THIS.
 *
 * The operator, not a subscriber. There is no unsubscribe, no manage link, no
 * ecosystem band: those belong to a reader who asked to be on a list, and
 * nobody asked to be on this one. This template also does not import
 * src/data/nav.ts, on purpose: nav.ts is mid-edit on another file in this same
 * run (the ECOSYSTEM export it used to carry is gone), and a receipt about
 * whether the build is healthy should not depend on a file that is itself
 * being changed by five other workers tonight.
 */

import { esc, style, role, rule, spacer, block, bleed, document_, sectionLabel } from '../lib/shell.mjs';
import { factLine, factTable } from '../lib/parts.mjs';

/**
 * One line of a machine-voice list, for the sections that are just facts in a
 * row (killed by rule, gate verdicts, decision headings). Not factLine/
 * factTable, which pair a label with one value: these sections are a list of
 * peers, not a form.
 */
function listLine(t, roles, text, { muted = false } = {}) {
  return `<div${style(role(roles.mono, { color: muted ? t.raw('color-muted') : t.raw('color-foreground'), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(text)}</div>`;
}

function paragraph(t, roles, text, overrides = {}) {
  return `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-200')}px`, ...overrides }))}>${esc(text)}</div>`;
}

/**
 * The alarm block. The one place this template reaches for
 * `color-stat-loss`, which tokens.css itself documents as "the only alarm
 * colour on the site, and it is reserved for statistics, never for a row
 * mark." An operator alarm about a count is exactly that population, so this
 * is the token that already owns the claim rather than a new one invented for
 * an inbox.
 */
function alarmsBlock(t, roles, alarms) {
  if (alarms.length === 0) {
    return (
      `<div${style(role(roles.section, { 'padding-bottom': `${t.px('space-200')}px` }))}>No alarms</div>` +
      paragraph(t, roles, 'Every check this receipt can run from published files sits inside its stated threshold.', {
        color: t.raw('color-muted')
      })
    );
  }
  return (
    `<div${style(role(roles.section, { color: t.raw('color-stat-loss'), 'padding-bottom': `${t.px('space-300')}px` }))}>${alarms.length} alarm${alarms.length === 1 ? '' : 's'}</div>` +
    alarms
      .map(
        (a) =>
          `<div${style({ 'padding-bottom': `${t.px('space-300')}px` })}>` +
          `<div${style(role(roles.mono, { color: t.raw('color-stat-loss'), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(a.code)}</div>` +
          `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px` }))}>${esc(a.text)}</div>` +
          `</div>`
      )
      .join('')
  );
}

/**
 * Builds the receipt as an email: subject line, preview line, HTML and text.
 *
 * `model` is scripts/nightly-receipt.mjs's finished computation (see that
 * file's `buildReceiptModel`). `plainText` is the exact string
 * scripts/nightly-receipt.mjs also writes to reports/receipts/YYYY-MM-DD.txt
 * and prints to stdout, reused verbatim as this email's text part so the two
 * surfaces cannot state the receipt differently.
 */
export function buildNightlyReceiptEmail({ t, roles, site, model, plainText }) {
  const subject = `Receipt: sweep ${model.sweptAtUtc}, ${model.counts.postingsObserved ?? 'not exported'} observed`;
  const preheader =
    model.alarms.length === 0
      ? `No alarms. ${model.counts.boards} boards, ${model.counts.verifiedLive} verified live, ${model.counts.killed} killed.`
      : `${model.alarms.length} alarm${model.alarms.length === 1 ? '' : 's'}. ${model.counts.boards} boards, ${model.counts.verifiedLive} verified live, ${model.counts.killed} killed.`;

  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `The Index <span${style({ color: t.raw('color-line-strong') })}>·</span> Nightly receipt, operator only</div>` +
    `<h1${style(role(roles.title, { 'padding-bottom': `${t.px('space-300')}px` }))}>Nightly receipt</h1>` +
    `<div${style(role(roles.mono, { color: t.raw('color-muted') }))}>GENERATED ${esc(model.generatedAtUtc.toUpperCase())}</div>`;

  const sweepSection =
    sectionLabel(t, roles, 'Sweep') +
    spacer(t.px('space-400')) +
    factTable([
      factLine(t, roles, { label: 'Published', value: model.sweptAtUtc, present: true }),
      factLine(t, roles, { label: 'Age', value: model.ageLine, present: true })
    ]);

  const countRows = [
    factLine(t, roles, { label: 'Boards', value: String(model.counts.boards), present: true }),
    factLine(t, roles, {
      label: 'Observed',
      value: model.counts.postingsObserved === null ? 'not exported' : String(model.counts.postingsObserved),
      present: model.counts.postingsObserved !== null
    }),
    factLine(t, roles, { label: 'Pulled', value: String(model.counts.pulled), present: true }),
    factLine(t, roles, { label: 'Verified live', value: String(model.counts.verifiedLive), present: true }),
    factLine(t, roles, { label: 'Killed', value: String(model.counts.killed), present: true }),
    factLine(t, roles, { label: 'Unattributed', value: String(model.counts.killedUnattributed), present: true })
  ];

  const countsSection =
    sectionLabel(t, roles, 'Counts') +
    spacer(t.px('space-400')) +
    factTable(countRows) +
    spacer(t.px('space-300')) +
    listLine(t, roles, 'KILLED BY RULE', { muted: true }) +
    model.counts.killedByRule.map(([ruleName, count]) => listLine(t, roles, `${ruleName}: ${count}`)).join('') +
    spacer(t.px('space-200')) +
    listLine(
      t,
      roles,
      model.boardFailures.length === 0
        ? 'Boards that failed to answer: none'
        : `Boards that failed to answer (${model.boardFailures.length}): ${model.boardFailures.join(', ')}`,
      { muted: model.boardFailures.length === 0 }
    );

  const changeSection =
    sectionLabel(t, roles, 'Change against the previous receipt') +
    spacer(t.px('space-400')) +
    paragraph(t, roles, model.changeLine);

  const medianSection =
    sectionLabel(t, roles, 'Seven day trailing median') +
    spacer(t.px('space-400')) +
    paragraph(t, roles, model.medianLine);

  const buildSection =
    sectionLabel(t, roles, 'Build and gates') +
    spacer(t.px('space-400')) +
    paragraph(t, roles, model.buildLine) +
    paragraph(t, roles, model.gatesLine) +
    (model.gates.list.length > 0
      ? model.gates.list.map((g) => listLine(t, roles, `${g.id}: ${g.verdict}`, { muted: g.verdict === 'pass' })).join('')
      : '');

  const decisionsSection =
    sectionLabel(t, roles, 'Decisions needed') +
    spacer(t.px('space-400')) +
    paragraph(t, roles, model.decisionsLine) +
    model.decisions.headings.map((h) => listLine(t, roles, h, { muted: true })).join('');

  const alarmsSection = sectionLabel(t, roles, 'Alarms') + spacer(t.px('space-400')) + alarmsBlock(t, roles, model.alarms);

  const footer =
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>${esc(model.footerLine)}</div>` +
    spacer(t.px('space-300')) +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted') }))}>${esc(site.name)} <span${style({ color: t.raw('color-line-strong') })}>·</span> ${esc(site.contact)}</div>`;

  const body = [
    block(t, masthead, { paddingTop: t.px('space-600'), paddingBottom: t.px('space-500') }),
    bleed(rule(t, { heavy: true })),
    block(t, sweepSection),
    bleed(rule(t)),
    block(t, countsSection),
    bleed(rule(t)),
    block(t, changeSection),
    bleed(rule(t)),
    block(t, medianSection),
    bleed(rule(t)),
    block(t, buildSection),
    bleed(rule(t)),
    block(t, decisionsSection),
    bleed(rule(t, { heavy: true })),
    block(t, alarmsSection, { background: t.raw('color-surface') }),
    bleed(rule(t, { heavy: true })),
    block(t, footer)
  ].join('\n');

  return {
    subject,
    preheader,
    html: document_(t, { subject, preheader, body }),
    text: plainText
  };
}
