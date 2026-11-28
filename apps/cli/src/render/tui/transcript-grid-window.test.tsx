import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid } from './chat-grid.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { transcriptRows } from './chat-projection.js';
import { effectiveOffset, INITIAL_SCROLL, reduceScroll } from './scroll.js';
import type { TranscriptEntry } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';

/**
 * The window the full-screen transcript draws is the grid's rows (MVP-11 unit 9, plan §3.1): the viewport's memo, the scroll geometry the keys
 * reduce against and the copy all lay the transcript out at the SAME content column (`transcriptRows`, `chatGrid` of the host's columns). A
 * memo at another width draws rows the geometry does not count (a long row wraps inside its cell into rows the window never budgeted), and a
 * geometry at another width scrolls to an offset the viewport does not draw; both show the person rows other than the ones the model holds.
 * These read the drawn frame of both hosts at rest and after one `PgUp`, and compare it with the model's rows at the offset the reducer gives.
 */

const ESC = String.fromCharCode(0x1b);
const PG_UP = `${ESC}[5~`;

/** Rows that wrap differently at every content width a terminal of 100 to 200 columns gives (84 and 96), so a width mix-up is visible. */
const TRANSCRIPT: readonly TranscriptEntry[] = Array.from({ length: 12 }, (_, index) => [
  { role: 'user' as const, text: `turn ${index} ${'q'.repeat(80)} end of turn ${index}` },
  { role: 'assistant' as const, text: `reply ${index} ${'r'.repeat(86)} end of reply ${index}` },
]).flat();

const mounts: ChatMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const SIZE = { cols: 100, rows: 30 };
/** The transcript's rows at rest at 100×30: the frame (29 rows) less the header (2) and the prompt block (5). */
const HEIGHT = SIZE.rows - 1 - CHAT_HEADER_ROWS - 5;

describe.each([
  [
    'the stand-alone chat',
    (color: boolean) =>
      Promise.resolve(
        mountStandaloneChat(
          { renderer: 'alt', color, size: SIZE },
          { seed: { initialRestore: true, transcript: TRANSCRIPT } },
        ),
      ),
  ],
  [
    'the Home-hosted chat',
    (color: boolean) =>
      mountHostedChat(
        { renderer: 'alt', color, size: SIZE },
        { seed: { initialRestore: true, transcript: TRANSCRIPT } },
      ),
  ],
] as const)('%s at 100×30', (_host, mountChat) => {
  it.each([true, false])(
    'draws the model’s rows at rest and after a page up (colour %s)',
    async (color) => {
      const mount = await mountChat(color);
      mounts.push(mount);
      await mount.until(() => mount.frame().join('\n').includes('end of reply 11'));
      await mount.settle();
      const grid = chatGrid(SIZE.cols);
      const model = transcriptRows(mount.store.getSnapshot().state.transcript, grid, color).map(
        (row) => row.text.trimEnd(),
      );
      const drawn = (): string[] =>
        mount
          .frame()
          .slice(CHAT_HEADER_ROWS, CHAT_HEADER_ROWS + HEIGHT)
          .map((row) => row.slice(grid.margin).trimEnd());
      const geometry = { totalLines: model.length, height: HEIGHT };
      const window = (offset: number): string[] => model.slice(offset, offset + HEIGHT);
      expect(drawn()).toEqual(window(effectiveOffset(INITIAL_SCROLL, geometry)));
      mount.key(PG_UP);
      await mount.settle();
      const paged = reduceScroll(INITIAL_SCROLL, 'page-up', geometry);
      expect(drawn()).toEqual(window(effectiveOffset(paged, geometry)));
    },
  );
});
