import type { APIRoute, GetStaticPaths } from 'astro';
import {
  ABSENCE,
  AGE_BASIS_LABEL,
  ageOf,
  applyLabel,
  fitComponents,
  firstSeen,
  firstSeenShowable,
  formatDate,
  formatDays,
  liveJobsAtCompany,
  loadJobs,
  sortJobs,
  sourceLabel,
  sweepDate,
  sweptStamp,
  type Job
} from '../../lib/data';
import { embedNote, safeDescription, stripRemoteEmbeds } from '../../lib/description';
import { isOn } from '../../lib/flags';
import { jobPath, routeFor } from '../../data/nav';
import { absoluteUrl } from '../../data/site';
import {
  applyCaption,
  expiryOf,
  provenanceStatus,
  rowPosition,
  statusStamp,
  verifiedCount
} from '../../components/job-detail/detail';

/**
 * The markdown twin of every job page, at /jobs/<slug>.md.
 *
 * WHY A SITE ABOUT AGENTS SHIPS A PLAIN TEXT COPY OF ITS OWN PAGES. The HTML
 * page is laid out for a person deciding whether to spend twenty minutes on an
 * application. A model reading the same posting has to reconstruct that record
 * out of markup, and every reconstruction is a chance to get a number wrong on
 * a site whose entire argument is that numbers do not get wrong here. So the
 * record ships twice, from one source, in two shapes: the page for the reader
 * and this for the machine.
 *
 * IT IS A TWIN, NOT A SUMMARY. Every section below is the same section of the
 * page, in the same order, with the same absences spelled the same way. If a
 * value is missing here it is missing there, and vice versa. Two documents that
 * describe one record and disagree would be worse than either alone, so nothing
 * in this file computes anything: the ages, durations, orderings and labels all
 * come from src/lib/data.ts and components/job-detail/detail.ts, which is what
 * the page reads too.
 *
 * The closed variant carries no apply section, no apply URL and no fit
 * reasoning, exactly as the closed page carries no apply action. A machine
 * scraping this file cannot be handed an application path the page refuses to
 * show a person.
 */

export const getStaticPaths = (() =>
  loadJobs().map((job) => ({ params: { slug: job.slug }, props: { job } }))) satisfies GetStaticPaths;

/** One bullet, with the absence spelled the way every other surface spells it. */
function row(key: string, value: string | null, absence: string): string {
  return `- ${key}: ${value ?? absence}`;
}

function factsSection(job: Job): string[] {
  return [
    '## The facts, as posted',
    '',
    row('Title', job.title, ABSENCE.value),
    row(
      'Compensation',
      job.comp_posted ? `${job.comp_posted}, range posted at source` : null,
      `${ABSENCE.value} at source`
    ),
    row('Location', job.location, ABSENCE.value),
    row('Posted date', formatDate(job.published_date), `${ABSENCE.date} at source`),
    row('Source system', sourceLabel(job), ABSENCE.value),
    row('Source URL', job.source_url, ABSENCE.value)
  ];
}

function descriptionSection(job: Job): string[] {
  // The embed pass, not the raw field, so the twin and the page withhold the
  // same thing. Heading levels stay as the employer wrote them: this file is a
  // document of its own rather than a section of one. See src/lib/description.ts.
  const description = safeDescription(job.description_html);
  const withheld = job.description_html
    ? embedNote(stripRemoteEmbeds(job.description_html).removed)
    : null;

  if (description) {
    return [
      '## The description, as published',
      '',
      'Verbatim from the source feed. Markup as fetched, not rewritten.',
      '',
      description,
      ...(withheld ? ['', withheld] : [])
    ];
  }
  return [
    '## The description, as published',
    '',
    `Nothing published in the feed we read. This slot renders the employer's own description verbatim from ${sourceLabel(job)} when the machine has one. It is never paraphrased and never summarised, so an empty slot stays empty.`
  ];
}

function fitSection(job: Job): string[] {
  const breakdown = fitComponents(job);
  const lines = [`## Fit, rubric v1`, '', `Fit ${breakdown.total} of 100.`, ''];

  for (const component of breakdown.components) {
    if (component.value === null) {
      // The twin spells an absence exactly as the page does. A model reading
      // this file has to reach the same conclusion a person reading the page
      // does, and "not listed" is the site's word for a thing we do not hold.
      lines.push(`- ${component.label}: ${ABSENCE.value}, against a rubric weight of ${component.weight}`);
      continue;
    }
    const note =
      component.fraction === null
        ? ' (outside the rubric range for this component, so the page draws no bar. The score still sums.)'
        : '';
    lines.push(`- ${component.label}: ${component.value} of ${component.weight}${note}`);
  }

  lines.push('');
  lines.push(
    breakdown.published
      ? `Fit ${breakdown.total} = ${breakdown.workingOut} · rubric v1 · weights ${breakdown.weightsOut}`
      : `Fit ${breakdown.total} of 100 · rubric v1 · weights ${breakdown.weightsOut}`
  );
  lines.push('');
  if (!breakdown.published) {
    lines.push(
      'The total is the machine\'s own score for this posting. The split behind it is not in this export, so the five readings are not shown. The weights are rubric v1 and are what a reading would be measured against.'
    );
    lines.push('');
  }
  lines.push(
    'The rubric scores the posting, never the reader. There is no per-component reasoning here because the machine does not emit one, and writing it downstream would be inventing the machine\'s reasoning.'
  );
  return lines;
}

