/**
 * The weekly digest.
 *
 * What it carries, per the page manifest: new roles only, the week's kills, one
 * statistic from facts.json, and the mark legend in the footer. RUN-FINISH
 * phase 6 (MASTER-SPEC F7, "The Ritual") extends that: "digest pipeline,
 * personalized for accounts and generic for subscribers, shipping dark." The
 * generic sections above are unchanged; what is new is the optional `person`
 * input this file's own header below explains, one more section that renders
 * only when a person has something in it, and the empty-week sentinel RUN-
 * FINISH section 4 and constraint 7 both require: "the digest ships dark ...
 * empty weeks send nothing."
 *
 * The one statistic used to be `measured-ghost-rate`, quoted out of facts.json.
 * That entry was deleted on 2026-08-19 because it was never a fact: it was a
 * reading, true of one night, sitting on a list of other people's research. What
 * stands in its place is the same number's honest form, computed from
 * src/data/stats.json through src/lib/readings.ts at build time, exactly as the
 * site computes it. Nothing in this email is a research number now: the counts
 * are records counted, and the dates are dates the machine recorded.
 *
 * PERSONALIZATION INPUT, AND WHY THIS FILE NEVER OPENS A CONNECTION FOR IT.
 *
 * `person`, the fifth argument below, is optional and is plain data: this
 * file has no path to a database. scripts/build-emails.mjs loads exactly four
 * modules through Vite (data.ts, readings.ts, site.ts, nav.ts) and hands their
 * exports to every template; it does not load src/lib/watchlist-store.ts or
 * src/lib/desk-store.ts, both of which are impure (open a connection) and
 * both of which are TypeScript, so a plain Node script cannot import them
 * without the same Vite step build-emails.mjs already uses for the four
 * modules it does load. Wiring that up is the sending pipeline's job, not
 * this template's, so `person` is the caller's own resolution of an
 * account's stored state down to two plain arrays:
 *
 *   watchedCompanies    Company names, one per prospect the account follows
 *                        (src/lib/watchlist-store.ts's StoredFollow list) with
 *                        its prospectId resolved back to that prospect's
 *                        company on src/data/prospects.json. A follow is
 *                        stored against a prospect id, never a company name,
 *                        the same way watchlist-store.ts's own header says a
 *                        job_id is resolved against loadJobs() by the
 *                        caller, at read time, not by the store. This file
 *                        reads company strings because that is the shape
 *                        loadJobs() and loadKills() already carry, so a role
 *                        or a kill matches a family with `===`, nothing more.
 *
 *   applicationJobIds   The `jobId` field alone off the account's Desk
 *                        applications (src/lib/desk-store.ts's
 *                        StoredApplication). Not the full record: this file
 *                        never reads state, interviewSubstage or anything a
 *                        person told the Desk, only the id, matched back
 *                        against loadJobs(). An application with no jobId
 *                        (a pasted external URL, legal per db/006_desk.sql's
 *                        XOR check) contributes nothing here, because there
 *                        is no published record to read a fate off.
 *
 * `digest_personal` (flags.config.mjs) being lit means this personalization
 * is built and provable, which is what the section below and its test cover.
 * It does not mean mail sends: nothing in this file, or in build-emails.mjs,
 * calls a sending platform. See this file's own "nothing to send" branch.
 *
 * WHY POSTING FATE IS "CLOSED WITHIN THE WINDOW" AND NOT desk.ts's fateOf().
 *
 * src/lib/desk.ts's fateOf() is the real state machine and the site's own
 * pages use it. This file cannot: fateOf() is TypeScript, this file is
 * loaded by Node with no Vite step of its own, and build-emails.mjs (which
 * has the Vite step) does not load desk.ts. Reimplementing fateOf() here
 * would be a second copy of a rule data.ts's own header calls out this
 * codebase's whole reason for existing: two surfaces computing the same
 * thing two ways is how they disagree. So this file asks a narrower,
 * honest question instead, answerable from data.ts's own fields alone: did
 * the tracked posting's own `status` become `closed`, with a `closed_on`
 * date inside this week's window. That is a real, dated, sourced event,
 * not a guess at what fateOf() would say. A posting still live prints
 * nothing, on purpose: constraint 13 is state-change-only, and "still
 * open" is not a change.
 *
 * Copy here is drafted and flagged for Ryan's voice pass.
 */

