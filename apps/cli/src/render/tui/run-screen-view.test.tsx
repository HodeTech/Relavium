/**
 * The Home's run view as the terminal shows it
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §5): at 80×24 with a short and a very long
 * live output, with a disposition card, below the minimum, with colour off, and through a mounted `RootApp` with real stdin bytes in both
 * the full-screen and the inline renderer. `run-screen.test.ts` owns the model; this file owns what is drawn from it and the wiring above it.
 *
 * The run host and the clock are scripted: no engine is built and no operator home is read.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { RunScreenView } from './run-screen-view.js';
import { createRunStore, type RunStore } from './run-store.js';
import { displayWidth } from './viewport.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

afterEach(cleanup);

const RUN = 'run-0001';
const TS = '2026-11-23T12:00:00.000Z';
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const running = (cancelling = false): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling },
  last: undefined,
});
const ended = (
  disposition: HostedLegEnd['terminal']['disposition'],
  remedy?: string,
): HostedLegEnd => ({
  leg: 'start',
  runId: RUN,
  terminal: {
    disposition,
    safety: undefined,
    headline: `Run ${RUN} ${disposition}.`,
    remedy,
  },
  handedOff: disposition === 'paused',
  retirement: 'retired',
  fault: undefined,
});
const settled = (end: HostedLegEnd): RunHostSnapshot => ({
  launching: false,
  active: undefined,
  last: end,
});

/** A store that has seen `nodeCount` nodes start and complete, and the last one stream a few lines. */
function storeWithNodes(nodeCount: number, color = false): RunStore {
  const store = createRunStore(color);
  let seq = 0;
  const envelope = (): { runId: string; timestamp: string; sequenceNumber: number } => {
    seq += 1;
    return { runId: RUN, timestamp: TS, sequenceNumber: seq };
  };
  store.apply({
    ...envelope(),
    type: 'run:started',
    workflowId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
    executionMode: 'local',
  });
  for (let i = 0; i < nodeCount; i += 1) {
    const nodeId = `node-${String(i).padStart(2, '0')}`;
    store.apply({ ...envelope(), type: 'node:started', nodeId, nodeType: 'agent' });
    if (i < nodeCount - 1)
      store.apply({
        ...envelope(),
        type: 'node:completed',
        nodeId,
        output: null,
        tokensUsed: { input: 1, output: 2 },
        durationMs: 5,
      });
  }
  const last = `node-${String(nodeCount - 1).padStart(2, '0')}`;
  for (let line = 0; line < 4; line += 1)
    store.apply({
      ...envelope(),
      type: 'agent:token',
      nodeId: last,
      token: `streamed line ${String(line)}\n`,
      model: 'm',
    });
  store.tick();
  return store;
}

interface ViewOptions {
  readonly hostedRun?: RunHostSnapshot | undefined;
  readonly store?: RunStore | undefined;
  readonly notices?: readonly string[];
  readonly armed?: boolean;
  readonly openGate?: boolean;
  readonly gateOpenFailed?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
}

function rawView(options: ViewOptions = {}) {
  return render(
    <RunScreenView
      runId={RUN}
      store={options.store}
      hostedRun={'hostedRun' in options ? options.hostedRun : running()}
      notices={options.notices ?? []}
      interruptArmed={options.armed ?? false}
      openGate={options.openGate}
      gateOpenFailed={options.gateOpenFailed}
      columns={options.columns ?? 80}
      rows={options.rows ?? 24}
      color={options.color ?? false}
    />,
  );
}

/** The view, read for its WORDS: the weight the host writes into the title (`emphasis.ts`) is zero columns and is not part of them. */
function view(options: ViewOptions = {}) {
  const mounted = rawView(options);
  return {
    ...mounted,
    lastFrame: (): string | undefined => {
      const frame = mounted.lastFrame();
      return frame === undefined ? undefined : withoutStyles(frame);
    },
  };
}

const linesOf = (frame: string | undefined): string[] => (frame ?? '').split('\n');

