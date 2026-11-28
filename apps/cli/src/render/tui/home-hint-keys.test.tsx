import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunKind, ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { EXAMPLE_PROMPT } from './home-layout.js';
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
/** A snapshot of this directory; `parked` is how many parked runs the store counts (the controller's parked rows are a separate read). */
const snapshotOf = (over: { sessions?: number; runs?: number; parked?: number }): HomeSnapshot => ({
  failedRuns: [],
  recentSessions: Array.from({ length: over.sessions ?? 0 }, (_, index) => sessionRow(index + 1)),
  recentRuns: Array.from({ length: over.runs ?? 0 }, (_, index) => runRow(String(index + 1))),
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: over.parked ?? 0, sessions: over.sessions ?? 0, runs: over.runs ?? 0 },
  isEmpty: over.sessions === undefined && over.runs === undefined && (over.parked ?? 0) === 0,
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
    startChat: options.startChat ?? (() => new Promise(() => {})),
    // A parked run is counted by the store too (the totals): a Home that lists one says so on its landing.
    homeStore: {
      read: () =>
        options.snapshot ??
        snapshotOf(options.parked === undefined ? {} : { parked: options.parked.length }),
    },
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

/**
 * The hint row the Home draws for a controller in `state` (the row that ends with the key that leaves the page: `[Ctrl+C]` on the landing, or
 * the armed one; `Esc start page` on the work page, MVP-11 unit 7).
 */
function hintOf(
  controller: HomeController,
  hostedRun: RunHostSnapshot = IDLE,
  size: { readonly cols: number; readonly rows: number } = { cols: 100, rows: 30 },
  keyless = false,
): string {
  return (
    rowsOf(controller, hostedRun, size, keyless).findLast((row) =>
      /\[Ctrl\+C\] exit|Esc start page$/u.test(row),
    ) ?? ''
  );
}

/** The rows the Home draws for a controller in its state. */
function rowsOf(
  controller: HomeController,
  hostedRun: RunHostSnapshot,
  size: { readonly cols: number; readonly rows: number },
  keyless: boolean,
): string[] {
  const state = controller.getSnapshot();
  const view = render(
    <HomeView
      page={state.homePage}
      snapshot={state.snapshot}
      editor={state.input}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={size.cols}
      rows={size.rows}
      color={false}
      keyless={keyless}
      interruptArmed={state.interruptArmed}
      hostedRun={hostedRun}
      parkedRuns={state.parkedRuns}
      stripFocus={state.stripFocus}
    />,
  );
  // The empty Home is left-hung at its margin (ADR-0146 §1), so a row is read by its words, not by the columns before them.
  const rows = (view.lastFrame() ?? '').split('\n').map((line) => line.trim());
  view.unmount();
  return rows;
}

/** The keyless line the Home draws (above the prompt, or as the empty Home's status line), or `''` when it draws none. */
function keylessLineOf(
  controller: HomeController,
  hostedRun: RunHostSnapshot = IDLE,
  size: { readonly cols: number; readonly rows: number } = { cols: 100, rows: 30 },
): string {
  return (
    rowsOf(controller, hostedRun, size, true).find((row) => row.startsWith('No provider key')) ?? ''
  );
}

/** The keys a legend row lists: the leading key of each ` · ` item that starts with one, as written. */
const listedKeys = (row: string): string[] =>
  row
    .split(' · ')
    .map((item) => item.split(' ')[0] ?? '')
    .filter((word) => /^(\[[^\]]+\]|Enter|Esc|↑\/↓|↓|Tab)$/u.test(word));

