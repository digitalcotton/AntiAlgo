/**
 * kills.ts: the recent kill records, read from the index, never typed.
 *
 * The index publishes the rows behind its kill count at /board/kills.json
 * (site.config's INDEX_KILLS_URL), rebuilt from its own store on every request,
 * the last two months of records, newest first. This site reads that endpoint
 * per request and keeps one short in-memory copy, the same way stats.ts reads
 * the sweep totals: a burst of visitors costs the index one fetch a minute.
 *
 * THE COMPANY IS REDACTED HERE, on the way in. The index names the company on
 * its own kill list, which is its record to publish. On this public marketing
 * page the record is shown as evidence of a pattern, not to name a firm, so the
 * company is dropped and, because the machine's observation prose repeats it,
 * scrubbed out of the observation too before it is ever rendered.
 *
 * A fetch that fails returns an empty list, and the evidence surface renders the
 * absence in the human voice rather than a card it did not read.
 */
import { INDEX_KILLS_URL } from '../../site.config.mjs';
import { dayStamp } from './stats';

/** The redaction stand-in shown wherever the company name would have been. */
export const REDACTED = 'Company redacted';

export interface KillRecord {
  /** The role title. Kept: the company is the identity, not the role. */
  role: string;
  /** The rule the machine fired, e.g. "repost-churn". Null until upstream emits it. */
  rule: string | null;
  /** The machine's observation, company scrubbed out. */
  observation: string;
  /** First published and killed, as the index prints them, or null. */
  firstPublished: string | null;
  killedOn: string | null;
  /** Days the posting stayed open, killed minus first published, or null. */
  openDays: number | null;
}

export interface KillFeed {
  /** The records, newest first, company redacted. */
  records: KillRecord[];
  /** The instant the index served the feed, as an ISO string, or null. */
  servedAt: string | null;
}

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 8 * 1000;

let cached: { at: number; value: KillFeed } | null = null;

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Remove the company name from a piece of the machine's prose. Case
 * insensitive, whole runs of it, so "Brex took this role down" and "a posting
 * at this company" both survive without the name in them. A blank or missing
 * company scrubs nothing.
 */
function scrubCompany(text: string, company: string): string {
  const name = company.trim();
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), REDACTED);
}

function parse(raw: unknown): KillFeed {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.kills)) {
    return { records: [], servedAt: null };
  }
  const records: KillRecord[] = [];
  for (const entry of o.kills) {
    const k = entry as Record<string, unknown>;
    if (!k || typeof k !== 'object') continue;
    if (typeof k.title !== 'string' || typeof k.reason !== 'string') continue;
    const company = typeof k.company === 'string' ? k.company : '';
    records.push({
      role: k.title,
      rule: typeof k.kill_rule === 'string' ? k.kill_rule : null,
      observation: scrubCompany(k.reason, company),
      firstPublished: typeof k.first_published === 'string' ? dayStamp(k.first_published) : null,
      killedOn: typeof k.killed_on === 'string' ? dayStamp(k.killed_on) : null,
      openDays: isNumber(k.open_days) ? k.open_days : null
    });
  }
  const servedAt = typeof o.served_at_utc === 'string' ? o.served_at_utc : null;
  return { records, servedAt };
}

const EMPTY: KillFeed = { records: [], servedAt: null };

export async function loadKills(): Promise<KillFeed> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let value: KillFeed = EMPTY;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(INDEX_KILLS_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (response.ok) value = parse(await response.json());
  } catch (error) {
    console.error("kills: could not read the index's kill records:", error);
  }
  // A failed or empty read is remembered only briefly, so one bad moment is not
  // a minute of an empty evidence page.
  const ok = value.records.length > 0;
  cached = { at: ok ? now : now - (CACHE_MS - 10 * 1000), value };
  return value;
}

/**
 * The shared bar scale for the set: the longest open span among the records
 * shown, so every bar measures against the same width, the way the index's own
 * duration bar does. Zero when nothing carries a span.
 */
export function killScaleMax(records: readonly KillRecord[]): number {
  return records.reduce((longest, r) => Math.max(longest, r.openDays ?? 0), 0);
}
