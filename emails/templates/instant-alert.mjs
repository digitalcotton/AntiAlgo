/**
 * The instant alert.
 *
 * One role, why it matched, one action. That is the whole brief and the
 * discipline is in what is left out: no second role, no "you might also like",
 * no digest of the day so far. An alert that arrives with a list is a digest
 * wearing an alert's subject line.
 *
 * "Why it matched" is answered twice, because there are two honest answers and
 * they are different questions:
 *
 *   1. Why you got it. The filter state the alert was created with, stored by
 *      the capture module and substituted at send time. This is the reader's own
 *      instruction quoted back, which is standing rule 4: a label describes
 *      reality.
 *   2. Why it scored. The rubric, component by component, with the arithmetic
 *      printed. No prose is written about any component: the fixture carries no
 *      per-component reasoning field and inventing one would be this repository
 *      making up the machine's reasoning on the panel whose whole job is showing
 *      the machine's reasoning.
 *
 * This email carries no statistic from facts.json. There is no room for a
 * teaching strip in an alert and a fact would be decoration here, which is worse
 * than absent.
 */

import { esc, style, role, rule, spacer, block, bleed, document_, sectionLabel, markInline, actionButton } from '../lib/shell.mjs';
import { fitBars, factLine, factTable, footer, absolute } from '../lib/parts.mjs';
import { digestWindow, alertRole, jobFacts, filterStateOf } from '../lib/content.mjs';

