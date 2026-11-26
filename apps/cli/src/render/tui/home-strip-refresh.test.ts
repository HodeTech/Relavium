/**
 * The strip becomes actionable, and it refreshes
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §6), through the real
 * Home controller: the idle tick reads the strip only when the change token moved, is paused while anything else has the screen, and leaves
 * no timer behind; the focus is the identity of a row, so a read that moves the row never moves the focus off it; and `Enter` does what the
 * row's kind says. `strip-focus.test.ts` owns the pure focus. The clock, the timer, the token and the reads are scripted: no database is
 * opened, no engine is built, and time moves only when a test says so.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChangeToken } from '../../history/change-probe.js';
import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  createHomeController,
  STRIP_REFRESH_MS,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { stripRows } from './strip-focus.js';
import type { HistoryPort } from './tab-host-history.js';

const DOWN = { downArrow: true } as const;
const UP = { upArrow: true } as const;
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

const runRow = (runId: string, status: HomeRunRow['status'] = 'completed'): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});
const sessionRow = (sessionId: string): HomeSessionRow => ({
  sessionId,
  workingDir: '/work',
  title: undefined,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const snapshotOf = (over: Partial<HomeSnapshot>): HomeSnapshot => ({
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: false,
  ...over,
});

/** `failed` runs, then `sessions`, then `recent` runs, which is the order the strip draws them. */
const strip = (
  failed: readonly string[],
  sessions: readonly string[],
  recent: readonly string[] = [],
): HomeSnapshot =>
  snapshotOf({
    attention: { gates: [], failedRuns: failed.map((id) => runRow(id, 'failed')) },
    recentSessions: sessions.map(sessionRow),
    recentRuns: recent.map((id) => runRow(id)),
  });

