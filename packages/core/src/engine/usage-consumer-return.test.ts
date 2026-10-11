import { expect, it } from 'vitest';
import { UsageCoverageFold, unwiredEffectJournal } from '@relavium/shared';
import { captureAgentTurnOutcome, DEFAULT_AGENT_TURN_LIMITS } from './agent-turn.js';
import { LedgerDurabilityError, MoneyDurability } from './money-durability.js';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import type { LlmProvider } from '@relavium/llm';

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