export function buildInstantAlert({ t, roles, data, site, nav, merge }) {
  const window = digestWindow(data);
  const job = alertRole(data, window);
  if (!job) {
    throw new Error('emails: no role in the digest window to populate the instant alert template with.');
  }

  const facts = jobFacts(data, job);
  const breakdown = data.fitComponents(job);
  const stamp = data.sweptStamp();
  const filterState = filterStateOf(data, job);
  const jobUrl = absolute(site, `/role/${job.slug}`);

  const subject = `${job.company}: ${job.title}`;
  const preheader = `Fit ${breakdown.total}. Verified at source ${stamp}. ${data.easeSummary(job)}.`;

  // -------------------------------------------------------------------------
  // Masthead, kept small. The role is the headline here, not the publication.
  // -------------------------------------------------------------------------
  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted') }))}>` +
    `The Index <span${style({ color: t.raw('color-line-strong') })}>·</span> Instant alert</div>`;

  // -------------------------------------------------------------------------
  // The role
  // -------------------------------------------------------------------------
  const head =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}><tr>` +
    `<td valign="top">` +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-200')}px` }))}>${esc(job.company)}</div>` +
    `<h1${style(role(roles.section, { 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `<a href="${esc(jobUrl)}"${style({ color: t.raw('color-foreground'), 'text-decoration': 'none' })}>${esc(job.title)}</a></h1>` +
    `<div>${markInline(t, data.markStateOf(job), roles)}</div>` +
    `</td>` +
    `<td valign="top" align="right"${style({ width: '90px' })}>` +
    `<div${style(
      role(roles.mono, {
        'font-size': `${t.px('size-500')}px`,
        'font-weight': String(t.number('weight-bold')),
        'line-height': '1',
        'font-feature-settings': t.raw('feature-tabular')
      })
    )}>${breakdown.total}</div>` +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'font-size': `${t.px('size-050')}px` }))}>Fit of 100</div>` +
    `</td></tr></table>`;

  const detail = factTable([
    factLine(t, roles, { label: 'Comp', value: facts.comp, present: facts.compPresent }),
    factLine(t, roles, { label: 'Location', value: job.location, present: true }),
    factLine(t, roles, { label: 'Age', value: facts.age, present: facts.agePresent }),
    factLine(t, roles, { label: 'Applying', value: data.easeSummary(job), present: true })
  ]);

  // -------------------------------------------------------------------------
  // Why it matched
  // -------------------------------------------------------------------------
  const why =
    sectionLabel(t, roles, 'Why it matched') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-200')}px` }))}>` +
    `You asked to hear about roles matching this filter.</div>` +
    `<div${style(role(roles.mono, { 'padding-bottom': `${t.px('space-500')}px` }))}>${esc(filterState)}</div>` +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `This is how it scored against rubric v1.</div>` +
    fitBars(t, roles, breakdown) +
    (breakdown.hasOutOfRange
      ? `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-top': `${t.px('space-300')}px` }))}>` +
        `One component sits above the weight the rubric gives it. The total is the sum of the components either way, and we have flagged the split to fix at source.</div>`
      : '');

  // -------------------------------------------------------------------------
  // The one action, then the receipts behind it
  // -------------------------------------------------------------------------
  const action =
    actionButton(t, roles, { href: job.apply_url, label: data.applyLabel(job) }) +
    spacer(t.px('space-300')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>` +
    `Goes to ${esc(job.ease.destination)}.</div>`;

  // The provenance line: our own record of this posting, in the machine voice.
  // First observed is printed here and not as a column anywhere, which is the
  // distinction the site draws: one row explaining its own figure is not the
  // suppressed First seen column.
  const provenance =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-200')}px` }))}>Provenance</div>` +
    `<div${style(role(roles.mono, { 'font-size': `${t.px('size-075')}px`, color: t.raw('color-muted'), 'line-height': '1.9' }))}>` +
    `FIRST OBSERVED ${esc(String(data.formatDate(job.first_observed) ?? data.ABSENCE.date).toUpperCase())}<br>` +
    `LAST VERIFIED ${esc(stamp.toUpperCase())}<br>` +
    `READ DIRECT FROM ${esc(data.sourceLabel(job).toUpperCase())}</div>` +
    spacer(t.px('space-300')) +
    `<a href="${esc(jobUrl)}"${style(role(roles.kicker, { color: t.raw('color-foreground'), 'text-decoration': 'underline' }))}>See the full record</a>`;

  const body = [
    block(t, masthead, { paddingTop: t.px('space-500'), paddingBottom: t.px('space-400') }),
    bleed(rule(t, { heavy: true })),
    block(t, head + spacer(t.px('space-400')) + detail),
    bleed(rule(t)),
    block(t, why, { background: t.raw('color-surface') }),
    bleed(rule(t)),
    block(t, action),
    bleed(rule(t)),
    block(t, provenance),
    bleed(rule(t, { heavy: true })),
    block(t, footer(t, roles, data, site, nav, merge), { background: t.raw('color-surface') })
  ].join('\n');

  return {
    subject,
    preheader,
    html: document_(t, { subject, preheader, body }),
    text: alertText({ data, job, facts, breakdown, stamp, filterState, jobUrl, merge })
  };
}

function alertText({ data, job, facts, breakdown, stamp, filterState, jobUrl, merge }) {
  const line = '='.repeat(56);
  const thin = '-'.repeat(56);
  const out = [];

  out.push('THE INDEX / INSTANT ALERT');
  out.push(line, '');
  out.push(job.company);
  out.push(job.title);
  out.push(data.markStateOf(job) === 're-verified' ? 'Re-verified' : 'Verified this sweep');
  out.push(`FIT ${breakdown.total} of 100`);
  out.push('');
  out.push(`Comp:      ${facts.comp}`);
  out.push(`Location:  ${job.location}`);
  out.push(`Age:       ${facts.age}`);
  out.push(`Applying:  ${data.easeSummary(job)}`);
  out.push('', thin, '');

  out.push('WHY IT MATCHED');
  out.push('You asked to hear about roles matching this filter.');
  out.push(`  ${filterState}`);
  out.push('');
  out.push('This is how it scored against rubric v1.');
  for (const component of breakdown.components) {
    if (component.value === null) {
      out.push(`  ${component.label}: not listed, weight ${component.weight}`);
      continue;
    }
    const note = component.inRange ? '' : '  (above its rubric weight, so no bar is drawn)';
    out.push(`  ${component.label}: ${component.value} of ${component.weight}${note}`);
  }
  out.push(
    breakdown.published
      ? `  FIT ${breakdown.total} = ${breakdown.workingOut} / RUBRIC V1 / WEIGHTS ${breakdown.weightsOut}`
      : `  FIT ${breakdown.total} OF 100 / RUBRIC V1 / WEIGHTS ${breakdown.weightsOut}`
  );
  if (!breakdown.published) {
    out.push('  The total is the machine\'s own score. The split behind it is not in this export, so');
    out.push('  the five readings are not shown.');
  }
  if (breakdown.hasOutOfRange) {
    out.push('  One component sits above the weight the rubric gives it. The total is the sum of the');
    out.push('  components either way, and we have flagged the split to fix at source.');
  }
  out.push('', thin, '');

  out.push(`${data.applyLabel(job)}: ${job.apply_url}`);
  out.push(`Goes to ${job.ease.destination}.`);
  out.push('', thin, '');

  out.push('PROVENANCE');
  out.push(`  First observed ${data.formatDate(job.first_observed) ?? data.ABSENCE.date}`);
  out.push(`  Last verified ${stamp}`);
  out.push(`  Read direct from ${data.sourceLabel(job)}`);
  out.push(`  Full record: ${jobUrl}`);
  out.push('', line, '');

  out.push('LEGEND: (o) verified this sweep / (+) re-verified / (/) closed');
  out.push('The Index reads company applicant tracking feeds direct, verifies every posting at source,');
  out.push('and archives what it kills. Sent because you asked for it.');
  out.push('');
  out.push(`Manage what you get: ${merge.manageTag}`);
  out.push(`Unsubscribe: ${merge.unsubscribeTag}`);

  return out.join('\n');
}
