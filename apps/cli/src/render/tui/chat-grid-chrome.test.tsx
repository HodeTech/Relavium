import './force-color.js';

import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { Box } from 'ink';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid, marginCell, type ChatGrid } from './chat-grid.js';
import { ChatView } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { chatPaletteRows } from './palette-view.js';
import { marginFormFor } from './margin-row.js';
import { INITIAL_SCROLL } from './scroll.js';
import { initialSessionViewState, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import { mountInk, type InkMount } from './surface-matrix/mount.js';
import { sheetTranscriptRows } from './tool-review-card.js';
import type { MentionReader } from './mention.js';
import type { Variant } from './surface-matrix/variants.js';
import { WORDMARK } from './home-layout.js';
import { displayWidth } from './viewport.js';

/**
 * The chat's CHROME on the grid (MVP-11 unit 9, plan section 3.2): the header, the prompt block (the editor, the rule, the status line, the hint, the
 * lead row, the palette, the attachment bar) and the live region (a tool call's row, the reasoning panel, the streamed answer, the busy line) stand in the
 * content column of the grid ({@link chatGrid}: a margin of 6 columns at 80 and 8 from 100, a content column of 68, 84 and 96), and the margin to their
 * left belongs to the host: no word a person or a model wrote can stand in it. Read from the DRAWN frame of both hosts (`relavium chat` and the chat the
 * Home hosts), both renderers, colour on and off, at 80×24, 100×30 and 120×40.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 40 },
] as const;

const VARIANTS: readonly Variant[] = (['alt', 'inline'] as const).flatMap((renderer) =>
  [true, false].flatMap((color) => SIZES.map((size): Variant => ({ renderer, color, size }))),
);

const name = (variant: Variant): string =>
  `${variant.renderer} · ${variant.color ? 'colour' : 'no colour'} · ${String(variant.size.cols)}×${String(variant.size.rows)}`;

/** The host marks used in the hostile strings: the person's marker, the tool's, the model switch's, a quote, and the inline role words. */
const CHEVRON = String.fromCodePoint(0x203a);
const TRIANGLE = String.fromCodePoint(0x25b8);
const SWITCH = String.fromCodePoint(0x21c4);
const HOSTILE = `${CHEVRON} you said ${TRIANGLE} tool ${SWITCH} model > agent`;

async function mountIn(host: Host, variant: Variant, setup: ChatSetup = {}): Promise<ChatMount> {
  const full: ChatSetup = {
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
    ...setup,
  };
  const mount =
    host === 'chat' ? await mountHostedChat(variant, full) : mountStandaloneChat(variant, full);
  await mount.settle();
  return mount;
}

let seq = 1;
const event = (body: Record<string, unknown>): SessionStreamHandleEvent =>
  ({
    sessionId: 'matrix-session',
    sequenceNumber: seq++,
    timestamp: '2026-11-27T09:00:00.000Z',
    ...body,
  }) as SessionStreamHandleEvent;

const turnStarted = (): SessionStreamHandleEvent => event({ type: 'session:turn_started' });
const toolCall = (toolId: string): SessionStreamHandleEvent =>
  event({
    type: 'agent:tool_call',
    nodeId: 'relavium-chat',
    model: 'm',
    toolId,
    toolInput: {},
  });
const toolResult = (toolId: string): SessionStreamHandleEvent =>
  event({
    type: 'agent:tool_result',
    nodeId: 'relavium-chat',
    toolId,
    success: true,
    outputSummary: 'ok',
  });
const token = (text: string): SessionStreamHandleEvent =>
  event({ type: 'agent:token', nodeId: 'relavium-chat', model: 'm', token: text });
const reasoning = (text: string): SessionStreamHandleEvent =>
  event({ type: 'agent:reasoning', nodeId: 'relavium-chat', text });

/** The grid of a variant, the form its margin is drawn in, and the margin cell of a tool call's row. */
function gridOf(variant: Variant): {
  readonly grid: ChatGrid;
  readonly toolCell: string;
} {
  const grid = chatGrid(variant.size.cols);
  const form = marginFormFor(variant.renderer === 'alt', variant.color);
  return { grid, toolCell: marginCell('toolCall', grid, form) };
}

/** A running turn whose every row of the live region is the model's own: reasoning, two tool calls (one finished), and a streamed answer. */
function startTurn(m: ChatMount, answer: string, tools: readonly string[]): void {
  seq = 1;
  m.store.apply(turnStarted());
  m.store.apply(reasoning(`${HOSTILE} the model is thinking about it`));
  tools.forEach((tool, index) => {
    m.store.apply(toolCall(tool));
    if (index < tools.length - 1) m.store.apply(toolResult(tool));
  });
  m.store.apply(token(answer));
  m.store.tick();
}

const blank = (cell: string): boolean => cell.trim() === '';

/** The rows of the frame whose margin is not blank, with the cell that stands in it. */
function markedRows(
  frame: readonly string[],
  grid: ChatGrid,
): { readonly row: string; readonly cell: string; readonly index: number }[] {
  return frame.flatMap((row, index) => {
    const cell = row.slice(0, grid.margin).padEnd(grid.margin);
    return blank(cell) ? [] : [{ row, cell, index }];
  });
}

describe.each(HOSTS)('the idle chat on the grid, in the %s host', (host) => {
  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'draws the prompt block in the content column: the prompt at its first column, the rule as wide as the content, the status line and the hint after the margin (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const margin = ' '.repeat(grid.margin);
        const rule = frame.findLastIndex((row) => /^ +[-─]+$/u.test(row));
        expect(rule, shown).toBeGreaterThan(0);
        // the rule is exactly the content column: starts after the margin, ends at the rail's last column
        expect(frame[rule]?.slice(0, grid.margin), shown).toBe(margin);
        expect(displayWidth(frame[rule] ?? ''), shown).toBe(grid.margin + grid.content);
        // the prompt row above it: the prompt's glyph at the content column, then a space, then the invitation
        expect(frame[rule - 1], shown).toMatch(
          new RegExp(`^ {${String(grid.margin)}}[>›] type a message`, 'u'),
        );
        // the status line under it starts at the content column and fits what the terminal leaves right of the margin
        const status = frame[rule + 1] ?? '';
        expect(status.startsWith(`${margin}anthropic · `), shown).toBe(true);
        expect(displayWidth(status) - grid.margin, shown).toBeLessThanOrEqual(grid.text);
        // the hint under that, at the content column, the last row of the frame
        expect(frame[rule + 2], shown).toMatch(
          new RegExp(`^ {${String(grid.margin)}}\\[/\\] commands`, 'u'),
        );
        expect(frame, shown).toHaveLength(rule + 3);
        // the leading row is blank
        expect(frame[rule - 2]?.trim(), shown).toBe('');
      } finally {
        m.unmount();
      }
    },
  );

  it.each(
    VARIANTS.filter((variant) => variant.renderer === 'alt').map(
      (variant) => [name(variant), variant] as const,
    ),
  )(
    'puts the wordmark at the content column and ends the session title at its last column, in a frame whose margin is blank (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, {
        prepare: (store) => store.appendUser(`${HOSTILE} plan the work`),
      });
      try {
        const frame = m.frame();
        const shown = frame.join('\n');
        expect(frame[0]?.startsWith(`${' '.repeat(grid.margin)}${WORDMARK}`), shown).toBe(true);
        // the title ends where the content column ends, so the row is `margin + content` wide
        expect(displayWidth((frame[0] ?? '').trimEnd()), shown).toBe(grid.margin + grid.content);
        // nothing a person wrote stands in the margin of either header row (the first user line is the title)
        expect((frame[0] ?? '').slice(0, grid.margin).trim(), shown).toBe('');
        expect(frame[1]?.trim(), shown).toBe('');
        expect(frame[0], 'the title carries no host glyph').not.toContain(TRIANGLE);
        expect(frame[0], 'the title carries no host glyph').not.toContain(SWITCH);
      } finally {
        m.unmount();
      }
    },
  );
});

