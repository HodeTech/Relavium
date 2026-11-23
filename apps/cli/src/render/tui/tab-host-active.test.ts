/**
 * The Active tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4). Two halves. The first is the pure model: every class of run drawn with a glyph and a word, the "N more" row, what a key
 * does (and what it refuses), and that the cursor follows a run. The second drives the real Home controller over a scripted poll and clock:
 * the tab reads when it is entered and again only when the change token moved, a paused row opens its gate card and `Esc` returns to the tab
 * on the same row, the poll reads nothing while the card is open, and closing, leaving the tab and tearing the Home down leave no timer.
 */
import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { classifyActiveRuns, type ActiveRow } from '../../history/active-model.js';
import type { ActiveRead } from '../../history/active-source.js';
import { createChangeProbe } from '../../history/change-probe.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import {
  createHomeController,
  type HomeActivePort,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { legend } from './legend.js';
import { usableColumns } from './sheet-frame.js';
import {
  TAB_HOST_ROWS,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegendItems,
  tabHostLines,
  tabHostMemory,
  withActiveRead,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
} from './tab-host.js';
import {
  ACTIVE_EMPTY,
  ACTIVE_FRESHNESS,
  ACTIVE_HELD_UNREAD,
  ACTIVE_KEYS,
  ACTIVE_LOADING,
  ACTIVE_STALE_READ,
  ACTIVE_UNREADABLE,
  activeGroupOf,
} from './tab-host-active.js';
import { displayWidth } from './viewport.js';

const HERE = '/work/here';
const THERE = '/work/there';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const TTL = 60_000;

const UP: ChatKey = { upArrow: true };
const DOWN: ChatKey = { downArrow: true };
const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };

function run(
  id: string,
  status: RunStatus,
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord {
  return {
    id,
    workflowId: 'wf',
    status,
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: new Date(NOW - 5_000).toISOString(),
    updatedAt: new Date(NOW - 5_000).toISOString(),
    projectRoot: HERE,
    ...over,
  };
}

/** The nine kinds of row the tab can show, each with an id of its own: the model's classification of real summaries. */
const IDS = {
  hosted: 'hostrun1',
  other: 'otherrun',
  pending: 'pendrun1',
  gate: 'gaterun1',
  media: 'mediarun',
  unknown: 'unknownr',
  elsewhere: 'elserun1',
  stalled: 'stallrun',
  held: 'heldrun1',
} as const;

function classify(
  runs: readonly RunSummaryRecord[],
  over: Partial<Parameters<typeof classifyActiveRuns>[0]> = {},
): ActiveRow[] {
  return classifyActiveRuns({
    runs,
    leases: new Map(),
    currentProjectRoot: HERE,
    outboxHeldRunIds: new Set(),
    nowMs: NOW,
    leaseTtlMs: TTL,
    ...over,
  });
}

const EVERY_CLASS: ActiveRow[] = classify(
  [
    run(IDS.hosted, 'running'),
    run(IDS.other, 'running'),
    run(IDS.pending, 'pending'),
    run(IDS.gate, 'paused'),
    run(IDS.media, 'paused'),
    run(IDS.unknown, 'paused'),
    run(IDS.elsewhere, 'paused', { projectRoot: THERE }),
    run(IDS.stalled, 'running', { createdAt: new Date(NOW - 5 * TTL).toISOString() }),
    run(IDS.held, 'running'),
  ],
  {
    hostedRunId: IDS.hosted,
    outboxHeldRunIds: new Set([IDS.held]),
    pendingGateCounts: new Map([
      [IDS.gate, 1],
      [IDS.media, 0],
    ]),
  },
);

const read = (rows: readonly ActiveRow[], over: Partial<ActiveRead> = {}): ActiveRead => ({
  rows,
  more: [],
  heldUnread: false,
  ...over,
});

const ROWS = 23;
const SIZE = { columns: 80, terminalRows: 24 };
const textOf = (state: TabHostState, geometry = SIZE): string[] =>
  tabHostLines(state, geometry).map((line) => line.text);
const lineWith = (lines: readonly string[], needle: string): string =>
  lines.find((line) => line.includes(needle)) ?? '';

/** The Active tab over `last`, with the keys going through the tab host's own fold. */
function rig(last: ActiveRead | null = read(EVERY_CLASS)) {
  // `null` is a tab entered before any read; `undefined` would take the default.
  const context = (over: Partial<TabHostContext> = {}): TabHostContext => ({
    port: undefined,
    now: 0,
    canArm: true,
    active: { last: last ?? undefined },
    ...over,
  });
  let state: TabHostState = enterTab(freshTabMemory('active'), 'active', context());
  const press = (input: string, key: ChatKey = {}): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context());
    if (step.kind !== 'close') state = step.state;
    return step;
  };
  return {
    press,
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
  };
}
const active = (state: TabHostState) => {
  if (state.active === undefined) throw new Error('the Active tab holds no state');
  return state.active;
};
const focusedId = (state: TabHostState): string | undefined => active(state).focus;

