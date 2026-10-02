import {
  createClient,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileResumedSessionEffects } from '../../engine/effect-retention.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { sanitizeInline } from '../sanitize.js';
import { captureIo } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let client: DbClient;
const rows = () => client.sqlite.prepare('SELECT * FROM run_effects').all();
function submit(controller: HomeController) {
  controller.handlePaste('synthetic prompt');
  controller.handleKey('', { return: true });
}
function session(onNotice?: () => void, flushNotice?: () => Promise<void>) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const io = captureIo();
  const processLine = vi.fn(() => Promise.resolve());
  const teardown = vi.fn(() => Promise.resolve());
  const onActivated = vi.fn((isActive: () => boolean) =>
    reconcileResumedSessionEffects({
      io: io.io,
      db: client.db,
      sessionId: 's1',
      sanitize: sanitizeInline,
      isActive,
      ...(flushNotice === undefined
        ? {}
        : {
            flushNotice: async (publish: (() => void | Promise<void>) | undefined) => {
              await publish?.();
              await flushNotice();
            },
          }),
      deliverNotice: (text) => {
        expect(rows()).toHaveLength(1);
        store.notice(text);
        onNotice?.();
      },
    }),
  );
  const built: HomeChatSession = {
    store,
    sessionId: 's1',
    processLine,
    teardown,
    onActivated,
    shouldStop: () => false,
    stopReason: () => 'exit',
  };
  return { built, store, processLine, teardown, onActivated };
}
function controller(startChat: () => Promise<HomeChatSession>) {
  return createHomeController({
    startChat,
    homeStore: { read: () => EMPTY },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    onExit: vi.fn(),
    onError: vi.fn(),
  });
}

beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
  createSessionStore(client.db).reserveOneShotEffectTurnKey('s1', 1);
  const journal = createEffectJournalStore(client.db, { uuid: () => 'e1', now: () => 1 });
  const identity = { scope: 'session:s1:1', slot: 0, toolId: 'run_command' };
  journal.prepare(
    identity,
    { kind: 'session', sessionId: 's1', turn: 1 },
    { providerAttempt: 1, toolCallId: 'session-tool:1:0' },
    3,
    'digest',
  );
  journal.settle(identity, 'committed');
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
});

describe('Home activation owns disclosure evidence (ADR-0098)', () => {
  it.each([false, true])(
    'gates the first message until rendered disclosure settles (exit=%s)',
    async (exit) => {
      let acknowledge: () => void = () => undefined;
      const flushed = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const made = session(undefined, () => flushed);
      const c = controller(() => Promise.resolve(made.built));
      submit(c);
      await flush();
      expect(rows()).toHaveLength(1);
      expect(c.getSnapshot().submitBusy).toBe(true);
      expect(made.processLine).not.toHaveBeenCalled();
      c.handlePaste('premature second message');
      c.handleKey('', { return: true });
      expect(made.processLine).not.toHaveBeenCalled();
      if (exit) await c.teardownActive();
      acknowledge();
      await flush();
      expect(rows()).toHaveLength(exit ? 1 : 0);
      expect(made.processLine).toHaveBeenCalledTimes(exit ? 0 : 1);
      if (!exit) await c.teardownActive();
    },
  );

  it('publishes the active transcript before disclosure, then sweeps once before accepting a message', async () => {
    const made = session();
    const c = controller(() => Promise.resolve(made.built));
    let published = false;
    c.subscribe(() => {
      if (c.getSnapshot().session === made.built) published = true;
    });
    made.store.subscribe(() => {
      expect(published).toBe(true);
      expect(c.getSnapshot().session).toBe(made.built);
    });
    submit(c);
    await flush();
    expect(made.onActivated).toHaveBeenCalledTimes(1);
    expect(
      made.store
        .getSnapshot()
        .state.transcript.some(
          (entry) =>
            entry.role === 'notice' &&
            entry.text.includes('landed in a turn that did not complete'),
        ),
    ).toBe(true);
    expect(rows()).toEqual([]);
    expect(made.processLine).toHaveBeenCalledTimes(1);
    c.handlePaste('next');
    c.handleKey('', { return: true });
    await flush();
    expect(made.onActivated).toHaveBeenCalledTimes(1);
    await c.teardownActive();
  });

  it('never activates or sweeps a build discarded by a mid-build exit', async () => {
    const made = session();
    let resolve: ((session: HomeChatSession) => void) | undefined;
    const c = controller(
      () =>
        new Promise<HomeChatSession>((done) => {
          resolve = done;
        }),
    );
    submit(c);
    const teardown = c.teardownActive();
    if (resolve === undefined) throw new Error('builder was not called');
    resolve(made.built);
    await teardown;
    await flush();
    expect(made.onActivated).not.toHaveBeenCalled();
    expect(made.processLine).not.toHaveBeenCalled();
    expect(made.teardown).toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('rechecks ownership after a publication subscriber synchronously exits', async () => {
    const made = session();
    const c = controller(() => Promise.resolve(made.built));
    let teardown: Promise<void> | undefined;
    c.subscribe(() => {
      if (c.getSnapshot().session === made.built && teardown === undefined)
        teardown = c.teardownActive();
    });
    submit(c);
    await flush();
    await teardown;
    expect(made.onActivated).not.toHaveBeenCalled();
    expect(made.processLine).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('retains the row and sends no first message when disclosure synchronously tears the active Home down', async () => {
    let teardown: Promise<void> | undefined;
    const made = session(() => {
      teardown = c.teardownActive();
    });
    const c = controller(() => Promise.resolve(made.built));
    submit(c);
    await flush();
    await teardown;
    expect(made.onActivated).toHaveBeenCalledTimes(1);
    expect(made.processLine).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('contains a throwing activation hook without an unhandled build rejection or deletion', async () => {
    const made = session();
    const broken = {
      ...made.built,
      onActivated: () => {
        throw new Error('SYNTHETIC_PRIVATE_ERROR');
      },
    };
    const c = controller(() => Promise.resolve(broken));
    submit(c);
    await flush();
    expect(c.getSnapshot().session).toBe(broken);
    expect(
      made.store
        .getSnapshot()
        .state.transcript.some(
          (entry) =>
            entry.role === 'notice' &&
            entry.text === 'warning: session effect disclosure could not be completed.',
        ),
    ).toBe(true);
    expect(rows()).toHaveLength(1);
    await c.teardownActive();
  });
});
