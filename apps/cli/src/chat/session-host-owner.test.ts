import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../config/resolve.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { createSessionPersister } from './persister.js';
import {
  buildChatSession,
  type BuildChatSessionOptions,
  type SessionUsageWriter,
} from './session-host.js';
import { SessionHostOwner } from './session-host-owner.js';
import { scriptedProvider, scriptedResolver, textTurn } from './test-support.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function invocationFixture() {
  const clock = { now: () => 0, schedule: () => () => undefined };
  const registry = new InvocationRegistry(clock);
  return {
    registry,
    finiteExit: createInvocationFiniteExit(registry, clock, {
      exit: vi.fn(),
      setExitCode: vi.fn(),
    }),
    seedFileCatalogOnce: () => Promise.resolve(),
  };
}

function options(): BuildChatSessionOptions {
  return {
    chat: resolveConfig({}).chat,
    agentRef: undefined,
    cwd: '/tmp',
    projectConfigDir: undefined,
    now: () => Date.parse('2026-10-16T00:00:00Z'),
    uuid: () => 'owned-session',
    providers: scriptedResolver([textTurn('synthetic reply')]),
    onListenerError: () => undefined,
  };
}

async function fixture(
  configure: (opts: BuildChatSessionOptions) => BuildChatSessionOptions = (opts) => opts,
  wrap: (writer: SessionUsageWriter) => SessionUsageWriter = (writer) => writer,
) {
  const invocation = invocationFixture();
  const owner = new SessionHostOwner(invocation, 'chat');
  const built = await owner.build((workOwner) =>
    buildChatSession({ ...configure(options()), workOwner }),
  );
  const client = createClient();
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  let ordinal = 0;
  const persister = owner.createPersister(() =>
    createSessionPersister({
      mode: 'fresh',
      usageStore: createSessionUsageStore(client.db),
      attachUsageWriter: (writer) => built.attachUsageWriter(wrap(writer)),
      store,
      handle: built.handle,
      governor: built.governor,
      attachDurabilityProbe: built.attachDurabilityProbe,
      attachEffectTurnAllocator: built.attachEffectTurnAllocator,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now: () => Date.parse('2026-10-16T00:00:00Z'),
      uuid: () => `owned-message-${++ordinal}`,
    }),
  );
  persister.start();
  built.session.start();
  return { invocation, owner, built, client, store, persister };
}

