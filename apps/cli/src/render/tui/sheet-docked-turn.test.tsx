/**
 * A docked sheet keeps the in-flight turn on screen (ADR-0147 §1; ADR-0129: "the conversation visible above it"; the frame
 * `docs/roadmap/phases/mvp-11/sheet-file-approval-80x24.png` shows `▸ read_file … ✓` above the sheet). The sheet takes the prompt block's place,
 * the prompt, its rule, the status line and the hint, and NOT the turn the person is asked about: this turn's tool-call lines with their outcomes,
 * the reasoning panel and the lead row's warnings stay above it; the busy line does not (it would say `Working…` under a card that waits). The
 * sheet keeps its rows: the in-flight lines are bounded by the rows the conversation keeps above the largest sheet, the newest kept.
 *
 * Unit 8 fix wave, S-1 (a regression of the build wave, which drew nothing above a docked sheet). Both renderers, 80×24 and 100×30, each kind of
 * card.
 */
import type {
  AskUserRequest,
  SessionStreamHandleEvent,
  ToolApprovalRequest,
  ToolPreview,
} from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { ChatApp } from './chat-ink.js';
import { CHAT_HEADER_ROWS, chatFrameRows } from './chat-layout.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { cardRowBudget, sheetTranscriptRows } from './tool-review-card.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
const event = (body: Record<string, unknown>): SessionStreamHandleEvent =>
  ({
    sessionId: 's',
    sequenceNumber: seq++,
    timestamp: '2026-11-27T09:00:00.000Z',
    ...body,
  }) as SessionStreamHandleEvent;
const started = (): SessionStreamHandleEvent =>
  event({
    type: 'session:started',
    agentRef: 'relavium-chat',
    model: 'claude-sonnet-4-6',
    context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
  });
const toolCall = (toolId: string): SessionStreamHandleEvent =>
  event({
    type: 'agent:tool_call',
    nodeId: 'relavium-chat',
    model: 'claude-sonnet-4-6',
    toolId,
    toolInput: { path: 'x' },
  });
const toolResult = (toolId: string): SessionStreamHandleEvent =>
  event({
    type: 'agent:tool_result',
    nodeId: 'relavium-chat',
    toolId,
    success: true,
    outputSummary: 'ok',
  });

const FILE: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const LONG: ToolPreview = editedFilePreview(100, { 5: 'five', 90: 'ninety' });
const COMMAND: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};
const COMMAND_PREVIEW: ToolPreview = {
  kind: 'operation',
  target: 'npm test',
  fields: [
    { name: '', value: 'npm' },
    { name: '', value: 'test' },
  ],
};
const FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};
const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'a.ts', description: 'first' },
        { label: 'b.ts', description: 'second' },
      ],
    },
  ],
};

interface CardKind {
  readonly name: string;
  /** Text only the sheet draws. */
  readonly landmark: string;
  readonly open: (store: ChatStoreController) => void;
}
const CARDS: readonly CardKind[] = [
  {
    name: 'a file-edit approval',
    landmark: 'Approval needed',
    open: (store) => {
      store.requestApproval(FILE, true, undefined, { callId: 'c1', preview: LONG }).catch(() => {});
    },
  },
  {
    name: 'a command approval',
    landmark: 'Standing:',
    open: (store) => {
      store
        .requestApproval(
          COMMAND,
          true,
          undefined,
          { callId: 'c2', preview: COMMAND_PREVIEW },
          FACTS,
        )
        .catch(() => {});
    },
  },
  {
    name: 'the agent’s question',
    landmark: 'Question from the agent',
    open: (store) => {
      store.requestQuestion(QUESTION).catch(() => {});
    },
  },
  {
    name: 'the continue checkpoint',
    landmark: 'Continue for 8 more?',
    open: (store) => {
      store.requestCheckpoint({ rounds: 12, interval: 8 }).catch(() => {});
    },
  },
];

function mount(alternate: boolean, size: { cols: number; rows: number }) {
  const input = new OwnedTtyInput();
  const output = new PlainTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = size.cols;
  output.rows = size.rows;
  const store = createChatStore(
    false,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  const instance = render(
    createElement(ChatApp, {
      store,
      onSubmit: () => Promise.resolve(),
      shouldStop: () => false,
      onExit: () => {},
      onError: () => {},
      onModeChange: () => {},
      alternateScreen: alternate,
    }),
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: alternate,
    },
  );
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  /** The last frame written that holds `needle`, as rows, control sequences stripped. */
  const rowsWith = (needle: string): readonly string[] =>
    (
      output.frames
        .map((frame) => frame.replace(CONTROL, ''))
        .filter((frame) => frame.includes(needle))
        .at(-1) ?? ''
    ).split('\n');
  return { store, rowsWith };
}

