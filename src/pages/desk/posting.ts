/**
 * /desk/posting: "Add a job". POST, by intent.
 *
 * A member pastes a job posting URL. This records the same tracked card the
 * paste flow in desk/application.ts creates (state 'clicked', external_url),
 * records a fetch request (db/033), wakes the Mac mini, which reads the page
 * and posts the text back to /machine/posting-fetch/result, and sends the
 * person to the posting's own page (/board/added-<id>), which narrates the
 * read and then carries the draft rail. Nothing on this route waits for the
 * network.
 *
 * NOTHING IS DRAFTED HERE (since 2026-09-11). Every intent used to start the
 * resume and cover letter the moment text existed. That drafted before the
 * person could say why they want the job, and doubled the spend when they
 * then pressed Generate with a reason. Now every intent ends on the posting's
 * page, and the draft starts when they press Generate there, through
 * /desk/job-draft like any other posting.
 *
 * FOUR INTENTS. `add` (a URL), `paste` (the person's own text for a posting
 * the machine could not read, or did not read yet), `retry` (an unreadable
 * or stale read back to the queue), `rename` (title or company the page did
 * not carry). Every intent but add acts on one application this person owns.
 *
 * THE VERIFIED SHORTCUT. A URL that matches one of the index's own postings
 * needs no machine: a jobId card, and the person lands on the /role page,
 * whose own rail drafts. The machine reads only what the index has never read.
 *
 * THIS ROUTE FETCHES NOTHING. desk/application.ts's stance ("this codebase
 * does not fetch other people's pages") still holds for the site: the fetch
 * happens on the mini, on its own network, and arrives here as data that is
 * sanitised on the way in (result.ts).
 */
import type { APIContext } from 'astro';
import { boardDetailPath, jobPath, routeFor } from '../../data/nav';
import { loadJobs } from '../../lib/data';
import { isOn } from '../../lib/flags';
import { createApplicationFromClick, getActiveApplicationForJob, getApplication } from '../../lib/desk-store';
import {
  NAME_MAX_CHARS,
  SNAPSHOT_MAX_CHARS,
  countRecentPostingFetches,
  createPostingFetch,
  getPostingFetchByApplication,
  getPostingFetchByUrlKey,
  normaliseUrlKey,
  pastePostingFetch,
  renamePostingFetch,
  resetPostingFetch
} from '../../lib/posting-fetch-store';
import { fillApplicationSnapshot } from '../../lib/desk-store';
import { addedSlugFor } from '../../lib/added-posting';
import { publishWake } from '../../lib/machine-wake';
import { deferWork } from '../../lib/defer-work';
import { plainTextFromHtml } from '../../lib/vocabulary';

export const prerender = false;

/** At most this many adds per person per hour. Each one is a read on the mini
    and up to two model calls on the person's own key once the text lands. */
export const ADD_CEILING = 20;
const ADD_WINDOW_MS = 60 * 60 * 1000;
const PASTE_MAX_CHARS = SNAPSHOT_MAX_CHARS;
const URL_MAX_CHARS = 2000;

function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json');
}

/** The Opportunities tracker, for a bounce with nowhere better to land (a bad
    URL from the modal, an application that is not this person's). The add-a-job
    modal that posts here lives on /opportunities, so a bounce returns there. */
function deskPath(view: string, notice?: string): string {
  const base = `${routeFor('opportunities')}?view=${view === 'table' ? 'table' : 'board'}`;
  return notice ? `${base}&posting=${notice}` : base;
}

/** The posting's own page: where every intent on an added posting ends. */
function detailPath(applicationId: number, notice?: string): string {
  const base = boardDetailPath(addedSlugFor(applicationId));
  return notice ? `${base}?posting=${notice}` : base;
}

