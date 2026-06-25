import { describe, expect, expectTypeOf, it } from 'vitest';

import { RUN_EVENT_TYPES, SESSION_EVENT_TYPES } from './constants.js';
import {
  CostUpdatedEventSchema,
  MaskedSecretSchema,
  RunEventSchema,
  SessionEventSchema,
} from './run-event.js';
import type { RunEvent, RunEventType } from './index.js';

const env = { runId: 'run-1', timestamp: '2026-06-04T00:00:00.000Z', sequenceNumber: 7 };

/** One canonical valid payload per RunEvent variant (sse-event-schema.md). */
const valid: Record<string, Record<string, unknown>> = {
  'run:started': {
    type: 'run:started',
    ...env,
    workflowId: 'b1a2c3d4-0000-4000-8000-000000000000', // workflows.id UUID (ADR-0022)
    inputs: {},
    executionMode: 'local',
  },
  'node:started': { type: 'node:started', ...env, nodeId: 'n', nodeType: 'agent' },
  'agent:token': {
    type: 'agent:token',
    ...env,
    nodeId: 'n',
    token: 'hi',
    model: 'claude-sonnet-4-6',
  },
  'agent:tool_call': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    model: 'claude-sonnet-4-6',
    toolId: 'read_file',
    toolInput: { path: 'x' },
  },
  'agent:tool_result': {
    type: 'agent:tool_result',
    ...env,
    nodeId: 'n',
    toolId: 'read_file',
    success: true,
    outputSummary: 'ok',
  },
  'agent:file_patch_proposed': {
    type: 'agent:file_patch_proposed',
    ...env,
    nodeId: 'n',
    patches: [{ uri: 'file:///x.ts', unifiedDiff: '@@ -1 +1 @@' }],
  },
  'cost:updated': {
    type: 'cost:updated',
    ...env,
    nodeId: 'n',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costMicrocents: 1234,
    cumulativeCostMicrocents: 5678,
  },
  'node:completed': {
    type: 'node:completed',
    ...env,
    nodeId: 'n',
    output: {},
    tokensUsed: { input: 1, output: 2, model: 'm' },
    durationMs: 100,
  },
  'node:failed': {
    type: 'node:failed',
    ...env,
    nodeId: 'n',
    error: { code: 'tool_failed', message: 'boom', retryable: false },
  },
  'node:skipped': {
    type: 'node:skipped',
    ...env,
    nodeId: 'n',
    reason: 'branch_not_taken',
  },
  'node:retrying': {
    type: 'node:retrying',
    ...env,
    nodeId: 'n',
    attemptNumber: 1,
    error: { code: 'tool_failed', message: 'boom', retryable: true },
    delayMs: 1000,
  },
  'media_job:submitted': {
    type: 'media_job:submitted',
    ...env,
    nodeId: 'n',
    jobId: 'job-1',
    provider: 'openai',
    model: 'sora',
    modality: 'video',
    startedAt: '2026-06-20T00:00:00.000Z',
    deadlineAt: '2026-06-20T00:30:00.000Z',
  },
  'human_gate:paused': {
    type: 'human_gate:paused',
    ...env,
    nodeId: 'n',
    gateId: 'g1',
    gateType: 'approval',
    message: 'approve?',
    timeoutMs: 1000,
    timeoutAction: 'reject',
    expiresAt: '2026-06-14T00:00:00.000Z',
  },
  'human_gate:resumed': {
    type: 'human_gate:resumed',
    ...env,
    nodeId: 'n',
    decision: 'approved',
    decidedBy: 'user-1',
  },
  'run:completed': {
    type: 'run:completed',
    ...env,
    outputs: {},
    totalTokensUsed: { input: 1, output: 2 },
    totalCostMicrocents: 999,
    durationMs: 100,
  },
  'run:failed': {
    type: 'run:failed',
    ...env,
    error: { code: 'internal', message: 'boom', retryable: false },
    partialOutputs: {},
  },
  'run:cancelled': { type: 'run:cancelled', ...env },
  'run:paused': { type: 'run:paused', ...env, pendingGateCount: 2, gateIds: ['g1', 'g2'] },
  'run:timeout': { type: 'run:timeout', ...env, elapsedMs: 1000, timeoutMs: 500 },
  'budget:warning': {
    type: 'budget:warning',
    ...env,
    spentMicrocents: 900,
    limitMicrocents: 1000,
    thresholdPct: 90,
  },
  'budget:paused': {
    type: 'budget:paused',
    ...env,
    nodeId: 'n',
    spentMicrocents: 1000,
    limitMicrocents: 1000,
    gateId: 'budget-gate-1',
  },
};

