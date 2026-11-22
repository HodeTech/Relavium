/**
 * The stale gate card (deferred-tasks-parked.md, "Answering a stale gate card after another process decided the
 * gate fails a healthy run"; ADR-0079 §4/§5, ADR-0078 §2).
 *
 * Terminal A runs a two-gate workflow and parks at gate g1 with its card open; the park hands the lease back
 * (§4). Terminal B decides g1 with `relavium gate`, runs on to g2, parks there and hands the lease back too.
 * Then A's stale card takes an answer — or is dismissed with Ctrl-C. A re-takes the vacant lease under a fresh
 * fence, so the fence cannot refuse it; only the compare-and-append sees that the log moved. Before the fix A
 * treated that refusal as a store fault and wrote `run:failed{internal}` (or `run:cancelled`) at a sequence B had
 * already used: SQLite's `UNIQUE(run_id, seq)` refused it and the outbox held it for good, while the reference
 * store — which had no such uniqueness — landed the bogus terminal in a run that is healthy and paused at g2.
 *
 * **Two engines on ONE store**, which is how this suite models two processes on one `history.db`: one shared
 * event log and one shared lease table (`InMemoryRunStore.bindLeases`), with a distinct owner per engine.
 * `@relavium/core` has no SQLite dependency, so the store is the reference one; it now refuses a duplicate
 * `(runId, seq)` the way SQLite's unique index does, so the race reproduces with SQLite's refusals rather than
 * being hidden by a laxer store.
 */

import type { DurableWriteContext, GateDecision, RunEvent, RunLeasePort } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { reconstructCheckpointState } from './checkpoint.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore, type RunStore } from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';
import type { RunHandle } from './run-handle.js';

const TWO_GATES: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: stale-gate-card
  nodes:
    - { id: a, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g1 }
    - { from: g1, to: g2 }
    - { from: g2, to: b }
