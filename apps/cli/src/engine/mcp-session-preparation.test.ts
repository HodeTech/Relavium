import {
  McpAbortedError,
  McpError,
  startMcpClient as actualStartMcpClient,
  type McpClient,
} from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { SessionHostOwner } from '../chat/session-host-owner.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { closePreparedMcp, connectAgentMcp, type ConnectAgentMcpOptions } from './mcp-servers.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function client(close: McpClient['close'] = () => Promise.resolve()): McpClient {
  return {
    capability: { call: () => Promise.resolve({ content: [], isError: false }) },
    toolDefs: [],
    toolIdsByServer: new Map(),
    childPids: [],
    skipped: [],
    close,
  };
}

const refs: readonly McpServerRef[] = [
  {
    id: 'owned',
    transport: 'stdio',
    command: 'synthetic-never-spawned',
    env: { AUTH: '{{secrets.synthetic}}' },
  },
];

function ownerFixture() {
  const clock = { now: () => 0, schedule: () => () => undefined };
  const registry = new InvocationRegistry(clock);
  const invocation = {
    registry,
    finiteExit: createInvocationFiniteExit(registry, clock, {
      exit: vi.fn(),
      setExitCode: vi.fn(),
    }),
    seedFileCatalogOnce: () => Promise.resolve(),
  };
  const owner = new SessionWorkOwner(invocation, 'chat', {
    cancel: () => undefined,
    cleanup: () => Promise.resolve(),
  });
  const options = {
    cwd: '/tmp',
    assertAdmitting: owner.assertAdmitting,
    connectSignal: owner.signal,
    onFailure: owner.failure,
    onCloseError: (_id: string, cause: unknown) => owner.cleanupUncertain(cause),
    work: owner.work,
    budget: registry.budget,
  };
  return { owner, registry, options };
}

