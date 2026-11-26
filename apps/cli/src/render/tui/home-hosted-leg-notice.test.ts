/**
 * A hosted leg that ends behind a chat tells the chat
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, [ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §8): a run that parks at a gate, finishes or fails while a chat is in front shows no card and no strip row there (a card never takes the
 * keyboard from another screen), so its transcript says so, once per end, in a fixed sentence that names the run. Nothing is said when no
 * chat is in front (the strip is the news), for an end the person asked for, or twice for one end.
 *
 * Through the real Home controller. The run host, the parked rows and the timers are scripted: no engine is built and no database opened.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HostedRunDisposition } from '../../home/hosted-run-terminal.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLegEnd, RunHostSnapshot } from '../../home/run-host.js';
import { createChatStore } from './chat-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { HOSTED_RUN_POLL_MS } from './tui-constants.js';

const RUN = '3f2a9c1e-7b64-4d0a-9c11-5a2e8f6d0b13';
const OTHER = '9c41b0aa-2d17-45f3-8e6b-0f1a7c33d2e4';
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const executing = (runId: string, last?: HostedLegEnd): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId, cancelling: false },
  last,
});
const endOf = (disposition: HostedRunDisposition, runId = RUN): HostedLegEnd => ({
  leg: 'start',
  runId,
  terminal: { disposition, safety: undefined, headline: 'h', remedy: undefined },
  handedOff: disposition === 'paused',
  retirement: 'retired',
  fault: undefined,
});
const settled = (end: HostedLegEnd): RunHostSnapshot => ({
  launching: false,
  active: undefined,
  last: end,
});
const PARKED: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1, workflow: 'deploy' };

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** A Home with a run host, a log of parked rows and a clock the test moves, and the chat that a pasted line starts. */
function rig(start: RunHostSnapshot = executing(RUN)) {
  let host = start;
  let parked: readonly ParkedRunRow[] = [];
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const note = vi.spyOn(store, 'note');
  // The Home's one notification channel: what the refused `/resume` says (ADR-0148 §6), never a line in the chat.
  const announced: string[] = [];
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
    // A native action that ends in the chat reads the run host again: the one way a chat's Home looks at the host with no leg live. `/resume`
    // is the one such action a chat has (`/init` is the Home's: ADR-0145 §7.5), and a resume that is refused with a notice ends in the chat.
    pickSession: () => Promise.resolve('another-session'),
    resumeChat: () => Promise.resolve({ notice: 'resumed' }),
    announce: (text) => announced.push(text),
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => host, cancel: () => true, close: () => Promise.resolve() },
    gateCards: {
      list: () => parked,
      read: () => undefined,
      resume: () => Promise.reject(new Error('nothing is answered here')),
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
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  /** Move time on, firing every timer that falls due, in order. */
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
    note,
    announced,
    host: (next: RunHostSnapshot): void => {
      host = next;
    },
    log: (next: readonly ParkedRunRow[]): void => {
      parked = next;
    },
    advance,
    /** The poll that watches a live leg is running: the run's view was opened once, and left. */
    watchTheLeg: (): void => {
      expect(controller.openScreen('run-view', { runId: RUN })).toBe(true);
      controller.closeScreen();
    },
    /** A message typed at the landing starts a chat, which is then in front. */
    async startChat(): Promise<void> {
      controller.handlePaste('hello');
      controller.handleKey('', { return: true });
      await settle();
      expect(controller.getSnapshot().mode).toBe('chat');
    },
  };
}
type Home = ReturnType<typeof rig>;

/** The transcript lines the chat was given, as the store's own `note` took them. */
const said = (home: Home): string[] => home.note.mock.calls.map((call) => call[0]);
/** Only the lines about a run: the chat may note other things (the disclosure of its effects). */
const aboutRuns = (home: Home): string[] => said(home).filter((line) => /^[‖✓✗] /u.test(line));

