/**
 * The gate and budget cards of the Home, from the Attention rows and from the run view
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4), through a mounted `RootApp` and real
 * stdin bytes: a paused run of this project is a row of the landing, `↓` and `Enter` open its card, `Ctrl+Y` answers the gate once and only
 * when the card has been painted, and `Esc` and `Ctrl+C` close the card and decide nothing.
 *
 * `run-card-keys.test.ts` owns the card's guard, `home-budget-card.test.ts` the budget card's words and `home-attention.test.ts` the rows'
 * read; this file owns the wiring above them. The run host and the reads are scripted: no engine is built and no operator home is read.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { flush, settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerState,
  type HomeGateCardsPort,
} from './home-controller.js';
import type { RunCardSnapshot } from './run-card-model.js';
import type { ApprovalGuard } from './tool-review-model.js';

afterEach(cleanup);

const RUN = 'run-0001';
const CTRL_C = '\x03';
const CTRL_Y = '\x19';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
/** Every guard layer off: the tests of the guard are `run-card-keys.test.ts`'s, and what is left here is the painted frame. */
const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };

/** The one named bound of every wait in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5_000;

/**
 * Wait until `predicate` holds, and FAIL, naming it, when it does not within {@link WAIT_MS}: a lone `Esc` byte is held back by ink for
 * its escape-sequence window, so a bounded count of macrotask yields is not enough for it, and a wait that gave up quietly would let a
 * stale frame be asserted.
 */
async function eventually(predicate: () => boolean, what = 'the condition'): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(`${what} was not reached within ${String(WAIT_MS)} ms`);
    },
    { timeout: WAIT_MS, interval: 5 },
  );
}

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const PAUSED_END: HostedLegEnd = {
  leg: 'start',
  runId: RUN,
  terminal: {
    disposition: 'paused',
    safety: undefined,
    headline: `Run ${RUN} is paused at a gate.`,
    remedy: undefined,
  },
  handedOff: true,
  retirement: 'retired',
  fault: undefined,
};
const PARKED_HOST: RunHostSnapshot = { launching: false, active: undefined, last: PAUSED_END };

const ROW: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const APPROVAL_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review-step',
      gateType: 'approval',
      message: 'Ship the release?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};
const BUDGET_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [],
  budgetGates: [
    { gateId: 'b1', nodeId: 'writer', allowance: { kind: 'amount', microcents: 4_200_000 } },
  ],
  degraded: false,
};

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

interface Options {
  readonly rows?: readonly ParkedRunRow[];
  /** What the log says when the card opens: `undefined` is a run that is not parked here. */
  readonly run?: RunGates | undefined;
  readonly guard?: ApprovalGuard;
  /** The controller's monotonic clock, which the card's guard runs on (default the real one): a test of a dwell moves it by hand. */
  readonly now?: () => number;
  readonly host?: RunHostSnapshot;
  readonly size?: { cols: number; rows: number };
  readonly snapshot?: HomeSnapshot;
  readonly reply?: HostedLaunch;
}

