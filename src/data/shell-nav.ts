/**
 * The shared shell's navigation, restated for this repository.
 *
 * WHY THIS FILE EXISTS AT ALL. The Index and the marketing site are two separate
 * Astro builds, in two separate repositories, deployed as two separate projects.
 * They are one site to a reader, who moves between tokenstoagents.ai and
 * tokenstoagents.ai/jobs without ever seeing a seam, so they have to wear the
 * same chrome. There is no module one can import from the other without
 * coupling two deployments, so the nav is stated twice and checked once.
 *
 * THE CHECK IS THE POINT. Two hand kept copies drift, and drift in a navigation
 * is the kind of bug nobody files: a link goes missing on one site and everyone
 * assumes it was never there. scripts/check-shell-parity.mjs compares this file
 * against the marketing site's src/data/nav.ts and fails when the two disagree
 * about what the header shows. Copying without that check would be worse than
 * not copying.
 *
 * EVERY HREF IS AN ORDINARY SAME ORIGIN PATH. The Index is served at /jobs on
 * tokenstoagents.ai, not at a subdomain, so a link to /reference works from
 * here exactly as it works from there. Locally these 404, because the dev
 * server for this repository only serves /jobs, and that is expected: the two
 * halves only meet in production, where the rewrite joins them.
 */

export interface ShellLink {
  key: string;
  href: string;
  label: string;
}

/** The chain, as the map dropdown lists it. Numbers are the layer numbers. */
export const MAP_LINKS: (ShellLink & { n: string })[] = [
  { key: 'home', href: '/', label: 'The map', n: '00' },
  { key: 'tokens', href: '/tokens', label: 'Tokens', n: '01' },
  { key: 'machine-readable-logic', href: '/machine-readable-logic', label: 'Machine-readable logic', n: '02' },
  { key: 'spec-driven-development', href: '/spec-driven-development', label: 'Spec-driven development', n: '03' },
  { key: 'runtime-context', href: '/runtime-context', label: 'Runtime context', n: '04' }
];

/** The return path, which renders under the chain with the undo mark. */
export const MAP_TAIL: ShellLink[] = [
  { key: 'readback', href: '/readback', label: 'The readback layer' }
];

/** The practical material, behind one trigger. */
export const REFERENCE_LINKS: ShellLink[] = [
  { key: 'reference', href: '/reference', label: 'Reference' },
  { key: 'glossary', href: '/glossary', label: 'Glossary' },
  { key: 'kit', href: '/kit', label: 'The starter kit' },
  { key: 'source', href: '/source', label: 'Source' },
  { key: 'search', href: '/search', label: 'Search' }
];

export const STANDARD_LINK: ShellLink = { key: 'standard', href: '/standard', label: 'The standard' };
export const WRITING_LINK: ShellLink = { key: 'writing', href: '/writing', label: 'Writing' };

/**
 * This product's own pages, which the job index trigger opens.
 *
 * The hrefs are written with the /jobs prefix rather than run through this
 * repository's routeFor(). That looks redundant here and is not: the same list
 * has to render identically on the marketing site, which has no idea this
 * repository has a base path, so the prefix is part of the address rather than
 * something a build step adds. One list, one shape, both sites.
 */
export const JOBS_LINK: ShellLink & { children: ShellLink[] } = {
  key: 'jobs',
  href: '/jobs',
  label: 'The job index',
  children: [
    { key: 'index', href: '/jobs', label: 'Index' },
    { key: 'kills', href: '/jobs/kills', label: 'Kill list' },
    { key: 'report', href: '/jobs/report', label: 'The report' },
    { key: 'manifesto', href: '/jobs/not-here', label: 'Not here, on purpose' },
    // Label corrected 2026-08-24: The Desk shipped in phase 4 task 2 (see
    // nav.ts's own `desk` PAGES entry), so "soon" had been stale since then.
    { key: 'desk', href: '/jobs/desk', label: 'The Desk' },
    { key: 'methodology', href: '/jobs/methodology', label: 'Methodology' }
  ]
};
