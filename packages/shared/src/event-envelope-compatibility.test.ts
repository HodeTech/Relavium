import { describe, expect, it } from 'vitest';

import {
  BaseEventSchema,
  HumanGatePausedEventSchema,
  RunEventSchema,
  RunOrSessionEventSchema,
  SessionEventSchema,
  parseStoredRunEvent,
  type BaseEvent,
  type HumanGateEvent,
} from './index.js';

const envelope = { timestamp: '2026-10-16T12:00:00.000Z', sequenceNumber: 3 };
const runEnvelope = { ...envelope, runId: 'run-envelope-regression' };
const sessionEnvelope = { ...envelope, sessionId: 'session-envelope-regression' };
const usageCoverage = { unverified: false, pendingInvocations: 1, unknownCalls: 2 };
const invocation = {
  producerId: 'producer-envelope-regression',
  ordinal: 2,
  dispatchId: 'dispatch-envelope-regression',
  round: 1,
  chainAttempt: 1,
};

// A computed own property is data, unlike an object literal's __proto__ setter syntax.
const inputs = {
  ['__proto__']: { admitted: ['own-property', 7] },
  nested: { values: [null, false, { result: 'retained' }] },
  secretInput: { secret: true, ref: 'inputs.secretInput' },
};
const runStarted = {
  type: 'run:started',
  ...runEnvelope,
  workflowId: '11111111-2222-4333-8444-555555555555',
  inputs,
  executionMode: 'local',
  cumulativeCostMicrocents: 19,
  cumulativeUnpricedCalls: 2,
  usageCoverage,
};
const gatePaused = {
  type: 'human_gate:paused',
  ...runEnvelope,
  nodeId: 'review-node',
  gateId: 'review-gate',
  gateType: 'review',
  message: 'Review the result',
  assignee: 'reviewer',
  timeoutMs: 1000,
  timeoutAction: 'reject',
  expiresAt: '2026-10-16T12:00:01.000Z',
};
const authorization = {
  type: 'budget:authorization',
  ...runEnvelope,
  nodeId: 'agent-node',
  gateId: 'budget-gate',
  authorization: {
    state: 'paused',
    allowance: {
      kind: 'frozen',
      quote: {
        kind: 'unpriced',
        excludedEntries: [
          {
            index: 0,
            model: 'unpriced-model',
            provider: 'openai',
            endpoint: 'custom',
            reason: 'unpriced_model',
          },
        ],
      },
    },
    spentMicrocents: 19,
    limitMicrocents: 20,
    timeoutMs: 1000,
    timeoutAction: 'reject',
    expiresAt: '2026-10-16T12:00:01.000Z',
  },
};
const sessionCompleted = {
  type: 'session:turn_completed',
  ...sessionEnvelope,
  stopReason: 'error',
  tokensUsed: { input: 15, output: 5, model: 'model-envelope-regression' },
  error: {
    code: 'tool_failed',
    message: 'Tool execution failed',
    retryable: true,
    correlationId: 'failure-envelope-regression',
  },
  toolHistory: [
    {
      call: { type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 22 },
      result: {
        type: 'tool_result',
        toolCallId: 'session-tool:1:0',
        resultBytes: 37,
        outcome: 'error',
      },
    },
  ],
  cumulativeCostMicrocents: 19,
  cumulativeUnpricedCalls: 2,
  usageCoverage,
};
const dualPayloads = [
  {
    type: 'agent:approval_requested',
    nodeId: 'agent-node',
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: '/workspace/result.txt' },
    attemptNumber: 2,
  },
  {
    type: 'budget:estimate_committed',
    nodeId: 'agent-node',
    model: 'model-envelope-regression',
    attemptNumber: 2,
    estimateMicrocents: 500,
    cumulativeConservativeMicrocents: 700,
  },
  {
    type: 'cost:usage_disposition',
    nodeId: 'agent-node',
    model: 'model-envelope-regression',
    invocation,
    disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
    receiptPending: true,
    usageCoverage,
  },
];