function mount(options: Options = {}) {
  const resume = vi.fn(() => Promise.resolve(options.reply ?? STARTED));
  const rows = options.rows ?? [ROW];
  const run = 'run' in options ? options.run : APPROVAL_RUN;
  const list = vi.fn((): readonly ParkedRunRow[] => rows);
  const gateCards: HomeGateCardsPort = {
    list,
    read: (runId) => (runId === RUN ? run : undefined),
    resume,
    guard: options.guard ?? OFF,
  };
  const real = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => options.snapshot ?? EMPTY },
    hostedRuns: {
      snapshot: () => options.host ?? IDLE,
      cancel: () => false,
      close: () => Promise.resolve(),
    },
    gateCards,
    ...(options.now === undefined ? {} : { now: options.now }),
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  // The host's own evidence that a frame is on screen, as `RootApp` binds it: kept here so a test waits on THAT, not on a count of yields.
  let homeVisible: ((state: HomeControllerState) => boolean) | undefined;
  let cardVisible: ((snapshot: RunCardSnapshot) => boolean) | undefined;
  const controller: HomeController = {
    ...real,
    bindHomeFrame: (visible) => {
      homeVisible = visible;
      real.bindHomeFrame(visible);
    },
    bindGateCardFrame: (visible) => {
      cardVisible = visible;
      real.bindGateCardFrame(visible);
    },
  };
  const size = options.size ?? { cols: 100, rows: 30 };
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
    />,
  );
  const frame = (): string => harness.lastFrame() ?? '';
  /** The landing's exact current state has been measured and flushed. */
  const homePainted = (): boolean => homeVisible?.(controller.getSnapshot()) === true;
  /** The open card's exact current snapshot has been measured and flushed. */
  const cardPainted = (): boolean => {
    const screen = controller.getSnapshot().screen;
    return screen?.kind === 'gate-card' && cardVisible?.(screen.card.getSnapshot()) === true;
  };
  return { controller, harness, resume, list, frame, homePainted, cardPainted };
}

type Mounted = ReturnType<typeof mount>;

/** Open the card of the first parked row with the keys a person presses: `↓` onto the row, then `Enter`. */
async function openCard(m: Mounted): Promise<void> {
  await settleFrames();
  m.harness.stdin.write(DOWN);
  await eventually(
    () => m.controller.getSnapshot().stripFocus?.id !== undefined,
    'the focus on the row',
  );
  // `Enter` on a row counts only once the frame that shows the focus is on screen: wait for that evidence, not for a count of yields.
  await eventually(
    () => m.frame().includes('Enter opens') && m.homePainted(),
    'the focused row on screen',
  );
  m.harness.stdin.write(ENTER);
  await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
  await eventually(() => m.frame().includes('waiting for you'), 'the card`s frame');
}

/**
 * Press `Ctrl+Y` once the card's exact frame has been measured and flushed. A key before that is refused, and the test waits for the
 * host's own evidence (`bindGateCardFrame`) rather than pressing again until something gives.
 */
async function answerOnceThePaintLanded(m: Mounted): Promise<void> {
  await eventually(m.cardPainted, 'the card`s frame being painted');
  m.harness.stdin.write(CTRL_Y);
  await eventually(() => m.resume.mock.calls.length > 0, 'the answer reaching the run host');
}

