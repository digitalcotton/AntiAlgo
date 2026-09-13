/**
 * kill-plain.ts: the finding in plain words, from the record's own facts.
 *
 * Every kill row carries the machine's reason sentence verbatim, and that
 * sentence is written for the record: "this posting is dated 2026-09-03 and
 * its title, location ... identical to a posting ... dated 2024-08-23, and left
 * them 8 day(s) before this one appeared at a new URL". A reader should not
 * have to parse that. This says the same thing in one line, built ONLY from
 * the scalar evidence the mini exports beside the sentence (Kill.evidence),
 * never from the prose: the site's own rule is that a finding is read off the
 * record or it does not ship. A record with no evidence gets no plain line and
 * keeps the sentence alone.
 *
 * Numbers come back as their own segments so the page can mark each one
 * data-truth="machine": a per-record observation the machine measured.
 */
import { formatDate, type Kill } from './data';

export type PlainSegment = { text: string } | { figure: string };

const days = (n: number): PlainSegment[] => [{ figure: String(n) }, { text: n === 1 ? ' day' : ' days' }];

export function plainKillSegments(kill: Kill): PlainSegment[] | null {
  const ev = kill.evidence;
  if (!ev) return null;
  const company = kill.company;
  switch (kill.kill_rule) {
    case 'repost_churn': {
      if (typeof ev.gap_days !== 'number') return null;
      const link = ev.identifier === 'reused' ? 'at the same link' : 'under a new link';
      const dated = ev.current_published ? formatDate(ev.current_published) : null;
      return [
        { text: `${company} took this role down and put the identical text back up ` },
        ...days(ev.gap_days),
        { text: ` later, ${link}${dated ? `, dated ${dated}` : ''}.` }
      ];
    }
    case 'touched_not_refreshed': {
      if (typeof ev.days_moved !== 'number') return null;
      const from = ev.published_was ? formatDate(ev.published_was) : null;
      const to = ev.published_now ? formatDate(ev.published_now) : null;
      return [
        { text: `${company} moved only the date on this posting` },
        { text: from && to ? `, from ${from} to ${to}, ` : ', ' },
        ...days(ev.days_moved),
        { text: ' forward. Every other field stayed exactly as it was.' }
      ];
    }
    case 'misrepresented': {
      if (!ev.location_as_printed) return null;
      return [
        { text: `${company} lists this role as ${ev.location_as_printed}, and the posting's own text requires the office.` }
      ];
    }
    case 'zombie': {
      if (typeof ev.days_past !== 'number') return null;
      const deadline = ev.deadline ? formatDate(ev.deadline) : null;
      return [
        { text: `${company} left this posting up ` },
        ...days(ev.days_past),
        { text: ` past the closing date it printed itself${deadline ? `, ${deadline}` : ''}.` }
      ];
    }
    case 'phantom': {
      if (typeof ev.http_status !== 'number') return null;
      return [
        { text: `The link ${company} published for this role no longer works: it answered ` },
        { figure: String(ev.http_status) },
        { text: ' on two separate requests.' }
      ];
    }
    default:
      return null;
  }
}