/** One targeted invalid payload per variant (a missing/invalid required field). */
const reject: Record<string, Record<string, unknown>> = {
  'run:started (bad executionMode)': {
    type: 'run:started',
    ...env,
    workflowId: 'b1a2c3d4-0000-4000-8000-000000000000', // valid UUID — isolate the executionMode failure
    inputs: {},
    executionMode: 'turbo',
  },
  'run:started (bad workflowId)': {
    type: 'run:started',
    ...env,
    workflowId: 'wf', // not a UUID (ADR-0022) — isolate the workflowId failure
    inputs: {},
    executionMode: 'local',
  },
  'node:started (missing nodeType)': { type: 'node:started', ...env, nodeId: 'n' },
  // `parallel`/`merge`/`human_gate` are authored YAML types, NOT engine types (`parallel` expands to
  // fan_out/fan_in; `merge` runs as fan_in; `human_gate` is the authored alias of human_in_the_loop) —
  // the node:started event carries the engine enum, so every authored-only type must be rejected.
  'node:started (authored nodeType parallel)': {
    type: 'node:started',
    ...env,
    nodeId: 'n',
    nodeType: 'parallel',
  },
  'node:started (authored nodeType merge)': {
    type: 'node:started',
    ...env,
    nodeId: 'n',
    nodeType: 'merge',
  },
  'node:started (authored nodeType human_gate)': {
    type: 'node:started',
    ...env,
    nodeId: 'n',
    nodeType: 'human_gate',
  },
  'agent:token (missing model)': { type: 'agent:token', ...env, nodeId: 'n', token: 'hi' },
  'agent:tool_call (missing toolId)': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    model: 'm',
    toolInput: {},
  },
  'agent:tool_call (missing model)': {
    type: 'agent:tool_call',
    ...env,
    nodeId: 'n',
    toolId: 'read_file',
    toolInput: {},
  },
  'agent:tool_result (missing success)': {
    type: 'agent:tool_result',
    ...env,
    nodeId: 'n',
    toolId: 't',
    outputSummary: 'ok',
  },
  'cost:updated (float costMicrocents)': { ...valid['cost:updated'], costMicrocents: 12.5 },
  'node:completed (bad tokensUsed)': {
    type: 'node:completed',
    ...env,
    nodeId: 'n',
    output: {},
    tokensUsed: { input: 1 },
    durationMs: 100,
  },
  'node:failed (missing error)': { type: 'node:failed', ...env, nodeId: 'n' },
  'node:skipped (bad reason)': { type: 'node:skipped', ...env, nodeId: 'n', reason: 'because' },
  'node:retrying (missing delayMs)': {
    type: 'node:retrying',
    ...env,
    nodeId: 'n',
    attemptNumber: 1,
    error: { code: 'tool_failed', message: 'x', retryable: true },
  },
  'media_job:submitted (bad provider)': {
    ...valid['media_job:submitted'],
    provider: 'cohere', // not in LLM_PROVIDERS
  },
  'media_job:submitted (bad modality)': {
    ...valid['media_job:submitted'],
    modality: 'document', // billed modalities are image|audio|video only
  },
  'media_job:submitted (non-datetime deadlineAt)': {
    ...valid['media_job:submitted'],
    deadlineAt: 'soon',
  },
  'media_job:submitted (non-datetime startedAt)': {
    ...valid['media_job:submitted'],
    startedAt: 'tomorrow',
  },
  // deadlineAt = startedAt + media_job_deadline_ms by construction; an earlier deadlineAt is malformed and
  // would invert the resume `now > deadlineAt` short-circuit (union-level superRefine, Date.parse-compared).
  'media_job:submitted (deadlineAt before startedAt)': {
    ...valid['media_job:submitted'],
    startedAt: '2026-06-20T00:30:00.000Z',
    deadlineAt: '2026-06-20T00:00:00.000Z',
  },
  'media_job:submitted (empty jobId)': {
    ...valid['media_job:submitted'],
    jobId: '',
  },
  'media_job:submitted (missing jobId)': {
    ...valid['media_job:submitted'],
    jobId: undefined,
  },
  'human_gate:paused (bad gateType)': {
    type: 'human_gate:paused',
    ...env,
    nodeId: 'n',
    gateId: 'g',
    gateType: 'sign-off',
    message: 'm',
  },
  'human_gate:resumed (bad decision)': {
    type: 'human_gate:resumed',
    ...env,
    nodeId: 'n',
    decision: 'maybe',
    decidedBy: 'u',
  },
  'run:completed (missing outputs)': {
    type: 'run:completed',
    ...env,
    totalTokensUsed: { input: 1, output: 2 },
    totalCostMicrocents: 0,
    durationMs: 100,
  },
  'run:completed (missing totalCostMicrocents)': {
    type: 'run:completed',
    ...env,
    outputs: {},
    totalTokensUsed: { input: 1, output: 2 },
    durationMs: 100,
  },
  'run:failed (missing partialOutputs)': {
    type: 'run:failed',
    ...env,
    error: { code: 'internal', message: 'm', retryable: false }, // compliant — isolate the missing partialOutputs
  },
  'run:cancelled (negative sequenceNumber)': { type: 'run:cancelled', ...env, sequenceNumber: -1 },
  // A media-job park may carry empty gateIds / pendingGateCount 0 (1.AG Section D), so those are no longer
  // rejected; an empty pendingMediaJobNodeIds (min 1) still is, and a ZERO-reason pause (no gate, no media) is
  // rejected by the union-level superRefine.
  'run:paused (empty pendingMediaJobNodeIds)': {
    ...valid['run:paused'],
    pendingMediaJobNodeIds: [],
  },
  'run:paused (no suspension reason)': {
    ...valid['run:paused'],
    pendingGateCount: 0,
    gateIds: [],
  },
  // pendingGateCount is the aggregate of gateIds — a divergent pair (count 5, two ids) is malformed and the
  // union-level superRefine rejects it (the count/list relaxation must not let them drift, 1.AG Section D).
  'run:paused (pendingGateCount/gateIds mismatch)': {
    ...valid['run:paused'],
    pendingGateCount: 5,
    gateIds: ['g1', 'g2'],
  },
  'run:timeout (negative elapsedMs)': { ...valid['run:timeout'], elapsedMs: -1 },
  'budget:warning (thresholdPct > 100)': { ...valid['budget:warning'], thresholdPct: 101 },
  'budget:warning (negative thresholdPct)': { ...valid['budget:warning'], thresholdPct: -1 },
  'budget:warning (fractional thresholdPct)': { ...valid['budget:warning'], thresholdPct: 90.5 },
  'budget:paused (negative spentMicrocents)': { ...valid['budget:paused'], spentMicrocents: -1 },
  'budget:paused (missing nodeId)': { ...valid['budget:paused'], nodeId: undefined },
  'budget:paused (empty nodeId)': { ...valid['budget:paused'], nodeId: '' },
  'budget:paused (missing gateId)': { ...valid['budget:paused'], gateId: undefined },
};

