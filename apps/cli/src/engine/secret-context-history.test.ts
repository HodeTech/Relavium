import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow, type RunHandle, type WorkflowDefinition } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEngine } from './build-engine.js';
import { createHistoryCheckpointer } from './checkpointer.js';
import { createCliHost } from './host.js';

// Synthetic test data, deliberately unrelated to provider credentials.
const CANARY = '__canary__sqlite_newly_derived_secret_0113__';
const RESUPPLIED_CANARY = '__canary__sqlite_resupplied_secret_0113__';
const DENIED_MESSAGE = 'secret-derived values are unavailable to expressions';
const INPUTS = { token: CANARY, name: 'Ada' };

function workflow(nodes: string, edges: string): WorkflowDefinition {
  return parseWorkflow(`schema_version: '1.0'
workflow:
  id: secret-context-history
  inputs:
    - { name: token, type: secret, required: true }
    - { name: name, type: string, required: true }
  context:
    - { key: greeting, value: 'Hello {{inputs.name}}' }
    - { key: alias, value: '{{inputs.token}}' }
    - { key: clean, value: ready }
    - { key: transitive, value: '{{ctx.alias}}' }
    - { key: nested, value: 'wrapped({{ctx.transitive}})' }
  nodes:
${nodes}
  edges:
${edges}
`);
}

function transformWorkflow(expression: string, beforeGate = false): WorkflowDefinition {
  return workflow(
    `    - { id: start, type: input }
${beforeGate ? '    - { id: before, type: human_gate, gate_type: approval, message_template: "Review {{ctx.greeting}}" }\n' : ''}    - id: derive
      type: transform
      transform: ${JSON.stringify(expression)}
    - { id: after, type: human_gate, gate_type: approval, message_template: 'Result {{run.outputs["derive"] | json}}' }
    - { id: out, type: output }`,
    `    - { from: start, to: ${beforeGate ? 'before' : 'derive'} }
${beforeGate ? '    - { from: before, to: derive }\n' : ''}    - { from: derive, to: after }
    - { from: after, to: out }`,
  );
}

