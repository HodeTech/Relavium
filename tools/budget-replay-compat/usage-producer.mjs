import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as core from '@relavium/core';
import { root, epochMs, record, digest, deferred } from './producer-common.mjs';

export async function produceUsagePrefixes() {
  const cases = [];
  let localFixtureCalls = 0;
  for (const ordinaryGate of [false, true]) {
    const label = ordinaryGate ? 'usage-ordinary-gate' : 'usage-invocation';
    const workflow = core.parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: label,
          ...(ordinaryGate
            ? {}
            : {
                agents: [
                  { id: 'a', provider: 'openai', model: 'offline-usage', system_prompt: 's' },
                ],
              }),
          nodes: ordinaryGate
            ? [
                {
                  id: 'gate',
                  type: 'human_gate',
                  gate_type: 'approval',
                  message_template: 'offline',
                },
                { id: 'out', type: 'output' },
              ]
            : [
                {
                  id: 'agent',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'offline',
                  max_tokens: 64,
                },
              ],
          edges: ordinaryGate ? [{ from: 'gate', to: 'out' }] : [],
        },
      }),
    );
    const workflowPath = `raw/${label}-workflow.json`;
    record(workflowPath, workflow);
    const store = new core.InMemoryRunStore();
    const base = core.createInMemoryHost({ store, baseEpochMs: epochMs });
    const lines = [];
    const host = {
      ...base,
      store: {
        ...base.store,
        resolveWorkflowId: (slug) => store.resolveWorkflowId(slug),
        readWorkflowSnapshot: (id) => store.readWorkflowSnapshot(id),
        listInterruptedRuns: () => store.listInterruptedRuns(),
        persistEvent: async (...args) => {
          await store.persistEvent(...args);
          const event = args[0];
          lines.push(JSON.stringify(event));
          const cut = ordinaryGate
            ? event.type === 'run:paused'
              ? 'ordinary-gate-paused'
              : undefined
            : {
                'cost:coverage_started': 'coverage-started',
                'cost:usage_pending': 'usage-pending',
                'cost:usage_disposition': 'usage-disposition',
              }[event.type];
          if (cut) {
            const bytes = `${lines.join('\n')}\n`,
              path = `raw/${label}-${cut}.ndjson`;
            writeFileSync(resolve(root, path), bytes);
            cases.push({
              label,
              cut,
              path,
              sha256: digest(bytes),
              bytes: Buffer.byteLength(bytes),
              rows: lines.length,
              cutSequence: event.sequenceNumber,
              cutType: event.type,
              runId: event.runId,
              gateId: event.gateId ?? 'offline-usage-gate',
              workflowPath,
              origin:
                'Actual current engine durable persistEvent arguments after store acknowledgement.',
              producerMode: 'new-usage-engine',
            });
          }
        },
      },
    };
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
        throw new Error('unused offline generate');
      },
      stream: async function* () {
        localFixtureCalls += 1;
        yield { type: 'text_delta', text: 'offline' };
        yield {
          type: 'stop',
          stopReason: 'stop',
          usage: { kind: 'missing', reason: 'not_reported' },
        };
      },
    };
    const executor = ordinaryGate
      ? core.createDispatchingNodeExecutor({
          human_in_the_loop: core.createHumanGateNodeExecutor(),
          output: core.createOutputNodeExecutor(),
        })
      : core.createAgentNodeExecutor({
          resolveProvider: () => provider,
          keyFor: () => 'offline-fixture',
          sleep: () => Promise.resolve(),
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => {
              throw new Error('offline tool forbidden');
            },
          },
        });
    const engine = new core.WorkflowEngine({ host, executor });
    const handle = engine.start({ workflow });
    const paused = deferred();
    const drained = (async () => {
      for await (const event of handle.events) if (event.type === 'run:paused') paused.resolve();
    })();
    if (ordinaryGate) {
      await paused.promise;
      handle.cancel();
    }
    await drained;
    const events = store.eventsFor(handle.runId);
    assert.equal(events.filter((event) => event.type === 'cost:coverage_started').length, 1);
    if (ordinaryGate)
      assert.equal(
        events.some((event) => event.type === 'cost:usage_pending'),
        false,
      );
    else {
      assert.equal(events.filter((event) => event.type === 'cost:usage_pending').length, 1);
      assert.equal(events.filter((event) => event.type === 'cost:usage_disposition').length, 1);
    }
  }
  assert.equal(localFixtureCalls, 1);
  assert.equal(cases.length, 4);
  return { cases, localFixtureCalls };
}