describe('every class of run is drawn with a glyph and a word', () => {
  const lines = textOf(rig().state);

  it.each([
    [IDS.hosted, '◐', 'running', 'this Home'],
    [IDS.other, '◐', 'running', 'running in another process'],
    [IDS.pending, '○', 'pending', 'running in another process'],
    [IDS.gate, '⏸', 'paused', 'gate waiting here'],
    [IDS.media, '⏸', 'paused', 'waiting for a media job'],
    [IDS.unknown, '⏸', 'paused', 'gate state not read'],
    [IDS.elsewhere, '⏸', 'paused', 'another project'],
    [IDS.stalled, '⚠', 'stalled', 'settled by the next start'],
    [IDS.held, '◇', 'held', 'terminal held in the outbox'],
  ])('%s: %s %s, and says why (%s)', (id, glyph, word, why) => {
    const line = lineWith(lines, id);
    expect(line, `a row for ${id}`).not.toBe('');
    expect(line).toContain(`${glyph} ${word}`);
    expect(line).toContain(why);
  });

  it('lists the groups in the order running, paused, stalled, held', () => {
    const groups = active(rig().state).rows.map(activeGroupOf);
    const order = ['running', 'paused', 'stalled', 'held'];
    const indexes = groups.map((group) => order.indexOf(group));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(groups)).toEqual(new Set(order));
  });

  it('a damaged log says `gate state not read` and never "media job"', () => {
    const line = lineWith(lines, IDS.unknown);
    expect(line).toContain('gate state not read');
    expect(line).not.toContain('media job');
    expect(lineWith(lines, IDS.media)).toContain('media job');
  });

  it('puts the leg this Home runs under running, whatever the database says of its status', () => {
    const [row] = classify([run(IDS.hosted, 'paused')], { hostedRunId: IDS.hosted });
    if (row === undefined) throw new Error('unreachable');
    expect(activeGroupOf(row)).toBe('running');
  });

  it('fits 23 rows and the usable width at 80×24 and on a wide terminal, and below 80×24 is the one line that says to enlarge', () => {
    for (const geometry of [SIZE, { columns: 200, terminalRows: 60 }]) {
      const drawn = textOf(rig().state, geometry);
      expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
      for (const line of drawn)
        expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(geometry.columns));
    }
    const small = textOf(rig().state, { columns: 60, terminalRows: 20 });
    expect(small[0]).toBe('Enlarge the terminal to use this screen — Esc closes.');
    expect(small.join('\n')).not.toContain(IDS.hosted);
    expect(ROWS).toBe(TAB_HOST_ROWS);
  });

  it('draws the freshness note under the list until a message or a warning takes its place', () => {
    expect(textOf(rig().state)).toContain(ACTIVE_FRESHNESS);
    const warned = rig(read(EVERY_CLASS, { heldUnread: true }));
    expect(textOf(warned.state)).toContain(ACTIVE_HELD_UNREAD);
    expect(textOf(warned.state)).not.toContain(ACTIVE_FRESHNESS);
  });
});

