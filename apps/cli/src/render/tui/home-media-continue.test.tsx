/**
 * A parked run that waits on media jobs and nothing else, from the Home's landing
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note), through a
 * mounted `RootApp` and real stdin bytes: its strip row says `waiting for media`, `↓` and `Enter` ask the Home's question (never a gate
 * card, and never the dead end `No gate to decide here`), only a Yes starts a leg, and a run with a gate keeps its card.
 *
 * `run-host-media-resume.test.ts` owns the resume itself, `media-continue.test.ts` the question's own words and its default, and
 * `tab-host-active.test.ts` the same request from the Active tab. This file owns the wiring above them: the run host and the reads are
 * scripted, and no engine is built.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerDeps,
  type HomeControllerState,
  type HomeGateCardsPort,
} from './home-controller.js';
import type { ApprovalGuard } from './tool-review-model.js';

/** The Home's question for a media park, as the controller is handed it. */
type MediaQuestion = (runId: string) => Promise<string | undefined>;

afterEach(cleanup);

const RUN = 'run-0001';
const DOWN = '\x1b[B';
const ENTER = '\r';
const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
const WAIT_MS = 5_000;

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
const RUNNING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'resume', runId: RUN, cancelling: false },
  last: undefined,
};

const MEDIA_ROW: ParkedRunRow = { runId: RUN, kind: 'media', gates: 0 };
const MEDIA_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [],
  budgetGates: [],
  pendingMediaJobNodeIds: ['paint'],
  degraded: false,
};
const GATE_ROW: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1 };
const GATE_RUN: RunGates = {
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
  pendingMediaJobNodeIds: ['paint'],
  degraded: false,
};

interface Options {
  readonly row?: ParkedRunRow;
  readonly run?: RunGates;
  /** The question's answer: absent means no question is wired. */
  readonly continueMedia?: HomeControllerDeps['continueMedia'];
  readonly host?: () => RunHostSnapshot;
  readonly size?: { cols: number; rows: number };
}

function mount(options: Options = {}) {
  const resume = vi.fn(() => Promise.reject(new Error('a gate is not answered here')));
  const gateCards: HomeGateCardsPort = {
    list: () => [options.row ?? MEDIA_ROW],
    read: (runId) => (runId === RUN ? (options.run ?? MEDIA_RUN) : undefined),
    resume,
    guard: OFF,
  };
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: {
      snapshot: options.host ?? ((): RunHostSnapshot => IDLE),
      cancel: () => false,
      close: () => Promise.resolve(),
    },
    gateCards,
    ...(options.continueMedia === undefined ? {} : { continueMedia: options.continueMedia }),
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  let homeVisible: ((state: HomeControllerState) => boolean) | undefined;
  const bound: HomeController = {
    ...controller,
    bindHomeFrame: (visible) => {
      homeVisible = visible;
      controller.bindHomeFrame(visible);
    },
  };
  const size = options.size ?? { cols: 100, rows: 30 };
  const harness = render(
    <RootApp
      controller={bound}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
    />,
  );
  const frame = (): string => harness.lastFrame() ?? '';
  const homePainted = (): boolean => homeVisible?.(controller.getSnapshot()) === true;
  return { controller, harness, resume, frame, homePainted };
}

type Mounted = ReturnType<typeof mount>;

/** `↓` onto the first row, and wait for the frame that shows the focus: `Enter` counts only once it is on screen. */
async function focusRow(m: Mounted, cue: string): Promise<void> {
  await settleFrames();
  m.harness.stdin.write(DOWN);
  await eventually(
    () => m.controller.getSnapshot().stripFocus?.id !== undefined,
    'the focus on the row',
  );
  await eventually(() => m.frame().includes(cue) && m.homePainted(), 'the focused row on screen');
}