const APPROVAL_RUN = (runId: string): RunGates => ({
  runId,
  workflowId: 'wf',
  gates: [
    {
      runId,
      gateId: 'g1',
      nodeId: 'review-step',
      gateType: 'approval',
      message: 'Ship the release?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
});

interface RigOptions {
  readonly snapshot: HomeSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  readonly hosted?: RunHostSnapshot;
  /** Whether the Home has run history to open a run's detail from (default yes). */
  readonly history?: boolean;
  /** A session resume that never finishes: the Home's native form stays open for as long as the test lasts. */
  readonly resumeHangs?: boolean;
  /** What building the chat answers (default: never, so the Home stays in its `loading` build window). */
  readonly startChat?: () => Promise<HomeChatSession>;
  /** `onError` is called and returns (a fault ends the Home) instead of rethrowing the fault into the test. */
  readonly faultsEndTheHome?: boolean;
  /** A commit lands while the strip is first read: the token has moved by the time the read returns. */
  readonly commitDuringFirstRead?: boolean;
}

function rig(options: RigOptions) {
  let current = options.snapshot;
  let parked = options.parked ?? [];
  const token = { dataVersion: 1, generation: 0 };
  let closed = false;
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let readsFail = false;
  const read = vi.fn(() => {
    if (options.commitDuringFirstRead === true && read.mock.calls.length === 1)
      token.generation += 1;
    if (readsFail) throw new Error('database is locked');
    return current;
  });
  const list = vi.fn((): readonly ParkedRunRow[] => parked);
  const loads: { readonly runId: string; readonly resolve: (load: RunDetailLoad) => void }[] = [];
  const history: HistoryPort = {
    read: () => ({
      query: { scope: 'project', status: undefined, page: 0 },
      pinned: [],
      rows: [],
      hasPrev: false,
      hasNext: false,
    }),
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail: (runId) =>
      new Promise<RunDetailLoad>((resolve) => {
        loads.push({ runId, resolve });
      }),
  };
  const loadDetail = vi.spyOn(history, 'loadDetail');
  const resumeChat = vi.fn(() =>
    options.resumeHangs === true ? new Promise<undefined>(() => {}) : Promise.resolve(undefined),
  );
  const readGates = vi.fn((runId: string): RunGates | undefined => APPROVAL_RUN(runId));
  const resumeRun = vi.fn(() => Promise.reject(new Error('unused')));
  const onExit = vi.fn();
  const onError = vi.fn((cause: unknown) => {
    if (options.faultsEndTheHome !== true) throw cause;
  });
  // The Home's one notification channel (ADR-0148 §6): what a resume says when it ends without a conversation.
  const announced: string[] = [];
  const deps: HomeControllerDeps = {
    startChat: options.startChat ?? (() => new Promise(() => {})),
    homeStore: { read },
    ...(options.history === false ? {} : { history }),
    resumeChat,
    announce: (text) => announced.push(text),
    hostedRuns: {
      snapshot: () => options.hosted ?? IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    gateCards: { list, read: readGates, resume: resumeRun },
    strip: {
      token: (): ChangeToken => ({ ...token }),
      isClosed: () => closed,
    },
    schedule: (run, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    now: () => now,
    onExit,
    onError,
  };
  const controller = createHomeController(deps);
  /** Move time forward, firing every timer that falls due on the way, in order; then let the promises the ticks started settle. */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = end;
    await settle();
  };
  return {
    controller,
    read,
    list,
    loads,
    loadDetail,
    resumeChat,
    announced,
    readGates,
    resumeRun,
    onExit,
    onError,
    advance,
    /** Another process (or this one) wrote: the token the next tick compares has moved. */
    moveToken: (): void => {
      token.generation += 1;
    },
    show: (next: HomeSnapshot, nextParked?: readonly ParkedRunRow[]): void => {
      current = next;
      if (nextParked !== undefined) parked = nextParked;
    },
    close: (): void => {
      closed = true;
    },
    /** Every read of the strip throws from now on (or stops throwing). */
    failReads: (fails: boolean): void => {
      readsFail = fails;
    },
    pending: (): number => timers.size,
  };
}
type Rig = ReturnType<typeof rig>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};
const press = (controller: HomeController, key: object, times = 1): void => {
  for (let n = 0; n < times; n += 1) controller.handleKey('', key);
};
const focusOf = (r: Rig) => r.controller.getSnapshot().stripFocus;

describe('the idle tick reads the strip only when the change token moved', () => {
  it('reads nothing while the token stays where the Home read it, and once when it moves, and the strip shows what it read', async () => {
    const before = strip([], ['s1']);
    const r = rig({ snapshot: before });
    expect(r.read, 'the strip was read as the Home was built').toHaveBeenCalledTimes(1);
    expect(r.list).toHaveBeenCalledTimes(1);

    await r.advance(STRIP_REFRESH_MS * 4);
    expect(r.read, 'four ticks and the token never moved: nothing is read').toHaveBeenCalledTimes(
      1,
    );
    expect(r.list).toHaveBeenCalledTimes(1);
    expect(r.controller.getSnapshot().snapshot).toBe(before);

    const after = strip([], ['s1', 's2']);
    r.show(after);
    r.moveToken();
    expect(r.read, 'the token moved, and the poll looks at the next tick').toHaveBeenCalledTimes(1);
    await r.advance(STRIP_REFRESH_MS);
    expect(r.read, 'one read for the move').toHaveBeenCalledTimes(2);
    expect(r.list).toHaveBeenCalledTimes(2);
    expect(r.controller.getSnapshot().snapshot, 'and the strip shows it').toBe(after);

    await r.advance(STRIP_REFRESH_MS * 4);
    expect(r.read, 'and then nothing again').toHaveBeenCalledTimes(2);
  });

  it('publishes nothing when the read is what the strip already shows: an idle tick never repaints', async () => {
    const r = rig({
      snapshot: strip([], ['s1']),
      parked: [{ runId: 'p1', kind: 'approval', gates: 1 }],
    });
    const before = r.controller.getSnapshot();
    const seen = vi.fn();
    r.controller.subscribe(seen);
    r.show(strip([], ['s1']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(r.read, 'the token moved, so it was read').toHaveBeenCalledTimes(2);
    expect(r.controller.getSnapshot(), 'but it was the same strip').toBe(before);
    expect(seen).not.toHaveBeenCalled();
  });

  it('shows a parked run another terminal raised, from the same tick', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    expect(r.controller.getSnapshot().parkedRuns).toEqual([]);
    const row: ParkedRunRow = { runId: 'p1', kind: 'approval', gates: 1 };
    r.show(strip([], ['s1']), [row]);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(r.controller.getSnapshot().parkedRuns).toEqual([row]);
  });

  it('keeps the rows it has when a read fails, and reads again at the next tick', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    const first = r.controller.getSnapshot().snapshot;
    r.read.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(r.controller.getSnapshot().snapshot, 'the strip is as it was').toBe(first);
    expect(r.read).toHaveBeenCalledTimes(2);
    await r.advance(STRIP_REFRESH_MS);
    expect(
      r.read,
      'the failed read backs the next attempt off: twice the interval',
    ).toHaveBeenCalledTimes(2);
    await r.advance(STRIP_REFRESH_MS);
    expect(
      r.read,
      'the failed read was not applied, so the attempt after the wait reads again, token or not',
    ).toHaveBeenCalledTimes(3);
  });

  it('stops for good once the database is closed', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.close();
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(1);
    expect(r.pending(), 'and no timer is left to ask again').toBe(0);
  });
});

describe('the tick is paused while anything else has the screen', () => {
  /** What puts something in front of the landing, and how to take it away again. */
  const FRONT: readonly (readonly [string, (r: Rig) => void, (r: Rig) => void])[] = [
    [
      'the help sheet',
      (r) => expect(r.controller.openScreen('help')).toBe(true),
      (r) => r.controller.closeScreen(),
    ],
    [
      'a run view',
      (r) => expect(r.controller.openScreen('run-view', { runId: 'r1' })).toBe(true),
      (r) => r.controller.closeScreen(),
    ],
    [
      'a gate card',
      (r) => {
        press(r.controller, DOWN);
        press(r.controller, ENTER);
        expect(r.controller.getSnapshot().screen?.kind).toBe('gate-card');
      },
      (r) => r.controller.closeScreen(),
    ],
    [
      'the command palette',
      (r) => {
        r.controller.handleKey('/', {});
        expect(r.controller.getSnapshot().palette).toBeDefined();
      },
      (r) => press(r.controller, ESC),
    ],
  ];

  it.each(FRONT)(
    'reads nothing while %s is in front, though the token moved',
    async (_name, open) => {
      const r = rig({
        snapshot: strip([], ['s1']),
        parked: [{ runId: 'p1', kind: 'approval', gates: 1 }],
      });
      open(r);
      const reads = r.read.mock.calls.length;
      r.show(strip([], ['s1', 's2']));
      r.moveToken();
      await r.advance(STRIP_REFRESH_MS * 3);
      expect(r.read, 'three ticks with something in front: nothing is read').toHaveBeenCalledTimes(
        reads,
      );
      expect(r.pending(), 'the tick itself is paused, not stopped').toBe(1);
    },
  );

  it.each(FRONT)(
    'reads again once %s has gone and the token has moved',
    async (_name, open, close) => {
      const r = rig({
        snapshot: strip([], ['s1']),
        parked: [{ runId: 'p1', kind: 'approval', gates: 1 }],
      });
      open(r);
      const next = strip([], ['s1', 's2']);
      r.show(next);
      r.moveToken();
      await r.advance(STRIP_REFRESH_MS * 2);
      close(r);
      await r.advance(STRIP_REFRESH_MS);
      expect(r.controller.getSnapshot().screen).toBeUndefined();
      expect(r.controller.getSnapshot().snapshot, 'what moved meanwhile is shown').toBe(next);
    },
  );

  it.each([
    [79, 24],
    [80, 23],
    [40, 10],
  ] as const)(
    'reads nothing at %ix%i, below 80x24, and reads at the next tick once the terminal is big enough',
    async (columns, rows) => {
      const r = rig({ snapshot: strip([], ['s1']) });
      r.controller.setTerminalSize(columns, rows);
      const next = strip([], ['s1', 's2']);
      r.show(next);
      r.moveToken();
      await r.advance(STRIP_REFRESH_MS * 3);
      expect(r.read, 'a terminal that cannot show the strip is not asked to').toHaveBeenCalledTimes(
        1,
      );

      r.controller.setTerminalSize(80, 24);
      await r.advance(STRIP_REFRESH_MS);
      expect(r.read).toHaveBeenCalledTimes(2);
      expect(r.controller.getSnapshot().snapshot).toBe(next);
    },
  );

  it('reads nothing while a native form is open (a resume in flight), though the token moved', async () => {
    const r = rig({ snapshot: strip([], ['s1']), resumeHangs: true });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().nativeActionBusy).toBe(true);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  // `/models` is a popup now: the strip's pause under an open popup is the `popup` flag's (`overlay-flags.test.ts` pins its gates).

  it('reads nothing while the first chat is being built, though the token moved', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    for (const letter of 'hello') r.controller.handleKey(letter, {});
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().mode).toBe('loading');
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while a chat is in front, though the token moved', async () => {
    const session: HomeChatSession = {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId: 'sess-strip',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const r = rig({ snapshot: strip([], ['s1']), startChat: () => Promise.resolve(session) });
    for (const letter of 'hello') r.controller.handleKey(letter, {});
    press(r.controller, ENTER);
    await settle();
    expect(r.controller.getSnapshot().mode).toBe('chat');
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.controller.getSnapshot().palette).toBeUndefined();
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while the exit question is open, though the token moved', async () => {
    const hosted: RunHostSnapshot = {
      launching: false,
      active: { leg: 'start', runId: 'r1', cancelling: false },
      last: undefined,
    };
    const r = rig({ snapshot: strip([], ['s1']), hosted });
    r.controller.handleKey('d', { ctrl: true });
    expect(r.controller.getSnapshot().exitGuard).toBe('confirm');
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  it('reads the strip once when the landing comes back from a screen, without waiting for a tick', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.controller.openScreen('help');
    const next = strip([], ['s1', 's2']);
    r.show(next);
    r.moveToken();
    r.controller.closeScreen();
    await settle();
    expect(r.read, 'the return read it').toHaveBeenCalledTimes(2);
    expect(r.controller.getSnapshot().snapshot).toBe(next);
    await r.advance(STRIP_REFRESH_MS * 2);
    expect(r.read, 'and the tick after it finds nothing new').toHaveBeenCalledTimes(2);
  });
});

describe('the first tick compares with the token taken before the Home first read the strip', () => {
  it('reads at the first tick when a commit landed while the strip was first read, instead of taking it for what the Home shows', async () => {
    const r = rig({ snapshot: strip([], ['s1']), commitDuringFirstRead: true });
    expect(r.read).toHaveBeenCalledTimes(1);
    const after = strip([], ['s1', 's2']);
    r.show(after);
    await r.advance(STRIP_REFRESH_MS);
    expect(r.read, 'the token moved after it was taken').toHaveBeenCalledTimes(2);
    expect(r.controller.getSnapshot().snapshot).toBe(after);
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read, 'and then nothing again').toHaveBeenCalledTimes(2);
  });
});

