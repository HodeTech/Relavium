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
  ProviderId,
  StreamChunk,
} from '@relavium/llm';
import {
  RunEventSchema,
  type AbortSignalLike,
  type ContentPart,
  type MediaReferencePort,
  type MediaStore,
  type RunEvent,
} from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import { parseWorkflow } from '../parser.js';
import type { ToolDef as CoreToolDef, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
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
    pollMediaJob: (_jobId: string, _key: string, signal?: AbortSignalLike) => {
      if (signal?.aborted === true) {
        return Promise.reject(new Error('poll aborted')); // a run cancel aborts the in-flight poll (ADR-0045 §4)
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

const INPUTS = { topic: 'the report' } as const;

// --- The reusable driver ---------------------------------------------------------------------------

type Host = ReturnType<typeof createInMemoryHost>;

function buildEngine(
  host: Host,
  resolveProvider: (id: ProviderId) => LlmProvider | undefined,
  resolveMediaSurface?: (model: string) => 'chat' | 'generative' | undefined,
): WorkflowEngine {
  return new WorkflowEngine({
    host,
    executor: createStandardNodeExecutor({
      sandbox,
      agent: {
        resolveProvider,
        ...(resolveMediaSurface === undefined ? {} : { resolveMediaSurface }),
        registry: echoRegistry,
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
      pollMediaJob: () =>
        // @ts-expect-error — an out-of-union job state (a future seam value / a non-conforming adapter) forces
        // the closed-switch's default arm, which MUST fail the node terminally rather than leave it parked with
        // no re-arm and no terminal (a silent hang).
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
});
