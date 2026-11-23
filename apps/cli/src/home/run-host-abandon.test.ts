/**
 * A leg that ignores its cancel cannot keep the Home waiting for ever
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6).
 *
 * The Home's own wait for a confirmed exit is the engine's ten-second grace window, and then it calls `RunHost.close()`. `close` joins
 * the leg, and a leg whose work never returns would make that join (and the Home that awaits it) wait for ever. So `close` has a bound
 * of its own: past it the leg is ABANDONED, its owner stays registered, the invocation's finite-exit bound is armed so the process
 * ends, and the Home's shared database is NOT closed under a leg that may still write to it.
 *
 * The leg here is a scripted handle whose stream is held open and whose `cancel` does nothing. Every timer is the test's own clock, and
 * every home is a temporary directory handed to the host (the second net below refuses the OS home outright).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WorkflowEngine,
  createInMemoryHost,
  type RunDeparture,
  type RunHandle,
} from '@relavium/core';
import { createClient, runMigrations, type DbClient } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import type { RunRenderer } from '../render/renderer.js';
import { captureIo } from '../test-support.js';
import { HOSTED_RUN_EXIT_BOUND_MS, HOSTED_RUN_EXIT_GRACE_MS } from '../render/tui/tui-constants.js';
import { HOSTED_LEG_SETTLE_BOUND_MS, RunHost, type HostedLaunch } from './run-host.js';

// The second net: anything that asks the OS for the home directory instead of being handed one is a leak.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const guarded = {
    ...actual,
    homedir: (): string => {
      throw new Error('a hosted leg reached the real operator home through os.homedir()');
    },
  };
  return { ...guarded, default: guarded };
});

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: host-abandon
  inputs:
    - { name: n, type: number }
  nodes:
    - { id: start, type: input }
    - { id: double, type: transform, transform: '({ d: inputs.n * 2 })' }
    - { id: out, type: output }
  edges:
    - { from: start, to: double }
    - { from: double, to: out }
`;

const DETACHED: Exclude<RunDeparture, { readonly kind: 'continue' }> = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

/** The one named bound of every `vi.waitFor` in this file. */
const WAIT_MS = 5000;

let root: string;
let home: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-run-host-abandon-'));
  home = join(root, 'operator-home');
  mkdirSync(home);
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A virtual clock for the host's one timer: callbacks fire in order as it is advanced, and what is still pending can be counted. */
function virtualClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    schedule: (run: () => void, delayMs: number): (() => void) => {
      next += 1;
      const id = next;
      pending.set(id, { at: now + delayMs, run });
      return () => {
        pending.delete(id);
      };
    },
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: (): number => pending.size,
  };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A handle whose stream stays open until `release()`, and whose `cancel` is a no-op: the host work of a leg that ignores its stop.
 * With `cancelEndsIt` the cancel releases it, as a leg that obeys does.
 */
function stubbornHandle(options: { readonly cancelEndsIt?: boolean } = {}) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn(() => {
    if (options.cancelEndsIt === true) release();
  });
  const event: RunEvent = {
    runId: 'run-stubborn',
    timestamp: '2026-11-23T00:00:00.000Z',
    sequenceNumber: 1,
    type: 'run:cancelled',
  };
  const handle: RunHandle = {
    runId: 'run-stubborn',
    events: (async function* (): AsyncGenerator<RunEvent> {
      await held;
      yield event;
    })(),
    subscribe: () => () => undefined,
    cancel,
    depart: () => Promise.resolve(DETACHED),
    whenConsumersReady: () => Promise.resolve(),
    highWaterMark: 256,
    bufferedCount: 0,
    durability: () => 'durable',
    terminalError: () => undefined,
  };
  return { handle, release, cancel };
}

function rig(options: {
  readonly cancelEndsIt?: boolean;
  /** The engine never comes back: the leg is still preparing. */
  readonly buildHangs?: boolean;
  /** The renderer every leg is given (the Home's run view feed, in production). */
  readonly renderer?: RunRenderer;
}) {
  const f = invocationFixture();
  const clock = virtualClock();
  const stubborn = stubbornHandle(options.cancelEndsIt === undefined ? {} : options);
  const buildEngine = (): Promise<WorkflowEngine> => {
    if (options.buildHangs === true) return new Promise<WorkflowEngine>(() => undefined);
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: { execute: () => Promise.resolve({ kind: 'completed', output: null }) },
    });
    vi.spyOn(engine, 'start').mockReturnValue(stubborn.handle);
    return Promise.resolve(engine);
  };
  const renderer = options.renderer;
  const host = new RunHost({
    invocation: f.invocation,
    io: captureIo().io,
    global: { json: false, color: false, cwd: root, configPath: undefined, verbosity: 'normal' },
    db: client.db,
    homeDir: home,
    buildEngine,
    sweepMedia: () => Promise.resolve(undefined),
    schedule: clock.schedule,
    ...(renderer === undefined ? {} : { renderer: () => renderer }),
  });
  const path = join(root, 'abandon.relavium.yaml');
  writeFileSync(path, WORKFLOW);
  return { host, f, clock, stubborn, path };
}

async function started(launch: Promise<HostedLaunch>) {
  const resolved = await launch;
  if (resolved.kind !== 'started')
    throw new Error(`expected a started leg, got ${JSON.stringify(resolved)}`);
  return resolved;
}

