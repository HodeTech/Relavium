import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PricingOverlay } from '@relavium/llm';
import {
  createAnthropicAdapter,
  createOpenAiAdapter,
  createGeminiAdapter,
} from '@relavium/llm/adapters';
import { unwiredEffectJournal } from '@relavium/shared';
import { runAgentTurn, DEFAULT_AGENT_TURN_LIMITS, AgentTurnError } from './agent-turn.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';
import { BudgetGovernor } from './budget-governor.js';

const capturedSchema = z.object({
  model: z.string(),
  response: z.object({ status: z.number(), body: z.string() }),
});
const messageSchema = z.object({
  id: z.string(),
  model: z.string(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  stop_reason: z.literal('model_context_window_exceeded'),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough(),
});

describe('captured native overflow through SDK → chain → core → governor and durable ledger', () => {
  it('records the captured actual quantities once and keeps the post-content overflow unrecoverable', async () => {
    const captured = capturedSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            '../../../llm/src/conformance/fixtures/overflow/2026-10-08-anthropic-context-stop.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    const message = messageSchema.parse(JSON.parse(captured.response.body));
    const events: { type: string; [key: string]: unknown }[] = [
      {
        type: 'message_start',
        message: {
          ...message,
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          usage: { ...message.usage, output_tokens: 0 },
        },
      },
    ];
    message.content.forEach((part, index) =>
      events.push(
        { type: 'content_block_start', index, content_block: { ...part, text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } },
        { type: 'content_block_stop', index },
      ),
    );
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: message.usage,
      },
      { type: 'message_stop' },
    );
    const sse = events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
    let requests = 0;
    const provider = createAnthropicAdapter({
      fetch: () => {
        requests++;
        return Promise.resolve(
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      },
    });
    const prices: PricingOverlay = new Map([
      [
        captured.model,
        {
          provider: 'anthropic',
          nativeId: captured.model,
          displayName: 'Captured native response',
          contextWindowTokens: 200000,
          maxOutputTokens: 64000,
          inputPerMtokMicrocents: 1000000,
          outputPerMtokMicrocents: 1000000,
          cachedInputPerMtokMicrocents: 0,
        },
      ],
    ]);
    const governor = new BudgetGovernor({
      budget: { max_cost_microcents: 1000000, on_exceed: 'fail' },
      resolvePrice: prices,
      emit: () => Promise.resolve(),
    });
    const writes: SettledAttemptDraft[] = [];
    const money = new MoneyDurability({
      emit: (draft) => {
        writes.push(draft);
      },
      flushConservative: () => governor.flushCommitments(),
    });
    let total = 0;
    let releases = 0;
    let estimates = 0;
    let settlements = 0;
    await expect(
      runAgentTurn({
        nodeId: 'native-overflow',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'offline replay' }] }],
        planEntries: [{ provider, model: captured.model, maxAttempts: 3 }],
        maxTokens: 16384,
        chainCapabilities: {
          keyFor: () => 'offline-synthetic-key',
          sleep: () => Promise.resolve(),
        },
        signal: new AbortController().signal,
        emit: (event) => {
          if (event.type === 'cost:updated') {
            total += event.costMicrocents;
            governor.updateCost(total);
          }
        },
        registry: {
          has: () => false,
          list: () => [],
          dispatch: () => {
            throw new Error('unexpected tools');
          },
        },
        dispatchContext: {
          nodeId: 'native-overflow',
          grantedToolIds: new Set(),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed',
          gateApproved: false,
          effects: unwiredEffectJournal(),
          effectSlot: 0,
        },
        limits: DEFAULT_AGENT_TURN_LIMITS,
        resolvePrice: prices,
        money: money.turnPort(() => total),
        preEgress: async (info) => {
          const admission = await governor.checkPreEgress(info);
          if (admission === undefined) throw new Error('expected bounded admission');
          return {
            release: () => {
              releases++;
              admission.release();
            },
            settleAtReservedEstimate: (origin) => {
              estimates++;
              admission.settleAtReservedEstimate(origin);
            },
            settle: (cost) => {
              settlements++;
              admission.settle(cost);
            },
          };
        },
      }),
    ).rejects.toMatchObject({
      code: 'context_overflow',
      recoverableOverflow: false,
      usage: { input: 199885, output: 12792 },
    });
    await money.join();
    expect(requests).toBe(1);
    expect(releases).toBe(0);
    expect(estimates).toBe(0);
    expect(settlements).toBe(1);
    expect(writes).toMatchObject([
      {
        model: captured.model,
        attemptNumber: 1,
        inputTokens: 199885,
        outputTokens: 12792,
        costMicrocents: 212677,
        priced: true,
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(total).toBe(212677);
  });
});

describe('recorded HTTP overflow safe explanation through actual SDK and core', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const [dialect, file] of [
    ['anthropic', '2026-10-04-anthropic-overflow.json'],
    ['openai', '2026-10-04-openai-overflow.json'],
    ['deepseek', '2026-10-04-deepseek-overflow.json'],
    ['gemini', '2026-10-08-gemini-overflow.json'],
  ] as const)
    it(`${dialect}: engine-authored refusal contains no upstream diagnostic or paid usage`, async () => {
      const captured = capturedSchema.parse(
        JSON.parse(
          readFileSync(
            new URL(`../../../llm/src/conformance/fixtures/overflow/${file}`, import.meta.url),
            'utf8',
          ),
        ),
      );
      const fetch = vi.fn(() =>
        Promise.resolve(
          new Response(captured.response.body, {
            status: captured.response.status,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      if (dialect === 'gemini') vi.stubGlobal('fetch', fetch);
      const actual =
        dialect === 'anthropic'
          ? createAnthropicAdapter({ fetch })
          : dialect === 'gemini'
            ? createGeminiAdapter()
            : createOpenAiAdapter({ providerId: dialect, fetch });
      // Explicit unknown metadata prevents a catalog window from replacing this distinct safe wording.
      const provider = { ...actual, contextLimit: () => undefined };
      const expected = `The request exceeded its context window (size unknown) for model ${captured.model}. No tools ran in this turn.`;
      let costEvents = 0;
      const refusal = await runAgentTurn({
        nodeId: 'captured-http-refusal',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'offline synthetic replay' }] }],
        planEntries: [{ provider, model: captured.model, maxAttempts: 3 }],
        maxTokens: 64,
        chainCapabilities: {
          keyFor: () => 'offline-synthetic-key',
          sleep: () => Promise.resolve(),
        },
        signal: new AbortController().signal,
        emit: (event) => {
          if (event.type === 'cost:updated') costEvents++;
        },
        registry: {
          has: () => false,
          list: () => [],
          dispatch: () => {
            throw new Error('unexpected tool execution');
          },
        },
        dispatchContext: {
          nodeId: 'captured-http-refusal',
          grantedToolIds: new Set(),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed',
          gateApproved: false,
          effects: unwiredEffectJournal(),
          effectSlot: 0,
        },
        limits: DEFAULT_AGENT_TURN_LIMITS,
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(AgentTurnError);
      if (!(refusal instanceof AgentTurnError)) throw new Error('expected core overflow refusal');
      expect(refusal.message).toBe(expected);
      expect(refusal).toMatchObject({
        code: 'context_overflow',
        recoverableOverflow: true,
        retryable: false,
      });
      expect(refusal.usage).toBeUndefined();
      expect(costEvents).toBe(0);
      expect(fetch).toHaveBeenCalledOnce();
    });
});