describe('the "N more" row', () => {
  const more = read(EVERY_CLASS, {
    more: [
      { status: 'running', count: 37, atLeast: false },
      { status: 'paused', count: 200, atLeast: true },
    ],
  });

  it('says how many runs lie past the rows kept, per status, and says `+` when the count stopped at a page', () => {
    const lines = textOf(rig(more).state);
    expect(lines).toContain('… 37 more running not listed');
    expect(lines).toContain('… 200+ more paused not listed');
  });

  it('is absent when nothing lies past the rows', () => {
    expect(textOf(rig().state).join('\n')).not.toContain('not listed');
  });

  it('is drawn with an empty list too, and the list still fits 23 rows with the markers and a long list', () => {
    const empty = textOf(rig(read([], { more: more.more })).state);
    expect(empty).toContain(ACTIVE_EMPTY);
    expect(empty).toContain('… 37 more running not listed');
    const many = classify(
      Array.from({ length: 60 }, (_, index) =>
        run(`many${String(index).padStart(4, '0')}`, 'running'),
      ),
    );
    const drawn = textOf(rig(read(many, { more: more.more })).state);
    expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(drawn).toContain('… 37 more running not listed');
    expect(drawn.some((line) => line.startsWith('› '))).toBe(true);
  });
});

describe('what a key does', () => {
  it('↑ and ↓ move the cursor and stop at the ends', () => {
    const r = rig();
    const last = active(r.state).rows.length - 1;
    r.press('', UP);
    expect(active(r.state).cursor).toBe(0);
    for (let i = 0; i < last + 3; i += 1) r.press('', DOWN);
    expect(active(r.state).cursor).toBe(last);
  });

  it('Enter on the leg this Home hosts asks for its view, with that run’s id', () => {
    const r = rig();
    const step = r.press('', ENTER);
    expect(step).toMatchObject({ kind: 'open-view', runId: IDS.hosted });
  });

  it('Enter on a run paused at a gate in this project asks for its gate card, and for nothing else', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.gate) r.press('', DOWN);
    expect(r.press('', ENTER)).toMatchObject({ kind: 'open-gate', runId: IDS.gate });
  });

  it.each([IDS.other, IDS.pending, IDS.media, IDS.unknown, IDS.elsewhere, IDS.stalled, IDS.held])(
    'Enter on %s opens nothing: it says the row is read-only, and why',
    (id) => {
      const r = rig();
      while (focusedId(r.state) !== id) r.press('', DOWN);
      const step = r.press('', ENTER);
      expect(step.kind).toBe('state');
      const message = active(r.state).message ?? '';
      expect(message).toMatch(/^Read-only: /u);
      expect(textOf(r.state)).toContain(message);
    },
  );

  it('says there is no cross-process cancel for a run another process owns', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.other) r.press('', DOWN);
    expect(textOf(r.state).join('\n')).toContain('no cross-process cancel');
  });

  it('a message goes with the next key', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.other) r.press('', DOWN);
    r.press('', ENTER);
    expect(active(r.state).message).toBeDefined();
    r.press('', UP);
    expect(active(r.state).message).toBeUndefined();
  });

  it('a chord or a letter is nothing: no run is cancelled, retried or edited from here', () => {
    const r = rig();
    const before = r.state;
    for (const [input, key] of [
      ['c', {}],
      ['r', {}],
      ['x', {}],
      ['d', {}],
      ['', { return: true, ctrl: true }],
      ['', { return: true, meta: true }],
      ['', { downArrow: true, ctrl: true }],
    ] as const) {
      const step = r.press(input, key);
      expect(step.kind, `${input} ${JSON.stringify(key)}`).toBe('state');
    }
    expect(r.state).toEqual(before);
  });

  it('an Enter with no row makes no step', () => {
    const r = rig(read([]));
    expect(r.press('', ENTER).kind).toBe('state');
  });

  it('presses every key the legend names, and each does what it says', () => {
    const r = rig();
    const items = tabHostLegendItems(r.state);
    expect(items).toContain(ACTIVE_KEYS.select);
    expect(items).toContain(ACTIVE_KEYS.open);
    const before = active(r.state).cursor;
    r.press('', DOWN);
    expect(active(r.state).cursor, `${ACTIVE_KEYS.select.keys} ${ACTIVE_KEYS.select.verb}`).toBe(
      before + 1,
    );
    r.press('', UP);
    expect(r.press('', ENTER).kind, `${ACTIVE_KEYS.open.keys} ${ACTIVE_KEYS.open.verb}`).not.toBe(
      'close',
    );
  });

  it('names no key it does not answer to: an empty list offers neither select nor open, and the way out is last', () => {
    const full = legend(tabHostLegendItems(rig().state));
    expect(full).toBe('←/→ tab · Tab cycle · ↑/↓ select · Enter open · Esc close');
    const empty = legend(tabHostLegendItems(rig(read([])).state));
    expect(empty).toBe('←/→ tab · Tab cycle · Esc close');
    const loading = legend(tabHostLegendItems(rig(null).state));
    expect(loading).toBe('←/→ tab · Tab cycle · Esc close');
  });
});