describe('session preparation keeps its original owner across MCP consent and startup', () => {
  it('refuses a late consent answer before resolving a secret or constructing a client', async () => {
    const f = ownerFixture();
    const consent = gate();
    const resolveSecret = vi.fn(() => 'SYNTHETIC_SECRET');
    const start = vi.fn(() => Promise.resolve(client()));
    const opening = f.owner.enter(() =>
      connectAgentMcp(refs, {
        ...f.options,
        consentGate: async () => {
          await consent.promise;
          return new Map();
        },
        resolveSecret,
        startMcpClient: start,
      }),
    );
    const refused = expect(opening).rejects.toSatisfy(f.owner.isStoppedFailure);
    f.owner.stop();
    consent.release();
    await refused;
    expect(resolveSecret, 'SESSION_LATE_CONSENT_BEFORE_SECRET').not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(f.registry.observations.exitCode()).toBe(0);
    await f.owner.close();
  });

  it('preserves the corresponding approved path and forwards the exact lifetime transfer', async () => {
    const f = ownerFixture();
    const live = client();
    const resolveSecret = vi.fn(() => 'SYNTHETIC_SECRET');
    const start = vi.fn<NonNullable<ConnectAgentMcpOptions['startMcpClient']>>(() =>
      Promise.resolve(live),
    );
    expect(
      await f.owner.enter(() =>
        connectAgentMcp(refs, {
          ...f.options,
          consentGate: () => Promise.resolve(new Map()),
          resolveSecret,
          startMcpClient: start,
        }),
      ),
    ).toBe(live);
    expect(resolveSecret).toHaveBeenCalledExactlyOnceWith('synthetic');
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[1]).toBe(f.owner.signal);
    expect(start.mock.calls[0]?.[2]).toBe(f.owner.work);
    await closePreparedMcp(live, f.options.onCloseError, f.options.budget);
    await f.owner.close();
  });

  it('joins the actual close of a client returned after cancellation before rejecting its construction', async () => {
    const f = ownerFixture();
    const started = gate();
    const publish = gate();
    const closed = gate();
    const close = vi.fn(() => closed.promise);
    const opening = f.owner.enter(() =>
      connectAgentMcp(refs, {
        ...f.options,
        consentGate: () => Promise.resolve(new Map()),
        resolveSecret: () => 'SYNTHETIC_SECRET',
        startMcpClient: async () => {
          started.release();
          await publish.promise;
          return client(close);
        },
      }),
    );
    let finished = false;
    const result = opening.then(
      () => {
        finished = true;
        throw new Error('Late MCP client was published.');
      },
      (cause: unknown) => {
        finished = true;
        return cause;
      },
    );
    await started.promise;
    f.owner.stop();
    publish.release();
    await reactions();
    expect(close).toHaveBeenCalledOnce();
    expect(finished, 'SESSION_LATE_CLIENT_ACTUAL_CLOSE').toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    closed.release();
    expect(f.owner.isStoppedFailure(await result)).toBe(true);
    await f.owner.close();
  });

  it('retains callback-reported uncertainty after the late client manager close fulfils', async () => {
    const f = ownerFixture();
    const started = gate();
    const publish = gate();
    const cause = new Error('PRIVATE_CLOSE_CALLBACK');
    const opening = f.owner.enter(() =>
      connectAgentMcp(refs, {
        ...f.options,
        consentGate: () => Promise.resolve(new Map()),
        resolveSecret: () => 'SYNTHETIC_SECRET',
        startMcpClient: async () => {
          started.release();
          await publish.promise;
          return client((onError) => {
            onError?.('owned', cause);
            return Promise.resolve();
          });
        },
      }),
    );
    const refused = expect(opening).rejects.toSatisfy(f.owner.isStoppedFailure);
    await started.promise;
    f.owner.stop();
    publish.release();
    await refused;
    await reactions();
    expect(f.owner.firstFailure?.cause).toBe(cause);
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.activeOwners, 'SESSION_PREPARATION_CALLBACK_UNCERTAINTY').toBe(1);
  });

  it('observes an opaque startup failure before its private failed-open lifetime can join', async () => {
    const child = gate();
    const failure = new Error('PRIVATE_STARTUP_FAILURE');
    const observed = vi.fn();
    let finished = false;
    const opening = connectAgentMcp(refs, {
      cwd: '/tmp',
      consentGate: () => Promise.resolve(new Map()),
      resolveSecret: () => 'SYNTHETIC_SECRET',
      onFailure: observed,
      startMcpClient: (_configs, _signal, work) => {
        if (work?.retainWork === undefined) throw new Error('Startup lifetime was not supplied.');
        void work.retainWork(() => child.promise);
        return Promise.reject(failure);
      },
    });
    const result = opening.catch((cause: unknown) => {
      finished = true;
      return cause;
    });
    await reactions();
    expect(
      observed,
      'SESSION_STARTUP_FAULT_BEFORE_FAILED_OPEN_JOIN',
    ).toHaveBeenCalledExactlyOnceWith(failure);
    expect(finished).toBe(false);
    child.release();
    expect(await result).toBe(failure);
  });

  it.each([true, false])(
    'only the typed owned cancellation can recover the stopped marker (typed=%s)',
    async (typed) => {
      const f = ownerFixture();
      const started = gate();
      const rejectStartup = gate();
      const failure = typed
        ? new McpAbortedError('owned', 'connect')
        : new Error('PRIVATE_FAILURE_RACING_STOP');
      const opening = f.owner.enter(() =>
        connectAgentMcp(refs, {
          ...f.options,
          consentGate: () => Promise.resolve(new Map()),
          resolveSecret: () => 'SYNTHETIC_SECRET',
          startMcpClient: async () => {
            started.release();
            await rejectStartup.promise;
            throw failure;
          },
        }),
      );
      const result = opening.catch((cause: unknown) => cause);
      await started.promise;
      f.owner.stop();
      rejectStartup.release();
      const cause = await result;
      expect(f.owner.isStoppedFailure(cause)).toBe(typed);
      expect(f.registry.observations.exitCode()).toBe(typed ? 0 : 9);
      if (!typed) expect(cause).toBe(failure);
      await f.owner.close();
    },
  );

  it('joins acquired client close before preserving a thrown remaining-budget fault', async () => {
    const primary = new Error('PRIVATE_BUDGET_FAULT');
    const native = gate();
    const close = vi.fn(() => native.promise);
    const result = closePreparedMcp(client(close), undefined, {
      deadline: () => undefined,
      remainingMs: () => {
        throw primary;
      },
    });
    const rejected = expect(result).rejects.toBe(primary);
    expect(close).toHaveBeenCalledOnce();
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await reactions();
    expect(settled).toBe(false);
    native.release();
    await rejected;
  });

  it('preserves the late-client admission refusal when close also rejects', async () => {
    const started = gate();
    const published = gate();
    const primary = new Error('PRIVATE_ADMISSION');
    const cleanup = new Error('PRIVATE_CLOSE');
    let stopped = false;
    const report = vi.fn();
    const close = vi.fn(() => Promise.reject(cleanup));
    const opening = connectAgentMcp(refs, {
      cwd: '/tmp',
      consentGate: () => Promise.resolve(new Map()),
      resolveSecret: () => 'SYNTHETIC_SECRET',
      assertAdmitting: () => {
        if (stopped) throw primary;
      },
      onCloseError: report,
      startMcpClient: async () => {
        started.release();
        await published.promise;
        return client(close);
      },
    });
    const rejected = expect(opening).rejects.toBe(primary);
    await started.promise;
    stopped = true;
    published.release();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('', cleanup);
  });

  it('never starts a new asynchronous manager close after the original budget expires', async () => {
    const close = vi.fn(() => Promise.resolve());
    let settled = false;
    void closePreparedMcp(client(close), undefined, {
      deadline: () => 0,
      remainingMs: () => 0,
    }).then(() => {
      settled = true;
    });
    await reactions();
    expect(close, 'SESSION_MCP_NO_NEW_CLOSE_AFTER_EXPIRY').not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it.each([true, false])(
    'actual failed-start manager cleanup retains its missing ACK before any host is adopted (failed=%s)',
    async (failed) => {
      const f = ownerFixture();
      const invocation = f.owner.invocation;
      await f.owner.close();
      const reservation = new SessionHostOwner(invocation, 'chat');
      const closeFailure = new Error('PRIVATE_FAILED_START_CLOSE');
      const close = vi.fn(() => (failed ? Promise.reject(closeFailure) : Promise.resolve()));
      const onCloseError = vi.fn((_id: string, cause: unknown) =>
        reservation.work.cleanupUncertain(cause),
      );
      await expect(
        reservation.build(async (work) => {
          await connectAgentMcp(refs, {
            cwd: '/tmp',
            assertAdmitting: work.assertAdmitting,
            onFailure: work.failure,
            onCloseError,
            budget: invocation.registry.budget,
            work: work.work,
            connectSignal: work.signal,
            consentGate: () => Promise.resolve(new Map()),
            resolveSecret: () => 'SYNTHETIC_SECRET',
            startMcpClient: (_configs, signal, options, lifecycle) =>
              actualStartMcpClient(
                [
                  {
                    id: 'owned',
                    open: () =>
                      Promise.resolve({
                        listTools: () =>
                          Promise.reject(new McpError('synthetic discovery refusal')),
                        callTool: () => Promise.resolve({ content: [], isError: false }),
                        close,
                      }),
                  },
                ],
                signal,
                options,
                lifecycle,
              ),
          });
          throw new Error('The fixture starter must refuse.');
        }),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
      expect(close).toHaveBeenCalledOnce();
      if (failed) {
        void reservation.work.close();
        await reactions();
        expect(
          onCloseError,
          'SESSION_ACTUAL_MANAGER_FAILED_START_CLOSE_IS_RETAINED',
        ).toHaveBeenCalledExactlyOnceWith('owned', closeFailure);
        expect(invocation.registry.budget.deadline()).toBe(3000);
        expect(invocation.registry.observations.exitCode()).toBe(9);
        expect(invocation.registry.activeOwners).toBe(1);
      } else {
        expect(onCloseError).not.toHaveBeenCalled();
        await reservation.work.close();
        await reactions();
        expect(invocation.registry.activeOwners).toBe(0);
        expect(invocation.registry.observations.exitCode()).toBe(0);
      }
    },
  );
});
