/**
 * 1.U — the End-to-end Node harness (the **M2** critical-path milestone). The proof that the engine works
 * end-to-end before any surface exists: it composes 1.K (FallbackChain) / 1.N (run loop + RunEventBus) /
 * 1.O (AgentRunner) / 1.P (node handlers) / 1.Q (human gate) / 1.R (checkpoint/resume) / 1.S (node retry) /
 * 1.T (ToolRegistry) / 1.AB (ExpressionSandbox) behind the `@relavium/llm` seam, using only already-exported `@relavium/core` symbols
 * and the in-memory `ExecutionHost` reference — zero platform imports, no live network/keys, deterministic.
 *
 * This is a **scenario suite** (the seed the Phase-2 CLI regression harness, 2.K, grows from — see
 * docs/roadmap/phases/phase-1-engine-and-llm.md §1.U *Harness shape*). Its members:
 *  • **happy-path** — the literal 3-node `input → agent → output` (a clean run, with a tool call): live
 *    token streaming, per-attempt cost, a gap-free `sequenceNumber` stream that validates against the
 *    canonical {@link RunEventSchema}.
 *  • **flagship** — `input → agent → human_gate → output`: in ONE run across a process boundary, the agent's
 *    forced provider error → **node retry** (ADR-0040) → **failover** to the second chain entry (1.K), with
 *    per-attempt cost; then a pause at the gate (the durable mid-run checkpoint persisted to the
 *    SQLite-shaped store); then a **fresh engine** resumes via `resumeFromCheckpoint` and runs `output` to
 *    `run:completed`, reproducing the same final output with `sequenceNumber` continuing gap-free. The
 *    `human_in_the_loop` gate is the durable suspend point because the Phase-1 engine resumes ONLY from a
 *    gate/budget pause — a gate-less interrupted run is reconciled to `run:failed` (ADR-0036). All LLM cost is
 *    incurred pre-gate and is RESTORED across the resume (run:completed.totalCostMicrocents) — the durable
 *    node:completed.cumulativeCostMicrocents carries it, closing the cost-event-persistence gap.
 *  • **determinism** — the same scenario produces an identical event signature + final output on a re-run
 *    (the no-wall-clock / no-RNG ban the risk table binds to this harness).
 *
 * The local stub helpers mirror `agent-runner.e2e.test.ts` (the project's e2e convention keeps them inline,
 * not on the curated public surface).
 */

import type {
  CapabilityFlags,
  LlmProvider,
  MediaJobStatus,
  PricingOverlay,
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
import {
  RunEventSchema,
  type AbortSignalLike,
  type ContentPart,
  type MediaReferencePort,
  type DurableWriteContext,
  type MediaStore,
  type RunEvent,
} from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import { parseWorkflow } from '../parser.js';
import type { ToolDef as CoreToolDef, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { createAppendAudit, formatAppendAudit } from './append-audit.js';
import { reconstructCheckpointState } from './checkpoint.js';
import { WorkflowEngine } from './engine.js';
import { checkDurableTruth, formatDurableTruth } from './durable-truth.js';
import {
  createInMemoryHost,
  createInMemoryTerminalOutbox,
  InMemoryRunStore,
  type RunStore,
} from './execution-host.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';
import type { RunHandle } from './run-handle.js';

// --- LLM-provider stubs (mirror agent-runner.e2e.test.ts) -------------------------------------------

const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

/** A provider whose `stream` replays the SAME chunk list every call (e.g. an always-failing primary). */
function provider(chunks: StreamChunk[], id: ProviderId = 'anthropic'): LlmProvider {
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('generate not used in the harness');
    },
    stream: () => streamOf(chunks),
  };
}

/** A provider that replays a DIFFERENT chunk list per call (call N → scripts[N]) — drives tool/retry turns. */
function scriptedProvider(scripts: StreamChunk[][], id: ProviderId = 'anthropic'): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('generate not used in the harness');
    },
    stream: () => {
      // Fail fast on an UNSCRIPTED call — an unintended extra LLM invocation is a harness bug, not a
      // silent empty turn (which would mask, e.g., a retry/failover that re-dispatched more than expected).
      const chunks = scripts[call];
      call += 1;
      if (chunks === undefined) {
        throw new Error(
          `scriptedProvider: unexpected stream call #${call} (only ${scripts.length} scripted)`,
        );
      }
      return streamOf(chunks);
    },
  };
}

const usage = { inputTokens: 10, outputTokens: 5 };
const STOP = (reason: 'stop' | 'tool_use' = 'stop'): StreamChunk => ({
  type: 'stop',
  stopReason: reason,
  usage,
});
const textTurn = (text: string): StreamChunk[] => [{ type: 'text_delta', text }, STOP('stop')];
const toolUseTurn = (id: string): StreamChunk[] => [
  { type: 'tool_call_start', id, name: 'echo' },
  { type: 'tool_call_end', id },
  STOP('tool_use'),
];
const retryableError = (providerId: ProviderId): StreamChunk => ({
  type: 'error',
  error: { kind: 'overloaded', retryable: true, provider: providerId, message: 'busy' },
});

/** Caps advertising inline image output (chat surface) — so the chain keeps a media-output model. */
const MEDIA_CAPS: CapabilityFlags = {
  ...CAPS,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['text', 'image']],
    surface: 'chat',
  },
};

/** A 5-byte in-flight base64 image part — the media-out fixture ("hello"). Typed as the media variant so it
 *  satisfies both a `ContentPart[]` (inline turn) and `MediaGenResult.media` (generative) without a cast. */
const IMAGE_PART: Extract<ContentPart, { type: 'media' }> = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'base64', data: 'aGVsbG8=' },
};

/** A provider whose non-streaming generate() returns inline media; its stream THROWS (media routes to generate). */
function mediaProvider(id: ProviderId = 'gemini'): LlmProvider {
  return {
    id,
    supports: MEDIA_CAPS,
    generate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'here is your image' }, IMAGE_PART],
        stopReason: 'stop',
        usage,
      }),
    stream: (): AsyncIterable<StreamChunk> => {
      throw new Error('stream must NOT run for an inline media-out turn');
    },
  };
}

/** A provider flagged media_surface 'generative' whose generateMedia returns a SYNC image (1.AG Section C);
 *  generate/stream THROW — proving a generative node routes to the separate endpoint, never the inline turn. */
function generativeMediaProvider(id: ProviderId = 'openai'): LlmProvider {
  return {
    id,
    supports: { ...MEDIA_CAPS, media: { ...MEDIA_CAPS.media, surface: 'generative' } },
    generate: () => {
      throw new Error('generate must NOT run for a generative node');
    },
    stream: (): AsyncIterable<StreamChunk> => {
      throw new Error('stream must NOT run for a generative node');
    },
    generateMedia: () => Promise.resolve({ media: IMAGE_PART, raw: { internal: true } }),
  };
}

/** A provider whose generateMedia SUBMITS an async job ({ jobId }) and whose pollMediaJob replays a scripted
 *  MediaJobStatus sequence (call N → script[N]; the last entry repeats). generate/stream throw. Records the
 *  generateMedia + pollMediaJob call counts (the re-attach test asserts generateMedia is called ONCE). */
function asyncMediaProvider(
  script: readonly MediaJobStatus[],
  id: ProviderId = 'openai',
): { provider: LlmProvider; generateCalls: () => number; pollCalls: () => number } {
  let generateCalls = 0;
  let pollCalls = 0;
  const provider: LlmProvider = {
    id,
    supports: { ...MEDIA_CAPS, media: { ...MEDIA_CAPS.media, surface: 'generative' } },
    generate: () => {
      throw new Error('generate must NOT run for a generative node');
    },
    stream: (): AsyncIterable<StreamChunk> => {
      throw new Error('stream must NOT run for a generative node');
    },
    generateMedia: () => {
      generateCalls += 1;
      return Promise.resolve({ jobId: 'job-1', raw: { internal: true } });
    },
    pollMediaJob: (jobId: string, _key: string, signal?: AbortSignalLike) => {
      if (signal?.aborted === true) {
        return Promise.reject(new Error('poll aborted')); // a run cancel aborts the in-flight poll (ADR-0045 §4)
      }
      if (jobId !== 'job-1') {
        // The engine must re-poll the PERSISTED opaque jobId generateMedia returned — especially across a
        // cross-process resume RE-ATTACH (MJ-1). A mismatch means a wrong/regenerated id is being polled.
        return Promise.reject(
          new Error(
            `pollMediaJob got unexpected jobId '${jobId}' (expected the persisted 'job-1')`,
          ),
        );
      }
      const status = script[Math.min(pollCalls, script.length - 1)];
      pollCalls += 1;
      return Promise.resolve(status ?? { state: 'pending' });
    },
  };
  return { provider, generateCalls: () => generateCalls, pollCalls: () => pollCalls };
}

/**
 * Drive a run that parks on an async media job to its terminal. A `pending` poll re-arms a timer but emits NO
 * event (progress is transient — ADR-0045 §2), so the run cannot be driven purely off the event stream: consume
 * events in the background and FIRE armed poll timers until the run settles (each fire = one poll). `onPaused`
 * (e.g. cross-process resume / cancel) runs once when the run first parks.
 */
async function driveMediaRun(
  handle: RunHandle,
  host: Host,
  onPaused?: () => Promise<void> | void,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let settled = false;
  let paused = false;
  const consume = (async (): Promise<void> => {
    for await (const event of handle.events) {
      events.push(event);
      if (
        event.type === 'run:completed' ||
        event.type === 'run:failed' ||
        event.type === 'run:cancelled'
      ) {
        settled = true;
      }
    }
  })();
  let guard = 0;
  while (!settled) {
    await Promise.resolve();
    if (!paused && events.some((e) => e.type === 'run:paused')) {
      paused = true;
      if (onPaused !== undefined) await onPaused();
    }
    if (host.armedCount() > 0) {
      host.fireTimers();
    }
    if ((guard += 1) > 100_000) {
      throw new Error('driveMediaRun did not settle');
    }
  }
  await consume;
  return events;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Extract the first media handle ref from a `{ media: [{ source: { ref } }] }` node output via a runtime
 *  guard (no unsafe cast) — the de-inlined durable form both media-out e2e tests assert. */
function firstMediaRef(out: unknown): string | undefined {
  if (!isRecord(out) || !Array.isArray(out['media'])) return undefined;
  const first: unknown = out['media'][0];
  if (!isRecord(first) || !isRecord(first['source'])) return undefined;
  const ref = first['source']['ref'];
  return typeof ref === 'string' ? ref : undefined;
}

/** A pure fake-digest in-memory MediaStore (no crypto) — content-addressed enough for the e2e. */
function stubMediaStore(): MediaStore {
  const puts: { handle: string; bytes: Uint8Array }[] = [];
  const digest = (bytes: Uint8Array): string => {
    let hex = '';
    for (let seed = 0; seed < 8; seed += 1) {
      let h = (2166136261 ^ (seed * 0x9e3779b1)) >>> 0;
      for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
      hex += h.toString(16).padStart(8, '0');
    }
    return hex;
  };
  return {
    put: (bytes) => {
      const handle = `media://sha256-${digest(bytes)}`;
      puts.push({ handle, bytes });
      return Promise.resolve(handle);
    },
    get: (handle) => {
      const found = puts.find((p) => p.handle === handle);
      return found === undefined
        ? Promise.reject(new Error('no bytes'))
        : Promise.resolve(found.bytes);
    },
    resolveForEgress: () => Promise.reject(new Error('unused by this test')),
    readRange: () => Promise.reject(new Error('unused by this test')),
  };
}

// --- Tool stubs: a sanitized echo registry + its LLM-visible def (mirror agent-runner.e2e.test.ts) ----

const echoRegistry: ToolRegistry = {
  has: () => true,
  list: () => ['echo'],
  dispatch: (call) => {
    const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'TOOL-OK' };
    return Promise.resolve({
      output: 'TOOL-OK',
      toolResult: markUntrusted(result),
      truncated: false,
      events: {
        call: { toolId: call.name, toolInput: {} },
        result: { toolId: call.name, success: true, outputSummary: 'TOOL-OK' },
      },
    });
  },
};

