import { describe, expect, it } from 'vitest';
import { BudgetSchema, type DurableWriteContext, type RunEvent } from '@relavium/shared';
import { prepareOutputCapPlan } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { BudgetGovernor, CommitmentDurabilityError } from './budget-governor.js';
import {
  createInMemoryHost,
  createInMemoryRunLeases,
  createInMemoryTerminalOutbox,
  InMemoryRunStore,
} from './execution-host.js';
import { isLedgerDurabilityError, MoneyDurability } from './money-durability.js';
import type { NodeExecContext, NodeOutcome, NodeReceiptContext } from './node-executor.js';
import type { PreEgressInfo } from './agent-turn.js';

const workflow = (budgeted = false, timed = false) =>
  parseWorkflow(`schema_version: '1.0'
workflow:
  id: append-acknowledgement
${timed ? '  timeout_ms: 1000' : ''}
${budgeted ? '  budget: { max_cost_microcents: 100000000, on_exceed: fail }' : ''}
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestInfo(): PreEgressInfo {
  const plan = prepareOutputCapPlan({
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    endpoint: 'official',
    maxTokens: 1,
    providerOptions: undefined,
  });
  return {
    ...plan,
    route: 'text',
    inputTokensEstimate: 0,
    maxTokensEstimate: undefined,
    outputCapPlan: plan,
  };
}

const terminal = (event: RunEvent) =>
  event.type === 'run:completed' || event.type === 'run:failed' || event.type === 'run:cancelled';

class ControlledStore extends InMemoryRunStore {
  readonly asks: { event: RunEvent; context: DurableWriteContext | undefined }[] = [];
  fault: ((event: RunEvent) => Promise<void> | void) | undefined;

  override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
    this.asks.push({ event, context });
    await this.fault?.(event);
    await super.persistEvent(event, context);
  }
}

async function heldRun(
  store: ControlledStore,
  options: {
    budgeted?: boolean;
    loseHeartbeat?: boolean;
    timed?: boolean;
    failOutbox?: boolean;
  } = {},
) {
  const entered = deferred<NodeExecContext>();
  const finish = deferred<NodeOutcome>();
  const leases = createInMemoryRunLeases();
  const host = createInMemoryHost({
    store,
    ...(options.failOutbox
      ? {
          terminalOutbox: {
            ...createInMemoryTerminalOutbox(),
            put: () => Promise.reject(new Error('PRIVATE outbox failure')),
          },
        }
      : {}),
    ...(options.loseHeartbeat
      ? { runLeases: { ...leases, heartbeat: () => Promise.resolve(false) } }
      : {}),
  });
  const engine = new WorkflowEngine({
    host,
    executor: {
      execute: (ctx) => {
        if (ctx.vertex.id !== 'start') return Promise.resolve({ kind: 'completed', output: 'out' });
        entered.resolve(ctx);
        return finish.promise;
      },
    },
  });
  const handle = engine.start({ workflow: workflow(options.budgeted, options.timed) });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const ctx = await entered.promise;
  if (ctx.money === undefined) expect.unreachable('every workflow dispatch has its money port');
  const money = ctx.money;
  return { host, engine, handle, events, drained, ctx, money, finish };
}

function record(ctx: NodeExecContext | NodeReceiptContext, amount = 17, attemptNumber = 1): void {
  const nodeId = 'vertex' in ctx ? ctx.vertex.id : 'start';
  const emit = 'vertex' in ctx ? ctx.emit : ctx.updateCost;
  emit({
    type: 'cost:updated',
    nodeId,
    model: 'offline-model',
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: amount,
    cumulativeCostMicrocents: 0,
  });
  ctx.money?.record({
    nodeId,
    model: 'offline-model',
    attemptNumber,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: amount,
    priced: true,
  });
}

function retainReceipt(ctx: NodeExecContext) {
  const done = deferred<void>();
  let receipt: NodeReceiptContext | undefined;
  const joined = ctx.continueReceipt?.((child) => {
    receipt = child;
    return done.promise;
  });
  if (receipt === undefined || joined === undefined) expect.unreachable('engine receipt context');
  return { receipt, release: () => done.resolve(), joined };
}

async function rejection(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  expect.unreachable('a required unacknowledged money write must reject');
}

function expectPrivateCause(error: unknown, original: unknown): void {
  if (!isLedgerDurabilityError(error)) expect.unreachable('expected the existing ledger error');
  expect(error.message).toBe('a realized-cost ledger write could not be made durable');
  if (!(error.cause instanceof Error)) expect.unreachable('missing private append failure');
  expect(error.cause.message).toBe('a required money write was not acknowledged persisted');
  expect(error.cause.cause).toBe(original);
}

describe('ADR-0103 private append acknowledgement', () => {
  it('rejects each failed required ledger append even when an earlier fault already failed the run', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store);
    const first = new Error('PRIVATE first write');
    const second = new Error('PRIVATE later write');
    let calls = 0;
    store.fault = (event) => {
      if (event.type === 'cost:attempt_settled') throw ++calls === 1 ? first : second;
    };
    record(h.ctx);
    expectPrivateCause(await rejection(h.money.join()), first);
    await h.money.join(); // consuming the first error cannot make the second append truthful
    record(h.ctx, 23, 2);
    expectPrivateCause(await rejection(h.money.join()), second);
    expect(calls).toBe(2);
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    expect(h.events.at(-1)).toMatchObject({ type: 'run:failed' });
    expect(JSON.stringify(h.events)).not.toContain('PRIVATE');
  });

  it('keeps an acknowledged ledger durable when a run timeout changes the unrelated run failure during its append', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store, { timed: true });
    const entered = deferred<void>();
    const release = deferred<void>();
    store.fault = async (event) => {
      if (event.type !== 'cost:attempt_settled') return;
      entered.resolve();
      await release.promise;
    };
    record(h.ctx);
    const joined = h.money.join();
    await entered.promise;
    h.host.fireTimers();
    expect(h.ctx.signal.aborted).toBe(true);
    release.resolve();
    await expect(joined).resolves.toBeUndefined();
    expect(
      store.eventsFor(h.handle.runId).filter((event) => event.type === 'cost:attempt_settled'),
    ).toHaveLength(1);
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    expect(h.events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
  });

  it('refuses new raw-scope calls after the exact producer has settled', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store);
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    const count = store.asks.length;
    expect(() => record(h.ctx)).toThrow('the receipt scope has already ended');
    expect(() => h.money.join()).toThrow('the receipt scope has already ended');
    expect(store.asks).toHaveLength(count);
    expect(h.handle.durability()).toBe('durable');
    expect(h.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: 0 });
    await expect.poll(() => h.host.runLeases.read(h.handle.runId)).toBeUndefined();
  });

  it('keeps genuine pre-terminal ownership loss terminal-free and rejects an incurred receipt', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store, { loseHeartbeat: true });
    h.host.fireLiveness();
    await h.drained;
    const count = store.asks.length;
    record(h.ctx);
    expect(isLedgerDurabilityError(await rejection(h.money.join()))).toBe(true);
    expect(store.asks).toHaveLength(count);
    expect(h.events.some(terminal)).toBe(false);
    expect(h.handle.durability()).toBe('uncertain');
    h.finish.resolve({ kind: 'completed', output: 'retired' });
  });

  for (const lostAcknowledgement of [false, true]) {
    it(`preserves original terminal outbox and refuses later money after ${lostAcknowledgement ? 'lost ACK' : 'failed append'}`, async () => {
      const store = new ControlledStore();
      const h = await heldRun(store);
      const child = retainReceipt(h.ctx);
      record(h.ctx, 5);
      await h.money.join();
      const enteredTerminal = deferred<void>();
      const releaseTerminal = deferred<void>();
      const cause = new Error('PRIVATE terminal append failure');
      store.fault = async (event) => {
        if (!terminal(event)) return;
        enteredTerminal.resolve();
        await releaseTerminal.promise;
        if (lostAcknowledgement) {
          const ask = store.asks.find((item) => item.event === event);
          await InMemoryRunStore.prototype.persistEvent.call(store, event, ask?.context);
        }
        throw cause;
      };
      h.finish.resolve({ kind: 'completed', output: 'done' });
      await enteredTerminal.promise;
      record(child.receipt, 7, 2); // transferred child asks behind T while its ACK is pending
      const failedReceipt = rejection(child.receipt.money.join());
      releaseTerminal.resolve();
      await h.drained;
      expectPrivateCause(await failedReceipt, cause);
      const intendedTerminal = h.events.at(-1);
      expect(intendedTerminal).toMatchObject({ type: 'run:completed', totalCostMicrocents: 5 });
      expect(h.handle.durability()).toBe('uncertain');
      expect(await h.host.terminalOutbox.list()).toEqual([intendedTerminal]);
      expect(store.asks.filter((ask) => ask.event.type === 'cost:attempt_settled')).toHaveLength(1);
      store.fault = undefined;
      expect(await h.host.runLeases.read(h.handle.runId)).toBeDefined();
      record(child.receipt, 9, 3);
      expectPrivateCause(await rejection(child.receipt.money.join()), cause);
      expect(store.asks.filter((ask) => ask.event.type === 'cost:attempt_settled')).toHaveLength(1);
      expect(await h.host.terminalOutbox.list()).toEqual([intendedTerminal]);
      child.release();
      await child.joined;
      // Wait on observable ownership, not an assumed count of promise turns.
      for (
        let turn = 0;
        turn < 200 && (await h.host.runLeases.read(h.handle.runId)) !== undefined;
        turn++
      )
        await Promise.resolve();
      expect(await h.host.runLeases.read(h.handle.runId)).toBeUndefined();
      const recovering = new WorkflowEngine({
        host: h.host,
        executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'unused' }) },
      });
      await recovering.drainTerminalOutbox();
      expect(await h.host.terminalOutbox.list()).toEqual([]);
      expect(store.eventsFor(h.handle.runId).filter(terminal)).toEqual([intendedTerminal]);
    });
  }

  it('refuses later money even when the terminal outbox also failed', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store, { failOutbox: true });
    const child = retainReceipt(h.ctx);
    const cause = new Error('PRIVATE terminal failure');
    store.fault = (event) => {
      if (terminal(event)) throw cause;
    };
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    const asks = store.asks.length;
    store.fault = undefined;
    expect(await h.host.runLeases.read(h.handle.runId)).toBeDefined();
    record(child.receipt);
    expectPrivateCause(await rejection(child.receipt.money.join()), cause);
    child.release();
    await child.joined;
    expect(store.asks).toHaveLength(asks);
    expect(await h.host.terminalOutbox.list()).toEqual([]);
    expect(h.handle.durability()).toBe('uncertain');
    expect(h.events.at(-1)?.type).toBe('run:completed');
  });

  it('a terminal ACK failure alone does not fabricate a ledger failure', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store);
    const child = retainReceipt(h.ctx);
    store.fault = (event) => {
      if (terminal(event)) throw new Error('PRIVATE terminal');
    };
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    await expect(child.receipt.money.join()).resolves.toBeUndefined();
    child.release();
    await child.joined;
    expect(h.handle.durability()).toBe('uncertain');
    expect(h.events.at(-1)?.type).toBe('run:completed');
  });

  it('a post-ACK retention callback throw cannot undo persisted terminal truth', async () => {
    const store = new ControlledStore();
    let callbackCalls = 0;
    const host = createInMemoryHost({ store });
    const engine = new WorkflowEngine({
      host: {
        ...host,
        mediaReferences: {
          recordRunMedia: () => {},
          reclaimRun: () => {
            callbackCalls += 1;
            throw new Error('PRIVATE retention callback');
          },
        },
      },
      executor: { execute: () => Promise.resolve({ kind: 'completed', output: 'done' }) },
    });
    const handle = engine.start({ workflow: workflow() });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(callbackCalls).toBe(1);
    expect(handle.durability()).toBe('durable');
    expect(await host.terminalOutbox.list()).toEqual([]);
    expect(store.eventsFor(handle.runId).filter(terminal)).toEqual(events.filter(terminal));
  });

  it('conservative production append refusal reaches the existing commitment error after cancellation', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store, { budgeted: true });
    const admission = await h.ctx.preEgress?.(requestInfo());
    if (admission === undefined) expect.unreachable('expected budget admission');
    h.handle.cancel();
    const cause = new Error('PRIVATE conservative append');
    store.fault = (event) => {
      if (event.type === 'budget:estimate_committed') throw cause;
    };
    admission.settleAtReservedEstimate();
    const failure = await rejection(h.money.join());
    expect(failure).toBeInstanceOf(CommitmentDurabilityError);
    if (!(failure instanceof CommitmentDurabilityError) || !(failure.cause instanceof Error))
      expect.unreachable('expected private conservative cause');
    expect(failure.cause.cause).toBe(cause);
    await h.money.join();
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    expect(h.events.at(-1)?.type).toBe('run:cancelled');
    expect(JSON.stringify(h.events)).not.toContain('PRIVATE');
  });

  it('a previously admitted conservative obligation is still a typed failure on a retained receipt scope', async () => {
    const store = new ControlledStore();
    const h = await heldRun(store, { budgeted: true });
    const child = retainReceipt(h.ctx);
    const admission = await h.ctx.preEgress?.(requestInfo());
    if (admission === undefined) expect.unreachable('expected budget admission');
    h.finish.resolve({ kind: 'completed', output: 'done' });
    await h.drained;
    const asks = store.asks.length;
    admission.settleAtReservedEstimate();
    await expect(child.receipt.money.join()).rejects.toBeInstanceOf(CommitmentDurabilityError);
    child.release();
    await child.joined;
    expect(store.asks).toHaveLength(asks);
    expect(h.handle.durability()).toBe('durable');
  });

  it('both money owners keep sticky failure state after the shared join consumes their errors', async () => {
    const governor = new BudgetGovernor({
      budget: BudgetSchema.parse({ max_cost_microcents: 100000000, on_exceed: 'fail' }),
      emit: () => {
        throw new Error('PRIVATE conservative');
      },
    });
    const money = new MoneyDurability({
      emit: () => {
        throw new Error('PRIVATE realized');
      },
      flushConservative: () => governor.flushCommitments(),
    });
    const admission = await governor.checkPreEgress(requestInfo());
    admission?.settleAtReservedEstimate();
    money.record(
      {
        nodeId: 'start',
        model: 'offline-model',
        attemptNumber: 1,
        inputTokens: 1,
        outputTokens: 1,
        costMicrocents: 17,
        priced: true,
      },
      17,
    );
    await expect(money.join()).rejects.toBeInstanceOf(CommitmentDurabilityError);
    await expect(money.join()).rejects.toSatisfy(isLedgerDurabilityError);
    await expect(money.join()).resolves.toBeUndefined();
    expect(money.durabilityBroken).toBe(true);
    expect(governor.conservativeDurabilityBroken).toBe(true);
  });
});