describe('a leg that ends while a chat is in front', () => {
  it('that parks at a gate says so in the transcript, naming the workflow of its Attention row', async () => {
    const home = rig();
    home.watchTheLeg();
    await home.startChat();
    home.log([PARKED]);
    home.host(settled(endOf('paused')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(aboutRuns(home)).toEqual([
      '‖ deploy is waiting at a gate. Leave this chat to answer it on the Home.',
    ]);
    await home.controller.teardownActive();
  });

  it('that completes says so, with the run id when no row names its workflow', async () => {
    const home = rig();
    home.watchTheLeg();
    await home.startChat();
    home.host(settled(endOf('completed')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(aboutRuns(home)).toEqual([
      '✓ run 3f2a9c1e completed. Leave this chat to see it on the Home.',
    ]);
    await home.controller.teardownActive();
  });

  it('that fails says so', async () => {
    const home = rig();
    home.watchTheLeg();
    await home.startChat();
    home.host(settled(endOf('failed')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(aboutRuns(home)).toEqual([
      '✗ run 3f2a9c1e failed. Leave this chat to see it on the Home.',
    ]);
    await home.controller.teardownActive();
  });

  it('says it once: another read of the host, and a later leg of the same run, repeat nothing of the first end', async () => {
    const home = rig();
    home.watchTheLeg();
    await home.startChat();
    const first = endOf('paused');
    home.log([PARKED]);
    home.host(settled(first));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(aboutRuns(home)).toHaveLength(1);

    // The gate is answered elsewhere and a resumed leg executes: the host still holds the first end as its last. `/resume` in the chat reads
    // the host again as it ends, and the first end is not announced a second time.
    home.host({
      launching: false,
      active: { leg: 'resume', runId: RUN, cancelling: false },
      last: first,
    });
    home.controller.handlePaste('/resume');
    home.controller.handleKey('', { return: true });
    await home.advance(HOSTED_RUN_POLL_MS * 4);
    expect(home.announced, 'the resume ended (its one notification)').toContain('resumed');
    expect(said(home), 'and nothing of it is a line in the chat').not.toContain('resumed');
    expect(aboutRuns(home), 'the first end is not announced again').toHaveLength(1);

    // That leg parks again: a new end, and the chat is told once more, and only once.
    home.host(settled(endOf('paused')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(aboutRuns(home)).toHaveLength(2);
    await home.advance(HOSTED_RUN_POLL_MS * 8);
    expect(aboutRuns(home)).toHaveLength(2);
    await home.controller.teardownActive();
  });

  it.each(['cancelled', 'uncertain', 'taken_over', 'settled'] as const)(
    'that ended %s says nothing: the person asked for it, or the exit line carries it',
    async (disposition) => {
      const home = rig();
      home.watchTheLeg();
      await home.startChat();
      home.host(settled(endOf(disposition)));
      await home.advance(HOSTED_RUN_POLL_MS);
      expect(aboutRuns(home)).toEqual([]);
      await home.controller.teardownActive();
    },
  );

  it('carries no control sequence from a workflow slug that had one', async () => {
    const home = rig();
    home.watchTheLeg();
    await home.startChat();
    home.log([{ ...PARKED, workflow: 'dep\u001b[2Jloy\nforged' }]);
    home.host(settled(endOf('paused')));
    await home.advance(HOSTED_RUN_POLL_MS);
    const [line] = aboutRuns(home);
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex -- the assertion is that no control survives
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
    await home.controller.teardownActive();
  });
});

describe('a leg that ends with no chat in front', () => {
  it('says nothing to a chat that is started afterwards: the strip is where the landing shows it', async () => {
    const home = rig();
    home.watchTheLeg();
    home.log([PARKED]);
    home.host(settled(endOf('paused')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(home.controller.getSnapshot().mode).toBe('home');
    await home.startChat();
    await home.advance(HOSTED_RUN_POLL_MS * 8);
    expect(aboutRuns(home), 'the end was seen on the landing').toEqual([]);
    await home.controller.teardownActive();
  });

  it('says nothing while the run`s own view is in front, and nothing to a chat that opens after it is left', async () => {
    const home = rig();
    expect(home.controller.openScreen('run-view', { runId: RUN })).toBe(true);
    home.log([PARKED]);
    home.host(settled(endOf('paused')));
    await home.advance(HOSTED_RUN_POLL_MS);
    expect(home.controller.getSnapshot().screen?.kind).toBe('run-view');
    home.controller.closeScreen();
    await home.startChat();
    await home.advance(HOSTED_RUN_POLL_MS * 8);
    expect(aboutRuns(home)).toEqual([]);
    await home.controller.teardownActive();
  });

  it('says nothing of an end the host already held when the Home opened', async () => {
    const home = rig(settled(endOf('completed')));
    await home.startChat();
    // `/resume` in the chat reads the host again as it ends: the end it holds is older than this Home.
    home.controller.handlePaste('/resume');
    home.controller.handleKey('', { return: true });
    await home.advance(HOSTED_RUN_POLL_MS * 4);
    expect(home.announced, 'the resume ended (its one notification)').toContain('resumed');
    expect(said(home)).not.toContain('resumed');
    expect(aboutRuns(home)).toEqual([]);
    await home.controller.teardownActive();
  });

  it('a run another process ended is not this Home`s to announce: no leg here, no end here', async () => {
    const home = rig(IDLE);
    await home.startChat();
    await home.advance(HOSTED_RUN_POLL_MS * 8);
    expect(aboutRuns(home)).toEqual([]);
    expect(OTHER).not.toBe(RUN);
    await home.controller.teardownActive();
  });
});
