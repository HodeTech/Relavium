import { expect, it } from 'vitest';
import type { ContentPart, RunEvent } from '@relavium/shared';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createInMemoryHost } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import type { NodeExecutor } from './node-executor.js';

const image: Extract<ContentPart, { type: 'media' }> = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'base64', data: 'AQ==' },
};
for (const rate of [undefined, 0, 17])
  it(`separate native media preserves missing-price count across durable pause and resume (rate=${rate})`, async () => {
    let calls = 0;
    const provider: LlmProvider = {
      id: 'openai',
      supports: {
        tools: false,
        streaming: false,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: {
          input: { image: false, audio: false, video: false, document: false },
          outputCombinations: [['image']],
        },
      },
      generate: () => Promise.reject(new Error('unexpected token route')),
      stream: () => {
        throw new Error('unexpected stream');
      },
      generateMedia: () => {
        calls++;
        return Promise.resolve({ media: image, raw: {} });
      },
    };
    const pricing: ModelPricing = {
      provider: 'openai',
      nativeId: 'native-review',
      displayName: 'native',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      inputPerMtokMicrocents: 0,
      outputPerMtokMicrocents: 0,
      cachedInputPerMtokMicrocents: 0,
      ...(rate === undefined ? {} : { mediaOutputRates: { image: rate } }),
    };
    const host = createInMemoryHost({
      mediaStore: {
        put: () => Promise.resolve(`media://sha256-${'1'.repeat(64)}`),
        get: () => Promise.resolve(new Uint8Array([1])),
        readRange: () => Promise.reject(new Error('unexpected range')),
        resolveForEgress: () => Promise.reject(new Error('unexpected egress')),
      },
    });
    const runner = createAgentNodeExecutor({
      resolveProvider: () => provider,
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool')),
      },
      resolveMediaSurface: () => 'generative',
      resolvePrice: new Map([['native-review', pricing]]),
    });
    const executor: NodeExecutor = {
      execute: (ctx) =>
        ctx.vertex.type === 'agent'
          ? runner.execute(ctx)
          : Promise.resolve(
              ctx.vertex.type === 'human_in_the_loop'
                ? { kind: 'paused', gate: { gateType: 'approval', message: 'review' } }
                : { kind: 'completed', output: '' },
            ),
    };
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'native-review',
          agents: [
            { id: 'a', provider: 'openai', model: 'native-review', system_prompt: 'offline' },
          ],
          nodes: [
            {
              id: 'media',
              type: 'agent',
              agent_ref: 'a',
              prompt_template: 'image',
              output_modalities: ['image'],
            },
            { id: 'gate', type: 'human_gate', gate_type: 'approval' },
            { id: 'out', type: 'output' },
          ],
          edges: [
            { from: 'media', to: 'gate' },
            { from: 'gate', to: 'out' },
          ],
        },
      }),
    );
    const handle = new WorkflowEngine({ host, executor }).start({ workflow });
    const events: RunEvent[] = [];
    let paused!: () => void;
    const pause = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused') paused();
      }
    })();
    await Promise.race([
      pause,
      drained.then(() => {
        throw new Error(JSON.stringify(events.at(-1)));
      }),
    ]);
    expect((await handle.depart()).kind).toBe('detached');
    await drained;
    const cp = await host.checkpointer.load(handle.runId);
    expect(cp?.usageCoverage?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(cp?.cumulativeUnpricedCalls).toBe(rate === undefined ? 1 : 0);
    expect(cp?.cumulativeCostMicrocents).toBe(rate ?? 0);
    expect(
      events.filter(
        (event) => event.type === 'cost:usage_pending' || event.type === 'cost:attempt_settled',
      ),
    ).toEqual([]);
    const gateId = cp?.pendingGates[0]?.gateId;
    if (gateId === undefined) throw new Error('missing gate');
    const resumed = await new WorkflowEngine({ host, executor }).resumeFromCheckpoint({
      runId: handle.runId,
      workflow,
      gateId,
      decision: { decision: 'approved', decidedBy: 'test' },
    });
    const after: RunEvent[] = [];
    for await (const event of resumed.events) after.push(event);
    expect(after.at(-1)).toMatchObject({
      type: 'run:completed',
      cumulativeUnpricedCalls: rate === undefined ? 1 : 0,
      totalCostMicrocents: rate ?? 0,
    });
    expect((await resumed.depart()).kind).toBe('closed');
    expect(calls).toBe(1);
  });