describe('actual session builder, persister and host cleanup ownership', () => {
  it.each([false, true])(
    'owns reporter failure %s without fatalizing a successfully reported passive fault',
    async (faulted) => {
      const cause = new TypeError('PRIVATE_REPORTER_FAILURE');
      const notes: string[] = [];
      const f = await fixture((opts) => ({
        ...opts,
        onListenerError: (note) => {
          if (faulted) throw cause;
          notes.push(note);
        },
      }));
      const remove = f.built.handle.subscribe((event) => {
        if (event.type === 'session:turn_started') throw new Error('synthetic passive listener');
      });
      try {
        f.persister.beginUserTurn('synthetic prompt');
        await f.owner.work.enter(() => f.built.session.sendMessage('synthetic prompt'));
        expect(f.owner.work.firstFailure?.cause, 'REPORTER_ORIGINAL_CAUSE').toBe(
          faulted ? cause : undefined,
        );
        expect(f.invocation.registry.observations.exitCode()).toBe(faulted ? 9 : 0);
        expect(
          f.store.loadMessages(f.built.sessionId).filter((message) => message.role === 'assistant'),
        ).toHaveLength(faulted ? 0 : 1);
        if (!faulted)
          expect(notes).toContainEqual(expect.stringContaining('synthetic passive listener'));
      } finally {
        remove();
        await f.owner.work.close();
        f.persister.close();
        f.client.sqlite.close();
      }
      expect(f.invocation.registry.activeOwners).toBe(0);
    },
  );

  it('joins the complete real session and records its final terminal before releasing the host', async () => {
    const f = await fixture();
    try {
      expect(f.built.workOwner).toBe(f.owner.work);
      f.persister.beginUserTurn('synthetic prompt');
      await f.owner.work.enter(() => f.built.session.sendMessage('synthetic prompt'));
      expect(f.store.loadMessages(f.built.sessionId)).toHaveLength(2);
      expect(f.invocation.registry.activeOwners).toBe(1);
      await f.owner.work.close();
      await reactions();
      expect(f.store.loadSession(f.built.sessionId)?.status).toBe('ended');
      expect(f.persister.durabilityFailure).toBeUndefined();
      expect(f.invocation.registry.activeOwners).toBe(0);
      expect(f.invocation.registry.observations.exitCode()).toBe(0);
    } finally {
      f.persister.close();
      f.client.sqlite.close();
    }
  });

  it('retains actual provider work after cancellation instead of treating the session terminal as quiescence', async () => {
    const started = gate();
    const producer = gate();
    const provider = {
      ...scriptedProvider([]),
      stream: async function* () {
        started.release();
        await producer.promise;
        yield* textTurn('late synthetic reply');
      },
    };
    const f = await fixture((opts) => ({
      ...opts,
      providers: { resolveProvider: () => provider, keyFor: () => 'synthetic-test-key' },
    }));
    let turn: Promise<void> | undefined;
    try {
      f.persister.beginUserTurn('synthetic prompt');
      turn = f.owner.work.enter(() => f.built.session.sendMessage('synthetic prompt'));
      await started.promise;
      let retired = false;
      const closing = f.owner.work.close();
      void closing.then(() => {
        retired = true;
      });
      await reactions();
      expect(f.store.loadSession(f.built.sessionId)?.status).toBe('ended');
      expect(retired, 'SESSION_NATIVE_ROOT_OUTLIVES_CANCEL_TERMINAL').toBe(false);
      expect(f.invocation.registry.activeOwners).toBe(1);
      producer.release();
      await turn;
      await reactions();
      expect(f.owner.work.firstFailure).toBeUndefined();
      await closing;
      await reactions();
      expect(f.invocation.registry.activeOwners).toBe(0);
      expect(f.store.loadMessages(f.built.sessionId)).toHaveLength(0);
    } finally {
      producer.release();
      await turn;
      f.persister.close();
      f.client.sqlite.close();
    }
  });

  it('retains a real terminal persistence refusal through actual cleanup and repeated barriers', async () => {
    const f = await fixture();
    try {
      f.client.sqlite.exec(
        "CREATE TRIGGER refuse_owned_terminal BEFORE UPDATE ON agent_sessions WHEN NEW.status = 'ended' BEGIN SELECT RAISE(ABORT, 'synthetic_terminal_refusal'); END",
      );
      let retired = false;
      void f.owner.work.close().then(() => {
        retired = true;
      });
      await reactions();
      expect(f.persister.durabilityFailure).toBeDefined();
      expect(f.store.loadSession(f.built.sessionId)?.status).toBe('active');
      await expect(f.built.whenHostSafeToClose()).rejects.toBe(f.persister.durabilityFailure);
      await expect(f.built.whenHostSafeToClose()).rejects.toBe(f.persister.durabilityFailure);
      expect(retired, 'SESSION_TERMINAL_PERSISTENCE_FAILURE_RETAINED').toBe(false);
      expect(f.invocation.registry.activeOwners).toBe(1);
      expect(f.invocation.registry.observations.exitCode()).toBe(9);
    } finally {
      // Administrative fixture disposal after actual work quiescence, not product retirement permission.
      f.persister.close();
      f.client.sqlite.close();
    }
  });

  it('starts the common fatal budget for a refused terminal write before a held provider tail joins', async () => {
    const started = gate();
    const producer = gate();
    const provider = {
      ...scriptedProvider([]),
      stream: async function* () {
        started.release();
        await producer.promise;
        yield* textTurn('late synthetic reply');
      },
    };
    const f = await fixture((opts) => ({
      ...opts,
      providers: { resolveProvider: () => provider, keyFor: () => 'synthetic-test-key' },
    }));
    let turn: Promise<void> | undefined;
    try {
      f.client.sqlite.exec(
        "CREATE TRIGGER refuse_held_terminal BEFORE UPDATE ON agent_sessions WHEN NEW.status = 'ended' BEGIN SELECT RAISE(ABORT, 'synthetic_held_terminal_refusal'); END",
      );
      f.persister.beginUserTurn('synthetic prompt');
      turn = f.owner.work.enter(() => f.built.session.sendMessage('synthetic prompt'));
      await started.promise;
      void f.owner.work.close();
      await reactions();
      expect(f.persister.durabilityFailure).toBeDefined();
      expect(
        f.invocation.registry.budget.deadline(),
        'SESSION_TERMINAL_FAILURE_BEFORE_HELD_PROVIDER_JOIN',
      ).toBe(3000);
      expect(f.invocation.registry.observations.exitCode()).toBe(9);
      expect(f.invocation.registry.activeOwners).toBe(1);
      producer.release();
      await turn;
      await reactions();
      expect(f.invocation.registry.activeOwners).toBe(1);
    } finally {
      producer.release();
      await turn;
      // Actual test-owned work has settled; this administrative close grants no product ACK.
      f.persister.close();
      f.client.sqlite.close();
    }
  });

  it('preserves a committed native charge when its post-ACK publication fails', async () => {
    let acknowledged = false;
    let records = 0;
    const f = await fixture(undefined, (writer) => ({
      ...writer,
      readSnapshot: () => {
        if (acknowledged) throw new Error('PRIVATE_POST_ACK_PROJECTION_FAILURE');
        if (writer.readSnapshot === undefined) throw new Error('Fixture snapshot is absent.');
        return writer.readSnapshot();
      },
      record: async (draft, cumulative) => {
        await writer.record(draft, cumulative);
        records += 1;
        acknowledged = true;
      },
    }));
    try {
      f.persister.beginUserTurn('synthetic prompt');
      await f.owner.work.enter(() => f.built.session.sendMessage('synthetic prompt'));
      await reactions();
      expect(records).toBe(1);
      expect(
        f.store.loadSessionCostBreakdown(f.built.sessionId).totalCostMicrocents,
      ).toBeGreaterThan(0);
      expect(f.invocation.registry.observations.exitCode()).toBe(9);
      expect(f.invocation.registry.activeOwners, 'SESSION_POST_ACK_PUBLICATION_RETAINS_OWNER').toBe(
        1,
      );
      await expect(f.built.whenHostSafeToClose()).rejects.toThrow(
        'session accounting publication failed',
      );
    } finally {
      // The fixture can inspect/dispose its native database; the product owner remains unacknowledged.
      f.persister.close();
      f.client.sqlite.close();
    }
  });

  it('adopts a late builder before cleanup and does not publish it after its owner stopped', async () => {
    const invocation = invocationFixture();
    const owner = new SessionHostOwner(invocation, 'home');
    const built = await buildChatSession(options());
    const publish = gate();
    const close = gate();
    const closeMcp = vi.fn(() => close.promise);
    const opening = owner.build(async () => {
      await publish.promise;
      return { ...built, closeMcp };
    });
    const result = opening.catch((cause: unknown) => cause);
    owner.work.stop();
    let retired = false;
    const closing = owner.work.close();
    void closing.then(() => {
      retired = true;
    });
    await reactions();
    expect(closeMcp).not.toHaveBeenCalled();
    publish.release();
    expect(owner.work.isStoppedFailure(await result)).toBe(true);
    await reactions();
    expect(closeMcp).toHaveBeenCalledOnce();
    expect(retired, 'SESSION_LATE_BUILD_ADOPTION_BEFORE_RETIREMENT').toBe(false);
    close.release();
    await closing;
    await reactions();
    expect(invocation.registry.activeOwners).toBe(0);
  });

  it('cannot overwrite an existing construction with a second builder on the same reservation', async () => {
    const invocation = invocationFixture();
    const owner = new SessionHostOwner(invocation, 'home');
    const first = await owner.build((workOwner) => buildChatSession({ ...options(), workOwner }));
    const second = vi.fn(() => buildChatSession(options()));
    expect(() => owner.build(second)).toThrow('Session construction is already owned.');
    expect(second).not.toHaveBeenCalled();
    expect(first.workOwner).toBe(owner.work);
    await owner.work.close();
  });
});