import { esc, style, role, rule, spacer, block, bleed, document_, sectionLabel } from '../lib/shell.mjs';
import { jobRow, killRow, footer, absolute } from '../lib/parts.mjs';
import { digestWindow, newRoles, weekKills, killedInWindow, jobFacts, DIGEST_ROLE_LIMIT, DIGEST_KILL_LIMIT } from '../lib/content.mjs';

/** Roles inside `rows` (already the digest's own selection) at a watched company. */
function familyRoles(rows, watchedCompanies) {
  if (watchedCompanies.size === 0) return [];
  return rows.filter((job) => watchedCompanies.has(job.company));
}

/** Kills inside `rows` (already the digest's own publishable selection) at a watched company. */
function familyKills(rows, watchedCompanies) {
  if (watchedCompanies.size === 0) return [];
  return rows.filter((kill) => watchedCompanies.has(kill.company));
}

/**
 * Tracked applications whose target posting closed inside this week's window.
 * See this file's own header, "WHY POSTING FATE IS ... NOT desk.ts's fateOf()".
 */
function applicationFateChanges(data, window, applicationJobIds) {
  if (applicationJobIds.length === 0) return [];
  const jobs = data.loadJobs();
  const changes = [];
  for (const jobId of applicationJobIds) {
    const job = jobs.find((candidate) => candidate.id === jobId) ?? null;
    if (!job || job.status !== 'closed' || !job.closed_on) continue;
    const elapsed = data.daysBetween(job.closed_on, window.to);
    if (elapsed === null || elapsed < 0 || elapsed > window.days) continue;
    changes.push(job);
  }
  return changes;
}

/** One tracked application's closure, in the same voice killRow() prints a kill in. */
function fateLine(t, roles, data, job) {
  const closedOn = data.formatDate(job.closed_on ?? null);
  return (
    `<div${style({ 'padding-bottom': `${t.px('space-300')}px` })}>` +
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(job.company)}</div>` +
    `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-100')}px` }))}>${esc(job.title ?? 'Untitled posting')}</div>` +
    `<div${style(role(roles.mono, { color: t.raw('color-muted') }))}>Closed ${esc(closedOn ?? 'unknown date')}</div>` +
    (job.closed_reason
      ? `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted'), 'padding-top': `${t.px('space-100')}px` }))}>${esc(job.closed_reason)}</div>`
      : '') +
    `</div>`
  );
}

/**
 * The empty week's sentinel. RUN-FINISH section 4 and constraint 7: "empty
 * weeks send nothing," and the caller has to be able to tell this apart from
 * a real digest without parsing prose. `send: false` is that signal. The
 * html and text below still exist, and still carry the sweep stamp and a
 * true sentence, because this object is also what a reviewer opening this
 * file's own test or a generated proof file reads: an empty shell that
 * looked like a real digest is exactly the failure RUN-FINISH names, and a
 * blank string would be a second version of the same failure, just quieter.
 * Nothing here is ever handed to a sending platform: see this file's own
 * header on `digest_personal` and the send path.
 */