describe('no timer is left running after the Home ends', () => {
  it('Ctrl+D at the empty prompt leaves nothing scheduled', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    expect(r.pending(), 'while the Home is open, the tick is armed').toBe(1);
    r.controller.handleKey('d', { ctrl: true });
    expect(r.onExit).toHaveBeenCalledTimes(1);
    expect(r.pending()).toBe(0);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read, 'and nothing reads afterwards').toHaveBeenCalledTimes(1);
  });

  it('a Home that ends on a fault leaves nothing scheduled either, and reads nothing afterwards', async () => {
    const r = rig({ snapshot: strip([], ['s1']), faultsEndTheHome: true });
    // A listener that throws is a fault of the Home: `notify` rethrows it, the tick's apply routes it to `failHome`.
    r.controller.subscribe(() => {
      throw new Error('a listener fault');
    });
    r.show(strip([], ['s1', 's2']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(r.onError).toHaveBeenCalledTimes(1);
    expect(r.pending()).toBe(0);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS * 3);
    expect(r.read).toHaveBeenCalledTimes(2);
  });

  it('a signal (the teardown) leaves nothing scheduled either', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    expect(r.pending()).toBe(1);
    await r.controller.teardownActive();
    expect(r.pending()).toBe(0);
  });
});

describe('the focus is the identity of a row, not its index', () => {
  it('a row inserted above the focused one moves the row and leaves the focus on it, and Enter opens that row', async () => {
    const r = rig({ snapshot: strip(['f1'], ['s1', 's2']) });
    press(r.controller, DOWN, 2); // f1, then s1
    expect(focusOf(r)).toEqual({ kind: 'session', id: 's1' });

    r.show(strip(['f0', 'f1'], ['s1', 's2']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r), 'a failed run came in above: the session is the third row now').toEqual({
      kind: 'session',
      id: 's1',
    });
    expect(
      stripRows(
        r.controller.getSnapshot().parkedRuns,
        r.controller.getSnapshot().snapshot,
      ).findIndex((row) => row.id === 's1'),
    ).toBe(2);

    press(r.controller, ENTER);
    await settle();
    expect(
      r.resumeChat,
      'Enter opens the session that was focused, not the row that took its index',
    ).toHaveBeenCalledWith('s1');
  });

  it('drops the focus when the focused row is gone, and moves it onto no other row: Enter then opens nothing', async () => {
    const r = rig({ snapshot: strip(['f1'], ['s1', 's2']) });
    press(r.controller, DOWN, 2);
    expect(focusOf(r)?.id).toBe('s1');

    // s1 is gone, and the row that now stands at its place is s2, another session: it is not what the person chose.
    r.show(strip(['f1'], ['s2']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r), 'the focus went with its row').toBeUndefined();
    press(r.controller, ENTER);
    await settle();
    expect(
      r.resumeChat,
      'Enter resumed no session: not the neighbour either',
    ).not.toHaveBeenCalled();
    expect(r.loadDetail).not.toHaveBeenCalled();
    expect(r.controller.getSnapshot().screen).toBeUndefined();

    // From the prompt `↓` starts again at the first row.
    press(r.controller, DOWN);
    expect(focusOf(r)?.id).toBe('f1');
  });

  it('is none for an empty strip', async () => {
    const r = rig({ snapshot: strip(['f1'], ['s1']) });
    press(r.controller, DOWN);
    expect(focusOf(r)?.id).toBe('f1');
    r.show(snapshotOf({ isEmpty: true }));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r)).toBeUndefined();
  });

  it('is kept by a refresh that changes nothing, and by one that adds rows below', async () => {
    const r = rig({ snapshot: strip(['f1'], ['s1']) });
    press(r.controller, DOWN);
    const focused = focusOf(r);
    r.show(strip(['f1'], ['s1']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r), 'the same object: nothing changed').toBe(focused);
    r.show(strip(['f1'], ['s1', 's2'], ['r1']));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r)).toEqual(focused);
  });
});

