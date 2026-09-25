/**
 * drop-zone.ts: dropping a file onto a band, written once.
 *
 * BROWSER ONLY. Imported by component <script> blocks (Come ready's resumé
 * band and its cover letter), never by a page's frontmatter: it touches
 * DataTransfer and the DOM and nothing else, and it opens no connection of
 * its own.
 *
 * WHAT IT IS FOR. Without a handler, a file dropped on a page is a
 * navigation: the browser leaves for the file and takes whatever the reader
 * was doing with it. This catches the drop, hands the file to a real file
 * input, and lets that input's own change listener submit the form it
 * belongs to, so the request is byte for byte the one the file picker would
 * have produced.
 */

/** The class the band carries while a file is over it. Its look lives in
    come-ready.css beside the other shared marks, so both bands wash the
    same colour and neither can drift. */
const DRAGGING = 'is-dragging';

/** Whether the page-wide miss guard is already installed. */
let missGuarded = false;

/** A file dropped NEXT TO a band, rather than on it, is still a navigation: the
 *  browser leaves for the file and takes whatever the reader was doing with it,
 *  including a half-filled record form. The bands are small targets — a dashed
 *  box a couple of hundred pixels wide — so a miss is the common case, not the
 *  rare one, and the reader cannot tell the difference between "I missed" and
 *  "the upload is broken".
 *
 *  So once any band is wired, the rest of the document swallows drops. A drop on
 *  a band is handled by the band's own listener first and this only sees it on
 *  the way up, where preventDefault has already been called and calling it again
 *  costs nothing.
 *
 *  Installed from wireDropZone rather than at module load, so a page that wires
 *  no band keeps the browser's own behaviour. */
function guardMisses(): void {
  if (missGuarded) return;
  missGuarded = true;
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());
}

export function wireDropZone(band: HTMLElement, input: HTMLInputElement): void {
  guardMisses();
  // Dragging over a child fires dragleave on the parent, so the depth is
  // counted rather than toggled; toggling makes the wash flicker as the
  // pointer crosses a label or a button inside the band.
  let depth = 0;
  const paint = (on: boolean) => band.classList.toggle(DRAGGING, on);

  // A drag is only answered when it is carrying a file. Text selected on the
  // page, a link, an image dragged out of the document — all of those fire the
  // same events, and lighting the band for them promises a catch that the drop
  // handler below would refuse anyway.
  const carriesFile = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  band.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (!carriesFile(event)) return;
    depth += 1;
    paint(true);
  });
  // Without a dragover handler that prevents the default, the drop event
  // never fires at all.
  band.addEventListener('dragover', (event) => event.preventDefault());
  band.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) paint(false);
  });
  band.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    paint(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (!dropped) return;
    const carrier = new DataTransfer();
    carrier.items.add(dropped);
    input.files = carrier.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