describe('at 80×24', () => {
  it('shows the title, the live output, the notices and the key line, in one bounded screen', async () => {
    const { lastFrame } = view({
      store: storeWithNodes(3),
      notices: ['a withheld-effort warning', 'an unpriced-model warning'],
    });
    await waitFor(() => (lastFrame() ?? '').includes('streamed line 3'));
    const frame = lastFrame() ?? '';
    const lines = linesOf(frame);
    expect(lines[0]).toBe('~ running  ·  run run-0001');
    expect(frame).toContain('node-00');
    expect(frame).toContain('streamed line 3');
    expect(frame).toContain('note: a withheld-effort warning');
    expect(frame).toContain('note: an unpriced-model warning');
    expect(lines.at(-1)).toBe('[Ctrl+C] cancel the run (twice) · Esc leaves it running');
    expect(lines.length, 'never more than the terminal less one row').toBeLessThanOrEqual(23);
  });

  it('keeps the title, the newest rows, the notices and the key line on screen with FORTY nodes', async () => {
    const { lastFrame } = view({
      store: storeWithNodes(40),
      notices: Array.from({ length: 50 }, (_, i) => `notice ${String(i)}`),
    });
    await waitFor(() => (lastFrame() ?? '').includes('streamed line 3'));
    const frame = lastFrame() ?? '';
    const lines = linesOf(frame);
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(lines[0]).toBe('~ running  ·  run run-0001');
    expect(lines.at(-1)).toBe('[Ctrl+C] cancel the run (twice) · Esc leaves it running');
    // The newest of the output and its cost footer stay; the oldest node rows are what scrolled off the top.
    expect(frame).toContain('node-39');
    expect(frame).toContain('streamed line 3');
    expect(frame).toContain('run run-0001  ·  cost');
    expect(frame).not.toContain('node-00');
    // The notices are the newest three, with how many came before.
    expect(frame).toContain('note: notice 49');
    expect(frame).toContain('note: notice 47');
    expect(frame).not.toContain('note: notice 46');
    expect(frame).toContain('… 47 earlier notices');
  });

  it('keeps a short output at the top, right under the title', async () => {
    const { lastFrame } = view({ store: storeWithNodes(2) });
    await waitFor(() => (lastFrame() ?? '').includes('streamed line 3'));
    const lines = linesOf(lastFrame());
    expect(lines[0]).toBe('~ running  ·  run run-0001');
    expect(lines[1], 'the first node row, with no gap between').toContain('node-00');
  });

  it('says there is no live output when nothing feeds the Home, and still shows everything else', () => {
    const { lastFrame } = view({ store: undefined, notices: ['a notice'] });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No live output for this view.');
    expect(frame).toContain('note: a notice');
    expect(frame).toContain('[Ctrl+C] cancel the run (twice)');
  });

  it('says that one more Ctrl+C cancels once the keymap is armed, and that the leg is stopping once it is cancelling', () => {
    expect(view({ armed: true }).lastFrame()).toContain(
      '[Ctrl+C] cancel the run (again) · Esc leaves it running',
    );
    const stopping = view({ hostedRun: running(true), armed: true }).lastFrame() ?? '';
    expect(stopping).toContain('# cancelling  ·  run run-0001');
    expect(stopping).toContain('Cancelling · the run stops at its next safe point (up to 10s)');
    expect(stopping).toContain('Waiting for the run to stop · Esc leaves the view');
    expect(stopping).not.toContain('[Ctrl+C] cancel the run');
  });

  it('shows the disposition card under the output once the leg has ended, within the same bounds', () => {
    const end: HostedLegEnd = {
      ...ended('failed', 'Read `relavium logs run-0001` for the cause.'),
      terminal: {
        disposition: 'failed',
        safety: undefined,
        headline: `Run ${RUN} failed. ${'It stopped because of something rather long. '.repeat(6)}`,
        remedy: 'Read `relavium logs run-0001` for the cause. '.repeat(8),
      },
      fault: 'the provider refused',
    };
    const { lastFrame } = view({
      hostedRun: settled(end),
      store: storeWithNodes(40),
      notices: Array.from({ length: 50 }, (_, i) => `notice ${String(i)}`),
    });
    const frame = lastFrame() ?? '';
    const lines = linesOf(frame);
    expect(lines[0]).toBe('x failed  ·  run run-0001');
    expect(frame).toContain('Run run-0001 failed.');
    expect(frame).toContain('Read `relavium logs run-0001`');
    expect(frame).toContain('Reason: the provider refused');
    expect(lines.at(-1)).toBe('Esc / [Ctrl+C] close');
    expect(lines.length).toBeLessThanOrEqual(23);
    expect(frame).not.toContain('[Ctrl+C] cancel the run');
  });
});

