import { expect, it } from 'vitest';
import { UsageCoverageFold, unwiredEffectJournal } from '@relavium/shared';
import { captureAgentTurnOutcome, DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';
import { LedgerDurabilityError, MoneyDurability } from './money-durability.js';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import type { LlmProvider } from '@relavium/llm';

import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '../../../db/src/index.js';
import {
  createAgentNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '../index.js';
import type { RunEvent } from '@relavium/shared';

for (const writeFails of [false, true]) {
  it(`consumer failure settles uncertainty and retains writer health (write fails=${writeFails})`, async () => {
    const fold = new UsageCoverageFold();
    fold.start('complete');
    let ordinal = 0,
      calls = 0,
      returned = 0,
      dispositions = 0;
    const marker = new Error('consumer refused delivery');
    const writerFailure = new Error('disposition writer refused');
    const money = new MoneyDurability({
      beginUsageInvocation: (draft) => {
        const id = Object.freeze({
          producerId: 'probe',
          ordinal: ++ordinal,
          dispatchId: 'turn',
          round: draft.round,
          chainAttempt: draft.chainAttempt,
        });
        fold.pending(draft.model, id);
        return Promise.resolve(id);
      },
      emitUsageDisposition: (draft) => {
        dispositions++;
        if (writeFails) throw writerFailure;
        fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
      },
      emit: (draft) => {
        if (draft.invocation) fold.complete(draft.model, draft.invocation);
      },
    });
    const provider: LlmProvider = {
      id: 'openai',
      supports: createOpenAiAdapter().supports,
      generate: () => Promise.reject(new Error('unexpected')),
      async *stream() {
        calls++;
        await Promise.resolve();
        try {
          yield { type: 'text_delta', text: 'billed content' };
          yield {
            type: 'stop',
            stopReason: 'stop',
            usage: { kind: 'missing', reason: 'interrupted' },
          };
        } finally {
          returned++;
        }
      },
    };
    const outcome = await captureAgentTurnOutcome({
      nodeId: 'turn',
      messages: [],
      planEntries: [{ provider, model: 'probe', maxAttempts: 1 }],
      chainCapabilities: {
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        newAbortController: () => new AbortController(),
      },
      signal: new AbortController().signal,
      emit: (event) => {
        if (event.type === 'agent:token') throw marker;
      },
      money: money.turnPort(() => 0),
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool')),
      },
      dispatchContext: {
        nodeId: 'turn',
        grantedToolIds: new Set(),
        config: {},
        toolPolicy: {},
        fsScope: 'sandboxed',
        gateApproved: false,
        effects: unwiredEffectJournal(),
        effectSlot: 0,
      },
      limits: DEFAULT_AGENT_TURN_LIMITS,
    });
    await money.waitForWrites();
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: marker,
      failureOrigin: 'observer',
      engaged: true,
    });
    expect(calls).toBe(1);
    expect(returned).toBe(1);
    expect(dispositions).toBe(1);
    expect(fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: writeFails ? 1 : 0,
      unknownCalls: writeFails ? 0 : 1,
    });
    expect(money.durabilityBroken).toBe(writeFails);
    // The turn already joined and observed the secondary fault while preserving its primary
    // observer exception. Sticky health still refuses any subsequent provider admission.
    if (writeFails)
      await expect(
        money.beginUsageInvocation({
          nodeId: 'turn',
          model: 'probe',
          round: 0,
          chainAttempt: 2,
        }),
      ).rejects.toBeInstanceOf(LedgerDurabilityError);
    else await money.join();
  });
}

