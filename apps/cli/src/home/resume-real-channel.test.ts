/**
 * `/resume` opens its conversation through the REAL Home (MVP-11 unit 6, round 1: O1 = C-F1). The real `driveHome`, controller, native prompt
 * channel and its `/resume` popup frame, the real Ink root (`RootApp` mounted on a fake terminal, so the flush that acknowledges a notice is the
 * product's `useVisibleRenderFlush` over the product's native acknowledgement), the real resumed-session builder over SQLite, and the
 * invocation's work owner, under which a disclosure that cannot be delivered is FATAL (`engine/effect-retention.ts`, `deliver`).
 *
 * The conversation resumed has a committed external effect to disclose: its activation publishes a notice and waits until the frame that
 * shows it is flushed. Adopted while the `/resume` popup was still open, that wait waited on the popup, the popup's close aborted it, and the
 * whole CLI exited 9 (`relavium: CLI output could not be delivered`) on every successful resume from the Home, from a Home chat and from a
 * Sessions-strip row. The conversation is adopted only once the popup has closed and the channel is idle.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
} from '@relavium/db';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { buildResumedChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import {
  createHomeController,
  RESUME_ALREADY_OPEN,
  RESUME_CANCELLED,
  type HomeChatSession,
  type HomeControllerDeps,
} from '../render/tui/home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { mountInk, type InkMount } from '../render/tui/surface-matrix/mount.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

/** The `/resume` picker answers no `Enter` until its popup's opening settle has passed on screen: the test waits that long, once. */
const PAST_THE_OPENING_MS = POPUP_SELECT_SETTLE_MS + 100;
/** How long a resume may take to open its conversation here (a restore, a build, a flushed disclosure): a bound on a defect, not a delay. */
const RESUME_OPENS_WITHIN_MS = 5000;
/** How long a chat may take to build and answer, or the picker to read its first page: bounds on a defect, not delays. */
const CHAT_ANSWERS_WITHIN_MS = 15_000;
const PICKER_LOADS_WITHIN_MS = 5000;
/** One journey: two or three chats built and answered, a resume, a restore and its disclosure, on a real Home and a real Ink root. */
const JOURNEY_TIMEOUT_MS = 60_000;
const SIZE = { cols: 120, rows: 40 } as const;
const DOWN = '\u001b[B';
const ENTER = '\r';
const DISCLOSURE = 'external effect(s) from earlier turns need attention';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RealHome {
  readonly props: RootAppProps;
  readonly mount: () => InkMount;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly effects: () => unknown[];
  readonly seedEffect: (sessionId: string) => void;
  /** Every work owner the Home handed a resumed conversation's builder, in order. */
  readonly resumedOwners: readonly SessionWorkOwner[];
  readonly fixture: ReturnType<typeof invocationFixture>;
}