describe('↑ and ↓ walk the rows in the order the strip draws them', () => {
  it('goes parked runs, failed runs, sessions, recent runs; the last row stays; ↑ from the first returns to the prompt', () => {
    const r = rig({
      snapshot: strip(['f1'], ['s1'], ['r1']),
      parked: [{ runId: 'p1', kind: 'approval', gates: 1 }],
    });
    const walked: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      press(r.controller, DOWN);
      walked.push(focusOf(r)?.id ?? '-');
    }
    expect(walked).toEqual(['p1', 'f1', 's1', 'r1', 'r1']);
    press(r.controller, UP, 3); // from the last row up to the first
    expect(focusOf(r)?.id).toBe('p1');
    press(r.controller, UP);
    expect(focusOf(r), 'back at the prompt').toBeUndefined();
  });

  it('skips a run whose log could not be read: it stays a display row', () => {
    const r = rig({
      snapshot: snapshotOf({
        attention: { gates: [], failedRuns: [runRow('u1', 'failed'), runRow('f1', 'failed')] },
        unreadableRunIds: ['u1'],
      }),
    });
    press(r.controller, DOWN);
    expect(focusOf(r)?.id).toBe('f1');
  });

  it('only starts from an empty prompt, and Esc or any other key leaves the focus', () => {
    const r = rig({ snapshot: strip(['f1'], ['s1']) });
    r.controller.handleKey('a', {});
    press(r.controller, DOWN);
    expect(focusOf(r), 'a draft is not left for the rows').toBeUndefined();
    r.controller.handleKey('', { backspace: true });

    press(r.controller, DOWN);
    expect(focusOf(r)?.id).toBe('f1');
    press(r.controller, ESC);
    expect(focusOf(r)).toBeUndefined();
    press(r.controller, DOWN);
    r.controller.handleKey('x', {});
    expect(focusOf(r), 'a key that is typing starts typing').toBeUndefined();
    expect(r.controller.getSnapshot().input.text).toBe('x');
  });
});