describe('the row of a media park', () => {
  it('says it waits for media, and its focused key says it asks: not "no gate to decide", not "Enter say why"', async () => {
    const m = mount();
    await settleFrames();
    expect(m.frame()).toContain('|| run-0001  ·  waiting for media  ·  ↓ select');
    expect(m.frame()).not.toContain('no gate to decide');
    m.harness.stdin.write(DOWN);
    await eventually(() =>
      m.frame().includes('> || run-0001  ·  waiting for media  ·  Enter ask to continue'),
    );
    expect(m.frame()).toContain('Enter continue it');
    expect(m.frame()).not.toContain('Enter say why');
    expect(m.frame()).not.toContain('Enter open the gate');
  });

  it('fits 80 columns: the hint bar is not cut short of the way out', async () => {
    const m = mount({ size: { cols: 80, rows: 24 } });
    await settleFrames();
    m.harness.stdin.write(DOWN);
    await eventually(() => m.frame().includes('Enter ask to continue'));
    const bar =
      m
        .frame()
        .split('\n')
        .find((line) => line.includes('Enter continue it')) ?? '';
    expect(bar).toBe(
      '↑/↓ select · Enter continue it · Esc return to prompt · [Ctrl+C] exit (twice)',
    );
    expect(bar.length).toBeLessThanOrEqual(80);
  });
});

describe('`Enter` on the focused row asks, and only a Yes starts a leg', () => {
  it('asks about that run once, with the keyboard the question`s from then on, and opens no gate card', async () => {
    let answer: (value: string | undefined) => void = () => undefined;
    const ask = vi.fn<MediaQuestion>(
      () =>
        new Promise<string | undefined>((resolve) => {
          answer = resolve;
        }),
    );
    const m = mount({ continueMedia: ask });
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(() => ask.mock.calls.length > 0, 'the question');
    expect(ask).toHaveBeenCalledWith(RUN);
    expect(m.controller.getSnapshot().screen, 'a question, not a card').toBeUndefined();
    expect(m.controller.getSnapshot().nativeActionBusy).toBe(true);
    // A second `Enter` while the question is open is the question's, not a second question.
    m.harness.stdin.write(ENTER);
    await settleFrames(4);
    expect(ask).toHaveBeenCalledTimes(1);
    answer(undefined);
    await eventually(() => !m.controller.getSnapshot().nativeActionBusy, 'the question closing');
    expect(m.resume, 'no gate was answered').not.toHaveBeenCalled();
  });

  it('a No (or Esc) changes nothing and says nothing: the run stays parked and the row stays focused', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({ continueMedia: ask });
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(
      () => ask.mock.calls.length > 0 && !m.controller.getSnapshot().nativeActionBusy,
    );
    const state = m.controller.getSnapshot();
    expect(state.screen).toBeUndefined();
    expect(state.notice).toBeUndefined();
    expect(state.stripFocus?.id).toBe(RUN);
    expect(state.parkedRuns).toEqual([MEDIA_ROW]);
  });

  it('a Yes that started the leg shows its run view at once, with the sentence kept for the landing', async () => {
    let started = false;
    const ask = vi.fn<MediaQuestion>(() => {
      started = true;
      return Promise.resolve<string | undefined>(
        `Continuing run ${RUN}. It runs in the background.`,
      );
    });
    const m = mount({ continueMedia: ask, host: () => (started ? RUNNING : IDLE) });
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'run-view', 'the run view');
    expect(m.controller.getSnapshot().screen).toMatchObject({
      kind: 'run-view',
      runId: RUN,
      from: 'landing',
    });
    expect(m.controller.getSnapshot().notice).toBe(
      `Continuing run ${RUN}. It runs in the background.`,
    );
  });

  it('a refusal (another leg already executes) is the landing`s notice and opens no view', async () => {
    const busy = 'A run is already executing: other-run.';
    const m = mount({ continueMedia: () => Promise.resolve(busy) });
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice === busy, 'the refusal');
    expect(m.controller.getSnapshot().screen).toBeUndefined();
  });

  it('a run this Home already executes is not offered: its view opens and nothing is asked', async () => {
    let executing = false;
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({ continueMedia: ask, host: () => (executing ? RUNNING : IDLE) });
    await focusRow(m, 'Enter ask to continue');
    // The leg that parked has not finished stopping when the person presses `Enter`: the row was read a moment ago.
    executing = true;
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'run-view', 'the run view');
    expect(ask).not.toHaveBeenCalled();
  });

  it('with no question wired the run says so, and it is not the dead end', async () => {
    const m = mount();
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice !== undefined);
    const notice = m.controller.getSnapshot().notice ?? '';
    expect(notice).toContain('Continuing a run is unavailable in this session');
    expect(notice).toContain('(run run-0001)');
    expect(notice).not.toContain('No gate to decide here');
  });
});

