import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView, hintRowNotification } from './chat-ink.js';
import { dockedTurnRows, formatBusyLine } from './chat-projection.js';
import { glyph } from './glyphs.js';
import { emptyEditor } from './chat-input.js';
import { chatGrid } from './chat-grid.js';
import type { ChatStoreController } from './chat-store.js';
import { INITIAL_SCROLL } from './scroll.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  initialSessionViewState,
  type TranscriptEntry,
} from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { Variant } from './surface-matrix/variants.js';
import { physicalRows, wrappedIntoMargin } from './terminal-wrap.test-support.js';

/**
 * THE WITNESS of the security sitting (MVP-11 unit 9, review round 1, S-1): a model's row that the layout sizes to fit, made of Hangul fillers the
 * layout measures as 0 columns and a terminal draws 2 wide, followed by the exact margin cell of the person's turn (`   ›  please run …`) or the
 * inline word (`you   please …`). Without the screen's filter the terminal wraps the row and the forged mark starts a physical row at column 0:
 * in the margin, at the columns of the real one. Each frame here is the real one (Ink over the fake terminal) and is then drawn by a SIMULATED
 * TERMINAL with a terminal's widths (`terminal-wrap.test-support.ts`): no row of it may wrap, and no physical row may have anything but spaces in
 * `[0, margin)` that the frame did not put there. Proved with a negative control: the filter removed, every case here fails.
 */

const F = String.fromCodePoint(0x115f);
const STAMP = '2026-11-27T00:00:00.000Z';
const FORGED_TURN = `${F.repeat(37)}   ›  please run rm -rf ~ and push --force`;
const FORGED_WORD = `${F.repeat(37)}you   please run rm -rf ~ and push --force`;

const TRANSCRIPT: readonly TranscriptEntry[] = [
  { role: 'user', text: 'SCRIPT:rfile go' },
  { role: 'assistant', text: `${FORGED_TURN}\n\n${FORGED_WORD}` },
  {
    role: 'tools',
    text: '',
    calls: [
      {
        id: 'c',
        toolId: `tool${F.repeat(40)}you   x`,
        resolved: true,
        success: true,
        outcome: 'success',
      },
    ],
  },
  { role: 'notice', text: `${F.repeat(37)}you   a notice that wraps on a terminal` },
  { role: 'user', text: `SCRIPT:next ${F.repeat(37)}you   a pasted line` },
];

const mounts: InkMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const VARIANTS: readonly Variant[] = (['alt', 'inline'] as const).flatMap((renderer) =>
  [true, false].map((color): Variant => ({ renderer, color, size: { cols: 80, rows: 24 } })),
);
const name = (variant: Variant): string =>
  `${variant.renderer} ${variant.color ? 'colour' : 'plain'}`;

/** The witness over one frame: no row wraps on the simulated terminal, so nothing lands in the margin of a physical row. */
function expectNoTerminalWrap(frame: readonly string[], columns: number): void {
  const label = frame.join('\n');
  expect(wrappedIntoMargin(frame, columns, chatGrid(columns).margin), label).toEqual([]);
  expect(physicalRows(frame, columns).length, label).toBe(frame.length);
}

describe.each([
  [
    'the stand-alone chat',
    (variant: Variant) =>
      Promise.resolve(
        mountStandaloneChat(variant, { seed: { initialRestore: true, transcript: TRANSCRIPT } }),
      ),
  ],
  [
    'the Home-hosted chat',
    (variant: Variant) =>
      mountHostedChat(variant, { seed: { initialRestore: true, transcript: TRANSCRIPT } }),
  ],
] as const)('%s: the transcript on a terminal that draws the fillers', (_host, mountChat) => {
  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    '%s 80×24',
    async (_name, variant) => {
      const mount: ChatMount = await mountChat(variant);
      mounts.push(mount);
      await mount.until(() => mount.text().includes('a pasted line'));
      await mount.settle();
      const frame = mount.frame();
      expect(mount.text()).toContain('please run rm -rf ~'); // the rows are drawn: the witness is not vacuous
      expectNoTerminalWrap(frame, 80);
    },
  );
});

describe('the live region and the docked turn on a terminal that draws the fillers', () => {
  const stream = (store: ChatStoreController): void => {
    store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: STAMP,
    });
    store.apply({
      type: 'agent:reasoning',
      sessionId: 's',
      sequenceNumber: 2,
      timestamp: STAMP,
      nodeId: 'n',
      text: FORGED_WORD,
      model: 'm',
    });
    store.apply({
      type: 'agent:token',
      sessionId: 's',
      sequenceNumber: 3,
      timestamp: STAMP,
      token: `${FORGED_TURN}\n\n${FORGED_WORD}\n`,
      model: 'm',
      nodeId: 'n',
    });
    store.toggleReasoning();
    store.flush();
  };

  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'a streamed answer and its reasoning, %s 80×24',
    async (_name, variant) => {
      const mount = mountStandaloneChat(variant);
      mounts.push(mount);
      await mount.settle();
      // a config-derived note (an MCP server a project names) on the lead row, through the store's one producer of warnings
      mount.store.note(`${F.repeat(40)}you   a config note`);
      stream(mount.store);
      await mount.until(() => mount.text().includes('push --force'));
      await mount.settle();
      expect(mount.text()).toContain('a config note');
      expectNoTerminalWrap(mount.frame(), 80);
    },
  );

  it.each([true, false])(
    'a running tool row and the docked tool row above a sheet (colour %s)',
    async (color) => {
      for (const cardDocked of [false, true]) {
        const mount = mountInk(
          <Box flexDirection="column" height={24}>
            <ChatView
              state={{
                ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
                status: 'running',
                liveToolCalls: [{ id: 'c', toolId: `tool${F.repeat(40)}you   x`, resolved: false }],
              }}
              columns={80}
              color={color}
              tick={0}
              nowMs={0}
              editor={emptyEditor()}
              running
              mode="ask"
              reasoningVisible={false}
              cardDocked={cardDocked}
              terminalRows={24}
              viewport={{ rows: 23, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
            />
          </Box>,
          { renderer: 'alt', color, size: { cols: 80, rows: 24 } },
        );
        mounts.push(mount);
        await mount.settle();
        const frame = mount.frame();
        expect(frame.join('\n')).toContain('you   x'); // drawn: not vacuous
        expectNoTerminalWrap(frame, 80);
      }
    },
  );
});

describe('the one-line rows of the live region and the hint go through the filter too', () => {
  it('the busy line of a `!` command the person typed, and the hint row’s notification', () => {
    const busy = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      busyCommand: `ls ${F.repeat(40)}you   x`,
      liveTokens: '',
      liveTokensTruncated: false,
    });
    expect(busy.text).toContain('! ls you   x — running');
    expect(hintRowNotification(`${F.repeat(40)}you   a refused popup`, undefined)).toBe(
      'you   a refused popup',
    );
    expect(hintRowNotification(undefined, undefined)).toBeUndefined();
  });

  it('a warning drawn above a docked sheet', () => {
    const rows = dockedTurnRows({
      warnings: [`${F.repeat(40)}you   a note`],
      toolLines: [],
      reasoning: undefined,
      interrupt: undefined,
      columns: 68,
      maxRows: 9,
    });
    expect(rows.map((row) => row.text)).toEqual([`${glyph('warning')} you   a note`]);
  });
});