describe('Enter does what the row says', () => {
  const tabHostOf = (r: Rig) => {
    const screen = r.controller.getSnapshot().screen;
    return screen?.kind === 'tab-host' ? screen.host : undefined;
  };

  it.each([
    ['a failed run', strip(['f1'], [], [])],
    ['a recent run', strip([], [], ['r1'])],
  ] as const)(
    'on %s it opens its detail in History, and Esc goes back to the list and then to the landing',
    async (_name, snapshot) => {
      const r = rig({ snapshot });
      const id = snapshot.attention.failedRuns[0]?.runId ?? snapshot.recentRuns[0]?.runId ?? '';
      press(r.controller, DOWN);
      expect(focusOf(r)?.id).toBe(id);
      press(r.controller, ENTER);

      const host = tabHostOf(r);
      expect(host?.tab).toBe('history');
      expect(host?.history?.detail).toMatchObject({ runId: id, phase: 'loading' });
      expect(r.loadDetail).toHaveBeenCalledWith(id);

      r.loads[0]?.resolve({ kind: 'missing' });
      await settle();
      expect(tabHostOf(r)?.history?.detail).toMatchObject({ runId: id, phase: 'missing' });

      press(r.controller, ESC);
      expect(tabHostOf(r)?.history?.detail, 'Esc steps back to the list').toBeUndefined();
      press(r.controller, ESC);
      expect(r.controller.getSnapshot().screen, 'and out to the landing').toBeUndefined();
      expect(focusOf(r)?.id, 'which is where the row it came from is still focused').toBe(id);
    },
  );

  it('on the run this Home hosts it shows the run view, not History: the leg is live, and the detail would only be the log', () => {
    const hosted: RunHostSnapshot = {
      launching: false,
      active: { leg: 'start', runId: 'r1', cancelling: false },
      last: undefined,
    };
    const r = rig({ snapshot: strip([], [], ['r1']), hosted });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view', runId: 'r1' });
    expect(r.loadDetail).not.toHaveBeenCalled();
  });

  it('on a parked run it opens its gate card, as it did', () => {
    const r = rig({
      snapshot: strip([], []),
      parked: [{ runId: 'p1', kind: 'approval', gates: 1 }],
    });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'gate-card', runId: 'p1' });
    expect(r.loadDetail).not.toHaveBeenCalled();
  });

  it('on a session it resumes it, as it did', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    await settle();
    expect(r.resumeChat).toHaveBeenCalledWith('s1');
    expect(r.loadDetail).not.toHaveBeenCalled();
  });

  it('on a paused run of another directory (a recent row, not a parked one) it opens its detail in History: no card, no resume', async () => {
    // The strip's recent runs are read across every directory, and only this directory's paused runs are parked rows with a card
    // (ADR-0139 §7): a budget-paused run recorded for another directory is an ordinary `paused` row of Continue.
    const snapshot = snapshotOf({ recentRuns: [runRow('elsewhere', 'paused')] });
    const r = rig({ snapshot });
    expect(r.controller.getSnapshot().parkedRuns).toEqual([]);
    press(r.controller, DOWN);
    expect(focusOf(r)).toMatchObject({ kind: 'run', id: 'elsewhere' });
    press(r.controller, ENTER);
    expect(tabHostOf(r)?.history?.detail).toMatchObject({ runId: 'elsewhere', phase: 'loading' });
    expect(r.readGates, 'no gate card is read for it').not.toHaveBeenCalled();
    expect(r.resumeRun, 'and nothing is resumed').not.toHaveBeenCalled();
    r.loads[0]?.resolve({ kind: 'missing' });
    await settle();
    expect(r.resumeRun).not.toHaveBeenCalled();
  });

  it('says so when the Home has no run history to open a run from, and opens nothing', () => {
    const r = rig({ snapshot: strip(['f1'], []), history: false });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.controller.getSnapshot().notice).toContain('run history is not available');
  });
});

