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

export function wireDropZone(band: HTMLElement, input: HTMLInputElement): void {
  // Dragging over a child fires dragleave on the parent, so the depth is
  // counted rather than toggled; toggling makes the wash flicker as the
  // pointer crosses a label or a button inside the band.
  let depth = 0;
  const paint = (on: boolean) => band.classList.toggle(DRAGGING, on);

  band.addEventListener('dragenter', (event) => {
    event.preventDefault();
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
