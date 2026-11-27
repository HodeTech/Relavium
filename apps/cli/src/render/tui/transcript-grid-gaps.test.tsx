import './force-color.js';

import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import { chatGrid, marginCell } from './chat-grid.js';
import {
  transcriptEntrySpan,
  transcriptRows,
  transcriptScrollGeometry,
  transcriptSelectionText,
} from './chat-projection.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewSeed,
  type TranscriptEntry,
} from './session-view-model.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import type { ToolDisplay } from './tool-display.js';
import {
  createTranscriptAcknowledgement,
  type TranscriptAcknowledgement,
} from './transcript-acknowledgement.js';
import { chatStatusLine } from './chat-status.js';
import { INITIAL_SCROLL } from './scroll.js';
import { mountHostedChat, mountStandaloneChat } from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { TranscriptRow } from './transcript-row.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { TranscriptViewport } from './transcript-viewport.js';
import { displayWidth } from './viewport.js';
import { Box } from 'ink';
import { emitIntro } from './chat-ink.js';
import { effectiveOffset, reduceScroll } from './scroll.js';
import type { ComponentProps, ReactElement } from 'react';
import { attachmentLegend } from './attachment-bar.js';

/**
 * Survivors of the unit 9 mutation round (each was a one-line change of the production code that no test of the increment noticed): the
 * boundaries of the margin cell, the tail of omitted calls, and the three inputs of the transcript's rows that only a row COUNT used to depend on
 * (the tool displays, the colour) in the copy, the span and the inline renderer.
 */

const mounts: InkMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

describe('the margin cell at the edge of its room', () => {
  it('draws a mark that fits exactly: the glyph at column 0 of a 3-column margin, the plain `->` at column 0 of a 4-column one', () => {
    expect(chatGrid(22)).toMatchObject({ margin: 3, markerEnd: 0 });
    expect(marginCell('yourTurn', chatGrid(22), 'glyph')).toBe('›  ');
    expect(marginCell('yourTurn', chatGrid(22), 'ascii')).toBe('>  ');
    expect(chatGrid(24)).toMatchObject({ margin: 4, markerEnd: 1 });
    expect(marginCell('toolCall', chatGrid(24), 'ascii')).toBe('->  ');
  });

  it('draws a word only with a blank column before the content: a word as wide as the margin is not drawn', () => {
    expect(marginCell('yourTurn', chatGrid(22), 'word')).toBe('   '); // `you` in 3 columns
    expect(marginCell('toolCall', chatGrid(24), 'word')).toBe('    '); // `tool` in 4
    expect(marginCell('agent', chatGrid(26), 'word')).toBe('     '); // `agent` in 5
    expect(marginCell('agent', chatGrid(27), 'word')).toBe('     ');
    expect(marginCell('agent', chatGrid(28), 'word')).toBe('agent ');
  });
});

describe('the tail of omitted calls', () => {
  const call = {
    id: 'c',
    toolId: 'read_file',
    resolved: true,
    success: true,
    outcome: 'success' as const,
  };
  it.each([1, 2])(
    'a tool entry that omitted %i call(s) ends with its own unmarked row',
    (omitted) => {
      const rows = transcriptRows(
        [{ role: 'tools', text: '', calls: [call], omitted }],
        chatGrid(80),
        true,
      );
      expect(rows.map((row) => [row.margin ?? null, row.text])).toEqual([
        ['toolCall', 'read_file ✓ completed'],
        [null, `${String(omitted)} omitted calls`],
      ]);
    },
  );

  it('none omitted, or none said: no tail', () => {
    for (const omitted of [0, undefined]) {
      const rows = transcriptRows(
        [{ role: 'tools', text: '', calls: [call], ...(omitted === undefined ? {} : { omitted }) }],
        chatGrid(80),
        true,
      );
      expect(rows.map((row) => row.text)).toEqual(['read_file ✓ completed']);
    }
  });
});