describe('a strip whose reads keep failing is read less and less often', () => {
  /** Move to `ms` after the last mark, in two steps: nothing reads one millisecond before, and exactly one read lands at `ms`. */
  const nextReadAt = async (r: Rig, ms: number, reads: number): Promise<number> => {
    await r.advance(ms - 1);
    expect(r.read, `no read before ${String(ms)} ms have passed`).toHaveBeenCalledTimes(reads);
    await r.advance(1);
    expect(r.read, `one read at ${String(ms)} ms`).toHaveBeenCalledTimes(reads + 1);
    return reads + 1;
  };

  it('waits twice as long after each failed read: 5, 10, 20, 40 and then 60 s at most', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.failReads(true);
    r.moveToken();
    let reads = r.read.mock.calls.length;
    for (const seconds of [5, 10, 20, 40, 60, 60, 60]) {
      reads = await nextReadAt(r, seconds * 1000, reads);
    }
    expect(r.pending(), 'one timer is armed, and no second one was left behind').toBe(1);
  });

  it('is back at one interval after a read that was applied', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.failReads(true);
    r.moveToken();
    let reads = r.read.mock.calls.length;
    for (const seconds of [5, 10, 20]) reads = await nextReadAt(r, seconds * 1000, reads);
    r.failReads(false);
    const healed = strip([], ['s1', 's2']);
    r.show(healed);
    reads = await nextReadAt(r, 40_000, reads);
    expect(r.controller.getSnapshot().snapshot, 'the read that worked is shown').toBe(healed);

    // The wait is one interval again (not the 80 s the failures called for), so a change is read one interval later.
    const next = strip([], ['s1', 's2', 's3']);
    r.show(next);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS - 1);
    expect(r.read).toHaveBeenCalledTimes(reads);
    await r.advance(1);
    expect(r.read, 'read one interval after the one that worked').toHaveBeenCalledTimes(reads + 1);
    expect(r.controller.getSnapshot().snapshot).toBe(next);
  });

  it('starts again at the first retry when the change token moved since the last attempt', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.failReads(true);
    r.moveToken();
    let reads = r.read.mock.calls.length;
    for (const seconds of [5, 10, 20]) reads = await nextReadAt(r, seconds * 1000, reads);
    // The next attempt is 40 s away. Something wrote meanwhile: that attempt fails again, and its retry is the first one's, not the 60 s.
    r.moveToken();
    reads = await nextReadAt(r, 40_000, reads);
    reads = await nextReadAt(r, 10_000, reads);
    reads = await nextReadAt(r, 20_000, reads);
  });

  it('leaves no timer behind when the Home ends in the middle of a wait', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    r.failReads(true);
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS); // the first failure: the next attempt is 10 s away
    expect(r.pending()).toBe(1);
    r.controller.handleKey('d', { ctrl: true });
    expect(r.onExit).toHaveBeenCalledTimes(1);
    expect(r.pending()).toBe(0);
    await r.advance(STRIP_REFRESH_MS * 6);
    expect(r.read).toHaveBeenCalledTimes(2);
  });
});

