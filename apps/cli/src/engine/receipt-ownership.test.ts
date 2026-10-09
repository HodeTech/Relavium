import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent, RunFence } from '@relavium/shared';
import {
  WorkflowEngine,
  InMemoryRunStore,
  createInMemoryHost,
  createInMemoryRunLeases,
  parseWorkflow,
  type NodeExecContext,
  type NodeOutcome,
  type NodeReceiptContext,
  type RunStore,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runCosts,
  runMigrations,
} from '@relavium/db';

// Composition stays in the CLI's declared workspace dependency graph. Both stores enforce their real
// fence/head checks; no source alias or unguarded mock stands in for the native append transaction.
const definition = parseWorkflow(`schema_version: '1.0'
workflow:
  id: retained-receipt
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`);
const terminal = (event: RunEvent) =>
  event.type === 'run:completed' || event.type === 'run:failed' || event.type === 'run:cancelled';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('observable host transition did not complete');
}
function record(receipt: NodeReceiptContext, amount = 17): void {
  receipt.updateCost({
    type: 'cost:updated',
    nodeId: 'wrong-node-must-not-escape-receipt-correlation',
    model: 'offline-model',
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: amount,
    cumulativeCostMicrocents: 0,
  });
  receipt.money.record({
    nodeId: 'wrong-node-must-not-escape-receipt-correlation',
    model: 'offline-model',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: amount,
    priced: true,
  });
}
async function failure(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  return expect.fail('required receipt must reject');
}
function fixture(kind: 'reference' | 'native') {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const client = kind === 'native' ? createClient(':memory:') : undefined;
  let next = 0;
  if (client !== undefined) runMigrations(client.db);
  const native =
    client === undefined
      ? undefined
      : createRunHistoryStore(client.db, {
          uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
          now: () => now,
          workflow: {
            slug: definition.workflow.id,
            name: definition.workflow.id,
            definitionJson: JSON.stringify(definition),
          },
        });
  const reference = new InMemoryRunStore();
  const underlying: RunStore = native ?? reference;
  const base = createInMemoryHost({
    store: underlying,
    runLeases:
      native === undefined ? createInMemoryRunLeases(() => now) : createRunLeasePort(native),
  });
  const asks: { event: RunEvent; context: DurableWriteContext | undefined }[] = [];
  const heartbeats: RunFence[] = [];
  const releases: RunFence[] = [];
  const acquisitions: { runId: string; ownerId: string }[] = [];
  let before:
    | ((event: RunEvent, context: DurableWriteContext | undefined) => Promise<void>)
    | undefined;
  let after: ((event: RunEvent) => void) | undefined;
  let heartbeatBarrier: (() => Promise<void>) | undefined;
  const host = {
    ...base,
    store: {
      resolveWorkflowId: (slug: string) => underlying.resolveWorkflowId(slug),
      readWorkflowSnapshot: (runId: string) => underlying.readWorkflowSnapshot(runId),
      listInterruptedRuns: () => underlying.listInterruptedRuns(),
      persistEvent: async (event: RunEvent, context?: DurableWriteContext) => {
        asks.push({ event, context });
        await before?.(event, context);
        await underlying.persistEvent(event, context);
        after?.(event);
      },
    },
    runLeases: {
      ...base.runLeases,
      acquire: async (runId: string, ownerId: string, ttl: number) => {
        acquisitions.push({ runId, ownerId });
        return base.runLeases.acquire(runId, ownerId, ttl);
      },
      heartbeat: async (runId: string, fence: RunFence, ttl: number) => {
        heartbeats.push(fence);
        await heartbeatBarrier?.();
        return base.runLeases.heartbeat(runId, fence, ttl);
      },
      release: async (runId: string, fence: RunFence) => {
        releases.push(fence);
        await base.runLeases.release(runId, fence);
      },
    },
  };
  return {
    host,
    asks,
    heartbeats,
    releases,
    acquisitions,
    before: (hook: typeof before) => {
      before = hook;
    },
    after: (hook: typeof after) => {
      after = hook;
    },
    holdHeartbeat: (barrier: () => Promise<void>) => {
      heartbeatBarrier = barrier;
    },
    age: () => {
      now += 100000;
    },
    events: (runId: string) =>
      native?.loadRunEventLogForReplay(runId) ?? reference.eventsFor(runId),
    verifyNative: (runId: string, amount: number) => {
      if (client === undefined || native === undefined) return;
      const rows = client.db.select().from(runCosts).all();
      // Existing node completion rows carry zero in this fixture. The one late attempt must be the
      // exact positive addend, and the projection must equal the ledger sum.
      expect(rows.map((row) => row.costMicrocents)).toEqual([0, 0, amount]);
      expect(rows.reduce((total, row) => total + row.costMicrocents, 0)).toBe(amount);
      expect(native.loadRun(runId)).toMatchObject({
        status: 'completed',
        totalCostMicrocents: amount,
      });
    },
    close: () => client?.sqlite.close(),
  };
}
async function held(f: ReturnType<typeof fixture>) {
  const entered = deferred<{
    ctx: NodeExecContext;
    receipt: NodeReceiptContext;
    child: Promise<void>;
  }>();
  const raw = deferred<NodeOutcome>();
  const childDone = deferred<void>();
  const engine = new WorkflowEngine({
    host: f.host,
    executor: {
      execute: (ctx) => {
        if (ctx.vertex.id !== 'start') return Promise.resolve({ kind: 'completed', output: 'out' });
        let receipt: NodeReceiptContext | undefined;
        const child = ctx.continueReceipt?.((value) => {
          receipt = value;
          return childDone.promise;
        });
        if (child === undefined || receipt === undefined)
          throw new Error('engine must supply receipt transfer');
        entered.resolve({ ctx, receipt, child });
        return raw.promise;
      },
    },
  });
  const handle = engine.start({ workflow: definition });
  const delivered: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) delivered.push(event);
  })();
  return { engine, handle, delivered, drained, raw, childDone, ...(await entered.promise) };
}