describe('the tool displays and the colour reach every consumer of the rows', () => {
  const tools: TranscriptEntry = {
    role: 'tools',
    text: '',
    calls: [{ id: 'c1', toolId: 'edit_file', resolved: true, success: true, outcome: 'success' }],
  };
  const display: ToolDisplay = {
    callId: 'c1',
    toolId: 'edit_file',
    outcome: 'success',
    target: `src/${'deep/'.repeat(20)}file.ts`,
    stats: { addedLines: 3, removedLines: 1, beforeBytes: 10, afterBytes: 12 },
  };
  const displays = new Map([['c1', display]]);
  const reply: TranscriptEntry = {
    role: 'assistant',
    text: 'A **bold** and `code` line\n\n```\nfenced\n```',
  };
  const WHOLE = { start: { line: 0, column: 0 }, end: { line: 99, column: 999 } };

  it('a tool row carries the target and the stats of its display, wrapped inside the content column', () => {
    const rows = transcriptRows([tools], chatGrid(80), true, displays);
    expect(rows.map((row) => row.text).join('')).toContain('edit_file ✓ completed → src/deep/');
    expect(rows.map((row) => row.text).join('')).toMatch(/file\.ts · \+3 -1$/u);
    expect(rows.length).toBe(3);
    expect(rows.filter((row) => row.margin === 'toolCall')).toHaveLength(1);
  });

  it('drag-copy reads the rows as the screen draws them: with the displays, and in the colour in force', () => {
    const grid = chatGrid(80);
    const copied = transcriptSelectionText([tools], grid, WHOLE, true, displays);
    expect(copied).toContain('edit_file ✓ completed →');
    expect(copied).toMatch(/file\.ts · \+3 -1$/u);
    expect(copied.split('\n')).toHaveLength(3);
    expect(transcriptSelectionText([tools], grid, WHOLE, true)).toBe('edit_file ✓ completed');
    expect(transcriptSelectionText([reply], grid, WHOLE, true)).toBe(
      'A bold and code line\n\n│ fenced',
    );
    expect(transcriptSelectionText([reply], grid, WHOLE, false)).toBe(
      'A **bold** and `code` line\n\n```\nfenced\n```',
    );
  });

  it('the span of an entry counts the rows of the entries before it as drawn: with their displays and in the colour in force', () => {
    const notice: TranscriptEntry = { role: 'notice', text: 'n' };
    const grid = chatGrid(80);
    expect(transcriptEntrySpan([tools, notice], 1, grid, true, displays)).toEqual({
      start: 3,
      end: 4,
    });
    expect(transcriptEntrySpan([tools, notice], 1, grid, true)).toEqual({ start: 1, end: 2 });
    expect(transcriptEntrySpan([reply, notice], 1, grid, true)).toEqual({ start: 3, end: 4 });
    expect(transcriptEntrySpan([reply, notice], 1, grid, false)).toEqual({ start: 5, end: 6 });
  });

  it('the acknowledgement of a notice after such rows reads the colour of the store and the displays the viewport was given', () => {
    const store = createChatStore(
      true,
      { transcript: [reply, tools] },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    const proof = createTranscriptAcknowledgement(() => store);
    const publication = proof.capture();
    store.notice('n');
    publication.published();
    const transcript = store.getSnapshot().state.transcript;
    const rows = transcriptRows(transcript, chatGrid(80), true, displays);
    // colour on: the fenced code takes 1 row (not 3) and the tool row wraps to 3: the notice is the last row
    proof.viewport(transcript, 80, rows.length - 1, rows.length, 80, displays);
    expect(publication.visible()).toBe(true);
    // a window that ends one row before the notice's last row (as a viewer that counts the plain rows or no displays would place it) clears nothing
    proof.viewport(transcript, 80, 0, rows.length - 1, 80, displays);
    expect(publication.visible()).toBe(false);
    // drawn without the displays the notice is nearer the top: a window that holds only the top rows must not clear it
    const bare = transcriptRows(transcript, chatGrid(80), true);
    proof.viewport(transcript, 80, 0, bare.length, 80);
    expect(publication.visible()).toBe(true);
  });

  it('the inline renderer draws the tool row with its display: the target and the stats are in the printed row', async () => {
    const state = {
      ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      transcript: [tools],
    };
    const mount = mountInk(
      <ChatView
        state={state}
        columns={80}
        color={false}
        tick={0}
        nowMs={0}
        editor={emptyEditor()}
        running={false}
        mode="ask"
        reasoningVisible={false}
        toolDisplays={displays}
      />,
      { renderer: 'inline', color: false, size: { cols: 80, rows: 30 } },
    );
    mounts.push(mount);
    await mount.settle();
    const text = mount
      .frame()
      .map((row) => row.trim())
      .join('');
    expect(text).toContain('edit_file ok completed →');
    expect(text).toContain('file.ts · +3 -1');
  });
});

describe('the status line is fitted to what the terminal leaves right of the margin', () => {
  it.each([
    [80, 6],
    [100, 8],
  ])(
    'at %i columns the row is the model of the line at (columns, margin %i), not a narrower one',
    async (cols, margin) => {
      const mount = mountStandaloneChat(
        { renderer: 'alt', color: false, size: { cols, rows: 30 } },
        {
          standalone: { provider: 'anthropic' },
          seed: { model: 'claude-sonnet-4-6-20251101-extended', turnCount: 12, transcript: [] },
          prepare: (store) => {
            store.setReasoningEffort('high');
            store.appendUser('hi');
          },
        },
      );
      mounts.push(mount);
      await mount.settle();
      const rows = mount.frame();
      const rule = rows.findLastIndex((row) => /^ +-+$/u.test(row));
      const facts = { mode: 'ask', reasoningEffort: 'high', provider: 'anthropic' } as const;
      const state = mount.store.getSnapshot().state;
      const expected = chatStatusLine(state, facts, cols, margin).text;
      expect(rows[rule + 1]).toBe(`${' '.repeat(margin)}${expected}`);
      // the line is not one of the narrower budgets a wrong argument would give (the content column's, or the margin counted twice)
      expect(expected).not.toBe(chatStatusLine(state, facts, cols - margin, margin).text);
      if (cols === 80) expect(displayWidth(rows[rule + 1] ?? '')).toBe(80);
    },
  );
});

describe('the mark of a notice the host leads is the notice’s own dim, not the person’s accent', () => {
  it('a question record’s `›` is drawn dim, not bold and not in the accent; the person’s own turn is', async () => {
    const lines = transcriptRows(
      [
        { role: 'user', text: 'a turn' },
        { role: 'notice', text: '› Asked: Scope — which?', hostLead: 'yourTurn' },
      ],
      chatGrid(100),
      true,
    );
    const mount = mountInk(
      <Box flexDirection="column" height={4}>
        <TranscriptViewport lines={lines} grid={chatGrid(100)} color scroll={INITIAL_SCROLL} />
      </Box>,
      { renderer: 'alt', color: true, size: { cols: 100, rows: 4 } },
    );
    mounts.push(mount);
    await mount.settle();
    const cells = mount.cells();
    const mark = (row: number): (typeof cells)[number][number] | undefined =>
      cells[row]?.find((cell) => cell.char === '›');
    const turn = mark(0);
    expect(turn?.style.bold).toBe(true);
    expect(turn?.style.fg).toBeDefined();
    const record = mark(1);
    expect(record, mount.frame().join('\n')).toBeDefined();
    expect(record?.style.bold).toBe(false);
    expect(record?.style.fg).toBeUndefined();
    expect(record?.style.dim).toBe(true);
  });
});

describe('the content cell of a row is exactly the content column wide', () => {
  it('a row wider than the column wraps inside its own cell, and its continuation hangs under a blank margin', async () => {
    const grid = chatGrid(100);
    const mount = mountInk(
      <Box width={100} flexDirection="column">
        <TranscriptRow
          line={{ text: 'x'.repeat(grid.content + 5), style: 'assistant' }}
          grid={grid}
          color={false}
          form="glyph"
        />
      </Box>,
      { renderer: 'alt', color: false, size: { cols: 100, rows: 4 } },
    );
    mounts.push(mount);
    await mount.settle();
    const [first, second] = mount.frame();
    expect(first).toBe(`${' '.repeat(grid.margin)}${'x'.repeat(grid.content)}`);
    expect(second).toBe(`${' '.repeat(grid.margin)}${'x'.repeat(5)}`);
  });
});

describe('the inline scrollback on the grid: where the header and the width come from', () => {
  it('the first entry after the printed header is not a second turn: one blank row (the header’s own) between them', async () => {
    const mount = await mountHostedChat(
      { renderer: 'inline', color: false, size: { cols: 80, rows: 30 } },
      { seed: { initialRestore: true, transcript: [{ role: 'user', text: 'one' }] } },
    );
    mounts.push(mount);
    await mount.settle();
    const rows = mount.frame();
    expect(rows[0]?.trim()).toBe('R  E  L  A  V  I  U  M');
    expect(rows[1]?.trim()).toBe('');
    expect(rows[2], rows.join('\n')).toBe('you   one');
  });

  it('a chat that is not told its width draws the inline rows on the 80-column grid (margin 6), whatever the terminal', async () => {
    const state = {
      ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      transcript: [{ role: 'user', text: 'one' }] as TranscriptEntry[],
    };
    const mount = mountInk(
      <ChatView
        state={state}
        color={false}
        tick={0}
        nowMs={0}
        editor={emptyEditor()}
        running={false}
        mode="ask"
        reasoningVisible={false}
      />,
      { renderer: 'inline', color: false, size: { cols: 120, rows: 30 } },
    );
    mounts.push(mount);
    await mount.settle();
    const frame = mount.frame();
    expect(frame.find((row) => row.endsWith('one'))).toBe('you   one');
    expect(frame.find((row) => /^ +-+$/u.test(row))).toBe(`${' '.repeat(6)}${'-'.repeat(68)}`);
  });
});

describe('the content of a row keeps the style of its kind', () => {
  it('a notice is dim, a summary gray, a hint yellow, a reply and a turn have no colour; colour off writes none', async () => {
    const entries: TranscriptEntry[] = [
      { role: 'user', text: 'turn' },
      {
        role: 'assistant',
        text: 'reply',
        summary: {
          stopReason: 'stop',
          tokensUsed: { input: 1, output: 2 },
          errorCode: 'provider_auth',
        },
      },
      { role: 'notice', text: 'notice' },
    ];
    for (const color of [true, false]) {
      const grid = chatGrid(200);
      const lines = transcriptRows(entries, grid, color);
      const mount = mountInk(
        <Box flexDirection="column" height={lines.length}>
          <TranscriptViewport lines={lines} grid={grid} color={color} scroll={INITIAL_SCROLL} />
        </Box>,
        { renderer: 'alt', color, size: { cols: 200, rows: lines.length } },
      );
      mounts.push(mount);
      await mount.settle();
      const cells = mount.cells();
      const styleOf = (word: string): (typeof cells)[number][number]['style'] | undefined => {
        const row = cells.find((line) =>
          line
            .map((cell) => cell.char)
            .join('')
            .includes(word),
        );
        const at =
          row
            ?.map((cell) => cell.char)
            .join('')
            .indexOf(word) ?? -1;
        return at < 0 ? undefined : row?.[at]?.style;
      };
      const where = mount.frame().join('\n');
      expect(styleOf('reply')?.fg, where).toBeUndefined();
      expect(styleOf('reply')?.dim, where).toBe(false);
      expect(styleOf('turn')?.bold, where).toBe(true);
      if (color) {
        expect(styleOf('notice')?.dim, where).toBe(true);
        expect(styleOf('provider_auth')?.fg, where).toBeDefined(); // the summary: gray
        expect(styleOf('Provider authentication')?.fg, where).toBeDefined(); // the hint: yellow
        expect(styleOf('Provider authentication')?.fg, where).not.toBe(
          styleOf('provider_auth')?.fg,
        );
      } else {
        for (const word of ['notice', 'provider_auth', 'Provider authentication'])
          expect(styleOf(word)?.fg, `${word}\n${where}`).toBeUndefined();
      }
    }
  });
});

describe('the one-line rows have the room the terminal leaves right of the margin, and the chips only the content column', () => {
  it('a warning of 70 columns is drawn whole in the lead row at 80 columns (74 of room), not cut at the content column’s 68', async () => {
    const mount = mountStandaloneChat(
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      { standalone: { provider: 'anthropic' }, prepare: (store) => store.note('w'.repeat(68)) },
    );
    mounts.push(mount);
    await mount.settle();
    const row = mount.frame().find((candidate) => candidate.includes('www')) ?? '';
    expect(displayWidth(row)).toBe(6 + 2 + 68);
    expect(row.endsWith('w'.repeat(68))).toBe(true);
  });

  it('the attachment bar is fitted to the content column: chips that fit 80 columns but not 68 are counted, not drawn', async () => {
    const attachments = (
      length: number,
    ): NonNullable<ComponentProps<typeof ChatView>['attachments']> => [
      { kind: 'file', path: 'x'.repeat(length), content: 'x', sizeBytes: 1 },
    ];
    let length = 1;
    while (displayWidth(attachmentLegend(attachments(length), 1000)) < 72) length += 1;
    const grid = chatGrid(80);
    const mount = mountInk(
      <ChatView
        state={initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND)}
        columns={80}
        color={false}
        tick={0}
        nowMs={0}
        editor={emptyEditor()}
        running={false}
        mode="ask"
        reasoningVisible={false}
        attachments={attachments(length)}
      />,
      { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
    );
    mounts.push(mount);
    await mount.settle();
    const bar = mount.frame().find((row) => row.includes('Esc clears them')) ?? '';
    expect(displayWidth(bar) - grid.margin).toBeLessThanOrEqual(grid.content);
    expect(bar).toContain('1 attachment');
    expect(bar).not.toContain('xxxx');
  });
});

describe.each(['the stand-alone chat', 'the Home-hosted chat'] as const)(
  '%s: a resize re-lays the transcript on the new content column',
  (host) => {
    it('shrinks from 120 to 80 columns and widens back: the drawn rows are the model’s rows at each width', async () => {
      const transcript: TranscriptEntry[] = [
        { role: 'user', text: `turn ${'word '.repeat(40)}end` },
        { role: 'assistant', text: `reply ${'text '.repeat(60)}end` },
      ];
      const variant: Variant = { renderer: 'alt', color: false, size: { cols: 120, rows: 30 } };
      const seed: SessionViewSeed = { initialRestore: true, transcript };
      let size = { cols: 120, rows: 30 };
      const heard = new Set<() => void>();
      const mount =
        host === 'the stand-alone chat'
          ? mountStandaloneChat(variant, { seed })
          : await mountHostedChat(variant, {
              seed,
              hosted: {
                home: {
                  getSize: () => size,
                  subscribeResize: (onResize) => {
                    heard.add(onResize);
                    return () => heard.delete(onResize);
                  },
                },
              },
            });
      mounts.push(mount);
      await mount.settle();
      const drawn = (cols: number): { shown: string[]; model: string[] } => {
        const grid = chatGrid(cols);
        const model = transcriptRows(transcript, grid, false).map((row) => row.text.trimEnd());
        const shown = mount
          .frame()
          .slice(CHAT_HEADER_ROWS, CHAT_HEADER_ROWS + model.length)
          .map((row) => row.slice(grid.margin).trimEnd());
        return { shown, model };
      };
      expect(drawn(120).shown).toEqual(drawn(120).model);
      for (const cols of [80, 100, 120]) {
        size = { cols, rows: 30 };
        mount.resize(cols, 30);
        for (const onResize of heard) onResize();
        await mount.settle();
        const { shown, model } = drawn(cols);
        expect(shown, mount.frame().join('\n')).toEqual(model);
      }
    });
  },
);

describe('the full-screen transcript draws the tool displays it is given, and redraws when they arrive', () => {
  it('a tool row gains its target and stats when its display arrives for the same transcript', async () => {
    const transcript: TranscriptEntry[] = [
      {
        role: 'tools',
        text: '',
        calls: [
          { id: 'c1', toolId: 'edit_file', resolved: true, success: true, outcome: 'success' },
        ],
      },
    ];
    const treeOf = (displays: ReadonlyMap<string, ToolDisplay> | undefined): ReactElement => (
      <Box flexDirection="column" height={20}>
        <ChatView
          state={{ ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND), transcript }}
          columns={100}
          color={false}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          viewport={{ rows: 20, cols: 100, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
          {...(displays === undefined ? {} : { toolDisplays: displays })}
        />
      </Box>
    );
    const mount = mountInk(treeOf(undefined), {
      renderer: 'alt',
      color: false,
      size: { cols: 100, rows: 20 },
    });
    mounts.push(mount);
    await mount.settle();
    expect(mount.frame().join('\n')).toContain('edit_file ok completed');
    expect(mount.frame().join('\n')).not.toContain('src/a.ts');
    mount.rerender(
      treeOf(
        new Map([
          [
            'c1',
            {
              callId: 'c1',
              toolId: 'edit_file',
              outcome: 'success',
              target: 'src/a.ts',
              stats: { addedLines: 3, removedLines: 1, beforeBytes: 1, afterBytes: 2 },
            },
          ],
        ]),
      ),
    );
    await mount.settle();
    expect(mount.frame().join('\n')).toContain('edit_file ok completed → src/a.ts · +3 -1');
  });
});

describe('the acknowledgement lays the transcript out at the columns the frame was drawn for', () => {
  it('a measured width wider than the columns (a box that grew) does not widen the content column the notice is counted in', () => {
    const text = 'w'.repeat(75); // two rows at the 68-column content column of 80 columns, one at the 96 of 120
    const store = createChatStore(
      false,
      { transcript: [{ role: 'user', text: 'q' }] },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    const proof = createTranscriptAcknowledgement(() => store);
    const publication = proof.capture();
    store.notice(text);
    publication.published();
    const transcript = store.getSnapshot().state.transcript;
    const rows = transcriptRows(transcript, chatGrid(80));
    expect(rows.slice(-2).map((row) => row.text.length)).toEqual([68, 7]);
    proof.viewport(transcript, 80, rows.length - 2, rows.length - 1, 120);
    expect(publication.visible()).toBe(false);
    proof.viewport(transcript, 80, rows.length - 2, rows.length, 120);
    expect(publication.visible()).toBe(true);
  });
});

describe('the live region keeps what it is given', () => {
  const CHEVRON = String.fromCodePoint(0x203a);
  const call = (
    id: string,
    resolved: boolean,
  ): NonNullable<ComponentProps<typeof ChatView>['state']>['liveToolCalls'][number] => ({
    id,
    toolId: `tool_${id}`,
    resolved,
    ...(resolved ? { success: true, outcome: 'success' as const } : {}),
  });
  const running = (
    extra: Partial<ComponentProps<typeof ChatView>['state']>,
  ): ComponentProps<typeof ChatView>['state'] => ({
    ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
    status: 'running',
    ...extra,
  });
  async function frameOf(
    state: ComponentProps<typeof ChatView>['state'],
    color: boolean,
    toolDisplays?: ReadonlyMap<string, ToolDisplay>,
  ): Promise<string[]> {
    const mount = mountInk(
      <ChatView
        state={state}
        columns={80}
        color={color}
        tick={0}
        nowMs={0}
        editor={emptyEditor()}
        running
        mode="ask"
        reasoningVisible={false}
        {...(toolDisplays === undefined ? {} : { toolDisplays })}
      />,
      { renderer: 'inline', color, size: { cols: 80, rows: 24 } },
    );
    mounts.push(mount);
    await mount.settle();
    return mount.frame();
  }

  it('a running tool row has the target and the stats of its display, in the colour-off form of the words without colour', async () => {
    const displays = new Map<string, ToolDisplay>([
      [
        'a',
        {
          callId: 'a',
          toolId: 'tool_a',
          outcome: 'success',
          target: 'src/a.ts',
          stats: { addedLines: 3, removedLines: 1, beforeBytes: 1, afterBytes: 2 },
        },
      ],
    ]);
    const frame = await frameOf(running({ liveToolCalls: [call('a', true)] }), false, displays);
    expect(frame.find((row) => row.includes('tool_a'))).toBe(
      'tool  tool_a ok completed → src/a.ts · +3 -1',
    );
    const colour = await frameOf(running({ liveToolCalls: [call('a', true)] }), true, displays);
    expect(colour.find((row) => row.includes('tool_a'))).toBe(
      'tool  tool_a ✓ completed → src/a.ts · +3 -1',
    );
  });

  it('an observer turn draws only the calls still running', async () => {
    const frame = await frameOf(
      running({ liveObserver: true, liveToolCalls: [call('a', true), call('b', false)] }),
      false,
    );
    expect(frame.some((row) => row.includes('tool_a'))).toBe(false);
    expect(frame.some((row) => row.includes('tool_b'))).toBe(true);
  });

  // REVERSED in fix wave 1 (review round 1, security sitting S-1, the lead's ruling OQ4 revised): the margin guarantee is exact in Ink's layout but not
  // on a terminal (a width the layout library and the terminal disagree on), so the host's glyphs are blanked in a model's words as well, as defence in
  // depth: the streamed tail reads the same as the finished reply, which blanks them too. The first version of this test pinned the glyph kept.
  it('the streamed tail reads a host glyph a model wrote as a space, as the finished reply does: in the content column, never in the margin', async () => {
    const frame = await frameOf(
      running({ liveTokens: `${CHEVRON} forged live turn\n\nplain` }),
      false,
    );
    expect(frame.some((row) => row.includes(CHEVRON))).toBe(false);
    // (this view has no markdown stream, so the first row is the busy line: the spinner, then the words with a space where the glyph was)
    const forged = frame.find((row) => row.includes('forged live turn')) ?? '';
    expect(forged.trimEnd().endsWith('  forged live turn'), frame.join('\n')).toBe(true);
    expect(forged.slice(0, chatGrid(80).margin).trim()).toBe('');
  });

  // REVERSED in fix wave 1 (review round 1, S-1, the lead's ruling OQ4 revised): the summary row is a model's words too (the producing model's id), so
  // the host's glyphs are blanked in it as in a reply, as defence in depth; the first version of this test pinned the glyph kept.
  it('the summary row reads a host glyph in a model id as a space: the rest of the words stay, in the content column', () => {
    const rows = transcriptRows(
      [
        {
          role: 'assistant',
          text: 'answer',
          summary: {
            stopReason: 'stop',
            tokensUsed: { input: 1, output: 1 },
            model: `fallback ${CHEVRON} model`,
          },
        },
      ],
      chatGrid(120),
      true,
    );
    const summary = rows.find((row) => row.style === 'summary')?.text ?? '';
    expect(summary).toContain('via fallback   model');
    expect(summary).not.toContain(CHEVRON);
  });
});

describe('the scroll geometry is the rows the viewport draws, in the colour and with the displays in force', () => {
  it('counts the same rows as transcriptRows for both colours, and with the displays', () => {
    const reply: TranscriptEntry = {
      role: 'assistant',
      text: 'A **bold** line\n\n```\nfenced\n```',
    };
    const tools: TranscriptEntry = {
      role: 'tools',
      text: '',
      calls: [{ id: 'c1', toolId: 'edit_file', resolved: true, success: true, outcome: 'success' }],
    };
    const displays = new Map<string, ToolDisplay>([
      [
        'c1',
        {
          callId: 'c1',
          toolId: 'edit_file',
          outcome: 'success',
          target: `src/${'deep/'.repeat(20)}f.ts`,
        },
      ],
    ]);
    const grid = chatGrid(80);
    for (const color of [true, false])
      for (const withDisplays of [true, false]) {
        const shown = withDisplays ? displays : undefined;
        expect(transcriptScrollGeometry([reply, tools], grid, 7, color, shown)).toEqual({
          totalLines: transcriptRows([reply, tools], grid, color, shown).length,
          height: 7,
        });
      }
    expect(transcriptScrollGeometry([reply], grid, 7, true).totalLines).not.toBe(
      transcriptScrollGeometry([reply], grid, 7, false).totalLines,
    );
    expect(transcriptScrollGeometry([tools], grid, 7, true, displays).totalLines).toBeGreaterThan(
      transcriptScrollGeometry([tools], grid, 7, true).totalLines,
    );
  });
});

describe.each(['the stand-alone chat', 'the Home-hosted chat'] as const)(
  '%s: a drag-copy on the full-screen transcript copies what the screen shows',
  (host) => {
    const ALT_COLOUR: Variant = { renderer: 'alt', color: true, size: { cols: 100, rows: 30 } };
    const FIRST_ROW = CHAT_HEADER_ROWS + 1; // the viewport's first row, 1-based

    async function copyOfFirstRow(
      setup: Parameters<typeof mountStandaloneChat>[1],
    ): Promise<string[]> {
      const copied: string[] = [];
      const clipboard = (text: string): { kind: 'written'; characters: number } => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      };
      const mount =
        host === 'the stand-alone chat'
          ? mountStandaloneChat(ALT_COLOUR, { ...setup, standalone: { clipboard } })
          : await mountHostedChat(ALT_COLOUR, {
              ...setup,
              hosted: { home: { props: { clipboard } } },
            });
      mounts.push(mount);
      await mount.settle();
      mount.key(`\u001b[<0;1;${String(FIRST_ROW)}M`);
      await mount.settle();
      mount.key(`\u001b[<32;99;${String(FIRST_ROW)}M`);
      await mount.settle();
      mount.key(`\u001b[<0;99;${String(FIRST_ROW)}m`);
      await mount.settle();
      return copied.map((text) => text.trimEnd());
    }

    it('with colour on the copy is the laid-out reply (markdown applied), not its source', async () => {
      const copied = await copyOfFirstRow({
        seed: {
          initialRestore: true,
          transcript: [{ role: 'assistant', text: 'A **bold** and `code` line' }],
        },
      });
      expect(copied).toEqual(['A bold and code line']);
    });

    it('a tool row is copied with the target and the stats of its display', async () => {
      const copied = await copyOfFirstRow({
        seed: {
          initialRestore: true,
          transcript: [
            {
              role: 'tools',
              text: '',
              calls: [
                {
                  id: 'call',
                  toolId: 'write_file',
                  resolved: true,
                  success: true,
                  outcome: 'success',
                },
              ],
            },
          ],
        },
        prepare: (store) =>
          store.applyToolLiveEvent({
            phase: 'preview',
            callId: 'call',
            toolId: 'write_file',
            preview: { kind: 'operation', target: 'src/a.ts', fields: [] },
          }),
      });
      expect(copied).toEqual(['write_file … → src/a.ts']);
    });
  },
);

describe('the viewport tells the acknowledgement what it drew', () => {
  it('the columns it was laid for, the width it measured and the displays it drew with', async () => {
    const calls: Parameters<TranscriptAcknowledgement['viewport']>[] = [];
    const acknowledgement: TranscriptAcknowledgement = {
      clearViewport: () => {},
      capture: () => ({ published: () => {}, visible: () => true }),
      inlineNotice: () => {},
      viewport: (...args) => {
        calls.push(args);
      },
    };
    const transcript: TranscriptEntry[] = [
      {
        role: 'tools',
        text: '',
        calls: [
          { id: 'c1', toolId: 'edit_file', resolved: true, success: true, outcome: 'success' },
        ],
      },
    ];
    const displays = new Map<string, ToolDisplay>([
      ['c1', { callId: 'c1', toolId: 'edit_file', outcome: 'success', target: 'src/a.ts' }],
    ]);
    const mount = mountInk(
      <Box flexDirection="column" height={20}>
        <ChatView
          state={{ ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND), transcript }}
          columns={100}
          color={false}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          toolDisplays={displays}
          acknowledgement={acknowledgement}
          viewport={{ rows: 20, cols: 100, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
        />
      </Box>,
      { renderer: 'alt', color: false, size: { cols: 100, rows: 20 } },
    );
    mounts.push(mount);
    await mount.settle();
    const last = calls.at(-1);
    expect(last, 'the viewport reported').toBeDefined();
    expect(last?.[0]).toBe(transcript);
    expect(last?.[1]).toBe(100); // the terminal's columns: the acknowledgement lays the grid out from them
    expect(last?.[4]).toBe(100); // the width the viewport's box measured
    expect(last?.[5]).toBe(displays);
  });
});

describe.each(['the stand-alone chat', 'the Home-hosted chat'] as const)(
  '%s: the scroll geometry is exactly the rows drawn, to the column, in the colour and with the displays in force',
  (host) => {
    it.each([true, false])(
      'PgUp lands on the model’s window: rows of exactly the content width, fenced code, wrapped tool rows (colour %s)',
      async (color) => {
        const SIZE = { cols: 100, rows: 30 };
        const content = chatGrid(SIZE.cols).content; // 84
        // exactly `content` columns: one row at 84, two at 83 or fewer
        const exact = `${'w'.repeat(40)} ${'v'.repeat(content - 41)}`;
        expect(exact.length).toBe(content);
        const transcript: TranscriptEntry[] = Array.from({ length: 12 }, (_unused, index) => [
          { role: 'user' as const, text: exact },
          {
            role: 'assistant' as const,
            text: `${exact}\n\n\`\`\`\nfenced ${String(index)}\n\`\`\``,
          },
          {
            role: 'tools' as const,
            text: '' as const,
            calls: [
              {
                id: `c${String(index)}`,
                toolId: 'write_file',
                resolved: true,
                success: true,
                outcome: 'success' as const,
              },
            ],
          },
        ]).flat();
        const variant: Variant = { renderer: 'alt', color, size: SIZE };
        const setup = {
          seed: { initialRestore: true, transcript } satisfies SessionViewSeed,
          prepare: (store: ChatStoreController): void => {
            for (let index = 0; index < 12; index += 1)
              store.applyToolLiveEvent({
                phase: 'preview',
                callId: `c${String(index)}`,
                toolId: 'write_file',
                preview: {
                  kind: 'operation',
                  target: `${'long-directory/'.repeat(8)}file-${String(index)}.txt`,
                  fields: [],
                },
              });
          },
        };
        const mount =
          host === 'the stand-alone chat'
            ? mountStandaloneChat(variant, setup)
            : await mountHostedChat(variant, setup);
        mounts.push(mount);
        await mount.settle();
        const grid = chatGrid(SIZE.cols);
        const displays = mount.store.getSnapshot().toolDisplays;
        const model = transcriptRows(transcript, grid, color, displays).map((row) =>
          row.text.trimEnd(),
        );
        // the three inputs are not no-ops here: each changes the number of rows
        expect(model.length).not.toBe(transcriptRows(transcript, grid, color).length);
        expect(model.length).not.toBe(transcriptRows(transcript, grid, !color, displays).length);
        expect(model.length).not.toBe(
          transcriptRows(transcript, chatGrid(SIZE.cols - 6), color, displays).length,
        );
        const height = SIZE.rows - 1 - CHAT_HEADER_ROWS - 5;
        const geometry = { totalLines: model.length, height };
        const drawn = (): string[] =>
          mount
            .frame()
            .slice(CHAT_HEADER_ROWS, CHAT_HEADER_ROWS + height)
            .map((row) => row.slice(grid.margin).trimEnd());
        mount.key('\u001b[5~'); // PgUp
        await mount.settle();
        const offset = effectiveOffset(reduceScroll(INITIAL_SCROLL, 'page-up', geometry), geometry);
        expect(drawn()).toEqual(model.slice(offset, offset + height));
      },
    );
  },
);

describe('the inline intro', () => {
  const ports = (written: string[]): Parameters<typeof emitIntro>[2] => ({
    notice: () => {},
    writeOut: (text) => void written.push(text),
    columns: 80,
  });

  it('the plain form of the switch (`<->`) leaves the sentence for the model switch’s word, as the glyph does', () => {
    const written: string[] = [];
    emitIntro('<-> model changed a -> b', false, ports(written));
    expect(written).toEqual([
      `${marginCell('modelSwitch', chatGrid(80), 'word')}model changed a -> b\n`,
    ]);
  });

  it('a terminal with no room for the word keeps the glyph where it was: the lead is never lost', () => {
    const written: string[] = [];
    emitIntro('⇄ model changed a → b', false, { ...ports(written), columns: 24 });
    expect(written.join('')).toContain('⇄ model changed');
  });
});

describe('the in-flight turn above a docked sheet keeps what the live region keeps', () => {
  const TRIANGLE = String.fromCodePoint(0x25b8);
  const call = (id: string): ComponentProps<typeof ChatView>['state']['liveToolCalls'][number] => ({
    id,
    toolId: id,
    resolved: true,
    success: true,
    outcome: 'success',
  });
  async function docked(
    toolId: string,
    color: boolean,
    displays?: ReadonlyMap<string, ToolDisplay>,
  ): Promise<InkMount> {
    const mount = mountInk(
      <Box flexDirection="column" height={24}>
        <ChatView
          state={{
            ...initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND),
            status: 'running',
            liveToolCalls: [call(toolId)],
          }}
          columns={100}
          color={color}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running
          mode="ask"
          reasoningVisible={false}
          cardDocked
          terminalRows={24}
          viewport={{ rows: 24, cols: 100, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
          {...(displays === undefined ? {} : { toolDisplays: displays })}
        />
      </Box>,
      { renderer: 'alt', color, size: { cols: 100, rows: 24 } },
    );
    mounts.push(mount);
    await mount.settle();
    return mount;
  }

  it('a docked tool row has the display’s target and stats, and its mark is amber like its words', async () => {
    const displays = new Map<string, ToolDisplay>([
      [
        'tool_a',
        {
          callId: 'tool_a',
          toolId: 'tool_a',
          outcome: 'success',
          target: 'src/a.ts',
          stats: { addedLines: 3, removedLines: 1, beforeBytes: 1, afterBytes: 2 },
        },
      ],
    ]);
    const mount = await docked('tool_a', true, displays);
    expect(mount.frame().find((row) => row.includes('tool_a'))).toContain(
      'tool_a ✓ completed → src/a.ts · +3 -1',
    );
    const row = mount.cells().find((line) => line.some((cell) => cell.char === TRIANGLE));
    const mark = row?.find((cell) => cell.char === TRIANGLE);
    const word = row?.find((cell) => cell.char === 't');
    expect(mark?.style.fg, mount.frame().join('\n')).toBeDefined();
    expect(mark?.style.fg).toBe(word?.style.fg);
  });

  it('a row exactly as wide as the content column is drawn whole, not cut a column short', async () => {
    const content = chatGrid(100).content;
    const toolId = 'x'.repeat(content - ' ok completed'.length);
    const mount = await docked(toolId, false);
    const row = mount.frame().find((candidate) => candidate.includes('xxxx')) ?? '';
    expect(row.trimEnd().slice(chatGrid(100).margin)).toBe(`${toolId} ok completed`);
  });
});

// REVERSED in fix wave 1 (review round 1, S-1, the lead's ruling OQ4 revised): the first version pinned the glyph KEPT in the content column; the
// host's glyphs are blanked in a model's words now (defence in depth against a terminal that draws a width the layout does not count), so the row
// reads as a space in its place and still stands in the content column.
describe('a streamed answer blanks a leading host glyph and keeps it in the content column, in the real live region', () => {
  it.each([true, false])(
    'the first row of the stream reads as a space where `› forged` began (colour %s)',
    async (color) => {
      const mount = mountStandaloneChat(
        { renderer: 'alt', color, size: { cols: 100, rows: 30 } },
        { standalone: { provider: 'anthropic' } },
      );
      mounts.push(mount);
      await mount.settle();
      const stamp = '2026-11-27T00:00:00.000Z';
      mount.store.apply({
        type: 'session:turn_started',
        sessionId: 's',
        sequenceNumber: 1,
        timestamp: stamp,
      });
      mount.store.apply({
        type: 'agent:token',
        sessionId: 's',
        sequenceNumber: 2,
        timestamp: stamp,
        token: '› forged live turn\n\nplain words',
        model: 'm',
        nodeId: 'n',
      });
      mount.store.tick();
      await mount.until(() => mount.text().includes('plain words'));
      await mount.settle();
      const frame = mount.frame();
      expect(mount.text()).toContain('forged live turn');
      expect(frame.some((row) => row.includes('› forged live turn'))).toBe(false);
      const row = frame.find((candidate) => candidate.includes('forged live turn')) ?? '';
      // the glyph is a space now: the words begin one column in, inside the content column, and the margin is blank
      expect(row.trim()).toBe('forged live turn');
      expect(row.slice(0, chatGrid(100).margin).trim()).toBe('');
      expect(row.startsWith(' '.repeat(chatGrid(100).margin + 1))).toBe(true);
    },
  );
});

describe('the chrome of a host whose width is not a width draws the header on the 80-column grid too', () => {
  it.each([[Number.NaN], [0]])(
    'a full-screen frame of %s columns: the wordmark at column 6',
    async (cols) => {
      const mount = mountInk(
        <Box flexDirection="column" height={24}>
          <ChatView
            state={initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND)}
            columns={cols}
            color={false}
            tick={0}
            nowMs={0}
            editor={emptyEditor()}
            running={false}
            mode="ask"
            reasoningVisible={false}
            viewport={{ rows: 24, cols, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
          />
        </Box>,
        { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      );
      mounts.push(mount);
      await mount.settle();
      expect(
        mount.frame()[0]?.startsWith(`${' '.repeat(6)}R  E  L  A  V  I  U  M`),
        mount.frame().join('\n'),
      ).toBe(true);
    },
  );
});