describe('the Attention rows', () => {
  it('a paused run of this project is one row: its id, its gate kind and the key that selects it, under the heading', async () => {
    const m = mount();
    await settleFrames();
    const frame = m.frame();
    expect(frame).toContain('Attention required');
    expect(frame).toContain('‖ run-0001  ·  approval gate  ·  ↓ selects');
    expect(frame).toContain('↓ Open a parked run');
    expect(frame.split('\n').filter((line) => line.includes('run-0001'))).toHaveLength(1);
  });

  it('there is no row, no heading and no hint for it when nothing is paused', async () => {
    const m = mount({ rows: [] });
    await settleFrames();
    const frame = m.frame();
    expect(frame).not.toContain('‖');
    expect(frame).not.toContain('Attention required');
    expect(frame).not.toContain('Open a parked run');
    expect(frame).toContain('Welcome to Relavium.');
  });

  it('`↓` at the empty prompt moves onto the row, which then names Enter, and `Esc` returns to the prompt', async () => {
    const m = mount();
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(() => m.frame().includes('> ‖ run-0001  ·  approval gate  ·  Enter opens'));
    expect(m.frame()).toContain('Enter open the gate');
    expect(m.controller.getSnapshot().stripFocus?.id).toBe(RUN);
    m.harness.stdin.write(ESC);
    await eventually(() => m.controller.getSnapshot().stripFocus?.id === undefined);
    await eventually(() => m.frame().includes('↓ selects'));
    expect(m.frame()).not.toContain('Enter opens');
  });

  it('a recent run that is also a parked run is listed once, as the parked row, and the other recent runs still are', async () => {
    const recent = (runId: string, workflowSlug: string) => ({
      runId,
      workflowSlug,
      status: 'paused' as const,
      createdAt: '2026-11-23T00:00:00.000Z',
      startedAt: '2026-11-23T00:00:00.000Z',
      completedAt: undefined,
      totalCostMicrocents: 0,
    });
    const m = mount({
      snapshot: {
        ...EMPTY,
        isEmpty: false,
        recentRuns: [recent(RUN, 'deploy-flow'), recent('run-0002', 'nightly-flow')],
      },
    });
    await settleFrames();
    await eventually(() => m.frame().includes('Continue'), 'the Continue list');
    const frame = m.frame();
    expect(frame, 'the parked row, once').toContain('‖ run-0001  ·  approval gate');
    expect(frame.split('\n').filter((line) => line.includes('run-0001'))).toHaveLength(1);
    expect(frame, 'its recent-run row is not repeated under Runs').not.toContain('deploy-flow');
    expect(frame, 'a recent run that is not parked still is').toContain('nightly-flow');
  });

  it('the strip`s own gate row of the same run is not repeated beside it', async () => {
    const m = mount({
      snapshot: {
        ...EMPTY,
        isEmpty: false,
        attention: {
          gates: [
            {
              runId: RUN,
              workflowSlug: 'deploy',
              gateId: 'g1',
              gateType: 'approval',
              nodeId: 'review-step',
              message: 'Ship the release?',
              expiresAt: undefined,
            },
          ],
          failedRuns: [],
        },
      },
    });
    await settleFrames();
    const lines = m
      .frame()
      .split('\n')
      .filter((line) => line.includes('⚠') || line.includes('‖'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('‖ run-0001');
    expect(m.frame()).not.toContain('Ship the release?');
  });
});

describe('the Attention rows keep a row on screen at 80×24, whatever else the Home shows', () => {
  const ROWS: readonly ParkedRunRow[] = ['run-0001', 'run-0002', 'run-0003'].map((runId) => ({
    runId,
    kind: 'approval' as const,
    gates: 1,
  }));
  const LONG_NOTICE = Array.from({ length: 16 }, (_, n) => `report line ${String(n + 1)}`).join(
    '\n',
  );

  it('with a 16-line notice, `↓` never focuses a row that is not drawn: every focus is a row the frame shows', async () => {
    const m = mount({ rows: ROWS, size: { cols: 80, rows: 24 } });
    m.controller.setProviderState(false, LONG_NOTICE);
    await settleFrames();
    await eventually(() => m.frame().includes('report line 1'), 'the notice');
    const seen: string[] = [];
    for (const expected of ROWS) {
      m.harness.stdin.write(DOWN);
      await eventually(
        () => m.controller.getSnapshot().stripFocus?.id === expected.runId,
        `focus on ${expected.runId}`,
      );
      await eventually(
        () => m.frame().includes(`> ‖ ${expected.runId}`),
        `the row of ${expected.runId} drawn when it is focused`,
      );
      seen.push(expected.runId);
    }
    expect(seen).toEqual(ROWS.map((row) => row.runId));
    expect(m.frame().split('\n').length, 'the whole Home fits 24 rows').toBeLessThanOrEqual(24);
  });
});

describe('opening the card', () => {
  it('`Enter` on the focused row opens the card in front of the landing: the message behind the gutter, the gate and the keys', async () => {
    const m = mount();
    await openCard(m);
    const frame = m.frame();
    expect(frame).toContain('‖ waiting for you  ·  run run-0001');
    expect(frame).toContain('│ Ship the release?');
    expect(frame).toContain('node review-step · approval gate');
    expect(frame).toContain('Ctrl+Y approves · Ctrl+N rejects · Esc leaves it pending');
    expect(frame).not.toContain('Attention required');
    expect(m.controller.getSnapshot().screen).toMatchObject({ kind: 'gate-card', back: 'landing' });
  });

  it('a `↓` and an `Enter` in ONE chunk open nothing: the row is not on screen yet, so it is not the person`s choice', async () => {
    const m = mount();
    await settleFrames();
    m.harness.stdin.write(`${DOWN}${ENTER}`);
    await eventually(() => m.controller.getSnapshot().stripFocus?.id !== undefined, 'the focus');
    await settleFrames(8);
    expect(
      m.controller.getSnapshot().screen,
      'no card opened behind the unseen row',
    ).toBeUndefined();
    expect(m.resume).not.toHaveBeenCalled();
    // Once the frame that shows the focus is on screen, the same key opens it.
    await eventually(
      () => m.frame().includes('Enter opens') && m.homePainted(),
      'the focused row on screen',
    );
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
  });

  it('a run that is no longer parked here opens nothing and says so', async () => {
    const m = mount({ run: undefined });
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(
      () => m.frame().includes('Enter opens') && m.homePainted(),
      'the focused row on screen',
    );
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice !== undefined);
    expect(m.controller.getSnapshot().screen).toBeUndefined();
    expect(m.controller.getSnapshot().notice).toContain(
      'Not parked in this directory any more: run ',
    );
  });

  it('a parked run with no gate to decide opens no card and points at /workflows, not at a shell command', async () => {
    const m = mount({
      rows: [{ runId: RUN, kind: 'none', gates: 0 }],
      run: { runId: RUN, workflowId: 'wf', gates: [], budgetGates: [], degraded: false },
    });
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(
      () => m.frame().includes('Enter says why') && m.homePainted(),
      'the focused row on screen',
    );
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice !== undefined);
    expect(m.controller.getSnapshot().screen).toBeUndefined();
    expect(m.controller.getSnapshot().notice).toContain('No gate to decide here');
    expect(m.controller.getSnapshot().notice).toContain('see what it waits for in /workflows');
    expect(m.controller.getSnapshot().notice).not.toContain('relavium status');
    expect(m.controller.getSnapshot().notice).toContain('(run run-0001)');
  });

  it('a run that ended parked offers its card from the run view: the key line says so, `Enter` opens it, `Esc` returns to the view', async () => {
    const m = mount({ host: PARKED_HOST });
    await settleFrames();
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter opens the gate'));
    expect(m.frame()).toContain('Enter opens the gate · Esc / Ctrl+C close');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card');
    await eventually(() => m.frame().includes('waiting for you'));
    expect(m.controller.getSnapshot().screen).toMatchObject({ back: 'run-view' });
    m.harness.stdin.write(ESC);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'run-view');
    await eventually(() => m.frame().includes('paused'));
    expect(m.resume).not.toHaveBeenCalled();
  });

  it('`Enter` on a run that ended parked but cannot open says why in the run view itself, and the key line says it will try again', async () => {
    // The run was answered elsewhere meanwhile: the log no longer has it parked here.
    const m = mount({ host: PARKED_HOST, run: undefined });
    await settleFrames();
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter opens the gate'), 'the key line');
    m.harness.stdin.write(ENTER);
    await eventually(
      () => m.frame().includes('Not parked in this directory any more: run '),
      'the reason in the run view',
    );
    expect(m.frame()).toContain('note: Not parked in this directory any more: run run-0001.');
    expect(m.frame()).toContain('Enter tries the gate again · Esc / Ctrl+C close');
    expect(m.controller.getSnapshot().screen, 'the view stays; no card opened').toMatchObject({
      kind: 'run-view',
      runId: RUN,
    });
    // The landing`s notice is not where the person is looking: it is left alone.
    expect(m.controller.getSnapshot().notice).toBeUndefined();
    // It is the view's own note: it goes with the view.
    m.harness.stdin.write(ESC);
    await eventually(() => m.controller.getSnapshot().screen === undefined, 'the landing');
    expect(m.controller.getSnapshot().notice).toBeUndefined();
  });

  it('a run view of a run that did not end parked offers no gate: `Enter` does nothing there', async () => {
    const m = mount({
      host: {
        launching: false,
        active: undefined,
        last: { ...PAUSED_END, terminal: { ...PAUSED_END.terminal, disposition: 'completed' } },
      },
    });
    await settleFrames();
    m.controller.openScreen('run-view', { runId: RUN });
    await eventually(() => m.frame().includes('completed'));
    expect(m.frame()).not.toContain('Enter opens the gate');
    m.harness.stdin.write(ENTER);
    await settleFrames();
    expect(m.controller.getSnapshot().screen?.kind).toBe('run-view');
  });
});