describe('the Home hint bar at the prompt', () => {
  it('an empty Home lists [/], Tab and [Ctrl+C]: the first opens the palette, Tab fills the example, the last arms and the next leaves', () => {
    const { controller, exits } = rig({});
    const hint = hintOf(controller);
    expect(hint).toBe(
      '[/] commands · type a message to chat · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(listedKeys(hint)).toEqual(['[/]', 'Tab', '[Ctrl+C]']);
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette, '/ opens the palette').toBeDefined();
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().palette, 'Esc closes it again').toBeUndefined();
    controller.handleKey('', { tab: true });
    expect(controller.getSnapshot().input.text, 'Tab fills the example the hint names').toBe(
      EXAMPLE_PROMPT,
    );
    for (let n = 0; n < EXAMPLE_PROMPT.length; n += 1)
      controller.handleKey('', { backspace: true });
    expect(controller.getSnapshot().input.text, 'the draft is emptied again').toBe('');
    controller.handleKey('c', CTRL_C);
    expect(controller.getSnapshot().interruptArmed, 'the first Ctrl+C arms').toBe(true);
    expect(hintOf(controller)).toBe('[Ctrl+C] exit (again)');
    expect(exits).not.toHaveBeenCalled();
    controller.handleKey('c', CTRL_C);
    expect(exits, 'the second Ctrl+C leaves').toHaveBeenCalledOnce();
  });

  it('a Home with sessions lists ↓ and moves onto the first session; a parked run lists ↓ and moves onto it', () => {
    const sessions = rig({ snapshot: snapshotOf({ sessions: 2 }) });
    // The landing's indicator (MVP-11 unit 7): `↓` and what it goes down to, counted.
    expect(hintOf(sessions.controller)).toBe(
      '[/] commands · ↓ 2 sessions · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    sessions.controller.handleKey('', DOWN);
    expect(sessions.controller.getSnapshot().stripFocus).toEqual({
      kind: 'session',
      id: 'session-1',
    });
    const parked = rig({ parked: [parkedRow('approval')] });
    // A parked run is named (MVP-11 unit 7): page 1 says what the most urgent item is, not only how many there are.
    expect(hintOf(parked.controller)).toBe(
      '[/] commands · ↓ run run-0001 needs approval · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    parked.controller.handleKey('', DOWN);
    expect(parked.controller.getSnapshot().stripFocus).toEqual({ kind: 'run', id: RUN });
  });

  it('at 80 columns the key that leaves is never the part that is cut: the lowest-priority item of a line that does not fit is dropped (ADR-0145 §3)', () => {
    const parked = rig({ parked: [parkedRow('approval')] });
    // Written whole it is wider than the 74 columns the margin leaves: the example's `Tab` goes, the indicator and the exit stay, nothing is
    // cut inside a word.
    expect(hintOf(parked.controller, IDLE, { cols: 80, rows: 24 })).toBe(
      '[/] commands · ↓ run run-0001 needs approval · [Ctrl+C] exit (twice)',
    );
    expect(hintOf(parked.controller, IDLE, { cols: 100, rows: 30 })).toContain(
      'Tab fill the example',
    );
  });

  it('a live run: its own row says Enter shows it (the hint keeps its doors), and Enter does', () => {
    const { controller } = rig({ host: EXECUTING });
    expect(hintOf(controller, EXECUTING)).toBe(
      '[/] commands · type a message to chat · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(
      rowsOf(controller, EXECUTING, { cols: 100, rows: 30 }, false).some((row) =>
        row.endsWith('Enter show it'),
      ),
      'the run row, under the status line',
    ).toBe(true);
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

describe('the Home hint bar for a draft that is a command', () => {
  it.each(['/mod', '/nonsense', '/models'])(
    'a pasted %s lists Enter run, because Enter runs the command (or says it is unknown) and starts no chat',
    (line) => {
      const started = vi.fn(() => new Promise<never>(() => {}));
      const { controller } = rig({ startChat: started });
      controller.handleKey(line, {}); // a paste: one chunk, so it is a draft and not the palette
      expect(controller.getSnapshot().input.text).toBe(line);
      const hint = hintOf(controller);
      expect(hint).toBe('Enter run · [Ctrl+J] newline · [Ctrl+C] exit (twice)');
      expect(hint).not.toContain('start the chat');
      controller.handleKey('', ENTER);
      expect(started, 'Enter on a command line starts no chat').not.toHaveBeenCalled();
    },
  );

  it('a message that only contains a slash is a message: Enter starts the chat', () => {
    const { controller } = rig({});
    controller.handleKey('see /etc/hosts', {});
    expect(hintOf(controller)).toBe(
      'Enter start the chat · [Ctrl+J] newline · [Ctrl+C] exit (twice)',
    );
  });
});

describe('the keyless line promises Enter only where Enter connects', () => {
  const CONNECTS = 'No provider key yet · Enter connect · /providers';
  const COMMAND_ONLY = 'No provider key yet · /providers connects one';

  it('at an empty prompt with nothing else to open, Enter connects, and the line says so', () => {
    const { controller } = rig({});
    expect(keylessLineOf(controller)).toBe(CONNECTS);
  });

  it('with a message typed, Enter connects (and keeps the message), and the line says so', () => {
    const { controller } = rig({});
    controller.handleKey('hello', {});
    expect(keylessLineOf(controller)).toBe(CONNECTS);
  });

  it('on a focused session row, a run row or a parked row, Enter does that row’s own thing, so the line promises only the command', () => {
    const sessions = rig({ snapshot: snapshotOf({ sessions: 1 }) });
    sessions.controller.handleKey('', DOWN);
    expect(keylessLineOf(sessions.controller)).toBe(COMMAND_ONLY);
    const runs = rig({ snapshot: snapshotOf({ runs: 1 }) });
    runs.controller.handleKey('', DOWN);
    expect(keylessLineOf(runs.controller)).toBe(COMMAND_ONLY);
    const parked = rig({ parked: [parkedRow('approval')] });
    parked.controller.handleKey('', DOWN);
    expect(keylessLineOf(parked.controller)).toBe(COMMAND_ONLY);
    // Esc returns to the prompt, where Enter connects again.
    sessions.controller.handleKey('', ESC);
    expect(keylessLineOf(sessions.controller)).toBe(CONNECTS);
  });

  it('while a run executes at an empty prompt, Enter shows the run; with a message typed, Enter connects', () => {
    const { controller } = rig({ host: EXECUTING });
    expect(keylessLineOf(controller, EXECUTING)).toBe(COMMAND_ONLY);
    controller.handleKey('hello', {});
    expect(keylessLineOf(controller, EXECUTING)).toBe(CONNECTS);
  });

  it('on a command line, Enter runs the command, so the line promises only the command word', () => {
    const { controller } = rig({});
    controller.handleKey('/doctor', {});
    expect(keylessLineOf(controller)).toBe(COMMAND_ONLY);
  });

  it('draws the same hint bar in every one of those states: only the keyless line changed its words', () => {
    const { controller } = rig({ snapshot: snapshotOf({ sessions: 1 }) });
    controller.handleKey('', DOWN);
    expect(hintOf(controller, IDLE, { cols: 100, rows: 30 }, true)).toBe(
      '↑/↓ select session · Enter resume · type to chat · Esc start page',
    );
  });
});

describe('the Home hint bar on a focused strip row', () => {
  it('a session row lists ↑/↓, Enter and Esc: ↑/↓ move the focus, Esc returns to the prompt, Enter resumes', () => {
    const { controller } = rig({ snapshot: snapshotOf({ sessions: 2 }) });
    controller.handleKey('', DOWN);
    const hint = hintOf(controller);
    expect(hint).toBe('↑/↓ select session · Enter resume · type to chat · Esc start page');
    expect(listedKeys(hint)).toEqual(['↑/↓', 'Enter', 'Esc']);
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'session', id: 'session-2' });
    controller.handleKey('', UP);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'session', id: 'session-1' });
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().stripFocus, 'Esc returns to the prompt').toBeUndefined();
    expect(controller.getSnapshot().homePage, 'the landing’s prompt').toBe('start');
    expect(controller.getSnapshot().input.text).toBe('');
  });

  it('a recent-run row lists ↑/↓, Enter and Esc: Esc returns to the prompt, ↑/↓ move the focus', () => {
    const { controller } = rig({ snapshot: snapshotOf({ runs: 2 }) });
    controller.handleKey('', DOWN);
    const hint = hintOf(controller);
    expect(hint).toBe('↑/↓ select · Enter details · type to chat · Esc start page');
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().stripFocus).toEqual({ kind: 'run', id: 'run-2' });
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().stripFocus).toBeUndefined();
  });

  it.each([
    ['approval', 'Enter open'],
    ['input', 'Enter show how to answer'],
  ] as const)(
    'a parked %s row lists %s, and Enter on it opens the gate card the word names',
    (kind, cue) => {
      const { controller } = rig({ parked: [parkedRow(kind)] });
      controller.handleKey('', DOWN);
      expect(hintOf(controller)).toBe(`↑/↓ select · ${cue} · type to chat · Esc start page`);
      controller.handleKey('', ENTER);
      expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    },
  );

  it.each([
    ['media', 'Enter ask to continue'],
    ['none', 'Enter say why'],
  ] as const)(
    'a parked %s row lists %s, and Enter on it opens no gate card where the log names no gate',
    (kind, cue) => {
      const { controller } = rig({
        parked: [parkedRow(kind)],
        gates: { ...APPROVAL, gates: [] },
      });
      controller.handleKey('', DOWN);
      expect(hintOf(controller)).toBe(`↑/↓ select · ${cue} · type to chat · Esc start page`);
      controller.handleKey('', ENTER);
      expect(controller.getSnapshot().screen?.kind).not.toBe('gate-card');
    },
  );
});
