import { RunEventSchema, TOOL_ACTIVITY_MAX_ENTRIES } from '@relavium/shared';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';
import { WorkflowEngine } from './engine.js';

/**
 * The engine's half of ADR-0140 §4: the `agent:tool_call` / `agent:tool_result` events a node streams become the
 * content-free `toolActivity` on that node's durable terminal — without touching the stream's order or numbering.
 * (The tracker's own rules are in `tool-activity.test.ts`; these tests prove it is WIRED.)
 */

type Handler = (ctx: NodeExecContext) => NodeOutcome | Promise<NodeOutcome>;

function workflow(body: string): WorkflowDefinition {
  return parseWorkflow(`schema_version: '1.0'\nworkflow:\n${body}`);
}

const PLAIN = `  id: tool-activity
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'w' }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;

const RETRYING = `  id: tool-activity-retry
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'w', retry: { max: 3, backoff: linear, backoff_ms: 10 } }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;

function engineWith(handlers: Readonly<Record<string, Handler>>, host = createInMemoryHost()) {
  const executor: NodeExecutor = {
    execute: (ctx) => {
      const handler = handlers[ctx.vertex.id];
      return Promise.resolve(
        handler === undefined ? { kind: 'completed', output: ctx.vertex.id } : handler(ctx),
      );
    },
  };
  return { engine: new WorkflowEngine({ host, executor }), host };
}

/** A tool call STARTS: the turn announces it through `ctx.onToolStart` before the registry is entered (ADR-0140 §4). */
const start = (ctx: NodeExecContext, toolId: string): void => ctx.onToolStart?.(toolId);

/** A whole call as the turn performs it: announced as started, then its `agent:tool_call` event after the dispatch. */
const call = (ctx: NodeExecContext, toolId: string): void => {
  start(ctx, toolId);
  ctx.emit({
    type: 'agent:tool_call',
    nodeId: ctx.vertex.id,
    model: 'm',
    toolId,
    toolInput: { path: 'SECRET-ARGUMENT' },
  });
};

const result = (
  ctx: NodeExecContext,
  toolId: string,
  success: boolean,
  durationMs?: number,
): void =>
  ctx.emit({
    type: 'agent:tool_result',
    nodeId: ctx.vertex.id,
    toolId,
    success,
    outputSummary: 'SECRET-RESULT-TEXT',
    ...(durationMs === undefined ? {} : { durationMs }),
  });

const done: NodeOutcome = {
  kind: 'completed',
  output: 'done',
  tokensUsed: { input: 1, output: 1 },
};

async function drain(handle: { events: AsyncIterable<RunEvent> }): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

const terminal = (events: readonly RunEvent[], type: 'node:completed' | 'node:failed') =>
  events.find((event) => event.type === type && event.nodeId === 'work');

