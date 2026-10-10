import { expect, it, vi } from 'vitest';
import {
  createAgentNodeExecutor,
  createInMemoryHost,
  InMemoryRunStore,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import { createCustomOpenAiProvider } from '@relavium/llm';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type EgressDeps,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { createValidatedFetch } from './validated-fetch.js';

function latch<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 1000; n += 1) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('provider lifetime did not reach expected state');
}
const sse =
  'data: ' +
  JSON.stringify({
    id: 'c',
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
  }) +
  '\n\n' +
  'data: ' +
  JSON.stringify({
    id: 'c',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }) +
  '\n\ndata: [DONE]\n\n';

for (const storage of ['reference', 'native'] as const)
  for (const held of ['dns', 'body', 'native close'] as const)
    it(`public ${storage} engine and actual SDK keep ${held} owned after their terminal`, async () => {
      vi.useFakeTimers();
      const dns = latch<readonly string[]>();
      const body = latch<void>();
      const close = latch<void>();
      const entered = latch<void>();
      let sockets = 0;
      let disposed = 0;
      const deps: EgressDeps = {
        resolveHost: () => {
          if (held === 'dns') {
            entered.resolve();
            return dns.promise;
          }
          return Promise.resolve(['93.184.216.34']);
        },
        openConnection: (_req, _signal, work) => {
          sockets += 1;
          void work?.retainWork?.(() => close.promise);
          return Promise.resolve({
            status: 200,
            location: undefined,
            headers: { 'content-type': 'text/event-stream' },
            body: (async function* () {
              if (held === 'body') {
                entered.resolve();
                await body.promise;
              }
              yield new TextEncoder().encode(sse);
            })(),
            dispose: () => {
              disposed += 1;
            },
          });
        },
      };
      const provider = createCustomOpenAiProvider({
        providerId: 'openai',
        baseURL: 'https://fixture.example/v1',
        fetch: createValidatedFetch(deps),
      });
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'provider-lifetime',
            agents: [{ id: 'a', provider: 'openai', model: 'gpt-4o', system_prompt: 'offline' }],
            nodes: [
              {
                id: 'work',
                type: 'agent',
                agent_ref: 'a',
                prompt_template: 'fixture',
                retry: { max: 1, backoff: 'linear' },
              },
            ],
            edges: [],
          },
        }),
      );
      const client = storage === 'native' ? createClient(':memory:') : undefined;
      if (client !== undefined) runMigrations(client.db);
      let id = 0;
      const native =
        client === undefined
          ? undefined
          : createRunHistoryStore(client.db, {
              uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
              now: () => Date.now(),
              workflow: {
                slug: workflow.workflow.id,
                name: workflow.workflow.id,
                definitionJson: JSON.stringify(workflow),
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
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('unexpected tool')),
          },
          tools: [],
          keyFor: () => 'fixture-key',
          sleep: () => Promise.resolve(),
          attemptTimeoutMs: 5,
          newAbortController: () => new AbortController(),
          setTimer: (ms, fire) => {
            const timer = setTimeout(fire, ms);
            return () => clearTimeout(timer);
          },
        }),
      });
      const handle = engine.start({ workflow });
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      try {
        if (held !== 'native close') {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(5);
        }
        await drained;
        expect(events.at(-1)?.type).toBe(held === 'native close' ? 'run:completed' : 'run:failed');
        const fence = await host.runLeases.read(handle.runId);
        expect(fence).toBeDefined();
        expect(host.livenessCount()).toBe(1);
        const before = JSON.stringify(events);
        const durable = native?.loadRunEventLogForReplay(handle.runId);
        dns.resolve(['93.184.216.34']);
        body.resolve();
        if (held !== 'dns') {
          for (let n = 0; n < 20; n += 1) await Promise.resolve();
          expect(await host.runLeases.read(handle.runId)).toEqual(fence);
          expect(host.livenessCount()).toBe(1);
        }
        close.resolve();
        await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
        expect(sockets).toBe(held === 'dns' ? 0 : 1);
        expect(disposed).toBe(held === 'dns' ? 0 : 1);
        expect(host.livenessCount()).toBe(0);
        expect(JSON.stringify(events)).toBe(before);
        if (native !== undefined)
          expect(native.loadRunEventLogForReplay(handle.runId)).toEqual(durable);
      } finally {
        dns.resolve(['93.184.216.34']);
        body.resolve();
        close.resolve();
        handle.cancel();
        await vi.runAllTimersAsync();
        await drained;
        await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
        client?.sqlite.close();
        vi.useRealTimers();
      }
    });
