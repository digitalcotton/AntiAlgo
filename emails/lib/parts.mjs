/**
 * The repeated pieces of both emails.
 *
 * A role row appears in the digest and, expanded, in the alert. A footer appears
 * in both. Written once so the two emails cannot describe the same posting
 * differently, which is the same argument src/components/README.md makes about
 * the site's seven pages.
 */

import { esc, style, role, rule, spacer, markInline, markLegend } from './shell.mjs';

/**
 * An absolute URL, because a mail client has no origin to resolve a path
 * against.
 *
 * `path` is base-free. SITE.url already carries the base (/jobs), so joining
 * them gives the served URL and putting the base in the path here would double
 * it. That is the one thing to know before editing any link in this directory.
 */
export const absolute = (site, path) => `${site.url}${path}`;

/**
 * The origin on its own, for the few hrefs that arrive already based.
 *
 * The ecosystem band in src/data/nav.ts holds one internal path now that the
 * Desk preview is linked, and a path is exactly what an inbox cannot resolve.
 * Rather than teach the band about emails, the footer joins it to the origin
 * here and leaves the site's own copy untouched.
 */
export const originOf = (site) => new URL(site.url).origin;

/**
 * A key and its value on one line, with the value in the voice its provenance
 * earns: mono when the machine measured it, sans when it is an absence.
 *
 * This is standing rule 3 and the components README's rule 4, applied in a place
 * where colour is doing less work than it does on the site. In an inbox the
 * typeface is the most reliable signal a reader has, and it is the one that
 * survives a client that rewrites colours.
 */
export function factLine(t, roles, { label, value, present }) {
  const valueStyle = present
    ? role(roles.mono, { color: t.raw('color-foreground') })
    : role(roles.body, { color: t.raw('color-muted'), 'font-size': `${t.px('size-150')}px` });
  return (
    `<tr>` +
    `<td valign="top"${style(
      role(roles.kicker, { color: t.raw('color-muted'), padding: `${t.px('space-100')}px ${t.px('space-400')}px ${t.px('space-100')}px 0`, width: '110px' })
    )}>${esc(label)}</td>` +
    `<td valign="top"${style({ ...valueStyle, padding: `${t.px('space-100')}px 0` })}>${esc(value)}</td>` +
    `</tr>`
  );
}

export function factTable(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}>${rows.join('')}</table>`;
}

/**
 * One role, as the digest lists it.
 *
 * The fit score sits in its own column at the left, which is where the approved
 * index canvas puts it, and it is the one number a reader scans down. Two links:
 * the title goes to the posting's page on the site, which is where the
 * provenance panel is, and the apply line goes to the source. Naming both
 * destinations rather than offering one unlabelled button is standing rule 4.
 */
export function jobRow(t, roles, data, site, job, facts) {
  const title = esc(job.title);
  const jobUrl = absolute(site, `/role/${job.slug}`);

  const compCell = facts.compPresent
    ? `<span${style(role(roles.mono, {}))}>${esc(facts.comp)}</span>`
    : `<span${style(role(roles.body, { color: t.raw('color-muted'), 'font-size': `${t.px('size-150')}px` }))}>${esc(facts.comp)}</span>`;

  const ageCell = facts.agePresent
    ? `<span${style(role(roles.mono, { color: t.raw('color-muted') }))}>${esc(facts.age)}</span>`
    : `<span${style(role(roles.body, { color: t.raw('color-muted'), 'font-size': `${t.px('size-150')}px` }))}>${esc(facts.age)}</span>`;

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}>` +
    `<tr>` +
    `<td valign="top"${style({ width: '64px', 'padding-right': `${t.px('space-400')}px` })}>` +
    `<div${style(
      role(roles.mono, {
        'font-size': `${t.px('size-400')}px`,
        'font-weight': String(t.number('weight-bold')),
        'line-height': '1.1',
        // Tabular figures from the token, so a column of scores lines up. Single
        // quoted in the token source, which is what makes it safe inside a double
        // quoted style attribute.
        'font-feature-settings': t.raw('feature-tabular')
      })
    )}>${job.fit.total}</div>` +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'font-size': `${t.px('size-050')}px` }))}>Fit</div>` +
    `</td>` +
    `<td valign="top">` +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(job.company)}</div>` +
    `<div${style({ 'padding-bottom': `${t.px('space-200')}px` })}>` +
    `<a href="${esc(jobUrl)}"${style(
      role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'text-decoration': 'none', color: t.raw('color-foreground') })
    )}>${title}</a></div>` +
    `<div${style({ 'padding-bottom': `${t.px('space-100')}px` })}>${markInline(t, data.markStateOf(job), roles)}</div>` +
    `<div${style({ 'padding-bottom': `${t.px('space-100')}px` })}>${compCell}` +
    `<span${style(role(roles.mono, { color: t.raw('color-line-strong'), padding: `0 ${t.px('space-200')}px` }))}>·</span>` +
    `<span${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>${esc(job.location)}</span></div>` +
    `<div${style({ 'padding-bottom': `${t.px('space-200')}px` })}>${ageCell}</div>` +
    `<div><a href="${esc(job.apply_url)}"${style(
      role(roles.kicker, { color: t.raw('color-foreground'), 'text-decoration': 'underline' })
    )}>${esc(data.applyLabel(job))}</a></div>` +
    `</td></tr></table>`
  );
}