describe('RunHost.close is bounded', () => {
  it('is the wait the exit-guard card adds to the engine`s grace: ten seconds and then three, thirteen in all', () => {
    expect(HOSTED_RUN_EXIT_GRACE_MS).toBe(10_000);
    expect(HOSTED_LEG_SETTLE_BOUND_MS).toBe(3_000);
    expect(HOSTED_RUN_EXIT_BOUND_MS, 'the card says this many seconds').toBe(
      HOSTED_RUN_EXIT_GRACE_MS + HOSTED_LEG_SETTLE_BOUND_MS,
    );
  });

  it(
    'waits the bound for a leg that ignores its cancel, then settles, abandons it and arms the finite exit',
    { timeout: 2_000 },
    async () => {
      const r = rig({});
      const launch = await started(r.host.start({ workflow: r.path, rawInputs: { n: '3' } }));
      expect(r.host.snapshot().active?.runId).toBe('run-stubborn');

      let closed = false;
      const closing = r.host.close().then(() => {
        closed = true;
      });
      await turn();
      expect(r.stubborn.cancel, 'the leg was asked to stop').toHaveBeenCalled();
      expect(closed, 'the leg has not settled: close waits').toBe(false);
      expect(r.host.abandoned).toBe(false);

      r.clock.advance(HOSTED_LEG_SETTLE_BOUND_MS - 1);
      await turn();
      expect(closed, 'still inside the bound').toBe(false);
      expect(r.f.registry.termination, 'the exit authority is not armed yet').toBeUndefined();

      r.clock.advance(1);
      await closing; // the bound ran out: close settles although the leg did not
      expect(closed).toBe(true);
      expect(r.host.abandoned).toBe(true);
      expect(
        r.f.registry.termination,
        'the invocation`s finite-exit bound is armed: it is what ends the process',
      ).toBeDefined();
      expect(r.f.registry.observations.hasInfrastructureFailure()).toBe(true);
      expect(r.f.registry.activeOwners, 'the abandoned leg`s owner stays registered').toBe(1);
      expect(
        client.sqlite.open,
        'the shared database is still open under a leg that may write',
      ).toBe(true);
      expect(r.clock.pending(), 'the bound`s timer is gone').toBe(0);

      const facts = r.host.exitFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]?.kind).toBe('abandoned');
      expect(facts[0]?.runId).toBe('run-stubborn');
      expect(facts[0]?.line).toContain('run-stubborn');

      // The leg that ignored the stop finishes later: it must still be able to write, and it ends without a throw.
      r.stubborn.release();
      const end = await launch.ended;
      expect(end.runId).toBe('run-stubborn');
      expect(client.sqlite.open).toBe(true);
    },
  );

  it('does not abandon a leg that settles inside the bound, and its timer does not outlive close', async () => {
    const r = rig({ cancelEndsIt: true });
    await started(r.host.start({ workflow: r.path, rawInputs: { n: '3' } }));
    await r.host.close();
    expect(r.host.abandoned).toBe(false);
    expect(r.host.exitFacts()).toEqual([]);
    expect(r.f.registry.termination).toBeUndefined();
    expect(r.f.registry.activeOwners, 'a settled leg retires its owner').toBe(0);
    expect(r.clock.pending(), 'no timer outlives the close').toBe(0);
  });

  it(
    'abandons a leg that never finished preparing, naming no run',
    { timeout: 2_000 },
    async () => {
      const r = rig({ buildHangs: true });
      const launching = r.host.start({ workflow: r.path, rawInputs: { n: '3' } });
      await turn();
      expect(r.host.snapshot().launching).toBe(true);

      const closing = r.host.close();
      await turn();
      r.clock.advance(HOSTED_LEG_SETTLE_BOUND_MS);
      await closing;
      expect(r.host.abandoned).toBe(true);
      expect(r.f.registry.termination).toBeDefined();
      const facts = r.host.exitFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]?.kind).toBe('abandoned');
      expect(facts[0]?.line).toContain('still starting');
      void launching;
    },
  );

  it('seals the renderer of a leg it gives up on, so its frame loop does not outlive the abandon', async () => {
    const seal = vi.fn();
    const r = rig({ renderer: { onEvent: () => undefined, seal } });
    const launch = await started(r.host.start({ workflow: r.path, rawInputs: { n: '3' } }));
    await vi.waitFor(() => expect(r.host.snapshot().active?.runId).toBe('run-stubborn'), {
      timeout: WAIT_MS,
    });

    const closing = r.host.close();
    await turn();
    expect(seal, 'the leg is still inside the bound: its loop runs').not.toHaveBeenCalled();
    r.clock.advance(HOSTED_LEG_SETTLE_BOUND_MS);
    await closing;
    expect(r.host.abandoned).toBe(true);
    expect(seal, 'the abandoned leg`s renderer was sealed by the abandon').toHaveBeenCalledOnce();

    r.stubborn.release(); // the leg that ignored the stop ends later; its own epilogue seals again, which the renderer tolerates
    await launch.ended;
  });

  it('a second close is the first close', async () => {
    const r = rig({ cancelEndsIt: true });
    await started(r.host.start({ workflow: r.path, rawInputs: { n: '3' } }));
    const first = r.host.close();
    expect(r.host.close()).toBe(first);
    await first;
  });
});