describe('RunEvent union — every variant', () => {
  it.each(Object.keys(valid))('accepts a valid %s', (name) => {
    expect(RunEventSchema.safeParse(valid[name]).success).toBe(true);
  });

  it.each(Object.keys(reject))('rejects %s', (name) => {
    expect(RunEventSchema.safeParse(reject[name]).success).toBe(false);
  });

  it('accepts a media-only run:paused park: empty gateIds + pendingGateCount 0 + media node ids (1.AG Section D)', () => {
    expect(
      RunEventSchema.safeParse({
        type: 'run:paused',
        ...env,
        pendingGateCount: 0,
        gateIds: [],
        pendingMediaJobNodeIds: ['work'],
      }).success,
    ).toBe(true);
  });

  it('covers exactly the 21 canonical colon-namespaced names, pinned to a literal list', () => {
    // A hardcoded contract list — independent of RUN_EVENT_TYPES — so the union and the
    // constant cannot silently drift together.
    const CONTRACT_NAMES = [
      'run:started',
      'node:started',
      'agent:token',
      'agent:tool_call',
      'agent:tool_result',
      'agent:file_patch_proposed',
      'cost:updated',
      'node:completed',
      'node:failed',
      'node:skipped',
      'node:retrying',
      'media_job:submitted',
      'human_gate:paused',
      'human_gate:resumed',
      'run:completed',
      'run:failed',
      'run:cancelled',
      'run:paused',
      'run:timeout',
      'budget:warning',
      'budget:paused',
    ];
    // The matrix above proves each canonical name's valid payload parses (so a
    // renamed/missing variant fails there); the union member count catches an *extra*
    // variant — without reaching into Zod's internal schema representation.
    // RunEventSchema wraps the union in the correlation-key refinement; reach the raw union.
    expect(RunEventSchema.innerType().options).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(RUN_EVENT_TYPES)).toEqual(new Set(CONTRACT_NAMES));
    expect(Object.keys(valid)).toEqual(CONTRACT_NAMES); // the matrix covers all 21
  });

  it('pins the RunEvent discriminant to RunEventType (type-level)', () => {
    expectTypeOf<RunEvent['type']>().toEqualTypeOf<RunEventType>();
  });
});