describe('from the run view of a leg that ended parked on media jobs', () => {
  const PAUSED_END: HostedLegEnd = {
    leg: 'start',
    runId: RUN,
    terminal: {
      disposition: 'paused',
      safety: undefined,
      headline: `Run ${RUN} is paused and waiting for an answer.`,
      remedy: undefined,
    },
    handedOff: true,
    retirement: 'retired',
    fault: undefined,
  };
  const PARKED: RunHostSnapshot = { launching: false, active: undefined, last: PAUSED_END };

  it('`Enter` asks the same question, and a No leaves the view as it was', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({ continueMedia: ask, host: () => PARKED });
    await settleFrames();
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter open the gate'));
    m.harness.stdin.write(ENTER);
    await eventually(() => ask.mock.calls.length > 0, 'the question');
    expect(ask).toHaveBeenCalledWith(RUN);
    await eventually(() => !m.controller.getSnapshot().nativeActionBusy, 'the question closing');
    expect(m.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: RUN });
    expect(m.controller.getSnapshot().notice).toBeUndefined();
  });

  it('a refusal is the view`s own note row, where the person who pressed `Enter` is looking', async () => {
    const m = mount({
      continueMedia: () => Promise.resolve('A run is already executing: other-run.'),
      host: () => PARKED,
    });
    await settleFrames();
    expect(m.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    await eventually(() => m.frame().includes('Enter open the gate'));
    m.harness.stdin.write(ENTER);
    await eventually(() => m.frame().includes('A run is already executing: other-run.'));
    expect(m.controller.getSnapshot().screen?.kind).toBe('run-view');
  });
});

describe('what stays as it was', () => {
  it('a run with a gate opens its gate card, even when a job is in flight beside it, and asks nothing', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({ row: GATE_ROW, run: GATE_RUN, continueMedia: ask });
    await focusRow(m, 'Enter open');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().screen?.kind === 'gate-card', 'the card');
    expect(ask).not.toHaveBeenCalled();
  });

  it('a run with neither a gate nor a job keeps the dead end`s sentence, and asks nothing', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({
      row: { runId: RUN, kind: 'none', gates: 0 },
      run: { ...MEDIA_RUN, pendingMediaJobNodeIds: [] },
      continueMedia: ask,
    });
    await focusRow(m, 'Enter say why');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice !== undefined);
    expect(m.controller.getSnapshot().notice).toContain('No gate to decide here');
    expect(ask).not.toHaveBeenCalled();
  });

  it('a media row whose log was damaged since it was read is the dead end`s sentence, never a question', async () => {
    const ask = vi.fn<MediaQuestion>(() => Promise.resolve<string | undefined>(undefined));
    const m = mount({ run: { ...MEDIA_RUN, degraded: true }, continueMedia: ask });
    await focusRow(m, 'Enter ask to continue');
    m.harness.stdin.write(ENTER);
    await eventually(() => m.controller.getSnapshot().notice !== undefined);
    expect(m.controller.getSnapshot().notice).toContain('No gate to decide here');
    expect(ask).not.toHaveBeenCalled();
  });
});