function provenanceSection(job: Job): string[] {
  const age = ageOf(job);
  const observed = firstSeen(job);
  const showObserved = firstSeenShowable(job);

  const lines = [
    '## Provenance',
    '',
    row(
      'First observed',
      showObserved ? formatDate(observed) : null,
      observed ? 'Held back while most rows were first seen on this sweep' : 'Not recorded for this posting'
    ),
    row('Last verified', sweptStamp(), ABSENCE.date),
    row('Age', age ? formatDays(age.days) : null, ABSENCE.date)
  ];

  if (age) {
    lines.push(`- Age measured from: ${AGE_BASIS_LABEL[age.basis]} ${formatDate(age.from)}`);
  }

  lines.push(`- Source: ${sourceLabel(job)}, read direct`);
  lines.push(`- Status: ${provenanceStatus(job)}`);
  return lines;
}

/**
 * The twin of PostingBiography.astro: MASTER-SPEC F10's "posting biography on
 * the detail page: first seen, published date with basis, lifecycle to date."
 * Same three rows, same order, same helpers as the HTML panel, so the two
 * documents cannot disagree about a posting's own history. See that
 * component's own header for why this sits beside `provenanceSection` rather
 * than folded into it, and for why the repost row stays unwritten while
 * `repost_biography` is dark: the fields are not in the published files, the
 * machine is frozen (owner ruling, 2026-08-31), and the Job type carries no
 * field for either to read.
 */
function biographySection(job: Job): string[] {
  const isClosed = job.status === 'closed';
  const age = ageOf(job);
  const observed = firstSeen(job);
  const showObserved = firstSeenShowable(job);

  const lifecycle = isClosed
    ? [
        job.closed_on ? `Closed ${formatDate(job.closed_on)}` : 'Closed, no date shown at source',
        job.closed_reason ?? 'No reason recorded at source',
        `confirmed archived ${sweptStamp()}`
      ].join(', ')
    : `${job.status === 're_verified' ? 'Live, re-verified' : 'Live, verified'} against ${sourceLabel(job)} at this sweep, ${sweptStamp()}`;

  const lines = [
    '## Posting biography',
    '',
    row(
      'First seen',
      showObserved ? formatDate(observed) : null,
      observed ? 'Held back while most rows were first seen on this sweep' : 'Not recorded for this posting'
    ),
    row(
      'Published date',
      job.published_date ? `${formatDate(job.published_date)}, as posted at source` : null,
      age
        ? `Not shown at source. Dated from ${AGE_BASIS_LABEL[age.basis]} ${formatDate(age.from)} instead`
        : 'Not shown at source, and no other date to measure from'
    ),
    `- Lifecycle to date: ${lifecycle}`
  ];

  // Dark, and staying dark: the machine is frozen and no export is pending.
  // Same gate as the HTML panel: no field on Job exists to read, so nothing
  // is pushed while the flag is off, which it is in both editions.
  if (isOn('repost_biography')) {
    lines.push(row('Repost history', null, 'Not yet available.'));
  }

  return lines;
}

function easeSection(job: Job): string[] {
  // Null only on a pre-posting row, which has no role page and so no mirror.
  // The section is dropped rather than filled with a measurement nobody took.
  const ease = job.ease;
  if (ease === null) return [];
  return [
    '## Ease of apply',
    '',
    `- Friction: ${ease.friction}`,
    row(
      'Estimated time',
      typeof ease.minutes_estimate === 'number' ? `~${ease.minutes_estimate} min` : null,
      'Not measured for this posting'
    ),
    `- Account: ${ease.account_required ? 'Required' : 'Not required'}`,
    `- Destination: ${ease.destination}`,
    '',
    'The tilde marks an estimate rather than a measurement.'
  ];
}

function windowSection(job: Job): string[] {
  const expiry = expiryOf(job);

  // No date where the window has nothing left. The record carries a window and
  // the sweep found the posting on its last day, so there is no later date to
  // stand behind and none is invented. See expiryOf() in detail.ts.
  if (!expiry) {
    return [
      '## Verification window',
      '',
      job.window
        ? `No date. This record carries a ${job.window.days} day window and the sweep of ${formatDate(sweepDate())} found the posting on day ${job.window.day} of it, so the window has nothing left to run.`
        : `No date. This record carries no verification window, so there is nothing to count from.`,
      '',
      'Nothing is published as validThrough in the page\'s structured data either. The next sweep decides whether this reading still stands, and until it runs we hold no date after which it goes stale.'
    ];
  }

  return [
    '## Verification window',
    '',
    `This reading stands until ${expiry.date}, which is ${expiry.basis}.`,
    '',
    'That date is ours, not the employer\'s. It is when the machine stops standing behind this reading unless a later sweep refreshes it, and it is the value published as validThrough in the page\'s structured data.'
  ];
}