describe('Ctrl+Y answers the gate once', () => {
  it('through the run host`s resume, as a human gate answer, and the card then says the run continues; a second key answers nothing', async () => {
    const m = mount();
    await openCard(m);
    await answerOnceThePaintLanded(m);
    expect(m.resume).toHaveBeenCalledOnce();
    expect(m.resume).toHaveBeenCalledWith({
      runId: RUN,
      gate: 'g1',
      kind: 'human',
      decision: { decision: 'approved', decidedBy: 'cli' },
    });
    await eventually(() => m.frame().includes('Answered. The run continues in the background.'));
    for (let press = 0; press < 5; press += 1) {
      m.harness.stdin.write(CTRL_Y);
      await flush();
    }
    expect(
      m.resume,
      'a gate that was answered leaves the card: no key answers it again',
    ).toHaveBeenCalledOnce();
  });

  it('a budget card answers as a budget resume with exactly the frozen allowance', async () => {
    const m = mount({ rows: [{ runId: RUN, kind: 'budget', gates: 1 }], run: BUDGET_RUN });
    await openCard(m);
    expect(m.frame()).toContain('Frozen allowance: $0.0420 (4200000 microcents)');
    await answerOnceThePaintLanded(m);
    expect(m.resume).toHaveBeenCalledOnce();
    expect(m.resume).toHaveBeenCalledWith({
      runId: RUN,
      gate: 'b1',
      kind: 'budget',
      decision: { decision: 'approved', decidedBy: 'cli', approvedAmountMicrocents: 4_200_000 },
    });
  });

  it('an unpriced budget card offers Abort only: Ctrl+Y answers nothing, however long it is pressed', async () => {
    const m = mount({
      rows: [{ runId: RUN, kind: 'budget', gates: 1 }],
      run: {
        ...BUDGET_RUN,
        budgetGates: [
          {
            gateId: 'b1',
            nodeId: 'writer',
            allowance: { kind: 'reject_only', reason: 'unpriced' },
          },
        ],
      },
    });
    await openCard(m);
    expect(m.frame()).toContain('no priced allowance');
    expect(m.frame()).toContain('Ctrl+N aborts · Esc leaves it pending');
    expect(m.frame()).not.toContain('Ctrl+Y');
    for (let press = 0; press < 20; press += 1) {
      m.harness.stdin.write(CTRL_Y);
      await flush();
    }
    expect(m.resume).not.toHaveBeenCalled();
  });
});

