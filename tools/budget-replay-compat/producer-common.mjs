import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as core from '@relavium/core';

export const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
export const epochMs = Date.parse('2026-10-03T00:00:00.000Z');
export const model = 'offline-budget';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const record = (relative, object) =>
  writeFileSync(resolve(root, relative), `${JSON.stringify(object, null, 2)}\n`);
export function deferred() {
  let resolveValue;
  const promise = new Promise((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}
export const workflow = core.parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'actual-budget-compat',
      budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval', strict_cost_cap: true },
      agents: [{ id: 'a', provider: 'openai', model, system_prompt: 's' }],
      nodes: [
        { id: 'agent', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 },
      ],
      edges: [],
    },
  }),
);

export function fixture(
  label,
  { initial = [], holdDecisionCompanion = false, suppressCapture = false } = {},
) {
  const store = new core.InMemoryRunStore();
  const base = core.createInMemoryHost({ store, baseEpochMs: epochMs });
  const counters = {
    providerResolve: 0,
    keyResolve: 0,
    providerCall: 0,
    fetch: 0,
    toolDispatch: 0,
  };
  const rows = initial.map((row) => JSON.stringify(row));
  const captures = [];
  const persisted = [];
  const held = deferred();
  const release = deferred();
  const paused = deferred();
  const publicEvents = [];
  const price = {
    provider: 'openai',
    nativeId: model,
    displayName: model,
    contextWindowTokens: 100000,
    maxOutputTokens: 1000,
    inputPerMtokMicrocents: 1000000,
    outputPerMtokMicrocents: 1000000,
    cachedInputPerMtokMicrocents: 1000000,
  };
  const resolvePrice = new Map([[model, price]]);
  const provider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => {
      counters.providerCall += 1;
      throw new Error('Offline compatibility provider call forbidden');
    },
    stream: () => {
      counters.providerCall += 1;
      throw new Error('Offline compatibility provider call forbidden');
    },
  };
  const executor = core.createAgentNodeExecutor({
    resolveProvider: () => {
      counters.providerResolve += 1;
      return provider;
    },
    keyFor: () => {
      counters.keyResolve += 1;
      throw new Error('Offline compatibility key resolution forbidden');
    },
    sleep: () => Promise.resolve(),
    tools: [],
    resolvePrice,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => {
        counters.toolDispatch += 1;
        throw new Error('Offline tool dispatch forbidden');
      },
    },
  });
  const host = {
    ...base,
    store: {
      resolveWorkflowId: (slug) => store.resolveWorkflowId(slug),
      readWorkflowSnapshot: (id) => store.readWorkflowSnapshot(id),
      listInterruptedRuns: () => store.listInterruptedRuns(),
      persistEvent: async (...args) => {
        // Exactly the event handed by the real engine to its durable host port. No schema rewrite.
        const serialized = JSON.stringify(args[0]);
        await store.persistEvent(...args);
        rows.push(serialized);
        persisted.push({
          type: args[0].type,
          sequenceNumber: args[0].sequenceNumber,
          sha256: digest(serialized),
        });
        const event = args[0];
        const cut =
          event.type === 'budget:authorization'
            ? `authority-${event.authorization.state}`
            : event.type === 'budget:paused'
              ? 'budget-paused-companion'
              : event.type === 'human_gate:paused'
                ? 'human-gate-paused-companion'
                : event.type === 'human_gate:resumed'
                  ? 'human-gate-resumed-companion'
                  : event.type === 'run:paused'
                    ? 'aggregate-paused'
                    : undefined;
        if (!suppressCapture && cut) {
          const relative = `raw/${label}-${cut}.ndjson`;
          const bytes = `${rows.join('\n')}\n`;
          writeFileSync(resolve(root, relative), bytes);
          captures.push({
            label,
            cut,
            path: relative,
            sha256: digest(bytes),
            bytes: Buffer.byteLength(bytes),
            rows: rows.length,
            cutSequence: event.sequenceNumber,
            cutType: event.type,
            runId: event.runId,
            nodeId: event.nodeId,
            gateId: event.gateId,
            origin:
              'Actual engine durable persistEvent arguments, serialized before in-memory store acknowledgement; prefix contains only successfully stored rows.',
          });
        }
        if (event.type === 'human_gate:resumed' && holdDecisionCompanion) {
          held.resolve();
          await release.promise;
        }
      },
    },
  };
  const engine = new core.WorkflowEngine({ host, executor, resolvePrice });
  const drain = (handle) =>
    (async () => {
      for await (const event of handle.events) {
        publicEvents.push(event);
        if (event.type === 'run:paused') paused.resolve();
      }
    })();
  const finish = async () => {
    for (
      let i = 0;
      i < 8 && (await host.runLeases.read(publicEvents[0]?.runId ?? initial[0]?.runId));
      i += 1
    )
      await new Promise((done) => setImmediate(done));
    assert.equal(host.armedCount(), 0);
    assert.equal(host.livenessCount(), 0);
    assert.equal(host.deadlineCount(), 0);
    assert.equal(counters.keyResolve, 0);
    assert.equal(counters.providerCall, 0);
    assert.equal(counters.toolDispatch, 0);
    record(`results/${label}-origin.json`, {
      label,
      producer: process.env.COMPAT_SOURCE,
      sourceManifest:
        process.env.COMPAT_SOURCE === 'frozen'
          ? 'frozen/source-manifest.json'
          : 'producer-source-manifest.json',
      captures,
      persisted,
      counters,
      publicEvents,
      workersClosed: true,
      timers: {
        work: host.armedCount(),
        liveness: host.livenessCount(),
        deadline: host.deadlineCount(),
      },
    });
  };
  return {
    store,
    host,
    engine,
    rows,
    captures,
    held,
    release,
    paused,
    publicEvents,
    drain,
    finish,
    counters,
  };
}
