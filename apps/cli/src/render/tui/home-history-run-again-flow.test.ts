/**
 * `r` on a History run's detail reaches the REAL launch flow ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §2, §7; MVP-11 unit 7, W4c): the controller is real, the launch flow is `createRunLaunch` over the real native prompt channel with its real
 * guards on an injected clock, and the only thing scripted is the host's `start`, which counts. The claim is the consent path's: no sequence
 * of keys that begins with `r` starts a run until the form's own confirmation (`Ctrl+Y`, past the chord card's dwell, quiet gap and lockout)
 * is answered, and that answer starts it exactly once. A workflow with no inputs is the strongest case: the form has nothing to ask, so the
 * confirmation card is the FIRST thing the key opens, with the key that opened it still held under the finger.
 *
 * The form's own guards are `home/run-launch-popup.test.ts`'s over every initial delay and rate; this file proves the History detail's `r`
 * reaches them: the same flow, the same card, the same lockout, with the Home's chord history shared between the controller and the channel
 * as `driveHome` wires them.
 */
import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLaunch, HostedStartRequest, RunHostSnapshot } from '../../home/run-host.js';
import { createRunLaunch, LAUNCH_CANCELLED, type LaunchCatalog } from '../../home/run-launch.js';
import { createChordHistory } from './chord-guard.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { createNativePromptChannel, type NativePromptSnapshot } from './native-prompt-channel.js';
import { RUN, definedPortOver, historyListOfRun, runDetailRead } from './run-again.test-support.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';
import type { TabHostState } from './tab-host.js';
import type { HistoryPort } from './tab-host-history.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const CTRL: Key = { ...none, ctrl: true };
const REPEAT = (key: Key): Key => ({ ...key, eventType: 'repeat' });
const ENTER = { return: true } as const;