function applySection(job: Job): string[] {
  if (!job.apply_url) {
    return [
      '## Apply',
      '',
      'No apply path was recorded for this posting on this sweep. The source URL above is the record we hold.'
    ];
  }
  return ['## Apply', '', `${applyLabel(job)}: ${job.apply_url}`, '', `${applyCaption(job)}.`];
}

function historySection(job: Job): string[] {
  const observed = firstSeen(job);
  const lines = ['## Full history', ''];

  if (job.published_date) {
    lines.push(`- ${formatDate(job.published_date)}: published at source, the date the posting itself showed.`);
  }
  lines.push(
    firstSeenShowable(job) && observed
      ? `- ${formatDate(observed)}: first observed in the feed.`
      : '- Observed live before the closure. Earlier observations are held in the archive. No dates are guessed here.'
  );
  lines.push(
    `- ${formatDate(job.closed_on ?? null) ?? ABSENCE.date}: closure detected at source.${job.closed_reason ? ` Reason of record: ${job.closed_reason}.` : ''}`
  );
  lines.push(
    `- ${sweptStamp()}: confirmed closed, archived. The record stays public. Closures are part of the index, not deletions from it.`
  );
  return lines;
}

function closureSection(job: Job): string[] {
  return [
    '## Closure record',
    '',
    row('Last seen live', null, 'Not recorded before the closure'),
    row('Closure detected', formatDate(job.closed_on ?? null), ABSENCE.date),
    `- Confirmed: ${sweptStamp()}`,
    row('Reason of record', job.closed_reason ?? null, 'None recorded at source')
  ];
}

function siblingsSection(job: Job): string[] {
  const siblings = sortJobs(liveJobsAtCompany(job.company), 'fit').filter(
    (other) => other.slug !== job.slug
  );
  const lines = [`## Still hiring at ${job.company}, verified this sweep`, ''];

  if (siblings.length === 0) {
    lines.push(
      `At ${job.company}: no other roles were verified live on this sweep. Every role this sweep verified is at ${absoluteUrl(routeFor('index'))}.`
    );
    return lines;
  }

  for (const sibling of siblings) {
    lines.push(`- ${sibling.title}, fit ${sibling.fit.total}: ${absoluteUrl(jobPath(sibling.slug))}`);
  }
  return lines;
}

function render(job: Job): string {
  const isClosed = job.status === 'closed';
  const position = rowPosition(job);
  // absoluteUrl, not `${SITE.url}${path}`: jobPath already carries the base and
  // SITE.url carries it too, so the hand-written join printed a canonical of
  // tokenstoagents.ai/jobs/jobs/<slug> on all 38 twins while the HTML page's own
  // rel=canonical, built through new URL(), was right. See src/data/site.ts.
  const canonical = absoluteUrl(jobPath(job.slug));

  const head = [
    `# ${job.title}`,
    '',
    `${job.company} · ${statusStamp(job)}`,
    '',
    `The Index. Verified at source ${sweptStamp()}.`,
    position !== null ? `Row ${position} of ${verifiedCount()} by fit on the index.` : 'Archived record. Not on the index.',
    `Canonical: ${canonical}`,
    ''
  ];

  const body = isClosed
    ? [
        '## This posting closed',
        '',
        'The machine found this posting closed at source and archived the record. Nothing here accepts applications, because a closed role that still takes them is a resume black hole, and we do not operate one.',
        '',
        ...factsSection(job),
        '',
        ...historySection(job),
        '',
        ...closureSection(job),
        '',
        ...provenanceSection(job),
        '',
        ...biographySection(job),
        '',
        ...siblingsSection(job)
      ]
    : [
        ...factsSection(job),
        '',
        ...descriptionSection(job),
        '',
        ...fitSection(job),
        '',
        ...provenanceSection(job),
        '',
        ...biographySection(job),
        '',
        ...easeSection(job),
        '',
        ...windowSection(job),
        '',
        ...applySection(job)
      ];

  const foot = [
    '',
    '## How to read this file',
    '',
    'Every number here is an observation the machine made, stamped at the sweep that made it. Where a value is missing it says so in words. Nothing on this page is inferred, rounded to look tidy, or filled in from a plausible default.'
  ];

  return [...head, ...body, ...foot].join('\n') + '\n';
}

export const GET: APIRoute = ({ props }) => {
  const job = props.job as Job;
  return new Response(render(job), {
    headers: {
      // charset stated, because a comp string carries a currency glyph and a
      // separator that a byte-guessing client would render as mojibake.
      'Content-Type': 'text/markdown; charset=utf-8'
    }
  });
};
