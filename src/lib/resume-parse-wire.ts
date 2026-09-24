/**
 * resume-parse-wire.ts: the vocabulary the resume-import endpoints speak, and
 * the two questions every consumer of it has to answer.
 *
 * WHY THIS MODULE EXISTS. On 2026-09-19, ab7b03c made the read land straight in
 * the Profile Record and then DELETE its own row (resume-parse-runner.ts calls
 * completeParse, applyParsedProposals, clearParse in three consecutive awaits).
 * That changed the lifetime of 'ready' from durable — it used to sit there until
 * a human clicked confirm — to a few milliseconds. From the browser's side,
 * 'none' became what success looks like.
 *
 * The commit touched six files, every one of them src/lib/resume-parse-*.ts and
 * their tests. Not one client file. Three browser surfaces were each holding a
 * hand-written list of the statuses that meant "stop waiting", and all three
 * silently became wrong. Two were repaired on 2026-09-20 (341f8af, StepResume;
 * and StepLetter). src/pages/profile.astro was not, and for four days an upload
 * that had ALREADY written its entries to the record sat through forty polls,
 * two full minutes, and then told the reader the read was taking too long.
 *
 * THE FIX IS NOT A WIDER LIST. Widening a whitelist leaves a whitelist. The
 * runner still has a path that leaves a row 'pending' for good
 * (resume-parse-runner.ts, "the one honest dead end"), so a 'failed' status is
 * the obvious next thing to add — and the moment it ships, every hand-written
 * list breaks again with no change of its own. So the list lives here once, the
 * two predicates below are the only way to ask about it, and their switches have
 * NO default clause: adding a member to ImportWireStatus is a compile error in
 * this file rather than a two-minute hang in three browsers.
 *
 * ZERO IMPORTS, DELIBERATELY. This module is imported by client <script> blocks
 * as well as by the endpoints. Anything it pulled in would be bundled into the
 * browser, and the endpoints' neighbours reach the database.
 *
 * NOT THE SAME AS ParseStatus. resume-parse-store.ts exports
 * `ParseStatus = 'pending' | 'ready'`, which types the DATABASE ROW. The wire is
 * wider than the row: it also has to say "there is no row" ('none'), "your POST
 * was accepted and the read is running" ('started') and "you are not signed in"
 * ('signed-out'). Three of the five values below existed nowhere in the type
 * system before this file.
 */

/** Every value the import endpoints can put in a response's `status` field.
 *
 *  'none'        no row. Either nothing was ever started, or — far more often —
 *                a read finished, its proposals were written into the record and
 *                clearParse deleted the row. THIS IS WHAT SUCCESS USUALLY LOOKS
 *                LIKE, which is the whole lesson of this module.
 *  'pending'     a read is genuinely still running.
 *  'ready'       finished, row not yet cleared. Observable for milliseconds in
 *                the normal path, and durably when applyParsedProposals threw
 *                and left the proposals for review.
 *  'started'     answer to a POST: accepted, handed to the background runner.
 *  'signed-out'  the session is gone. The caller stops and navigates. */
export type ImportWireStatus = 'none' | 'pending' | 'ready' | 'started' | 'signed-out';

/** Whether a poller should stop asking.
 *
 *  This is NOT "did it work" — 'signed-out' ends the wait and is not a success.
 *  Use readLanded for that. */
export function pollEnds(status: ImportWireStatus): boolean {
  switch (status) {
    case 'ready':
    case 'none':
    case 'signed-out':
      return true;
    case 'pending':
    case 'started':
      return false;
  }
}

/** Whether the read finished and its findings exist somewhere the reader can
 *  see: written into the record ('none', after clearParse) or still sitting in
 *  the row for review ('ready').
 *
 *  A caller that gets true here should reload rather than report a failure. */
export function readLanded(status: ImportWireStatus): boolean {
  switch (status) {
    case 'none':
    case 'ready':
      return true;
    case 'pending':
    case 'started':
    case 'signed-out':
      return false;
  }
}

/** Narrow an unknown JSON body to a wire status.
 *
 *  Returns null for a body that is not one of ours, which is the case that used
 *  to be mistaken for a network fault: fetch() follows redirects, so the gate's
 *  302 to /sign-in arrives as a 200 HTML page, response.ok is true, and
 *  .json() throws. A caller that gets null here should hand the submission back
 *  to the browser as a plain navigation rather than blaming the connection. */
export function wireStatusOf(body: unknown): ImportWireStatus | null {
  if (!body || typeof body !== 'object') return null;
  const status = (body as { status?: unknown }).status;
  return isImportWireStatus(status) ? status : null;
}

/** The runtime half of the union, for narrowing a parsed response. Kept beside
 *  the type so a new member cannot be added to one and forgotten in the other:
 *  the ALL array below is checked against the type at compile time. */
export function isImportWireStatus(value: unknown): value is ImportWireStatus {
  return typeof value === 'string' && (ALL_IMPORT_WIRE_STATUSES as readonly string[]).includes(value);
}

/** Every member, once, for the runtime guard and for the tests to iterate.
 *
 *  The annotation is what binds it to the union: drop a member and
 *  `satisfies`-style assignment fails, add one to the type without adding it
 *  here and the exhaustiveness test below catches it. */
export const ALL_IMPORT_WIRE_STATUSES: readonly ImportWireStatus[] = [
  'none',
  'pending',
  'ready',
  'started',
  'signed-out'
];