describe('event envelope compatibility', () => {
  describe('BaseEventSchema public correlation contract', () => {
    it.each([
      ['run', runEnvelope],
      ['session', sessionEnvelope],
    ])('accepts the %s envelope through the retained BaseEvent export', (_family, correlation) => {
      const expected = { type: 'agent:token', ...correlation };
      const parsed: BaseEvent = BaseEventSchema.parse(expected);
      expect(parsed).toEqual(expected);
    });

    it.each([
      ['neither', envelope],
      ['both', { ...runEnvelope, sessionId: sessionEnvelope.sessionId }],
    ])('rejects %s correlation keys directly', (_case, correlation) => {
      // safeParse keeps the causal failure an AssertionError rather than an unrelated parse throw.
      expect(
        BaseEventSchema.safeParse({ type: 'agent:token', ...correlation }).success,
        'EVENT_ENVELOPE_CORRELATION',
      ).toBe(false);
    });
  });

  describe('complete event payload preservation', () => {
    it.each([
      ['run admission and own __proto__ inputs', RunEventSchema, runStarted],
      ['budget authorization', RunEventSchema, authorization],
      ['human gate pause', RunEventSchema, gatePaused],
      [
        'human gate resume',
        RunEventSchema,
        {
          type: 'human_gate:resumed',
          ...runEnvelope,
          nodeId: 'review-node',
          gateId: 'review-gate',
          decision: 'input_provided',
          decidedBy: 'reviewer',
          payload: { nested: [{ answer: 42 }] },
        },
      ],
      ['session terminal and tool history', SessionEventSchema, sessionCompleted],
    ] as const)('preserves %s in its family and the bus schema', (_case, schema, expected) => {
      expect(schema.parse(expected), 'FULL_EVENT_PAYLOAD_PRESERVATION').toEqual(expected);
      expect(RunOrSessionEventSchema.parse(expected), 'FULL_EVENT_PAYLOAD_PRESERVATION').toEqual(
        expected,
      );
    });

    it('retains own __proto__ input data without changing the record prototype', () => {
      const parsed = RunEventSchema.parse(runStarted);
      expect(parsed.type).toBe('run:started');
      if (parsed.type !== 'run:started') throw new Error('expected run admission event');
      expect(Object.hasOwn(parsed.inputs, '__proto__')).toBe(true);
      expect(parsed.inputs['__proto__']).toEqual({ admitted: ['own-property', 7] });
      expect(Object.getPrototypeOf(parsed.inputs)).toBe(Object.prototype);
    });

    it('retains the public HumanGateEvent convenience type', () => {
      const parsed: HumanGateEvent = HumanGatePausedEventSchema.parse(gatePaused);
      expect(parsed).toEqual(gatePaused);
    });

    it.each(dualPayloads)('preserves $type on both complete correlation envelopes', (payload) => {
      for (const correlation of [runEnvelope, sessionEnvelope]) {
        const expected = { ...correlation, ...payload };
        expect(RunEventSchema.parse(expected), 'FULL_EVENT_PAYLOAD_PRESERVATION').toEqual(expected);
        expect(RunOrSessionEventSchema.parse(expected), 'FULL_EVENT_PAYLOAD_PRESERVATION').toEqual(
          expected,
        );
      }
    });

    it.each(dualPayloads)(
      'refuses both and neither keys for $type in complete schemas',
      (payload) => {
        for (const correlation of [
          envelope,
          { ...runEnvelope, sessionId: sessionEnvelope.sessionId },
        ]) {
          const candidate = { ...correlation, ...payload };
          expect(RunEventSchema.safeParse(candidate).success).toBe(false);
          expect(RunOrSessionEventSchema.safeParse(candidate).success).toBe(false);
        }
      },
    );

    it.each([
      ['run', RunEventSchema, runStarted, { sessionId: 'opposite-session' }],
      ['session', SessionEventSchema, sessionCompleted, { runId: 'opposite-run' }],
    ] as const)(
      'strips opposite keys and future optional fields on %s-only variants',
      (_case, schema, expected, opposite) => {
        const candidate = { ...expected, ...opposite, futureOptional: { feature: true } };
        expect(schema.parse(candidate)).toEqual(expected);
        expect(RunOrSessionEventSchema.parse(candidate)).toEqual(expected);
      },
    );

    it('keeps accounting-boundary strict unknown-field rejection', () => {
      const payload = dualPayloads[2];
      const candidate = { ...runEnvelope, ...payload, futureOptional: true };
      expect(RunEventSchema.safeParse(candidate).success).toBe(false);
      expect(RunOrSessionEventSchema.safeParse(candidate).success).toBe(false);
    });
  });

  describe('existing cross-field guards', () => {
    const mediaSubmitted = {
      type: 'media_job:submitted',
      ...runEnvelope,
      nodeId: 'media-node',
      jobId: 'media-job',
      provider: 'openai',
      model: 'video-model',
      modality: 'video',
      startedAt: envelope.timestamp,
      deadlineAt: '2026-10-16T12:00:01.000Z',
    };

    it.each([
      ['gate timeout requires duration', { ...gatePaused, timeoutMs: undefined }, 'timeoutAction'],
      [
        'pause requires a reason',
        { type: 'run:paused', ...runEnvelope, pendingGateCount: 0, gateIds: [] },
        'gateIds',
      ],
      [
        'pause count matches gates',
        { type: 'run:paused', ...runEnvelope, pendingGateCount: 2, gateIds: ['gate-1'] },
        'pendingGateCount',
      ],
      [
        'media deadline follows submit',
        { ...mediaSubmitted, deadlineAt: '2026-10-16T11:59:59.000Z' },
        'deadlineAt',
      ],
      [
        'frozen media cost requires units',
        { ...mediaSubmitted, acceptedCostMicrocents: 10 },
        'units',
      ],
      [
        'approval action matches preview',
        { ...runEnvelope, ...dualPayloads[0], preview: { command: 'touch result.txt' } },
        'preview',
      ],
      [
        'conservative total includes commitment',
        { ...runEnvelope, ...dualPayloads[1], cumulativeConservativeMicrocents: 499 },
        'cumulativeConservativeMicrocents',
      ],
      [
        'realized total includes charge',
        {
          type: 'cost:attempt_settled',
          ...runEnvelope,
          nodeId: 'agent-node',
          model: 'model',
          attemptNumber: 1,
          inputTokens: 10,
          outputTokens: 5,
          costMicrocents: 20,
          cumulativeCostMicrocents: 19,
          priced: true,
        },
        'cumulativeCostMicrocents',
      ],
      [
        'receipt requires incomplete disposition',
        {
          ...runEnvelope,
          ...dualPayloads[2],
          disposition: { kind: 'not_invoked', reason: 'cancelled' },
        },
        'receiptPending',
      ],
    ] as const)('retains %s', (_case, candidate, issueField) => {
      const parsed = RunEventSchema.safeParse(candidate);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path[0] === issueField)).toBe(true);
      }
      expect(RunOrSessionEventSchema.safeParse(candidate).success).toBe(false);
    });
  });

  describe('stored run forward-reader discriminator boundary', () => {
    it.each([
      ['missing body', { type: 'test:never_real_envelope_event' }],
      [
        'invalid body',
        {
          type: 'test:never_real_envelope_event',
          runId: '',
          sessionId: 7,
          sequenceNumber: -1,
          timestamp: null,
        },
      ],
    ])('drops an unknown nonempty type with %s', (_case, candidate) => {
      expect(parseStoredRunEvent(candidate)).toBeUndefined();
      expect(RunEventSchema.safeParse(candidate).success).toBe(false);
    });

    it.each([
      ['missing type', {}],
      ['empty type', { type: '' }],
      ['numeric type', { type: 7 }],
      ['null type', { type: null }],
      ['known type with missing body', { type: 'run:started' }],
      ['known type with bad envelope', { ...runStarted, sequenceNumber: -1 }],
      ['known type with bad payload', { ...runStarted, workflowId: 'invalid-uuid' }],
      [
        'known type with broken cross-field invariant',
        { ...runEnvelope, ...dualPayloads[1], cumulativeConservativeMicrocents: 0 },
      ],
    ])('throws for %s', (_case, candidate) => {
      expect(() => parseStoredRunEvent(candidate)).toThrow();
    });

    it('returns the complete known payload while stripping future optional fields', () => {
      expect(
        parseStoredRunEvent({ ...runStarted, futureOptional: true }),
        'FULL_EVENT_PAYLOAD_PRESERVATION',
      ).toEqual(runStarted);
    });
  });
});
