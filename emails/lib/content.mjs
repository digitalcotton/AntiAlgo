/**
 * What goes in an email, selected from the same data the site reads.
 *
 * Nothing here computes a duration, an age, a fit total or an intersection.
 * src/lib/data.ts owns every derived observation on this property and these
 * functions call it, for the reason that module states: two surfaces doing the
 * same subtraction two ways is how they end up disagreeing about a number that
 * has to be one number, and the disagreement surfaces later in a screenshot.
 *
 * The one derivation that is genuinely new here is the digest window, because
 * the site has no concept of a week. It is defined once, below, and the emails
 * print it rather than implying it.
 */

/**
 * How far back a weekly digest looks, counted from the sweep date.
 *
 * Seven days because the digest is weekly. The window is a stated selection
 * rule, not a claim about the postings: a role inside it is one the machine
 * first observed in the last seven sweeps, which is a fact about our record. It
 * is not a claim that the employer posted it this week, which is a fact we
 * usually do not hold.
 */
export const DIGEST_WINDOW_DAYS = 7;

/**
 * How many of each section a digest prints.
 *
 * The full sweep will not fit in an inbox and a scrolled-past list teaches
 * nothing. Both counts are stated in the copy beside the shown rows ("28 new
 * this week, the 10 highest fit below"), so the cap is visible to the reader
 * rather than being a quiet edit of what happened.
 */
export const DIGEST_ROLE_LIMIT = 10;
export const DIGEST_KILL_LIMIT = 6;

/** The window, as two dates the email can print. */
export function digestWindow(data) {
  const to = data.sweepDate();
  const toMillis = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  const from = new Date(toMillis - DIGEST_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { from, to, days: DIGEST_WINDOW_DAYS };
}

const insideWindow = (data, isoDate, window) => {
  if (!isoDate) return false;
  const elapsed = data.daysBetween(isoDate, window.to);
  return elapsed !== null && elapsed >= 0 && elapsed <= window.days;
};

/**
 * Roles the machine first observed inside the window, best fit first.
 *
 * `first_observed` is our own record rather than the employer's claim, which is
 * exactly why this selection is defensible where "posted this week" would not
 * be: 28 of these 37 rows carry no published date at all, so we cannot say when
 * they went up. We can say when we first saw them, and the digest says that.
 *
 * Rows with no `first_observed` are not swept into the list on the assumption
 * that they must be new. They are absent, which is the truthful state.
 */
export function newRoles(data, window) {
  const inside = data.verifiedJobs().filter((job) => insideWindow(data, job.first_observed, window));
  return data.sortJobs(inside, 'fit');
}

/**
 * Kills recorded inside the window, longest measured duration first.
 *
 * PUBLISHABLE RECORDS ONLY. `loadKills()` excludes a record marked held, which
 * is a real kill whose central claim we cannot evidence as our own observation.
 * A held record is listed nowhere, in an email as much as on the site, and
 * `killedInWindow()` below is what stops that exclusion from quietly shrinking a
 * count the email states out loud.
 *
 * Rows with no measured duration sort last and keep their place in the record:
 * dropping them would make the list look tidier than the evidence is. Uplight's
 * kill is dated the 16th, a day before the sweep, and is not normalised to the
 * sweep date.
 */
export function weekKills(data, window) {
  const inside = data.loadKills().filter((kill) => insideWindow(data, kill.killed_on, window));
  return [...inside].sort((left, right) => {
    const leftDays = data.killDuration(left)?.days ?? -1;
    const rightDays = data.killDuration(right)?.days ?? -1;
    if (leftDays !== rightDays) return rightDays - leftDays;
    return left.company.localeCompare(right.company);
  });
}

/**
 * Everything the machine killed inside the window, held records included.
 *
 * "N postings were killed this week" is a claim about what the machine did, not
 * about how many rows this email prints, so it counts the archive. The digest
 * says in the same breath how many of them it is publishing and why the rest
 * are absent, for the same reason the kill list does: a surface that states a
 * total and then silently shows fewer rows is the move this product exists to
 * name.
 */
export function killedInWindow(data, window) {
  return data.killArchive().filter((kill) => insideWindow(data, kill.killed_on, window));
}

/**
 * The role an instant alert fires on: the highest fit of the window's new roles.
 *
 * The real machine fires an alert when a new posting matches a subscriber's
 * stored filter string. The template needs one populated instance, and picking
 * the top of the same ordering the digest uses means the fixture instance is
 * chosen by a rule rather than by taste. It also lands on a record that carries
 * a fit component outside its rubric weight, which is the case the template has
 * to get right and the one a hand-picked example would have avoided.
 */
export function alertRole(data, window) {
  const candidates = newRoles(data, window);
  if (candidates.length === 0) return null;
  return candidates[0];
}

/**
 * The comp, location and age cells, each rendering an absence where the record
 * holds nothing. The strings come from data.ts so the email and the table say
 * the same words about the same gap.
 */
export function jobFacts(data, job) {
  return {
    comp: job.comp_posted ?? data.ABSENCE.value,
    compPresent: Boolean(job.comp_posted),
    location: job.location ?? data.ABSENCE.value,
    locationPresent: Boolean(job.location),
    age: data.formatAge(job) ?? data.ABSENCE.date,
    agePresent: data.formatAge(job) !== null,
    ageBasis: data.ageOf(job) ? data.AGE_BASIS_LABEL[data.ageOf(job).basis] : null,
    ageFrom: data.ageOf(job) ? data.formatDate(data.ageOf(job).from) : null
  };
}

/**
 * The filter state string an alert was created with.
 *
 * The capture module stores this alongside an instant-alert consent, so at send
 * time the machine substitutes the subscriber's own string. A template built
 * from fixtures has no subscriber, so the populated instance renders the facets
 * of the role itself, derived by `facetsOf()`. It is labelled in the email as
 * the alert this matched, and the merge field is named in emails/README.md so
 * the substitution has one documented place to happen.
 */
export function filterStateOf(data, job) {
  const facets = data.facetsOf(job);
  const groups = data.filterGroups(data.verifiedJobs());
  const labelFor = (groupKey, value) => {
    const group = groups.find((entry) => entry.key === groupKey);
    const option = group?.options.find((entry) => entry.value === value);
    if (!group || !option) return null;
    // Both halves, because "Remote" alone does not say which control produced
    // it and a reader should be able to match the string to the filter row.
    return `${group.label}: ${option.label}`;
  };
  return ['location', 'comp', 'freshness']
    .map((key) => labelFor(key, facets[key]))
    .filter(Boolean)
    .join(' · ');
}