describe.each(HOSTS)('the margin of the chat is the host’s, in the %s host', (host) => {
  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'a running turn of hostile words has a blank margin on every row but its tool calls’ own: one mark per call, none from the text (%s)',
    async (_label, variant) => {
      const { grid, toolCell } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        const tools = [`${CHEVRON} read_file`, `${TRIANGLE}${SWITCH} write_file`];
        startTurn(m, `${HOSTILE} and a streamed answer that goes on for a while.`, tools);
        m.store.note(`${HOSTILE} a warning`);
        m.notifications.notify(`${HOSTILE} a notification`, undefined, 'mode');
        await m.until(() => m.text().includes('streamed answer'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        expect(m.text(), shown).toContain('write_file');
        const marked = markedRows(frame, grid);
        expect(
          marked.map((row) => row.cell),
          `only the tool calls' rows are marked, each with the table's mark in the margin\n${shown}`,
        ).toEqual(tools.map(() => toolCell));
        // the call's words stand in the content column, right after the mark's cell, and a glyph the model named was blanked from them
        for (const { row } of marked)
          expect(row.slice(grid.margin), shown).toMatch(/^\s*(?:read_file|write_file)\b/u);
        // every other row: nothing but spaces in the margin, whatever the row says
        for (const row of frame)
          if (!marked.some((mark) => mark.row === row))
            expect(row.slice(0, grid.margin).trim(), `${row}\n${shown}`).toBe('');
      } finally {
        m.unmount();
      }
    },
  );

  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'a hostile draft, an open palette with a hostile query and a hostile history search leave the margin blank (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        m.key(HOSTILE);
        await m.until(() => m.text().includes('agent'));
        const draft = m.frame();
        expect(markedRows(draft, grid), draft.join('\n')).toEqual([]);
        // clear the draft with Ctrl+C, then open the palette and type a hostile query into it
        m.key('\u0003');
        await m.until(() => !m.text().includes('agent'));
        m.key('/');
        await m.until(() => m.text().includes('Enter run'));
        m.key(`${CHEVRON}${TRIANGLE}`);
        await m.settle();
        const palette = m.frame();
        expect(markedRows(palette, grid), palette.join('\n')).toEqual([]);
      } finally {
        m.unmount();
      }
    },
  );
});