describe('a card that has not been painted refuses an answer', () => {
  it('a Ctrl+Y in the same breath as the Enter that opened the card is refused: the frame was not on screen yet', async () => {
    const m = mount();
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(
      () => m.frame().includes('Enter opens') && m.homePainted(),
      'the focused row on screen',
    );
    m.harness.stdin.write(ENTER);
    m.harness.stdin.write(CTRL_Y);
    await eventually(() => m.frame().includes('waiting for you'));
    expect(m.resume, 'refused: nothing was answered').not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen).toMatchObject({ kind: 'gate-card' });
    // The gate is still open and answers once its frame has been painted.
    await answerOnceThePaintLanded(m);
    expect(m.resume).toHaveBeenCalledOnce();
  });

  it('with no frame evidence bound at all, the card never takes an approval (controller only: nothing paints)', async () => {
    const resume = vi.fn(() => Promise.resolve(STARTED));
    const controller = createHomeController({
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => new Promise(() => {}),
      homeStore: { read: () => EMPTY },
      gateCards: { list: () => [ROW], read: () => APPROVAL_RUN, resume, guard: OFF },
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    controller.handleKey('', { downArrow: true });
    controller.handleKey('', { return: true });
    expect(controller.getSnapshot().screen?.kind).toBe('gate-card');
    controller.handleKey('y', { ctrl: true });
    await flush();
    expect(resume).not.toHaveBeenCalled();
    // Evidence that the exact frame is on screen is what makes the chord count.
    controller.bindGateCardFrame(() => true);
    const screen = controller.getSnapshot().screen;
    if (screen?.kind === 'gate-card') screen.card.shown(screen.card.getSnapshot());
    controller.handleKey('y', { ctrl: true });
    await flush();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('below 80×24 no chord is delivered to the card, and the card is the enlarge line and the keys', async () => {
    const m = mount({ size: { cols: 60, rows: 20 } });
    await settleFrames();
    // The landing is not drawn below the minimum, so the card is opened through the controller (the keys that reach it are the point).
    m.controller.handleKey('', { downArrow: true });
    m.controller.handleKey('', { return: true });
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card');
    await eventually(() => m.frame().includes('Terminal too small (60×20)'));
    for (let press = 0; press < 10; press += 1) {
      m.harness.stdin.write(CTRL_Y);
      await flush();
    }
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.frame()).not.toContain('Ship the release?');
  });
});

describe('Esc and Ctrl+C close the card and decide nothing', () => {
  it('Esc closes the card and the run stays parked: nothing is answered, and its row is back', async () => {
    const m = mount();
    await openCard(m);
    await settleFrames(8);
    m.harness.stdin.write(ESC);
    // Either outcome ends the wait, so a card that ANSWERED on Esc fails the assertions below instead of timing out.
    await eventually(
      () => m.controller.getSnapshot().screen === undefined || m.resume.mock.calls.length > 0,
    );
    expect(m.resume, 'Esc decides nothing').not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen).toBeUndefined();
    await eventually(() => m.frame().includes('Attention required'));
    expect(m.frame()).toContain('‖ run-0001');
    expect(m.controller.getSnapshot().parkedRuns).toEqual([ROW]);
  });

  it('Ctrl+C on the card closes it too: nothing is answered and the interrupt keymap is not armed', async () => {
    const m = mount();
    await openCard(m);
    await settleFrames(8);
    m.harness.stdin.write(CTRL_C);
    await eventually(() => m.controller.getSnapshot().screen === undefined);
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().interruptArmed).toBe(false);
    expect(m.frame()).not.toContain('Press Ctrl+C again to exit');
  });

  it('Ctrl+C on a card opened from the run view closes the card AND the view (ADR-0139 §5), arming nothing; Esc is the one step back', async () => {
    const m = mount({ host: PARKED_HOST });
    await settleFrames();
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter opens the gate'), 'the run view');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
    await eventually(() => m.frame().includes('waiting for you'), 'the card`s frame');
    m.harness.stdin.write(CTRL_C);
    await eventually(() => m.controller.getSnapshot().screen === undefined, 'the landing');
    expect(m.resume, 'a close decides nothing').not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().interruptArmed).toBe(false);
    expect(m.frame()).not.toContain('Press Ctrl+C again to exit');

    // Esc, by contrast, steps back to the view.
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter opens the gate'), 'the run view');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
    await settleFrames(8);
    m.harness.stdin.write(ESC);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'run-view', 'the run view');
  });

  it('a card closed while an answer is in flight does not take the answer back, and the closed card answers nothing more', async () => {
    const m = mount({ reply: STARTED });
    await openCard(m);
    await answerOnceThePaintLanded(m);
    m.harness.stdin.write(ESC);
    await eventually(() => m.controller.getSnapshot().screen === undefined);
    expect(m.resume).toHaveBeenCalledOnce();
    m.harness.stdin.write(CTRL_Y);
    await flush();
    expect(m.resume).toHaveBeenCalledOnce();
  });

  it('a paste into the card answers nothing, even a pasted letter that is a chord`s', async () => {
    const m = mount();
    await openCard(m);
    await settleFrames(8);
    m.controller.handlePaste('y');
    m.controller.handlePaste('\x19');
    await flush();
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen?.kind).toBe('gate-card');
  });
});