async function withRealHome(use: (home: RealHome) => Promise<void>): Promise<void> {
  const f = invocationFixture();
  const client = createClient(':memory:');
  runMigrations(client.db);
  const sessions = createSessionStore(client.db);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-resume-real-')));
  const cwd = join(root, 'workspace');
  const homeDir = join(root, 'operator');
  mkdirSync(cwd);
  mkdirSync(join(homeDir, '.relavium'), { recursive: true });
  const configPath = join(homeDir, '.relavium', 'config.toml');
  // The startup hint already shown, so no first-chat hint holds the keyboard.
  writeFileSync(configPath, '[preferences]\ndefault_mode="ask"\ndefault_mode_hint_shown=true\n');
  let props: RootAppProps | undefined;
  let mounted: InkMount | undefined;
  const resumedOwners: SessionWorkOwner[] = [];
  let id = 0;
  let tick = 0;
  let finishRender = (): void => {};
  const exited = new Promise<void>((resolve) => {
    finishRender = resolve;
  });
  let escaped: unknown;
  const running = driveHome({
    homeDir,
    // No tool-output store: the operator directory here is a test's, not a private one.
    outputStoreFactory: () => Promise.resolve(undefined),
    invocation: f.invocation,
    io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true },
    global: { cwd, configPath, json: false, color: false, verbosity: 'normal' },
    providers: scriptedResolver([textTurn('first'), textTurn('second'), textTurn('third')]),
    // A clock that moves, so the conversations of the picker have an order.
    now: () => Date.parse('2026-11-26T00:00:00.000Z') + 1000 * tick++,
    uuid: () => `resume-real-${String(++id)}`,
    buildResumedSession: (options) => {
      if (options.workOwner !== undefined) resumedOwners.push(options.workOwner);
      return buildResumedChatSession(options);
    },
    openSessionStore: () => ({
      store: sessions,
      db: client.db,
      close: () => client.sqlite.close(),
    }),
    // The product's root on a fake terminal: its `onRendererReady` hands the Home the REAL visible-render flush.
    render: (value) => {
      props = value;
      mounted = mountInk(createElement(RootApp, value), {
        renderer: value.alternateScreen === true ? 'alt' : 'inline',
        color: false,
        size: SIZE,
      });
      const mount = mounted;
      return {
        unmount: () => {
          mount.unmount();
          finishRender();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => mount.settle(),
      };
    },
    getSize: () => SIZE,
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
  }).catch((cause: unknown) => {
    escaped = cause;
    return undefined;
  });
  try {
    await vi.waitFor(() => expect(props).toBeDefined());
    if (props === undefined || mounted === undefined) throw new Error('Home did not mount');
    const mount = mounted;
    await use({
      props,
      mount: () => mount,
      sessions,
      effects: () => client.sqlite.prepare('SELECT state FROM run_effects').all(),
      seedEffect: (sessionId) => {
        const turn = sessions.reserveEffectTurnKey(sessionId);
        const identity = {
          scope: `session:${encodeURIComponent(sessionId)}:${String(turn)}`,
          slot: 0,
          toolId: 'run_command',
        };
        const journal = createEffectJournalStore(client.db, {
          uuid: () => `resume-real-effect-${sessionId}`,
          now: Date.now,
        });
        journal.prepare(
          identity,
          { kind: 'session', sessionId, turn },
          { providerAttempt: 1, toolCallId: `resume-real-call-${sessionId}` },
          3,
          'digest',
        );
        journal.settle(identity, 'committed', 'done');
      },
      resumedOwners,
      fixture: f,
    });
  } finally {
    mounted?.unmount();
    finishRender();
    if (f.registry.activeOwners > 0) f.invocation.finiteExit.signal(15);
    await running;
    if (client.sqlite.open) client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
  expect(escaped, 'the Home ended without a fault').toBeUndefined();
}

/** Type a message on the Home (or in its chat) and wait for the conversation it lands in to be idle, its reply durable. */
async function send(home: RealHome, text: string): Promise<HomeChatSession> {
  const { controller } = home.props;
  for (const char of text) controller.handleKey(char, {});
  controller.handleKey('', { return: true });
  await vi.waitFor(
    () => {
      const snapshot = controller.getSnapshot();
      expect(snapshot.mode).toBe('chat');
      expect(snapshot.submitBusy).toBe(false);
      expect(snapshot.session?.store.getSnapshot().state.status).toBe('idle');
    },
    { timeout: CHAT_ANSWERS_WITHIN_MS, interval: 20 },
  );
  const session = controller.getSnapshot().session;
  if (session === undefined) throw new Error('Expected the chat the Home hosts.');
  await vi.waitFor(() =>
    expect(
      home.sessions
        .loadFull(session.sessionId)
        ?.messages.filter((message) => message.role === 'assistant').length,
    ).toBeGreaterThan(0),
  );
  return session;
}

/** `/cancel` in the Home's chat: back to the bare Home, the conversation saved. */
async function leaveChat(home: RealHome): Promise<void> {
  const { controller } = home.props;
  for (const char of '/cancel') controller.handleKey(char, {});
  controller.handleKey('', { return: true });
  await vi.waitFor(() => {
    expect(controller.getSnapshot().mode).toBe('home');
    expect(controller.getSnapshot().session).toBeUndefined();
  });
}

/** `/resume`, then the row of `sessionId` in its picker, chosen as a person does: on the terminal, once the popup has settled. */
async function resumeThroughPicker(home: RealHome, sessionId: string): Promise<void> {
  const { controller, nativePrompt } = home.props;
  if (nativePrompt === undefined) throw new Error('Expected the Home`s prompt channel.');
  controller.handlePaste('/resume');
  controller.handleKey('', { return: true });
  await vi.waitFor(
    () =>
      expect(nativePrompt.getSnapshot().options.map((option) => option.value)).toContain(sessionId),
    { timeout: PICKER_LOADS_WITHIN_MS, interval: 20 },
  );
  expect(nativePrompt.getSnapshot().popup).toMatchObject({ title: '/resume' });
  await pause(PAST_THE_OPENING_MS);
  const row = nativePrompt.getSnapshot().options.findIndex((option) => option.value === sessionId);
  for (let step = 0; step < row; step += 1) home.mount().key(DOWN);
  await vi.waitFor(() => expect(nativePrompt.getSnapshot().selected).toBe(row));
  home.mount().key(ENTER);
}

/** `↓` at the Home's empty prompt focuses the strip's first row (the latest conversation), and `Enter` resumes it. */
function resumeThroughStrip(home: RealHome): void {
  const { controller } = home.props;
  controller.handleKey('', { downArrow: true });
  controller.handleKey('', { return: true });
}

const ROUTES = ['the Home`s picker', 'a Home chat`s picker', 'a Sessions strip row'] as const;

describe('a resume opens its conversation, and its disclosure is delivered, only once the /resume popup has closed', () => {
  it.each(ROUTES)(
    'from %s: the conversation opens, its effect disclosure is shown and acknowledged, and the Home does not end',
    async (route) => {
      await withRealHome(async (home) => {
        const { controller, nativePrompt } = home.props;
        const saved = await send(home, 'hello');
        home.seedEffect(saved.sessionId);
        await leaveChat(home);
        let open: HomeChatSession | undefined;
        if (route === 'a Home chat`s picker') open = await send(home, 'another');
        if (route === 'a Sessions strip row') resumeThroughStrip(home);
        else await resumeThroughPicker(home, saved.sessionId);
        await vi.waitFor(
          () => {
            // The defect: the disclosure's wait was aborted by the popup's close, and the Home ended (exit 9, `output_unavailable`).
            const failure = home.resumedOwners.at(-1)?.firstFailure?.cause;
            expect(failure, 'the resumed conversation`s owner saw no failure').toBeUndefined();
            expect(home.fixture.registry.termination, 'the Home did not end').toBeUndefined();
            const snapshot = controller.getSnapshot();
            expect(snapshot.session?.sessionId).toBe(saved.sessionId);
            expect(snapshot.mode).toBe('chat');
            expect(snapshot.submitBusy, 'the activation finished').toBe(false);
          },
          { timeout: RESUME_OPENS_WITHIN_MS, interval: 20 },
        );
        // The popup is gone and the channel idle before anything was adopted; the disclosure is in the conversation and was acknowledged
        // (the committed row is swept only after the frame that shows it was flushed).
        expect(nativePrompt?.getSnapshot().active).toBe(false);
        const transcript = controller
          .getSnapshot()
          .session?.store.getSnapshot()
          .state.transcript.map((entry) => entry.text ?? '')
          .join('\n');
        expect(transcript).toContain(DISCLOSURE);
        await vi.waitFor(() => expect(home.effects()).toEqual([]));
        if (open !== undefined) expect(controller.getSnapshot().session).not.toBe(open);
        expect(home.fixture.registry.observations.exitCode(), `no failure observed`).toBe(0);
      });
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe('the Home adopts what the /resume frame came to only after the frame has closed', () => {
  interface FakeSession extends HomeChatSession {
    readonly torn: () => number;
    readonly activated: () => number;
  }
  const fakeSession = (sessionId: string): FakeSession => {
    let torn = 0;
    let activated = 0;
    return {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId,
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => {
        torn += 1;
        return Promise.resolve();
      },
      onActivated: () => {
        activated += 1;
      },
      torn: () => torn,
      activated: () => activated,
    };
  };
  function home(options: {
    readonly pick: string | undefined;
    readonly resume: NonNullable<HomeControllerDeps['resumeChat']>;
    /** What the frame does after its stages ran, before it reports itself closed. */
    readonly closing?: (controller: ReturnType<typeof createHomeController>) => Promise<void>;
  }) {
    const open = fakeSession('open-chat');
    const order: string[] = [];
    const sessionsSeen = new Set<HomeChatSession>();
    const controller: ReturnType<typeof createHomeController> = createHomeController({
      startChat: () => Promise.resolve(open),
      homeStore: {
        read: () => ({
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: true,
        }),
      },
      onExit: vi.fn(),
      onError: (cause) => {
        throw cause;
      },
      announce: (text) => order.push(`announce ${text}`),
      pickSession: () => Promise.resolve(options.pick),
      resumeChat: (id) => {
        order.push(`resume ${id}`);
        return options.resume(id);
      },
      resumeFrame: async (_origin, run) => {
        order.push('open');
        try {
          await run();
          await options.closing?.(controller);
        } finally {
          order.push('close');
        }
      },
    });
    controller.subscribe(() => {
      const session = controller.getSnapshot().session;
      if (session !== undefined) sessionsSeen.add(session);
    });
    return { controller, open, order, sessionsSeen };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const typeResume = async (h: ReturnType<typeof home>): Promise<void> => {
    h.controller.handlePaste('/resume');
    h.controller.handleKey('', { return: true });
    await settle();
    await settle();
  };
  const toChat = async (h: ReturnType<typeof home>): Promise<void> => {
    h.controller.handlePaste('hello');
    h.controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(h.controller.getSnapshot().mode).toBe('chat'));
    await vi.waitFor(() => expect(h.controller.getSnapshot().submitBusy).toBe(false));
  };

  it('a restored conversation is adopted and activated after the frame closed, never inside it', async () => {
    const resumed = fakeSession('s1');
    let activatedInsideTheFrame = -1;
    const h = home({
      pick: 's1',
      resume: () => Promise.resolve(resumed),
      closing: () => {
        activatedInsideTheFrame = resumed.activated();
        return Promise.resolve();
      },
    });
    await toChat(h);
    await typeResume(h);
    await vi.waitFor(() => expect(h.controller.getSnapshot().session).toBe(resumed));
    expect(activatedInsideTheFrame, 'nothing was activated while the frame was open').toBe(0);
    expect(resumed.activated()).toBe(1);
    expect(h.open.torn(), 'the conversation it replaced was closed').toBe(1);
    expect(h.order).toEqual(['open', 'resume s1', 'close']);
  });

  it('the Home leaves while the frame closes: the restored conversation is torn down and nothing is adopted', async () => {
    const resumed = fakeSession('s1');
    let leaving: Promise<void> | undefined;
    const h = home({
      pick: 's1',
      resume: () => Promise.resolve(resumed),
      // The Home begins to leave as the frame closes (its teardown joins the resume itself, so it is not awaited here).
      closing: (controller) => {
        leaving = controller.teardownActive();
        return Promise.resolve();
      },
    });
    await toChat(h);
    await typeResume(h);
    await vi.waitFor(() => expect(resumed.torn()).toBe(1));
    await leaving;
    expect(h.sessionsSeen.has(resumed), 'never the Home`s conversation').toBe(false);
    expect(resumed.activated()).toBe(0);
    expect(h.order).toEqual(['open', 'resume s1', 'close']);
  });

  it('a frame that fails to close after the restore built the conversation: it is torn down, nothing is adopted', async () => {
    const resumed = fakeSession('s1');
    const h = home({
      pick: 's1',
      resume: () => Promise.resolve(resumed),
      closing: () => Promise.reject(new Error('the frame could not close')),
    });
    await toChat(h);
    await typeResume(h);
    await vi.waitFor(() => expect(resumed.torn()).toBe(1));
    expect(h.sessionsSeen.has(resumed)).toBe(false);
    expect(resumed.activated()).toBe(0);
    // The action failed: the Home says so as it says any failed action, and the conversation that was open stays.
    expect(h.controller.getSnapshot().session).toBe(h.open);
    expect(h.controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it.each([
    ['the conversation that is already open', 'open-chat', RESUME_ALREADY_OPEN, ['open', 'close']],
    ['a cancelled restore', 's1', RESUME_CANCELLED, ['open', 'resume s1', 'close']],
  ] as const)(
    '%s: its one notification is said after the frame has closed',
    async (_case, pick, said, stages) => {
      const h = home({ pick, resume: () => Promise.resolve(undefined) });
      await toChat(h);
      await typeResume(h);
      await vi.waitFor(() => expect(h.order).toContain(`announce ${said}`));
      expect(h.order).toEqual([...stages, `announce ${said}`]);
      expect(h.controller.getSnapshot().session).toBe(h.open);
    },
  );

  it('the Home leaves while the frame closes: what the stages had to say is not said', async () => {
    let leaving: Promise<void> | undefined;
    const h = home({
      pick: 's1',
      resume: () => Promise.resolve(undefined),
      closing: (controller) => {
        leaving = controller.teardownActive();
        return Promise.resolve();
      },
    });
    await toChat(h);
    await typeResume(h);
    await vi.waitFor(() => expect(h.order).toContain('close'));
    await leaving;
    await settle();
    expect(h.order).toEqual(['open', 'resume s1', 'close']);
  });
});
