/**
 * The run lease's LIVE behaviour — the heartbeat, the fence classification, and what a process does when it
 * discovers it no longer owns the run
 * ([ADR-0079](../../../../docs/decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §4-§6).
 *
 * The lease *table* and its CAS are proven in `@relavium/db`; what lives here is the half that only the
 * engine can answer: that a fenced-out process **stops without claiming an outcome it does not know**, that
 * the beat is a liveness timer rather than a work timer, and that ownership is given up exactly when the
 * process stops working on the run.
 */

import type { RunEvent, RunFence, RunLeasePort } from '@relavium/shared';
import { LeaseFencedError, RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { EngineStateError, isTransientEngineStateError } from './errors.js';
import { createInMemoryHost, createInMemoryRunLeases, InMemoryRunStore } from './execution-host.js';
import type { NodeExecContext, NodeOutcome, NodeExecutor } from './node-executor.js';
import type { RunHandle } from './run-handle.js';

const LINEAR: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: lease-fixture
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`,
);

const GATED: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: lease-gate-fixture
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: b }
`,
);

class Stub implements NodeExecutor {
  constructor(
    private readonly handlers: Readonly<
      Record<string, () => NodeOutcome | Promise<NodeOutcome>>
    > = {},
  ) {}
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    const handler = this.handlers[ctx.vertex.id];
    return Promise.resolve(handler?.() ?? { kind: 'completed', output: ctx.vertex.id });
  }
}

/** A dispatch that never settles — the run stays IN FLIGHT, holding its lease and its heartbeat. */
const inFlight = (): Promise<NodeOutcome> => new Promise<NodeOutcome>(() => undefined);

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