describe('the dwell, with the real stdin path and a dwell that is not zero', () => {
  /** What `run-card-keys.test.ts` pins on the model, here through the mounted app: the card's frame is acknowledged by the host. */
  const DWELL = { settleMs: 400, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 } as const;

  it('a Ctrl+Y inside the dwell of the painted frame answers nothing, and the one after it answers once', async () => {
    let now = 10_000;
    const m = mount({ guard: DWELL, now: () => now });
    await openCard(m);
    await eventually(m.cardPainted, 'the card`s frame being painted');
    // The frame was shown at `now`: 399 ms later is inside the dwell, and the card is still waiting.
    now += 399;
    m.harness.stdin.write(CTRL_Y);
    await settleFrames(8);
    expect(m.resume, 'inside the dwell: nothing was sent').not.toHaveBeenCalled();
    expect(m.controller.getSnapshot().screen).toMatchObject({ kind: 'gate-card' });
    // A refused key restarts nothing here (the lockout is off), and the dwell is over one millisecond later.
    now += 1;
    m.harness.stdin.write(CTRL_Y);
    await eventually(() => m.resume.mock.calls.length > 0, 'the answer reaching the run host');
    expect(m.resume).toHaveBeenCalledOnce();
  });

  it('a different gate under the cursor is a new frame: its dwell starts again', async () => {
    let now = 10_000;
    const second: RunGates = {
      ...APPROVAL_RUN,
      gates: [
        ...APPROVAL_RUN.gates,
        {
          runId: RUN,
          gateId: 'g2',
          nodeId: 'second-step',
          gateType: 'approval',
          message: 'And this one?',
          accepts: ['approved', 'rejected'],
        },
      ],
    };
    const m = mount({ guard: DWELL, now: () => now, run: second });
    await openCard(m);
    await eventually(m.cardPainted, 'the first gate painted');
    now += 1_000;
    m.harness.stdin.write(DOWN);
    await eventually(() => m.frame().includes('gate 2 of 2'), 'the second gate shown');
    // The dwell counts from the frame that SHOWS this gate: a key at once is refused, however old the first frame was.
    m.harness.stdin.write(CTRL_Y);
    await settleFrames(8);
    expect(m.resume).not.toHaveBeenCalled();
    await eventually(m.cardPainted, 'the second gate painted');
    now += 400;
    m.harness.stdin.write(CTRL_Y);
    await eventually(() => m.resume.mock.calls.length > 0, 'the answer reaching the run host');
    expect(m.resume).toHaveBeenCalledWith(expect.objectContaining({ gate: 'g2' }));
  });
});