/**
 * One kill.
 *
 * A duration renders only where the machine measured it, which is
 * `measuredByUs()`: `killed_on` minus `first_published`, never the stored
 * `duration_open_days`. A row whose figure came from outside reporting prints no
 * duration here at all, because a number in this column would read as ours. The
 * four rows with no first-published date print the absence in the human voice.
 *
 * No duration bar, and that is deliberate. The kill list draws one against a
 * cited 9.8 day reference line, and this email carries exactly one statistic
 * from facts.json. A bar with no reference line is a picture of nothing, and a
 * reference line here would be a second uncited number. See DECISIONS.md.
 */
export function killRow(t, roles, data, site, kill, siblings) {
  const duration = data.measuredByUs(kill) ? data.killDuration(kill) : null;

  // Two dates, each labelled once. The duration's "to" date is the kill date, so
  // printing the span and then the kill date again would be the same observation
  // twice, and a ledger that repeats itself reads as one that was not checked.
  const dateLine = duration
    ? `<span${style(role(roles.mono, {}))}>${esc(data.formatDays(duration.days))} open</span>` +
      `<span${style(role(roles.mono, { color: t.raw('color-line-strong'), padding: `0 ${t.px('space-200')}px` }))}>·</span>` +
      `<span${style(role(roles.mono, { color: t.raw('color-muted') }))}>First published ${esc(data.formatDate(duration.from))}</span>`
    : `<span${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>No first published date shown at source, so we have not measured how long it was open.</span>`;

  const killedLine = kill.killed_on
    ? `<span${style(role(roles.mono, { color: t.raw('color-muted') }))}>Killed ${esc(data.formatDate(kill.killed_on))}</span>`
    : '';

  // The fairness treatment, computed rather than named: a company on this list
  // that also holds a verified live posting says so, on its own row. It costs
  // nothing, it is true, and it makes every other row more credible.
  const both =
    siblings.length > 0
      ? `<div${style({ 'padding-top': `${t.px('space-200')}px` })}>` +
        `<a href="${esc(absolute(site, '/kills'))}"${style(
          role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') })
        )}>${esc(kill.company)} also holds ${siblings.length === 1 ? 'one verified live role' : `${siblings.length} verified live roles`} in this sweep.</a></div>`
      : '';

  return (
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(kill.company)}</div>` +
    `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-200')}px` }))}>${esc(kill.title)}</div>` +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-foreground'), 'padding-bottom': `${t.px('space-200')}px` }))}>${esc(kill.reason)}</div>` +
    `<div>${dateLine}</div>` +
    (killedLine ? `<div${style({ 'padding-top': `${t.px('space-100')}px` })}>${killedLine}</div>` : '') +
    both
  );
}

/**
 * The rubric, with a bar per component.
 *
 * The bar is a two cell table at a percentage width, which every mail client
 * renders identically and no client needs CSS for. Where a component falls
 * outside its rubric weight the value prints and the bar does not, and the row
 * says why: clipping 37 to a full 30 wide bar would draw a picture that says
 * "at the maximum" about a number that is past it. That rule is data.ts's, and
 * this is it rendered in a place that cannot use the site's component.
 */
export function fitBars(t, roles, breakdown) {
  const rows = breakdown.components
    .map((component) => {
      // No published reading, so no value and no bar: the row states the
      // rubric weight, which is real, and says the reading is not listed. Same
      // rule the site's FitBars follows, rendered where a custom property
      // cannot reach. See data.ts, fit component provenance.
      const bar = component.value === null
        ? `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>Not published in this export, so nothing is drawn for it.</div>`
        : component.inRange
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}><tr>` +
          `<td${style({
            width: `${Math.round(component.fraction * 100)}%`,
            height: `${t.px('space-200')}px`,
            'background-color': t.raw('color-mark-live'),
            'font-size': '0',
            'line-height': '0'
          })}>&nbsp;</td>` +
          `<td${style({
            width: `${100 - Math.round(component.fraction * 100)}%`,
            height: `${t.px('space-200')}px`,
            'background-color': t.raw('color-line'),
            'font-size': '0',
            'line-height': '0'
          })}>&nbsp;</td>` +
          `</tr></table>`
        : `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>Above its rubric weight, so no bar is drawn.</div>`;

      return (
        `<tr><td${style({ padding: `0 0 ${t.px('space-300')}px 0` })}>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}><tr>` +
        `<td${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(component.label)}</td>` +
        /* Standing rule 3 decides the face here: a reading is a machine
           assertion and takes the mono, an absence is us saying what we do not
           hold and takes the sans. The weight stays beside it either way,
           because a bar with no stated maximum is a picture of nothing. */
        `<td align="right"${style(
          role(component.value === null ? roles.body : roles.mono, {
            'font-size': `${t.px('size-075')}px`,
            color: t.raw('color-muted'),
            'padding-bottom': `${t.px('space-100')}px`
          })
        )}>${component.value === null ? `Not listed, weight ${component.weight}` : `${component.value} of ${component.weight}`}</td>` +
        `</tr></table>${bar}</td></tr>`
      );
    })
    .join('');

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${style({ width: '100%' })}>${rows}</table>` +
    `<div${style(role(roles.mono, { 'font-size': `${t.px('size-075')}px`, color: t.raw('color-muted') }))}>` +
    (breakdown.published
      ? `FIT ${breakdown.total} = ${esc(breakdown.workingOut)} · RUBRIC V1 · WEIGHTS ${esc(breakdown.weightsOut)}`
      : `FIT ${breakdown.total} OF 100 · RUBRIC V1 · WEIGHTS ${esc(breakdown.weightsOut)}`) +
    `</div>` +
    (breakdown.published
      ? ''
      : `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-top': `${t.px('space-200')}px` }))}>` +
        `The total is the machine's own score. The split behind it is not in this export, so the five readings are not shown.</div>`)
  );
}