/** Yield microtasks until `predicate` holds — the engine arms/settles in continuations, never on a clock. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let spin = 0; spin < 1000; spin += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`never became true: ${what}`); // fail fast, never hang
}

describe('ADR-0079 §6 — the heartbeat is a LIVENESS timer', () => {
  it('arms no work timer, and is disarmed when the run settles', async () => {
    const host = createInMemoryHost();
    const handle = new WorkflowEngine({ host, executor: new Stub() }).start({ workflow: LINEAR });
    // Mid-run the beat exists and is NOT in the work set — this is what keeps `armedCount()` answering
    // "is the run waiting on something", and what stops a drive-to-quiescence loop spinning forever on a
    // timer that re-arms itself.
    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');
    expect(host.armedCount()).toBe(0);

    await drain(handle);
    expect(host.livenessCount()).toBe(0); // disarmed on settle — no beat outlives its run
  });

  it('renews the lease when it fires, and re-arms exactly one successor', async () => {
    const beats: RunFence[] = [];
    const inner = createInMemoryRunLeases();
    const leases: RunLeasePort = {
      ...inner,
      heartbeat: (runId, fence, ttlMs) => {
        beats.push(fence);
        return inner.heartbeat(runId, fence, ttlMs);
      },
    };
    // A node that never settles, so the run is still IN FLIGHT while the beat is exercised — a gate-parked
    // run would have released its lease and stopped beating before the fire below.
    const host = createInMemoryHost({ runLeases: leases });
    const handle = new WorkflowEngine({
      host,
      executor: new Stub({ a: inFlight }),
    }).start({ workflow: LINEAR });

    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');
    host.fireLiveness();
    await until(() => beats.length === 1, 'the lease was renewed');

    // Re-armed, and only ONCE: arming is idempotent, so a beat can never leave a second timer behind
    // renewing a stale fence for the life of the process.
    await until(() => host.livenessCount() === 1, 'the heartbeat re-armed');
    expect(beats).toHaveLength(1);
    void handle;
  });
});

describe('ADR-0079 §5 — a fenced-out process stops without claiming an outcome', () => {
  it('a heartbeat that discovers a takeover ends the run with NO terminal and reports uncertain', async () => {
    const store = new InMemoryRunStore();
    const inner = createInMemoryRunLeases();
    let takenOver = false;
    const leases: RunLeasePort = {
      ...inner,
      heartbeat: (runId, fence, ttlMs) =>
        takenOver ? Promise.resolve(false) : inner.heartbeat(runId, fence, ttlMs),
    };
    const host = createInMemoryHost({ store, runLeases: leases });
    // The node stays IN FLIGHT — never a gate pause. A parked run has already released its lease (§4), so it
    // has no beat to fire; the case §5 is about is a process still executing when ownership moves.
    const handle = new WorkflowEngine({
      host,
      executor: new Stub({ a: inFlight }),
    }).start({ workflow: LINEAR });

    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');
    takenOver = true;
    host.fireLiveness();

    // The stream COMPLETES rather than hanging — the consumer's `for await` must end even though no
    // terminal was written, which is the whole reason the handle took a closer.
    const events = await drain(handle);
    expect(events.some((event) => event.type === 'run:failed')).toBe(false);
    expect(events.some((event) => event.type === 'run:completed')).toBe(false);
    expect(handle.durability()).toBe('uncertain');
    // And nothing was written claiming an outcome for a run another process now owns. Writing `run:failed`
    // here would be a durable LIE about a run that may be succeeding elsewhere.
    const persisted = store.eventsFor(handle.runId).map((event) => event.type);
    expect(persisted).not.toContain('run:failed');
    expect(persisted).not.toContain('run:completed');
  });

  it('a FENCED settle disarms the grace window too (ADR-0085 §8.12)', async () => {
    // `#settle` reaches its fenced branch and RETURNS before its own `#disarmGraceWindow()`, so a run whose
    // ownership moved after a cancel left the backstop armed. The cost is concrete, not theoretical: the CLI
    // deliberately does not `unref` a `deadline` timer (a hung executor may hold no socket, so the backstop
    // is the only thing that will unblock the run) and sets `process.exitCode` rather than calling
    // `process.exit` — so a fenced `relavium run` sat idle for the full 10 s after it had finished.
    //
    // §8.12 claims the window is disarmed "on a normal settle, on `abandon()`, and on a fenced settle —
    // proven by the armed count". Only the normal one was.
    const store = new InMemoryRunStore();
    const inner = createInMemoryRunLeases();
    let takenOver = false;
    const leases: RunLeasePort = {
      ...inner,
      heartbeat: (runId, fence, ttlMs) =>
        takenOver ? Promise.resolve(false) : inner.heartbeat(runId, fence, ttlMs),
    };
    const host = createInMemoryHost({ store, runLeases: leases });
    const started: string[] = [];
    const engine = new WorkflowEngine({
      host,
      executor: new Stub({
        a: () => {
          started.push('a');
          return inFlight();
        },
      }),
    });
    const handle = engine.start({ workflow: LINEAR });

    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');
    // Wait for the node to actually be IN FLIGHT. Cancelling before it starts settles the run immediately —
    // `#step` finds nothing running and closes it `run:cancelled` — and the fenced path is then never taken.
    await until(() => started.length > 0, 'the node started');
    // Cancel FIRST, so the grace window is armed before ownership moves — the ordering that produced the
    // leak. Then the heartbeat discovers the takeover and the run settles fenced.
    engine.cancel(handle.runId);
    await until(() => host.deadlineCount() === 1, 'the grace window was armed');
    takenOver = true;
    host.fireLiveness();

    await drain(handle);
    expect(handle.durability()).toBe('uncertain'); // …it really did take the FENCED path
    expect(host.deadlineCount()).toBe(0); // …and left no backstop holding the loop open
  });

  it('a durable write refused by the fence produces the same disposition', async () => {
    // The other half of §5: the loss is discovered at a WRITE rather than at a beat. Same outcome, because
    // the process learned the same fact — it no longer owns the run.
    const inner = new InMemoryRunStore();
    let fenceEverything = false;
    const store = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: async (
        event: RunEvent,
        ctx?: Parameters<typeof inner.persistEvent>[1],
      ): Promise<void> => {
        if (fenceEverything && event.type !== 'run:started') {
          throw new LeaseFencedError('run-x', 'someone-else', 1, 99);
        }
        await inner.persistEvent(event, ctx);
      },
    };
    const host = createInMemoryHost({ store });
    const handle = new WorkflowEngine({
      host,
      executor: new Stub({
        a: () => {
          fenceEverything = true;
          return { kind: 'completed', output: 'a' };
        },
      }),
    }).start({ workflow: LINEAR });

    const events = await drain(handle);
    expect(events.some((event) => event.type.startsWith('run:completed'))).toBe(false);
    expect(events.some((event) => event.type === 'run:failed')).toBe(false);
    expect(handle.durability()).toBe('uncertain');
    expect(host.livenessCount()).toBe(0); // the beat stops too — nothing is left renewing a lost lease
  });
});

describe('ADR-0079 §4 — ownership is given up when the process stops WORKING on the run', () => {
  it('a gate park releases the lease, so the next process is not refused for the full TTL', async () => {
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ runLeases: leases });
    const handle = new WorkflowEngine({
      host,
      executor: new Stub({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
    }).start({ workflow: GATED });

    for await (const event of handle.events) if (event.type === 'run:paused') break;
    // Spin rather than read once: `run:paused` is DELIVERED to this consumer before `#emitPausedOnce`
    // continues to the release, so a single read here is a race that would pass or fail on scheduling.
    for (let spin = 0; spin < 1000 && (await leases.read(handle.runId)) !== undefined; spin += 1) {
      await Promise.resolve();
    }
    expect(await leases.read(handle.runId)).toBeUndefined();
    expect(host.livenessCount()).toBe(0); // and the beat stopped with it
  });
});

describe('ADR-0079 §7 — reconcile() never terminates a run somebody else is running', () => {
  /** Seed a run that has a `run:started` and no terminal — what a crashed process leaves behind. */
  async function seedInterrupted(store: InMemoryRunStore, runId: string): Promise<void> {
    const workflowId = await store.resolveWorkflowId(LINEAR.workflow.id);
    await store.persistEvent({
      type: 'run:started',
      runId,
      sequenceNumber: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      workflowId,
      inputs: {},
      executionMode: 'local',
    });
  }

  it('SKIPS a run holding a live lease, and reconciles one whose lease has expired', async () => {
    const store = new InMemoryRunStore();
    let clock = 1_000_000;
    const leases = createInMemoryRunLeases(() => clock);
    await seedInterrupted(store, 'run-live');
    await seedInterrupted(store, 'run-dead');
    // Two owners, both mid-run when their processes were interrupted. Only one is still alive.
    await leases.acquire('run-live', 'owner-live', RUN_LEASE_TTL_MS);
    await leases.acquire('run-dead', 'owner-dead', RUN_LEASE_TTL_MS);
    clock += RUN_LEASE_TTL_MS + 1; // both TTLs elapse…
    await leases.heartbeat('run-live', { ownerId: 'owner-live', generation: 1 }, RUN_LEASE_TTL_MS);

    const host = createInMemoryHost({ store, runLeases: leases });
    const repaired = await new WorkflowEngine({ host, executor: new Stub() }).reconcile();

    // Only the dead one is failed. Terminating `run-live` would kill a run another process is finishing.
    expect(repaired.map((event) => event.runId)).toEqual(['run-dead']);
    expect(store.eventsFor('run-live').map((event) => event.type)).toEqual(['run:started']);
  });

  it('BUMPS the generation on takeover, so the dead owner is fenced if it ever wakes', async () => {
    const store = new InMemoryRunStore();
    let clock = 1_000_000;
    const leases = createInMemoryRunLeases(() => clock);
    await seedInterrupted(store, 'run-zombie');
    const stale = await leases.acquire('run-zombie', 'owner-dead', RUN_LEASE_TTL_MS);
    clock += RUN_LEASE_TTL_MS + 1;

    const host = createInMemoryHost({ store, runLeases: leases });
    await new WorkflowEngine({ host, executor: new Stub() }).reconcile();

    // The zombie wakes holding its old fence. Its generation is behind, so a heartbeat tells it it lost —
    // which is the only thing that stops it appending past the terminal reconciliation just wrote.
    expect(stale).toBeDefined();
    if (stale === undefined) throw new Error('the seed acquire must succeed');
    expect(await leases.heartbeat('run-zombie', stale, RUN_LEASE_TTL_MS)).toBe(false);
  });
});