describe('node terminals carry the content-free toolActivity (ADR-0140 §4)', () => {
  it('a node with one tool call and one result completes carrying one paired entry with the MEASURED duration', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'read_file');
        result(ctx, 'read_file', true, 37);
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    // The duration is the one the result CARRIED (the turn measured it around the dispatch), not a difference of the
    // engine's clock between the two emits — which are back to back and would read about 0 (here, 1 tick).
    expect(completed.toolActivity).toEqual([
      { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 37 },
    ]);
    expect(completed).not.toHaveProperty('toolActivityTruncated');
  });

  it('a result that carries NO measured duration leaves the entry without one — ok still follows success', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'read_file');
        result(ctx, 'read_file', true);
        call(ctx, 'run_command');
        result(ctx, 'run_command', false);
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.toolActivity).toEqual([
      { toolId: 'read_file', ok: true, resultRecorded: true },
      { toolId: 'run_command', ok: false, resultRecorded: true },
    ]);
  });

  it('a node that made no tool call carries toolActivity: [] — present and empty — and no truncated count', async () => {
    const { engine } = engineWith({});
    const events = await drain(engine.start({ workflow: workflow(PLAIN) }));
    const completed = events.filter((event) => event.type === 'node:completed');
    expect(completed.length).toBeGreaterThan(0); // every kind of node: input, transform and output alike
    for (const event of completed) {
      expect(event).toHaveProperty('toolActivity', []);
      expect(event).not.toHaveProperty('toolActivityTruncated');
    }
  });

  it('a node that fails without a tool call carries toolActivity: [] too, so absence only ever means an older log', async () => {
    const { engine } = engineWith({
      work: () => ({
        kind: 'failed',
        error: { code: 'validation', message: 'fatal', retryable: false },
      }),
    });
    const failed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:failed',
    );
    if (failed?.type !== 'node:failed') throw new Error('expected node:failed');
    expect(failed).toHaveProperty('toolActivity', []);
    expect(failed).not.toHaveProperty('toolActivityTruncated');
  });

  it('hands every executor the ENGINE’s elapsed clock, so a measurement and the bus timestamps share one clock', async () => {
    // A host whose clock moves only when the test says so: the span between two reads of `ctx.elapsedMs` is then
    // exactly what the test advanced, and a clock the engine did not supply could not produce it.
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let offset = 0;
    const host = {
      ...createInMemoryHost(),
      clock: { now: () => new Date(base + offset).toISOString() },
    };
    const { engine } = engineWith(
      {
        work: (ctx) => {
          const startedAt = ctx.elapsedMs?.();
          offset += 250;
          const finishedAt = ctx.elapsedMs?.();
          if (startedAt === undefined || finishedAt === undefined)
            throw new Error('the engine supplied no elapsed clock');
          call(ctx, 'read_file');
          result(ctx, 'read_file', true, finishedAt - startedAt);
          return done;
        },
      },
      host,
    );
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.toolActivity).toEqual([
      { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 250 },
    ]);
  });

  it('stores nothing but ids, outcomes and durations: the call arguments and the result text never reach the terminal', async () => {
    const store = new InMemoryRunStore();
    const { engine } = engineWith(
      {
        work: (ctx) => {
          call(ctx, 'read_file');
          result(ctx, 'read_file', true);
          return done;
        },
      },
      createInMemoryHost({ store }),
    );
    const events = await drain(engine.start({ workflow: workflow(PLAIN) }));
    const runId = events[0]?.type === 'run:started' ? events[0].runId : '';
    const persisted = JSON.stringify(
      store.eventsFor(runId).filter((event) => event.type === 'node:completed'),
    );
    expect(persisted).toContain('"toolActivity"'); // the durable row carries it …
    expect(persisted).not.toContain('SECRET-ARGUMENT'); // … and nothing of the call
    expect(persisted).not.toContain('SECRET-RESULT-TEXT'); // … or of the result
    // The streamed events themselves are unchanged: they still carry their own (sanitized) content.
    expect(JSON.stringify(events)).toContain('SECRET-ARGUMENT');
  });

  it('does not change the stream: tool events keep their place before the terminal, and numbering stays gap-free', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'a');
        result(ctx, 'a', true);
        call(ctx, 'b');
        result(ctx, 'b', false);
        return done;
      },
    });
    const events = await drain(engine.start({ workflow: workflow(PLAIN) }));
    events.forEach((event, index) => expect(event.sequenceNumber).toBe(index));
    const order = events
      .filter((event) => event.type.startsWith('agent:tool') || event.type === 'node:completed')
      .filter((event) => 'nodeId' in event && event.nodeId === 'work')
      .map((event) => event.type);
    expect(order).toEqual([
      'agent:tool_call',
      'agent:tool_result',
      'agent:tool_call',
      'agent:tool_result',
      'node:completed',
    ]);
  });

  it('a terminal failure carries the trace: a failed result is ok:false WITH a duration, an unpaired call says no result was recorded', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'run_command');
        result(ctx, 'run_command', false, 12);
        call(ctx, 'web_fetch'); // the node fails before this call's result is recorded
        return {
          kind: 'failed',
          error: { code: 'validation', message: 'fatal', retryable: false },
        };
      },
    });
    const failed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:failed',
    );
    if (failed?.type !== 'node:failed') throw new Error('expected node:failed');
    expect(failed.toolActivity).toEqual([
      { toolId: 'run_command', ok: false, resultRecorded: true, durationMs: 12 },
      { toolId: 'web_fetch', ok: false, resultRecorded: false },
    ]);
  });

  it('a call whose id is not a bounded tool id is stored as unknown_tool, and the persisted terminal still validates', async () => {
    const store = new InMemoryRunStore();
    const hostile = `leak-${'z'.repeat(300)}`;
    const { engine } = engineWith(
      {
        work: (ctx) => {
          call(ctx, hostile);
          result(ctx, hostile, true, 5);
          call(ctx, 'read_file');
          result(ctx, 'read_file', true, 6);
          return done;
        },
      },
      createInMemoryHost({ store }),
    );
    const events = await drain(engine.start({ workflow: workflow(PLAIN) }));
    const runId = events[0]?.type === 'run:started' ? events[0].runId : '';
    const persisted = store.eventsFor(runId).filter((event) => event.type === 'node:completed');
    const work = persisted.find((event) => event.nodeId === 'work');
    expect(work).toMatchObject({
      toolActivity: [
        { toolId: 'unknown_tool', ok: true, resultRecorded: true, durationMs: 5 },
        { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 6 },
      ],
    });
    expect(JSON.stringify(persisted)).not.toContain('leak-');
    // The schema bound and the stored value agree: a node event the engine wrote never fails to parse.
    for (const event of persisted) expect(RunEventSchema.safeParse(event).success).toBe(true);
  });

  it('keeps the first 50 calls of a runaway node and counts the rest, and the bounded event still validates', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        for (let index = 0; index < TOOL_ACTIVITY_MAX_ENTRIES + 2; index += 1) {
          call(ctx, 'bash');
          result(ctx, 'bash', true);
        }
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.toolActivity).toHaveLength(TOOL_ACTIVITY_MAX_ENTRIES);
    expect(completed.toolActivityTruncated).toBe(2);
  });

  it('a retried node: node:retrying carries nothing, and the recovering attempt reports only its own calls', async () => {
    const host = createInMemoryHost();
    let attempts = 0;
    const { engine } = engineWith(
      {
        work: (ctx) => {
          attempts += 1;
          if (attempts === 1) {
            call(ctx, 'first-attempt-tool');
            result(ctx, 'first-attempt-tool', false);
            return {
              kind: 'failed',
              error: { code: 'tool_failed', message: 'transient', retryable: true },
            };
          }
          call(ctx, 'second-attempt-tool');
          result(ctx, 'second-attempt-tool', true);
          return done;
        },
      },
      host,
    );
    const events: RunEvent[] = [];
    for await (const event of engine.start({ workflow: workflow(RETRYING) }).events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        let waited = 0;
        while (host.armedCount() === 0 && waited < 1000) {
          waited += 1;
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }
    const retrying = events.find((event) => event.type === 'node:retrying');
    expect(retrying).toBeDefined();
    expect(retrying).not.toHaveProperty('toolActivity');
    const completed = terminal(events, 'node:completed');
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.attemptNumber).toBe(2);
    expect(completed.toolActivity).toHaveLength(1);
    expect(completed.toolActivity?.[0]).toMatchObject({
      toolId: 'second-attempt-tool',
      ok: true,
      resultRecorded: true,
    });
  });

  it('a terminal failure after exhausted retries reports the LAST attempt only', async () => {
    const host = createInMemoryHost();
    let attempts = 0;
    const { engine } = engineWith(
      {
        work: (ctx) => {
          attempts += 1;
          call(ctx, `attempt-${attempts}-tool`);
          return {
            kind: 'failed',
            error: { code: 'tool_failed', message: 'transient', retryable: true },
          };
        },
      },
      host,
    );
    const events: RunEvent[] = [];
    for await (const event of engine.start({ workflow: workflow(RETRYING) }).events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        let waited = 0;
        while (host.armedCount() === 0 && waited < 1000) {
          waited += 1;
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }
    const failed = terminal(events, 'node:failed');
    if (failed?.type !== 'node:failed') throw new Error('expected node:failed');
    expect(attempts).toBe(3);
    expect(failed.toolActivity).toEqual([
      { toolId: 'attempt-3-tool', ok: false, resultRecorded: false },
    ]);
  });

  it('a call counts ONCE: the agent:tool_call event no longer records it a second time', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'read_file'); // announced as started AND emitted as an event
        result(ctx, 'read_file', true, 3);
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.toolActivity).toEqual([
      { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 3 },
    ]);
  });

  it('records a call from its START, not from its event: a call announced and never answered is an unpaired entry', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        start(ctx, 'run_command'); // no agent:tool_call, no agent:tool_result — the node ends first
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    expect(completed.toolActivity).toEqual([
      { toolId: 'run_command', ok: false, resultRecorded: false },
    ]);
  });

  describe('a call in flight when its node is cut is shown, not dropped (ADR-0140 §4)', () => {
    const TIMED = `  id: tool-activity-deadline
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: a, prompt_template: 'go', timeout_ms: 4000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;

    /** The hung executor of both cuts: one call finishes, a second starts and never answers. */
    const hangingHandler =
      (late: { current?: NodeExecContext }) =>
      (ctx: NodeExecContext): Promise<NodeOutcome> => {
        call(ctx, 'read_file');
        result(ctx, 'read_file', true, 9);
        start(ctx, 'run_command'); // in flight: announced, never answered
        late.current = ctx;
        return new Promise<NodeOutcome>(() => undefined);
      };

    async function run(
      host: ReturnType<typeof createInMemoryHost>,
      engine: WorkflowEngine,
      cut: () => void,
      late: { current?: NodeExecContext },
    ): Promise<RunEvent[]> {
      const handle = engine.start({ workflow: workflow(TIMED) });
      const events: RunEvent[] = [];
      let settled = false;
      const consume = (async (): Promise<void> => {
        for await (const event of handle.events) {
          events.push(event);
          if (
            event.type === 'run:failed' ||
            event.type === 'run:cancelled' ||
            event.type === 'run:completed'
          )
            settled = true;
        }
      })();
      for (let i = 0; i < 400 && late.current === undefined; i += 1) await Promise.resolve();
      expect(late.current).toBeDefined(); // the premise: the executor is mid-call
      cut();
      for (let i = 0; i < 800 && !settled; i += 1) {
        await Promise.resolve();
        if (host.armedCount() > 0) host.fireTimers();
      }
      await consume;
      return events;
    }

    it('a node cut by its authored deadline carries the call that was running as an UNPAIRED entry', async () => {
      const host = createInMemoryHost();
      const late: { current?: NodeExecContext } = {};
      const { engine } = engineWith({ work: hangingHandler(late) }, host);
      const events = await run(host, engine, () => host.fireDeadlines(), late);
      const failed = terminal(events, 'node:failed');
      if (failed?.type !== 'node:failed') throw new Error('expected node:failed');
      expect(failed.error.code).toBe('run_timeout');
      // Before: the call was recorded only when its event was emitted after the dispatch returned, and that emit is
      // dropped once the node is cut, so this terminal carried the finished call and nothing of the one in flight.
      expect(failed.toolActivity).toEqual([
        { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 9 },
        { toolId: 'run_command', ok: false, resultRecorded: false },
      ]);
      expect(RunEventSchema.safeParse(failed).success).toBe(true);
    });

    it('a node abandoned after its grace window carries the call that was running as an UNPAIRED entry', async () => {
      const host = createInMemoryHost();
      const late: { current?: NodeExecContext } = {};
      const { engine } = engineWith({ work: hangingHandler(late) }, host);
      // No authored `timeout_ms` here, so the node's only bound is the run's grace window after the cancel.
      const handle = engine.start({ workflow: workflow(PLAIN) });
      const events: RunEvent[] = [];
      let settled = false;
      const consume = (async (): Promise<void> => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
        }
      })();
      for (let i = 0; i < 400 && late.current === undefined; i += 1) await Promise.resolve();
      expect(late.current).toBeDefined();
      engine.cancel(handle.runId);
      for (let i = 0; i < 200 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
      expect(host.deadlineCount()).toBe(1); // the grace window, and nothing else
      host.fireDeadlines();
      for (let i = 0; i < 800 && !settled; i += 1) {
        await Promise.resolve();
        if (host.armedCount() > 0) host.fireTimers();
      }
      await consume;
      const failed = terminal(events, 'node:failed');
      if (failed?.type !== 'node:failed') throw new Error('expected node:failed');
      expect(failed.error.message).toContain('the engine stopped waiting'); // the grace path, not a node deadline
      expect(failed.toolActivity).toEqual([
        { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 9 },
        { toolId: 'run_command', ok: false, resultRecorded: false },
      ]);
    });
  });

  describe('a node re-dispatched after an earlier dispatch ended without a terminal (ADR-0140 §4)', () => {
    const PAUSING = `  id: tool-activity-redispatch
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'w' }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }
  budget:
    max_cost_microcents: 100000000
    on_exceed: pause_for_approval`;

    const budgetGate: NodeOutcome = {
      kind: 'paused',
      gate: {
        gateType: 'approval',
        message: 'over budget — continue?',
        isBudgetGate: true,
        spentMicrocents: 900,
        limitMicrocents: 1000,
      },
    };

    async function approveEveryPause(
      engine: WorkflowEngine,
      workflowDefinition: WorkflowDefinition,
    ): Promise<RunEvent[]> {
      const handle = engine.start({ workflow: workflowDefinition });
      const events: RunEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused') {
          const gateId = event.gateIds[0];
          if (gateId !== undefined) {
            await engine.resume(handle.runId, gateId, {
              decision: 'approved',
              decidedBy: 'tester',
            });
          }
        }
      }
      return events;
    }

    it('the second dispatch reports only its own calls: the first dispatch’s trace is discarded when the node starts again', async () => {
      let dispatches = 0;
      const { engine } = engineWith({
        work: (ctx) => {
          dispatches += 1;
          if (dispatches === 1) {
            call(ctx, 'first-dispatch-tool');
            result(ctx, 'first-dispatch-tool', true, 4);
            start(ctx, 'first-dispatch-in-flight'); // and one that never answered before the pause
            return budgetGate; // no terminal: the node waits for the approval
          }
          call(ctx, 'second-dispatch-tool');
          result(ctx, 'second-dispatch-tool', true, 6);
          return done;
        },
      });
      const events = await approveEveryPause(engine, workflow(PAUSING));
      expect(dispatches).toBe(2); // the premise: the approval really did re-dispatch the node
      expect(
        events.filter((event) => event.type === 'node:started' && event.nodeId === 'work'),
      ).toHaveLength(2);
      const completed = terminal(events, 'node:completed');
      if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
      expect(completed.toolActivity).toEqual([
        { toolId: 'second-dispatch-tool', ok: true, resultRecorded: true, durationMs: 6 },
      ]);
    });

    it('a straggler of the first dispatch cannot put a call on the successor’s trace', async () => {
      let dispatches = 0;
      let firstCtx: NodeExecContext | undefined;
      const { engine } = engineWith({
        work: (ctx) => {
          dispatches += 1;
          if (dispatches === 1) {
            firstCtx = ctx;
            return budgetGate;
          }
          firstCtx?.onToolStart?.('straggler-tool'); // dispatch 1's captured hook fires while dispatch 2 is live
          call(ctx, 'second-dispatch-tool');
          result(ctx, 'second-dispatch-tool', true, 6);
          return done;
        },
      });
      const events = await approveEveryPause(engine, workflow(PAUSING));
      expect(dispatches).toBe(2);
      const completed = terminal(events, 'node:completed');
      if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
      expect(completed.toolActivity).toEqual([
        { toolId: 'second-dispatch-tool', ok: true, resultRecorded: true, durationMs: 6 },
      ]);
    });
  });
});
