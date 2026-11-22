import { TOOL_ACTIVITY_MAX_ENTRIES } from '@relavium/shared';
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

const call = (ctx: NodeExecContext, toolId: string): void =>
  ctx.emit({
    type: 'agent:tool_call',
    nodeId: ctx.vertex.id,
    model: 'm',
    toolId,
    toolInput: { path: 'SECRET-ARGUMENT' },
  });

const result = (ctx: NodeExecContext, toolId: string, success: boolean): void =>
  ctx.emit({
    type: 'agent:tool_result',
    nodeId: ctx.vertex.id,
    toolId,
    success,
    outputSummary: 'SECRET-RESULT-TEXT',
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
  it('a node with one tool call and one result completes carrying one paired, timed entry', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'read_file');
        result(ctx, 'read_file', true);
        return done;
      },
    });
    const completed = terminal(
      await drain(engine.start({ workflow: workflow(PLAIN) })),
      'node:completed',
    );
    expect(completed).toMatchObject({
      type: 'node:completed',
      toolActivity: [{ toolId: 'read_file', ok: true }],
    });
    if (completed?.type !== 'node:completed') throw new Error('expected node:completed');
    const [entry] = completed.toolActivity ?? [];
    // The in-memory clock advances 1 ms per read, so the gap is a real non-negative whole number.
    expect(Number.isInteger(entry?.durationMs)).toBe(true);
    expect(entry?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(completed).not.toHaveProperty('toolActivityTruncated');
  });

  it('a node that made no tool call carries no toolActivity key at all', async () => {
    const { engine } = engineWith({});
    const events = await drain(engine.start({ workflow: workflow(PLAIN) }));
    for (const event of events) {
      if (event.type === 'node:completed') {
        expect(event).not.toHaveProperty('toolActivity');
        expect(event).not.toHaveProperty('toolActivityTruncated');
      }
    }
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

  it('a terminal failure carries the trace: a failed result is ok:false WITH a duration, an unpaired call has none', async () => {
    const { engine } = engineWith({
      work: (ctx) => {
        call(ctx, 'run_command');
        result(ctx, 'run_command', false);
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
    expect(failed.toolActivity).toHaveLength(2);
    expect(failed.toolActivity?.[0]).toMatchObject({ toolId: 'run_command', ok: false });
    expect(Number.isInteger(failed.toolActivity?.[0]?.durationMs)).toBe(true);
    expect(failed.toolActivity?.[1]).toEqual({ toolId: 'web_fetch', ok: false });
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
    expect(completed.toolActivity?.[0]).toMatchObject({ toolId: 'second-attempt-tool', ok: true });
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
    expect(failed.toolActivity).toEqual([{ toolId: 'attempt-3-tool', ok: false }]);
  });
});