function buildNothingToSend({ t, roles, data, site, nav, merge, stamp }) {
  const subject = 'The Index: nothing to report this week';
  const preheader = `No new roles, no kills, and nothing on your own account changed. Swept ${stamp}.`;

  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `The Index <span${style({ color: t.raw('color-line-strong') })}>·</span> ` +
    `<a href="${esc(site.parent.url)}"${style(role(roles.kicker, { color: t.raw('color-muted'), 'text-decoration': 'none' }))}>by ${esc(site.parent.name)}</a></div>` +
    `<h1${style(role(roles.title, { 'padding-bottom': `${t.px('space-300')}px` }))}>Nothing this week.</h1>` +
    `<div${style(role(roles.mono, { color: t.raw('color-muted') }))}>SWEPT ${esc(stamp.toUpperCase())}</div>`;

  const bodySection =
    sectionLabel(t, roles, 'This week') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-200')}px` }))}>` +
    `No roles were new to the Index this week, nothing was killed, and nothing on your own account changed. ` +
    `Silence beats noise, so nothing was sent: this page exists only to prove the template renders.</div>` +
    `<a href="${esc(site.url)}"${style(role(roles.kicker, { color: t.raw('color-foreground'), 'text-decoration': 'underline' }))}>See the Index</a>`;

  const html = [
    block(t, masthead, { paddingTop: t.px('space-600'), paddingBottom: t.px('space-500') }),
    bleed(rule(t, { heavy: true })),
    block(t, bodySection),
    bleed(rule(t, { heavy: true })),
    block(t, footer(t, roles, data, site, nav, merge), { background: t.raw('color-surface') })
  ].join('\n');

  const text = [
    'THE INDEX / THE WEEKLY DIGEST',
    `by ${site.parent.name}  ${site.parent.url}`,
    `SWEPT ${stamp.toUpperCase()}`,
    '='.repeat(56),
    '',
    'NOTHING THIS WEEK',
    'No roles were new to the Index this week, nothing was killed, and nothing on your own account changed.',
    'Silence beats noise, so nothing was sent. This text exists only to prove the template renders.',
    '',
    `See the Index: ${site.url}`
  ].join('\n');

  return {
    send: false,
    reason: 'No new roles, no kills, and no personal updates this week.',
    subject,
    preheader,
    html,
    text
  };
}