describe('the card is the end of a leg', () => {
  it("is not drawn while a resumed leg runs, although the host still holds the earlier leg's end", () => {
    const frame =
      view({
        hostedRun: {
          launching: false,
          active: { leg: 'resume', runId: RUN, cancelling: false },
          last: ended('paused', 'Open the run to continue it.'),
        },
        store: storeWithNodes(2),
      }).lastFrame() ?? '';
    expect(linesOf(frame)[0]).toBe('~ running  ·  run run-0001  ·  resumed');
    expect(frame).not.toContain('Open the run to continue it.');
    expect(frame).not.toContain('Esc / [Ctrl+C] close');
  });
});

describe('every state has a glyph and a word, with colour off', () => {
  const STATES: readonly {
    readonly name: string;
    readonly hostedRun: RunHostSnapshot | undefined;
    readonly title: string;
  }[] = [
    {
      // No view is opened for a run that has no id, so a leg that has not named its run is not this view's (and never its `Ctrl+C`'s).
      name: 'a leg that has not named its run',
      hostedRun: {
        launching: false,
        active: { leg: 'start', runId: undefined, cancelling: false },
        last: undefined,
      },
      title: 'o not held',
    },
    { name: 'running', hostedRun: running(), title: '~ running' },
    { name: 'cancelling', hostedRun: running(true), title: '# cancelling' },
    { name: 'completed', hostedRun: settled(ended('completed')), title: 'ok completed' },
    { name: 'failed', hostedRun: settled(ended('failed')), title: 'x failed' },
    { name: 'cancelled', hostedRun: settled(ended('cancelled')), title: '/ cancelled' },
    {
      name: 'paused',
      hostedRun: settled(ended('paused', 'Open the run to continue it.')),
      title: '|| paused',
    },
    { name: 'needs attention', hostedRun: settled(ended('uncertain')), title: '! needs attention' },
    { name: 'taken over', hostedRun: settled(ended('taken_over')), title: '! taken over' },
    { name: 'already settled', hostedRun: settled(ended('settled')), title: 'ok already settled' },
    { name: 'not held', hostedRun: IDLE, title: 'o not held' },
    { name: 'no host', hostedRun: undefined, title: 'o not held' },
  ];

  it.each(STATES)('$name: "$title", bold, and not one colour sequence', ({ hostedRun, title }) => {
    const options = { hostedRun, store: storeWithNodes(2), notices: ['a notice'] };
    const frame = view(options).lastFrame() ?? '';
    expect(linesOf(frame)[0]).toBe(`${title}  ·  run run-0001`);
    // "No colour" means colour only (ADR-0145 §5): the title keeps its weight, and no sequence of the frame is a colour.
    const raw = rawView(options).lastFrame() ?? '';
    expect(linesOf(raw)[0]).toContain('\x1b[1m');
    // eslint-disable-next-line no-control-regex -- the assertion is about escape sequences
    const codes = raw.match(/\x1b\[[0-9;]*m/g) ?? [];
    expect(codes.filter((code) => !['\x1b[1m', '\x1b[22m'].includes(code))).toEqual([]);
  });

  it('draws colour only when colour is on, over the same words', () => {
    const plain = rawView({ color: false }).lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex -- the assertion is about escape sequences
    expect(plain.replace(/\x1b\[(?:1|22)m/g, '')).not.toContain('\x1b[');
    // ink-testing-library strips nothing: with colour enabled the title carries SGR codes, and the same text.
    const coloured = rawView({ color: true }).lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex -- the assertion is about escape sequences
    expect(coloured.replace(/\x1b\[[0-9;]*m/g, '')).toContain('◐ running  ·  run run-0001');
  });
});

describe('below 80×24', () => {
  it.each([
    { columns: 60, rows: 20 },
    { columns: 79, rows: 24 },
    { columns: 80, rows: 23 },
  ])(
    'is the enlarge line and the key line at $columns×$rows, with no live output',
    ({ columns, rows }) => {
      const { lastFrame } = view({
        columns,
        rows,
        store: storeWithNodes(3),
        notices: ['a notice'],
      });
      const lines = linesOf(lastFrame());
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        `Terminal too small (${String(columns)}×${String(rows)}) — resize to at least 80×24.`,
      );
      expect(lines[1]).toBe('[Ctrl+C] cancel the run (twice) · Esc leaves it running');
      expect(lastFrame()).not.toContain('node-00');
      expect(lastFrame()).not.toContain('note:');
    },
  );

  it('says that one more press cancels once armed: the person cannot see anything else, so the line must say so', () => {
    const { lastFrame } = view({ columns: 60, rows: 20, armed: true });
    expect(lastFrame()).toContain('[Ctrl+C] cancel the run (again)');
  });

  it('a settled run below the minimum reads "Esc / [Ctrl+C] close"', () => {
    const { lastFrame } = view({ columns: 60, rows: 20, hostedRun: settled(ended('completed')) });
    expect(linesOf(lastFrame()).at(-1)).toBe('Esc / [Ctrl+C] close');
  });

  it.each([
    { columns: 60, rows: 24 },
    { columns: 40, rows: 24 },
  ])(
    'a run that ended parked names only the keys that are delivered at $columns columns, and no row is wider than the terminal',
    ({ columns, rows }) => {
      for (const gateOpenFailed of [false, true]) {
        const { lastFrame } = view({
          columns,
          rows,
          hostedRun: settled(ended('paused', 'Open the run to continue it.')),
          openGate: true,
          gateOpenFailed,
          store: storeWithNodes(3),
          notices: ['a notice'],
        });
        const lines = linesOf(lastFrame());
        expect(lines).toHaveLength(2);
        expect(lines[1], 'Enter is not delivered here').toMatch(/^Esc \/ \[Ctrl\+C\] close/u);
        expect(lastFrame()).not.toContain('Enter');
        for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      }
    },
  );

  it('at 80×24 the same run names Enter, and below it does not: the key line follows the size the keys are delivered at', () => {
    const at = (columns: number, rows: number): string =>
      view({
        columns,
        rows,
        hostedRun: settled(ended('paused', 'Open the run to continue it.')),
        openGate: true,
      }).lastFrame() ?? '';
    expect(linesOf(at(80, 24)).at(-1)).toBe('Enter open the gate · Esc / [Ctrl+C] close');
    expect(linesOf(at(79, 24)).at(-1)).toBe('Esc / [Ctrl+C] close');
  });
});

describe('a notice wider than the terminal', () => {
  it('ends in an ellipsis inside the terminal, at 80 columns and on a wide one, in Latin and in wide characters', () => {
    for (const columns of [80, 120]) {
      const { lastFrame } = view({
        columns,
        notices: ['withheld effort warning '.repeat(30), '日本語のお知らせ'.repeat(30)],
      });
      const notes = linesOf(lastFrame()).filter((line) => line.startsWith('note: '));
      expect(notes).toHaveLength(2);
      for (const note of notes) {
        expect(note.endsWith('…'), `${String(columns)} columns: the cut is shown`).toBe(true);
        expect(displayWidth(note)).toBeLessThanOrEqual(columns);
      }
    }
  });
});

// ---- Through a mounted RootApp, with real stdin bytes ---------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const CTRL_C = '\x03';
const ESC = '\x1b';

function mountHome(
  options: {
    size?: { cols: number; rows: number };
    alternateScreen?: boolean;
    store?: RunStore;
  } = {},
) {
  let current: RunHostSnapshot = running();
  const cancel = vi.fn((): boolean => {
    if (current.active === undefined) return false;
    current = { ...current, active: { ...current.active, cancelling: true } };
    return true;
  });
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: {
      snapshot: () => current,
      cancel,
      close: () => Promise.resolve(),
      notices: { snapshot: () => ['a departure diagnostic'] },
    },
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  const size = options.size ?? { cols: 100, rows: 30 };
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
      {...(options.alternateScreen === undefined
        ? {}
        : { alternateScreen: options.alternateScreen })}
    />,
  );
  controller.openScreen('run-view', { runId: RUN, store: options.store });
  return {
    controller,
    harness,
    cancel,
    setHost: (next: RunHostSnapshot): void => {
      current = next;
    },
  };
}

describe.each([
  { mode: 'full-screen', alternateScreen: true },
  { mode: 'inline', alternateScreen: false },
])('through RootApp, $mode', ({ alternateScreen }) => {
  it('draws the view in place of the strip and the prompt, and the ladder works on real bytes', async () => {
    const { controller, harness, cancel } = mountHome({
      alternateScreen,
      store: storeWithNodes(2),
      size: { cols: 80, rows: 24 },
    });
    await waitFor(() => (harness.lastFrame() ?? '').includes('~ running'));
    const frame = harness.lastFrame() ?? '';
    expect(frame).toContain('note: a departure diagnostic');
    expect(frame).toContain('streamed line 3');
    expect(frame).not.toContain('[Ctrl+C] exit (twice)');
    expect(linesOf(frame).length).toBeLessThanOrEqual(23);

    harness.stdin.write(CTRL_C);
    await waitFor(() => controller.getSnapshot().interruptArmed);
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+C] cancel the run (again)'));
    expect(cancel, 'the first press only arms').not.toHaveBeenCalled();

    harness.stdin.write(CTRL_C);
    await waitFor(() => (harness.lastFrame() ?? '').includes('■ cancelling'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.lastFrame()).toContain('Cancelling · the run stops at its next safe point');
  });

  it('Esc brings the Home back with the leg still running, and the strip row is the way back', async () => {
    const { controller, harness, cancel } = mountHome({
      alternateScreen,
      size: { cols: 100, rows: 30 },
    });
    await waitFor(() => (harness.lastFrame() ?? '').includes('~ running'));
    harness.stdin.write(ESC); // a lone ESC is held back a moment while the input layer rules out an escape sequence
    await vi.waitFor(() => expect(controller.getSnapshot().screen).toBeUndefined(), {
      timeout: WAIT_MS,
    });
    await vi.waitFor(() => expect(harness.lastFrame()).toContain('~ run-0001'), {
      timeout: WAIT_MS,
    });
    expect(harness.lastFrame()).toContain('[Ctrl+C] exit (twice)');
    expect(cancel).not.toHaveBeenCalled();
    harness.stdin.write('\r');
    await waitFor(() => controller.getSnapshot().screen !== undefined);
    await waitFor(() => (harness.lastFrame() ?? '').includes('~ running  ·  run run-0001'));
    // `waitFor` only waits: what it waited for is asserted here, or the test would end on a stale frame.
    expect(controller.getSnapshot().screen, 'Enter brought the run view back').toMatchObject({
      kind: 'run-view',
      runId: 'run-0001',
    });
    expect(harness.lastFrame()).toContain('~ running  ·  run run-0001');
    expect(cancel, 'coming back to the view cancels nothing').not.toHaveBeenCalled();
  });

  it('below the minimum draws the enlarge line and still takes Esc and Ctrl+C, and nothing else', async () => {
    const { controller, harness, cancel } = mountHome({
      alternateScreen,
      size: { cols: 60, rows: 20 },
    });
    await waitFor(() => (harness.lastFrame() ?? '').includes('Terminal too small (60×20)'));
    expect(harness.lastFrame()).toContain('[Ctrl+C] cancel the run (twice)');
    harness.stdin.write('x');
    await settleFrames();
    expect(
      controller.getSnapshot().screen,
      'a letter below the minimum is not delivered',
    ).toBeDefined();
    harness.stdin.write(CTRL_C);
    await waitFor(() => controller.getSnapshot().interruptArmed);
    await waitFor(() => (harness.lastFrame() ?? '').includes('[Ctrl+C] cancel the run (again)'));
    expect(cancel).not.toHaveBeenCalled();
    harness.stdin.write(ESC);
    await vi.waitFor(() => expect(controller.getSnapshot().screen).toBeUndefined(), {
      timeout: WAIT_MS,
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});
