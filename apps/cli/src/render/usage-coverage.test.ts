import { RunEventSchema, type UsageCoverage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { costNotice } from '../chat/repl-info.js';
import { createChatStore } from './tui/chat-store.js';
import { formatCostShort } from './tui/format.js';
import { createRunStore } from './tui/run-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './tui/session-view-model.js';

const complete: UsageCoverage = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
const invocation = {
  producerId: 'producer',
  ordinal: 1,
  dispatchId: 'dispatch',
  round: 0,
  chainAttempt: 1,
};

describe('usage coverage across live and persisted cost projections', () => {
  it('uses the durable missing-price counter without adding queued observations twice', () => {
    const store = createRunStore(false);
    const apply = (sequenceNumber: number, body: Record<string, unknown>) =>
      store.apply(
        RunEventSchema.parse({
          ...body,
          runId: 'run',
          timestamp: '2026-10-10T00:00:00.000Z',
          sequenceNumber,
        }),
      );
    apply(1, { type: 'cost:coverage_started', basis: 'complete', cumulativeUnpricedCalls: 0 });
    for (const sequenceNumber of [2, 3]) {
      apply(sequenceNumber, {
        type: 'cost:updated',
        nodeId: 'worker',
        model: 'model',
        inputTokens: 0,
        outputTokens: 0,
        costMicrocents: 0,
        cumulativeCostMicrocents: 0,
        priced: false,
        cumulativeUnpricedCalls: 2,
      });
    }
    store.flush();
    expect(store.getSnapshot().state.unpricedCalls).toBe(2);
    expect(store.getSnapshot().state.usageCoverage).toEqual(complete);
    expect(store.summaryText()).toContain('price unknown for 2 calls');
    expect(store.summaryText()).not.toContain('free');
  });
  it('qualifies zero and positive known sums through pending, unknown and exact late settlement', () => {
    const store = createRunStore(false);
    let seq = 0;
    const apply = (body: Record<string, unknown>) =>
      store.apply(
        RunEventSchema.parse({
          ...body,
          runId: 'run',
          timestamp: '2026-10-10T00:00:00.000Z',
          sequenceNumber: ++seq,
        }),
      );
    apply({ type: 'cost:coverage_started', basis: 'complete' });
    expect(formatCostShort(0, store.getSnapshot().state.usageCoverage)).toBe('free');
    apply({ type: 'cost:usage_pending', nodeId: 'worker', model: 'model', invocation });
    expect(store.summaryText()).toContain('$0.0000 known; 1 usage pending');
    apply({
      type: 'cost:usage_disposition',
      nodeId: 'worker',
      model: 'model',
      invocation,
      disposition: {
        kind: 'incomplete',
        evidence: { kind: 'partial', known: { outputTokens: 2 }, reason: 'missing_fields' },
      },
      receiptPending: true,
    });
    expect(store.summaryText()).toContain('usage unknown for 1 call');
    apply({
      type: 'cost:attempt_settled',
      nodeId: 'worker',
      model: 'model',
      invocation,
      attemptNumber: 1,
      inputTokens: 3,
      outputTokens: 2,
      costMicrocents: 10000,
      cumulativeCostMicrocents: 10000,
      priced: true,
    });
    expect(store.getSnapshot().state.usageCoverage).toEqual(complete);
    expect(store.summaryText()).not.toContain('unknown');
    expect(store.summaryText()).toContain('$0.0001');
  });

  it('keeps missing-price and incomplete-usage qualifications independent', () => {
    const store = createChatStore(
      false,
      { transcript: [], cumulativeCostMicrocents: 0, usageCoverage: complete },
      INLINE_TRANSCRIPT_BOUND,
    );
    const event = RunEventSchema.parse({
      type: 'cost:updated',
      sessionId: 'session',
      nodeId: 'worker',
      model: 'model',
      timestamp: '2026-10-10T00:00:00.000Z',
      sequenceNumber: 1,
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 0,
      cumulativeCostMicrocents: 0,
      priced: false,
      usageCoverage: { ...complete, unknownCalls: 1 },
    });
    if (event.type !== 'cost:updated') throw new Error('wrong test event');
    store.apply(event);
    expect(store.summaryText()).toContain('usage unknown for 1 call');
    expect(store.summaryText()).toContain('price unknown for 1 call');
    expect(store.summaryText()).not.toContain('free');
  });

  it('renders usage-only models without inventing money, completed calls or terminal controls', () => {
    const notice = costNotice(0, [], {
      coverage: { ...complete, unknownCalls: 1 },
      models: [{ model: 'model\u001b[31m\nforged', coverage: { ...complete, unknownCalls: 1 } }],
    });
    expect(notice).toContain('usage unknown for 1 call');
    expect(notice).toContain('model');
    expect(notice).not.toContain('\u001b');
    expect(notice).not.toContain('\nforged');
    expect(notice).not.toContain('(0 calls');
    expect(notice).not.toContain('free');
  });
});
