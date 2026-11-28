/**
 * A screen opened from a row of the work page gives the focus back to that row, or to the nearest, when it closes (MVP-11 unit 7, round 1:
 * OB77; `restoreRowFocus`), through the real controller with scripted reads. A gate answered on the card takes its run off the list, so the focus
 * is the row that now stands where the answered one stood, the LAST row when the list got shorter than that place, never the docked prompt while
 * a row is left to stand on. And an unrelated change while the card is open (a provider state) does not use that memory up.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunGates } from '../../home/run-gates.js';
import type { HostedLaunch, HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import type { HomePopupKind, HomePopupsPort } from '../../popups/home-port.js';
import { definedPortOver } from './run-again.test-support.js';
import {
  CTRL,
  DOWN,
  ENTER,
  ESC,
  GUARD_OFF,
  IDLE_HOST,
  runRow,
  settle,
  snapshotOf,
} from './home-controller.test-support.js';
import { HOSTED_RUN_POLL_MS } from './tui-constants.js';

const gateOf = (runId: string): RunGates => ({
  runId,
  workflowId: 'wf',
  gates: [
    {
      runId,
      gateId: 'g1',
      nodeId: 'review',
      gateType: 'approval',
      message: 'Ship?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
});
const parkedRow = (runId: string): ParkedRunRow => ({ runId, kind: 'approval', gates: 1 });

/** The Home over a list of parked runs: answering a gate takes its run off the list. */
function rig(ids: readonly string[], snapshot: HomeSnapshot) {
  let parked: readonly ParkedRunRow[] = ids.map(parkedRow);
  const resume = vi.fn((request: { readonly runId: string }): Promise<HostedLaunch> => {
    parked = parked.filter((row) => row.runId !== request.runId);
    return Promise.resolve({
      kind: 'started',
      leg: 'resume',
      runId: request.runId,
      ended: new Promise(() => undefined),
    });
  });
  /** What the Home asked its popup host to open (`/workflows` is a popup of the Home since MVP-11 unit 8; its `[h]` is a request the Home carries out). */
  const popups: { readonly kind: HomePopupKind; readonly port: HomePopupsPort }[] = [];
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => snapshot },
    defined: definedPortOver().port,
    openHomePopup: (request) => {
      popups.push(request);
    },
    resumeChat: () => Promise.resolve(undefined),
    announce: () => {},
    hostedRuns: { snapshot: () => IDLE_HOST, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list: () => parked,
      read: (id) => (ids.includes(id) ? gateOf(id) : undefined),
      resume,
      guard: GUARD_OFF,
    },
    schedule: () => () => {},
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  controller.bindGateCardFrame(() => true);
  return {
    controller,
    popups,
    focus: () => controller.getSnapshot().stripFocus?.id,
    press: (key: ChatKey): void => controller.handleKey('', key),
  };
}

