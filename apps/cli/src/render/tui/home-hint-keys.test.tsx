import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunKind, ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { HomeView } from './home-view.js';

/**
 * The hint bar under the Home's prompt lists only keys the Home answers, and each does what its word says
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3: a test presses every key a legend lists). The
 * legend is read from the frame the real `HomeView` draws, then every key it lists is pressed on a real controller in the same state.
 */
afterEach(cleanup);

const RUN = 'run-0001';
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const DOWN = { downArrow: true } as const;
const UP = { upArrow: true } as const;
const CTRL_C = { ctrl: true } as const;

const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const runRow = (id: string): HomeRunRow => ({
  runId: `run-${id}`,
  workflowSlug: `wf-${id}`,
  status: 'completed',
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const snapshotOf = (over: { sessions?: number; runs?: number }): HomeSnapshot => ({
  attention: { gates: [], failedRuns: [] },
  recentSessions: Array.from({ length: over.sessions ?? 0 }, (_, index) => sessionRow(index + 1)),
  recentRuns: Array.from({ length: over.runs ?? 0 }, (_, index) => runRow(String(index + 1))),
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: over.sessions === undefined && over.runs === undefined,
});

const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: false },
  last: undefined,
};

const parkedRow = (kind: ParkedRunKind): ParkedRunRow => ({ runId: RUN, kind, gates: 1 });
const APPROVAL: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review',
      gateType: 'approval',
      message: 'Ship it?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};

interface Rig {
  readonly controller: HomeController;
  readonly exits: ReturnType<typeof vi.fn>;
}

function rig(options: {
  readonly snapshot?: HomeSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  readonly host?: RunHostSnapshot;
  readonly startChat?: () => Promise<never>;
  /** What the log says of the parked run when `Enter` reads it: a gate, or (the default) the gate of the row. */
  readonly gates?: RunGates;
}): Rig {
  const exits = vi.fn();
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: options.startChat ?? (() => new Promise(() => {})),
    homeStore: { read: () => options.snapshot ?? snapshotOf({}) },
    hostedRuns: {
      snapshot: () => options.host ?? IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    gateCards: {
      list: () => options.parked ?? [],
      read: () => options.gates ?? APPROVAL,
      resume: () => new Promise(() => {}),
      guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
    },
    strip: { token: () => ({ dataVersion: 1, generation: 0 }), isClosed: () => false },
    schedule: () => () => {},
    now: () => 0,
    onExit: exits,
    onError: (cause) => {
      throw cause;
    },
  });
  controller.bindGateCardFrame(() => true);
  return { controller, exits };
}

/** The hint row the Home draws for a controller in `state` (the row that ends with the key that leaves, or the armed one). */
function hintOf(
  controller: HomeController,
  hostedRun: RunHostSnapshot = IDLE,
  size: { readonly cols: number; readonly rows: number } = { cols: 100, rows: 30 },
): string {
  const state = controller.getSnapshot();
  const view = render(
    <HomeView
      snapshot={state.snapshot}
      editor={state.input}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={size.cols}
      rows={size.rows}
      color={false}
      keyless={false}
      interruptArmed={state.interruptArmed}
      hostedRun={hostedRun}
      parkedRuns={state.parkedRuns}
      stripFocus={state.stripFocus}
    />,
  );
  const rows = (view.lastFrame() ?? '').split('\n').map((line) => line.trimEnd());
  view.unmount();
  return rows.findLast((row) => /\[Ctrl\+C\] exit/u.test(row)) ?? '';
}

/** The keys a legend row lists: the leading key of each ` · ` item that starts with one, as written. */
const listedKeys = (row: string): string[] =>
  row
    .split(' · ')
    .map((item) => item.split(' ')[0] ?? '')
    .filter((word) => /^(\[[^\]]+\]|Enter|Esc|↑\/↓|↓|Tab)$/u.test(word));

