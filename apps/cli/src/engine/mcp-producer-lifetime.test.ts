import {
  BUILTIN_TOOLS,
  createAgentNodeExecutor,
  createInMemoryHost,
  createInMemoryEffectJournalStore,
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
  type HopResponse,
} from '@relavium/db';
import { openHttpConnection, startMcpClient } from '@relavium/mcp';
import { RUN_LEASE_HEARTBEAT_MS, type RunEvent } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { createMcpFetch } from './mcp-fetch.js';

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
  expect.fail('MCP lifetime did not settle');
}
function envelope(body: string | undefined): {
  readonly method: string;
  readonly id?: string | number;
} {
  const value: unknown = JSON.parse(body ?? '{}');
  if (
    typeof value !== 'object' ||
    value === null ||
    !('method' in value) ||
    typeof value.method !== 'string'
  )
    throw new Error('missing offline SDK envelope');
  const id = 'id' in value ? value.id : undefined;
  return {
    method: value.method,
    ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
  };
}
function hop(status: number, text = ''): HopResponse {
  return {
    status,
    location: undefined,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
      'mcp-session-id': 'offline-session',
    },
    body: (async function* () {
      await Promise.resolve();
      if (text !== '') yield new TextEncoder().encode(text);
    })(),
    dispose: () => {},
  };
}