`,
);

const TERMINALS: ReadonlySet<RunEvent['type']> = new Set([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);

/** Gates pause; every other node completes with its own id. */
class GateStub implements NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    return Promise.resolve(
      ctx.vertex.id.startsWith('g')
        ? { kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }
        : { kind: 'completed', output: ctx.vertex.id },
    );
  }
}

/**
 * One "process" on the shared store. The id source is distinct per process because the engine mints its OWNER
 * from it: two reference hosts would both answer `id-1`, and the lease would then read B as A renewing.
 */
function processOn(store: InMemoryRunStore, name: string) {
  const host = createInMemoryHost({ store });
  let next = 0;
  const ids = { newId: () => `${name}-${String(++next)}` };
  const engine = new WorkflowEngine({ host: { ...host, ids }, executor: new GateStub() });
  return { host, engine };
}

async function untilAsync(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let spin = 0; spin < 1000; spin += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`never became true: ${what}`); // fail fast, never hang
}

/** The lease row is gone — a park, a departure or a release has handed the claim back. */
async function leaseVacant(leases: RunLeasePort, runId: string): Promise<void> {
  await untilAsync(async () => (await leases.read(runId)) === undefined, 'the lease was released');
}

/** Read a handle's primary stream up to its next `run:paused`, keeping the reader intact for `depart()`. */
async function readToPause(handle: RunHandle): Promise<Extract<RunEvent, { type: 'run:paused' }>> {
  const iterator = handle.events[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) throw new Error('the run ended before it paused');
    if (next.value.type === 'run:paused') return next.value;
  }
}

const approve = (by: string): GateDecision => ({ decision: 'approved', decidedBy: by });

/**
 * Terminal A parks at g1 with its card still open; terminal B decides g1, runs to g2, parks and exits. Returns
 * A still parked in memory on g1, and the log exactly as B left it.
 */
async function staleCardScene() {
  const store = new InMemoryRunStore();
  const a = processOn(store, 'terminal-a');
  const handleA = a.engine.start({ workflow: TWO_GATES });
  const runId = handleA.runId;
  const eventsA: RunEvent[] = [];
  let reached: (gateId: string) => void = () => undefined;
  const atFirstGate = new Promise<string>((resolve) => {
    reached = resolve;
  });
  // A keeps draining on a background promise, as the CLI's card does, so its execution stays alive and parked.
  const drainedA = (async () => {
    for await (const event of handleA.events) {
      eventsA.push(event);
      if (event.type === 'run:paused') reached(event.gateIds[0] ?? '');
    }
  })();
  const firstGate = await atFirstGate;
  await leaseVacant(a.host.runLeases, runId); // §4: A's park handed the claim back

  // Terminal B: `relavium gate <run> g1 approve` — a resume from the checkpoint in another process.
  const b = processOn(store, 'terminal-b');
  const before = store.eventsFor(runId).length;
  const handleB = await b.engine.resumeFromCheckpoint({
    runId,
    workflow: TWO_GATES,
    gateId: firstGate,
    decision: approve('terminal-b'),
  });
  const secondPause = await readToPause(handleB);
  expect((await handleB.depart()).kind).toBe('detached'); // B exits at g2, as `relavium gate` does
  await leaseVacant(b.host.runLeases, runId);

  const afterB = [...store.eventsFor(runId)];
  const usedByB = new Set(afterB.slice(before).map((event) => event.sequenceNumber));
  expect(usedByB.size).toBeGreaterThan(0);
  return {
    store,
    a,
    handleA,
    eventsA,
    drainedA,
    runId,
    firstGate,
    secondGate: secondPause.gateIds[0] ?? '',
    afterB,
    usedByB,
  };
}

type Scene = Awaited<ReturnType<typeof staleCardScene>>;

/** What every stale-card outcome must leave behind: A stopped fenced, and the run exactly as B decided it. */
async function expectFencedAndUntouched(scene: Scene): Promise<void> {
  const { store, a, handleA, eventsA, runId, afterB, usedByB, secondGate } = scene;
  // A claims no outcome: no terminal reached its stream, and the handle reports the fenced disposition
  // (no terminal + `uncertain`, which the CLI maps to exit 6, never exit 5).
  expect(eventsA.filter((event) => TERMINALS.has(event.type))).toEqual([]);
  expect(handleA.durability()).toBe('uncertain');
  expect(handleA.terminalError()).toBeUndefined();
  // Nothing of A's landed: the log is byte-for-byte what B left, with no terminal and no reused sequence.
  const persisted = store.eventsFor(runId);
  expect(persisted).toEqual(afterB);
  expect(persisted.filter((event) => TERMINALS.has(event.type))).toEqual([]);
  const seqs = persisted.map((event) => event.sequenceNumber);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(persisted.filter((event) => event.type === 'run:failed')).toEqual([]);
  expect(
    [...usedByB].every((seq) => persisted.filter((e) => e.sequenceNumber === seq).length === 1),
  ).toBe(true);
  // No outbox entry: the run belongs to another process's log, so there is nothing for a later start to retry.
  expect(await a.host.terminalOutbox.list()).toEqual([]);
  // The re-taken claim was handed back, so the next `relavium gate` is not refused for a lease TTL.
  expect(await a.host.runLeases.read(runId)).toBeUndefined();
  // The run's stored status is the one B decided: paused at g2, resumable.
  const checkpoint = reconstructCheckpointState(persisted);
  expect(checkpoint?.runStatus).toBe('paused');
  expect(checkpoint?.pendingGates.map((gate) => gate.gateId)).toEqual([secondGate]);
  const interrupted = await store.listInterruptedRuns();
  expect(interrupted.find((run) => run.runId === runId)?.resumable).toBe(true);
}

/** The run A gave up stays healthy: a later process decides g2 and the run completes with one terminal. */
async function expectStillCompletes(scene: Scene): Promise<void> {
  const c = processOn(scene.store, 'terminal-c');
  const handleC = await c.engine.resumeFromCheckpoint({
    runId: scene.runId,
    workflow: TWO_GATES,
    gateId: scene.secondGate,
    decision: approve('terminal-c'),
  });
  const eventsC: RunEvent[] = [];
  for await (const event of handleC.events) eventsC.push(event);
  expect(eventsC.at(-1)?.type).toBe('run:completed');
  expect(handleC.durability()).toBe('durable');
  const terminals = scene.store
    .eventsFor(scene.runId)
    .filter((event) => TERMINALS.has(event.type))
    .map((event) => event.type);
  expect(terminals).toEqual(['run:completed']);
}

describe('a stale gate card after another process decided the gate (ADR-0079 §4/§5)', () => {
  it('answering it stops A as fenced: no terminal, no outbox entry, the re-taken lease released', async () => {
    const scene = await staleCardScene();
    // A's card for g1 is still open and takes an answer. A's resume re-takes the vacant lease under a fresh
    // fence; its guarded append is refused on its stale head — which is ownership loss, not a store fault.
    await scene.a.engine.resume(scene.runId, scene.firstGate, approve('terminal-a'));
    await scene.drainedA;

    await expectFencedAndUntouched(scene);
    await expectStillCompletes(scene);
  });

  it('Ctrl-C at it stops A as fenced too: no `run:cancelled` at a sequence B used', async () => {
    // The terminal-first sibling. A cancel at a parked run writes `run:cancelled` before anything else, and a
    // terminal is exempt from the append guard — so the first write under a re-taken claim carries the guard.
    const scene = await staleCardScene();
    scene.a.engine.cancel(scene.runId);
    await scene.drainedA;

    await expectFencedAndUntouched(scene);
    await expectStillCompletes(scene);
  });
});

describe('the uncontended park-and-resume path is unchanged', () => {
  it('re-takes the claim at each gate, completes, and writes its terminal exactly once', async () => {
    const store = new InMemoryRunStore();
    const solo = processOn(store, 'solo');
    const handle = solo.engine.start({ workflow: TWO_GATES });
    const runId = handle.runId;
    const events: RunEvent[] = [];
    const gates: string[] = [];
    let paused: () => void = () => undefined;
    let pause = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused') {
          gates.push(event.gateIds[0] ?? '');
          paused();
        }
      }
    })();

    for (const expected of ['g1', 'g2']) {
      await pause;
      pause = new Promise<void>((resolve) => {
        paused = resolve;
      });
      await leaseVacant(solo.host.runLeases, runId); // each park hands the claim back (§4)
      const gateId = gates.at(-1) ?? '';
      expect(
        reconstructCheckpointState(store.eventsFor(runId))?.pendingGates.map((g) => g.nodeId),
      ).toEqual([expected]);
      await solo.engine.resume(runId, gateId, approve('solo'));
    }
    await drained;

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(handle.durability()).toBe('durable');
    const persisted = store.eventsFor(runId);
    expect(persisted.filter((event) => TERMINALS.has(event.type)).map((e) => e.type)).toEqual([
      'run:completed',
    ]);
    const seqs = persisted.map((event) => event.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(await solo.host.terminalOutbox.list()).toEqual([]);
    expect((await handle.depart()).kind).toBe('closed');
    expect(await solo.host.runLeases.read(runId)).toBeUndefined();
  });

  it('a store fault on the first write under a re-taken claim stays a store fault: the run fails durably', async () => {
    // The re-take's head check must not swallow this process's OWN failures. The gate decision's write fails
    // for a store fault; the log did not move, so this is no takeover: the run fails as ADR-0078 says, the
    // later guarded writes fail closed against the failed ask, and the terminal — guarded against the head
    // this process left at its park, not against that failed ask — still lands.
    const inner = new InMemoryRunStore();
    let faultGateDecision = false;
    const store: RunStore = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: (event: RunEvent, ctx?: DurableWriteContext) => {
        if (faultGateDecision && event.type === 'human_gate:resumed') {
          faultGateDecision = false;
          return Promise.reject(new Error('disk I/O error'));
        }
        return inner.persistEvent(event, ctx);
      },
    };
    const host = createInMemoryHost({ store });
    const engine = new WorkflowEngine({ host, executor: new GateStub() });
    const handle = engine.start({ workflow: TWO_GATES });
    const runId = handle.runId;
    const events: RunEvent[] = [];
    let reached: (gateId: string) => void = () => undefined;
    const atFirstGate = new Promise<string>((resolve) => {
      reached = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused') reached(event.gateIds[0] ?? '');
      }
    })();
    const gateId = await atFirstGate;
    await leaseVacant(host.runLeases, runId);

    faultGateDecision = true;
    await engine.resume(runId, gateId, approve('solo'));
    await drained;

    expect(events.at(-1)?.type).toBe('run:failed');
    expect(handle.terminalError()).toBe('internal');
    expect(handle.durability()).toBe('durable'); // landed — not fenced, not held in the outbox
    expect(await host.terminalOutbox.list()).toEqual([]);
    const persisted = inner.eventsFor(runId);
    expect(persisted.filter((event) => TERMINALS.has(event.type)).map((e) => e.type)).toEqual([
      'run:failed',
    ]);
    expect(persisted.map((event) => event.type)).not.toContain('human_gate:resumed');
  });

  it('a later write failing closed on an OWN failed ask is not read as a takeover', async () => {
    // Two gates answered together under one re-taken claim. The first decision's write fails for a store fault;
    // the second is already queued behind it, and the guard refuses it against that failed ask — the log did
    // not move, it is failing closed as ADR-0078 intends. Comparing the refusal's durable head with the head
    // this process left at its park is what keeps that from being misread as another writer: the run fails and
    // its terminal lands, exactly as it did before the re-take check existed.
    const PARALLEL: WorkflowDefinition = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: stale-gate-card-parallel
  nodes:
    - { id: a, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g1 }
    - { from: a, to: g2 }
    - { from: g1, to: b }
    - { from: g2, to: b }
`,
    );
    const inner = new InMemoryRunStore();
    let holdFirstDecision = false;
    let entered: () => void = () => undefined;
    const firstDecisionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail: () => void = () => undefined;
    const store: RunStore = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      persistEvent: (event: RunEvent, ctx?: DurableWriteContext) => {
        if (holdFirstDecision && event.type === 'human_gate:resumed') {
          holdFirstDecision = false;
          entered();
          return new Promise<void>((_resolve, reject) => {
            fail = () => reject(new Error('disk I/O error'));
          });
        }
        return inner.persistEvent(event, ctx);
      },
    };
    const host = createInMemoryHost({ store });
    const engine = new WorkflowEngine({ host, executor: new GateStub() });
    const handle = engine.start({ workflow: PARALLEL });
    const runId = handle.runId;
    const events: RunEvent[] = [];
    let reached: (gateIds: readonly string[]) => void = () => undefined;
    const atGates = new Promise<readonly string[]>((resolve) => {
      reached = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused' && event.gateIds.length === 2) reached(event.gateIds);
      }
    })();
    const gateIds = await atGates;
    await leaseVacant(host.runLeases, runId);

    holdFirstDecision = true;
    const first = engine.resume(runId, gateIds[0] ?? '', approve('solo'));
    const second = engine.resume(runId, gateIds[1] ?? '', approve('solo'));
    await firstDecisionEntered;
    // One macrotask: every microtask chain has run, so the second decision is queued behind the first write.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    fail();
    await Promise.all([first, second]);
    await drained;

    expect(events.at(-1)?.type).toBe('run:failed');
    expect(handle.terminalError()).toBe('internal');
    expect(handle.durability()).toBe('durable');
    expect(await host.terminalOutbox.list()).toEqual([]);
    const persisted = inner.eventsFor(runId);
    expect(persisted.filter((event) => TERMINALS.has(event.type)).map((e) => e.type)).toEqual([
      'run:failed',
    ]);
    // Neither decision landed: the first for its fault, the second refused fail-closed behind it.
    expect(persisted.map((event) => event.type)).not.toContain('human_gate:resumed');
  });
});