/** A turn that has run `tools` (each called and resolved) and is still running. */
function turnWith(store: ChatStoreController, tools: readonly string[]): void {
  store.apply(started());
  store.apply(event({ type: 'session:turn_started' }));
  store.appendUser('please fix the build');
  for (const tool of tools) {
    store.apply(toolCall(tool));
    store.apply(toolResult(tool));
  }
  store.tick(); // the coalesced tool events reach the snapshot
}

describe.each([
  ['alternate screen', true],
  ['inline', false],
] as const)('%s: the in-flight turn stays above a docked sheet', (_label, alternate) => {
  describe.each([
    [80, 24],
    [100, 30],
  ] as const)('%i×%i', (cols, rows) => {
    it.each(CARDS)(
      '$name: the resolved tool call of this turn is on screen above it, the busy line is not',
      async (card) => {
        const m = mount(alternate, { cols, rows });
        await pause(30);
        turnWith(m.store, ['read_file']);
        await pause(30);
        card.open(m.store);
        let frame: readonly string[] = [];
        for (let tries = 0; tries < 60; tries += 1) {
          await pause(20);
          frame = m.rowsWith(card.landmark);
          if (frame.length > 1) break;
        }
        const tool = frame.findIndex((row) => /read_file/u.test(row));
        const sheet = frame.findIndex((row) => row.startsWith('== '));
        expect(tool, frame.join('\n')).toBeGreaterThanOrEqual(0);
        expect(frame[tool], 'the call and its outcome').toMatch(/read_file.*(?:ok|completed)/u);
        expect(sheet).toBeGreaterThan(tool);
        expect(frame.join('\n'), 'no busy line under a card that waits').not.toMatch(
          /Working…|Thinking…/u,
        );
        if (alternate)
          expect(
            frame.length,
            'the frame stays rows − 1 (and the empty last row)',
          ).toBeLessThanOrEqual(rows);
      },
    );
  });
});

describe('the sheet keeps its rows: the in-flight lines are bounded, the newest kept', () => {
  it.each([
    [80, 24],
    [100, 30],
  ] as const)(
    '%i×%i: a turn of 15 calls under a full sheet shows the newest calls in the conversation’s rows',
    async (cols, rows) => {
      // The arithmetic, from the code's constants: the conversation keeps nine rows above the largest sheet.
      expect(sheetTranscriptRows(rows)).toBe(
        chatFrameRows(rows) - CHAT_HEADER_ROWS - cardRowBudget(rows),
      );
      expect(sheetTranscriptRows(rows)).toBe(9);
      const m = mount(true, { cols, rows });
      await pause(30);
      const tools = Array.from(
        { length: 15 },
        (_, index) => `tool_${String(index + 1).padStart(2, '0')}`,
      );
      turnWith(m.store, tools);
      await pause(30);
      CARDS[0]?.open(m.store);
      let frame: readonly string[] = [];
      for (let tries = 0; tries < 60; tries += 1) {
        await pause(20);
        frame = m.rowsWith('Approval needed');
        if (frame.length > 1) break;
      }
      const sheet = frame.findIndex((row) => row.startsWith('== Approval needed'));
      expect(sheet, 'the sheet keeps its place: the header, then nine rows').toBe(
        CHAT_HEADER_ROWS + 9,
      );
      const last = frame.findLastIndex((row) => row.trim() !== '');
      expect(last - sheet + 1, 'and its whole budget').toBe(cardRowBudget(rows));
      expect(frame[sheet - 1], 'the newest call right above it').toMatch(/tool_15/u);
      expect(frame.join('\n'), 'the oldest calls gave way').not.toMatch(/tool_01/u);
    },
  );
});

describe('the reasoning panel and the lead row’s warnings stay above a docked sheet too', () => {
  it.each([true, false])(
    'alternate=%s: the reasoning header and a warning are on screen with the card',
    async (alternate) => {
      const m = mount(alternate, { cols: 80, rows: 24 });
      await pause(30);
      turnWith(m.store, ['read_file']);
      m.store.apply(
        event({
          type: 'agent:reasoning',
          nodeId: 'relavium-chat',
          text: 'let me think',
          model: 'claude-sonnet-4-6',
        }),
      );
      m.store.note('The attachment was cut to fit.');
      m.store.tick();
      await pause(30);
      CARDS[0]?.open(m.store);
      let frame: readonly string[] = [];
      for (let tries = 0; tries < 60; tries += 1) {
        await pause(20);
        frame = m.rowsWith('Approval needed');
        if (frame.length > 1) break;
      }
      const sheet = frame.findIndex((row) => row.startsWith('== Approval needed'));
      const reasoning = frame.findIndex((row) => /Reasoning · \[Ctrl\+T\] show/u.test(row));
      const warning = frame.findIndex((row) => /The attachment was cut to fit\./u.test(row));
      expect(reasoning, frame.join('\n')).toBeGreaterThanOrEqual(0);
      expect(warning).toBeGreaterThanOrEqual(0);
      expect(reasoning).toBeLessThan(sheet);
      expect(warning).toBeLessThan(sheet);
    },
  );
});