const echoToolDef: CoreToolDef = {
  id: 'echo',
  source: 'builtin',
  description: 'echo',
  parseArgs: (raw) => raw,
  llmVisibleParams: { type: 'object' },
  policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
  dispatch: () => Promise.reject(new Error('echoToolDef dispatch is not used directly')),
};

// --- Canonical workflows --------------------------------------------------------------------------

/** Happy path — the literal 3-node sequential workflow, with a tool call (§1.U tasks bullet a). */
const HAPPY_PATH = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-happy
  inputs:
    - { name: topic, type: string }
  agents:
    - id: writer
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
      tools: [echo]
  nodes:
    - { id: in, type: input }
    - { id: work, type: agent, agent_ref: writer, prompt_template: 'Summarize: {{inputs.topic}}' }
    - { id: out, type: output }
  edges:
    - { from: in, to: work }
    - { from: work, to: out }
`,
);

/** Two independent agent nodes with no edge between them — genuine engine concurrency under `max_parallel: 2`. */
const PARALLEL_PAIR = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-parallel-pair
  max_parallel: 2
  inputs:
    - { name: topic, type: string }
  agents:
    - id: writer
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
  nodes:
    - { id: a, type: agent, agent_ref: writer, prompt_template: 'One: {{inputs.topic}}' }
    - { id: b, type: agent, agent_ref: writer, prompt_template: 'Two: {{inputs.topic}}' }
  edges: []
`,
);

/** Flagship — adds a human gate as the durable mid-run checkpoint; the agent fails over with a retry budget. */
const FLAGSHIP = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-flagship
  inputs:
    - { name: topic, type: string }
  agents:
    - id: writer
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
      retry: { max: 2, backoff: linear, backoff_ms: 10 }
      fallback_chain:
        - { model: claude-sonnet-4-6, provider: openai, max_attempts: 1 }
  nodes:
    - { id: in, type: input }
    - { id: work, type: agent, agent_ref: writer, prompt_template: 'Summarize: {{inputs.topic}}' }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: in, to: work }
    - { from: work, to: g }
    - { from: g, to: out }
`,
);

/** Inline media-out — an agent node requesting image output (1.AG Section B, ADR-0046). */
const MEDIA_OUT = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-media-out
  inputs:
    - { name: topic, type: string }
  agents:
    - id: painter
      model: gemini-2.5-flash
      provider: gemini
      system_prompt: You make images.
  nodes:
    - { id: in, type: input }
    - { id: work, type: agent, agent_ref: painter, prompt_template: 'Draw: {{inputs.topic}}', output_modalities: [text, image] }
    - { id: out, type: output }
  edges:
    - { from: in, to: work }
    - { from: work, to: out }
`,
);

/** Generative media-out — an agent node on a media_surface:'generative' model (1.AG Section C, ADR-0045). */
const GENERATIVE_OUT = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-generative-out
  inputs:
    - { name: topic, type: string }
  agents:
    - id: painter
      model: gpt-image-1
      provider: openai
      system_prompt: You make images.
  nodes:
    - { id: in, type: input }
    - { id: work, type: agent, agent_ref: painter, prompt_template: 'Draw: {{inputs.topic}}', output_modalities: [image], count: 1 }
    - { id: out, type: output }
  edges:
    - { from: in, to: work }
    - { from: work, to: out }
`,
);

/** GENERATIVE_OUT after same-slug CONTENT drift — identical `workflow.id` (so the resume identity guard, which
 *  compares only the surrogate id, passes) but the `work` media node is GONE (in→out direct). Resuming a
 *  checkpoint whose pendingMediaJobs references `work` against this drifted plan exercises the orphaned-vertex
 *  path in #pollMediaJob (vertex === undefined). */
const GENERATIVE_OUT_DRIFTED = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-generative-out
  inputs:
    - { name: topic, type: string }
  nodes:
    - { id: in, type: input }
    - { id: out, type: output }
  edges:
    - { from: in, to: out }
`,
);

/** A human gate AND a generative media node parked CONCURRENTLY (1.AG Section D, AG-A-FC-3) — two parallel
 *  branches from `in`, joined at `out`. The resume applies the gate decision while the media job re-attaches. */
const GATE_AND_MEDIA = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-gate-and-media
  inputs:
    - { name: topic, type: string }
  agents:
    - id: painter
      model: gpt-image-1
      provider: openai
      system_prompt: You make images.
  nodes:
    - { id: in, type: input }
    - { id: gen, type: agent, agent_ref: painter, prompt_template: 'Draw: {{inputs.topic}}', output_modalities: [image], count: 1 }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: in, to: gen }
    - { from: in, to: g }
    - { from: gen, to: out }
    - { from: g, to: out }
`,
);

// GATE_AND_MEDIA plus a whole-run `timeout_ms` — used ONLY by the abandon() guard test, which rejects a resume
// WITHOUT ever firing timers (so the inert 1h timeout never trips the manual controller, unlike the timer-firing
// driveMediaRun tests). It exists so the rejected-resume armedCount()===0 assertion also covers abandon()'s
// run-timeout disarm leg (#runTimeoutDisarm), not just the media-poll leg.
const GATE_AND_MEDIA_TIMED = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-gate-and-media-timed
  timeout_ms: 3600000
  inputs:
    - { name: topic, type: string }
  agents:
    - id: painter
      model: gpt-image-1
      provider: openai
      system_prompt: You make images.
  nodes:
    - { id: in, type: input }
    - { id: gen, type: agent, agent_ref: painter, prompt_template: 'Draw: {{inputs.topic}}', output_modalities: [image], count: 1 }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: in, to: gen }
    - { from: in, to: g }
    - { from: gen, to: out }
    - { from: g, to: out }
`,
);

/** Two independent async-media submissions: a parked job is slot-free but its priced admission must stay live. */
const BUDGETED_ASYNC_MEDIA_PARALLEL = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-budgeted-async-media-parallel
  max_parallel: 1
  budget:
    max_cost_microcents: 1500
    on_exceed: fail
  agents:
    - id: painter
      model: budget-media-model
      provider: openai
      system_prompt: You make images.
  nodes:
    - { id: n1, type: agent, agent_ref: painter, prompt_template: 'Draw one', output_modalities: [image], count: 1 }
    - { id: n2, type: agent, agent_ref: painter, prompt_template: 'Draw two', output_modalities: [image], count: 1 }
  edges: []
`,
);

/** A parked media job and a human gate; resuming the gate reveals whether the parked-job reservation was restored. */
const BUDGETED_ASYNC_MEDIA_RESUME = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-budgeted-async-media-resume
  max_parallel: 2
  budget:
    max_cost_microcents: 1500
    on_exceed: fail
  agents:
    - id: painter
      model: budget-media-model
      provider: openai
      system_prompt: You make images.
  nodes:
    - { id: gen, type: agent, agent_ref: painter, prompt_template: 'Draw one', output_modalities: [image], count: 1 }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: after, type: agent, agent_ref: painter, prompt_template: 'Draw two', output_modalities: [image], count: 1 }
  edges:
    - { from: g, to: after }
`,
);

/** A synthetic user-priced generative model: the shipped catalog intentionally has no media rates yet. */
/**
 * Two sequential text agents under a cap — the ADR-0074 §1/§2 conservative-commitment path.
 *
 * `n1`'s provider ends its stream with NO terminal usage (a clean EOF / partial-stream failure, which
 * ADR-0074's Context calls routine). The turn therefore CANNOT release the reservation — the provider may
 * already have billed — so it is retained conservatively and made DURABLE. The cap is sized so exactly one
 * worst-case call fits: if the retained amount survives, `n2` must be refused.
 */
const BUDGETED_TEXT_CONSERVATIVE = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-budgeted-text-conservative
  max_parallel: 1
  budget:
    max_cost_microcents: 1500
    on_exceed: fail
  agents:
    - id: writer
      model: budget-text-model
      provider: anthropic
      system_prompt: You write.
      max_tokens: 1000
  nodes:
    - { id: n1, type: agent, agent_ref: writer, prompt_template: 'One' }
    - { id: n2, type: agent, agent_ref: writer, prompt_template: 'Two' }
  edges:
    - { from: n1, to: n2 }
`,
);

/**
 * The same conservative path with a GATE between the two agents, so process 1 can pause and a fresh process
 * must reconstruct the commitment. This is what proves `#seedFromCheckpoint` actually FEEDS the restored total
 * to the governor: without that call the fold still computes the right number and nothing notices.
 */
const BUDGETED_TEXT_CONSERVATIVE_RESUME = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: m2-harness-budgeted-text-conservative-resume
  max_parallel: 1
  budget:
    max_cost_microcents: 1500
    on_exceed: fail
  agents:
    - id: writer
      model: budget-text-model
      provider: anthropic
      system_prompt: You write.
      max_tokens: 1000
  nodes:
    - { id: n1, type: agent, agent_ref: writer, prompt_template: 'One' }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: n2, type: agent, agent_ref: writer, prompt_template: 'Two' }
  edges:
    - { from: n1, to: g }
    - { from: g, to: n2 }
`,
);

/** Prices `budget-text-model` so one 1000-token call costs 1,000µ¢ — the cap fits exactly one. */
const BUDGET_TEXT_PRICING: PricingOverlay = new Map([
  [
    'budget-text-model',
    {
      provider: 'anthropic',
      nativeId: 'budget-text-model',
      displayName: 'Budget text model',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      inputPerMtokMicrocents: 0,
      outputPerMtokMicrocents: 1_000_000,
      cachedInputPerMtokMicrocents: 0,
    },
  ],
]);

const BUDGET_MEDIA_PRICING: PricingOverlay = new Map([
  [
    'budget-media-model',
    {
      provider: 'openai',
      nativeId: 'budget-media-model',
      displayName: 'Budget media model',
      contextWindowTokens: 1,
      maxOutputTokens: 1,
      inputPerMtokMicrocents: 0,
      outputPerMtokMicrocents: 0,
      cachedInputPerMtokMicrocents: 0,
      mediaOutputRates: { image: 1000 },
    },
  ],
]);

const INPUTS = { topic: 'the report' } as const;

// --- The reusable driver ---------------------------------------------------------------------------

type Host = ReturnType<typeof createInMemoryHost>;

function buildEngine(
  host: Host,
  resolveProvider: (id: ProviderId) => LlmProvider | undefined,
  resolveMediaSurface?: (model: string) => 'chat' | 'generative' | undefined,
  resolvePrice?: PricingOverlay,
  // Overridable ONLY so the ADR-0077 barrier tests can observe tool dispatch directly. B2's whole claim is
  // "the ledger write lands before the run mutates the world", and the only honest witness to that is the
  // dispatch itself — not an event, which would just be re-reading the thing under test.
  registry: ToolRegistry = echoRegistry,
): WorkflowEngine {
  return new WorkflowEngine({
    host,
    ...(resolvePrice === undefined ? {} : { resolvePrice }),
    executor: createStandardNodeExecutor({
      sandbox,
      agent: {
        resolveProvider,
        ...(resolveMediaSurface === undefined ? {} : { resolveMediaSurface }),
        ...(resolvePrice === undefined ? {} : { resolvePrice }),
        registry,
        tools: [echoToolDef],
        keyFor: () => 'k',
        sleep: () => Promise.resolve(),
        now: () => 1,
      },
    }),
  });
}

interface DriveResult {
  readonly events: RunEvent[];
  readonly gateId: string | undefined;
  readonly lastSeq: number;
}

/**
 * Drive a run handle to its terminal — or, with `breakOnPause`, to the first `run:paused` (the "process"
 * dies parked at the gate). On every `node:retrying` it arms-then-fires the backoff timer: the timer is
 * armed in `#dispatch`'s continuation just AFTER the event is delivered, so the consumer must spin the
 * microtask queue until `armedCount() > 0` before firing (the manual timer never fires on a wall clock).
 */