for (const store of ['reference', 'native'] as const)
  for (const path of ['discovered', 'builtin'] as const)
    for (const held of ['dns', 'body', 'native close'] as const)
      it(`public ${store} ${path} MCP ${held} retains the exact run fence after terminal`, async () => {
        vi.useFakeTimers();
        const dns = latch<readonly string[]>();
        const body = latch<void>();
        const closed = latch<void>();
        const entered = latch<void>();
        let armed = false;
        let firstDns = true;
        let calls = 0;
        let providerCalls = 0;
        const deps: EgressDeps = {
          resolveHost: () => {
            if (armed && firstDns && held === 'dns') {
              firstDns = false;
              entered.resolve();
              return dns.promise;
            }
            return Promise.resolve(['93.184.216.34']);
          },
          openConnection: (request, _signal, work) => {
            if (request.method === 'GET') return Promise.resolve(hop(405));
            const message = envelope(request.body);
            if (
              message.method === 'notifications/initialized' ||
              message.method === 'notifications/cancelled'
            )
              return Promise.resolve(hop(202));
            let result: unknown;
            if (message.method === 'initialize')
              result = {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'offline', version: '1' },
              };
            else if (message.method === 'tools/list')
              result = {
                tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
              };
            else if (message.method === 'tools/call') {
              calls += 1;
              void work?.retainWork?.(() => closed.promise);
              const response = hop(200);
              return Promise.resolve({
                ...response,
                headers: { 'content-type': 'application/json' },
                body: (async function* () {
                  entered.resolve();
                  if (held === 'body') await body.promise;
                  yield new TextEncoder().encode(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: message.id,
                      result: { content: [{ type: 'text', text: 'late private MCP result' }] },
                    }),
                  );
                })(),
              });
            } else throw new Error('unexpected offline SDK request');
            return Promise.resolve(
              hop(200, JSON.stringify({ jsonrpc: '2.0', id: message.id, result })),
            );
          },
        };
        const mcp = await startMcpClient([
          {
            id: 'remote',
            open: (signal) =>
              openHttpConnection(
                'remote',
                {
                  url: 'https://mcp.example/rpc',
                  fetch: createMcpFetch({ deps }),
                },
                signal,
              ),
          },
        ]);
        const builtin = BUILTIN_TOOLS.find((tool) => tool.id === 'mcp_call');
        if (builtin === undefined) throw new Error('missing shipped MCP tool');
        const selected = path === 'builtin' ? builtin : mcp.toolDefs[0];
        if (selected === undefined) throw new Error('missing discovered MCP tool');
        const registry = createToolRegistry({ tools: [selected], host: { mcp: mcp.capability } });
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
            providerCalls += 1;
            await Promise.resolve();
            if (providerCalls === 1) {
              yield { type: 'tool_call_start', id: 'mcp-call', name: selected.id };
              yield {
                type: 'tool_call_delta',
                id: 'mcp-call',
                argsJsonDelta: JSON.stringify(
                  path === 'builtin' ? { server: 'remote', tool: 'echo', args: {} } : {},
                ),
              };
              yield { type: 'tool_call_end', id: 'mcp-call' };
              yield {
                type: 'stop',
                stopReason: 'tool_use',
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            } else {
              yield { type: 'text_delta', text: 'done' };
              yield {
                type: 'stop',
                stopReason: 'stop',
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            }
          },
        };
        const definition = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'mcp-lifetime',
              agents: [
                {
                  id: 'agent',
                  provider: 'openai',
                  model: 'gpt-4o',
                  system_prompt: 'offline',
                  tools: [selected.id],
                },
              ],
              nodes: [
                {
                  id: 'work',
                  type: 'agent',
                  agent_ref: 'agent',
                  prompt_template: 'offline',
                  timeout_ms: 3000,
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
        const journal = createInMemoryEffectJournalStore();
        const engine = new WorkflowEngine({
          host,
          effectJournal: (correlation) => journal.for(correlation),
          effectResume: journal.resume,
          executor: createAgentNodeExecutor({
            resolveProvider: () => provider,
            registry,
            tools: [selected],
            keyFor: () => 'offline-placeholder',
            sleep: () => Promise.resolve(),
          }),
        });
        armed = true;
        const handle = engine.start({ workflow: definition });
        const events: RunEvent[] = [];
        const drained = (async () => {
          for await (const event of handle.events) events.push(event);
        })();
        try {
          await Promise.race([
            entered.promise,
            drained.then(() => expect.fail('terminal before MCP entry')),
          ]);
          // The reference host owns explicit deadline handles, independent of SDK timers.
          if (held !== 'native close') host.fireDeadlines();
          await drained;
          expect(events.at(-1)?.type).toBe(
            held === 'native close' ? 'run:completed' : 'run:failed',
          );
          const fence = await host.runLeases.read(handle.runId);
          if (fence === undefined)
            expect.fail('MCP raw work released its run fence before acknowledgement');
          expect(host.livenessCount()).toBe(1);
          const terminalEvents = JSON.stringify(events);
          const durableBefore = native?.loadRunEventLogForReplay(handle.runId);
          vi.setSystemTime(Date.now() + RUN_LEASE_HEARTBEAT_MS);
          host.fireLiveness();
          await until(async () => {
            const current = await host.runLeases.read(handle.runId);
            return current !== undefined && current.expiresAt > fence.expiresAt;
          });
          const renewed = await host.runLeases.read(handle.runId);
          expect(renewed?.ownerId).toBe(fence.ownerId);
          expect(renewed?.generation).toBe(fence.generation);
          expect(renewed?.expiresAt).toBeGreaterThan(fence.expiresAt);
          dns.resolve(['93.184.216.34']);
          body.resolve();
          if (held !== 'dns') {
            for (let turn = 0; turn < 30; turn++) await Promise.resolve();
            expect((await host.runLeases.read(handle.runId))?.generation).toBe(fence.generation);
            expect(host.livenessCount()).toBe(1);
          }
          closed.resolve();
          await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
          expect(host.livenessCount()).toBe(0);
          expect(calls).toBe(held === 'dns' ? 0 : 1);
          expect(providerCalls).toBe(held === 'native close' ? 2 : 1);
          expect(JSON.stringify(events)).toBe(terminalEvents);
          if (native !== undefined)
            expect(native.loadRunEventLogForReplay(handle.runId)).toEqual(durableBefore);
        } finally {
          dns.resolve(['93.184.216.34']);
          body.resolve();
          closed.resolve();
          handle.cancel();
          await vi.runAllTimersAsync();
          await drained;
          await until(async () => (await host.runLeases.read(handle.runId)) === undefined);
          await mcp.close();
          client?.sqlite.close();
          vi.useRealTimers();
        }
      });