/**
 * The sweep counts, in the machine voice.
 *
 * Straight out of stats.json, and they reconcile: verified plus killed equals
 * pulled, and killed over pulled is the ghost rate the one licensed statistic
 * quotes. Printed as a footer line rather than as tiles, because an inbox is not
 * a dashboard.
 */
export function sweepCounts(t, roles, data) {
  const stats = data.loadStats();
  const parts = [
    `${stats.boards} boards read`,
    `${stats.pulled} pulled`,
    `${stats.verified_live} verified`,
    `${stats.killed} killed`
  ];
  return `<div${style(role(roles.mono, { 'font-size': `${t.px('size-075')}px`, color: t.raw('color-muted') }))}>${parts
    .map(esc)
    .join(' · ')}</div>`;
}

/**
 * The footer both emails share.
 *
 * Carries the legend (standing rule 5: a mark is never more than one viewport
 * from its meaning), the way home to the mothership, the sweep counts, and the
 * unsubscribe. The unsubscribe href is a merge field the sending platform fills
 * in; it is named in one constant so it can be corrected in one place, and it is
 * flagged in emails/README.md because nothing here has been able to verify it
 * against a live account.
 */
/*
 * `nav` is still in this signature and is no longer read. It stays because
 * three templates and a new one landing this wave all call footer() with the
 * same six arguments, and changing the shape of a shared function while other
 * work is mid-flight breaks callers this file cannot see. Drop the parameter
 * and update every call site in one deliberate pass, not as a side effect of
 * fixing the band below.
 */