describe('Esc and Ctrl+C at the Active tab', () => {
  it('Esc closes the screen from the list, like every tab with nothing open', () => {
    expect(rig().press('', ESC)).toEqual({ kind: 'close' });
  });

  it('Ctrl+C closes it too, and cancels nothing', () => {
    expect(rig().press('c', { ctrl: true })).toEqual({ kind: 'close' });
  });
});

describe('the cursor follows the run', () => {
  it('stays on its run when a newer read moves it down the list', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.gate) r.press('', DOWN);
    const before = active(r.state).cursor;
    const shuffled = [
      ...classify([run('newcome1', 'running'), run('newcome2', 'running')], {}),
      ...EVERY_CLASS,
    ];
    const next = withActiveRead(r.state, read(shuffled));
    expect(focusedId(next)).toBe(IDS.gate);
    expect(active(next).cursor).toBeGreaterThan(before);
    expect(active(next).rows[active(next).cursor]?.runId).toBe(IDS.gate);
  });

  it('keeps its position, inside the rows, when the run left the list', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.held) r.press('', DOWN);
    const without = EVERY_CLASS.filter((row) => row.runId !== IDS.held);
    const next = withActiveRead(r.state, read(without));
    expect(active(next).cursor).toBe(without.length - 1);
    expect(active(next).focus).toBe(active(next).rows.at(-1)?.runId);
    const emptied = withActiveRead(r.state, read([]));
    expect(active(emptied).cursor).toBe(0);
    expect(active(emptied).focus).toBeUndefined();
  });

  it('is remembered by the tab host as a row and as a run, and the tab is entered there again', () => {
    const r = rig();
    while (focusedId(r.state) !== IDS.gate) r.press('', DOWN);
    const memory = tabHostMemory(r.state);
    expect(memory.positions.active).toBe(active(r.state).cursor);
    expect(memory.activeFocus).toBe(IDS.gate);
    const back = enterTab(memory, 'active', r.context());
    expect(active(back).focus).toBe(IDS.gate);
    // The focus wins over the row number when the list has changed since.
    const reordered = enterTab(memory, 'active', {
      ...r.context(),
      active: { last: read([...classify([run('newcome1', 'running')]), ...EVERY_CLASS]) },
    });
    expect(active(reordered).focus).toBe(IDS.gate);
  });
});