describe('a failed read of the parked rows is a failed read of the strip', () => {
  it('keeps the rows it has, and reads again after the wait without the token moving, so the rows that were missed appear', async () => {
    const before: ParkedRunRow = { runId: 'p1', kind: 'approval', gates: 1 };
    const raised: ParkedRunRow = { runId: 'p2', kind: 'approval', gates: 1 };
    const r = rig({ snapshot: strip([], ['s1']), parked: [before] });
    expect(r.controller.getSnapshot().parkedRuns).toEqual([before]);

    r.show(strip([], ['s1']), [before, raised]);
    r.list.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(r.list, 'the tick asked for the parked rows').toHaveBeenCalledTimes(2);
    expect(
      r.controller.getSnapshot().parkedRuns,
      'the rows the strip had stay: they are not replaced by an empty list',
    ).toEqual([before]);

    // The failed read was not applied: after the doubled wait the strip reads again with no new commit, and the rows appear.
    await r.advance(STRIP_REFRESH_MS * 2 - 1);
    expect(r.list).toHaveBeenCalledTimes(2);
    await r.advance(1);
    expect(r.list).toHaveBeenCalledTimes(3);
    expect(r.controller.getSnapshot().parkedRuns).toEqual([before, raised]);

    await r.advance(STRIP_REFRESH_MS * 4);
    expect(
      r.list,
      'and once it was applied, an unchanged token reads nothing more',
    ).toHaveBeenCalledTimes(3);
  });
});

