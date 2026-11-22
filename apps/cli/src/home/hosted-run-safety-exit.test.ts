/**
 * A hosted leg's safety fact outlives the Home's own return value
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6): "The process exit
 * is computed by `native-bootstrap` from the registry after the Home returns, not from the Home's return
 * value, so step 3 tests the safety exit at that layer."
 *
 * Each case starts the real native bootstrap, lets the "Home" host one leg through the real `driveRun` and
 * `HostedRunLifetime`, and returns `0` as a clean Home end does. The process must still exit with the leg's
 * safety code (8, 7, 5 or 6), and a leg's ordinary outcomes must not change a clean Home's exit.
 */
import {
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import type { RunDurability, RunEvent } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { driveRun } from '../commands/drive.js';
import type { ExitCode } from '../process/exit-codes.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { startNativeCli } from '../process/native-bootstrap.js';
import type { NativeInvocationPorts } from '../process/native-invocation.js';
import { SignalCustody } from '../process/signal-custody.js';
import type { RunTerminalView } from '../run-core/run-lifetime.js';
import { captureIo, OwnedTtyOutput } from '../test-support.js';
import { HostedRunLifetime } from './hosted-run-lifetime.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;
const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

/** The Home's terminal view, as far as one leg uses it. */
const HOME_VIEW: RunTerminalView = {
  sealed: false,
  releaseInput: () => Promise.resolve(),
  createJobControl: (factory) => factory(() => undefined),
  createRenderer: (factory) =>
    factory({ acknowledgeNoAcquisition: () => undefined, adopt: () => undefined }),
  runPrompt: (factory) => factory(),
  runViewOperation: (factory) => Promise.resolve().then(factory),
};

interface Leg {
  readonly terminal: 'run:completed' | 'run:paused' | 'run:cancelled';
  readonly departure?: Departure;
  readonly durability?: RunDurability;
}

function handleFor(leg: Leg): RunHandle {
  const base = { runId: 'run-safety', timestamp: '2026-11-22T00:00:00.000Z', sequenceNumber: 1 };
  const event: RunEvent =
    leg.terminal === 'run:completed'
      ? {
          ...base,
          type: 'run:completed',
          outputs: {},
          totalTokensUsed: { input: 0, output: 0 },
          totalCostMicrocents: 0,
          durationMs: 1,
        }
      : leg.terminal === 'run:paused'
        ? { ...base, type: 'run:paused', pendingGateCount: 1, gateIds: ['gate-1'] }
        : { ...base, type: 'run:cancelled' };
  return {
    runId: base.runId,
    events: (async function* (): AsyncGenerator<RunEvent> {
      await Promise.resolve();
      yield event;
    })(),
    subscribe: () => () => undefined,
    cancel: () => undefined,
    depart: () => Promise.resolve(leg.departure ?? DETACHED),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => leg.durability ?? 'durable',
    terminalError: () => undefined,
  };
}

/** The native bootstrap over an invocation whose custody the Home's own surface holds. */
function bootstrap(hostedLeg: Leg) {
  const f = invocationFixture();
  const invocation = { ...f.invocation, signalCustody: new SignalCustody() };
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  let exitCode: number | undefined;
  const physicalExit = vi.fn();
  const ports: NativeInvocationPorts = {
    stdout,
    stderr,
    schedule: () => () => undefined,
    onFatal: () => () => undefined,
    onBackground: () => () => undefined,
    readExitCode: () => exitCode,
    setExitCode: (code) => {
      exitCode = code;
    },
    exit: physicalExit,
  };
  const { io } = captureIo();
  const native = startNativeCli(
    ['node', 'relavium'],
    io,
    invocation,
    ports,
    () =>
      Promise.resolve({
        run: async (): Promise<ExitCode> => {
          // The Home's surface holds the custody for as long as the Home lives.
          const releaseCustody = invocation.signalCustody.claim();
          try {
            const lifetime = new HostedRunLifetime(invocation, HOME_VIEW);
            await driveRun({
              lifetime,
              engine: new WorkflowEngine({
                host: createInMemoryHost(),
                executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
              }),
              handle: handleFor(hostedLeg),
              io,
              makeRenderer: () => ({ onEvent: () => undefined }),
            });
            await lifetime.finish();
          } finally {
            releaseCustody();
          }
          // A clean end of the Home: its own return value says success.
          return 0;
        },
      }),
    () => () => undefined,
  );
  cleanups.push(() => {
    native.dispose();
    stdout.destroy();
    stderr.destroy();
  });
  return { native, registry: f.registry, exitCode: () => exitCode, physicalExit };
}

describe('a hosted leg safety fact beats the Home own return of 0 at the native bootstrap', () => {
  it.each([
    {
      code: 8,
      says: 'money receipts not confirmed',
      leg: { terminal: 'run:completed', departure: { ...DETACHED, moneyDurability: 'uncertain' } },
    },
    {
      code: 7,
      says: 'an effect needs attention',
      leg: { terminal: 'run:completed', departure: { ...DETACHED, effectNeedsAttention: true } },
    },
    {
      code: 5,
      says: 'a delivered terminal that did not land',
      leg: { terminal: 'run:completed', durability: 'uncertain' },
    },
    {
      code: 6,
      says: 'a run taken over elsewhere',
      leg: { terminal: 'run:paused', durability: 'uncertain' },
    },
  ] satisfies { code: number; says: string; leg: Leg }[])(
    'exit $code ($says)',
    async ({ code, leg }) => {
      const b = bootstrap(leg);
      expect(await b.native.finished).toBe(code);
      expect(b.exitCode()).toBe(code);
      expect(b.registry.activeOwners, 'the leg owner retired').toBe(0);
      expect(b.registry.observations.hasInfrastructureFailure()).toBe(false);
      expect(b.registry.budget.deadline(), 'no fatal bound was started').toBeUndefined();
      expect(b.physicalExit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'a completed leg', leg: { terminal: 'run:completed' } },
    { name: 'a paused leg', leg: { terminal: 'run:paused' } },
    { name: 'a cancelled leg', leg: { terminal: 'run:cancelled' } },
  ] satisfies { name: string; leg: Leg }[])(
    'leaves a clean Home exit at 0 after $name: ordinary outcomes are view state',
    async ({ leg }) => {
      const b = bootstrap(leg);
      expect(await b.native.finished).toBe(0);
      expect(b.exitCode()).toBe(0);
      expect(b.registry.activeOwners).toBe(0);
    },
  );
});