describe('before a read, and when there is none', () => {
  it('says it is reading until the first read, and names no key but the tab’s', () => {
    const r = rig(null);
    expect(textOf(r.state)).toContain(ACTIVE_LOADING);
    expect(active(r.state).phase).toBe('loading');
    const loaded = withActiveRead(r.state, read(EVERY_CLASS));
    expect(active(loaded).phase).toBe('ready');
    expect(textOf(loaded)).not.toContain(ACTIVE_LOADING);
  });

  it('says it cannot be read when nothing feeds the tab, and when the first read failed', () => {
    const none = enterTab(freshTabMemory('active'), 'active', { port: undefined, now: 0 });
    expect(textOf(none)).toContain(ACTIVE_UNREADABLE);
    expect(active(none).phase).toBe('unreadable');
  });

  it('a later failure keeps the list and says it is the last one read; the next good read takes the sentence back', async () => {
    const { withActiveFailure } = await import('./tab-host.js');
    const r = rig();
    const failed = withActiveFailure(r.state);
    expect(textOf(failed)).toContain(ACTIVE_STALE_READ);
    expect(textOf(failed).join('\n')).toContain(IDS.hosted);
    expect(withActiveFailure(failed), 'the same object, so a failing poll does not repaint').toBe(
      failed,
    );
    const recovered = withActiveRead(failed, read(EVERY_CLASS));
    expect(textOf(recovered)).not.toContain(ACTIVE_STALE_READ);
    const never = withActiveFailure(rig(null).state);
    expect(textOf(never)).toContain(ACTIVE_UNREADABLE);
  });
});

// ---- Through the real Home controller -------------------------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const GATE_RUN: RunGates = {
  runId: IDS.gate,
  workflowId: 'wf',
  gates: [
    {
      runId: IDS.gate,
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
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const tabHostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const activeOf = (c: HomeController) => tabHostOf(c)?.active;

interface Options {
  readonly current?: ActiveRead;
  readonly withActive?: boolean;
  readonly parked?: (runId: string) => RunGates | undefined;
  readonly readFails?: boolean;
}

/** A Home with a scripted poll, a scripted clock and scripted timers: nothing sleeps and no operator home is read. */
function mount(options: Options = {}) {
  let clock = 1_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const state = {
    current: options.current ?? read(EVERY_CLASS),
    closed: false,
    readFails: options.readFails === true,
  };
  const probe = createChangeProbe(() => 1);
  const reads = vi.fn((): Promise<ActiveRead> => {
    if (state.readFails) return Promise.reject(new Error('could not read'));
    return Promise.resolve(state.current);
  });
  const active: HomeActivePort = {
    token: probe.token,
    read: reads,
    isClosed: () => state.closed,
  };
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    ...(options.withActive === false ? {} : { active }),
    hostedRuns: {
      snapshot: (): RunHostSnapshot => IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    gateCards: {
      list: () => [],
      read: options.parked ?? ((runId: string) => (runId === IDS.gate ? GATE_RUN : undefined)),
      resume: () => Promise.reject(new Error('nothing is answered here')),
    },
    schedule: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: clock + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    now: () => clock,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  const controller = createHomeController(deps);
  return {
    controller,
    state,
    probe,
    reads,
    onExit,
    timers: (): number => timers.size,
    /** Move the clock and fire every timer that falls due, then let the poll's promises settle. */
    advance: async (ms: number): Promise<void> => {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].callback();
        await flush();
      }
      clock = end;
    },
  };
}
type Home = ReturnType<typeof mount>;

const openActive = async (home: Home): Promise<void> => {
  expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
  await flush();
};
/** Move the cursor onto the run `id` with real keys. */
const moveTo = (home: Home, id: string): void => {
  for (let i = 0; i < 20 && activeOf(home.controller)?.focus !== id; i += 1)
    home.controller.handleKey('', DOWN);
  expect(activeOf(home.controller)?.focus).toBe(id);
};
const POLL = 1_500;

describe('the controller reads the tab when it is entered, and again only when something moved', () => {
  it('shows the rows after one read at the start, and does not read again while the token is the same', async () => {
    const home = mount();
    await openActive(home);
    expect(home.reads).toHaveBeenCalledTimes(1);
    expect(activeOf(home.controller)?.phase).toBe('ready');
    expect(activeOf(home.controller)?.rows).toHaveLength(EVERY_CLASS.length);
    await home.advance(POLL * 10);
    expect(home.reads, 'ten ticks and nothing moved').toHaveBeenCalledTimes(1);
  });

  it('reads again at the next tick after the in-process generation moves, and paints the newer rows', async () => {
    const home = mount();
    await openActive(home);
    home.state.current = read(EVERY_CLASS.slice(0, 3));
    home.probe.bump();
    await home.advance(POLL);
    expect(home.reads).toHaveBeenCalledTimes(2);
    expect(activeOf(home.controller)?.rows).toHaveLength(3);
  });

  it('opens on the last read it kept, at once, and reads again', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.controller.openScreen('tab-host', { tab: 'active' })).toBe(true);
    expect(activeOf(home.controller)?.phase, 'before the new read has landed').toBe('ready');
    await flush();
    expect(home.reads).toHaveBeenCalledTimes(2);
  });

  it('with nothing wired it says the tab cannot be read, and reads nothing', async () => {
    const home = mount({ withActive: false });
    await openActive(home);
    expect(activeOf(home.controller)?.phase).toBe('unreadable');
    await home.advance(POLL * 3);
    expect(home.reads).not.toHaveBeenCalled();
    expect(home.timers()).toBe(0);
  });

  it('a read that fails says so: the tab cannot be read, and then the list stays when a later read fails', async () => {
    const home = mount({ readFails: true });
    await openActive(home);
    expect(activeOf(home.controller)?.phase).toBe('unreadable');
    home.state.readFails = false;
    await home.advance(POLL);
    expect(activeOf(home.controller)?.phase, 'the same token reads again after a failure').toBe(
      'ready',
    );
    home.state.readFails = true;
    home.probe.bump();
    await home.advance(POLL);
    expect(activeOf(home.controller)?.rows).toHaveLength(EVERY_CLASS.length);
    expect(activeOf(home.controller)?.message).toBe(ACTIVE_STALE_READ);
  });

  it('is told the terminal is below 80×24 and reads nothing until it is not', async () => {
    const home = mount();
    home.controller.setTerminalSize(60, 20);
    await openActive(home);
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).not.toHaveBeenCalled();
    home.controller.setTerminalSize(100, 30);
    await home.advance(POLL);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once the database is closed, and leaves no timer', async () => {
    const home = mount();
    await openActive(home);
    home.state.closed = true;
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).toHaveBeenCalledTimes(1);
    expect(home.timers()).toBe(0);
  });
});