describe('the message and the input gate, at 80×24 through the mounted app', () => {
  it('a message longer than the card`s room says where to read the rest, and the card is still answerable', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `step ${String(i + 1)}`).join('\n');
    const m = mount({
      size: { cols: 80, rows: 24 },
      run: {
        ...APPROVAL_RUN,
        gates: [{ ...APPROVAL_RUN.gates[0], message: long } as RunGates['gates'][number]],
      },
    });
    await openCard(m);
    const lines = m.frame().split('\n');
    expect(lines.length, 'the whole card fits 24 rows').toBeLessThanOrEqual(23);
    expect(m.frame()).toContain('step 1');
    expect(m.frame(), 'the tail is not on screen').not.toContain('step 30');
    expect(m.frame()).toContain('The message continues. To read all of it, run:');
    expect(m.frame()).toContain('relavium gate list run-0001');
    expect(m.frame()).toContain('Ctrl+Y approves · Ctrl+N rejects · Esc leaves it pending');
    await answerOnceThePaintLanded(m);
    expect(m.resume).toHaveBeenCalledOnce();
  });

  it('an input gate shows the whole command that takes its value, wrapped, says that rejecting continues the run, and its row says how', async () => {
    const m = mount({
      size: { cols: 80, rows: 24 },
      rows: [{ runId: RUN, kind: 'input', gates: 1 }],
      run: {
        ...APPROVAL_RUN,
        gates: [
          {
            runId: RUN,
            gateId: 'collect-the-token',
            nodeId: 'ask',
            gateType: 'input',
            message: 'Paste the deploy token',
            accepts: ['input_provided', 'rejected'],
          },
        ],
      },
    });
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(
      () => m.frame().includes('Enter shows how to answer') && m.homePainted(),
      'the focused input row, which says what Enter does',
    );
    expect(m.frame()).toContain('> ‖ run-0001  ·  input gate  ·  Enter shows how to answer');
    expect(m.frame()).toContain('Enter shows how');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
    await eventually(() => m.frame().includes('waiting for you'), 'the card`s frame');
    const frame = m.frame();
    expect(frame).toContain(
      'This gate takes a typed value, which this card cannot take. In a shell:',
    );
    expect(frame.replace(/\s+/g, ' ')).toContain(
      'relavium gate run-0001 --gate collect-the-token --input <json>',
    );
    expect(frame).toContain('Rejecting does not stop the run: the workflow routes on a rejection.');
    expect(frame).toContain('Ctrl+N rejects · Esc leaves it pending');
    expect(frame).not.toContain('Ctrl+Y approves');
  });
});

