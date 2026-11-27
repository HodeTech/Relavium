import { afterEach, describe, expect, it } from 'vitest';

import type { NoticeFlush } from '../../engine/effect-retention.js';
import { chatGrid } from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { effectiveOffset, INITIAL_SCROLL, reduceScroll } from './scroll.js';
import type { TranscriptEntry } from './session-view-model.js';
import { mountStandaloneChat } from './surface-matrix/chat-host.js';
import { physicalRows } from './terminal-wrap.test-support.js';
import { displayWidth } from './viewport.js';

/**
 * The full-screen transcript keeps ONE row = ONE physical row (MVP-11 unit 9, review round 3, R3S-1, the sitting's probe as committed tests): the
 * viewport counts its rows (the scroll geometry, the measured-frame acknowledgement), so a row that grew past the content column after the layout
 * (the screen's filter used to run after it: a decomposed Thai AM, a joiner after an indicator, one column each) wrapped into a physical row the
 * count did not know, the bottom rows fell off the frame, and the acknowledgement cleared a notice that was NOT on the screen (the resume path's
 * effect disclosure is acknowledged this way: fail-open). Now the filter runs before the layout and the full-screen cell clips; these hold that
 * the flush resolves only with the notice on the frame, for ordinary Thai, Lao, indicators that are not flags and runs of flags, colour on and off.
 */

const THAI = 'กำลังทำงานอยู่ คำถามนี้สำคัญ น้ำค่ำ ทำไมจึงจำได้ ';
const LAO = 'ຄຳຖາມນີ້ສຳຄັນ ກຳລັງເຮັດວຽກ ';
const RI_PAIR = `${String.fromCodePoint(0x1f1e6)}${String.fromCodePoint(0x1f1e7)}`;
const FLAGS = `${String.fromCodePoint(0x1f1fa, 0x1f1f8)}${String.fromCodePoint(0x1f1f9, 0x1f1f7)}`;
const FILL = Array.from({ length: 12 }, (_, i) => `plain line ${String(i)}`).join('\n');

const BODIES: readonly (readonly [string, string])[] = [
  [
    'Thai paragraphs',
    Array.from({ length: 6 }, (_, i) => `ย่อหน้า ${String(i)} ${THAI.repeat(4)}`).join('\n\n'),
  ],
  [
    'Lao paragraphs',
    Array.from({ length: 6 }, (_, i) => `ວັກ ${String(i)} ${LAO.repeat(5)}`).join('\n\n'),
  ],
  [
    'indicators that are not a flag',
    Array.from(
      { length: 6 },
      (_, i) => `para ${String(i)} ${`${RI_PAIR.repeat(3)} word `.repeat(10)}`,
    ).join('\n\n'),
  ],
  [
    'runs of flags',
    Array.from(
      { length: 6 },
      (_, i) => `para ${String(i)} ${`${FLAGS.repeat(4)} word `.repeat(8)}`,
    ).join('\n\n'),
  ],
  // the sitting's minimal cases: one row of 67 columns and one character the old filter widened after the layout
  ['one row ending in an indicator pair', `${FILL}\n${'a'.repeat(67)}${RI_PAIR}`],
  ['one row ending in a Thai AM', `${FILL}\n${'a'.repeat(67)}กำ`],
  ['the plain control', `${FILL}\n${'a'.repeat(68)}`],
];

