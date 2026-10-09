import {
  BUILTIN_TOOLS,
  createAgentNodeExecutor,
  createInMemoryHost,
  InMemoryRunStore,
  createToolRegistry,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type EgressDeps,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { createNodeEgressCapability } from './tool-host/egress.js';

function latch<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('HTTP lifetime did not settle');
}

for (const store of ['reference', 'native'] as const)
  for (const held of ['dns', 'body'] as const)
    it(`shipping ${store} agent HTTP ${held} stays owned after bounded failure without late dispatch or delivery`, async () => {
      vi.useFakeTimers();
      const dns = latch<readonly string[]>();
      const body = latch<void>();
      const entered = latch<void>();
      let opens = 0;
      let disposed = 0;
      let providerCalls = 0;
      const deps: EgressDeps = {
        resolveHost: () => {
          if (held === 'dns') {
            entered.resolve();
            return dns.promise;
          }
          return Promise.resolve(['203.0.113.10']);
        },
        openConnection: () => {
          opens++;
          return Promise.resolve({
            status: 200,
            location: undefined,
            body: (async function* () {
              if (held === 'body') {
                entered.resolve();
                await body.promise;
              }
              yield new TextEncoder().encode('late private response');
            })(),
            dispose: () => {
              disposed++;
            },
          });
        },
      };
      const http = BUILTIN_TOOLS.find((tool) => tool.id === 'http_request');
      if (http === undefined) throw new Error('missing shipped HTTP tool');
      const registry = createToolRegistry({
        tools: [http],
        host: { egress: createNodeEgressCapability({ deps, timeoutMs: 20 }) },
      });
      const provider: LlmProvider = {
        id: 'openai',
        supports: {
          tools: true,
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
          throw new Error('unexpected generation');
        },
        stream: async function* (): AsyncGenerator<StreamChunk> {
          providerCalls++;
          await Promise.resolve();
          yield { type: 'tool_call_start', id: 'http-call', name: 'http_request' };
          yield {
            type: 'tool_call_delta',
            id: 'http-call',
            argsJsonDelta: '{"url":"https://api.example/x"}',
          };
          yield { type: 'tool_call_end', id: 'http-call' };
          yield {
            type: 'stop',
            stopReason: 'tool_use',
            usage: { inputTokens: 3, outputTokens: 2 },
          };
        },
      };
      const definition = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'http-lifetime',
            tools: { allowedDomains: ['api.example'] },
            agents: [
              {
                id: 'agent',
                provider: 'openai',
                model: 'gpt-4o',
                system_prompt: 's',
                tools: ['http_request'],
              },
            ],
            nodes: [
              {
                id: 'work',
                type: 'agent',
                agent_ref: 'agent',
                prompt_template: 'offline',
                retry: { max: 1, backoff: 'linear' },
              },
            ],
            edges: [],
          },
        }),
      );
      const client = store === 'native' ? createClient(':memory:') : undefined;
      if (client !== undefined) runMigrations(client.db);
      let next = 0;
      const native =
        client === undefined
          ? undefined
          : createRunHistoryStore(client.db, {
              uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
              now: () => Date.now(),
              workflow: {
                slug: definition.workflow.id,
                name: definition.workflow.id,
                definitionJson: JSON.stringify(definition),
              },
            });
      const host = createInMemoryHost({
        store: native ?? new InMemoryRunStore(),
        ...(native === undefined ? {} : { runLeases: createRunLeasePort(native) }),
      });
      const engine = new WorkflowEngine({
        host,
        executor: createAgentNodeExecutor({
          resolveProvider: () => provider,
          registry,
          tools: [http],
          keyFor: () => 'offline-placeholder',
          sleep: () => Promise.resolve(),
        }),
      });
      const handle = engine.start({ workflow: definition });
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      try {
        await entered.promise;
        const fence = await host.runLeases.read(handle.runId);
        expect(fence).toBeDefined();
        await vi.advanceTimersByTimeAsync(20);
        await drained;
        expect(events.at(-1)?.type).toBe('run:failed');
        expect(await host.runLeases.read(handle.runId)).toEqual(fence);
        expect(host.livenessCount()).toBe(1);
        const terminalEvents = JSON.stringify(events);
        const durableBefore = native?.loadRunEventLogForReplay(handle.runId);
        expect(providerCalls).toBe(1);
        expect(opens).toBe(held === 'dns' ? 0 : 1);
        dns.resolve(['203.0.113.10']);
        body.resolve();
        await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
        expect(host.livenessCount()).toBe(0);
        expect(providerCalls).toBe(1);
        expect(opens).toBe(held === 'dns' ? 0 : 1);
        expect(disposed).toBe(held === 'dns' ? 0 : 1);
        expect(JSON.stringify(events)).toBe(terminalEvents);
        if (native !== undefined)
          expect(native.loadRunEventLogForReplay(handle.runId)).toEqual(durableBefore);
        expect(
          events.some((event) => JSON.stringify(event).includes('late private response')),
        ).toBe(false);
      } finally {
        dns.resolve(['203.0.113.10']);
        body.resolve();
        handle.cancel();
        await vi.runAllTimersAsync();
        await drained;
        await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
        client?.sqlite.close();
        vi.useRealTimers();
      }
    });
