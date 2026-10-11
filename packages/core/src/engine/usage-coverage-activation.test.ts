import { describe, expect, it } from 'vitest';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { UsageCoverageFold, unwiredEffectJournal, type UsageEvidence } from '@relavium/shared';
import { DEFAULT_AGENT_TURN_LIMITS, runAgentTurn } from './agent-turn.js';
import { MoneyDurability } from './money-durability.js';

function harness(evidence: UsageEvidence, failure?: 'pending' | 'disposition') {
  const coverage = new UsageCoverageFold();
  coverage.start('complete');
  let calls = 0,
    ordinal = 0,
    cost = 0,
    actualWrites = 0;
  const order: string[] = [];
  const provider: LlmProvider = {
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
      throw new Error('unexpected generate');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      calls++;
      order.push('invoke');
      yield { type: 'text_delta', text: 'useful' };
      yield { type: 'stop', stopReason: 'stop', usage: evidence };
    },
  };
  const money = new MoneyDurability({
    beginUsageInvocation: async (draft) => {
      await Promise.resolve();
      order.push('pending');
      if (failure === 'pending') throw new Error('pending refused');
      const id = Object.freeze({
        producerId: 'test',
        ordinal: ++ordinal,
        dispatchId: draft.nodeId,
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      coverage.pending(draft.model, id);
      return id;
    },
    emitUsageDisposition: (draft) => {
      order.push('disposition');
      if (failure === 'disposition') throw new Error('disposition refused');
      coverage.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      actualWrites++;
      if (draft.invocation !== undefined) coverage.complete(draft.model, draft.invocation);
    },
  });
  const run = () =>
    runAgentTurn({
      nodeId: 'node',
      messages: [],
      planEntries: [{ provider, model: 'offline', maxAttempts: 1 }],
      chainCapabilities: { keyFor: () => 'synthetic', sleep: () => Promise.resolve() },
      signal: new AbortController().signal,
      emit: (event) => {
        if (event.type === 'cost:updated') cost += event.costMicrocents;
      },
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => {
          throw new Error('no tools');
        },
      },
      dispatchContext: {
        nodeId: 'node',
        grantedToolIds: new Set(),
        config: {},
        toolPolicy: {},
        fsScope: 'sandboxed',
        gateApproved: false,
        effects: unwiredEffectJournal(),
        effectSlot: 0,
      },
      limits: DEFAULT_AGENT_TURN_LIMITS,
      money: money.turnPort(() => cost),
    });
  return { run, coverage, money, order, calls: () => calls, actualWrites: () => actualWrites };
}

describe('ADR-0104 production turn accounting', () => {
  for (const evidence of [
    { kind: 'missing', reason: 'not_reported' },
    { kind: 'partial', known: { outputTokens: 8 }, reason: 'missing_fields' },
  ] satisfies UsageEvidence[]) {
    it(`retains useful ${evidence.kind} output and unknown uncapped coverage`, async () => {
      const h = harness(evidence);
      expect((await h.run()).text).toBe('useful');
      expect(h.order, 'USAGE_CAUSAL_DISPOSITION_ACK').toEqual(['pending', 'invoke', 'disposition']);
      expect(h.actualWrites()).toBe(0);
      expect(h.coverage.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
      });
    });
  }
  it('failed pending durability permits no provider invocation', async () => {
    const h = harness({ kind: 'missing', reason: 'not_reported' }, 'pending');
    await expect(h.run()).rejects.toThrow();
    expect(h.calls()).toBe(0);
  });
  it('failed uncertainty durability rejects the enclosing boundary without a governor', async () => {
    const h = harness({ kind: 'missing', reason: 'not_reported' }, 'disposition');
    await expect(h.run()).rejects.toThrow('ledger');
    expect(h.calls()).toBe(1);
    await expect(h.run()).rejects.toThrow();
    expect(h.calls()).toBe(1);
  });
  it('claims an exact live receipt once before any cost mutation and allows one late completion', async () => {
    const h = harness({ kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } });
    const id = await h.money.beginUsageInvocation({
      nodeId: 'n',
      model: 'offline',
      round: 0,
      chainAttempt: 1,
    });
    expect(h.money.claimUsage({ ...id }, 'complete')).toBe(false);
    expect(h.money.claimUsage(id, 'incomplete')).toBe(true);
    expect(h.money.claimUsage(id, 'incomplete')).toBe(false);
    expect(h.money.claimUsage(id, 'complete')).toBe(true);
    expect(h.money.claimUsage(id, 'complete')).toBe(false);
    const retired = await h.money.beginUsageInvocation({
      nodeId: 'n',
      model: 'offline',
      round: 0,
      chainAttempt: 2,
    });
    expect(h.money.claimUsage(retired, 'retired')).toBe(true);
    expect(h.money.claimUsage(retired, 'complete')).toBe(false);
  });
});