async function drive(
  handle: RunHandle,
  host: Host,
  opts: { breakOnPause?: boolean } = {},
): Promise<DriveResult> {
  const events: RunEvent[] = [];
  let gateId: string | undefined;
  let lastSeq = -1;
  for await (const event of handle.events) {
    events.push(event);
    lastSeq = Math.max(lastSeq, event.sequenceNumber);
    if (event.type === 'node:retrying') {
      let waited = 0;
      while (host.armedCount() === 0) {
        if ((waited += 1) > 1000) {
          throw new Error('backoff timer was never armed after node:retrying');
        }
        await Promise.resolve();
      }
      host.fireTimers();
    }
    if (opts.breakOnPause === true && event.type === 'run:paused') {
      gateId = event.gateIds[0];
      break;
    }
  }
  return { events, gateId, lastSeq };
}

/** Assert every event validates against the canonical RunEventSchema (§1.U "matching the canonical schema"). */
function assertCanonicalSchema(events: readonly RunEvent[]): void {
  for (const event of events) {
    const parsed = RunEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`event ${event.type}#${String(event.sequenceNumber)} is not canonical`);
    }
  }
}

/** Assert sequenceNumbers are exactly 0..n-1 — the bus's gap-free, exactly-once guarantee. */
function assertGapFreeSeq(events: readonly RunEvent[]): void {
  const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

const tokensOf = (events: readonly RunEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'agent:token' ? [e.token] : []));
const costsOf = (events: readonly RunEvent[]): Extract<RunEvent, { type: 'cost:updated' }>[] =>
  events.filter((e): e is Extract<RunEvent, { type: 'cost:updated' }> => e.type === 'cost:updated');
const nodeOutput = (events: readonly RunEvent[], nodeId: string): unknown =>
  events.find(
    (e): e is Extract<RunEvent, { type: 'node:completed' }> =>
      e.type === 'node:completed' && e.nodeId === nodeId,
  )?.output;

let sandbox: ExpressionSandbox;

beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