describe('ADR-0079 §4/§5 — a parked process cannot speak for a run it gave up', () => {
  /** Park a run at its gate, draining on a background promise so the execution stays alive to cancel. */
  async function parked(host: ReturnType<typeof createInMemoryHost>): Promise<{
    engine: WorkflowEngine;
    runId: string;
    drained: Promise<void>;
  }> {
    const engine = new WorkflowEngine({
      host,
      executor: new Stub({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
    });
    const handle = engine.start({ workflow: GATED });
    let reached: () => void = () => undefined;
    const atPause = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) if (event.type === 'run:paused') reached();
    })();
    await atPause;
    return { engine, runId: handle.runId, drained };
  }

  it('a cancel writes NO terminal once another process holds the lease', async () => {
    // A gate park releases the lease (§4) — but the gate deadline, the run-level `timeout_ms` and a
    // cooperative cancel all stay armed, and all end at `#settle`. A terminal is exempt from the append
    // guard (ADR-0078 §2) and an ABSENT fence is a pass rather than a refusal, so before this was closed a
    // parked process could durably write `run:cancelled` into a run another process was finishing — two
    // terminals in one log, the exact divergence ADR-0079 exists to prevent.
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    const { engine, runId, drained } = await parked(host);

    // Spin until the park's release lands: `run:paused` is DELIVERED before `#emitPausedOnce` continues to
    // the release, so reading once here would race it.
    for (let spin = 0; spin < 1000 && (await leases.read(runId)) !== undefined; spin += 1) {
      await Promise.resolve();
    }
    expect(await leases.read(runId)).toBeUndefined();

    // Another process takes the run over — the ordinary `relavium gate` resume.
    expect(await leases.acquire(runId, 'another-process', RUN_LEASE_TTL_MS)).toBeDefined();

    engine.cancel(runId); // …and the first process is Ctrl-C'd, dismissing a now-stale prompt.
    await drained;

    const persisted = store.eventsFor(runId).map((event) => event.type);
    expect(persisted).not.toContain('run:cancelled');
    expect(persisted).not.toContain('run:failed');
  });

  it('a cancel on a run NOBODY took over still records the cancellation', async () => {
    // The reason the fix RE-ACQUIRES rather than simply refusing: the common case is a user cancelling
    // their own parked run, and that must still be recorded. A fix that only fenced would drop it.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const { engine, runId, drained } = await parked(host);
    engine.cancel(runId);
    await drained;

    expect(store.eventsFor(runId).map((event) => event.type)).toContain('run:cancelled');
  });

  it('an INLINE resume that lands the instant run:paused is delivered is not fenced by the park', async () => {
    // The mirror of the bug above, and it bit on the happy path. `#emitDurable` DELIVERS to consumers, and
    // an inline prompter (`relavium gate`'s interactive re-pause) resumes synchronously on `run:paused` —
    // before `#emitPausedOnce` continues. When the claim was dropped after the emit, that resume saw
    // `#owned === true`, skipped its re-acquire, and then had the lease row deleted out from under it: its
    // next `node:started` was fenced and a perfectly healthy run died `uncertain`.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const engine = new WorkflowEngine({
      host,
      executor: new Stub({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
    });
    const handle = engine.start({ workflow: GATED });
    // Through `subscribe`, not the `for await` loop, and the difference is the whole test. A subscriber runs
    // SYNCHRONOUSLY inside `#emitDurable`'s delivery, so the resume lands strictly between the pause being
    // observable and `#emitPausedOnce` continuing — which is precisely the window. Resuming from the async
    // iterator instead lands a microtask later, after the surrender, and passes either way.
    handle.subscribe((event) => {
      if (event.type === 'run:paused') {
        void engine.resume(handle.runId, event.gateIds[0] ?? '', {
          decision: 'approved',
          decidedBy: 'inline',
        });
      }
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(handle.durability()).toBe('durable');
  });
});

describe('ADR-0079 §4/§7 — a claim that leads nowhere is never leaked', () => {
  async function seedTerminal(store: InMemoryRunStore, runId: string): Promise<void> {
    const workflowId = await store.resolveWorkflowId(LINEAR.workflow.id);
    await store.persistEvent({
      type: 'run:started',
      runId,
      sequenceNumber: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      workflowId,
      inputs: {},
      executionMode: 'local',
    });
    await store.persistEvent({
      type: 'run:completed',
      runId,
      sequenceNumber: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      outputs: {},
      totalTokensUsed: { input: 0, output: 0 },
      totalCostMicrocents: 0,
      durationMs: 1,
    });
  }

  it('an already-terminal resume releases the lease it took, so re-delivery stays a no-op', async () => {
    // `resumeFromCheckpoint` acquires BEFORE it reads the checkpoint, so the idempotent already-settled exit
    // owns that claim too. Holding it turned the documented no-op into a transient refusal for a full TTL —
    // over a run that finished hours ago — and left a `run_leases` row per re-delivery.
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    await seedTerminal(store, 'run-done');

    const engine = new WorkflowEngine({ host, executor: new Stub() });
    const handle = await engine.resumeFromCheckpoint({ runId: 'run-done', workflow: LINEAR });
    for await (const event of handle.events) void event; // a closed handle: completes immediately

    expect(await leases.read('run-done')).toBeUndefined();
  });

  it('a workflow_mismatch refusal releases too', async () => {
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    await seedTerminal(store, 'run-mismatch');

    const engine = new WorkflowEngine({ host, executor: new Stub() });
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-mismatch', workflow: GATED }),
    ).rejects.toBeInstanceOf(EngineStateError);
    expect(await leases.read('run-mismatch')).toBeUndefined();
  });

  it('reconcile() never takes over a run THIS engine is executing', async () => {
    // `acquire` refuses only a DIFFERENT owner, so for the engine's own run it is a renewal that bumps the
    // generation — fencing the live execution out at its next write and then deleting its row in the
    // caller's `finally`. The lease cannot tell the two apart; the in-memory run table can.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const engine = new WorkflowEngine({
      host,
      executor: new Stub({ a: inFlight }),
    });
    const handle = engine.start({ workflow: LINEAR });
    await until(() => store.eventsFor(handle.runId).length > 0, 'the run started');

    const repaired = await engine.reconcile();

    expect(repaired).toEqual([]); // it did NOT fail its own live run
    expect(store.eventsFor(handle.runId).map((e) => e.type)).not.toContain('run:failed');
    expect(handle.durability()).not.toBe('uncertain'); // …nor fence it out of its own run
  });
});

