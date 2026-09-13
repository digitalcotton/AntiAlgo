/**
 * draft-job.ts: the one place a draft slug becomes a Job.
 *
 * THREE POPULATIONS, IN THIS ORDER. An added posting (slug `added-<id>`,
 * src/lib/added-posting.ts) is owner scoped and needs the viewer's id: without
 * one it resolves to nothing, so a stranger's URL, a signed-out request and a
 * run token for someone else's draft all land on the same null. Then the
 * verified set (src/data/jobs.json, in memory). Then the board table (db/017,
 * db/018) when a database is configured. Every draft leg (the begin endpoint,
 * the room, the run endpoint, the PDF route) resolves through here and fails
 * closed on null.
 *
 * An added posting is draftable only once its text has landed (ready or
 * pasted). A pending fetch is not yet a job: the run endpoint's own
 * "no-such-job" branch fails the render honestly if a stale token ever arrives
 * before the text does.
 */
import { jobBySlug, type Job } from './data';
import { isConfigured } from './db';
import { getBoardJobBySlug } from './job-store';
import { boardRowToJob } from './board-jobs';
import { addedApplicationId, addedPostingToJob, isAddedSlug } from './added-posting';
import { getPostingFetchByApplication } from './posting-fetch-store';

export async function draftableJobBySlug(slug: string, userId?: string | null): Promise<Job | null> {
  const wanted = slug.trim();
  if (!wanted) return null;

  if (isAddedSlug(wanted)) {
    const applicationId = addedApplicationId(wanted);
    if (applicationId === null || !userId || !isConfigured()) return null;
    const row = await getPostingFetchByApplication(userId, applicationId);
    if (!row || (row.status !== 'ready' && row.status !== 'pasted')) return null;
    return addedPostingToJob(row);
  }

  const verified = jobBySlug(wanted);
  if (verified) return verified;

  if (!isConfigured()) return null;

  const row = await getBoardJobBySlug(wanted);
  return row ? boardRowToJob(row) : null;
}