for (const kind of ['reference', 'native'] as const)
  describe(`${kind} retained receipt ownership`, () => {
    it('ACKed T publishes before a transferred child, then R uses T head and the identical live fence', async () => {
      const f = fixture(kind);
      try {
        const h = await held(f);
        h.raw.resolve({ kind: 'completed', output: 'done' });
        await h.drained; // bounded primary outcome while the child is deliberately still pending
        const T = h.delivered.at(-1);
        expect(T).toMatchObject({ type: 'run:completed', totalCostMicrocents: 0 });
        const tAsk = f.asks.find((ask) => terminal(ask.event));
        const fence = tAsk?.context?.fence;
        expect(fence).toBeDefined();
        expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(fence ?? {});
        expect(f.releases).toEqual([]);
        f.host.fireLiveness();
        await until(() => f.heartbeats.length === 1 && f.host.livenessCount() === 1);
        expect(f.heartbeats[0]).toBe(fence);
        expect(Object.keys(h.receipt).sort()).toEqual(['continueReceipt', 'money', 'updateCost']);
        expect(() => h.ctx.continueReceipt?.(() => Promise.resolve())).toThrow(
          'receipt scope has already ended',
        );
        const writeEntered = deferred<void>();
        const writeDone = deferred<void>();
        f.before(async (event) => {
          if (event.type === 'cost:attempt_settled') {
            writeEntered.resolve();
            await writeDone.promise;
          }
        });
        record(h.receipt);
        const joined = h.receipt.money.join();
        await writeEntered.promise;
        h.childDone.resolve();
        await h.child;
        expect(() => record(h.receipt)).toThrow('receipt scope has already ended');
        // Entered money writes retain host ownership after the producing child's raw promise settles.
        expect(f.releases).toEqual([]);
        expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(fence ?? {});
        const rAsk = f.asks.find((ask) => ask.event.type === 'cost:attempt_settled');
        expect(rAsk?.context?.fence).toBe(fence);
        expect(rAsk?.context?.expectedLastSequenceNumber).toBe(T?.sequenceNumber);
        const beatEntered = deferred<void>();
        const beatDone = deferred<void>();
        f.holdHeartbeat(() => {
          beatEntered.resolve();
          return beatDone.promise;
        });
        f.host.fireLiveness();
        await beatEntered.promise;
        writeDone.resolve();
        await joined;
        // The raw child and ledger are done, but the entered beat still owns a host lifetime slot.
        expect(f.releases).toEqual([]);
        expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(fence ?? {});
        beatDone.resolve();
        await until(async () => (await f.host.runLeases.read(h.handle.runId)) === undefined);
        expect(f.releases).toEqual([fence]);
        expect(f.host.livenessCount()).toBe(0);
        expect(h.handle.durability()).toBe('durable');
        const rows = f.events(h.handle.runId);
        expect(rows.filter(terminal)).toEqual([T]);
        expect(rows.at(-1)).toMatchObject({
          type: 'cost:attempt_settled',
          nodeId: 'start',
          costMicrocents: 17,
          cumulativeCostMicrocents: 17,
        });
        expect(h.delivered.at(-1)).toBe(T);
        expect(await f.host.terminalOutbox.list()).toEqual([]);
        f.verifyNative(h.handle.runId, 17);
      } finally {
        f.close();
      }
    });

    for (const lostAck of [false, true])
      it(`${lostAck ? 'lost' : 'failed'} T ACK refuses R under retained ownership and preserves the original outbox`, async () => {
        const f = fixture(kind);
        try {
          const h = await held(f);
          const cause = new Error('PRIVATE terminal fault');
          if (lostAck)
            f.after((event) => {
              if (terminal(event)) throw cause;
            });
          else f.before((event) => (terminal(event) ? Promise.reject(cause) : Promise.resolve()));
          h.raw.resolve({ kind: 'completed', output: 'done' });
          await h.drained;
          const T = h.delivered.at(-1);
          const fence = f.asks.find((ask) => terminal(ask.event))?.context?.fence;
          expect(T).toMatchObject({ type: 'run:completed', totalCostMicrocents: 0 });
          expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(fence ?? {});
          expect(f.releases).toEqual([]);
          f.before(undefined);
          f.after(undefined);
          const count = f.asks.length;
          record(h.receipt);
          const error = await failure(h.receipt.money.join());
          expect(error.message).toBe('a realized-cost ledger write could not be made durable');
          expect(error.cause).toMatchObject({
            message: 'a required money write was not acknowledged persisted',
            cause,
          });
          if (!(error.cause instanceof Error))
            expect.fail('private original append failure required');
          expect(error.cause.cause).toBe(cause);
          expect(f.asks).toHaveLength(count); // sticky ACK refusal happens BEFORE asking the actual store
          expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(fence ?? {});
          expect(await f.host.terminalOutbox.list()).toEqual([T]);
          expect(h.handle.durability()).toBe('uncertain');
          h.childDone.resolve();
          await h.child;
          await until(async () => (await f.host.runLeases.read(h.handle.runId)) === undefined);
          const recovering = new WorkflowEngine({
            host: f.host,
            executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'unused' }) },
          });
          await recovering.drainTerminalOutbox();
          expect(await f.host.terminalOutbox.list()).toEqual([]);
          expect(f.events(h.handle.runId).filter(terminal)).toEqual([T]);
          expect(
            f.events(h.handle.runId).filter((event) => event.type === 'cost:attempt_settled'),
          ).toEqual([]);
        } finally {
          f.close();
        }
      });

    for (const releaseSuccessor of [false, true])
      it(`late ownership loss preserves ACKed T and refuses money after successor ${releaseSuccessor ? 'release' : 'acquisition'}`, async () => {
        const f = fixture(kind);
        try {
          const h = await held(f);
          h.raw.resolve({ kind: 'completed', output: 'done' });
          await h.drained;
          const T = h.delivered.at(-1);
          const originalFence = f.asks.find((ask) => terminal(ask.event))?.context?.fence;
          if (originalFence === undefined) expect.fail('terminal must have its exact fence');
          expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(originalFence);
          f.age();
          const successor = await f.host.runLeases.acquire(h.handle.runId, 'successor', 60000);
          if (successor === undefined) expect.fail('real expired-lease takeover must succeed');
          expect(successor.ownerId).toBe('successor');
          expect(successor.generation).toBeGreaterThan(originalFence.generation);
          expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(successor);
          expect(f.acquisitions).toEqual([
            { runId: h.handle.runId, ownerId: originalFence.ownerId },
            { runId: h.handle.runId, ownerId: successor.ownerId },
          ]);
          // These are distinct real store states before old-owner receipt entry. A vacant lease row
          // must not let the old execution reacquire, and a retained successor must not be deleted.
          if (releaseSuccessor) {
            await f.host.runLeases.release(h.handle.runId, successor);
            expect(await f.host.runLeases.read(h.handle.runId)).toBeUndefined();
          }
          const expectedReleases = releaseSuccessor ? [successor] : [];
          expect(f.releases).toEqual(expectedReleases);
          f.host.fireLiveness();
          await until(() => f.heartbeats.length === 1 && h.ctx.signal.aborted);
          expect(f.heartbeats[0]).toBe(originalFence);
          expect(h.handle.durability()).toBe('durable');
          const count = f.asks.length;
          record(h.receipt);
          expect((await failure(h.receipt.money.join())).message).toBe(
            'a realized-cost ledger write could not be made durable',
          );
          expect(f.asks).toHaveLength(count);
          h.childDone.resolve();
          await h.child;
          // Both real child and money promises settled. Let their queued retirement reactions run;
          // this task boundary is not a completion substitute for either producer or host operation.
          await setImmediate();
          expect(f.host.livenessCount()).toBe(0);
          expect(() => record(h.receipt)).toThrow('receipt scope has already ended');
          if (releaseSuccessor) expect(await f.host.runLeases.read(h.handle.runId)).toBeUndefined();
          else expect(await f.host.runLeases.read(h.handle.runId)).toMatchObject(successor);
          expect(f.acquisitions).toHaveLength(2); // no old-owner reacquisition, even into the vacant row
          expect(f.releases).toEqual(expectedReleases); // no old-owner release during retirement
          expect(f.asks).toHaveLength(count); // no delayed old-owner append
          expect(f.events(h.handle.runId).filter(terminal)).toEqual([T]);
          expect(h.delivered.at(-1)).toBe(T);
          expect(h.handle.durability()).toBe('durable');
          expect(await f.host.terminalOutbox.list()).toEqual([]);
        } finally {
          f.close();
        }
      });
  });