describe('ADR-0079 §6 — the heartbeat tolerates a blip but not a blackout', () => {
  it('survives isolated write failures, then gives up once the misses cover the whole TTL', async () => {
    // Unbounded tolerance hid the one failure §6 names as its reason for existing: a store that is
    // persistently unwritable means the lease provably expires, somebody takes the run over, and this
    // process keeps dispatching nodes and calling tools with no beat ever telling it.
    const inner = createInMemoryRunLeases();
    let failing = false;
    const leases: RunLeasePort = {
      ...inner,
      heartbeat: (runId, fence, ttlMs) =>
        failing
          ? Promise.reject(new Error('store unwritable'))
          : inner.heartbeat(runId, fence, ttlMs),
    };
    const host = createInMemoryHost({ runLeases: leases });
    const handle = new WorkflowEngine({ host, executor: new Stub({ a: inFlight }) }).start({
      workflow: LINEAR,
    });
    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');

    failing = true;
    const misses = Math.ceil(RUN_LEASE_TTL_MS / RUN_LEASE_HEARTBEAT_MS);
    for (let beat = 0; beat < misses - 1; beat += 1) {
      host.fireLiveness();
      await until(() => host.livenessCount() === 1, `beat ${String(beat)} re-armed`);
      expect(handle.durability()).not.toBe('uncertain'); // still ours — a blip is not a takeover
    }

    host.fireLiveness(); // the miss that covers the TTL
    await drain(handle);
    expect(handle.durability()).toBe('uncertain'); // an unprovable claim stops (§5)
  });

  it('a gate park during a beat is not read as a takeover', async () => {
    // The await inside `#beat` suspends, and a park during it hands the claim back WITHOUT setting `lost`.
    // A beat that then acted would read this process's own deliberate release as somebody else's takeover.
    const inner = createInMemoryRunLeases();
    let release: (() => void) | undefined;
    let beatFinished = false;
    const leases: RunLeasePort = {
      ...inner,
      heartbeat: async (runId, fence, ttlMs) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const answer = await inner.heartbeat(runId, fence, ttlMs);
        beatFinished = true;
        return answer;
      },
    };
    const host = createInMemoryHost({ runLeases: leases });
    const engine = new WorkflowEngine({
      host,
      executor: new Stub({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
    });
    const handle = engine.start({ workflow: GATED });
    await until(() => host.livenessCount() === 1, 'the heartbeat was armed');

    host.fireLiveness(); // the beat suspends inside the port…
    await until(() => release !== undefined, 'the beat is in flight');
    for await (const event of handle.events) if (event.type === 'run:paused') break; // …and the run parks
    release?.(); // now let the beat finish
    await until(() => beatFinished, 'the beat answered');
    await until(() => host.livenessCount() === 0, 'the beat did not re-arm on a parked run');

    // The port ANSWERED `false` — the park deleted the row — and that must not be read as a takeover, because
    // this process is the one that released it. Without the `held` re-check the beat treats its own park as
    // somebody else's claim and kills a healthy parked run.
    expect(handle.durability()).not.toBe('uncertain');
    expect(await inner.read(handle.runId)).toBeUndefined(); // still parked, still resumable
  });
});

describe('ADR-0079 §3 — a run that cannot own its own id says so', () => {
  it('names the lease port rather than failing with an unattributed "the run failed"', async () => {
    // A fresh run's acquire is uncontended by construction, so a refusal here means the host is misconfigured
    // — a locked, unmigrated or read-only `history.db`. Settling with the generic default pointed at nothing.
    const leases: RunLeasePort = {
      ...createInMemoryRunLeases(),
      acquire: () => Promise.resolve(undefined),
    };
    const host = createInMemoryHost({ runLeases: leases });
    const handle = new WorkflowEngine({ host, executor: new Stub() }).start({ workflow: LINEAR });
    const events = await drain(handle);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:failed');
    expect(terminal?.type === 'run:failed' ? terminal.error.message : '').toMatch(/run-lease port/);
  });
});

describe('ADR-0079 §4 — a losing resume is refused with something actionable', () => {
  it('names the holder AND the bound on the wait', async () => {
    // "retry shortly" is not actionable; `RunLeaseInfo` already carries `expiresAt`, so the deadline is free.
    // The holder id is opaque by design (§1 — an owner is a process, not a name), which makes the deadline
    // the only concrete thing the message can offer a caller deciding how long to back off.
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    const workflowId = await store.resolveWorkflowId(LINEAR.workflow.id);
    await store.persistEvent({
      type: 'run:started',
      runId: 'run-held',
      sequenceNumber: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      workflowId,
      inputs: {},
      executionMode: 'local',
    });
    await leases.acquire('run-held', 'the-other-process', RUN_LEASE_TTL_MS);

    const engine = new WorkflowEngine({ host, executor: new Stub() });
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-held', workflow: LINEAR }),
    ).rejects.toMatchObject({ code: 'run_owned_elsewhere' });

    await engine
      .resumeFromCheckpoint({ runId: 'run-held', workflow: LINEAR })
      .then(() => expect.unreachable('the resume must be refused'))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        expect(message).toContain('the-other-process'); // who
        expect(message).toMatch(/in at most \d+s/); // …and for how long
      });
  });
});