describe('the Home hint bar at the prompt', () => {
  it('an empty Home lists [/] and [Ctrl+C]: the first opens the palette, the second arms and the next leaves', () => {
    const { controller, exits } = rig({});
    const hint = hintOf(controller);
    expect(hint).toBe('[/] for commands · type a message to start a chat · [Ctrl+C] exit (twice)');
    expect(listedKeys(hint)).toEqual(['[/]', '[Ctrl+C]']);
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette, '/ opens the palette').toBeDefined();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().palette, 'Esc closes it again').toBeUndefined();
    controller.handleKey('c', CTRL_C);
    expect(controller.getSnapshot().interruptArmed, 'the first Ctrl+C arms').toBe(true);
    expect(hintOf(controller)).toBe('[Ctrl+C] exit (again)');
    expect(exits).not.toHaveBeenCalled();
    controller.handleKey('c', CTRL_C);
    expect(exits, 'the second Ctrl+C leaves').toHaveBeenCalledOnce();
  });

  it('a Home with sessions lists ↓ and moves onto the first session; a parked run lists ↓ and moves onto it', () => {
    const sessions = rig({ snapshot: snapshotOf({ sessions: 2 }) });
    expect(hintOf(sessions.controller)).toBe(
      '[/] commands · ↓ continue · type a message to chat · [Ctrl+C] exit (twice)',
    );
    sessions.controller.handleKey('', DOWN);
    expect(sessions.controller.getSnapshot().stripFocus).toEqual({
      kind: 'session',
      id: 'session-1',
    });
    const parked = rig({ parked: [parkedRow('approval')] });
    expect(hintOf(parked.controller)).toBe(
      '[/] commands · ↓ open a parked run · type a message to chat · [Ctrl+C] exit (twice)',
    );
    parked.controller.handleKey('', DOWN);
    expect(parked.controller.getSnapshot().stripFocus).toEqual({ kind: 'run', id: RUN });
  });

  it('at 80 columns the key that leaves is never the part that is cut: the lowest-priority item of a line that does not fit is dropped (ADR-0145 §3)', () => {
    const parked = rig({ parked: [parkedRow('approval')] });
    // 83 columns written whole: the standing "type a message to chat" goes, the exit stays, and nothing is cut inside a word.
    expect(hintOf(parked.controller, IDLE, { cols: 80, rows: 24 })).toBe(
      '[/] commands \u00b7 \u2193 open a parked run \u00b7 [Ctrl+C] exit (twice)',
    );
    expect(hintOf(parked.controller, IDLE, { cols: 100, rows: 30 })).toContain(
      'type a message to chat',
    );
  });

  it('a live run lists Enter first: it shows the run', () => {
    const { controller } = rig({ host: EXECUTING });
    expect(hintOf(controller, EXECUTING)).toBe(
      '[/] commands · Enter show it · type a message to chat · [Ctrl+C] exit (twice)',
    );
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: RUN });
  });

  it('a draft lists Enter and Ctrl+J: Enter starts the chat and Ctrl+J puts a newline in the draft', () => {
    const started = vi.fn(() => new Promise<never>(() => {}));
    const { controller } = rig({ startChat: started });
    for (const char of 'hello') controller.handleKey(char, {});
    const hint = hintOf(controller);
    expect(hint).toBe('Enter start the chat · [Ctrl+J] newline · [Ctrl+C] exit (twice)');
    expect(listedKeys(hint)).toEqual(['Enter', '[Ctrl+J]', '[Ctrl+C]']);
    controller.handleKey('\n', {});
    expect(controller.getSnapshot().input.text, 'Ctrl+J is a newline, not a submit').toBe(
      'hello\n',
    );
    expect(started).not.toHaveBeenCalled();
    controller.handleKey('', ENTER);
    expect(started, 'Enter starts the chat with the draft').toHaveBeenCalledOnce();
  });
});

describe('the Home hint bar on a focused strip row', () => {
  it('a session row lists ↑/↓, Enter and Esc: ↑/↓ move the focus, Esc returns to the prompt, Enter resumes', () => {
    const { controller } = rig({ snapshot: snapshotOf({ sessions: 2 }) });
    controller.handleKey('', DOWN);
    const hint = hintOf(controller);
    expect(hint).toBe(
      '↑/↓ select session · Enter resume · Esc return to prompt · [Ctrl+C] exit (twice)',
    );
    expect(listedKeys(hint)).toEqual(['↑/↓', 'Enter', 'Esc', '[Ctrl+C]']);
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'session', id: 'session-2' });
    controller.handleKey('', UP);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'session', id: 'session-1' });
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().stripFocus, 'Esc returns to the prompt').toBeUndefined();
    expect(controller.getSnapshot().input.text).toBe('');
  });

  it('a recent-run row lists ↑/↓, Enter and Esc: Esc returns to the prompt, ↑/↓ move the focus', () => {
    const { controller } = rig({ snapshot: snapshotOf({ runs: 2 }) });
    controller.handleKey('', DOWN);
    const hint = hintOf(controller);
    expect(hint).toBe(
      '↑/↓ select · Enter open the run · Esc return to prompt · [Ctrl+C] exit (twice)',
    );
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'run', id: 'run-2' });
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().stripFocus).toBeUndefined();
  });

  it.each([
    ['approval', 'Enter open the gate'],
    ['input', 'Enter show how'],
  ] as const)(
    'a parked %s row lists %s, and Enter on it opens the gate card the word names',
    (kind, cue) => {
      const { controller } = rig({ parked: [parkedRow(kind)] });
      controller.handleKey('', DOWN);
      expect(hintOf(controller)).toBe(
        `↑/↓ select \u00b7 ${cue} \u00b7 Esc return to prompt \u00b7 [Ctrl+C] exit (twice)`,
      );
      controller.handleKey('', ENTER);
      expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    },
  );

  it.each([
    ['media', 'Enter continue it'],
    ['none', 'Enter say why'],
  ] as const)(
    'a parked %s row lists %s, and Enter on it opens no gate card where the log names no gate',
    (kind, cue) => {
      const { controller } = rig({
        parked: [parkedRow(kind)],
        gates: { ...APPROVAL, gates: [] },
      });
      controller.handleKey('', DOWN);
      expect(hintOf(controller)).toBe(
        `↑/↓ select \u00b7 ${cue} \u00b7 Esc return to prompt \u00b7 [Ctrl+C] exit (twice)`,
      );
      controller.handleKey('', ENTER);
      expect(controller.getSnapshot().screen?.kind).not.toBe('gate-card');
    },
  );
});