for (const mode of [
  'stream-refused',
  'stream-normal',
  'stream-cancelled',
  'stream-terminal-refused',
  'stream-terminal-and-cost-refused',
  'generate-refused',
] as const) {
  it(`installed SDK + SQLite workflow: ${mode}`, async () => {
    const client = createClient();
    runMigrations(client.db);
    let id = 0,
      calls = 0,
      ready = 0;
    let cancel = () => {};
    const marker = new Error('consumer delivery failure');
    const terminalRefused =
      mode === 'stream-terminal-refused' || mode === 'stream-terminal-and-cost-refused';
    const provider = createOpenAiAdapter({
      baseURL: 'https://r5-money.invalid/v1',
      maxRetries: 0,
      fetch: () => {
        calls++;
        if (mode === 'generate-refused')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
                usage: {
                  prompt_tokens: 2,
                  completion_tokens: 1,
                  prompt_tokens_details: { cached_tokens: 0 },
                  completion_tokens_details: { audio_tokens: 0 },
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        return Promise.resolve(
          new Response(
            'data: ' +
              JSON.stringify({
                id: 'offline',
                choices: [{ index: 0, delta: { content: 'paid text' }, finish_reason: null }],
              }) +
              '\n\ndata: ' +
              JSON.stringify({
                id: 'offline',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                ...(terminalRefused
                  ? {
                      usage: {
                        prompt_tokens: 2,
                        completion_tokens: 1,
                        prompt_tokens_details: { cached_tokens: 0 },
                      },
                    }
                  : {}),
              }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      },
    });
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'r5',
          agents: [{ id: 'a', provider: 'openai', model: 'offline', system_prompt: 'offline' }],
          nodes: [
            {
              id: 'n',
              type: 'agent',
              agent_ref: 'a',
              prompt_template: 'offline',
              ...(mode === 'generate-refused' ? { output_modalities: ['text', 'audio'] } : {}),
            },
          ],
          edges: [],
        },
      }),
    );
    const store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      now: () => Date.parse('2026-10-10T00:00:00Z'),
      workflow: { slug: 'r5', name: 'r5', definitionJson: JSON.stringify(workflow) },
    });
    const host = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
    const resolvePrice = new Map([
      [
        'offline',
        {
          provider: 'openai' as const,
          nativeId: 'offline',
          displayName: 'offline',
          contextWindowTokens: 1000,
          maxOutputTokens: 100,
          inputPerMtokMicrocents: 100000000,
          outputPerMtokMicrocents: 100000000,
          cachedInputPerMtokMicrocents: 0,
        },
      ],
    ]);
    const runner = createAgentNodeExecutor({
      resolvePrice,
      resolveProvider: () => provider,
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool')),
      },
    });
    const handle = new WorkflowEngine({
      host,
      resolvePrice,
      executor: {
        execute: (ctx) =>
          runner.execute({
            ...ctx,
            whenReady: async () => {
              if (terminalRefused && ++ready === 2) throw marker;
              await ctx.whenReady?.();
            },
            emit: (event) => {
              if (mode === 'stream-refused' && event.type === 'agent:token') throw marker;
              ctx.emit(event);
              if (mode === 'stream-cancelled' && event.type === 'agent:token') cancel();
              if (mode === 'generate-refused' && event.type === 'cost:updated') throw marker;
              if (mode === 'stream-terminal-and-cost-refused' && event.type === 'cost:updated')
                throw new Error('secondary accounting observer');
            },
          }),
      },
    }).start({ workflow });
    cancel = () => handle.cancel();
    const live: RunEvent[] = [];
    try {
      for await (const event of handle.events) live.push(event);
      const departure = await handle.depart();
      const rows = store.loadRunEventLogForReplay(handle.runId);
      const fold = new UsageCoverageFold();
      for (const event of rows) fold.apply(event);
      expect(calls, JSON.stringify(rows)).toBe(1);
      expect(departure).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
      expect(host.livenessCount()).toBe(0);
      expect(rows.filter((e) => e.type === 'cost:usage_pending')).toHaveLength(1);
      expect(rows.at(-1)?.type).toBe(
        mode === 'stream-normal'
          ? 'run:completed'
          : mode === 'stream-cancelled'
            ? 'run:cancelled'
            : 'run:failed',
      );
      if (mode === 'generate-refused' || terminalRefused) {
        expect({
          ledger: rows.filter((e) => e.type === 'cost:attempt_settled').length,
          total: rows.at(-1)?.cumulativeCostMicrocents,
          coverage: fold.snapshot().coverage,
        }).toEqual({
          ledger: 1,
          total: 300,
          coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
        });
      } else {
        expect({
          dispositions: rows.filter((e) => e.type === 'cost:usage_disposition').length,
          coverage: fold.snapshot().coverage,
        }).toEqual({
          dispositions: 1,
          coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 },
        });
      }
    } finally {
      client.sqlite.close();
    }
  });
}