describe('secret context at native SQLite/public boundaries (ADR-0113)', () => {
  const directories: string[] = [];
  const clients: DbClient[] = [];
  const consumers: Array<{ handle: RunHandle; drained: Promise<void> }> = [];

  afterEach(async () => {
    for (const { handle } of consumers) handle.cancel();
    await Promise.all(consumers.map(({ drained }) => drained));
    await Promise.all(consumers.map(({ handle }) => handle.depart()));
    consumers.length = 0;
    for (const client of clients.splice(0)) client.sqlite.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function open(path: string, definition: WorkflowDefinition) {
    const client = createClient(path);
    clients.push(client);
    runMigrations(client.db);
    const store = createRunHistoryStore(client.db, {
      uuid: randomUUID,
      now: Date.now,
      workflow: {
        slug: definition.workflow.id,
        name: definition.workflow.id,
        definitionJson: JSON.stringify(definition),
      },
    });
    return { client, store };
  }

  async function engine(store: RunHistoryStore) {
    return await buildEngine({
      host: createCliHost(store, {
        runLeases: createRunLeasePort(store),
        checkpointer: createHistoryCheckpointer(store),
      }),
      // No adapter, keychain, environment credential or provider call is needed by these graphs.
      providers: {
        resolveProvider: () => {
          throw new Error('unexpected provider resolution in non-agent workflow');
        },
        keyFor: () => {
          throw new Error('unexpected credential access in non-agent workflow');
        },
      },
    });
  }

  async function fixture(definition: WorkflowDefinition) {
    const directory = mkdtempSync(join(tmpdir(), 'relavium-secret-context-'));
    directories.push(directory);
    const path = join(directory, 'history.db');
    const persistence = open(path, definition);
    return { ...persistence, path, engine: await engine(persistence.store) };
  }

  function consume(handle: RunHandle) {
    const events: RunEvent[] = [];
    let ready = () => {};
    const pausedOrFinished = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (
          event.type === 'run:paused' ||
          event.type === 'run:completed' ||
          event.type === 'run:failed' ||
          event.type === 'run:cancelled'
        ) {
          ready();
        }
      }
    })();
    consumers.push({ handle, drained });
    return { events, pausedOrFinished, drained };
  }

  function expectNoNewSecret(client: DbClient, events: readonly RunEvent[]) {
    const persistedEvents = client.sqlite
      .prepare('SELECT payload_json FROM run_events ORDER BY run_id, seq')
      .all();
    const steps = client.sqlite
      .prepare('SELECT output_json FROM step_executions ORDER BY run_id, node_id')
      .all();
    const runs = client.sqlite.prepare('SELECT output_json FROM runs ORDER BY id').all();
    // A negative assertion without actual public/persisted evidence would pass on a broken host.
    expect(events.length).toBeGreaterThan(0);
    expect(persistedEvents.length).toBeGreaterThan(0);
    expect(steps.length).toBeGreaterThan(0);
    expect(runs).toHaveLength(1);
    for (const evidence of [events, persistedEvents, steps, runs]) {
      expect(JSON.stringify(evidence)).not.toContain(CANARY);
      expect(JSON.stringify(evidence)).not.toContain(RESUPPLIED_CANARY);
    }
  }

  function expectExpressionDenied(events: readonly RunEvent[], nodeId = 'derive') {
    expect(
      events.find((event) => event.type === 'node:failed' && event.nodeId === nodeId),
    ).toMatchObject({
      type: 'node:failed',
      nodeId,
      error: { code: 'sandbox_error', message: DENIED_MESSAGE, retryable: false },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'sandbox_error', message: DENIED_MESSAGE, retryable: false },
    });
    expect(events.some((event) => event.type === 'run:completed')).toBe(false);
    expect(events.some((event) => event.type === 'node:completed' && event.nodeId === nodeId)).toBe(
      false,
    );
  }

  it('persists exact clean output, original authored context, and unchanged admitted-input markers', async () => {
    const definition = workflow(
      `    - { id: start, type: input }
    - id: derive
      type: transform
      transform: '({ greeting: ctx.greeting, clean: ctx.clean, keys: Object.keys(ctx) })'
    - { id: out, type: output }`,
      `    - { from: start, to: derive }
    - { from: derive, to: out }`,
    );
    const { client, engine: runtime } = await fixture(definition);
    const handle = runtime.start({ workflow: definition, inputs: INPUTS });
    const { events, drained } = consume(handle);
    await drained;
    const output = {
      greeting: 'Hello Ada',
      clean: 'ready',
      keys: ['greeting', 'alias', 'clean', 'transitive', 'nested'],
    };
    expect(events.at(-1)).toMatchObject({ type: 'run:completed', outputs: { out: output } });
    const masked = { token: { secret: true, ref: 'inputs.token' }, name: 'Ada' };
    expect(events[0]).toMatchObject({ type: 'run:started', inputs: masked });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'node:completed', nodeId: 'start', output: masked }),
    );
    expect(
      client.sqlite
        .prepare("SELECT output_json FROM step_executions WHERE node_id = 'derive'")
        .all(),
    ).toEqual([{ output_json: JSON.stringify(output) }]);
    expect(client.sqlite.prepare('SELECT output_json FROM runs').all()).toEqual([
      { output_json: JSON.stringify({ out: output }) },
    ]);
    expect(client.sqlite.prepare('SELECT workflow_definition_snapshot FROM runs').all()).toEqual([
      { workflow_definition_snapshot: JSON.stringify(definition) },
    ]);
    expectNoNewSecret(client, events);
  });

  it('keeps context analysis and native history on the admitted definition after caller mutation', async () => {
    const definition = workflow(
      `    - { id: start, type: input }
    - { id: derive, type: transform, transform: 'ctx.greeting' }
    - { id: out, type: output }`,
      `    - { from: start, to: derive }
    - { from: derive, to: out }`,
    );
    const frozenSnapshot = JSON.stringify(definition);
    const { client, engine: runtime } = await fixture(definition);
    const handle = runtime.start({ workflow: definition, inputs: INPUTS });
    const greeting = definition.workflow.context?.find((entry) => entry.key === 'greeting');
    if (greeting === undefined) throw new Error('missing authored greeting');
    greeting.value = '{{inputs.token}}';
    definition.workflow.context?.push({ key: 'later', value: '{{inputs.token}}' });
    const { events, drained } = consume(handle);
    await drained;
    expect(events.at(-1)).toMatchObject({
      type: 'run:completed',
      outputs: { out: 'Hello Ada' },
    });
    expect(
      client.sqlite
        .prepare("SELECT output_json FROM step_executions WHERE node_id = 'derive'")
        .all(),
    ).toEqual([{ output_json: JSON.stringify('Hello Ada') }]);
    expect(client.sqlite.prepare('SELECT output_json FROM runs').all()).toEqual([
      { output_json: JSON.stringify({ out: 'Hello Ada' }) },
    ]);
    expect(client.sqlite.prepare('SELECT workflow_definition_snapshot FROM runs').all()).toEqual([
      { workflow_definition_snapshot: frozenSnapshot },
    ]);
    expectNoNewSecret(client, events);
  });

  it('persists hydrated Error result fields through the actual standard executor', async () => {
    const definition = workflow(
      `    - { id: start, type: input }
    - id: derive
      type: transform
      transform: 'Object.assign(new TypeError("clean diagnostic"), {info:42})'
    - { id: out, type: output }`,
      `    - { from: start, to: derive }
    - { from: derive, to: out }`,
    );
    const { client, engine: runtime } = await fixture(definition);
    const { events, drained } = consume(runtime.start({ workflow: definition, inputs: INPUTS }));
    await drained;
    const derived = events.find(
      (event) => event.type === 'node:completed' && event.nodeId === 'derive',
    );
    expect(derived).toMatchObject({
      type: 'node:completed',
      output: {
        info: 42,
        name: 'TypeError',
        message: 'clean diagnostic',
      },
    });
    if (derived?.type !== 'node:completed') throw new Error('missing completed derivation');
    if (derived.output === null || typeof derived.output !== 'object')
      throw new Error('missing hydrated diagnostic object');
    expect(typeof Reflect.get(derived.output, 'stack')).toBe('string');
    expect(events.at(-1)).toMatchObject({
      type: 'run:completed',
      outputs: { out: derived.output },
    });
    expect(
      client.sqlite
        .prepare("SELECT output_json FROM step_executions WHERE node_id = 'derive'")
        .all(),
    ).toEqual([{ output_json: JSON.stringify(derived.output) }]);
    expect(client.sqlite.prepare('SELECT output_json FROM runs').all()).toEqual([
      { output_json: JSON.stringify({ out: derived.output }) },
    ]);
    expectNoNewSecret(client, events);
  });

  it.each([
    ['direct context', 'ctx.alias'],
    ['computed context', 'ctx[["al", "ias"].join("")]'],
    ['serialized context', 'JSON.stringify(ctx)'],
    ['transitive context', 'ctx.transitive'],
    ['nested context', '({ nested: [ctx.nested] })'],
    ['direct input', 'inputs.token'],
    ['caught access', '(() => { try { return ctx.alias; } catch { return "clean fallback"; } })()'],
    ['returned context', 'ctx'],
    ['result getter', '({ get value() { return ctx.alias; } })'],
    ['result toJSON', '({ toJSON() { return { value: ctx.alias }; } })'],
  ])('refuses %s before a downstream human can see it', async (_label, expression) => {
    const definition = transformWorkflow(expression);
    const { client, engine: runtime } = await fixture(definition);
    const { events, drained } = consume(runtime.start({ workflow: definition, inputs: INPUTS }));
    await drained;
    expectExpressionDenied(events);
    expect(events.some((event) => event.type === 'human_gate:paused')).toBe(false);
    expect(
      client.sqlite
        .prepare("SELECT output_json FROM step_executions WHERE node_id = 'derive'")
        .all(),
    ).toEqual([{ output_json: null }]);
    expect(client.sqlite.prepare('SELECT output_json FROM runs').all()).toEqual([
      {
        output_json: JSON.stringify({
          start: { token: { secret: true, ref: 'inputs.token' }, name: 'Ada' },
        }),
      },
    ]);
    expectNoNewSecret(client, events);
  });

  it('refuses context in a custom merge without persisting the derived value', async () => {
    const definition = workflow(
      `    - { id: start, type: input }
    - { id: left, type: transform, transform: '"left"' }
    - { id: right, type: transform, transform: '"right"' }
    - { id: derive, type: merge, merge_strategy: custom, merge_fn: '({ branches, leaked: ctx.transitive })' }
    - { id: out, type: output }`,
      `    - { from: start, to: left }
    - { from: start, to: right }
    - { from: left, to: derive }
    - { from: right, to: derive }
    - { from: derive, to: out }`,
    );
    const { client, engine: runtime } = await fixture(definition);
    const { events, drained } = consume(runtime.start({ workflow: definition, inputs: INPUTS }));
    await drained;
    expectExpressionDenied(events);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'node:completed', nodeId: 'left', output: 'left' }),
    );
    expectNoNewSecret(client, events);
  });

  it('refuses a context condition oracle before either branch runs', async () => {
    const definition = workflow(
      `    - { id: start, type: input }
    - id: derive
      type: condition
      expression: 'ctx.alias.length > 0'
      branches: [{ when: true, target_node: yes }]
      default: no
    - { id: yes, type: transform, transform: '"selected-yes"' }
    - { id: no, type: transform, transform: '"selected-no"' }
    - { id: out, type: output }`,
      `    - { from: start, to: derive }
    - { from: yes, to: out }
    - { from: no, to: out }`,
    );
    const { client, engine: runtime } = await fixture(definition);
    const { events, drained } = consume(runtime.start({ workflow: definition, inputs: INPUTS }));
    await drained;
    expectExpressionDenied(events);
    expect(
      events.some((event) => event.type === 'node:started' && ['yes', 'no'].includes(event.nodeId)),
    ).toBe(false);
    expectNoNewSecret(client, events);
  });

  it.each(['{{inputs.token | default("public")}}', '{{ctx.transitive | json}}'])(
    'runtime-refuses hand-built human template %s before publishing a gate',
    async (template) => {
      const parsed = workflow(
        `    - { id: start, type: input }
    - { id: gate, type: human_gate, gate_type: approval, message_template: 'Review {{ctx.greeting}}' }
    - { id: out, type: output }`,
        `    - { from: start, to: gate }
    - { from: gate, to: out }`,
      );
      // Preserve the typed workflow while bypassing parse-time text taint refusal intentionally.
      const definition: WorkflowDefinition = {
        ...parsed,
        workflow: {
          ...parsed.workflow,
          nodes: parsed.workflow.nodes.map((node) =>
            node.type === 'human_gate' ? { ...node, message_template: template } : node,
          ),
        },
      };
      const { client, engine: runtime } = await fixture(definition);
      const { events, drained } = consume(runtime.start({ workflow: definition, inputs: INPUTS }));
      await drained;
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'validation', retryable: false },
      });
      expect(events.some((event) => event.type === 'human_gate:paused')).toBe(false);
      expectNoNewSecret(client, events);
    },
  );

  it('publishes the exact clean downstream gate message and completes after same-process approval', async () => {
    const definition = transformWorkflow('ctx.greeting');
    const { client, engine: runtime } = await fixture(definition);
    const handle = runtime.start({ workflow: definition, inputs: INPUTS });
    const { events, pausedOrFinished, drained } = consume(handle);
    await pausedOrFinished;
    const gate = events.find((event) => event.type === 'human_gate:paused');
    expect(gate).toMatchObject({ message: 'Result "Hello Ada"' });
    if (gate?.type !== 'human_gate:paused')
      throw new Error('clean workflow did not reach its gate');
    await runtime.resume(handle.runId, gate.gateId, { decision: 'approved', decidedBy: 'offline' });
    await drained;
    expect(events.at(-1)).toMatchObject({ type: 'run:completed' });
    expectNoNewSecret(client, events);
  });

  it.each([false, true])(
    'retains denied context after a human gate (reopened file and fresh engine=%s)',
    async (fresh) => {
      const definition = transformWorkflow('ctx.transitive', true);
      const original = await fixture(definition);
      const handle = original.engine.start({ workflow: definition, inputs: INPUTS });
      const first = consume(handle);
      await first.pausedOrFinished;
      const gate = first.events.find((event) => event.type === 'human_gate:paused');
      expect(gate).toMatchObject({ nodeId: 'before', message: 'Review Hello Ada' });
      if (gate?.type !== 'human_gate:paused')
        throw new Error('workflow did not reach its first gate');
      let activeClient = original.client;
      let events = first.events;
      if (fresh) {
        expect((await handle.depart()).kind).toBe('detached');
        await first.drained;
        original.client.sqlite.close();
        clients.splice(clients.indexOf(original.client), 1);
        const reopened = open(original.path, definition);
        activeClient = reopened.client;
        const runtime = await engine(reopened.store);
        const resumed = await runtime.resumeFromCheckpoint({
          runId: handle.runId,
          workflow: definition,
          inputs: { token: RESUPPLIED_CANARY },
          gateId: gate.gateId,
          decision: { decision: 'approved', decidedBy: 'offline' },
        });
        const second = consume(resumed);
        await second.drained;
        events = [...first.events, ...second.events];
      } else {
        await original.engine.resume(handle.runId, gate.gateId, {
          decision: 'approved',
          decidedBy: 'offline',
        });
        await first.drained;
      }
      expectExpressionDenied(events);
      expect(events.filter((event) => event.type === 'human_gate:paused')).toHaveLength(1);
      expectNoNewSecret(activeClient, events);
    },
  );
});