describe('a paused row opens its gate card, and Esc returns to the tab on the same row', () => {
  it('Enter on the paused row opens the card; Esc puts the tab host back on that row, and the poll reads again', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    const row = activeOf(home.controller)?.cursor;
    home.controller.handleKey('', ENTER);
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('gate-card');
    expect(screen?.kind === 'gate-card' && screen.runId).toBe(IDS.gate);
    expect(screen?.kind === 'gate-card' && screen.from).toBe('tab-host');
    expect(
      screen?.kind === 'gate-card' && screen.back,
      'a card opened from a browser returns to the browser',
    ).toBe('landing');
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(tabHostOf(home.controller)?.tab).toBe('active');
    expect(activeOf(home.controller)?.cursor).toBe(row);
    expect(activeOf(home.controller)?.focus).toBe(IDS.gate);
    await flush();
    expect(home.reads, 'the tab reads again when it is back').toHaveBeenCalledTimes(2);
  });

  it('reads nothing while the card is open, whatever the token does, and leaves no timer behind', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('gate-card');
    expect(home.timers(), 'the card holds no poll').toBe(0);
    home.probe.bump();
    await home.advance(POLL * 5);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('the tab keeps following its run when the list changed while the card was open', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    home.state.current = read([
      ...classify([run('newcome1', 'running'), run('newcome2', 'running')]),
      ...EVERY_CLASS,
    ]);
    home.probe.bump();
    home.controller.handleKey('', ESC);
    await flush();
    expect(activeOf(home.controller)?.focus).toBe(IDS.gate);
  });

  it('Ctrl+C on the card closes the card and the tab host with it, and the poll', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    home.controller.handleKey('c', { ctrl: true });
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
  });

  it('a run that is not parked any more says so on the tab, and the tab stays', async () => {
    const home = mount({ parked: () => undefined });
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.message).toContain(
      'is not parked in this directory any more.',
    );
    expect(
      home.controller.getSnapshot().notice,
      'where the person is looking, not behind the screen',
    ).toBeUndefined();
  });

  it('a run that was parked with no gate left says where to look, on the tab', async () => {
    const home = mount({ parked: () => ({ ...GATE_RUN, gates: [] }) });
    await openActive(home);
    moveTo(home, IDS.gate);
    home.controller.handleKey('', ENTER);
    expect(activeOf(home.controller)?.message).toContain('is parked with no gate to decide here.');
  });
});

