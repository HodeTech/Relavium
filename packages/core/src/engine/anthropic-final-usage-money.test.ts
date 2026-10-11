import { it, expect } from 'vitest';
import {
  createClient,
  runMigrations,
  createRunHistoryStore,
  createRunLeasePort,
} from '../../../db/src/index.js';
import {
  WorkflowEngine,
  createInMemoryHost,
  createAgentNodeExecutor,
  parseWorkflow,
} from '../index.js';
import { createAnthropicAdapter } from '@relavium/llm/adapters';
import { UsageCoverageFold, type RunEvent } from '@relavium/shared';
for (const startOutput of [0, 2])
  for (const final of ['omitted', 'empty', 'input-only'] as const) scenario(startOutput, final);
scenario(0, 'explicit-zero');
scenario(0, 'explicit-positive');
function scenario(
  startOutput: number,
  final: 'omitted' | 'empty' | 'input-only' | 'explicit-zero' | 'explicit-positive',
) {
  it(`Anthropic final-output durable money initial=${startOutput} final=${final}`, async () => {
    const client = createClient();
    runMigrations(client.db);
    let ids = 0,
      calls = 0;
    const price = {
      provider: 'anthropic' as const,
      nativeId: 'independent-anthropic',
      displayName: 'independent',
      contextWindowTokens: 10000,
      maxOutputTokens: 100,
      inputPerMtokMicrocents: 1000000,
      outputPerMtokMicrocents: 1000000,
      cachedInputPerMtokMicrocents: 0,
      cacheWritePerMtokMicrocents: 0,
    };
    const prices = new Map([['independent-anthropic', price]]);
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'independent-anthropic',
          agents: [
            {
              id: 'a',
              provider: 'anthropic',
              model: 'independent-anthropic',
              system_prompt: 'offline',
              max_tokens: 100,
            },
          ],
          nodes: [{ id: 'n', type: 'agent', agent_ref: 'a', prompt_template: 'offline' }],
          edges: [],
          budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
        },
      }),
    );
    const events: ReadonlyArray<readonly [string, unknown]> = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg-review',
            type: 'message',
            role: 'assistant',
            model: 'independent-anthropic',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 11,
              output_tokens: startOutput,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'billed answer' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          ...(final === 'omitted'
            ? {}
            : {
                usage:
                  final === 'empty'
                    ? {}
                    : final === 'input-only'
                      ? { input_tokens: 11 }
                      : { output_tokens: final === 'explicit-zero' ? 0 : 7 },
              }),
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ];
    const wire = events
      .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      .join('');
    const provider = createAnthropicAdapter({
      fetch: () => {
        calls++;
        return Promise.resolve(
          new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
        );
      },
    });
    const store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => Date.parse('2026-10-11T00:00:00Z'),
      workflow: {
        slug: 'independent-anthropic',
        name: 'independent',
        definitionJson: JSON.stringify(workflow),
      },
    });
    const host = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
    const runner = createAgentNodeExecutor({
      resolveProvider: () => provider,
      keyFor: () => 'offline-key-fixture',
      sleep: () => Promise.resolve(),
      resolvePrice: prices,
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool')),
      },
    });
    const handle = new WorkflowEngine({ host, executor: runner, resolvePrice: prices }).start({
      workflow,
    });
    const live: RunEvent[] = [];
    try {
      for await (const event of handle.events) live.push(event);
      const departure = await handle.depart();
      const rows = store.loadRunEventLogForReplay(handle.runId);
      const fold = new UsageCoverageFold();
      for (const event of rows) fold.apply(event);
      const coverage = fold.snapshot().coverage;
      const liveFold = new UsageCoverageFold();
      for (const event of live) liveFold.apply(event);
      expect(liveFold.snapshot().coverage).toEqual(coverage);
      const ledger = rows.filter((e) => e.type === 'cost:attempt_settled');
      const conservative = rows.filter((e) => e.type === 'budget:estimate_committed');
      const positive = final === 'explicit-zero' || final === 'explicit-positive';
      const terminal = rows.at(-1);
      const sql = client.sqlite.prepare('SELECT COUNT(*) AS n FROM run_events').get();

      expect(calls).toBe(1);
      expect(terminal?.type).toBe('run:completed');
      expect(departure).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
      expect(sql).toEqual({ n: rows.length });
      expect(rows.filter((e) => e.type === 'cost:usage_pending')).toHaveLength(1);
      expect(ledger).toHaveLength(positive ? 1 : 0);
      expect(coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: positive ? 0 : 1,
      });
      expect(
        terminal?.type === 'run:completed' ? terminal.cumulativeCostMicrocents : undefined,
      ).toBe(positive ? (final === 'explicit-zero' ? 11 : 18) : 0);
      expect(conservative).toHaveLength(positive ? 0 : 1);
    } finally {
      client.sqlite.close();
    }
  });
}