describe('cost:updated and sequenceNumber invariants', () => {
  it('pins cost:updated to integer micro-cents', () => {
    const ok = valid['cost:updated'];
    expect(CostUpdatedEventSchema.safeParse(ok).success).toBe(true);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, costMicrocents: 12.5 }).success).toBe(false);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, cumulativeCostMicrocents: -1 }).success).toBe(
      false,
    );
  });

  it('accepts an optional 1-based attemptNumber on cost:updated, rejects non-positive', () => {
    const ok = valid['cost:updated'];
    expect(CostUpdatedEventSchema.safeParse({ ...ok, attemptNumber: 2 }).success).toBe(true);
    expect(CostUpdatedEventSchema.safeParse({ ...ok, attemptNumber: 0 }).success).toBe(false);
  });

  it('accepts an optional cumulativeCostMicrocents on node:failed / run:cancelled, rejects negative/fractional (2.S/D-GC)', () => {
    // The durable fail-cost snapshot (ADR-0045 §5): both terminal carriers accept the optional running total
    // (omittable for backward-compat) but pin it to non-negative integer micro-cents, like every cost field.
    for (const base of [valid['node:failed'], { type: 'run:cancelled' as const, ...env }]) {
      expect(RunEventSchema.safeParse({ ...base, cumulativeCostMicrocents: 4242 }).success).toBe(
        true,
      );
      expect(RunEventSchema.safeParse(base).success).toBe(true); // still valid when omitted
      expect(RunEventSchema.safeParse({ ...base, cumulativeCostMicrocents: -1 }).success).toBe(
        false,
      );
      expect(RunEventSchema.safeParse({ ...base, cumulativeCostMicrocents: 1.5 }).success).toBe(
        false,
      );
    }
  });

  it('accepts sequenceNumber 0 but rejects negative / fractional', () => {
    const cancelled = { type: 'run:cancelled', ...env };
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: 0 }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: -1 }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...cancelled, sequenceNumber: 1.5 }).success).toBe(false);
  });

  it('accepts the human-gate events with their optional fields present', () => {
    expect(
      RunEventSchema.safeParse({
        ...valid['human_gate:paused'],
        assignee: 'reviewer@example.com',
        timeoutMs: 1000,
        expiresAt: '2026-06-04T01:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({ ...valid['human_gate:resumed'], payload: { input: 'yes' } })
        .success,
    ).toBe(true);
  });

  it('rejects a non-ISO-8601 timestamp', () => {
    expect(
      RunEventSchema.safeParse({ ...env, type: 'run:cancelled', timestamp: 'June 4 2026' }).success,
    ).toBe(false);
  });

  it('accepts node:completed from a non-agent node (tokensUsed without a model)', () => {
    // A condition/transform/merge node has no LLM model — tokensUsed.model is optional.
    expect(
      RunEventSchema.safeParse({ ...valid['node:completed'], tokensUsed: { input: 0, output: 0 } })
        .success,
    ).toBe(true);
  });

  it('rejects legacy dotted and non-canonical event names', () => {
    expect(
      RunEventSchema.safeParse({ ...valid['cost:updated'], type: 'cost.update' }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...env, type: 'node:error', nodeId: 'n' }).success).toBe(
      false,
    );
    expect(RunEventSchema.safeParse({ ...env, type: 'run:error' }).success).toBe(false);
  });
});

const senv = { sessionId: 'sess-1', timestamp: '2026-06-04T00:00:00.000Z', sequenceNumber: 3 };