describe('the hosted leg’s row reopens its view, and Esc returns to the tab on the same row', () => {
  it('Enter on it puts the run view of that run in front, and Esc brings the tab back on its row', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.hosted);
    home.controller.handleKey('', ENTER);
    const screen = home.controller.getSnapshot().screen;
    expect(screen?.kind).toBe('run-view');
    expect(screen?.kind === 'run-view' && screen.runId).toBe(IDS.hosted);
    expect(screen?.kind === 'run-view' && screen.from).toBe('tab-host');
    expect(home.timers(), 'a run view holds no poll').toBe(0);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.focus).toBe(IDS.hosted);
  });
});

describe('a read-only row opens nothing', () => {
  it('Enter on another process’s run leaves the tab as it is, with the reason on the tab', async () => {
    const home = mount();
    await openActive(home);
    moveTo(home, IDS.other);
    home.controller.handleKey('', ENTER);
    expect(home.controller.getSnapshot().screen?.kind).toBe('tab-host');
    expect(activeOf(home.controller)?.message).toMatch(/^Read-only: /u);
  });
});

describe('closing, leaving the tab and tearing the Home down leave no timer', () => {
  it('Esc at the list closes the screen and clears the poll’s timer', async () => {
    const home = mount();
    await openActive(home);
    expect(home.timers(), 'one timer while the tab is in front').toBe(1);
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
    await home.advance(POLL * 10);
    expect(home.reads).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C closes it the same way', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('c', { ctrl: true });
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.timers()).toBe(0);
  });

  it('moving to another tab stops the poll, and coming back starts it with a read at once', async () => {
    const home = mount();
    await openActive(home);
    home.controller.handleKey('', { rightArrow: true });
    expect(tabHostOf(home.controller)?.tab).toBe('history');
    expect(home.timers()).toBe(0);
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads).toHaveBeenCalledTimes(1);
    home.controller.handleKey('', { leftArrow: true });
    await flush();
    expect(home.reads).toHaveBeenCalledTimes(2);
    expect(home.timers()).toBe(1);
  });

  it('the Home ending (a signal) clears the timer, and a read still in flight is not painted', async () => {
    const home = mount();
    await openActive(home);
    expect(home.timers()).toBe(1);
    await home.controller.teardownActive();
    expect(home.timers()).toBe(0);
    const before = home.reads.mock.calls.length;
    home.probe.bump();
    await home.advance(POLL * 3);
    expect(home.reads.mock.calls.length).toBe(before);
  });

  it('a read that lands after the screen closed paints nothing', async () => {
    let finish: (value: ActiveRead) => void = () => undefined;
    const home = mount();
    home.reads.mockImplementationOnce(
      () =>
        new Promise<ActiveRead>((resolve) => {
          finish = resolve;
        }),
    );
    home.controller.openScreen('tab-host', { tab: 'active' });
    expect(activeOf(home.controller)?.phase).toBe('loading');
    home.controller.handleKey('', ESC);
    finish(read(EVERY_CLASS));
    await flush();
    expect(home.controller.getSnapshot().screen).toBeUndefined();
  });
});

describe('the keys of the tab host still work around it', () => {
  it('the tab bar draws Active in front with the rows below it, in at most 23 rows, through a real controller', async () => {
    const home = mount();
    await openActive(home);
    const host = tabHostOf(home.controller);
    if (host === undefined) throw new Error('no tab host');
    const drawn = textOf(host);
    expect(drawn.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(drawn[0]).toContain('▸ Active');
    expect(drawn.join('\n')).toContain(IDS.hosted);
  });
});