describe.each(HOSTS)('the live region of the chat, in the %s host', (host) => {
  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'draws a tool call’s mark in the margin and its words in the content column, and hangs a long call under its own first row (%s)',
    async (_label, variant) => {
      const { grid, toolCell } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        const long = `a_very_long_tool_name_${'that_goes_on_'.repeat(8)}and_on`;
        startTurn(m, 'the answer', ['read_file', long]);
        await m.until(() => m.text().includes('and_on'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const first = frame.findIndex((row) => row.startsWith(toolCell));
        expect(first, shown).toBeGreaterThanOrEqual(0);
        // the first call: mark, then its words from the content column
        expect(frame[first], shown).toMatch(
          new RegExp(`^${escape(toolCell)}read_file .*completed`, 'u'),
        );
        // the long call: its mark, and the rest of it hangs on rows with a blank margin, every row inside the content column
        const second = first + 1;
        expect(frame[second]?.startsWith(toolCell), shown).toBe(true);
        let at = second;
        const words: string[] = [];
        do {
          const row = frame[at] ?? '';
          expect(
            displayWidth(row) - grid.margin,
            `row ${String(at)}\n${shown}`,
          ).toBeLessThanOrEqual(grid.content);
          words.push(row.slice(grid.margin).trim());
          at += 1;
        } while (
          (frame[at] ?? '').startsWith(' '.repeat(grid.margin)) &&
          !blank(frame[at] ?? '') &&
          words.join('').length < long.length
        );
        expect(words.join('')).toContain(long.slice(0, 40));
        // the form of the mark: the glyph (its ASCII form without colour) full-screen, the role word inline
        if (variant.renderer === 'inline') expect(toolCell.trim(), shown).toBe('tool');
        else expect(toolCell.trim(), shown).toBe(variant.color ? TRIANGLE : '->');
      } finally {
        m.unmount();
      }
    },
  );

  it.each(VARIANTS.map((variant) => [name(variant), variant] as const))(
    'draws the reasoning panel, the streamed answer, the busy line and the interrupt note in the content column, none wider than it (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        startTurn(m, `${'word '.repeat(60)}end.`, []);
        m.store.toggleReasoning();
        await m.until(() => m.text().includes('Reasoning'));
        m.key('\u0003'); // the first Ctrl+C interrupts the turn and arms: the `Interrupting` note stands above the prompt block
        await m.until(() => m.text().includes('Interrupting'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const live = frame.flatMap((row, index) =>
          /Reasoning|word|Esc stops|Interrupting|thinking/u.test(row) ? [index] : [],
        );
        expect(live.length, shown).toBeGreaterThan(3);
        for (const index of live) {
          const row = frame[index] ?? '';
          expect(row.slice(0, grid.margin).trim(), `${row}\n${shown}`).toBe('');
          expect(displayWidth(row) - grid.margin, `${row}\n${shown}`).toBeLessThanOrEqual(
            grid.content,
          );
        }
        // the busy line: the spinner stays in the content string, after the margin
        const busy = frame.find((row) => row.includes('Esc stops'));
        expect(busy?.startsWith(' '.repeat(grid.margin)), shown).toBe(true);
        expect(busy?.slice(grid.margin).startsWith(' '), shown).toBe(false);
      } finally {
        m.unmount();
      }
    },
  );

  it.each(
    (['alt', 'inline'] as const).flatMap((renderer) =>
      [true, false].map(
        (color) => [`${renderer} ${color ? 'colour' : 'no colour'}`, renderer, color] as const,
      ),
    ),
  )(
    'wraps the streamed answer as the finished reply wraps: the same rows before and after the turn completes (%s)',
    async (_label, renderer, color) => {
      const variant: Variant = { renderer, color, size: { cols: 80, rows: 24 } };
      const m = await mountIn(host, variant);
      try {
        const answer =
          'Add a TAX_RATE constant to billing and apply it once in total(), keeping the public ' +
          'signature of the function as it is; then run the existing tests for the invoice module ' +
          'and update the two fixtures that hard-code the old totals, one by one, with the rate.';
        startTurn(m, answer, []);
        await m.until(() => m.text().includes('Esc stops'));
        await m.settle();
        const grid = chatGrid(80);
        const content = (frame: readonly string[]): string[] =>
          frame.map((row) => row.slice(grid.margin).trimEnd());
        const before = content(m.frame());
        const stop = before.findIndex((row) => row.includes('Esc stops'));
        // the streamed rows: the rows above the busy line that carry the answer (it is the only thing but the header above it)
        const start = before.findIndex((row) => row.includes('Add a TAX_RATE'));
        expect(start, before.join('\n')).toBeGreaterThanOrEqual(0);
        const live = before.slice(start, stop).filter((row) => row !== '');
        expect(live.length, before.join('\n')).toBeGreaterThan(2);
        // complete the turn: the reply lands in the transcript, wrapped by the transcript's own layout
        m.store.apply(
          event({
            type: 'session:turn_completed',
            stopReason: 'stop',
            tokensUsed: { input: 1, output: 1 },
          }),
        );
        await m.until(() => !m.text().includes('Esc stops'));
        await m.settle();
        const after = content(m.frame());
        const first = after.findIndex((row) => row.includes('Add a TAX_RATE'));
        expect(first, after.join('\n')).toBeGreaterThanOrEqual(0);
        const finished = after.slice(first, first + live.length);
        expect(
          finished,
          `the reply wraps where the stream did\n${before.join('\n')}\n---\n${after.join('\n')}`,
        ).toEqual(live);
        // and no row of either is wider than the content column
        for (const row of [...live, ...finished])
          expect(row.length).toBeLessThanOrEqual(grid.content);
      } finally {
        m.unmount();
      }
    },
  );
});