describe('M2 — end-to-end Node harness (1.U)', () => {
  it('happy path: a 3-node input→agent(+tool)→output run streams, records per-attempt cost, gap-free + canonical', async () => {
    const host = createInMemoryHost();
    // The primary streams a tool-use turn (echo) then the answer — a real tool round-trip, no fallback.
    const engine = buildEngine(host, () =>
      scriptedProvider([toolUseTurn('c1'), textTurn('a summary')]),
    );
    const { events } = await drive(engine.start({ workflow: HAPPY_PATH, inputs: INPUTS }), host);

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(tokensOf(events)).toEqual(['a summary']); // live token streaming over the RunEventBus
    expect(events.some((e) => e.type === 'agent:tool_call' && e.toolId === 'echo')).toBe(true);
    expect(events.some((e) => e.type === 'agent:tool_result' && e.success)).toBe(true);
    expect(nodeOutput(events, 'out')).toBe('a summary'); // the agent's answer flows through to output

    // Per-attempt cost: the tool-use turn AND the answer turn each emit one cost:updated, the cumulative
    // rolls up. Pinned to the EXACT count — a `>= 1` would pass even if the tool-turn cost went missing.
    const costs = costsOf(events);
    expect(costs.length).toBe(2); // tool-use turn + answer turn → one cost:updated each
    let running = 0;
    for (const c of costs) {
      expect(c.model).toBe('claude-opus-4-8');
      expect(c.costMicrocents).toBeGreaterThan(0);
      running += c.costMicrocents;
      expect(c.cumulativeCostMicrocents).toBe(running);
    }

    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('inline media-out: an agent node requesting image output routes to generate() and de-inlines to a handle (1.AG/ADR-0046)', async () => {
    // The end-to-end proof of the "previously-missing integration link": a real agent node (output_modalities
    // [text, image]) → generate() (its stream throws) → { text, media } node output → the engine de-inlines
    // the in-flight base64 to a media:// handle at #emitDurable, gap-free, with NO base64 on the durable stream.
    const host = createInMemoryHost({ mediaStore: stubMediaStore() });
    const engine = buildEngine(host, () => mediaProvider('gemini'));
    const { events } = await drive(engine.start({ workflow: MEDIA_OUT, inputs: INPUTS }), host);

    expect(events.at(-1)?.type).toBe('run:completed');
    const out = nodeOutput(events, 'work');
    expect(out).toMatchObject({
      text: 'here is your image',
      media: [{ type: 'media', mimeType: 'image/png', source: { kind: 'handle' } }],
    });
    // The de-inlined source is a canonical media:// sha256 handle (the durable form — never a raw byte carrier).
    expect(firstMediaRef(out)).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
    // I3 — the in-flight base64 ("hello") never appears on the delivered (or persisted) run-event stream.
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');

    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('generative media-out: an agent node on a generative model routes to generateMedia and de-inlines to a handle (1.AG Section C/ADR-0045)', async () => {
    // The end-to-end proof of the generative SYNC link: a real agent node on a media_surface:'generative' model
    // → generateMedia (its generate/stream throw) → { text:'', media } node output → the engine de-inlines the
    // in-flight base64 to a media:// handle at #emitDurable, gap-free, with NO base64 on the durable stream.
    const host = createInMemoryHost({ mediaStore: stubMediaStore() });
    const engine = buildEngine(
      host,
      () => generativeMediaProvider('openai'),
      () => 'generative',
    );
    const { events } = await drive(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:completed');
    const out = nodeOutput(events, 'work');
    expect(out).toMatchObject({
      text: '', // a generative node is PURE media — no accompanying chat text
      media: [{ type: 'media', mimeType: 'image/png', source: { kind: 'handle' } }],
    });
    expect(firstMediaRef(out)).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
    // I3 — no base64 on the delivered (or persisted) stream; and MediaGenResult.raw (the provider-internal
    // diagnostic) is structurally excluded from the node output (strip-on-sink, ADR-0045 §7) — the stub's
    // raw:{ internal:true } must never appear. Exactly one realized cost:updated for the node.
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    expect(JSON.stringify(events)).not.toContain('"internal":true');
    expect(costsOf(events).filter((c) => c.nodeId === 'work')).toHaveLength(1);

    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('async media job: parks, polls (pending then done), de-inlines to a handle, completes (1.AG Section D/ADR-0045)', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const job = asyncMediaProvider([{ state: 'pending' }, { state: 'done', media: IMAGE_PART }]);
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const events = await driveMediaRun(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(events.some((e) => e.type === 'media_job:submitted')).toBe(true);
    expect(events.some((e) => e.type === 'run:paused')).toBe(true); // PARKED, not a stall-fail (MJ-1)
    const out = nodeOutput(events, 'work');
    expect(out).toMatchObject({
      media: [{ type: 'media', mimeType: 'image/png', source: { kind: 'handle' } }],
    });
    expect(firstMediaRef(out)).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toContain('aGVsbG8='); // I3 — the in-flight bytes never go durable
    expect(job.generateCalls()).toBe(1); // submitted once
    expect(job.pollCalls()).toBeGreaterThanOrEqual(2); // pending then done
    expect(costsOf(events).filter((c) => c.nodeId === 'work')).toHaveLength(1); // the lone realized addend (§5)
    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('async media job: a content-policy poll failure settles node:failed (content_filter) → run:failed', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const job = asyncMediaProvider([
      {
        state: 'failed',
        error: { provider: 'openai', kind: 'content_filter', retryable: false, message: 'blocked' },
      },
    ]);
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const events = await driveMediaRun(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );
    expect(events.at(-1)?.type).toBe('run:failed');
    const failedEvent = events.find((e) => e.type === 'node:failed');
    expect(failedEvent?.type === 'node:failed' && failedEvent.error.code).toBe('content_filter');
    // The FAILED path still emits exactly one realized cost addend (the provider billed the paid job even
    // though it was content-filtered — ADR-0045 §5); pin it so a dropped #emitMediaJobCost on the failed arm
    // is a loud regression, not silent (L1).
    expect(costsOf(events).filter((c) => c.nodeId === 'work')).toHaveLength(1);
  });

  it('async media budget: a slot-free parked job retains its priced admission and blocks the next submission (G38)', async () => {
    // `max_parallel:1` deliberately frees the execution slot when n1 parks. The money reservation must NOT follow
    // that scheduling slot: n2's same-priced submission would take the total from 1,000 to 2,000µ¢ over a 1,500µ¢
    // cap. Before the retained lease, both generateMedia calls ran and the workflow completed after both polls.
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const job = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
      BUDGET_MEDIA_PRICING,
    );

    const events = await driveMediaRun(
      engine.start({ workflow: BUDGETED_ASYNC_MEDIA_PARALLEL, inputs: INPUTS }),
      host,
    );

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:failed');
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
    expect(terminal?.type === 'run:failed' && terminal.cumulativeCostMicrocents).toBe(1000);
    expect(job.generateCalls()).toBe(1);
    expect(events.filter((event) => event.type === 'media_job:submitted')).toHaveLength(1);
    const costs = costsOf(events);
    expect(costs).toHaveLength(1);
    expect(costs[0]?.costMicrocents).toBe(1000);
    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('async media job: a cross-process resume RE-ATTACHES (re-polls) the persisted jobId — never re-submits (MJ-1)', async () => {
    const store = new InMemoryRunStore();
    // Process 1: submit + park, then "crash" (break at run:paused; the poll timer is never fired).
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1 } = await drive(
      engine1.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    expect(events1.some((e) => e.type === 'media_job:submitted')).toBe(true);
    expect(job1.generateCalls()).toBe(1);
    const runId = events1[0]?.runId ?? '';

    // Process 2: a fresh engine resumes purely from the store — re-attaches + re-polls to done. The opaque
    // jobId is re-polled; generateMedia is NEVER called again (ADR-0045 §3, the no-double-submit rule).
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({ runId, workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host2,
    );
    expect(events2.at(-1)?.type).toBe('run:completed');
    expect(job2.generateCalls()).toBe(0); // RE-ATTACH, never re-submit
    expect(job2.pollCalls()).toBeGreaterThanOrEqual(1);
    expect(firstMediaRef(nodeOutput(events2, 'work'))).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
    // The prior process already emitted run:paused for this park; the resume must NOT re-announce it (L2).
    expect(events2.filter((e) => e.type === 'run:paused')).toHaveLength(0);
    // The lone realized cost addend fires on the resume→done path too (exactly one — ADR-0045 §5).
    expect(costsOf(events2).filter((c) => c.nodeId === 'work')).toHaveLength(1);
  });

  it('conservative commitment: a usage-less attempt is DURABLE and still consumes the cap after a resume (ADR-0074 §1/§2)', async () => {
    // The end-to-end proof for the whole of C2, and the case that had no test at any layer. Before ADR-0074 the
    // retained estimate lived only in memory, so a crash reset it to zero and the resumed run spent again against
    // a cap that had forgotten money the provider may already have billed.
    const store = new InMemoryRunStore();
    // `n1`'s stream ends with NO terminal usage — a clean EOF, which FallbackChain treats as a successful empty
    // turn. The provider may still have billed it, so the reservation must be retained, not released.
    const provider1 = scriptedProvider([[{ type: 'text_delta', text: 'partial' }]]);
    const host1 = createInMemoryHost({ store });
    const engine1 = buildEngine(host1, () => provider1, undefined, BUDGET_TEXT_PRICING);
    const events1 = await drive(
      engine1.start({ workflow: BUDGETED_TEXT_CONSERVATIVE, inputs: INPUTS }),
      host1,
    );

    // 1. The commitment is DURABLE — the whole point of §2. It carries the owning node, the model, its own delta
    //    and a cumulative that already includes it.
    const commits = events1.events.filter((e) => e.type === 'budget:estimate_committed');
    expect(commits).toHaveLength(1);
    const [commit] = commits;
    expect(commit?.type === 'budget:estimate_committed' && commit.nodeId).toBe('n1');
    expect(commit?.type === 'budget:estimate_committed' && commit.model).toBe('budget-text-model');
    expect(
      commit?.type === 'budget:estimate_committed' &&
        commit.cumulativeConservativeMicrocents === commit.estimateMicrocents,
    ).toBe(true);
    // 2. It is an ESTIMATE, never spend: no `cost:updated` for n1, and the realized total stays 0.
    expect(costsOf(events1.events).filter((c) => c.nodeId === 'n1')).toHaveLength(0);
    const terminal1 = events1.events.at(-1);
    expect(terminal1?.type).toBe('run:failed');
    // 3. And it CONSUMED the cap in this process — n2's worst-case call no longer fits beside it.
    expect(terminal1?.type === 'run:failed' && terminal1.error.code).toBe('budget_exceeded');
    expect(terminal1?.type === 'run:failed' && terminal1.cumulativeCostMicrocents).toBe(0);
    // 4. The row is in the DURABLE log, not merely on the stream — this is what survives the crash.
    const persisted = store.eventsFor(events1.events[0]?.runId ?? '');
    expect(persisted.filter((e) => e.type === 'budget:estimate_committed')).toHaveLength(1);

    // 5. The fold reads it back. A fresh process reconstructs the SAME conservative total, summing the deltas —
    //    which is what `#seedFromCheckpoint` hands to the resumed governor before any resumed admission.
    const rebuilt = reconstructCheckpointState(persisted);
    expect(rebuilt?.conservativeCostMicrocents).toBe(
      commit?.type === 'budget:estimate_committed' ? commit.estimateMicrocents : -1,
    );
    // …and it never leaks into the realized total.
    expect(rebuilt?.cumulativeCostMicrocents).toBe(0);
  });

  it('conservative commitment: the node boundary WAITS for the commitment`s durable write (ADR-0074 §2)', async () => {
    // §2's other barrier: "the enclosing turn completion waits for the commitment's durability acknowledgement".
    // Under a SYNCHRONOUS store the ordering happens by accident, which is why removing the flush went unnoticed;
    // so the store here defers the commitment's write, and the node's own terminal must not be persisted until
    // it lands.
    //
    // **What this test does and no longer does, recorded rather than left implied (clause 4).** It was written
    // when `#emitDurable` started each persist concurrently. ADR-0078 §1's ordered tail now serializes the
    // appends for a run outright, so the ORDERING half below holds whether or not the money barrier exists —
    // review measured that deleting the flush leaves this green. The ordering assertion is kept because it is
    // still the documented behaviour and would catch a regression in the TAIL; what it no longer does is pin
    // the barrier. The barrier's own half — that `join()` OBSERVES a retained failure rather than merely
    // awaiting it — is pinned by the ADR-0077 ledger tests further down this file and by
    // `money-durability.test.ts`, which is where a reader should look for it.
    let releaseCommitWrite: (() => void) | undefined;
    const inner = new InMemoryRunStore();
    const persistOrder: string[] = [];
    const store = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      eventsFor: (runId: string) => inner.eventsFor(runId),
      persistEvent: async (event: RunEvent): Promise<void> => {
        if (event.type === 'budget:estimate_committed') {
          await new Promise<void>((resolve) => {
            releaseCommitWrite = resolve;
          });
        }
        persistOrder.push(event.type);
        await inner.persistEvent(event);
      },
    };
    const provider = scriptedProvider([[{ type: 'text_delta', text: 'partial' }]]); // no terminal usage
    const host = createInMemoryHost({ store });
    const engine = buildEngine(host, () => provider, undefined, BUDGET_TEXT_PRICING);
    const handle = engine.start({ workflow: BUDGETED_TEXT_CONSERVATIVE, inputs: INPUTS });

    // Let the run reach the commitment and block on its write.
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(releaseCommitWrite).toBeDefined();
    // n1's OWN terminal must not be durable yet — a crash here would have recorded progress the money log lacks.
    expect(persistOrder).not.toContain('node:completed');

    releaseCommitWrite?.();
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    // Now it landed, and it landed FIRST.
    expect(persistOrder.indexOf('budget:estimate_committed')).toBeLessThan(
      persistOrder.indexOf('node:completed'),
    );
  });

  // --- The durable-truth oracle (CR-91) --------------------------------------------------------------
  //
  // Everything above this point asserts on the LIVE stream. That is one view, taken in-process while the
  // engine that produced it is still alive, and it cannot see the failure class this phase exists for: a
  // caller told `completed` while the log says `failed`, a restart reconciling to a different terminal, or a
  // checkpoint fold that disagrees with the terminal and would make a resume do the wrong work.
  //
  // `checkDurableTruth` compares four views. These tests apply it to the three terminals a run can reach, on
  // real engine runs rather than synthetic logs — `durable-truth.test.ts` covers the oracle's own detection
  // logic, this covers the engine actually satisfying it.

  /** Run the oracle over a finished run, restarting a FRESH engine over the same store to reconcile. */
  async function assertDurableTruth(
    host: Host,
    store: InMemoryRunStore,
    events: readonly RunEvent[],
    resolveProvider: (id: ProviderId) => LlmProvider | undefined,
  ) {
    const runId = events[0]?.runId;
    if (runId === undefined) expect.unreachable('no run:started');
    const verdict = await checkDurableTruth({
      runId,
      live: events.at(-1),
      eventsFor: (id) => store.eventsFor(id),
      // A fresh engine over the SAME store, which is what a restarted process is.
      reconcile: () => buildEngine(host, resolveProvider).reconcile(),
    });
    expect(verdict.agrees, formatDurableTruth(verdict)).toBe(true);
    return verdict;
  }

  it('durable truth: a COMPLETED run survives a restart unchanged (CR-91)', async () => {
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const provider = scriptedProvider([toolUseTurn('c1'), textTurn('a summary')]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: HAPPY_PATH, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:completed');
    const verdict = await assertDurableTruth(host, store, events, () => provider);
    // A run that already closed must give reconcile() nothing to do — repairing a run that DIED without a
    // terminal is its job; touching one that landed is the defect.
    expect(verdict.reconciledCount).toBe(0);
    expect(verdict.durableTerminalCount).toBe(1);
  });

  it('durable truth: a FAILED run agrees across all four views (CR-91)', async () => {
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    // A fatal provider error — no retry budget on HAPPY_PATH, so the node fails and the run follows.
    const provider = scriptedProvider([
      [
        {
          type: 'error',
          error: { kind: 'auth', retryable: false, provider: 'anthropic', message: 'nope' },
        },
      ],
    ]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: HAPPY_PATH, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:failed');
    const verdict = await assertDurableTruth(host, store, events, () => provider);
    expect(verdict.checkpointStatus).toBe('failed');
    // The concrete code FIRST. `history === live` alone is satisfied by `undefined === undefined`, so it holds
    // just as well for a verdict that read no error at all from either side — including one where a refactor
    // stopped populating `errorCode`. Pinning the value is what makes the equality mean something.
    expect(verdict.history?.errorCode).toBe('provider_auth');
    expect(verdict.history?.errorCode).toBe(verdict.live?.errorCode);
  });

  it('durable truth: a CANCELLED run agrees across all four views (CR-91)', async () => {
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const provider = scriptedProvider([toolUseTurn('c1'), textTurn('a summary')]);
    const engine = buildEngine(host, () => provider);
    const handle = engine.start({ workflow: HAPPY_PATH, inputs: INPUTS });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      // `handle.cancel()`, not `engine.cancel(runId)`: the latter THROWS `run_already_terminal` once the run
      // settled, and this stream is a buffered push/pull adapter — the consumer's position relative to engine
      // progress is a microtask-interleaving property, not a guarantee. `work` is a real node that finishes on
      // its own, so a lagging consumer would throw inside this `for await` instead of failing an assertion.
      if (event.type === 'node:started' && event.nodeId === 'work') handle.cancel();
    }

    expect(events.at(-1)?.type).toBe('run:cancelled');
    await assertDurableTruth(host, store, events, () => provider);
  });

  // --- The realized-cost ledger's barriers (ADR-0076 / ADR-0077) ------------------------------------
  //
  // Every test here runs on HAPPY_PATH, which declares NO `budget` — deliberately. ADR-0077 §5's whole
  // finding is that the barriers used to live behind a governor that only exists when a workflow declares a
  // cap, so a budgeted fixture would pass even with all three holes open. An unbudgeted run is the regression.

  /** A registry that records every dispatch, so a barrier can be witnessed by the side effect it gates. */
  function spyingRegistry(): { registry: ToolRegistry; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      registry: {
        has: (id) => echoRegistry.has(id),
        list: () => echoRegistry.list(),
        dispatch: (call, ctx) => {
          calls.push(call.name);
          return echoRegistry.dispatch(call, ctx);
        },
      },
    };
  }

  /**
   * Drain the queue to QUIESCENCE — microtasks and a macrotask turn, repeatedly.
   *
   * Load-bearing, and its absence made the first version of every test below hollow. `ledger.blocked()` flips
   * INSIDE `persistEvent`, several turns before the run would have reached the action a barrier guards. Assert
   * at that instant and the dispatch is still sitting in the queue, so the assertion passes whether or not the
   * barrier exists. Draining first is what makes deleting a join go red.
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      for (let j = 0; j < 200; j += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** A store that blocks `cost:attempt_settled`'s write until released, recording persist order. */
  function blockingLedgerStore() {
    const inner = new InMemoryRunStore();
    const persistOrder: string[] = [];
    let resolveWrite: (() => void) | undefined;
    return {
      persistOrder,
      blocked: () => resolveWrite !== undefined,
      release: () => resolveWrite?.(),
      store: {
        resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
        listInterruptedRuns: () => inner.listInterruptedRuns(),
        eventsFor: (runId: string) => inner.eventsFor(runId),
        persistEvent: async (event: RunEvent): Promise<void> => {
          if (event.type === 'cost:attempt_settled' && resolveWrite === undefined) {
            await new Promise<void>((resolve) => {
              resolveWrite = resolve;
            });
          }
          // `type:nodeId`, not just the type. HAPPY_PATH's `input` node completes long before the agent
          // spends anything, so a bare `node:completed` check would fire on the wrong node and pass for the
          // wrong reason — which it did, on the first run of this test.
          persistOrder.push(
            'nodeId' in event && typeof event.nodeId === 'string'
              ? `${event.type}:${event.nodeId}`
              : event.type,
          );
          await inner.persistEvent(event);
        },
      },
    };
  }

  it('ledger B2: a TOOL is not dispatched until the attempt`s charge is durable (ADR-0077)', async () => {
    // The barrier ADR-0077 adds beyond ADR-0074 §2's pair, and the one that makes this ledger EXTEND the
    // guarantee rather than repeat it: realized spend must be durable before the run mutates the world, not
    // merely before it spends again. Witnessed on the dispatch itself.
    const { registry, calls } = spyingRegistry();
    const ledger = blockingLedgerStore();
    const provider = scriptedProvider([toolUseTurn('t1'), textTurn('done')]);
    const host = createInMemoryHost({ store: ledger.store });
    const engine = buildEngine(host, () => provider, undefined, undefined, registry);
    const handle = engine.start({ workflow: HAPPY_PATH, inputs: INPUTS });

    // Spin until the ledger write blocks. HAPPY_PATH runs input → agent → output and the charge only settles
    // after a full successful attempt, so this needs more turns of the microtask queue than §2's fixture,
    // whose commitment fires on a usage-less stream almost immediately.
    for (let i = 0; i < 500 && !ledger.blocked(); i += 1) await Promise.resolve();
    expect(ledger.blocked()).toBe(true);
    await settle(); // give the guarded action every chance to run before asserting it did not
    // THE assertion: the model asked for a tool, the charge is not durable, so nothing ran.
    expect(calls).toEqual([]);

    ledger.release();
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(calls).toEqual(['echo']); // it did run, once the write landed
    expect(events.at(-1)?.type).toBe('run:completed');
  });

  it('ledger B3: the node terminal is not durable until the attempt`s charge is (ADR-0077)', async () => {
    const ledger = blockingLedgerStore();
    const provider = scriptedProvider([textTurn('done')]);
    const host = createInMemoryHost({ store: ledger.store });
    const engine = buildEngine(host, () => provider);
    const handle = engine.start({ workflow: HAPPY_PATH, inputs: INPUTS });

    // Spin until the ledger write blocks. HAPPY_PATH runs input → agent → output and the charge only settles
    // after a full successful attempt, so this needs more turns of the microtask queue than §2's fixture,
    // whose commitment fires on a usage-less stream almost immediately.
    for (let i = 0; i < 500 && !ledger.blocked(); i += 1) await Promise.resolve();
    expect(ledger.blocked()).toBe(true);
    await settle(); // give the guarded action every chance to run before asserting it did not
    // The AGENT node's own terminal must not be durable — a crash here records progress the money log lacks.
    // (`in`'s terminal is legitimately already there; it spent nothing.)
    expect(ledger.persistOrder).not.toContain('node:completed:work');

    ledger.release();
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    // PRESENCE first, then order. A bare `indexOf(a) < indexOf(b)` passes vacuously when `a` is missing —
    // `-1` is less than everything — so a run that never settled a charge at all would satisfy the ordering
    // it is supposed to prove.
    expect(ledger.persistOrder).toContain('cost:attempt_settled:work');
    expect(ledger.persistOrder).toContain('node:completed:work');
    expect(ledger.persistOrder.indexOf('cost:attempt_settled:work')).toBeLessThan(
      ledger.persistOrder.indexOf('node:completed:work'),
    );
  });

  it('ledger: a REJECTED write dispatches no tool — the observe half, not just the await (ADR-0077)', async () => {
    // **What stops the dispatch here is the ENGINE'S ABORT, not the barrier — stated because the obvious
    // reading of this test is wrong.** `#emitDurable` absorbs the rejection, sets `#failure` and calls
    // `#abort.abort()`, and `dispatchToolUseTurn`'s `throwIfAborted` ends the turn. Deleting the observe half
    // OR B2 leaves this test green, so it does NOT pin either.
    //
    // What it does pin is still worth having: a rejected ledger write ends the run without mutating the
    // world, and the terminal message stays secret-free. ADR-0077's stated required regression — the barrier
    // itself refusing — needs a case that DEFEATS the abort: reject the ledger write while a concurrent
    // sibling has already set `#failure`, so `#emitDurable`'s `this.#failure === undefined` guard skips the
    // abort and only the barrier is left to stop the dispatch. Not built; named so it is not lost.
    const { registry, calls } = spyingRegistry();
    const inner = new InMemoryRunStore();
    const store = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      eventsFor: (runId: string) => inner.eventsFor(runId),
      persistEvent: async (event: RunEvent): Promise<void> => {
        // Reject ASYNCHRONOUSLY, after a tick — a synchronous throw would let the engine's own abort win the
        // race and make this pass without any barrier at all.
        if (event.type === 'cost:attempt_settled') {
          await Promise.resolve();
          throw new Error('ledger write failed');
        }
        await inner.persistEvent(event);
      },
    };
    const provider = scriptedProvider([toolUseTurn('t1'), textTurn('done')]);
    const host = createInMemoryHost({ store });
    const engine = buildEngine(host, () => provider, undefined, undefined, registry);
    const handle = engine.start({ workflow: HAPPY_PATH, inputs: INPUTS });

    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);

    expect(calls).toEqual([]); // the world was not mutated on an unrecorded charge
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      // `#emitDurable`'s own message, not the barrier's — and that is correct, not a miss. It absorbs the
      // rejection and sets `#failure` FIRST, and `#failure ??=` keeps the first cause. The barrier's job here
      // is to stop the dispatch, not to rename the failure; its own message reaches the terminal only when a
      // ledger write fails somewhere `#emitDurable` does not already absorb.
      expect(terminal.error.message).toBe('a durable run-event write failed');
      // Secret-free either way: a store error can carry a filesystem path and must never reach the user.
      expect(terminal.error.message).not.toContain('ledger write failed');
    }
    // And the NODE terminal says `the run was cancelled`, NOT the barrier's diagnosis — measured, after an
    // assertion here claimed otherwise. It is the same fact as the paragraph above: the abort wins, the turn
    // ends at `throwIfAborted`, and B2's `LedgerDurabilityError` is never the error that classifies this node.
    // `#runAttempt` DOES have an arm that keeps that class intact (it used to flatten it to `the node handler
    // threw an unexpected error`), but reaching it needs the same abort-defeating fixture named above.
    const nodeFailed = events.find((e) => e.type === 'node:failed');
    expect(nodeFailed?.type === 'node:failed' ? nodeFailed.error.message : undefined).toBe(
      'the run was cancelled',
    );
  });

  it('ledger: an UNBUDGETED run records its realized spend at all (ADR-0077 §5)', async () => {
    // The plainest regression for §5's finding. Before it, the ledger's barriers hung off `BudgetGovernor`,
    // which the engine builds only when a workflow declares a `budget` — so this run, which spends real
    // money, would have started a write nobody ever joined.
    const inner = new InMemoryRunStore();
    const provider = scriptedProvider([textTurn('done')]);
    const host = createInMemoryHost({ store: inner });
    const engine = buildEngine(host, () => provider);
    const handle = engine.start({ workflow: HAPPY_PATH, inputs: INPUTS });
    const { events } = await drive(handle, host);

    expect(events.at(-1)?.type).toBe('run:completed');
    const persisted = inner.eventsFor(events[0]?.runId ?? '');
    const ledgerRows = persisted.filter((e) => e.type === 'cost:attempt_settled');
    expect(ledgerRows).toHaveLength(1);
    const row = ledgerRows[0];
    if (row?.type !== 'cost:attempt_settled') expect.unreachable('missing ledger row');
    expect(row.attemptNumber).toBe(1);
    expect(row.priced).toBe(true); // the built-in pricing table knows this model, so the charge is real
    // The cumulative must already include this charge, which is what the schema refinement pins.
    expect(row.cumulativeCostMicrocents).toBeGreaterThanOrEqual(row.costMicrocents);
  });

  it('conservative commitment: a RESUMED run still cannot spend past the cap it committed against (ADR-0074 §2)', async () => {
    // The half the previous test cannot reach: `#seedFromCheckpoint` must hand the folded total to the resumed
    // governor. Remove that one call and the fold still computes the right number, the log still contains the
    // right row, and nothing else in the suite notices — the resumed process simply spends again against a cap
    // that has forgotten money the provider may already have billed. That is exactly ADR-0074's bypass.
    const store = new InMemoryRunStore();
    const provider1 = scriptedProvider([[{ type: 'text_delta', text: 'partial' }]]); // no terminal usage
    const host1 = createInMemoryHost({ store });
    const engine1 = buildEngine(host1, () => provider1, undefined, BUDGET_TEXT_PRICING);
    const {
      events: events1,
      gateId,
      lastSeq,
    } = await drive(
      engine1.start({ workflow: BUDGETED_TEXT_CONSERVATIVE_RESUME, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';
    if (gateId === undefined) throw new Error('expected process 1 to pause at the human gate');
    expect(events1.filter((e) => e.type === 'budget:estimate_committed')).toHaveLength(1);

    // A FRESH process — its governor starts empty and may only learn the debit from the durable log.
    const provider2 = scriptedProvider([[{ type: 'text_delta', text: 'two' }, STOP()]]);
    const host2 = createInMemoryHost({ store });
    const engine2 = buildEngine(host2, () => provider2, undefined, BUDGET_TEXT_PRICING);
    const events2: RunEvent[] = [];
    for await (const event of (
      await engine2.resumeFromCheckpoint({
        runId,
        workflow: BUDGETED_TEXT_CONSERVATIVE_RESUME,
        inputs: INPUTS,
        gateId,
        decision: { decision: 'approved', decidedBy: 'human' },
      })
    ).events) {
      events2.push(event);
    }

    const terminal = events2.at(-1);
    expect(terminal?.type).toBe('run:failed');
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
    // n2 was REFUSED pre-egress: the provider was never called. Without the restore it would have run.
    expect(events2.some((e) => e.type === 'node:completed' && e.nodeId === 'n2')).toBe(false);
    // Realized spend is still zero — the block came entirely from an ESTIMATE, which is the point.
    expect(terminal?.type === 'run:failed' && terminal.cumulativeCostMicrocents).toBe(0);
    // The resumed segment keeps the prior sequence space (gap-free from last+1).
    events2.forEach((event, index) => expect(event.sequenceNumber).toBe(lastSeq + index + 1));
  });

  it('async media budget: checkpoint resume reconstructs a parked-job reservation before gate-unblocked egress', async () => {
    const store = new InMemoryRunStore();
    // Process 1: submit the priced job and park it alongside a human gate. Its timer is intentionally not fired;
    // the checkpoint is the only thing process 2 may use to reconstruct the already-paid commitment.
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
      BUDGET_MEDIA_PRICING,
    );
    const {
      events: events1,
      gateId,
      lastSeq,
    } = await drive(
      engine1.start({ workflow: BUDGETED_ASYNC_MEDIA_RESUME, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';
    if (gateId === undefined)
      throw new Error('expected the process-1 checkpoint to contain a human gate');
    expect(job1.generateCalls()).toBe(1);

    // Process 2 approves the gate, making `after` ready. It must see gen's reconstructed 1,000µ¢ reservation and
    // fail before submit; normal `checkPreEgress` is intentionally NOT rerun for gen itself because it is paid.
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
      BUDGET_MEDIA_PRICING,
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({
        runId,
        workflow: BUDGETED_ASYNC_MEDIA_RESUME,
        inputs: INPUTS,
        gateId,
        decision: { decision: 'approved', decidedBy: 'human' },
      }),
      host2,
    );

    const terminal = events2.at(-1);
    expect(terminal?.type).toBe('run:failed');
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
    expect(terminal?.type === 'run:failed' && terminal.cumulativeCostMicrocents).toBe(1000);
    expect(job2.generateCalls()).toBe(0); // gen re-attached; `after` never submitted
    expect(costsOf(events2).filter((cost) => cost.nodeId === 'gen')).toHaveLength(1);
    // Resume keeps the prior process's sequence space; the resumed segment starts at the persisted last+1 and is
    // gap-free from there (rather than restarting at 0 like a fresh run).
    events2.forEach((event, index) => expect(event.sequenceNumber).toBe(lastSeq + index + 1));
    assertCanonicalSchema(events2);
  });

  it('async media job: a run cancel aborts the in-flight poll → run:cancelled (ADR-0045 §4)', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const job = asyncMediaProvider([{ state: 'pending' }]); // never resolves on its own
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const handle = engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS });
    // Cancel once the run parks on the (never-resolving) media job: the run reaches run:cancelled through the
    // real engine cancel path. This stub detects the abort at poll-call entry, so it proves the cancel SETTLES
    // the run — the dedicated mid-await abort-observation proof is the deterministic test below.
    const events = await driveMediaRun(handle, host, () => handle.cancel());
    expect(events.at(-1)?.type).toBe('run:cancelled');
  });

  it('async media job: a cancel of a parked job fires the terminal media sweep (#reclaimRunMedia, ADR-0045 §4)', async () => {
    const reclaims: string[] = [];
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: () => undefined,
      reclaimRun: (runId) => {
        reclaims.push(runId);
      },
    };
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
      mediaReferences,
    });
    const job = asyncMediaProvider([{ state: 'pending' }]); // never resolves on its own
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const handle = engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS });
    const events = await driveMediaRun(handle, host, () => handle.cancel());
    expect(events.at(-1)?.type).toBe('run:cancelled');
    const runId = events[0]?.runId ?? '';
    // The terminal sweep must reclaim the run's media references on the CANCEL terminal too (not only on a
    // happy-path run:completed) — a parked job's run-scoped refs (incl. any done→cancel-race produced byte)
    // are GC-eligible the instant the run settles. Exactly one sweep, for this run.
    expect(reclaims).toEqual([runId]);
    // The #settle sweep also emits the paid job's lone realized cost addend before clearing it (the provider
    // billed the cancelled-but-still-generating job — ADR-0045 §5); pin exactly one so a dropped cancel-path
    // #emitMediaJobCost is a loud regression (L1).
    expect(costsOf(events).filter((c) => c.nodeId === 'work')).toHaveLength(1);
  });

  it('AG-A-FC-3: a run parked on BOTH a human gate AND a media job resumes both — gate decision + media re-attach', async () => {
    const store = new InMemoryRunStore();
    // Process 1: both branches park (the gate + the media job); break at the first run:paused.
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1, gateId } = await drive(
      engine1.start({ workflow: GATE_AND_MEDIA, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    expect(events1.some((e) => e.type === 'media_job:submitted')).toBe(true);
    expect(events1.some((e) => e.type === 'human_gate:paused')).toBe(true);
    const paused = events1.find((e) => e.type === 'run:paused');
    // run:paused carries BOTH reasons (the AG-A-FC-3 disambiguator).
    expect(
      paused?.type === 'run:paused' &&
        paused.gateIds.length === 1 &&
        paused.pendingMediaJobNodeIds?.includes('gen'),
    ).toBe(true);
    const runId = events1[0]?.runId ?? '';
    expect(gateId).toBeDefined();

    // Process 2: resume WITH the gate decision — the gate advances (decision) AND the media job re-attaches
    // (re-poll, no decision). Both reach terminal; exactly one run terminal.
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({
        runId,
        workflow: GATE_AND_MEDIA,
        inputs: INPUTS,
        gateId: gateId ?? '',
        decision: { decision: 'approved', decidedBy: 'human' },
      }),
      host2,
    );
    expect(events2.at(-1)?.type).toBe('run:completed');
    expect(events2.filter((e) => e.type === 'run:completed')).toHaveLength(1); // exactly one terminal
    expect(job2.generateCalls()).toBe(0); // the media job re-attached, never re-submitted
    expect(firstMediaRef(nodeOutput(events2, 'gen'))).toMatch(/^media:\/\/sha256-[0-9a-f]{64}$/);
  });

  it('AG-A-FC-3 guard: a media-only resume (no gate decision) of a both-parked run is rejected (pending_gate_requires_decision)', async () => {
    const store = new InMemoryRunStore();
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1 } = await drive(
      engine1.start({ workflow: GATE_AND_MEDIA_TIMED, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';

    const host2 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]).provider,
      () => 'generative',
    );
    // Neither gateId nor decision: the media-only resume form cannot resolve the still-parked gate. The engine
    // must reject the misuse EAGERLY rather than re-attach the media job and silently re-park on the gate after
    // it settles (L3). The half-initialized execution is dropped from #runs (a retry can re-resume correctly).
    await expect(
      engine2.resumeFromCheckpoint({ runId, workflow: GATE_AND_MEDIA_TIMED, inputs: INPUTS }),
    ).rejects.toMatchObject({ code: 'pending_gate_requires_decision' });
    // The rejected resume must leave NO armed timer behind: before the guard threw, the constructor's
    // #seedFromCheckpoint armed a media-poll timer for the parked job AND beginResumeMediaJobs armed the
    // whole-run timeout (GATE_AND_MEDIA_TIMED declares timeout_ms) — the catch must abandon (disarm) BOTH legs, else
    // an orphan timer would later poll the provider for a run the caller saw rejected (and a retry could
    // double-attach the same jobId). armedCount()===0 pins both the #mediaJobTimers and #runTimeoutDisarm
    // disarm legs of abandon() (H2).
    expect(host2.armedCount()).toBe(0);
  });

  it('async media job: a resume past the deadline short-circuits to a retryable timeout, never re-polls (ADR-0045 §3)', async () => {
    const store = new InMemoryRunStore();
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() }); // clock ~2026-01-01
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1 } = await drive(
      engine1.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';

    // Process 2: a clock FAR past the 30-min default deadline → the re-attach's first poll short-circuits to a
    // retryable timeout BEFORE polling (the provider has surely dropped the job). The done-script never runs.
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({
      store,
      mediaStore: stubMediaStore(),
      baseEpochMs: Date.parse('2026-02-01T00:00:00.000Z'),
    });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({ runId, workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host2,
    );
    expect(events2.at(-1)?.type).toBe('run:failed');
    const failed = events2.find((e) => e.type === 'node:failed');
    expect(failed?.type === 'node:failed' && failed.error.code).toBe('provider_unavailable');
    expect(failed?.type === 'node:failed' && failed.error.retryable).toBe(true);
    expect(job2.pollCalls()).toBe(0); // short-circuited before polling
    expect(job2.generateCalls()).toBe(0); // never re-submitted
    // The deadline-abandoned job was still provider-billed → exactly one realized cost addend (ADR-0045 §5).
    expect(costsOf(events2).filter((c) => c.nodeId === 'work')).toHaveLength(1);
  });

  it('async media job: an orphaned-vertex resume (content drift) still emits the paid job cost addend (H1, ADR-0045 §5)', async () => {
    const store = new InMemoryRunStore();
    // Process 1: park the 'work' media job (then "crash" at run:paused).
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1 } = await drive(
      engine1.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';

    // Process 2: resume against the DRIFTED workflow (same id, no 'work' node). #seedFromCheckpoint re-attaches
    // the parked 'work' job, but the poll finds no vertex → the orphaned-vertex branch must emit the paid job's
    // lone cost addend before clearing it (not silently drop it, the H1 bug). generateMedia/pollMediaJob are
    // never (re-)invoked for 'work' — the branch short-circuits before the executor poll.
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({
        runId,
        workflow: GENERATIVE_OUT_DRIFTED,
        inputs: INPUTS,
      }),
      host2,
    );
    expect(events2.at(-1)?.type).toBe('run:completed'); // the drifted plan (in→out) finishes; 'work' is orphaned
    expect(costsOf(events2).filter((c) => c.nodeId === 'work')).toHaveLength(1); // the paid orphan is still billed
    expect(job2.generateCalls()).toBe(0); // never re-submitted
    expect(job2.pollCalls()).toBe(0); // the orphaned-vertex branch short-circuits before the executor poll
  });

  it('async media job: a crash-in-window resume (no persisted run:paused) emits run:paused on resume (H2, ADR-0036)', async () => {
    const store = new InMemoryRunStore();
    const job1 = asyncMediaProvider([{ state: 'pending' }]);
    const host1 = createInMemoryHost({ store, mediaStore: stubMediaStore() });
    const engine1 = buildEngine(
      host1,
      () => job1.provider,
      () => 'generative',
    );
    const { events: events1 } = await drive(
      engine1.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host1,
      { breakOnPause: true },
    );
    const runId = events1[0]?.runId ?? '';

    // Simulate the CRASH-IN-WINDOW: the prior process persisted media_job:submitted but crashed BEFORE
    // run:paused. Copy every event EXCEPT run:paused into a fresh store, so the checkpoint folds runStatus
    // 'running' (RUN_STATUS_BY_EVENT has no media_job:submitted entry) — the resumed process MUST emit run:paused.
    const crashStore = new InMemoryRunStore();
    for (const e of store.eventsFor(runId)) {
      if (e.type !== 'run:paused') {
        await crashStore.persistEvent(e);
      }
    }
    const job2 = asyncMediaProvider([{ state: 'done', media: IMAGE_PART }]);
    const host2 = createInMemoryHost({ store: crashStore, mediaStore: stubMediaStore() });
    const engine2 = buildEngine(
      host2,
      () => job2.provider,
      () => 'generative',
    );
    const events2 = await driveMediaRun(
      await engine2.resumeFromCheckpoint({ runId, workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host2,
    );
    expect(events2.at(-1)?.type).toBe('run:completed');
    // The prior process never announced run:paused, so the resumed process must — exactly once, before terminal.
    const pausedIdx = events2.findIndex((e) => e.type === 'run:paused');
    expect(events2.filter((e) => e.type === 'run:paused')).toHaveLength(1);
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeLessThan(events2.length - 1); // before the terminal
    expect(job2.generateCalls()).toBe(0); // re-attach, not re-submit
  });

  it('async media job: an IN-FLIGHT poll is aborted by a run cancel (deterministic) → run:cancelled (ADR-0045 §4)', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    let observedAbort = false;
    const provider: LlmProvider = {
      id: 'openai',
      supports: { ...MEDIA_CAPS, media: { ...MEDIA_CAPS.media, surface: 'generative' } },
      generate: () => {
        throw new Error('generate must NOT run');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run');
      },
      generateMedia: () => Promise.resolve({ jobId: 'job-1', raw: {} }),
      // A poll that stays IN-FLIGHT until the run abort signal fires (then rejects) — proving the cancel
      // reaches the open provider request, not just the next schedule.
      pollMediaJob: (_jobId: string, _key: string, signal?: AbortSignalLike) =>
        new Promise<MediaJobStatus>((_resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const engine = buildEngine(
      host,
      () => provider,
      () => 'generative',
    );
    const handle = engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS });
    const events = await driveMediaRun(handle, host, () => handle.cancel());
    expect(events.at(-1)?.type).toBe('run:cancelled');
    expect(observedAbort).toBe(true); // the in-flight poll observed the abort
  });

  it('async media job: an UNRECOGNIZED poll state fails the node loud (no silent park-forever hang) — the default arm (N2)', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const provider: LlmProvider = {
      id: 'openai',
      supports: { ...MEDIA_CAPS, media: { ...MEDIA_CAPS.media, surface: 'generative' } },
      generate: () => {
        throw new Error('generate must NOT run');
      },
      stream: (): AsyncIterable<StreamChunk> => {
        throw new Error('stream must NOT run');
      },
      generateMedia: () => Promise.resolve({ jobId: 'job-1', raw: {} }),
      // An out-of-union job state (a future seam value / a non-conforming adapter) forces the closed-switch's
      // default arm, which MUST fail the node terminally rather than leave it parked with no re-arm (silent hang).
      pollMediaJob: () =>
        // @ts-expect-error — 'frozen' is intentionally outside the MediaJobStatus union (see above).
        Promise.resolve<MediaJobStatus>({ state: 'frozen' }),
    };
    const engine = buildEngine(
      host,
      () => provider,
      () => 'generative',
    );
    const events = await driveMediaRun(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );
    expect(events.at(-1)?.type).toBe('run:failed'); // settled, not hung
    const failed = events.find((e) => e.type === 'node:failed');
    expect(failed?.type === 'node:failed' && failed.error.code).toBe('internal');
    expect(failed?.type === 'node:failed' && failed.error.message).toContain(
      'unrecognized job state',
    );
  });

  it('async media job: survives repeated pending polls (backoff re-arm) before done', async () => {
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    const job = asyncMediaProvider([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'pending' },
      { state: 'done', media: IMAGE_PART },
    ]);
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const events = await driveMediaRun(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(job.pollCalls()).toBeGreaterThanOrEqual(4); // 3 pending + done
    expect(events.filter((e) => e.type === 'node:completed' && e.nodeId === 'work')).toHaveLength(
      1,
    );
    expect(costsOf(events).filter((c) => c.nodeId === 'work')).toHaveLength(1); // still exactly one addend
    // The completed node reports the full submit→done wall-clock, not the ~0 of the synchronous settle (M2):
    // each poll advanced the harness clock, so the elapsed across the 3 pending polls is strictly positive.
    const done = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(done?.type === 'node:completed' && done.durationMs > 0).toBe(true);
  });

  it('async media job: a poll re-arm timer fault still accounts the paid submission exactly once', async () => {
    const baseHost = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore: stubMediaStore(),
    });
    let timerCalls = 0;
    const host: Host = {
      ...baseHost,
      setTimer: (ms, onFire) => {
        timerCalls += 1;
        // The first timer parks the submitted job. Its first pending poll then attempts the second arm, which
        // models a host timer failure outside the normal executor/adapter path.
        if (timerCalls === 2) throw new Error('timer unavailable');
        return baseHost.setTimer(ms, onFire);
      },
    };
    const job = asyncMediaProvider([{ state: 'pending' }]);
    const engine = buildEngine(
      host,
      () => job.provider,
      () => 'generative',
    );
    const events = await driveMediaRun(
      engine.start({ workflow: GENERATIVE_OUT, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:failed');
    const costs = costsOf(events).filter((event) => event.nodeId === 'work');
    expect(costs).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.cumulativeCostMicrocents).toBe(
      costs[0]?.costMicrocents,
    );
    assertGapFreeSeq(events);
    assertCanonicalSchema(events);
  });

  it('flagship: one run — retry then failover, pause at the gate, cross-process resume reproduces the final output', async () => {
    // The primary (anthropic) ALWAYS errors retryably pre-content; the fallback (openai) fails the first
    // dispatch then succeeds — so dispatch 1 exhausts the chain (→ node retry), dispatch 2 fails over to the
    // fallback and completes. "forcing a provider error triggers retry then fallback" (§1.U acceptance).
    // Instantiate the stubs ONCE so the fallback's per-call counter persists across the two dispatches
    // (a fresh instance per resolve would reset it and never recover — the failover would never succeed).
    const primary = provider([retryableError('anthropic')], 'anthropic');
    const fallback = scriptedProvider(
      [[retryableError('openai')], textTurn('a summary')],
      'openai',
    );
    const resolveProvider = (id: ProviderId): LlmProvider =>
      id === 'anthropic' ? primary : fallback;

    // --- "Process" #1: run until the gate, persisting node-boundary + gate events to the shared store. ---
    const store = new InMemoryRunStore();
    const host1 = createInMemoryHost({ store });
    const engine1 = buildEngine(host1, resolveProvider);
    const handle1 = engine1.start({ workflow: FLAGSHIP, inputs: INPUTS });
    const {
      events: events1,
      gateId,
      lastSeq,
    } = await drive(handle1, host1, { breakOnPause: true });

    expect(gateId).toBeDefined();
    // Node retry then failover, all pre-gate; the run parked at the gate (no terminal yet).
    expect(events1.filter((e) => e.type === 'node:retrying')).toHaveLength(1);
    const retrying = events1.find((e) => e.type === 'node:retrying');
    // Assert the CLASSIFIED code, not `.retryable` — node:retrying is only ever emitted for a retryable
    // failure, so asserting retryable===true is tautological; the overloaded chain-exhaustion maps to
    // `provider_unavailable` (agent-turn.ts), which a misclassification would fail.
    expect(retrying?.type === 'node:retrying' ? retrying.error.code : undefined).toBe(
      'provider_unavailable',
    );
    expect(tokensOf(events1)).toEqual(['a summary']); // the fallback streamed the answer
    expect(events1.some((e) => e.type === 'human_gate:paused')).toBe(true);
    expect(events1.some((e) => e.type === 'run:paused')).toBe(true);
    expect(events1.some((e) => e.type === 'run:completed')).toBe(false);
    // The expensive agent result is checkpointed (failover output recorded at the node boundary).
    expect(nodeOutput(events1, 'work')).toBe('a summary');

    // Per-attempt cost recorded, attributed to the FALLBACK model — failover cost is accounted (§1.U).
    // Exactly ONE cost:updated: only the successful fallback attempt bills (the pre-content error attempts
    // carry no usage). `=== 1` catches a double-charge or a billed failed attempt that `>= 1` would miss.
    const costs1 = costsOf(events1);
    expect(costs1.length).toBe(1);
    for (const c of costs1) {
      expect(c.model).toBe('claude-sonnet-4-6');
      expect(c.costMicrocents).toBeGreaterThan(0);
    }

    // --- "Process" #2: a brand-new engine resumes purely from the persisted store. ---
    const host2 = createInMemoryHost({ store });
    const engine2 = buildEngine(host2, resolveProvider);
    const handle2 = await engine2.resumeFromCheckpoint({
      runId: handle1.runId,
      workflow: FLAGSHIP,
      inputs: INPUTS,
      gateId: gateId ?? '',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const { events: events2 } = await drive(handle2, host2);

    expect(handle2.runId).toBe(handle1.runId);
    expect(events2[0]?.type).toBe('human_gate:resumed'); // NOT a re-emitted run:started
    expect(tokensOf(events2)).toEqual([]); // the agent was NOT re-run — its output was restored
    // The checkpointed `work` (agent) node must NOT be re-dispatched on resume (its output is restored) —
    // assert directly, not just via the absence of streamed tokens.
    expect(events2.some((e) => e.type === 'node:started' && e.nodeId === 'work')).toBe(false);
    expect(events2.some((e) => e.type === 'node:completed' && e.nodeId === 'work')).toBe(false);
    expect(events2.some((e) => e.type === 'node:started' && e.nodeId === 'out')).toBe(true);
    expect(events2.at(-1)?.type).toBe('run:completed'); // resume reproduces a completed run
    expect(nodeOutput(events2, 'out')).toEqual({ decision: 'approved' }); // deterministic final output

    // Cost-event persistence: the pre-gate agent cost is RESTORED across the cross-process resume — the
    // durable node:completed.cumulativeCostMicrocents carries it (cost:updated is streamed, not persisted),
    // so run:completed.totalCostMicrocents reflects it rather than restarting near 0.
    const preGateCost = costs1.at(-1)?.cumulativeCostMicrocents ?? 0;
    expect(preGateCost).toBeGreaterThan(0);
    const resumedTerminal = events2.find((e) => e.type === 'run:completed');
    expect(
      resumedTerminal?.type === 'run:completed' ? resumedTerminal.totalCostMicrocents : -1,
    ).toBe(preGateCost);

    // The whole run — across the process boundary — is one gap-free, canonical sequence.
    const whole = [...events1, ...events2];
    assertGapFreeSeq(whole);
    assertCanonicalSchema(whole);
    expect(events2[0]?.sequenceNumber).toBe(lastSeq + 1); // resume continues the counter, no reset/gap
  });

  it('determinism: re-running the happy path yields an identical event signature + final output (no wall-clock/RNG)', async () => {
    const runOnce = async (): Promise<{ sig: string; output: unknown }> => {
      const host = createInMemoryHost();
      const engine = buildEngine(host, () =>
        scriptedProvider([toolUseTurn('c1'), textTurn('a summary')]),
      );
      const { events } = await drive(engine.start({ workflow: HAPPY_PATH, inputs: INPUTS }), host);
      return {
        sig: events.map((e) => `${String(e.sequenceNumber)}:${e.type}`).join('|'),
        output: nodeOutput(events, 'out'),
      };
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(second.sig).toBe(first.sig);
    expect(second.output).toEqual(first.output);
  });

  // --- the append audit, against the REAL engine (CR-10, ADR-0078) -------------------------------
  //
  // The harness's unit tests drive `audit.store.persistEvent` directly, which proves the predicates and
  // nothing about the engine. These two drive a live `WorkflowEngine` over an audited store, and they exist
  // because a docblock claim about the engine's actual behaviour turned out to be wrong when someone finally
  // ran it: an ordinary sequential run overlaps NOTHING today, because every `#emitDurable` call site awaits
  // and `#emitDurable` awaits its own region before returning. The overlap needs genuine concurrency.

  it('append audit: an ordinary SEQUENTIAL run already overlaps nothing (CR-10 baseline)', async () => {
    const audit = createAppendAudit(new InMemoryRunStore());
    const host = createInMemoryHost({ store: audit.store });
    const provider = scriptedProvider([textTurn('a summary')]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: HAPPY_PATH, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:completed');
    const runId = audit.runIds()[0];
    expect(runId).toBeDefined();
    const verdict = audit.verdict(runId ?? '');
    // The whole verdict, not just `holds` — a green here must not be a green produced by an empty ask list.
    expect(verdict.asked.length).toBeGreaterThan(3);
    expect(verdict.committed).toEqual(verdict.asked);
    expect(verdict.overlapViolations, formatAppendAudit(verdict)).toEqual([]);
    expect(verdict.holds, formatAppendAudit(verdict)).toBe(true);
  });

  // --- CR-92: the terminal outbox and the uncertain disposition (ADR-0078 §4, §5) -------------------

  /** A store whose TERMINAL write always fails; everything else lands. The CR-92 fixture. */
  function terminalRefusingStore(): RunStore {
    const inner = new InMemoryRunStore();
    return {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: async (event: RunEvent, ctx?: DurableWriteContext): Promise<void> => {
        if (event.type === 'run:completed' || event.type === 'run:failed') {
          throw new Error('the terminal write failed');
        }
        await inner.persistEvent(event, ctx);
      },
    };
  }

  it('CR-92: a terminal the store refuses is reported UNCERTAIN, not completed', async () => {
    // THE defect. Before this the caller drained `run:completed` with outputs while the durable log had no
    // terminal at all, and nothing in the API could tell the two apart.
    const outbox = createInMemoryTerminalOutbox();
    const host = createInMemoryHost({ store: terminalRefusingStore(), terminalOutbox: outbox });
    const handle = buildEngine(host, () => scriptedProvider([textTurn('a summary')])).start({
      workflow: HAPPY_PATH,
      inputs: INPUTS,
    });
    const { events } = await drive(handle, host);

    // The terminal is still DELIVERED — exactly-one-terminal is sacred, and a consumer's `for await` must
    // complete. What changes is that the handle no longer claims it is durable.
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(handle.durability()).toBe('uncertain');

    // …and the payload is held OUTSIDE the store, so a later start can retry it under the same identity.
    const held = await outbox.list();
    expect(held).toHaveLength(1);
    expect(held[0]?.type).toBe('run:completed');
    expect(held[0]?.runId).toBe(handle.runId);
  });

  it('CR-92: a terminal that LANDS reports durable, and holds nothing', async () => {
    // The negative control. Without it the assertion above passes for a handle that reports `uncertain`
    // unconditionally.
    const outbox = createInMemoryTerminalOutbox();
    const host = createInMemoryHost({ terminalOutbox: outbox });
    const handle = buildEngine(host, () => scriptedProvider([textTurn('a summary')])).start({
      workflow: HAPPY_PATH,
      inputs: INPUTS,
    });
    const { events } = await drive(handle, host);

    expect(events.at(-1)?.type).toBe('run:completed');
    expect(handle.durability()).toBe('durable');
    expect(await outbox.list()).toEqual([]);
  });

  it('CR-92: the outbox is DRAINED before reconciliation — a completed run is not relabelled failed', async () => {
    // The ordering ADR-0078 §4 calls load-bearing. Reconciliation sees a run with no durable terminal and
    // concludes it needs repair; if it ran first it would write `run:failed{internal}` for a run that
    // actually COMPLETED — the divergence the outbox exists to close, reintroduced by ordering.
    const inner = new InMemoryRunStore();
    let refuse = true;
    const store: RunStore = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: async (event: RunEvent, ctx?: DurableWriteContext): Promise<void> => {
        if (refuse && event.type === 'run:completed') throw new Error('the terminal write failed');
        await inner.persistEvent(event, ctx);
      },
    };
    const outbox = createInMemoryTerminalOutbox();
    const host = createInMemoryHost({ store, terminalOutbox: outbox });
    const handle = buildEngine(host, () => scriptedProvider([textTurn('a summary')])).start({
      workflow: HAPPY_PATH,
      inputs: INPUTS,
    });
    await drive(handle, host);
    expect(handle.durability()).toBe('uncertain');

    // A later start: the store is healthy again.
    refuse = false;
    const repaired = await buildEngine(host, () => scriptedProvider([])).reconcile();

    // THE assertion: the run's own `run:completed` was retried, NOT replaced by a reconciliation failure.
    expect(repaired.map((e) => e.type)).toEqual(['run:completed']);
    const durable = inner.eventsFor(handle.runId);
    const terminals = durable.filter((e) => e.type === 'run:completed' || e.type === 'run:failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('run:completed');
    expect(await outbox.list()).toEqual([]); // and the entry is forgotten once it lands
  });

  it('CR-92: a drained entry whose run ALREADY has a terminal is dropped, never appended', async () => {
    // The other direction: the original write may have committed and only its acknowledgement been lost.
    // Replaying blindly would break exactly-one-terminal from the path that exists to restore it.
    const inner = new InMemoryRunStore();
    const outbox = createInMemoryTerminalOutbox();
    const host = createInMemoryHost({ store: inner, terminalOutbox: outbox });
    const handle = buildEngine(host, () => scriptedProvider([textTurn('x')])).start({
      workflow: HAPPY_PATH,
      inputs: INPUTS,
    });
    await drive(handle, host);
    expect(handle.durability()).toBe('durable'); // it landed

    // Now plant a stale entry for that same run, as a crashed process would have left behind.
    const terminal = inner.eventsFor(handle.runId).at(-1);
    expect(terminal?.type).toBe('run:completed');
    if (terminal !== undefined) await outbox.put(terminal);

    const repaired = await buildEngine(host, () => scriptedProvider([])).reconcile();
    expect(repaired).toEqual([]); // dropped, not appended
    expect(await outbox.list()).toEqual([]); // and forgotten
    expect(inner.eventsFor(handle.runId).filter((e) => e.type === 'run:completed')).toHaveLength(1);
  });

  it('append audit: reconcile() carries the guard too — the SECOND write path (ADR-0078 §3)', async () => {
    // `reconcile()` bypasses `#emitDurable` and calls the store directly, so every property established at
    // that choke point has to be re-established here or it holds for one of two writers.
    //
    // **This test was HOLLOW when first written, and the shape of the mistake is worth keeping.** It called
    // `reconcile()` twice and asserted the second produced nothing — which it does, but for the wrong
    // reason: `listInterruptedRuns` already excludes a run that carries a terminal, so the second call never
    // reaches the guarded write at all. Measured: removing the guard entirely from `reconcile()` left all
    // 1165 `packages/core` tests green, including this one. Two concurrent reconciles against ONE still-
    // interrupted run is the scenario that actually forces the refusal — both read the same belief, only one
    // can be right.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    const engine = buildEngine(host, () => scriptedProvider([textTurn('x')]));

    const runId = 'r-interrupted';
    const base = { runId, timestamp: '2026-01-01T00:00:00.000Z' } as const;
    await store.persistEvent({
      type: 'run:started',
      ...base,
      sequenceNumber: 0,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    });
    await store.persistEvent({
      type: 'node:started',
      ...base,
      sequenceNumber: 1,
      nodeId: 'n',
      nodeType: 'agent',
    });

    // Both reconciles read the same `lastSequenceNumber`; the loser's belief is stale by the time it writes.
    const [a, b] = await Promise.all([engine.reconcile(), engine.reconcile()]);
    const repaired = [...a, ...b];

    // THE assertion: exactly one repair landed. Without the guard both commit and the run carries two
    // terminals, breaking ADR-0036's exactly-one-terminal from the path that exists to restore it.
    expect(repaired).toHaveLength(1);
    const terminals = store
      .eventsFor(runId)
      .filter((e) => e.type === 'run:failed' || e.type === 'run:completed');
    expect(terminals).toHaveLength(1);
  });

  it('append audit: the engine PASSES the guard, with the right belief, and exempts the terminal', async () => {
    // Nothing observed the engine SIDE of ADR-0078 §2 — measured, both mutations pass the whole suite:
    // dropping the ctx entirely (the guard disconnected from the durable write path) and guarding the
    // terminal too (ADR-0036's exemption removed) each left all of `packages/core` green. A recording double
    // rather than the audit decorator, so this test does not depend on the harness being right.
    const seen: { seq: number; type: string; expected: number | undefined }[] = [];
    const inner = new InMemoryRunStore();
    const recording = {
      resolveWorkflowId: (slug: string) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      persistEvent: async (event: RunEvent, ctx?: DurableWriteContext): Promise<void> => {
        seen.push({
          seq: event.sequenceNumber,
          type: event.type,
          expected: ctx?.expectedLastSequenceNumber,
        });
        await inner.persistEvent(event, ctx);
      },
    };
    const host = createInMemoryHost({ store: recording });
    const provider = scriptedProvider([textTurn('a summary')]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: HAPPY_PATH, inputs: INPUTS }),
      host,
    );
    expect(events.at(-1)?.type).toBe('run:completed');

    // Every NON-terminal ask carries a belief, and it is the previous ask's sequence — not the previous
    // COMMITTED one, and not `undefined`.
    const nonTerminal = seen.filter((a) => !a.type.startsWith('run:'));
    expect(nonTerminal.length).toBeGreaterThan(1);
    expect(nonTerminal[0]?.expected).toBeDefined();
    for (let i = 1; i < nonTerminal.length; i += 1) {
      expect(nonTerminal[i]?.expected).toBe(nonTerminal[i - 1]?.seq);
    }
    // The first ask of the run believes the log is empty.
    expect(seen[0]?.expected).toBe(-1);
    // And the TERMINAL is unguarded — exactly-one-terminal outranks the guard (ADR-0036; CR-92 owns the
    // terminal's disposition). Asserted, because guarding it here would break resume in a way no other test
    // in this file would notice.
    const terminal = seen.at(-1);
    expect(terminal?.type).toBe('run:completed');
    expect(terminal?.expected).toBeUndefined();
  });

  it('append audit: a LOST non-terminal write makes the engine`s next ask fail closed (CR-10 acceptance)', async () => {
    // CR-10's acceptance clause — "a crash injected between the two must leave a prefix with no hole" —
    // driven through the real engine rather than at the store. One `node:completed` write is dropped; the
    // guard must then REFUSE the sibling's append rather than let it land past the gap, because the engine
    // keeps emitting (ADR-0078 §6 preserves totality for non-terminals).
    let dropped = 0;
    const audit = createAppendAudit(new InMemoryRunStore(), {
      fault: (event) => {
        if (event.type === 'node:completed' && dropped === 0) {
          dropped += 1;
          return new Error('the write was lost');
        }
        return 'commit';
      },
    });
    const host = createInMemoryHost({ store: audit.store });
    const provider = scriptedProvider([textTurn('one'), textTurn('two')]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: PARALLEL_PAIR, inputs: INPUTS }),
      host,
    );

    expect(dropped).toBe(1); // the fault really fired — without this the rest is vacuous
    expect(events.at(-1)?.type).toBe('run:failed');
    const records = audit.records();

    // **The property, asserted directly.** An earlier version of this test checked only
    // `rejected.length >= 1` — which the INJECTED loss already satisfies on its own, so it passed whether or
    // not the guard refused anything. At least two rejections are required: the loss, and the guarded ask
    // that would otherwise have committed past it.
    const rejected = records.filter((r) => r.outcome === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(2);

    // And the log itself: every NON-TERMINAL event committed before the first miss, and none after it. That
    // is CR-10's prefix property, stated over the segment CR-10 actually covers.
    const nonTerminal = records.filter((r) => !r.type.startsWith('run:'));
    const firstMiss = nonTerminal.findIndex((r) => r.outcome !== 'committed');
    expect(firstMiss).toBeGreaterThan(-1);
    expect(nonTerminal.slice(0, firstMiss).every((r) => r.outcome === 'committed')).toBe(true);
    expect(nonTerminal.slice(firstMiss).some((r) => r.outcome === 'committed')).toBe(false);

    // The TERMINAL is the one thing that does land past the miss, because it is exempt — recorded here
    // rather than hidden, since it is exactly the residual CR-92's outbox closes.
    expect(records.at(-1)?.type).toBe('run:failed');
    expect(records.at(-1)?.outcome).toBe('committed');
    expect(audit.verdict(audit.runIds()[0] ?? '').overlapViolations).toEqual([]);
  });

  it('append audit: a FAN-OUT run no longer overlaps its appends (CR-10 — the assertion that flipped)', async () => {
    // **This assertion is the acceptance, and it FLIPPED here.** It was written one commit earlier as
    // `expect(overlapViolations.length).toBeGreaterThan(0)` — the measured pre-CR-10 baseline, in which a
    // `max_parallel: 2` fan-out produced exactly one overlap ("sequence 10 (node:completed) was asked while
    // [9] was still in flight"). Landing ADR-0078 §1's ordered tail turned that test red, and this is the
    // same test with the expectation inverted, which is what the phase document means by "break-verify by
    // restoring the concurrent start": put `await prior` back below the persist and this goes red again.
    //
    // Nothing else in `packages/core` moved — 1154 other tests stayed green through the change, which is the
    // evidence that serializing the append did not perturb any interleaving a test legitimately pins.
    const audit = createAppendAudit(new InMemoryRunStore());
    const host = createInMemoryHost({ store: audit.store });
    const provider = scriptedProvider([textTurn('one'), textTurn('two')]);
    const { events } = await drive(
      buildEngine(host, () => provider).start({ workflow: PARALLEL_PAIR, inputs: INPUTS }),
      host,
    );

    expect(events.at(-1)?.type).toBe('run:completed');
    const runId = audit.runIds()[0] ?? '';
    const verdict = audit.verdict(runId);
    expect(verdict.overlapViolations, formatAppendAudit(verdict)).toEqual([]);
    expect(verdict.holes).toEqual([]);
    expect(verdict.askOrderViolations).toEqual([]);
    expect(verdict.commitOrderViolations).toEqual([]);
    // Not vacuous: the run really did fan out and really did append. A green above with an empty ask list
    // would be the obvious way for this test to lie.
    expect(verdict.asked.length).toBeGreaterThan(4);
    expect(verdict.committed).toEqual(verdict.asked);
    // …and the PREMISE is asserted, not assumed: both nodes were genuinely in flight together. Without this
    // a one-character change to `max_parallel` (or a scheduler change) would turn the assertion above into a
    // tautology about a sequential run, which is green for a reason that has nothing to do with CR-10.
    const startedAt = events.findIndex((e) => e.type === 'node:started');
    const secondStart = events.findIndex((e, i) => i > startedAt && e.type === 'node:started');
    const firstComplete = events.findIndex((e) => e.type === 'node:completed');
    expect(secondStart).toBeGreaterThan(-1);
    expect(secondStart).toBeLessThan(firstComplete);
  });
});