export function footer(t, roles, data, site, nav, { unsubscribeTag, manageTag }) {
  // THE WAY HOME, AND WHY IT IS TWO LINKS RATHER THAN A BAND.
  //
  // This used to read nav.ECOSYSTEM from src/data/nav.ts: a band listing the
  // sibling properties with a "you are here" cell for this one. That export is
  // gone. SiteFooter.astro was ported from the marketing site and reads
  // shell-nav.ts instead, and nav.ts's own header records the removal. Nothing
  // updated this function, so both emails threw on every build, which is how a
  // shared helper fails: silently for whoever deleted the export, loudly for
  // whoever builds next.
  //
  // It is not restored as a band, because the band is not what an inbox needs.
  // On the site the shared header carries the way home, which is exactly why
  // SiteFooter dropped it. A reader in an inbox has no header and no chrome at
  // all, so the way home has to be in the message: this product, and the site
  // it belongs to. Two links, both absolute, because a relative href in an
  // inbox resolves against the webmail host or does nothing.
  //
  // Read from `site` rather than from a navigation module, since these two
  // addresses are facts about the property and are already stated once in
  // src/data/site.ts.
  const origin = originOf(site);
  const homeLinks = [
    { href: site.url, label: site.name },
    { href: site.parent.url, label: site.parent.name }
  ];
  const ecosystem = homeLinks
    .map(({ href, label }) => {
      const absolute = href.startsWith('/') ? `${origin}${href}` : href;
      return `<a href="${esc(absolute)}"${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-foreground'), 'text-decoration': 'none' }))}>${esc(label)}</a>`;
    })
    .join(`<span${style(role(roles.body, { color: t.raw('color-line-strong'), padding: `0 ${t.px('space-200')}px` }))}>&#183;</span>`);

  return (
    markLegend(t, roles) +
    spacer(t.px('space-400')) +
    rule(t) +
    spacer(t.px('space-400')) +
    sweepCounts(t, roles, data) +
    spacer(t.px('space-300')) +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-200')}px` }))}>` +
    `The Index reads company applicant tracking feeds direct, verifies every posting at source, and archives what it kills. Sent because you asked for it.</div>` +
    `<div${style({ 'padding-bottom': `${t.px('space-300')}px` })}>${ecosystem}</div>` +
    `<div>` +
    `<a href="${esc(manageTag)}"${style(role(roles.kicker, { color: t.raw('color-muted'), 'text-decoration': 'underline' }))}>Manage what you get</a>` +
    `<span${style(role(roles.kicker, { color: t.raw('color-line-strong'), padding: `0 ${t.px('space-200')}px` }))}>·</span>` +
    `<a href="${esc(unsubscribeTag)}"${style(role(roles.kicker, { color: t.raw('color-muted'), 'text-decoration': 'underline' }))}>Unsubscribe</a>` +
    `</div>`
  );
}