describe('what an Attention row says of the run it names', () => {
  const UUID = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';

  it('at 80×24 it names the workflow and the deadline beside the kind and the key, and the id gives way to them', async () => {
    const m = mount({
      size: { cols: 80, rows: 24 },
      // The app's clock reads 0: a deadline five minutes after the epoch is five minutes away.
      rows: [
        {
          runId: UUID,
          kind: 'approval',
          gates: 1,
          workflow: 'deploy',
          expiresAt: '1970-01-01T00:05:00.000Z',
        },
      ],
    });
    await settleFrames();
    const row = m
      .frame()
      .split('\n')
      .find((line) => line.includes('‖'));
    expect(row?.trimStart()).toBe(
      '‖ 0b8f3a5…  ·  deploy  ·  approval gate  ·  expires in 5m  ·  ↓ selects',
    );
    m.harness.stdin.write(DOWN);
    await eventually(
      () => m.frame().includes('Enter opens') && m.homePainted(),
      'the focused row on screen',
    );
    const focused = m
      .frame()
      .split('\n')
      .find((line) => line.includes('‖'));
    expect(focused?.trimStart()).toBe(
      '> ‖ 0b8f3a5…  ·  deploy  ·  approval gate  ·  expires in 5m  ·  Enter opens',
    );
    expect((focused ?? '').length, 'inside the 80 columns').toBeLessThanOrEqual(80);
  });

  it('an overdue gate says `expired` in the row, with colour off too', async () => {
    const m = mount({
      size: { cols: 80, rows: 24 },
      rows: [
        {
          runId: RUN,
          kind: 'approval',
          gates: 1,
          workflow: 'deploy',
          expiresAt: '1969-12-31T23:00:00.000Z',
        },
      ],
    });
    await settleFrames();
    expect(m.frame()).toContain(
      '‖ run-0001  ·  deploy  ·  approval gate  ·  expired  ·  ↓ selects',
    );
  });
});