describe.each(HOSTS)('the palette over a chat, in the %s host, on the grid', (host) => {
  it.each(
    VARIANTS.filter((variant) => variant.renderer === 'alt').map(
      (variant) => [name(variant), variant] as const,
    ),
  )(
    'draws the list, the typed query and the rule in the content column, cut inside it, and the legend on the hint row (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        m.key('/');
        await m.until(() => m.text().includes('Enter run'));
        m.key('x'.repeat(120));
        await m.settle();
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const margin = ' '.repeat(grid.margin);
        const rule = frame.findLastIndex((row) => /^ +[-─]+$/u.test(row));
        expect(frame[rule], shown).toBe(
          `${margin}${(variant.color ? '─' : '-').repeat(grid.content)}`,
        );
        // the legend is the hint row: the last row, at the content column
        expect(frame.at(-1), shown).toBe(`${margin}Esc close`);
        // every row of the block, from the typed query down to the legend, is inside the content column: the long query wrapped there
        const query = frame.findIndex((row) =>
          row.startsWith(`${margin}${variant.color ? '›' : '>'} /xxx`),
        );
        expect(query, shown).toBeGreaterThan(0);
        for (let index = query; index <= rule; index += 1) {
          expect(
            displayWidth(frame[index] ?? '') - grid.margin,
            `row ${String(index)}\n${shown}`,
          ).toBeLessThanOrEqual(grid.content);
          expect(frame[index]?.slice(0, grid.margin).trim(), shown).toBe('');
        }
      } finally {
        m.unmount();
      }
    },
  );

  it.each(
    VARIANTS.filter((variant) => variant.renderer === 'alt').map(
      (variant) => [name(variant), variant] as const,
    ),
  )(
    'keeps the row budget of the palette: its list, the prompt, the rule and the hint row take what chatPaletteRows says, in the content column (%s)',
    async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        m.key('/');
        await m.until(() => m.text().includes('Enter run'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.join('\n');
        const margin = ' '.repeat(grid.margin);
        const entries = frame.filter((row) => /^ +(?:[>›]|\s) \/[a-z]+ {2,}\S/u.test(row));
        const markers = frame.filter((row) => /^ +[▲▼^v] \d+ more/u.test(row));
        for (const row of [...entries, ...markers])
          expect(row.startsWith(margin), shown).toBe(true);
        // the block is the list (entries and markers), the prompt, the rule and the hint row: `maxRows` of them at most
        const budget = chatPaletteRows(variant.size.rows, {
          rows: Array.from({ length: 22 }, () => ({ groupStart: false })) as never,
        });
        expect(entries.length + markers.length + 3, shown).toBeLessThanOrEqual(budget);
        expect(frame, shown).toHaveLength(variant.size.rows - 1);
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the editor on the grid', () => {
  const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
  const ALT_100: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };

  it.each([
    ['80×24', ALT_80],
    ['100×30', ALT_100],
  ] as const)(
    'cuts a long one-line draft at the content column and keeps the cursor on the screen, in at most the editor’s bound (%s)',
    async (_label, variant) => {
      const grid = chatGrid(variant.size.cols);
      const m = mountStandaloneChat(variant, { standalone: { provider: 'anthropic' } });
      try {
        await m.settle();
        const draft = Array.from({ length: 160 }, (_unused, index) => `w${String(index)}`).join(
          ' ',
        );
        m.key(`\u001b[200~${draft}\u001b[201~`);
        await m.until(() => m.text().includes('w159'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.join('\n');
        const rule = frame.findLastIndex((row) => /^ +-+$/u.test(row));
        const cursorRows = m
          .cells()
          .flatMap((row, index) => (row.some((cell) => cell.style.inverse) ? [index] : []));
        expect(cursorRows, shown).toHaveLength(1);
        expect(cursorRows[0], shown).toBeLessThan(rule);
        // the editor's rows: from the first row that holds draft words down to the rule, each inside the content column, none more than the bound
        const editor = frame.slice(0, rule).filter((row) => /w\d+/u.test(row) || /more/u.test(row));
        expect(editor.length, shown).toBeLessThanOrEqual(8);
        for (const row of editor) {
          expect(displayWidth(row) - grid.margin, shown).toBeLessThanOrEqual(grid.content);
          expect(row.slice(0, grid.margin).trim(), shown).toBe('');
        }
        expect(frame, shown).toHaveLength(variant.size.rows - 1);
        // the whole draft is still what is sent: the window is the drawing's
        m.key('\r');
        await m.until(() => m.submitted.length > 0);
        expect(m.submitted[0]).toBe(draft);
      } finally {
        m.unmount();
      }
    },
  );

  it('moves the cursor across a wrap at the content column: the cell is on the row the text is on, one per frame', async () => {
    const grid = chatGrid(ALT_80.size.cols);
    const m = mountStandaloneChat(ALT_80, { standalone: { provider: 'anthropic' } });
    try {
      await m.settle();
      m.key('a'.repeat(grid.content - 3));
      await m.until(() => m.text().includes('a'.repeat(grid.content - 3)));
      for (const typed of ['b', 'c', 'd', 'e', 'f']) {
        m.key(typed);
        await m.until(() => m.text().includes(typed));
        const cursors = m
          .cells()
          .flatMap((row, index) => (row.some((cell) => cell.style.inverse) ? [index] : []));
        expect(cursors, m.text()).toHaveLength(1);
      }
      // every row of the draft is inside the content column
      const rows = m.frame().filter((row) => /a{20}|[bcdef]{2}/u.test(row));
      for (const row of rows)
        expect(displayWidth(row) - grid.margin, m.text()).toBeLessThanOrEqual(grid.content);
    } finally {
      m.unmount();
    }
  });
});

describe('the attachment bar on the grid', () => {
  const mounted: InkMount[] = [];
  afterEach(() => {
    for (const mount of mounted.splice(0)) mount.unmount();
  });

  it.each(SIZES.map((size) => [`${String(size.cols)}×${String(size.rows)}`, size] as const))(
    'is a row of the content column, fitted to its width whatever the chips say (%s)',
    async (_label, size) => {
      const variant: Variant = { renderer: 'inline', color: false, size };
      const grid = chatGrid(size.cols);
      const mount = mountInk(
        <ChatView
          state={initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND)}
          columns={size.cols}
          color={false}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          attachments={[
            { kind: 'file', path: `src/${'deep/'.repeat(20)}file.ts`, content: 'x', sizeBytes: 1 },
            {
              kind: 'command',
              cmd: {
                command: 'npm',
                args: ['run', 'test', '--', '--long-argument-name'.repeat(6)],
              },
              exitCode: 0,
              stdout: '',
              stderr: '',
            },
          ]}
        />,
        variant,
      );
      mounted.push(mount);
      await mount.settle();
      const frame = mount.frame();
      const shown = frame.join('\n');
      const bar = frame.findIndex((row) => row.includes('Esc clears them'));
      expect(bar, shown).toBeGreaterThanOrEqual(0);
      expect(frame[bar]?.startsWith(' '.repeat(grid.margin)), shown).toBe(true);
      expect(frame[bar]?.[grid.margin], shown).not.toBe(' ');
      expect(displayWidth(frame[bar] ?? '') - grid.margin, shown).toBeLessThanOrEqual(grid.content);
      // it stands directly above the prompt row
      expect(frame[bar + 1], shown).toMatch(
        new RegExp(`^ {${String(grid.margin)}}> type a message`, 'u'),
      );
    },
  );
});

describe.each(HOSTS)('no row of the chat is wider than the terminal, in the %s host', (host) => {
  it.each([16, 19, 20, 29, 30, 40, 60, 80, 100, 120, 200])(
    'at %i columns, a running turn, an open palette and a long draft fit (alternate and inline, colour on and off)',
    async (cols) => {
      for (const renderer of ['alt', 'inline'] as const) {
        for (const color of [true, false]) {
          const variant: Variant = { renderer, color, size: { cols, rows: 24 } };
          // a running turn of hostile words
          const running = await mountIn(host, variant, { prepare: (s) => s.notice('A notice.') });
          try {
            startTurn(running, `${HOSTILE} ${'word '.repeat(40)}`, ['read_file', 'x'.repeat(100)]);
            running.store.note(`${HOSTILE} a warning`);
            await running.until(() => running.text().includes('word'));
            await running.settle();
            for (const row of running.frame())
              expect(displayWidth(row), `${name(variant)}: ${row}`).toBeLessThanOrEqual(cols);
          } finally {
            running.unmount();
          }
          // an open palette over a long draft's query, and a long draft
          const idle = await mountIn(host, variant, { prepare: (s) => s.notice('A notice.') });
          try {
            idle.key(`\u001b[200~${'w '.repeat(100)}\u001b[201~`);
            await idle.until(() => idle.text().includes('w w'));
            await idle.settle();
            for (const row of idle.frame())
              expect(displayWidth(row), `${name(variant)}: ${row}`).toBeLessThanOrEqual(cols);
          } finally {
            idle.unmount();
          }
        }
      }
    },
  );
});

describe.each(HOSTS)(
  'the in-flight turn above a docked sheet, in the %s host, on the grid',
  (host) => {
    const FILE: ToolApprovalRequest = {
      toolId: 'edit_file',
      action: 'fs_write',
      preview: { path: 'src/app.ts' },
      unredactedPreview: { path: 'src/app.ts' },
    };

    it.each(
      VARIANTS.filter((variant) => variant.size.cols !== 120).map(
        (variant) => [name(variant), variant] as const,
      ),
    )(
      'draws a tool call’s mark in the margin and every other row in the content column, in the rows the sheet leaves the conversation (%s)',
      async (_label, variant) => {
        const { grid, toolCell } = gridOf(variant);
        const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
        try {
          const tools = [`${CHEVRON} read_file`, 'a_second_tool'];
          startTurn(m, 'the answer', tools);
          m.store.note(`${HOSTILE} a warning`);
          m.store.toggleReasoning();
          m.key('\u0003'); // the first Ctrl+C: the `Interrupting` note stays above the sheet
          await m.until(() => m.text().includes('Interrupting'));
          m.store
            .requestApproval(FILE, true, undefined, {
              callId: 'c1',
              preview: editedFilePreview(100, { 5: 'five', 90: 'ninety' }),
            })
            .catch(() => {});
          await m.until(() => m.text().includes('Approval needed'));
          await m.settle();
          const frame = m.frame();
          const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
          const sheet = frame.findIndex((row) => /^(?:==|━━) Approval needed/u.test(row));
          expect(sheet, shown).toBeGreaterThan(2);
          const above = frame.slice(0, sheet);
          // the turn's rows above the sheet: the tool calls' marks, and nothing else in the margin
          expect(
            markedRows(above, grid).map((row) => row.cell),
            shown,
          ).toEqual(tools.map(() => toolCell));
          for (const row of above) {
            expect(displayWidth(row), shown).toBeLessThanOrEqual(variant.size.cols);
            if (!row.startsWith(toolCell) || toolCell.trim() === '')
              expect(row.slice(0, grid.margin).trim(), `${row}\n${shown}`).toBe('');
          }
          // the rows are the content column's: the warning, the reasoning and the interrupt note are there, none wider than the column
          for (const word of ['a warning', 'Reasoning', 'Interrupting']) {
            const row = above.find((candidate) => candidate.includes(word));
            expect(row, `${word}\n${shown}`).toBeDefined();
            expect(displayWidth(row ?? '') - grid.margin, shown).toBeLessThanOrEqual(grid.content);
          }
          // the budget does not move: the conversation keeps its rows above the sheet (9 at 80×24 and 100×30), alternate screen
          if (variant.renderer === 'alt')
            expect(sheet, shown).toBe(2 + sheetTranscriptRows(variant.size.rows));
        } finally {
          m.unmount();
        }
      },
    );
  },
);

describe.each(HOSTS)('the room of the one-line rows of the chat, in the %s host', (host) => {
  it.each([[80], [100]] as const)(
    'gives the hint row and the notification what the terminal leaves right of the margin, not the content column’s: at %i columns',
    async (cols) => {
      const grid = chatGrid(cols);
      const variant: Variant = { renderer: 'alt', color: false, size: { cols, rows: 24 } };
      const m = await mountIn(host, variant, { prepare: (store) => store.notice('A notice.') });
      try {
        const room = 'n'.repeat(grid.text);
        // a notification as long as the room is drawn whole; one more column is cut by the terminal's edge of the row, by one character
        m.notifications.notify(room, undefined, 'mode');
        await m.until(() => m.text().includes('nnnn'));
        await m.settle();
        const row = m.frame().findLast((candidate) => candidate.includes('nnnn')) ?? '';
        expect(row, m.text()).toBe(`${' '.repeat(grid.margin)}${room}`);
        expect(grid.text, 'the hint row has more room than the content column').toBeGreaterThan(
          grid.content,
        );
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the chrome of a host that has no usable width, or no height', () => {
  const mounted: InkMount[] = [];
  afterEach(() => {
    for (const mount of mounted.splice(0)) mount.unmount();
  });

  function viewOf(
    columns: number | undefined,
    draft: string,
    variant: Variant,
    color = false,
  ): InkMount {
    const mount = mountInk(
      <ChatView
        state={initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND)}
        {...(columns === undefined ? {} : { columns })}
        color={color}
        tick={0}
        nowMs={0}
        editor={{ text: draft, cursor: draft.length }}
        running={false}
        mode="ask"
        reasoningVisible={false}
      />,
      variant,
    );
    mounted.push(mount);
    return mount;
  }

  it.each([[Number.NaN], [0], [Number.POSITIVE_INFINITY], [-5]])(
    'draws the 80-column grid for a width that is not a width (%s): never a rule it cannot draw',
    async (columns) => {
      const mount = viewOf(columns, '', {
        renderer: 'inline',
        color: false,
        size: { cols: 80, rows: 24 },
      });
      await mount.settle();
      const frame = mount.frame();
      const grid = chatGrid(80);
      const rule = frame.find((row) => /^ +-+$/u.test(row));
      expect(rule, frame.join('\n')).toBe(`${' '.repeat(grid.margin)}${'-'.repeat(grid.content)}`);
    },
  );

  it.each([[80], [100], [120]])(
    'wraps the draft of a host that does not know its height at the content column, exactly as the editor cuts it (%i columns)',
    async (columns) => {
      const grid = chatGrid(columns);
      const draft = Array.from({ length: 80 }, (_unused, index) => `w${String(index)}`).join(' ');
      const mount = viewOf(columns, draft, {
        renderer: 'inline',
        color: false,
        size: { cols: columns, rows: 60 },
      });
      await mount.settle();
      const frame = mount.frame();
      const shown = frame.join('\n');
      const rule = frame.findLastIndex((row) => /^ +-+$/u.test(row));
      const rows = frame.slice(0, rule - 0).filter((row) => /w\d/u.test(row));
      expect(rows.length, shown).toBeGreaterThan(2);
      for (const row of rows) {
        expect(row.slice(0, grid.margin).trim(), shown).toBe('');
        // the editor's rows are the content column's width at most: Ink wraps the draft where the box ends
        expect(displayWidth(row) - grid.margin, shown).toBeLessThanOrEqual(grid.content);
      }
    },
  );

  it('draws the mark of a tool call in the colour of its words: the live row is the host’s, amber in both', async () => {
    const variant: Variant = { renderer: 'alt', color: true, size: { cols: 100, rows: 30 } };
    const m = await mountIn('standalone-chat', variant, {
      prepare: (store) => store.notice('A notice.'),
    });
    try {
      startTurn(m, 'the answer', ['read_file']);
      await m.until(() => m.text().includes('read_file'));
      await m.settle();
      const cells = m.cells();
      const row = cells.find((line) => line.some((cell) => cell.char === TRIANGLE));
      expect(row, m.text()).toBeDefined();
      const mark = row?.find((cell) => cell.char === TRIANGLE);
      const words = row?.find((cell) => cell.char === 'r');
      expect(mark?.style.fg, 'the mark is coloured').toBeDefined();
      expect(mark?.style.fg).toBe(words?.style.fg);
    } finally {
      m.unmount();
    }
  });
});

describe.each(HOSTS)(
  'the row estimates of the live region, in the %s host, are the content column’s',
  (host) => {
    const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

    it.each([
      ['a body of 900 characters (14 rows at 68 columns) is cut at its head and marked', 900, true],
      ['a body of 700 characters (11 rows at 68 columns) is drawn whole', 700, false],
    ] as const)('the expanded reasoning panel: %s', async (_label, length, cut) => {
      const grid = chatGrid(80);
      const m = await mountIn(host, ALT_80, { prepare: (store) => store.notice('A notice.') });
      try {
        seq = 1;
        m.store.apply(turnStarted());
        m.store.apply(reasoning('abcdefghi '.repeat(length / 10)));
        m.store.toggleReasoning();
        m.store.tick();
        await m.until(() => m.text().includes('Reasoning'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.join('\n');
        const body = frame.filter((row) => /^ +…?[a-i]/u.test(row) && !row.includes('Reasoning'));
        expect(
          frame.some((row) => /^…|^ +…[a-i]/u.test(row)),
          shown,
        ).toBe(cut);
        expect(body.length, shown).toBeGreaterThan(8);
        for (const row of body)
          expect(displayWidth(row) - grid.margin, shown).toBeLessThanOrEqual(grid.content);
      } finally {
        m.unmount();
      }
    });

    it('the streamed line of a view that has no markdown stream is bounded to the live budget at the content column’s width', async () => {
      const mounted = mountInk(
        <Box flexDirection="column" height={24}>
          <ChatView
            state={{
              ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
              status: 'running',
              liveTokens: 'x'.repeat(3000),
            }}
            columns={80}
            color={false}
            tick={0}
            nowMs={0}
            editor={emptyEditor()}
            running
            mode="ask"
            reasoningVisible={false}
            viewport={{ rows: 24, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
          />
        </Box>,
        ALT_80,
      );
      try {
        await mounted.settle();
        const frame = mounted.frame();
        const shown = frame.join('\n');
        const grid = chatGrid(80);
        const drawn = frame.join('').split('x').length - 1;
        // `liveAnswerRowBudget(24)` is 8 rows of the content column's 68 columns: the line is cut to what they hold
        expect(drawn, shown).toBeLessThanOrEqual(8 * grid.content);
        expect(drawn, shown).toBeGreaterThan(8 * grid.content - 2 * grid.content);
        for (const row of frame) expect(displayWidth(row), shown).toBeLessThanOrEqual(80);
      } finally {
        mounted.unmount();
      }
    });
  },
);

describe.each(HOSTS)(
  'the rows below the prompt block, in the %s host, are in the content column',
  (host) => {
    const NAME = `${CHEVRON} you ${TRIANGLE} tool.md`;
    const READER: MentionReader = {
      list: () => Promise.resolve([{ name: NAME, type: 'file', path: NAME }]),
      read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
    };

    async function mountWithReader(variant: Variant): Promise<ChatMount> {
      const m =
        host === 'chat'
          ? await mountHostedChat(variant, { hosted: { session: { mentionReader: READER } } })
          : mountStandaloneChat(variant, { standalone: { mentionReader: READER } });
      await m.settle();
      return m;
    }

    it.each(
      VARIANTS.filter((variant) => variant.size.cols !== 120).map(
        (variant) => [name(variant), variant] as const,
      ),
    )(
      'draws the `@` completion list and the attachment chip bar after the margin: a file name cannot stand in it (%s)',
      async (_label, variant) => {
        const { grid } = gridOf(variant);
        const m = await mountWithReader(variant);
        try {
          m.key('@');
          await m.until(() => m.text().includes('tool.md'));
          await m.settle();
          const list = m.frame();
          const shown = list.map((row, index) => `${String(index)}|${row}`).join('\n');
          const at = list.findIndex((row) => row.includes('tool.md'));
          expect(at, shown).toBeGreaterThan(0);
          // the completion list is a row of the content column: the margin to its left is blank, the file name is a stored name drawn after it
          for (let index = at - 1; index < list.length; index += 1)
            expect(
              list[index]?.slice(0, grid.margin).trim(),
              `row ${String(index)}\n${shown}`,
            ).toBe('');
          expect(markedRows(list, grid), shown).toEqual([]);
          // pick the file: its chip is the attachment bar above the prompt, a row of the content column
          m.key('\r');
          await m.until(() => m.text().includes('📎'));
          await m.settle();
          const bar = m.frame();
          const chip = bar.findIndex((row) => row.includes('📎'));
          expect(chip, bar.join('\n')).toBeGreaterThan(0);
          expect(bar[chip]?.startsWith(' '.repeat(grid.margin)), bar.join('\n')).toBe(true);
          expect(displayWidth(bar[chip] ?? '') - grid.margin, bar.join('\n')).toBeLessThanOrEqual(
            grid.content,
          );
          expect(markedRows(bar, grid), bar.join('\n')).toEqual([]);
        } finally {
          m.unmount();
        }
      },
    );

    it.each(
      VARIANTS.filter((variant) => variant.size.cols !== 120 && variant.renderer === 'alt').map(
        (variant) => [name(variant), variant] as const,
      ),
    )('draws the history search after the margin (%s)', async (_label, variant) => {
      const { grid } = gridOf(variant);
      const m = await mountWithReader(variant);
      try {
        m.key('first line');
        m.key('\r');
        await m.settle();
        m.key('\u0012'); // Ctrl+R
        await m.until(() => m.text().includes('search'));
        await m.settle();
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const from = frame.findIndex((row) => row.includes('search'));
        expect(from, shown).toBeGreaterThan(0);
        for (let index = from; index < frame.length; index += 1)
          expect(frame[index]?.slice(0, grid.margin).trim(), `row ${String(index)}\n${shown}`).toBe(
            '',
          );
      } finally {
        m.unmount();
      }
    });
  },
);

/** A literal for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
