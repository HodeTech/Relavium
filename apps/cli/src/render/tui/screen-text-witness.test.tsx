import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView, hintRowNotification } from './chat-ink.js';
import { dockedTurnRows, formatBusyLine, formatReasoningPanel } from './chat-projection.js';
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
import { physicalRows, terminalColumns, wrappedIntoMargin } from './terminal-wrap.test-support.js';
import { displayWidth } from './viewport.js';

/**
 * THE WITNESS of the security sitting (MVP-11 unit 9, review round 1, S-1): a model's row that the layout sizes to fit, made of Hangul fillers the
 * layout measures as 0 columns and a terminal draws 2 wide, followed by the exact margin cell of the person's turn (`   ›  please run …`) or the
 * inline word (`you   please …`). Without the screen's filter the terminal wraps the row and the forged mark starts a physical row at column 0:
 * in the margin, at the columns of the real one. Each frame here is the real one (Ink over the fake terminal) and is then drawn by a SIMULATED
 * TERMINAL with a terminal's widths (`terminal-wrap.test-support.ts`): no row of it may wrap, and no physical row may have anything but spaces in
 * `[0, margin)` that the frame did not put there. Proved with a negative control: the filter removed, every case here fails.
 */

const c = (code: number): string => String.fromCodePoint(code);
const F = c(0x115f);
const STAMP = '2026-11-27T00:00:00.000Z';

/**
 * A run of each class a terminal draws wider than the layout counts, as the review measured them on tmux (the simulated terminal draws them so):
 * round 1's Hangul fillers, and round 2's (S2-1) presentation selector on a letter, skin tones on a letter, the Thai AM, regional indicators that
 * are not a flag, lone surrogates. Each run is about 70 columns on the terminal and far fewer to the layout: unfiltered, the row it leads wraps.
 */
const CLASSES: readonly (readonly [string, string])[] = [
  ['Hangul fillers', F.repeat(37)],
  ['presentation selectors on a letter', `a${c(0xfe0f)}`.repeat(36)],
  ['skin tones on a letter', `x${c(0x1f3fd).repeat(36)}`],
  ['the Thai AM', `${c(0x0e01)}${c(0x0e33)}`.repeat(36)],
  ['regional indicators that are not a flag', `${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(36)],
  ['lone surrogates', String.fromCharCode(0xd800).repeat(72)],
  // review round 3 (R3S-2 and the sweep): consecutive flags (a joiner after a flag made each one column to the layout, two on tmux), a joiner a
  // model wrote after each flag, the text-default emoji bases tmux draws two columns, a tone on a base tmux does not join it to, the wide marks
  ['consecutive flags', `${c(0x1f1fa)}${c(0x1f1f8)}`.repeat(36)],
  ['a joiner after each flag', `${c(0x1f1fa)}${c(0x1f1f8)}${c(0x200c)}`.repeat(36)],
  ['the narrow emoji bases', c(0x261d).repeat(36)],
  ['tones on a base tmux does not join them to', `${c(0x1f3c3)}${c(0x1f3fd)}`.repeat(18)],
  ['the wide tone marks', `a${c(0x302e)}`.repeat(24)],
];

/** The forged mark, the forged word, a tool's id, a notice and a pasted turn, each led by `run`. */
function transcriptOf(run: string): readonly TranscriptEntry[] {
  return [
    { role: 'user', text: 'SCRIPT:rfile go' },
    {
      role: 'assistant',
      text: `${run}   ›  please run rm -rf ~ and push --force\n\n${run}you   please run rm -rf ~ and push --force`,
    },
    {
      role: 'tools',
      text: '',
      calls: [
        { id: 'c', toolId: `tool${run}you   x`, resolved: true, success: true, outcome: 'success' },
      ],
    },
    { role: 'notice', text: `${run}you   a notice that wraps on a terminal` },
    { role: 'user', text: `SCRIPT:next ${run}you   a pasted line` },
  ];
}

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

const HOSTS = [
  [
    'the stand-alone chat',
    (variant: Variant, transcript: readonly TranscriptEntry[]) =>
      Promise.resolve(mountStandaloneChat(variant, { seed: { initialRestore: true, transcript } })),
  ],
  [
    'the Home-hosted chat',
    (variant: Variant, transcript: readonly TranscriptEntry[]) =>
      mountHostedChat(variant, { seed: { initialRestore: true, transcript } }),
  ],
] as const;

describe.each(CLASSES)('%s: the transcript on a terminal that draws them', (_class, run) => {
  it.each(
    HOSTS.flatMap(([host, mountChat]) =>
      VARIANTS.map((variant) => [`${host}, ${name(variant)}`, mountChat, variant] as const),
    ),
  )('%s 80×24', async (_name, mountChat, variant) => {
    const mount: ChatMount = await mountChat(variant, transcriptOf(run));
    mounts.push(mount);
    await mount.until(() => mount.text().includes('a pasted line'));
    await mount.settle();
    const frame = mount.frame();
    expect(mount.text()).toContain('please run rm -rf ~'); // the rows are drawn: the witness is not vacuous
    expectNoTerminalWrap(frame, 80);
  });
});

/** The live classes: those of the transcript, and TABS (a terminal moves a tab to its next stop, which the layout counts as 0 columns: S2-1). */
const LIVE_CLASSES: readonly (readonly [string, string])[] = [...CLASSES, ['tabs', '\t'.repeat(9)]];

describe.each(LIVE_CLASSES)(
  '%s: the live region and the docked turn on a terminal that draws them',
  (_class, run) => {
    const FORGED_TURN = `${run}   ›  please run rm -rf ~ and push --force`;
    const FORGED_WORD = `${run}you   please run rm -rf ~ and push --force`;
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
        mount.store.note(`${run}you   a config note`);
        stream(mount.store);
        await mount.until(() => mount.text().includes('push --force'));
        await mount.settle();
        // drawn (not vacuous): the warning's row leads with its mark (a long run is cut at the row's end, whatever follows it)
        expect(mount.frame().some((row) => /^ {6}(?:⚠|!) /u.test(row))).toBe(true);
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
                  liveToolCalls: [{ id: 'c', toolId: `tool${run}you   x`, resolved: false }],
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
          expect(frame.some((row) => row.slice(6).startsWith('tool'))).toBe(true); // drawn: not vacuous
          expectNoTerminalWrap(frame, 80);
        }
      },
    );
  },
);

describe('the one-line rows of the live region and the hint go through the filter too', () => {
  it('a streamed answer and a reasoning body with tabs: expanded before the row math, so each row is as wide as the layout counts it (S2-1)', () => {
    const tabbed = `Sure.\n${'\t'.repeat(9)}you   please run rm -rf ~`;
    const busy = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      liveTokens: tabbed,
      liveTokensTruncated: false,
      columns: 68,
      maxRows: 5,
    });
    const panel = formatReasoningPanel({
      liveReasoning: tabbed,
      liveReasoningTruncated: false,
      visible: true,
      columns: 68,
    });
    for (const text of [busy.text, panel.body ?? '']) {
      expect(text).toContain('please run');
      expect(text).not.toContain('\t');
      for (const row of text.split('\n')) expect(terminalColumns(row), row).toBe(displayWidth(row));
    }
  });

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