export function buildWeeklyDigest({ t, roles, data, readings, site, nav, merge, person = null }) {
  const window = digestWindow(data);
  const roleRows = newRoles(data, window);
  const kills = weekKills(data, window);
  const killed = killedInWindow(data, window);

  // See this file's own header, "PERSONALIZATION INPUT". Defensive against a
  // caller handing back anything other than the two plain arrays that header
  // documents: a malformed `person` degrades to no personalization rather
  // than a thrown build.
  const watchedCompanies = new Set(Array.isArray(person?.watchedCompanies) ? person.watchedCompanies : []);
  const applicationJobIds = Array.isArray(person?.applicationJobIds) ? person.applicationJobIds : [];
  // Two different reasons a killed record is not listed, counted apart. Held:
  // we cannot evidence its own claim. Unattributed: we can, and we withdrew the
  // rule it fired. Collapsing them would state the wrong admission.
  const heldBack = killed.filter((kill) => kill.held === true).length;
  const unattributed = killed.length - kills.length - heldBack;
  const shown = roleRows.slice(0, DIGEST_ROLE_LIMIT);
  const shownKills = kills.slice(0, DIGEST_KILL_LIMIT);
  const stamp = data.sweptStamp();

  // The account section's own three finds. See this file's own header,
  // "PERSONALIZATION INPUT", for what each one is and is not allowed to read.
  const myRoles = familyRoles(roleRows, watchedCompanies);
  const myKills = familyKills(kills, watchedCompanies);
  const myFateChanges = applicationFateChanges(data, window, applicationJobIds);
  const hasPersonal = myRoles.length > 0 || myKills.length > 0 || myFateChanges.length > 0;

  // RUN-FINISH section 4, constraint 7: "empty weeks send nothing." Empty
  // means the archive's own record of the week, not the published rows: a
  // held or unattributed kill still gets an explanatory sentence below (see
  // killLede), which is real content, so `killed.length` (the archive count,
  // not `kills.length`, the publishable one) is what has to be zero too.
  const isEmptyWeek = roleRows.length === 0 && killed.length === 0 && !hasPersonal;
  if (isEmptyWeek) {
    return buildNothingToSend({ t, roles, data, site, nav, merge, stamp });
  }

  // Computed, never named: the companies holding both a kill and a verified live
  // posting in this sweep. Reading the intersection here rather than writing a
  // company name into a template is the same rule the kill list follows.
  const bothLists = new Map(data.companiesOnBothLists().map((entry) => [entry.company, entry.live]));

  // What the machine killed, not how many rows this email prints. The two were
  // the same number until a record was held back, and the footer states the
  // sweep's own kill count, so a subject counting listed rows would have put two
  // different totals for one sweep in one email.
  const subject = `The Index: ${roleRows.length} new roles, ${killed.length} killed`;

  /**
   * The kill section's opening line, written once and rendered by both the HTML
   * and the text build so the two cannot drift.
   *
   * It states what was killed, then what is not listed and why. A held record is
   * one whose central claim we cannot evidence as our own observation: it is
   * kept in the archive and published nowhere, and an email that dropped it from
   * a total without saying so would be doing the thing the kill list exists to
   * name. Flagged for Ryan's voice pass with the sentence on /kills.
   */
  const killLede =
    `${killed.length} postings were killed this week. ` +
    (unattributed > 0
      ? `${unattributed === 1 ? 'One of them was' : `${unattributed} of them were`} closed under the age rule ` +
        `we retired on 19 August 2026, which killed a posting for outliving a threshold. A duration is not ` +
        `evidence about an employer, so ${unattributed === 1 ? 'it stays' : 'they stay'} in the archive and out ` +
        `of this email. `
      : '') +
    (heldBack > 0
      ? `${heldBack === 1 ? 'One record is' : `${heldBack} records are`} held back and not listed, because we cannot ` +
        `evidence what ${heldBack === 1 ? 'it claims' : 'they claim'} as our own observation. `
      : '') +
    (kills.length === 0
      ? 'Nothing this week tripped a rule we stand behind, so there is nothing here to read. We will not name a company on a hunch.'
      : `The ${shownKills.length} that stayed open longest are below.`);
  const preheader = `Read direct from company feeds and verified at source. Swept ${stamp}.`;

  // -------------------------------------------------------------------------
  // Masthead
  // -------------------------------------------------------------------------
  const masthead =
    `<div${style(role(roles.kicker, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
    `The Index <span${style({ color: t.raw('color-line-strong') })}>·</span> ` +
    `<a href="${esc(site.parent.url)}"${style(role(roles.kicker, { color: t.raw('color-muted'), 'text-decoration': 'none' }))}>by ${esc(site.parent.name)}</a></div>` +
    `<h1${style(role(roles.title, { 'padding-bottom': `${t.px('space-300')}px` }))}>The weekly digest</h1>` +
    `<div${style(role(roles.mono, { color: t.raw('color-muted') }))}>SWEPT ${esc(stamp.toUpperCase())} <span${style({
      color: t.raw('color-line-strong')
    })}></span></div>`;

  // -------------------------------------------------------------------------
  // New roles
  //
  // The section states its selection rule once, in the machine voice, instead of
  // printing the same first-seen date on every row. On this sweep that date is
  // identical for 28 of the 28, and a column of one repeated date implies 28
  // postings appeared overnight, which is why the site suppresses the First seen
  // column while the archive is shallow. One line at the top says where the
  // selection came from without making that claim.
  // -------------------------------------------------------------------------
  const newSection =
    sectionLabel(t, roles, 'New this week') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-200')}px` }))}>` +
    `${roleRows.length} roles are new to the Index this week. The ${shown.length} highest fit are below.</div>` +
    `<div${style(role(roles.mono, { 'font-size': `${t.px('size-075')}px`, color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-500')}px` }))}>` +
    `FIRST OBSERVED BETWEEN ${esc(String(data.formatDate(window.from)).toUpperCase())} AND ${esc(
      String(data.formatDate(window.to)).toUpperCase()
    )}</div>` +
    shown
      .map((job, index) => jobRow(t, roles, data, site, job, jobFacts(data, job)) + (index < shown.length - 1 ? spacer(t.px('space-400')) + rule(t) + spacer(t.px('space-400')) : ''))
      .join('') +
    spacer(t.px('space-500')) +
    `<a href="${esc(site.url)}"${style(role(roles.kicker, { color: t.raw('color-foreground'), 'text-decoration': 'underline' }))}>` +
    `See all ${roleRows.length} on the Index</a>`;

  // -------------------------------------------------------------------------
  // The statistic, then the kills it explains
  // -------------------------------------------------------------------------
  // A reading, not a citation, and the line says which. It is computed from the
  // same stats.json the site's tiles read, so an email and a page built from one
  // sweep cannot state two different numbers for it.
  const byRule = readings.reading('killed_by_rule');
  const factString = `${byRule.display} postings were caught by a named rule this sweep`;
  const factSource = 'Measured by The Index, read direct from company feeds';

  const insight =
    `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-200')}px` }))}>${esc(
      factString
    )}.</div>` +
    `<div${style(role(roles.mono, { 'font-size': `${t.px('size-075')}px`, color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-300')}px` }))}>${esc(
      factSource.toUpperCase()
    )}</div>` +
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>` +
    (kills.length === 0
      ? 'Five rules ran. Each one publishes what it found, and the ones that found nothing publish that.</div>'
      : 'Every row below states what the machine observed, and when. You draw the conclusion.</div>');

  const killSection =
    sectionLabel(t, roles, 'Killed this week') +
    spacer(t.px('space-400')) +
    `<div${style(role(roles.body, { 'padding-bottom': `${t.px('space-500')}px` }))}>` +
    `${esc(killLede)}</div>` +
    shownKills
      .map(
        (kill, index) =>
          killRow(t, roles, data, site, kill, bothLists.get(kill.company) ?? []) +
          (index < shownKills.length - 1 ? spacer(t.px('space-400')) + rule(t) + spacer(t.px('space-400')) : '')
      )
      .join('') +
    spacer(t.px('space-500')) +
    `<a href="${esc(absolute(site, '/kills'))}"${style(role(roles.kicker, { color: t.raw('color-foreground'), 'text-decoration': 'underline' }))}>` +
    (kills.length === 0 ? 'How every rule works</a>' : `See all ${kills.length} kills, with the dates</a>`) +
    spacer(t.px('space-400')) +
    // The appeal line, verbatim from AppealLine.astro. A courtroom has an appeal
    // and a mob does not, and the wording is fixed for that reason.
    `<div${style(role(roles.body, { 'font-size': `${t.px('size-150')}px`, color: t.raw('color-muted') }))}>` +
    `Posting still live and we got it wrong? <a href="mailto:${esc(site.contact)}"${style({
      color: t.raw('color-foreground')
    })}>Tell us</a> and we will re-verify tonight.</div>`;

  // -------------------------------------------------------------------------
  // Your account: the personalized section, and it renders only when it has
  // something to say. Constraint 13, state-change-only: a person whose
  // families, watchlist and applications carry no news this week gets no
  // section at all, not a section saying so. See this file's own header,
  // "PERSONALIZATION INPUT".
  // -------------------------------------------------------------------------
  const personalSection = !hasPersonal
    ? ''
    : sectionLabel(t, roles, 'Your account') +
      spacer(t.px('space-400')) +
      `<div${style(role(roles.mono, { color: t.raw('color-muted'), 'padding-bottom': `${t.px('space-400')}px` }))}>SWEPT ${esc(
        stamp.toUpperCase()
      )}</div>` +
      (myRoles.length === 0
        ? ''
        : `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
          `${myRoles.length} new role${myRoles.length === 1 ? '' : 's'} this week at a company you follow.</div>` +
          myRoles
            .map(
              (job, index) =>
                jobRow(t, roles, data, site, job, jobFacts(data, job)) +
                (index < myRoles.length - 1 ? spacer(t.px('space-400')) + rule(t) + spacer(t.px('space-400')) : '')
            )
            .join('') +
          spacer(t.px('space-500'))) +
      (myKills.length === 0
        ? ''
        : `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
          `${myKills.length} kill${myKills.length === 1 ? '' : 's'} this week at a company you follow.</div>` +
          myKills
            .map(
              (kill, index) =>
                killRow(t, roles, data, site, kill, bothLists.get(kill.company) ?? []) +
                (index < myKills.length - 1 ? spacer(t.px('space-400')) + rule(t) + spacer(t.px('space-400')) : '')
            )
            .join('') +
          spacer(t.px('space-500'))) +
      (myFateChanges.length === 0
        ? ''
        : `<div${style(role(roles.body, { 'font-weight': String(t.number('weight-medium')), 'padding-bottom': `${t.px('space-300')}px` }))}>` +
          `${myFateChanges.length} posting${myFateChanges.length === 1 ? '' : 's'} you are tracking on the Desk closed this week.</div>` +
          myFateChanges.map((job) => fateLine(t, roles, data, job)).join(''));

  const body = [
    block(t, masthead, { paddingTop: t.px('space-600'), paddingBottom: t.px('space-500') }),
    bleed(rule(t, { heavy: true })),
    block(t, newSection),
    bleed(rule(t)),
    block(t, insight, { background: t.raw('color-surface') }),
    bleed(rule(t)),
    block(t, killSection),
    ...(hasPersonal ? [bleed(rule(t, { heavy: true })), block(t, personalSection, { background: t.raw('color-surface') })] : []),
    bleed(rule(t, { heavy: true })),
    block(t, footer(t, roles, data, site, nav, merge), { background: t.raw('color-surface') })
  ].join('\n');

  return {
    send: true,
    subject,
    preheader,
    html: document_(t, { subject, preheader, body }),
    text: digestText({
      data,
      site,
      window,
      roleRows,
      shown,
      kills,
      shownKills,
      killLede,
      stamp,
      factString,
      factSource,
      merge,
      bothLists,
      myRoles,
      myKills,
      myFateChanges,
      hasPersonal
    })
  };
}

/**
 * The text part.
 *
 * Not an afterthought and not a stripped copy of the HTML: a text part is what a
 * screen reader in a plain-text client reads, what a spam filter scores, and
 * what survives when a client refuses HTML. It carries the same facts in the
 * same order, and every absence is still stated rather than left blank, because
 * a blank field in plain text reads as a rendering fault rather than as
 * something the machine did not observe.
 */
function digestText({
  data,
  site,
  window,
  roleRows,
  shown,
  kills,
  shownKills,
  killLede,
  stamp,
  factString,
  factSource,
  merge,
  bothLists,
  myRoles,
  myKills,
  myFateChanges,
  hasPersonal
}) {
  const line = '='.repeat(56);
  const thin = '-'.repeat(56);
  const out = [];

  out.push('THE INDEX / THE WEEKLY DIGEST');
  out.push(`by ${site.parent.name}  ${site.parent.url}`);
  out.push(`SWEPT ${stamp.toUpperCase()}`);
  out.push(line, '');

  out.push('NEW THIS WEEK');
  out.push(`${roleRows.length} roles are new to the Index this week. The ${shown.length} highest fit are below.`);
  out.push(`First observed between ${data.formatDate(window.from)} and ${data.formatDate(window.to)}.`);
  out.push('');

  for (const job of shown) {
    const facts = jobFacts(data, job);
    out.push(`FIT ${job.fit.total}  ${job.company}`);
    out.push(`  ${job.title}`);
    out.push(`  ${data.markStateOf(job) === 're-verified' ? 'Re-verified' : 'Verified this sweep'}`);
    out.push(`  Comp: ${facts.comp}`);
    out.push(`  Location: ${job.location}`);
    out.push(`  Age: ${facts.age}`);
    out.push(`  ${site.url}/role/${job.slug}`);
    out.push(`  ${data.applyLabel(job)}: ${job.apply_url}`);
    out.push('');
  }
  out.push(`See all ${roleRows.length} on the Index: ${site.url}`);
  out.push('', thin, '');

  out.push(`${factString}.`);
  out.push(factSource.toUpperCase());
  out.push(
    kills.length === 0
      ? 'Five rules ran. Each one publishes what it found, and the ones that found nothing publish that.'
      : 'Every row below states what the machine observed, and when. You draw the conclusion.'
  );
  out.push('', thin, '');

  out.push('KILLED THIS WEEK');
  out.push(killLede);
  out.push('');

  for (const kill of shownKills) {
    const duration = data.measuredByUs(kill) ? data.killDuration(kill) : null;
    out.push(`${kill.company}`);
    out.push(`  ${kill.title}`);
    out.push(`  ${kill.reason}`);
    if (duration) {
      out.push(`  ${data.formatDays(duration.days)} open / First published ${data.formatDate(duration.from)}`);
    } else {
      out.push('  No first published date shown at source, so we have not measured how long it was open.');
    }
    if (kill.killed_on) out.push(`  Killed ${data.formatDate(kill.killed_on)}`);
    const siblings = bothLists.get(kill.company) ?? [];
    if (siblings.length > 0) {
      out.push(
        `  ${kill.company} also holds ${siblings.length === 1 ? 'one verified live role' : `${siblings.length} verified live roles`} in this sweep.`
      );
    }
    out.push('');
  }
  out.push(
    kills.length === 0
      ? `How every rule works: ${site.url}/kills`
      : `See all ${kills.length} kills, with the dates: ${site.url}/kills`
  );
  out.push('');
  out.push(`Posting still live and we got it wrong? Tell us at ${site.contact} and we will re-verify tonight.`);
  out.push('');

  // Your account. Same rule as the HTML: renders only when it has news, per
  // constraint 13 (state-change-only). See this file's own header.
  if (hasPersonal) {
    out.push(thin, '');
    out.push('YOUR ACCOUNT');
    out.push(`SWEPT ${stamp.toUpperCase()}`);
    out.push('');

    if (myRoles.length > 0) {
      out.push(`${myRoles.length} new role${myRoles.length === 1 ? '' : 's'} this week at a company you follow.`);
      out.push('');
      for (const job of myRoles) {
        const facts = jobFacts(data, job);
        out.push(`FIT ${job.fit.total}  ${job.company}`);
        out.push(`  ${job.title}`);
        out.push(`  Comp: ${facts.comp}`);
        out.push(`  Location: ${job.location}`);
        out.push(`  ${site.url}/role/${job.slug}`);
        out.push('');
      }
    }

    if (myKills.length > 0) {
      out.push(`${myKills.length} kill${myKills.length === 1 ? '' : 's'} this week at a company you follow.`);
      out.push('');
      for (const kill of myKills) {
        out.push(`${kill.company}`);
        out.push(`  ${kill.title}`);
        out.push(`  ${kill.reason}`);
        if (kill.killed_on) out.push(`  Killed ${data.formatDate(kill.killed_on)}`);
        out.push('');
      }
    }

    if (myFateChanges.length > 0) {
      out.push(`${myFateChanges.length} posting${myFateChanges.length === 1 ? '' : 's'} you are tracking on the Desk closed this week.`);
      out.push('');
      for (const job of myFateChanges) {
        out.push(`${job.company}`);
        out.push(`  ${job.title ?? 'Untitled posting'}`);
        out.push(`  Closed ${data.formatDate(job.closed_on) ?? 'unknown date'}`);
        if (job.closed_reason) out.push(`  ${job.closed_reason}`);
        out.push('');
      }
    }

    out.push('', thin, '');
  }

  out.push(line, '');

  const stats = data.loadStats();
  out.push('LEGEND: (o) verified this sweep / (+) re-verified / (/) closed');
  out.push(`${stats.boards} boards read / ${stats.pulled} pulled / ${stats.verified_live} verified / ${stats.killed} killed`);
  out.push('The Index reads company applicant tracking feeds direct, verifies every posting at source,');
  out.push('and archives what it kills. Sent because you asked for it.');
  out.push('');
  out.push(`Manage what you get: ${merge.manageTag}`);
  out.push(`Unsubscribe: ${merge.unsubscribeTag}`);

  return out.join('\n');
}