describe('the Enter after a refresh dropped the focused row is not the empty prompt’s', () => {
  const hosted: RunHostSnapshot = {
    launching: false,
    active: { leg: 'start', runId: 'hosted-run', cancelling: false },
    last: undefined,
  };
  /** A focus on a session that then vanishes on a tick, with a run executing: the empty prompt's `Enter` would open its view. */
  async function dropped() {
    const r = rig({ snapshot: strip([], ['s1']), hosted });
    press(r.controller, DOWN);
    expect(focusOf(r)).toEqual({ kind: 'session', id: 's1' });
    r.show(strip([], []));
    r.moveToken();
    await r.advance(STRIP_REFRESH_MS);
    expect(focusOf(r), 'the focus went with its row').toBeUndefined();
    return r;
  }

  it('is ignored once, with no notice, and the next one is the prompt’s own', async () => {
    const r = await dropped();
    press(r.controller, ENTER);
    await settle();
    expect(r.controller.getSnapshot().screen, 'no run view opened').toBeUndefined();
    expect(r.resumeChat).not.toHaveBeenCalled();
    expect(r.controller.getSnapshot().notice, 'and nothing is said').toBeUndefined();

    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({
      kind: 'run-view',
      runId: 'hosted-run',
    });
  });

  it('ends with any other key: the Enter after one is the prompt’s own', async () => {
    const r = await dropped();
    r.controller.handleKey('x', {});
    r.controller.handleKey('', { backspace: true });
    expect(r.controller.getSnapshot().input.text).toBe('');
    press(r.controller, ENTER);
    expect(r.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view' });
  });

  it('is not set by a focus the person left (Esc), nor by a refresh that kept the row', async () => {
    const r = rig({ snapshot: strip([], ['s1']), hosted });
    press(r.controller, DOWN);
    press(r.controller, ESC);
    press(r.controller, ENTER);
    expect(
      r.controller.getSnapshot().screen,
      'the first Enter after an Esc is the prompt’s',
    ).toMatchObject({
      kind: 'run-view',
    });

    const kept = rig({ snapshot: strip([], ['s1']), hosted });
    press(kept.controller, DOWN);
    kept.show(strip([], ['s1', 's2']));
    kept.moveToken();
    await kept.advance(STRIP_REFRESH_MS);
    expect(focusOf(kept)).toEqual({ kind: 'session', id: 's1' });
    press(kept.controller, ESC);
    press(kept.controller, ENTER);
    expect(kept.controller.getSnapshot().screen).toMatchObject({ kind: 'run-view' });
  });
});

describe('a resume the person cancelled says so', () => {
  it('on a strip session whose resume returns nothing, the fixed sentence is one notification, never the landing`s notice', async () => {
    const r = rig({ snapshot: strip([], ['s1']) });
    press(r.controller, DOWN);
    press(r.controller, ENTER);
    await settle();
    expect(r.resumeChat).toHaveBeenCalledWith('s1');
    expect(r.announced).toEqual(['Resume cancelled.']);
    expect(r.controller.getSnapshot().notice).toBeUndefined();
    expect(r.controller.getSnapshot().mode).toBe('home');
    expect(r.controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});
