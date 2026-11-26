/**
 * The line a Home-hosted chat gets when a hosted leg ends behind it (`‖ deploy is waiting at a gate. Leave this chat to answer it on the Home.`)
 * is about the session's world, not an answer to a gesture: it stays until `/clear` or the chat ends, as it did before warnings had a lifetime
 * (MVP-11 unit 7, round 1: SE73). Noted with the `turn` lifetime, the next message consumed it and the person lost the one sign of a run that
 * waits for them. Through the real Home controller and a real chat store; the run host, the parked rows and the timers are scripted.
 */
import { describe, expect, it } from 'vitest';

import type { HostedRunDisposition } from '../../home/hosted-run-terminal.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { createChatStore } from './chat-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { HOSTED_RUN_POLL_MS } from './tui-constants.js';

const RUN = '3f2a9c1e-7b64-4d0a-9c11-5a2e8f6d0b13';
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const EXECUTING: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: false },
  last: undefined,
};
const endOf = (disposition: HostedRunDisposition): HostedLegEnd => ({
  leg: 'start',
  runId: RUN,
  terminal: { disposition, safety: undefined, headline: 'h', remedy: undefined },
  handedOff: disposition === 'paused',
  retirement: 'retired',
  fault: undefined,
});
const PARKED: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1, workflow: 'deploy' };

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

async function chatWithALegThatEnds(disposition: HostedRunDisposition) {
  let host = EXECUTING;
  let parked: readonly ParkedRunRow[] = [];
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const session: HomeChatSession = {
    store,
    sessionId: 'chat-1',
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  const controller = createHomeController({
    startChat: () => Promise.resolve(session),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list: () => parked,
      read: () => undefined,
      resume: () => Promise.reject(new Error('nothing is answered here')),
    },
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    now: () => now,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  // The poll that watches a live leg runs once its view was opened and left.
  expect(controller.openScreen('run-view', { runId: RUN })).toBe(true);
  controller.closeScreen();
  controller.handlePaste('hello');
  controller.handleKey('', { return: true });
  await settle();
  expect(controller.getSnapshot().mode).toBe('chat');
  parked = [PARKED];
  host = { launching: false, active: undefined, last: endOf(disposition) };
  now += HOSTED_RUN_POLL_MS;
  for (const timer of timers.splice(0).filter((entry) => entry.at <= now)) timer.run();
  await settle();
  return { controller, store };
}

describe('the line about a leg that ended behind a chat outlives the next message', () => {
  it.each(['paused', 'completed', 'failed'] as const)('%s', async (disposition) => {
    const { controller, store } = await chatWithALegThatEnds(disposition);
    const view = store.getSnapshot().state;
    const line = view.warnings.find((warning) => warning.includes('Leave this chat'));
    expect(line, 'the chat was told').toBeDefined();
    expect(view.stickyWarnings, 'kept for the session, not for one turn').toContain(line);
    await controller.teardownActive();
  });
});
