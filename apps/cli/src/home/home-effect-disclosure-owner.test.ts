import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
} from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { isCliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const DISCLOSURE_FAILED =
  'warning: session effect disclosure could not be completed; audit evidence was retained.';
const PRIVATE_RESULT = 'PRIVATE_EFFECT_RESULT /private/result-path';
const PRIVATE_DATABASE = 'PRIVATE_DISCLOSURE_DB_FAULT /private/database-path';

type Scenario =
  | 'healthy'
  | 'sync-notice-fault'
  | 'async-notice-fault'
  | 'async-flush-fault'
  | 'held-flush'
  | 'read-refusal'
  | 'unpublished-flush';

it.each<Scenario>([
  'healthy',
  'sync-notice-fault',
  'async-notice-fault',
  'async-flush-fault',
  'held-flush',
  'read-refusal',
  'unpublished-flush',
])('actual Home reseat owns effect disclosure: %s', async (scenario) => {
  const f = invocationFixture();
  const client = createClient(':memory:');
  runMigrations(client.db);
  const sessions = createSessionStore(client.db);
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-effect-owner-'));
  const captured = captureIo();
  const cause = new TypeError('PRIVATE_DISCLOSURE_PRODUCER_FAULT /private/output-path');
  const faulted = scenario.endsWith('-fault');
  let props: RootAppProps | undefined;
  let originalOwner: SessionWorkOwner | undefined;
  let resumedOwner: SessionWorkOwner | undefined;
  let finishRender = () => {};
  let releaseDelivery = () => {};
  const exited = new Promise<void>((resolve) => {
    finishRender = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  let closed = 0;
  let id = 0;
  let armed = false;
  let deliveryStarted = 0;
  let deliverySettled = false;
  let sinkCalls = 0;
  let refusedReads = 0;
  let resumedRetired = false;
  let settled = false;
  let retainedAtClose: unknown;
  const attemptedNotices: string[] = [];
  const running = driveHome({
    invocation: f.invocation,
    io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
    global: {
      cwd,
      configPath: join(cwd, 'absent-global.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    providers: scriptedResolver([textTurn('first'), textTurn('second')]),
    uuid: () => `home-effect-owner-${++id}`,
    buildSession: (options) => {
      originalOwner = options.workOwner;
      return buildChatSession(options);
    },
    buildResumedSession: async (options) => {
      resumedOwner = options.workOwner;
      const built = await buildResumedChatSession(options);
      // Fault only the disclosure projection AFTER the real resume loader succeeds. Other
      // SQLite queries and actual host construction stay live; this refusal is recoverable.
      if (scenario === 'read-refusal') {
        const prepare = client.sqlite.prepare.bind(client.sqlite);
        vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
          if (
            query.startsWith('select') &&
            query.includes('run_effects') &&
            query.includes('attempt_json')
          ) {
            refusedReads++;
            throw new Error(PRIVATE_DATABASE);
          }
          return prepare(query);
        });
      }
      return built;
    },
    openSessionStore: () => ({
      db: client.db,
      store: sessions,
      close: () => {
        retainedAtClose = client.sqlite.prepare('SELECT state FROM run_effects').all();
        closed++;
        client.sqlite.close();
      },
    }),
    // Actual controller, hosts, stores and SQLite; this acknowledged renderer seam is not a real TTY.
    render: (value) => {
      props = value;
      value.onRendererReady?.(async (publish) => {
        if (armed) {
          armed = false;
          const session = value.controller.getSnapshot().session;
          if (session === undefined) throw new Error('Expected reseated Home session.');
          const notice = session.store.notice.bind(session.store);
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Inject a runtime async sink fault through Home's original callback.
          vi.spyOn(session.store, 'notice').mockImplementation((text) => {
            attemptedNotices.push(text);
            if (text.includes('external effect(s)')) {
              sinkCalls++;
              if (scenario === 'sync-notice-fault') throw cause;
              if (scenario === 'async-notice-fault') return Promise.reject(cause);
            }
            return notice(text);
          });
          if (scenario === 'unpublished-flush') return;
          await publish?.();
          if (scenario === 'async-flush-fault') throw cause;
          if (scenario === 'held-flush') {
            deliveryStarted++;
            await delivery;
            deliverySettled = true;
          }
          return;
        }
        await publish?.();
      });
      return {
        unmount: finishRender,
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => Promise.resolve(),
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
    onboardingTerminalLifecycle: {
      onInput: () => () => {},
      isRawMode: () => false,
      setRawMode: () => {},
    },
  }).then((code) => {
    settled = true;
    return code;
  });
  try {
    if (props === undefined) throw new Error('Expected Home mount.');
    const controller = props.controller;
    const type = (text: string): void => {
      for (const char of text) controller.handleKey(char, {});
    };
    type('first');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(controller.getSnapshot().session).toBeDefined());
    await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false));
    const original = controller.getSnapshot().session;
    if (original === undefined) throw new Error('Expected original Home session.');
    // The first reply must really be durable before /models loads and reseats that session.
    await vi.waitFor(() =>
      expect(
        sessions
          .loadFull(original.sessionId)
          ?.messages.filter((message) => message.role === 'assistant'),
      ).toHaveLength(1),
    );
    const turn = sessions.reserveEffectTurnKey(original.sessionId);
    const journal = createEffectJournalStore(client.db, {
      uuid: () => 'home-effect-owner-effect',
      now: Date.now,
    });
    const identity = {
      scope: `session:${encodeURIComponent(original.sessionId)}:${String(turn)}`,
      slot: 0,
      toolId: 'run_command',
    };
    journal.prepare(
      identity,
      { kind: 'session', sessionId: original.sessionId, turn },
      { providerAttempt: 1, toolCallId: 'home-effect-owner-call' },
      3,
      'digest',
    );
    journal.settle(identity, 'committed', PRIVATE_RESULT);
    armed = true;
    controller.handleKey('/', {});
    type('models');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(controller.getSnapshot().modelPicker).toBeDefined());
    type('claude-opus-4-8');
    controller.handleKey('', { return: true });
    if (controller.getSnapshot().modelPicker?.phase === 'effort')
      controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(resumedOwner).toBeDefined());
    expect(originalOwner).toBeDefined();
    expect(resumedOwner).not.toBe(originalOwner);
    if (resumedOwner === undefined) throw new Error('Expected original resumed owner.');
    const retired = resumedOwner.retired.then(() => {
      resumedRetired = true;
    });
    if (faulted) {
      await vi.waitFor(() => expect(resumedOwner?.firstFailure).toBeDefined());
      const failure = resumedOwner?.firstFailure?.cause;
      expect(isCliError(failure), 'original session owns disclosure output failure').toBe(true);
      if (!isCliError(failure)) throw new Error('Expected classified output failure.');
      expect(failure.code).toBe('output_unavailable');
      expect(failure.cause, 'retain the exact producer cause before advisory recovery').toBe(cause);
      expect(f.registry.termination).toBeDefined();
      expect(sinkCalls).toBe(1);
    } else if (scenario === 'held-flush') {
      await vi.waitFor(() => expect(deliveryStarted).toBe(1));
      expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
        { state: 'committed' },
      ]);
      expect(controller.getSnapshot().submitBusy).toBe(true);
      finishRender();
      await flush();
      await flush();
      expect(settled, 'Home result must join the actual pending acknowledgement').toBe(false);
      expect(deliverySettled).toBe(false);
      expect(closed, 'pending output cannot release the shared database').toBe(0);
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      expect(resumedRetired, 'the actual resumed host still owns its pending delivery').toBe(false);
      expect(resumedOwner?.firstFailure).toBeUndefined();
      expect(f.registry.termination).toBeUndefined();
      releaseDelivery();
    } else {
      await vi.waitFor(() => expect(controller.getSnapshot().session).not.toBe(original));
      await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false));
      const resumed = controller.getSnapshot().session;
      if (resumed === undefined) throw new Error('Expected active reseated Home session.');
      expect(resumed.sessionId).toBe(original.sessionId);
      const text = resumed.store
        .getSnapshot()
        .state.transcript.map((entry) => entry.text ?? '')
        .join('\n');
      attemptedNotices.push(text);
      if (scenario === 'read-refusal' || scenario === 'unpublished-flush') {
        expect(text).toContain(DISCLOSURE_FAILED);
        if (scenario === 'read-refusal') expect(refusedReads).toBeGreaterThan(0);
        else expect(sinkCalls).toBe(0);
        expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([
          { state: 'committed' },
        ]);
      } else {
        expect(text).toContain('external effect(s) from earlier turns need attention');
        expect(client.sqlite.prepare('SELECT state FROM run_effects').all()).toEqual([]);
        expect(sinkCalls).toBe(1);
      }
      expect(resumedOwner?.firstFailure).toBeUndefined();
      expect(f.registry.termination).toBeUndefined();
    }
    finishRender();
    expect(await running).toBe(faulted ? 9 : 0);
    await retired;
    expect(resumedRetired).toBe(true);
    if (scenario === 'held-flush') expect(deliverySettled).toBe(true);
    expect(retainedAtClose).toEqual(scenario === 'healthy' ? [] : [{ state: 'committed' }]);
    expect(closed).toBe(1);
    expect(client.sqlite.open).toBe(false);
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
    const publicText = `${captured.out()}${captured.err()}${attemptedNotices.join('\n')}`;
    for (const secret of [PRIVATE_RESULT, PRIVATE_DATABASE, cause.message, '/private/'])
      expect(publicText).not.toContain(secret);
  } finally {
    releaseDelivery();
    finishRender();
    await running;
    vi.restoreAllMocks();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
