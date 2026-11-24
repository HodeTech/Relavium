/**
 * The Home's ONE chord history, at the wiring the product uses
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * `run-card-cross-lockout.test.ts` proves the lockout with the card MODEL and the channel handed one history by the test itself. The
 * claim that matters is the product's: `driveHome` makes one history and hands it to the prompt channel (the MCP consent card) and to
 * `createHomeController`, which hands it on to every gate or budget card it opens and to the exit guard. A card built without it keeps a
 * history of its own, sees a card nobody has answered, and a key held down through one answer answers the next. So these tests build the
 * pieces the way `driveHome` does (one `createChordHistory()`, the channel and the controller both given it) and press the keys a person
 * does: a gate card answered with `Ctrl+Y` through the controller, and then a held `Ctrl+Y` on the card that follows.
 *
 * One clock is injected everywhere and the dwell, the quiet gap and the typeahead are switched off, so the lockout (the product's own
 * two seconds) is the only rule in play. The run host and the reads are scripted: no engine is built and no operator home is read.
 */
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, RunHostSnapshot } from '../../home/run-host.js';
import { createChordHistory } from './chord-guard.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import type { ApprovalGuard } from './tool-review-model.js';

const RUN = 'run-0001';
/** Only the lockout (the product's own 2 s) is on. */
const LOCKOUT_ONLY: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0 };
const CTRL_Y = { ctrl: true } as const;
const CTRL_C = { ctrl: true } as const;
const DOWN = { downArrow: true } as const;
const ENTER = { return: true } as const;
/** The same chord as the native channel takes it (ink's whole `Key`). */
const CHANNEL_CTRL: Key = {
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
  ctrl: true,
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
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

/** The pieces `driveHome` builds, over one history and one clock. */
function wiring() {
  let now = 0;
  let host: RunHostSnapshot = IDLE;
  const history = createChordHistory();
  const channel = createNativePromptChannel({ history, now: () => now, guard: LOCKOUT_ONLY });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  const resume = vi.fn(() => {
    host = RUNNING; // the answer started a leg: it is executing from here
    return Promise.resolve(STARTED);
  });
  const cancel = vi.fn((): boolean => true);
  const controller: HomeController = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => new Promise(() => {}),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => host, cancel, close: () => Promise.resolve() },
    gateCards: {
      list: () => [ROW],
      read: (runId) => (runId === RUN ? APPROVAL_RUN : undefined),
      resume,
      guard: LOCKOUT_ONLY,
    },
    chordHistory: history,
    now: () => now,
    schedule: () => () => {},
    onExit: vi.fn(),
    onError: vi.fn((cause: unknown) => {
      throw cause;
    }),
  });
  // The host's evidence that the frames are on screen: this file proves the lockout, not the painting.
  controller.bindGateCardFrame(() => true);
  controller.bindHomeFrame(() => true);
  return {
    controller,
    channel,
    resume,
    cancel,
    at: (ms: number): void => {
      now = ms;
    },
    /** `↓` onto the parked row and `Enter`: the card of the run, as a person opens it. */
    openCard: (): void => {
      controller.handleKey('', DOWN);
      controller.handleKey('', ENTER);
      expect(controller.getSnapshot().screen?.kind, 'the gate card is open').toBe('gate-card');
    },
    /** The consent card of the leg the answer started: opened on the channel, and its frame acknowledged. */
    openConsent: (): Promise<unknown> => {
      channel.flow.begin();
      const answer = channel.flow.chord({
        message: 'Allow MCP server?',
        allow: 'Allow',
        deny: 'Refuse',
      });
      channel.ui.shown(channel.ui.getSnapshot());
      return answer;
    },
  };
}

describe('a gate answered with Ctrl+Y locks the card that follows, at the product`s wiring', () => {
  it('refuses a held Ctrl+Y on the consent card, and accepts one after the key was let go for the whole window', async () => {
    const w = wiring();
    w.at(0);
    w.openCard();
    w.controller.handleKey('y', CTRL_Y);
    expect(w.resume, 'the gate was answered by that key').toHaveBeenCalledOnce();

    w.at(100);
    const consent = w.openConsent();
    let settled: unknown = 'pending';
    void consent.then((value) => {
      settled = value;
    });
    w.at(700); // the first auto-repeat of the key that is still down
    w.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled, 'refused: the card stays open, because the gate card shared its history').toBe(
      'pending',
    );
    expect(w.channel.ui.getSnapshot().kind).toBe('chord');

    w.at(2_600); // 1.9 s after the refused repeat: still inside the window that repeat restarted
    w.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled).toBe('pending');

    w.at(4_601); // the key was let go for the whole window: a deliberate press answers
    w.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent).toBe('allow');
  });

  it('refuses a held Ctrl+Y on the exit guard the same way, and the run is not cancelled', () => {
    const w = wiring();
    w.at(0);
    w.openCard();
    w.controller.handleKey('y', CTRL_Y);
    expect(w.resume).toHaveBeenCalledOnce();
    // The answer started a leg; the card is closed again, as a person returns to the landing, and the interrupt key asks twice.
    w.controller.closeScreen();

    w.at(300);
    w.controller.handleKey('c', CTRL_C);
    w.at(400);
    w.controller.handleKey('c', CTRL_C);
    expect(w.controller.getSnapshot().exitGuard, 'a leg is executing: the second press asks').toBe(
      'confirm',
    );

    w.at(900); // inside the two seconds of the answer: the held key's auto-repeat
    w.controller.handleKey('y', CTRL_Y);
    expect(w.controller.getSnapshot().exitGuard, 'refused: the card is still asking').toBe(
      'confirm',
    );
    expect(w.cancel, 'nothing was cancelled').not.toHaveBeenCalled();

    w.at(2_901); // let go for the whole window the refusal restarted
    w.controller.handleKey('y', CTRL_Y);
    expect(w.cancel, 'a deliberate press counts').toHaveBeenCalledOnce();
    expect(w.controller.getSnapshot().exitGuard).toBe('stopping');
  });
});
