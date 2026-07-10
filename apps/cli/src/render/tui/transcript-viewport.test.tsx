import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { settleFrames } from './harness-util.js';
import { INITIAL_SCROLL } from './scroll.js';
import type { ViewportGeometry } from './scroll.js';
import { TranscriptViewport } from './transcript-viewport.js';
import type { DisplayLine } from './viewport.js';

/**
 * `TranscriptViewport`'s reported geometry (2.6.F Step 6). `top` is the whole basis of mouse selection: a terminal
 * mouse report carries an ABSOLUTE 1-based row, and turning it into a wrapped-transcript line index needs to know
 * which frame row the viewport's first row occupies —
 *
 *     displayLine = scrollOffset + (mouseRow - 1 - top)
 *
 * `measureElement` exposes only width/height, so `top` is summed from yoga up the `parentNode` chain. That is an
 * assumption about ink's internals, so it is not assumed: each test below renders a REAL ink tree and asserts the
 * reported `top` equals the frame's own line index for the viewport's first row. If a future ink bump changes how
 * layout maps to the frame, these fail before anything user-visible does.
 */

afterEach(cleanup);

const lines = (n: number): DisplayLine[] =>
  Array.from({ length: n }, (_, i) => ({ text: `L${i}`, style: 'assistant' as const }));

/** Mount the viewport inside a rows-bounded column, with `header` rows above and `live` rows below — the shape both
 *  surfaces use (the Home puts its management strip above; the prompt/overlays sit below). */
function mountAt(
  header: number,
  live: number,
  rows: number,
): { frame: () => string; geometry: () => ViewportGeometry | undefined } {
  let geometry: ViewportGeometry | undefined;
  const h = render(
    <Box flexDirection="column" height={rows}>
      {Array.from({ length: header }, (_, i) => (
        <Text key={`h${i}`}>HDR{i}</Text>
      ))}
      <TranscriptViewport
        lines={lines(40)}
        color={false}
        scroll={INITIAL_SCROLL}
        onMeasure={(g) => {
          geometry = g;
        }}
      />
      {Array.from({ length: live }, (_, i) => (
        <Text key={`f${i}`}>FTR{i}</Text>
      ))}
    </Box>,
  );
  return { frame: () => h.lastFrame() ?? '', geometry: () => geometry };
}

/** The frame row at which the viewport's FIRST rendered line appears — the ground truth `top` must match. */
const firstViewportRow = (frame: string): number =>
  frame.split('\n').findIndex((line) => /^L\d+/.test(line.trimEnd()));

describe('TranscriptViewport — the reported frame offset', () => {
  it('top === 0 when the viewport is the first child (the `relavium chat` shape)', async () => {
    const { frame, geometry } = mountAt(0, 2, 12);
    await settleFrames();
    expect(geometry()?.top).toBe(0);
    expect(geometry()?.top).toBe(firstViewportRow(frame())); // ground truth: the frame itself
  });

  it('top counts the rows above it (the Home’s management strip)', async () => {
    const { frame, geometry } = mountAt(3, 2, 12);
    await settleFrames();
    expect(geometry()?.top).toBe(3);
    expect(geometry()?.top).toBe(firstViewportRow(frame()));
  });

  it('top is UNCHANGED when the live region grows (an overlay opens) — only the height shrinks', async () => {
    const small = mountAt(3, 2, 12);
    await settleFrames();
    const tall = mountAt(3, 6, 12);
    await settleFrames();

    expect(tall.geometry()?.top).toBe(3);
    expect(tall.geometry()?.top).toBe(firstViewportRow(tall.frame()));
    // The overlay eats the viewport's height, never its position — a selection anchored before it opened stays valid.
    expect(tall.geometry()?.height).toBeLessThan(small.geometry()?.height ?? 0);
  });

  it('SUMS the whole parentNode chain — a NESTED viewport’s own yoga top is not its frame row', async () => {
    // The load-bearing case. In both surfaces today every ancestor happens to sit at offset 0, so reading the box's
    // OWN `getComputedTop()` would coincidentally agree — and a break-verify proved the chain walk was untested.
    // Here an intermediate Box is itself offset, so the box's own top (1) differs from its frame row (2).
    let geometry: ViewportGeometry | undefined;
    const h = render(
      <Box flexDirection="column" height={12}>
        <Text>HDR0</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text>SUB0</Text>
          <TranscriptViewport
            lines={lines(40)}
            color={false}
            scroll={INITIAL_SCROLL}
            onMeasure={(g) => {
              geometry = g;
            }}
          />
        </Box>
        <Text>FTR0</Text>
      </Box>,
    );
    await settleFrames();
    expect(geometry?.top).toBe(2); // 1 (header) + 1 (the nested Box's own first row)
    expect(geometry?.top).toBe(firstViewportRow(h.lastFrame() ?? ''));
  });

  it('reports the measured width and the total wrapped line count alongside the position', async () => {
    const { geometry } = mountAt(0, 2, 12);
    await settleFrames();
    const g = geometry();
    expect(g?.totalLines).toBe(40); // every wrapped line, not just the visible window
    expect(g?.height).toBe(10); // 12 rows − 2 live rows
    expect(g?.width).toBeGreaterThan(0);
    expect(g?.left).toBe(0);
  });
});
