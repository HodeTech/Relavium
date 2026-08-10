import { describe, expect, expectTypeOf, it } from 'vitest';

import { RUN_EVENT_TYPES, SESSION_EVENT_TYPES } from './constants.js';
import {
  CostUpdatedEventSchema,
  MaskedSecretSchema,
  parseStoredRunEvent,
  RunEventSchema,
  SessionEventSchema,
  StopReasonSchema,
} from './run-event.js';
import type { RunEvent, RunEventType, SessionEvent, SessionEventType } from './index.js';

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
  'agent:reasoning': {
    type: 'agent:reasoning',
    ...env,
    nodeId: 'n',
    text: 'let me think',
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
  'agent:approval_requested': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: './out.txt' },
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
  'budget:estimate_committed': {
    type: 'budget:estimate_committed',
    ...env,
    nodeId: 'n',
    attemptNumber: 1,
    model: 'claude-opus-4-8',
    estimateMicrocents: 400,
    cumulativeConservativeMicrocents: 400,
  },
  'cost:attempt_settled': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'claude-opus-4-8',
    attemptNumber: 1,
    inputTokens: 10,
    outputTokens: 5,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
};

/** One targeted invalid payload per variant (a missing/invalid required field). */
const reject: Record<string, Record<string, unknown>> = {
  'budget:estimate_committed (no model)': {
    type: 'budget:estimate_committed',
    ...env,
    estimateMicrocents: 400,
    cumulativeConservativeMicrocents: 400,
  },
  'budget:estimate_committed (zero estimate)': {
    // Unreachable by construction — `#admit` refuses `<= 0` — and the bound must be right on the FIRST version:
    // tightening later would turn every historical zero row into a §5 corruption that must throw.
    type: 'budget:estimate_committed',
    ...env,
    model: 'm',
    estimateMicrocents: 0,
    cumulativeConservativeMicrocents: 0,
  },
  'budget:estimate_committed (fractional estimate)': {
    type: 'budget:estimate_committed',
    ...env,
    model: 'm',
    estimateMicrocents: 12.5,
    cumulativeConservativeMicrocents: 12.5,
  },
  'budget:estimate_committed (cumulative below this commitment)': {
    // The single most likely producer bug: reading the counter BEFORE the `+=`. That emits a first commitment as
    // `{estimate: 500, cumulative: 0}`, restores 0 on resume, and hands 500 micro-cents of already-owed money
    // back to the cap as headroom — with nothing else anywhere complaining.
    type: 'budget:estimate_committed',
    ...env,
    model: 'm',
    estimateMicrocents: 500,
    cumulativeConservativeMicrocents: 0,
  },
  'budget:estimate_committed (attemptNumber 0)': {
    type: 'budget:estimate_committed',
    ...env,
    model: 'm',
    attemptNumber: 0,
    estimateMicrocents: 400,
    cumulativeConservativeMicrocents: 400,
  },
  // ADR-0076. The first two pin the DIVERGENCES from this event's two siblings: `attemptNumber` and `priced` are
  // optional on `cost:updated` / `budget:estimate_committed` (they had historical rows) and REQUIRED here (it has
  // none). Loosening later stays additive; tightening later would be the one-way door `parseStoredRunEvent`
  // describes — so a test that lets either slip through optional is what makes the door close silently.
  'cost:attempt_settled (no attemptNumber)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (no priced)': {
    // Without the flag, `costMicrocents: 0` with real tokens is ambiguous between "unpriced" and "free" — the
    // exact ambiguity a ledger row exists to resolve.
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
  },
  'cost:attempt_settled (cumulative below this attempt)': {
    // The same producer bug the conservative twin pins: reading the run-wide counter BEFORE folding this
    // attempt into it. Reconstruction sums the deltas so the RESTORE survives it, which is precisely why
    // nothing else would complain — every display reading the snapshot just under-reports.
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 500,
    cumulativeCostMicrocents: 0,
    // `priced` is REQUIRED on this event, so omitting it here would reject the fixture on the MISSING FIELD and
    // never reach the refinement — a test that passes with the refinement deleted. It did, until a break-verify
    // caught it. Every fixture below carries a complete payload for the same reason: exactly one thing wrong.
    priced: true,
  },
  // `nodeId` and `model` are required too, and the file's own convention is to defend a required field with
  // a fixture — `budget:estimate_committed` has `(no model)`, `budget:paused` has `(missing/empty nodeId)`.
  // Without these, loosening either to `.optional()` reddens nothing, which is the same silent one-way door
  // the `attemptNumber`/`priced` fixtures exist to hold shut.
  'cost:attempt_settled (no nodeId)': {
    type: 'cost:attempt_settled',
    ...env,
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (empty nodeId)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: '',
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (no model)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (empty model)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: '',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (attemptNumber 0)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    attemptNumber: 0,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 400,
    cumulativeCostMicrocents: 400,
    priced: true,
  },
  'cost:attempt_settled (fractional cost)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: 12.5,
    // 13, not 12.5 — a fractional cumulative would reject this fixture on the CUMULATIVE field and leave
    // `costMicrocents`'s integer bound untested. One thing wrong per fixture, and it has to be the named one.
    cumulativeCostMicrocents: 13,
    priced: true,
  },
  'cost:attempt_settled (negative cost)': {
    type: 'cost:attempt_settled',
    ...env,
    nodeId: 'n',
    model: 'm',
    attemptNumber: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrocents: -1,
    cumulativeCostMicrocents: 0,
    priced: true,
  },
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
  'agent:reasoning (missing model)': { type: 'agent:reasoning', ...env, nodeId: 'n', text: 'hi' },
  'agent:reasoning (missing text)': {
    type: 'agent:reasoning',
    ...env,
    nodeId: 'n',
    model: 'claude-sonnet-4-6',
  },
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
  'agent:approval_requested (missing action)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'write_file',
    preview: { path: './out.txt' },
  },
  'agent:approval_requested (bad action)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'write_file',
    action: 'fs_read', // not a governed action class (only fs_write | process | egress | os)
    preview: { path: './out.txt' },
  },
  'agent:approval_requested (empty toolId)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: '',
    action: 'fs_write',
    preview: { path: './out.txt' },
  },
  'agent:approval_requested (empty preview path)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: '' }, // path/command/host are all nonEmptyString — an empty display value is rejected
  },
  'agent:approval_requested (egress preview carrying a path — action drift)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'http_request',
    action: 'egress',
    preview: { path: './out.txt' }, // an egress approval must carry `host` ONLY — a path is action drift (superRefine)
  },
  'agent:approval_requested (fs_write preview carrying a host — action drift)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'write_file',
    action: 'fs_write',
    preview: { host: 'evil.example' }, // fs_write carries `path` ONLY — a host is action drift
  },
  'agent:approval_requested (os preview carrying a path — action drift)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'read_clipboard',
    action: 'os',
    preview: { path: './leak.txt' }, // os carries NO field — any of path/command/host is drift
  },
  'agent:approval_requested (process preview carrying a host — action drift)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'run_command',
    action: 'process',
    preview: { host: 'evil.example' }, // process carries `command` ONLY — a host is action drift
  },
  'agent:approval_requested (empty preview command)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'run_command',
    action: 'process',
    preview: { command: '' }, // command was tightened to nonEmptyString (symmetry with path/host)
  },
  'agent:approval_requested (empty preview host)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'http_request',
    action: 'egress',
    preview: { host: '' },
  },
  'agent:approval_requested (stray secret-bearing preview field — .strict)': {
    type: 'agent:approval_requested',
    ...env,
    nodeId: 'n',
    toolId: 'http_request',
    action: 'egress',
    // .strict() on `preview` rejects an unexpected field LOUDLY — a host wiring bug that put a full
    // URL/query (a secret-bearing field) into the preview is a parse failure, not a silent strip.
    preview: { host: 'api.example.com', url: 'https://api.example.com/x?token=abc' },
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
  // #W15-7 / ADR-0074 §3: a frozen cost on an unfrozen basis. A resume would restore the old reservation
  // while RE-DERIVING the volume from a workflow definition the user may have edited in between — the exact
  // drift §3 exists to prevent, reintroduced through the half-populated case.
  'media_job:submitted (acceptedCostMicrocents without units)': {
    ...valid['media_job:submitted'],
    acceptedCostMicrocents: 1_500,
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

  it('ACCEPTS a BLANK approval preview for os and egress (the action-bind superRefine must not over-reject)', () => {
    // APPROVAL_PREVIEW_FIELD maps os → undefined (no field) and egress → host (OPTIONAL), so an all-empty
    // preview is VALID for read_clipboard/notify (os) and mcp_call/web_search (blank egress). A regression that
    // mis-resolved the allowed key would silently break the whole os / MCP approval class — pin the accept side.
    for (const [toolId, action] of [
      ['read_clipboard', 'os'],
      ['mcp_call', 'egress'],
    ] as const) {
      expect(
        RunEventSchema.safeParse({
          type: 'agent:approval_requested',
          ...env,
          nodeId: 'n',
          toolId,
          action,
          preview: {},
        }).success,
      ).toBe(true);
    }
  });

  it('REJECTS a blank approval preview for fs_write and process (their target is always resolved)', () => {
    // The mirror of the accept test above: fs_write / process ALWAYS resolve their path / command before the
    // gate (previewFor sets it from a mandatory policy target), so a blank preview is a host-wiring bug the
    // union-level refine rejects — while os / egress (above) legitimately stay blank.
    for (const [toolId, action] of [
      ['write_file', 'fs_write'],
      ['run_command', 'process'],
    ] as const) {
      expect(
        RunEventSchema.safeParse({
          type: 'agent:approval_requested',
          ...env,
          nodeId: 'n',
          toolId,
          action,
          preview: {},
        }).success,
      ).toBe(false);
    }
  });

  it('covers exactly the 25 canonical colon-namespaced names, pinned to a literal list', () => {
    // A hardcoded contract list — independent of RUN_EVENT_TYPES — so the union and the
    // constant cannot silently drift together.
    const CONTRACT_NAMES = [
      'run:started',
      'node:started',
      'agent:token',
      'agent:reasoning', // EA6 (2.5.H) — the reasoning counterpart of agent:token
      'agent:tool_call',
      'agent:tool_result',
      'agent:approval_requested',
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
      'budget:estimate_committed', // ADR-0074 §2 — a durable conservative commitment; an ESTIMATE, not spend
      'cost:attempt_settled', // ADR-0076 — the realized twin of the line above; the only DURABLE cost: event
    ];
    // The matrix above proves each canonical name's valid payload parses (so a
    // renamed/missing variant fails there); the union member count catches an *extra*
    // variant — without reaching into Zod's internal schema representation.
    // RunEventSchema wraps the union in the correlation-key refinement; reach the raw union.
    expect(RunEventSchema.innerType().options).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(RUN_EVENT_TYPES)).toEqual(new Set(CONTRACT_NAMES));
    expect(Object.keys(valid)).toEqual(CONTRACT_NAMES); // the matrix covers all 25
    // STRUCTURAL, not a comment: the §5 forward-compat fixtures stand in for "a type a newer binary wrote" using
    // the `test:` prefix. Step B first used `budget:estimate_committed` for that and ADR-0074 §2 then made it
    // real, silently inverting three fixtures. A `test:`-prefixed name must never become a canonical event.
    expect([...RUN_EVENT_TYPES, ...SESSION_EVENT_TYPES].some((t) => t.startsWith('test:'))).toBe(
      false,
    );
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
  'session:compacting': { type: 'session:compacting', ...senv, reason: 'manual' },
  'session:compacted': {
    type: 'session:compacted',
    ...senv,
    reason: 'manual',
    summary: 'earlier we set up the project and configured the db',
    keptMessageCount: 2,
    tokensBefore: 14200,
    tokensAfter: 900,
    tokensUsed: { input: 14000, output: 340 },
  },
  'session:trimmed': {
    type: 'session:trimmed',
    ...senv,
    reason: 'manual',
    keptMessageCount: 20,
    droppedMessageCount: 8,
  },
};

describe('SessionEvent union — the agent-first namespace', () => {
  it.each(Object.keys(validSession))('accepts a valid %s', (name) => {
    expect(SessionEventSchema.safeParse(validSession[name]).success).toBe(true);
  });

  it('covers exactly the eight session:* names, pinned to a literal list', () => {
    const CONTRACT_NAMES = [
      'session:started',
      'session:turn_started',
      'session:turn_completed',
      'session:cancelled',
      'session:exported',
      'session:compacting', // ADR-0062 — the "Summarizing…" moment START
      'session:compacted', // ADR-0062
      'session:trimmed', // ADR-0062
    ];
    expect(SessionEventSchema.options).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(SESSION_EVENT_TYPES)).toEqual(new Set(CONTRACT_NAMES));
    expect(Object.keys(validSession)).toEqual(CONTRACT_NAMES);
  });

  it('binds session:compacting.reason to the two-value enum (ADR-0062 — the moment START)', () => {
    const ok = validSession['session:compacting'];
    expect(SessionEventSchema.safeParse(ok).success).toBe(true);
    // Symmetric with session:compacted.reason — manual / auto-threshold (NOT auto-fallback, which is a trim).
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'auto-threshold' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'auto-fallback' }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'nope' }).success).toBe(false);
  });

  it('binds session:compacted.reason to the two-value enum and requires a non-empty summary (ADR-0062)', () => {
    const ok = validSession['session:compacted'];
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'auto-threshold' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'nope' }).success).toBe(false);
    // A compaction always carries summary text (it is what becomes the preamble) + its real spend.
    expect(SessionEventSchema.safeParse({ ...ok, summary: '' }).success).toBe(false);
    // Omitting the summarization spend is rejected (constructed fresh so the omission is well-typed).
    expect(
      SessionEventSchema.safeParse({
        type: 'session:compacted',
        ...senv,
        reason: 'manual',
        summary: 's',
        keptMessageCount: 2,
        tokensBefore: 1,
        tokensAfter: 1,
      }).success,
    ).toBe(false);
  });

  it('accepts a summary-less session:trimmed (deterministic drop, no cost — ADR-0062)', () => {
    const ok = validSession['session:trimmed'];
    expect(SessionEventSchema.safeParse(ok).success).toBe(true);
    // A trim spends nothing: it carries neither summary nor tokensUsed — a compacted-shaped payload is a
    // distinct arm, so an unknown extra key on this closed union member is stripped, not silently accepted
    // as a compaction. Counts must be non-negative ints.
    expect(SessionEventSchema.safeParse({ ...ok, keptMessageCount: -1 }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...ok, droppedMessageCount: -1 }).success).toBe(false);
    // `reason` is the two-value enum (manual / auto-fallback — the view surfaces the auto-fallback trim, ADR-0062).
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'auto-fallback' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...ok, reason: 'nope' }).success).toBe(false);
  });

  it('binds session:compacted counts to nonNegativeInt (ADR-0062)', () => {
    const ok = validSession['session:compacted'];
    for (const field of ['keptMessageCount', 'tokensBefore', 'tokensAfter'] as const) {
      expect(SessionEventSchema.safeParse({ ...ok, [field]: -1 }).success).toBe(false);
    }
  });

  it('pins the SessionEvent discriminant to SessionEventType (type-level)', () => {
    expectTypeOf<SessionEvent['type']>().toEqualTypeOf<SessionEventType>();
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

  it('binds session:turn_completed.stopReason to the SESSION stop-reason enum (the five LLM values + aborted)', () => {
    const ok = validSession['session:turn_completed'];
    expect(SessionEventSchema.safeParse({ ...ok, stopReason: 'tool_use' }).success).toBe(true);
    // EA7 (ADR-0057): the session superset adds `aborted` (the mid-turn abort) — accepted here, but NOT in
    // the LLM StopReason vocabulary (the @relavium/llm seam stays the clean five values). Pin BOTH halves
    // co-located: the LLM StopReason has exactly five members and REJECTS 'aborted'.
    expect(SessionEventSchema.safeParse({ ...ok, stopReason: 'aborted' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...ok, stopReason: 'banana' }).success).toBe(false);
    expect(StopReasonSchema.options).toHaveLength(5);
    expect(StopReasonSchema.safeParse('aborted').success).toBe(false);
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
  it('enforces exactly one of runId / sessionId on the dual-envelope events', () => {
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

  it('accepts a FRACTIONAL media-job units volume (ADR-0074 §3)', () => {
    // `duration_seconds` is `z.number().positive()`, so `units = duration × count` is fractional by contract.
    // An integer bound here would reject a 12.5-second video job at the bus — and the row is written AFTER the
    // provider has accepted and billed the job, so the run would die holding an unpollable paid job.
    const base = {
      type: 'media_job:submitted',
      runId: 'run-1',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 3,
      nodeId: 'gen',
      jobId: 'j1',
      provider: 'openai',
      model: 'sora-2',
      modality: 'video',
      startedAt: '2026-06-04T00:00:00.000Z',
      deadlineAt: '2026-06-04T01:00:00.000Z',
    };
    expect(
      RunEventSchema.safeParse({ ...base, units: 12.5, acceptedCostMicrocents: 900 }).success,
    ).toBe(true);
    expect(RunEventSchema.safeParse({ ...base, units: 0 }).success).toBe(false); // still a positive volume
    expect(RunEventSchema.safeParse({ ...base, units: -1 }).success).toBe(false);
    // The MONEY field stays an integer — micro-cents are not fractional.
    expect(RunEventSchema.safeParse({ ...base, acceptedCostMicrocents: 1.5 }).success).toBe(false);
  });

  it('carries budget:estimate_committed on either envelope (dual), and drops nodeId on a session turn (ADR-0074 §2)', () => {
    const base = {
      type: 'budget:estimate_committed',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 7,
      model: 'claude-opus-4-8',
      estimateMicrocents: 500,
      cumulativeConservativeMicrocents: 500,
    };
    // A run carries nodeId; a session turn has no node, so the field is genuinely ABSENT rather than empty. That
    // matters beyond coverage: this is the first run event with an OPTIONAL top-level `nodeId`, and the store's
    // `'nodeId' in event ? event.nodeId : null` projection depends on Zod omitting an absent optional key.
    const asRun = RunEventSchema.safeParse({ ...base, runId: 'run-1', nodeId: 'n' });
    expect(asRun.success).toBe(true);
    const asSession = RunEventSchema.safeParse({ ...base, sessionId: 'sess-1' });
    expect(asSession.success).toBe(true);
    if (asSession.success) {
      expect('nodeId' in asSession.data).toBe(false);
    }
    // neither / both → rejected (the same dualBase invariant agent:token obeys)
    expect(RunEventSchema.safeParse(base).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, runId: 'r', sessionId: 's' }).success).toBe(false);
  });

  it('pins the conservative cumulative to include this commitment (the read-before-increment bug)', () => {
    const base = {
      type: 'budget:estimate_committed',
      runId: 'run-1',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 7,
      model: 'm',
      estimateMicrocents: 500,
    };
    expect(
      RunEventSchema.safeParse({ ...base, cumulativeConservativeMicrocents: 500 }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({ ...base, cumulativeConservativeMicrocents: 900 }).success,
    ).toBe(true); // a later commitment
    const bad = RunEventSchema.safeParse({ ...base, cumulativeConservativeMicrocents: 499 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      // The error lands on the cumulative, not on an unrelated field — so the message names the actual mistake.
      expect(
        bad.error.issues.some((i) => i.path.includes('cumulativeConservativeMicrocents')),
      ).toBe(true);
    }
  });

  it('carries agent:reasoning on either envelope (dual), like agent:token (EA6, 2.5.H)', () => {
    const base = {
      type: 'agent:reasoning',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 5,
      nodeId: 'n',
      text: 'thinking about it',
      model: 'claude-sonnet-4-6',
    };
    // exactly one correlation key → accepted (run-flavored, then session-flavored)
    expect(RunEventSchema.safeParse({ ...base, runId: 'run-1' }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...base, sessionId: 'sess-1' }).success).toBe(true);
    // neither / both → rejected (the same dualBase invariant agent:token obeys)
    expect(RunEventSchema.safeParse(base).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, runId: 'r', sessionId: 's' }).success).toBe(false);
    // agent:reasoning carries no attemptNumber (it mirrors agent:token, not the cost/tool carriers)
    expect(SessionEventSchema.safeParse({ ...base, sessionId: 'sess-1' }).success).toBe(false); // it's a RunEvent arm, not a session:* lifecycle arm
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
      'agent:approval_requested',
      'node:completed',
      'cost:updated',
      'agent:file_patch_proposed',
    ]) {
      expect(RunEventSchema.safeParse({ ...valid[name], attemptNumber: 2 }).success).toBe(true);
      expect(RunEventSchema.safeParse({ ...valid[name], attemptNumber: 0 }).success).toBe(false);
    }
  });

  it('carries agent:approval_requested on either envelope (dual) with a secret-free preview (ADR-0057 EA5)', () => {
    const base = {
      type: 'agent:approval_requested',
      timestamp: '2026-06-04T00:00:00.000Z',
      sequenceNumber: 9,
      nodeId: 'n',
      toolId: 'run_command',
      action: 'process',
      preview: { command: 'npm test' },
    };
    // dual: accepted on a run (runId) AND on a session (sessionId), rejected with neither / both.
    expect(RunEventSchema.safeParse({ ...base, runId: 'run-1' }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...base, sessionId: 'sess-1' }).success).toBe(true);
    expect(RunEventSchema.safeParse(base).success).toBe(false); // neither correlation key
    expect(RunEventSchema.safeParse({ ...base, runId: 'r', sessionId: 's' }).success).toBe(false); // both
    // egress preview carries the host only (a secret-free, query-free target)
    expect(
      RunEventSchema.safeParse({
        ...base,
        sessionId: 'sess-1',
        toolId: 'http_request',
        action: 'egress',
        preview: { host: 'api.example.com' },
      }).success,
    ).toBe(true);
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

describe('parseStoredRunEvent — the forward-compatible read (ADR-0074 §5)', () => {
  const known = {
    type: 'run:started' as const,
    runId: 'r1',
    sequenceNumber: 0,
    timestamp: '2026-07-30T00:00:00.000Z',
    workflowId: '11111111-2222-4333-8444-555555555555', // surrogate UUID per ADR-0022
    inputs: {},
    executionMode: 'local' as const,
  };

  it('parses a known event exactly as the strict schema does — validated and stripped, not passed through', () => {
    expect(parseStoredRunEvent(known)).toEqual(RunEventSchema.parse(known));
    // The other half of the same §Forward-compatibility sentence: consumers ignore unknown FIELDS too. A newer
    // binary adding an optional field (ADR-0074 §3 does exactly this to `media_job:submitted`) must not make the
    // row unreadable — and the returned object must be the STRIPPED parse output, not the raw candidate. Pins the
    // `return candidate as RunEvent` shortcut as a failure.
    const withFutureField = { ...known, someFutureField: 1 };
    expect(parseStoredRunEvent(withFutureField)).toEqual(RunEventSchema.parse(known));
    expect(parseStoredRunEvent(withFutureField)).not.toHaveProperty('someFutureField');
  });

  it('DROPS an unknown event type — a newer writer, not corruption', () => {
    // The whole point: the strict schema throws here, which made one row from a newer binary render an entire
    // run unreadable. `sse-event-schema.md` promises consumers ignore unknown types; this is that promise.
    expect(
      parseStoredRunEvent({
        // A name reserved for these tests and deliberately never added to the union. The first draft used
        // `budget:estimate_committed` as the stand-in for "a newer writer" — which then LANDED (ADR-0074 §2) and
        // silently turned this fixture into a KNOWN type. The pinned-contract test caught it, but the lesson is
        // the fixture's: a forward-row stand-in must name something that will never become real.
        type: 'test:never_a_real_event',
        runId: 'r1',
        sequenceNumber: 1,
        timestamp: '2026-07-30T00:00:00.000Z',
        estimateMicrocents: 500,
      }),
    ).toBeUndefined();
    // And the strict schema still rejects it, so the write side is unchanged.
    expect(() => RunEventSchema.parse({ type: 'test:never_a_real_event' })).toThrow();
  });

  it('THROWS on a known type with a damaged body — corruption is never swallowed', () => {
    // The distinction that keeps ADR-0050's durability posture: a row we can identify but not read is a
    // damaged row, and hiding it would lose data silently.
    expect(() => parseStoredRunEvent({ ...known, runId: '' })).toThrow();
    expect(() => parseStoredRunEvent({ ...known, sequenceNumber: -1 })).toThrow();
    expect(() => parseStoredRunEvent({ ...known, workflowId: undefined })).toThrow();
  });

  it('THROWS on something that is not an event at all', () => {
    expect(() => parseStoredRunEvent({ nope: true })).toThrow();
    expect(() => parseStoredRunEvent(null)).toThrow();
    expect(() => parseStoredRunEvent('run:started')).toThrow();
  });

  it('THROWS on a row with no usable `type` — Zod cannot tell it apart, so we do', () => {
    // Zod raises the SAME `invalid_union_discriminator` for a missing discriminator as for an unrecognized one.
    // They are opposites: no writer of ours has ever omitted `type`, so this is a damaged row.
    expect(() => parseStoredRunEvent({ ...known, type: undefined })).toThrow();
    expect(() => parseStoredRunEvent({ ...known, type: '' })).toThrow();
    expect(() => parseStoredRunEvent({ ...known, type: 7 })).toThrow();
    expect(() => parseStoredRunEvent({ ...known, type: null })).toThrow();
  });

  it('drops a forward-written row whatever its body looks like', () => {
    // Both drop: the row is unreadable either way, and we could not judge the body of a variant we do not know.
    expect(parseStoredRunEvent({ type: 'some:future_event' })).toBeUndefined();
    expect(
      parseStoredRunEvent({ type: 'some:future_event', sequenceNumber: 'not-a-number' }),
    ).toBeUndefined();
  });
});

/**
 * ADR-0074 §3 freezes the media-job basis at SUBMIT time. The invariant is a one-way implication, not
 * "both or neither" (#W15-7) — so the guard has to reject the half-frozen case WITHOUT rejecting the
 * legitimate units-only one.
 */
describe('media_job:submitted — the frozen basis (#W15-7)', () => {
  const base = valid['media_job:submitted'];

  it('accepts units alone — the H3 approved-bypass freezes the volume and omits the cost on purpose', () => {
    // No pricing hook ran on that path, and `0` would freeze "priced at zero" for a job that was never
    // priced. Rejecting this would break the bypass outright.
    expect(RunEventSchema.safeParse({ ...base, units: 12.5 }).success).toBe(true);
  });

  it('accepts both together, with a FRACTIONAL volume', () => {
    // `duration_seconds` is fractional by contract; an integer bound here would make a 12.5-second video
    // job unwritable after the provider had already accepted and billed it.
    expect(
      RunEventSchema.safeParse({ ...base, units: 12.5, acceptedCostMicrocents: 1_500 }).success,
    ).toBe(true);
  });

  it('accepts a reserved-nothing commitment, which is distinct from absent', () => {
    // `0` says "priced, reserved nothing" — the allow-degrade path for an unpriced model under a
    // non-strict cap. It still needs its basis.
    expect(RunEventSchema.safeParse({ ...base, units: 4, acceptedCostMicrocents: 0 }).success).toBe(
      true,
    );
  });

  it('accepts neither — a legacy row written before §3', () => {
    expect(RunEventSchema.safeParse(base).success).toBe(true);
  });
});
