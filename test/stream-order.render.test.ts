import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import StreamPage from './fixtures/stream/StreamPage.astro';

/**
 * Pins the runtime fact the /board restructuring (this ticket) depends on:
 * an `await` inside a BODY component delays only the bytes after it, while
 * the head (and anything rendered before that child) has already flushed.
 * StreamPage is a minimal, hermetic document (no BaseLayout, no DB) with one
 * child, SlowChild, whose frontmatter awaits a 150ms timer before it emits
 * its marker. If the container did not stream at all, both markers would
 * land in the same chunk and this test would fail loudly rather than pass by
 * accident.
 */
async function streamTimings(): Promise<{ headTime: number | null; markerTime: number | null; chunkCount: number }> {
  // `streaming` defaults to false (a single buffered response), so it has to
  // be requested explicitly to observe real chunk-by-chunk delivery.
  const container = await AstroContainer.create({ streaming: true });
  const response = await container.renderToResponse(StreamPage);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let acc = '';
  let headTime: number | null = null;
  let markerTime: number | null = null;
  let chunkCount = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkCount += 1;
    acc += decoder.decode(value, { stream: true });
    const now = performance.now();
    if (headTime === null && acc.includes('data-head-marker')) {
      headTime = now;
    }
    if (markerTime === null && acc.includes('data-slow-marker')) {
      markerTime = now;
    }
  }

  return { headTime, markerTime, chunkCount };
}

describe('Astro container streaming: head flushes before a slow body child resolves', () => {
  it('emits the head marker at least 100ms before the slow child marker', async () => {
    const { headTime, markerTime, chunkCount } = await streamTimings();

    expect(headTime).not.toBeNull();
    expect(markerTime).not.toBeNull();

    if (chunkCount <= 1) {
      throw new Error(
        'container streaming did not engage: head and slow-child markers arrived in a single chunk, ' +
          'so this test cannot demonstrate stream ordering. AstroContainer.create() defaulted to buffering ' +
          'the whole response instead of streaming it.'
      );
    }

    expect(markerTime! - headTime!).toBeGreaterThanOrEqual(100);
  });
});