describe('ADR-0079 §7 — the transient classification is what earns a distinct exit code', () => {
  it('run_owned_elsewhere is transient; every other engine-state refusal is permanent', () => {
    // Without this the whole exit-6 chain rests on a constant that nothing exercises: forcing
    // `isTransientEngineStateError` to `false` left all 3,580 tests in the repo green, because the CLI's
    // own tests only prove the CliErrorCode→exit-code table, never that anything PRODUCES the code.
    expect(
      isTransientEngineStateError(
        new EngineStateError('run_owned_elsewhere', 'busy', { runId: 'r' }),
      ),
    ).toBe(true);
    for (const code of ['unknown_run', 'run_already_terminal', 'workflow_mismatch'] as const) {
      expect(isTransientEngineStateError(new EngineStateError(code, 'nope', { runId: 'r' }))).toBe(
        false,
      );
    }
  });

  it('a release-then-reacquire by the same owner restarts the generation — §1 as amended', () => {
    // The one numeric claim §1's 2026-08-17 amendment turns on, asserted directly rather than left implicit.
    // If a future change makes `release` a tombstone, this test is the one that should fail and be updated
    // together with the amendment — which is the point of pinning a documented LIMITATION.
    const leases = createInMemoryRunLeases();
    return (async () => {
      const first = await leases.acquire('run-gen', 'owner-a', RUN_LEASE_TTL_MS);
      expect(first?.generation).toBe(1);
      const renewed = await leases.acquire('run-gen', 'owner-a', RUN_LEASE_TTL_MS);
      expect(renewed?.generation).toBe(2); // monotonic WITHIN a lease's lifetime
      if (renewed !== undefined) await leases.release('run-gen', renewed);
      const afterRelease = await leases.acquire('run-gen', 'owner-a', RUN_LEASE_TTL_MS);
      expect(afterRelease?.generation).toBe(1); // …and restarts across one, because release DELETES the row
    })();
  });
});