/** One canonical valid payload per `session:*` lifecycle variant (sse-event-schema.md). */
const validSession: Record<string, Record<string, unknown>> = {
  'session:started': {
    type: 'session:started',
    ...senv,
    agentRef: 'my-agent',
    model: 'claude-sonnet-4-6',
    context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
  },
  'session:turn_started': { type: 'session:turn_started', ...senv },
  'session:turn_completed': {
    type: 'session:turn_completed',
    ...senv,
    stopReason: 'stop',
    tokensUsed: { input: 1, output: 2, model: 'm' },
  },
  'session:cancelled': { type: 'session:cancelled', ...senv },
  'session:exported': { type: 'session:exported', ...senv, workflowPath: '/w/x.relavium.yaml' },
};

describe('SessionEvent union — the agent-first namespace', () => {
  it.each(Object.keys(validSession))('accepts a valid %s', (name) => {
    expect(SessionEventSchema.safeParse(validSession[name]).success).toBe(true);
  });

  it('covers exactly the five session:* names, pinned to a literal list', () => {
    const CONTRACT_NAMES = [
      'session:started',
      'session:turn_started',
      'session:turn_completed',
      'session:cancelled',
      'session:exported',
    ];
    expect(SessionEventSchema.options).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(SESSION_EVENT_TYPES)).toEqual(new Set(CONTRACT_NAMES));
    expect(Object.keys(validSession)).toEqual(CONTRACT_NAMES);
  });

  it('requires sessionId (a session event without it is rejected)', () => {
    // `...env` carries runId but no sessionId — the wrong correlation key for a session event.
    expect(SessionEventSchema.safeParse({ type: 'session:turn_started', ...env }).success).toBe(
      false,
    );
  });

  it('accepts a failed turn (session:turn_completed carries an ErrorCode error)', () => {
    expect(
      SessionEventSchema.safeParse({
        ...validSession['session:turn_completed'],
        error: { code: 'provider_rate_limit', message: 'slow down', retryable: true },
      }).success,
    ).toBe(true);
  });

  it('pins turn_limit as the ErrorCode for a capped conversation (never a silent stop)', () => {
    // A session hitting a hard turn/round cap must be expressible as its own cause,
    // fatal-without-user-action — not folded into run_timeout/budget_exceeded. (Distinct
    // from [chat].max_messages, which is a history-trim threshold, not a stop.)
    expect(
      SessionEventSchema.safeParse({
        ...validSession['session:turn_completed'],
        error: { code: 'turn_limit', message: 'session reached its turn cap', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('rejects a session:started selection whose startLine exceeds endLine', () => {
    const withSelection = (sel: { file: string; startLine: number; endLine: number }) =>
      SessionEventSchema.safeParse({
        ...validSession['session:started'],
        context: { workingDir: '/w', fsScopeTier: 'sandboxed', selection: { ...sel } },
      }).success;
    expect(withSelection({ file: 'a.ts', startLine: 1, endLine: 5 })).toBe(true);
    expect(withSelection({ file: 'a.ts', startLine: 5, endLine: 1 })).toBe(false);
  });

  it('binds session:turn_completed.stopReason to the closed StopReason enum', () => {
    const ok = validSession['session:turn_completed'];
    expect(SessionEventSchema.safeParse({ ...ok, stopReason: 'tool_use' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...ok, stopReason: 'banana' }).success).toBe(false);
  });

  it('rejects session variants missing/emptying a required field', () => {
    // session:exported needs a non-empty workflowPath
    expect(
      SessionEventSchema.safeParse({ ...validSession['session:exported'], workflowPath: '' })
        .success,
    ).toBe(false);
    // session:started needs model (agentRef + context present)
    expect(
      SessionEventSchema.safeParse({
        type: 'session:started',
        ...senv,
        agentRef: 'a',
        context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
      }).success,
    ).toBe(false);
    // session:turn_completed needs tokensUsed (stopReason present)
    expect(
      SessionEventSchema.safeParse({ type: 'session:turn_completed', ...senv, stopReason: 'stop' })
        .success,
    ).toBe(false);
  });
});

describe('event envelope + ErrorCode + attemptNumber invariants', () => {
  it('enforces exactly one of runId / sessionId on the four dual-envelope events', () => {
    // A reused event carries runId on a run and sessionId on a session — never neither, never both.
    const dual = {
      type: 'agent:token',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 4,
      nodeId: 'n',
      token: 'hi',
      model: 'm',
    };
    // exactly one → accepted (run-flavored, then session-flavored)
    expect(RunEventSchema.safeParse({ ...dual, runId: 'run-1' }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...dual, sessionId: 'sess-1' }).success).toBe(true);
    // neither / both → rejected, with the error on the correlation key (not an unrelated field)
    const onCorrelationKey = (doc: unknown): boolean => {
      const result = RunEventSchema.safeParse(doc);
      return (
        !result.success && result.error.issues.some((i) => i.message.includes('runId / sessionId'))
      );
    };
    expect(onCorrelationKey(dual)).toBe(true); // neither
    expect(onCorrelationKey({ ...dual, runId: 'run-1', sessionId: 'sess-1' })).toBe(true); // both
  });

  it('binds node:failed / run:failed error.code to the closed ErrorCode enum', () => {
    // A free-string code is rejected now that the taxonomy is closed.
    expect(
      RunEventSchema.safeParse({
        ...valid['node:failed'],
        error: { code: 'totally_made_up', message: 'x', retryable: false },
      }).success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({
        ...valid['node:failed'],
        error: { code: 'sandbox_error', message: 'x', retryable: false },
      }).success,
    ).toBe(true);
    // The 1.AG content_filter ErrorCode parses on the event path (a content-policy block surfaces here).
    expect(
      RunEventSchema.safeParse({
        ...valid['node:failed'],
        error: { code: 'content_filter', message: 'content policy block', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('accepts an optional 1-based attemptNumber on every carrier event', () => {
    for (const name of [
      'agent:tool_call',
      'agent:tool_result',
      'node:completed',
      'cost:updated',
      'agent:file_patch_proposed',
    ]) {
      expect(RunEventSchema.safeParse({ ...valid[name], attemptNumber: 2 }).success).toBe(true);
      expect(RunEventSchema.safeParse({ ...valid[name], attemptNumber: 0 }).success).toBe(false);
    }
  });

  it('rejects an agent:file_patch_proposed with an empty patches array', () => {
    expect(
      RunEventSchema.safeParse({ ...valid['agent:file_patch_proposed'], patches: [] }).success,
    ).toBe(false);
  });

  it('rejects an empty root-cause nodeId on run:failed.error', () => {
    expect(
      RunEventSchema.safeParse({
        ...valid['run:failed'],
        error: { code: 'internal', message: 'x', retryable: false, nodeId: '' },
      }).success,
    ).toBe(false);
  });
});

describe('MaskedSecretSchema', () => {
  it('accepts a masked secret ({ secret: true, ref })', () => {
    expect(MaskedSecretSchema.safeParse({ secret: true, ref: 'keychain:openai' }).success).toBe(
      true,
    );
  });

  it('rejects a non-masked or ref-less value', () => {
    expect(MaskedSecretSchema.safeParse({ secret: false, ref: 'x' }).success).toBe(false); // secret must be literal true
    expect(MaskedSecretSchema.safeParse({ secret: true }).success).toBe(false); // ref required
    expect(MaskedSecretSchema.safeParse({ secret: true, ref: '' }).success).toBe(false); // ref non-empty
  });

  it('rejects an extra field — a raw secret can never ride alongside the masked shape', () => {
    expect(
      MaskedSecretSchema.safeParse({ secret: true, ref: 'keychain:openai', raw_value: 'sk-leak' })
        .success,
    ).toBe(false);
  });
});

describe('correlationId on the shared error shape (ADR-0036)', () => {
  it('accepts a non-empty correlationId on node:failed and run:failed', () => {
    expect(
      RunEventSchema.safeParse({
        ...valid['node:failed'],
        error: { code: 'tool_failed', message: 'boom', retryable: false, correlationId: 'corr-1' },
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({
        ...valid['run:failed'],
        error: { code: 'internal', message: 'boom', retryable: false, correlationId: 'corr-1' },
      }).success,
    ).toBe(true);
  });

  it('rejects an empty correlationId (nonEmptyString) on node:failed', () => {
    expect(
      RunEventSchema.safeParse({
        ...valid['node:failed'],
        error: { code: 'tool_failed', message: 'boom', retryable: false, correlationId: '' },
      }).success,
    ).toBe(false);
  });

  it('accepts a correlationId on a session:turn_completed error and rejects an empty one', () => {
    const base = { ...validSession['session:turn_completed'] };
    expect(
      SessionEventSchema.safeParse({
        ...base,
        error: {
          code: 'provider_rate_limit',
          message: 'slow',
          retryable: true,
          correlationId: 'c1',
        },
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        error: { code: 'provider_rate_limit', message: 'slow', retryable: true, correlationId: '' },
      }).success,
    ).toBe(false);
  });
});