describe('a screen opened from a row gives the focus back to that row, or the nearest, when it closes', () => {
  it('the list got shorter than the row’s place: the focus is the last row that is left', async () => {
    const r = rig(
      ['p1', 'p2', 'p3'],
      snapshotOf({ totals: { attention: 3, sessions: 0, runs: 0 } }),
    );
    r.press(DOWN);
    r.press(DOWN);
    r.press(DOWN);
    expect(r.focus()).toBe('p3');
    r.press(ENTER);
    expect(r.controller.getSnapshot().screen?.kind).toBe('gate-card');
    r.controller.handleKey('y', CTRL);
    await settle();
    r.press(ESC);
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.focus(), 'p3 is answered and gone: the last row left, not the docked prompt').toBe(
      'p2',
    );
  });

  it('a row answered in the middle: the row that now stands where it stood', async () => {
    const r = rig(
      ['p1', 'p2', 'p3'],
      snapshotOf({ totals: { attention: 3, sessions: 0, runs: 0 } }),
    );
    r.press(DOWN);
    r.press(DOWN);
    expect(r.focus()).toBe('p2');
    r.press(ENTER);
    r.controller.handleKey('y', CTRL);
    await settle();
    r.press(ESC);
    expect(r.focus()).toBe('p3');
  });

  it('the answered run executed (its row was hidden) and paused again at its next gate before the card closed: the focus is that run’s row, wherever the list now has it', async () => {
    const END = (runId: string): HostedLegEnd => ({
      leg: 'resume',
      runId,
      terminal: {
        disposition: 'paused',
        safety: undefined,
        headline: `Run ${runId} is paused.`,
        remedy: undefined,
      },
      handedOff: true,
      retirement: 'retired',
      fault: undefined,
    });
    let host: RunHostSnapshot = IDLE_HOST;
    let now = 0;
    let next = 0;
    const pending = new Map<number, { at: number; run: () => void }>();
    let parked: readonly ParkedRunRow[] = ['p1', 'p2', 'p3'].map(parkedRow);
    const controller = createHomeController({
      startChat: () => new Promise<HomeChatSession>(() => {}),
      homeStore: { read: () => snapshotOf({ totals: { attention: 3, sessions: 0, runs: 0 } }) },
      resumeChat: () => Promise.resolve(undefined),
      announce: () => {},
      hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
      gateCards: {
        list: () => parked,
        read: (id) => gateOf(id),
        resume: (request) => {
          host = {
            launching: false,
            active: { leg: 'resume', runId: request.runId, cancelling: false },
            last: undefined,
          };
          return Promise.resolve({
            kind: 'started',
            leg: 'resume',
            runId: request.runId,
            ended: new Promise(() => undefined),
          });
        },
        guard: GUARD_OFF,
      },
      schedule: (run, delayMs) => {
        next += 1;
        const id = next;
        pending.set(id, { at: now + delayMs, run });
        return () => pending.delete(id);
      },
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    controller.bindGateCardFrame(() => true);
    const poll = (): void => {
      now += HOSTED_RUN_POLL_MS;
      for (const [id, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.run();
      }
    };
    controller.handleKey('', DOWN);
    controller.handleKey('', DOWN);
    expect(controller.getSnapshot().stripFocus?.id).toBe('p2');
    controller.handleKey('', ENTER);
    controller.handleKey('y', CTRL);
    await settle();
    poll();
    expect(
      controller.getSnapshot().parkedRuns.map((row) => row.runId),
      'a leg executes p2: its row is hidden',
    ).toEqual(['p1', 'p3']);
    expect(controller.getSnapshot().stripFocus, 'the focus went with the row').toBeUndefined();
    parked = ['p2', 'p1', 'p3'].map(parkedRow); // the leg paused again, and the log lists p2 first
    host = { launching: false, active: undefined, last: END('p2') };
    poll();
    expect(controller.getSnapshot().parkedRuns.map((row) => row.runId)).toEqual(['p2', 'p1', 'p3']);
    controller.handleKey('', ESC);
    expect(controller.getSnapshot().screen).toBeUndefined();
    expect(
      controller.getSnapshot().stripFocus?.id,
      'p2 stands first now: not the row that stands where p2 stood (p1)',
    ).toBe('p2');
  });

  it('the memory is of one screen only: a later screen opened from the prompt gives the focus back to the prompt, not to the row of the earlier one', () => {
    const r = rig(['p1'], snapshotOf({ totals: { attention: 1, sessions: 0, runs: 0 } }));
    r.press(DOWN);
    expect(r.focus()).toBe('p1');
    r.press(ENTER);
    expect(r.controller.getSnapshot().screen?.kind).toBe('gate-card');
    r.press(ESC);
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.focus(), 'the card closed with the row still under the focus').toBe('p1');
    r.press(DOWN);
    expect(r.focus(), 'down past the last row is the docked prompt').toBeUndefined();
    // A screen opened from the prompt: `/workflows` typed there, then `[h]` in its popup (the popup closes itself and the Home opens the Runs screen).
    r.controller.handlePaste('/workflows');
    r.press(ENTER);
    expect(r.popups.map((request) => request.kind)).toEqual(['workflows']);
    r.popups[0]?.port.workflows?.openRuns();
    expect(r.controller.getSnapshot().screen?.kind).toBe('tab-host');
    r.press(ESC);
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.focus(), 'the Runs screen was opened from the prompt').toBeUndefined();
  });

  it('an unrelated change while the card is open (a provider state) does not use the memory up: the answered row still hands the focus on', async () => {
    const snapshot = snapshotOf({
      recentRuns: [runRow('recent-1')],
      totals: { attention: 2, sessions: 0, runs: 1 },
    });
    const r = rig(['p1', 'p2'], snapshot);
    r.press(DOWN);
    r.press(DOWN);
    expect(r.focus()).toBe('p2');
    r.press(ENTER);
    expect(r.controller.getSnapshot().screen?.kind).toBe('gate-card');
    r.controller.setProviderState(false);
    r.controller.setProviderState(false);
    r.controller.handleKey('y', CTRL);
    await settle();
    r.press(ESC);
    expect(r.controller.getSnapshot().screen).toBeUndefined();
    expect(r.focus(), 'p2 is answered and gone: the row that now stands there').toBe('recent-1');
  });
});