const mounts: { readonly unmount: () => void }[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

describe.each([true, false])(
  'the effect-disclosure flush on the full screen, 80×24 (colour %s)',
  (color) => {
    it.each(BODIES)('%s: the flush resolves with the notice on the frame', async (_name, body) => {
      let flush: NoticeFlush | undefined;
      const mount = mountStandaloneChat(
        { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
        {
          seed: {
            initialRestore: true,
            transcript: [
              { role: 'user', text: 'q' },
              { role: 'assistant', text: `${body}\nEND-OF-REPLY` },
            ],
          },
          standalone: {
            onActivated: (published) => {
              flush = published;
            },
          },
        },
      );
      mounts.push(mount);
      await mount.until(() => flush !== undefined);
      await mount.settle();
      const notice = 'EFFECT-DISCLOSURE-NOTICE';
      let resolved = false;
      await flush?.(() => {
        mount.store.notice(notice);
      }).then(() => {
        resolved = true;
      });
      await mount.settle();
      const frame = mount.frame();
      // what the acknowledgement claims is what the screen shows: resolved ⇒ the notice is on the frame
      expect(resolved).toBe(true);
      expect(frame.join('\n'), frame.join('\n')).toContain(notice);
      // and the frame is the model's rows, one physical row each: no row of the transcript is wider than the content column
      const grid = chatGrid(80);
      for (const row of transcriptRows(mount.store.getSnapshot().state.transcript, grid, color))
        expect(displayWidth(row.text), row.text).toBeLessThanOrEqual(grid.content);
      expect(physicalRows(frame, 80)).toHaveLength(frame.length);
    });
  },
);

describe('a Thai transcript on the full screen: the keys reach every row (review round 3, R3S-1)', () => {
  const TRANSCRIPT: readonly TranscriptEntry[] = Array.from({ length: 8 }, (_, index) => [
    { role: 'user' as const, text: `turn ${String(index)}` },
    { role: 'assistant' as const, text: `${THAI.repeat(5)} end of reply ${String(index)}` },
  ]).flat();
  const SIZE = { cols: 80, rows: 24 };
  const HEIGHT = SIZE.rows - 1 - CHAT_HEADER_ROWS - 5;
  const ESC = String.fromCharCode(0x1b);

  it.each([true, false])(
    'PgUp to the top and PgDn back to the end draw the model’s rows (colour %s)',
    async (color) => {
      const mount = mountStandaloneChat(
        { renderer: 'alt', color, size: SIZE },
        { seed: { initialRestore: true, transcript: TRANSCRIPT } },
      );
      mounts.push(mount);
      await mount.until(() => mount.frame().join('\n').includes('end of reply 7'));
      await mount.settle();
      const grid = chatGrid(SIZE.cols);
      const model = transcriptRows(mount.store.getSnapshot().state.transcript, grid, color).map(
        (row) => row.text.trimEnd(),
      );
      const geometry = { totalLines: model.length, height: HEIGHT };
      const drawn = (): string[] =>
        mount
          .frame()
          .slice(CHAT_HEADER_ROWS, CHAT_HEADER_ROWS + HEIGHT)
          .map((row) => row.slice(grid.margin).trimEnd());
      const seen = new Set<number>();
      let scroll = INITIAL_SCROLL;
      const check = (): void => {
        const offset = effectiveOffset(scroll, geometry);
        expect(drawn()).toEqual(model.slice(offset, offset + HEIGHT));
        for (let at = offset; at < Math.min(model.length, offset + HEIGHT); at += 1) seen.add(at);
      };
      check();
      for (let page = 0; page < 12; page += 1) {
        mount.key(`${ESC}[5~`);
        await mount.settle();
        scroll = reduceScroll(scroll, 'page-up', geometry);
        check();
      }
      for (let page = 0; page < 12; page += 1) {
        mount.key(`${ESC}[6~`);
        await mount.settle();
        scroll = reduceScroll(scroll, 'page-down', geometry);
        check();
      }
      expect(seen.size).toBe(model.length);
      expect(drawn().join('\n')).toContain('end of reply 7');
    },
  );
});

describe('the live tail is laid out from the filtered stream (review round 3, R3S-1: the filter runs on the stream before its layout)', () => {
  const STAMP = '2026-11-27T00:00:00.000Z';

  it.each([true, false])(
    'a Thai and flag reply streamed in small chunks: no row of the tail is cut at the cell (colour %s)',
    async (color) => {
      const mount = mountStandaloneChat({ renderer: 'alt', color, size: { cols: 80, rows: 30 } });
      mounts.push(mount);
      await mount.settle();
      mount.store.apply({
        type: 'session:turn_started',
        sessionId: 's',
        sequenceNumber: 1,
        timestamp: STAMP,
      });
      const reply = `${THAI.repeat(3)}${FLAGS.repeat(6)} ${THAI.repeat(2)}${RI_PAIR.repeat(5)} tail-end words`;
      const units = [...reply];
      let sequence = 2;
      for (let at = 0; at < units.length; at += 3) {
        mount.store.apply({
          type: 'agent:token',
          sessionId: 's',
          sequenceNumber: sequence,
          timestamp: STAMP,
          token: units.slice(at, at + 3).join(''),
          model: 'm',
          nodeId: 'n',
        });
        sequence += 1;
      }
      mount.store.flush();
      await mount.until(() => mount.text().includes('tail-end'));
      await mount.settle();
      const frame = mount.frame();
      // the full-screen cell cuts a row wider than the content column with an ellipsis: a row laid out from the filtered stream is never cut
      expect(
        frame.filter((row) => row.includes('…')),
        frame.join('\n'),
      ).toEqual([]);
      expect(physicalRows(frame, 80)).toHaveLength(frame.length);
    },
  );
});

describe('the second layer: a full-screen live row the layout gave too much is cut at its cell, never wrapped (review round 3, R3S-1)', () => {
  it.each([true, false])('a tail row wider than the content column, colour %s', async (color) => {
    const { Box } = await import('ink');
    const { ChatView } = await import('./chat-ink.js');
    const { emptyEditor } = await import('./chat-input.js');
    const { initialSessionViewState, FULLSCREEN_TRANSCRIPT_BOUND } =
      await import('./session-view-model.js');
    const { mountInk } = await import('./surface-matrix/mount.js');
    const wide = [{ text: 'w'.repeat(100), spans: [{ text: 'w'.repeat(100) }] }];
    const markdown = {
      tail: () => wide,
      plainTail: () => wide,
      sourceTail: () => 'w',
      elided: false,
    };
    const mount = mountInk(
      <Box flexDirection="column" height={24}>
        <ChatView
          state={{
            ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
            status: 'running',
            liveTokens: 'w',
          }}
          markdown={markdown}
          columns={80}
          color={color}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running
          mode="ask"
          reasoningVisible={false}
          terminalRows={24}
          viewport={{ rows: 23, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
        />
      </Box>,
      { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
    );
    mounts.push(mount);
    await mount.settle();
    const frame = mount.frame();
    const rows = frame.filter((row) => row.includes('w'.repeat(10)));
    expect(rows, frame.join('\n')).toHaveLength(1);
    expect(rows[0]?.trimEnd().endsWith('…')).toBe(true);
  });
});