/** No inputs at all: the form has nothing to ask and opens on the confirmation card. */
const NO_INPUTS = `schema_version: '1.0'
workflow:
  id: nightly
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

/** When the person presses `r`, on the injected clock: well after the Home's first frame. */
const PRESSED_AT = 10_000;
/** The first `Ctrl+Y` of a held chord comes this long after the `r`: a hand going from one key to the next. */
const FIRST_PRESS_AFTER_MS = 5;
/** How long a key is held in the grid, and the initial repeat delays and rates it is held at. */
const HOLD_MS = 4_000;
const INITIAL_DELAYS_MS = [0, 250, 500, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 100] as const;

const catalog: LaunchCatalog = {
  list: () => [{ path: 'nightly.yaml', slug: 'nightly', name: undefined, tags: [], valid: true }],
  load: (path) => ({
    definition: parseWorkflow(NO_INPUTS, { source: path }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
};

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'start',
  runId: '0123456789abcdef-run',
  ended: new Promise(() => {}),
};

/** A Home on a History detail whose `r` reaches the real launch flow over the real channel. */
async function mount() {
  let clock = PRESSED_AT - 1_000;
  const chordHistory = createChordHistory();
  const channel = createNativePromptChannel({ now: () => clock, history: chordHistory });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  const host = {
    start: vi.fn((request: HostedStartRequest) => (void request, Promise.resolve(STARTED))),
  };
  const launch = createRunLaunch({ flow: channel.flow, host, catalog });
  const open = vi.fn((slug?: string, path?: string) => launch.open(slug, path));
  const history: HistoryPort = {
    read: () => historyListOfRun(),
    cost: () => ({ kind: 'text', text: '$0.01' }),
    loadDetail: () => Promise.resolve<RunDetailLoad>({ kind: 'ready', detail: runDetailRead() }),
  };
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    history,
    defined: definedPortOver([
      { slug: 'nightly', name: undefined, nodeCount: 2, path: 'nightly.yaml', valid: true },
    ]).port,
    launchRun: open,
    chordHistory,
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
    schedule: () => () => {},
    now: () => clock,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  expect(controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
  controller.handleKey('', ENTER);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const screen = controller.getSnapshot().screen;
  const hostState: TabHostState | undefined = screen?.kind === 'tab-host' ? screen.host : undefined;
  expect(hostState?.history?.detail?.phase).toBe('ready');
  expect(hostState?.history?.detail?.runId).toBe(RUN);
  return {
    controller,
    channel,
    host,
    open,
    at: (time: number): void => {
      clock = time;
    },
    now: (): number => clock,
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    /** The host measured and flushed the frame on the channel now. */
    show: (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    },
    message: (): string | undefined => {
      const now = controller.getSnapshot().screen;
      return now?.kind === 'tab-host' ? now.host.history?.detail?.message : undefined;
    },
    /** `r` pressed, and the launch flow's confirmation card up for it (the first prompt: the workflow has no inputs). */
    pressR: async (): Promise<void> => {
      clock = PRESSED_AT;
      controller.handleKey('r', {});
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'chord'; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.ui.getSnapshot().kind, 'the confirmation card is up').toBe('chord');
    },
  };
}

describe('nothing starts until the form’s own confirmation is answered, whatever follows the `r`', () => {
  for (const initial of INITIAL_DELAYS_MS) {
    for (const interval of REPEAT_INTERVALS_MS) {
      it(`a Ctrl+Y held from the moment the form opened (first repeat after ${String(initial)} ms, then every ${String(interval)} ms) starts nothing; one patient press after it is let go starts exactly one`, async () => {
        const m = await mount();
        await m.pressR();
        expect(m.open, 'the flow was opened for the catalog entry').toHaveBeenCalledWith(
          'nightly',
          'nightly.yaml',
        );
        const first = PRESSED_AT + FIRST_PRESS_AFTER_MS;
        m.at(first);
        m.channel.ui.unseenInput('y', CTRL); // before the card's frame was on screen: the host drops it, unseen
        m.show();
        let last = first;
        for (let at = first + initial; at <= first + HOLD_MS; at += interval) {
          m.at(at);
          last = at;
          m.channel.ui.input('y', REPEAT(CTRL));
          expect(m.snapshot().kind, `the repeat at +${String(at - PRESSED_AT)} ms`).toBe('chord');
        }
        expect(m.host.start, 'a held key started nothing').not.toHaveBeenCalled();
        m.at(last + APPROVAL_LOCKOUT_MS + 1);
        m.channel.ui.input('y', CTRL);
        await vi.waitFor(() => expect(m.host.start).toHaveBeenCalledTimes(1));
        const request = m.host.start.mock.calls[0]?.[0];
        expect(request?.workflow, 'the file the catalog listed').toBe('nightly.yaml');
        expect(m.open).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('a single Ctrl+Y one second after the form opened, with nothing pressed between, answers nothing: the lockout runs from the card’s appearance, not only from an earlier answer', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FIRST_PRESS_AFTER_MS);
    m.show(); // the host measured and flushed the card at once
    m.at(PRESSED_AT + 1_000); // past the dwell and the quiet gap: only the lockout is left to refuse it
    m.channel.ui.input('y', CTRL);
    expect(m.snapshot().kind, 'the card is still asking').toBe('chord');
    expect(m.host.start).not.toHaveBeenCalled();
    // That refused press restarted the lockout: the patient press after it is the answer, and it starts exactly one run.
    m.at(PRESSED_AT + 1_000 + APPROVAL_LOCKOUT_MS + 1);
    m.channel.ui.input('y', CTRL);
    await vi.waitFor(() => expect(m.host.start).toHaveBeenCalledTimes(1));
  });

  it('a held `r` while the card is up opens no second form and answers nothing: at the controller it is dropped, at the card it is typing', async () => {
    const m = await mount();
    await m.pressR();
    m.show();
    m.at(PRESSED_AT + APPROVAL_LOCKOUT_MS + 1); // long past the lockout: only the key's own kind keeps it from answering
    for (let repeat = 0; repeat < 30; repeat += 1) {
      m.controller.handleKey('r', {}); // the keyboard the controller dropped
      m.channel.ui.input('r', REPEAT(none)); // the same key as the card sees it
    }
    expect(m.snapshot().kind, 'the card is still asking').toBe('chord');
    expect(m.open, 'one form for a held key').toHaveBeenCalledTimes(1);
    expect(m.host.start).not.toHaveBeenCalled();
  });

  it('an Enter, a Ctrl+R, a paste and a letter never answer the card; Ctrl+N leaves it with nothing started and says so on the detail', async () => {
    const m = await mount();
    await m.pressR();
    m.show();
    m.at(PRESSED_AT + APPROVAL_LOCKOUT_MS + 1);
    m.channel.ui.input('', { ...none, return: true });
    m.channel.ui.input('r', { ...none, ctrl: true });
    m.channel.ui.paste('y');
    m.channel.ui.input('y', none);
    expect(m.snapshot().kind).toBe('chord');
    expect(m.host.start).not.toHaveBeenCalled();
    m.channel.ui.input('n', CTRL);
    await vi.waitFor(() => expect(m.controller.getSnapshot().nativeActionBusy).toBe(false));
    expect(m.host.start, 'leaving the form started nothing').not.toHaveBeenCalled();
    expect(m.message(), 'what the flow said, on the detail').toBe(LAUNCH_CANCELLED);
    expect(m.controller.getSnapshot().notice).toBeUndefined();
  });

  it('a Ctrl+Y typed ahead of the form, before its frame was on screen or inside its lockout, answers nothing, and the press that follows the lockout does', async () => {
    const m = await mount();
    await m.pressR();
    m.channel.ui.input('y', CTRL); // its frame was never acknowledged
    expect(m.snapshot().kind).toBe('chord');
    m.show();
    m.at(m.now() + 100);
    m.channel.ui.input('y', CTRL); // inside the dwell and the lockout the early one restarted
    expect(m.snapshot().kind).toBe('chord');
    expect(m.host.start).not.toHaveBeenCalled();
    m.at(m.now() + APPROVAL_LOCKOUT_MS + 1);
    m.channel.ui.input('y', CTRL);
    await vi.waitFor(() => expect(m.host.start).toHaveBeenCalledTimes(1));
  });
});