/** A pasted address, or null. https only: the mini refuses anything else too. */
function acceptableUrl(raw: string): string | null {
  const trimmed = raw.trim().slice(0, URL_MAX_CHARS);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function jobForUrl(url: string) {
  return loadJobs().find((job) => job.apply_url === url || job.source_url === url) ?? null;
}

function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The person's pasted text as paragraphs: blank lines split, single newlines
    break. Escaped first, so pasted markup is text, never markup. */
export function pastedTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function applicationIdFrom(form: FormData): number | null {
  const raw = String(form.get('applicationId') ?? '').trim();
  if (!/^[1-9]\d{0,17}$/.test(raw)) return null;
  return Number(raw);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;
  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }
  if (!isOn('add_posting')) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const userId = viewer.userId;
  const form = await context.request.formData();
  const intent = String(form.get('intent') ?? '');
  const view = String(form.get('view') ?? 'board');

  if (intent === 'add') {
    const url = acceptableUrl(String(form.get('url') ?? ''));
    if (!url) {
      return wantsJson(context.request)
        ? Response.json({ error: 'bad-url' }, { status: 400 })
        : redirectTo(deskPath(view, 'bad-url'));
    }

    // The index's own posting: a card, then its /role page, no machine involved.
    const verified = jobForUrl(url);
    if (verified) {
      const tracked = await getActiveApplicationForJob(userId, verified.id);
      if (!tracked) {
        await createApplicationFromClick(userId, {
          jobId: verified.id,
          externalUrl: null,
          snapshotTitle: verified.title,
          snapshotCompany: verified.company,
          snapshotDescription: plainText(verified.description_html),
          clickedAt: new Date()
        });
      }
      const detailUrl = jobPath(verified.slug);
      return wantsJson(context.request) ? Response.json({ verified: true, detailUrl }) : redirectTo(detailUrl);
    }

    // The same posting twice is one card, and the same page.
    const existing = await getPostingFetchByUrlKey(userId, normaliseUrlKey(url));
    if (existing) {
      return wantsJson(context.request)
        ? Response.json({ applicationId: existing.applicationId, requestId: existing.id, detailUrl: detailPath(existing.applicationId), existing: true })
        : redirectTo(detailPath(existing.applicationId));
    }

    try {
      const recent = await countRecentPostingFetches(userId, ADD_WINDOW_MS);
      if (recent >= ADD_CEILING) {
        return new Response('You have added a lot of postings in the last hour. Give it a little while, then try again.', {
          status: 429,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' }
        });
      }
    } catch (error) {
      console.error(`desk/posting: could not read the add rate for user ${userId}; allowing.`, error);
    }

    const created = await createApplicationFromClick(userId, {
      jobId: null,
      externalUrl: url,
      snapshotTitle: null,
      snapshotCompany: null,
      snapshotDescription: null,
      clickedAt: new Date()
    });
    const request = await createPostingFetch(userId, created.id, url);
    // Fire and forget: a lost wake delays the read, the drain catches it up.
    deferWork(publishWake(request.id));

    if (wantsJson(context.request)) {
      return Response.json({
        applicationId: created.id,
        requestId: request.id,
        detailUrl: detailPath(created.id)
      });
    }
    return redirectTo(detailPath(created.id));
  }

  // Every intent below acts on one application this person owns.
  const applicationId = applicationIdFrom(form);
  if (applicationId === null) return redirectTo(deskPath(view));
  const application = await getApplication(userId, applicationId);
  const fetchRow = application ? await getPostingFetchByApplication(userId, applicationId) : null;
  if (!application || !fetchRow) return redirectTo(deskPath(view));

  if (intent === 'paste') {
    const text = String(form.get('text') ?? '').trim().slice(0, PASTE_MAX_CHARS);
    const title = String(form.get('titleOverride') ?? '').trim().slice(0, NAME_MAX_CHARS) || null;
    const company = String(form.get('companyOverride') ?? '').trim().slice(0, NAME_MAX_CHARS);
    if (!text || !company) {
      return redirectTo(detailPath(applicationId, 'paste-incomplete'));
    }
    const html = pastedTextToHtml(text);
    const settled = await pastePostingFetch(userId, applicationId, { title, company, descriptionHtml: html });
    if (settled) {
      await fillApplicationSnapshot(userId, applicationId, { title, company, description: text.slice(0, SNAPSHOT_MAX_CHARS) });
    }
    return redirectTo(detailPath(applicationId));
  }

  if (intent === 'retry') {
    const reset = await resetPostingFetch(userId, applicationId);
    if (reset) deferWork(publishWake(reset.id));
    return redirectTo(detailPath(applicationId));
  }

  if (intent === 'rename') {
    const title = String(form.get('titleOverride') ?? '').trim().slice(0, NAME_MAX_CHARS) || null;
    const company = String(form.get('companyOverride') ?? '').trim().slice(0, NAME_MAX_CHARS) || null;
    const renamed = await renamePostingFetch(userId, applicationId, { title, company });
    if (renamed) {
      // The card's own name follows, where it was still empty.
      await fillApplicationSnapshot(userId, applicationId, {
        title: renamed.title,
        company: renamed.company,
        description: renamed.descriptionHtml ? plainTextFromHtml(renamed.descriptionHtml).slice(0, SNAPSHOT_MAX_CHARS) : null
      });
    }
    return redirectTo(detailPath(applicationId));
  }

  return new Response('Unknown intent.', { status: 400 });
}
