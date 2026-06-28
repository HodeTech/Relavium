import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { createRunHistoryStore, type Db } from '@relavium/db';
import { CapabilityFlagsSchema, type CapabilityFlags } from '@relavium/llm';
import { RunEventSchema, type RunEvent } from '@relavium/shared';

import type { CliIo } from './process/io.js';

/**
 * A well-formed chat-surface {@link CapabilityFlags} (text-only output) — the `model_catalog.capabilities` blob
 * the D15 load-check projects and re-validates. Built THROUGH `CapabilityFlagsSchema` so the drift-refine
 * (`vision` mirrors `media.input.image`, ADR-0031) is enforced at module load: the single fixture both the
 * media-wiring and `run` command tests project, so that invariant is encoded once, not copied per file.
 */
export const CHAT_TEXT_CAPABILITY_FLAGS: CapabilityFlags = CapabilityFlagsSchema.parse({
  tools: true,
  streaming: true,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['text']],
    surface: 'chat',
  },
});

/**
 * A well-formed generative-surface {@link CapabilityFlags} — routes to `generateMedia` (ADR-0045 §1), so its
 * inline `outputCombinations` is empty and the load-check's generative branch keys on `media.surface`. The
 * matching catalog row drives the projection's generative path (distinct from the chat inline-membership path).
 */
export const GENERATIVE_IMAGE_CAPABILITY_FLAGS: CapabilityFlags = CapabilityFlagsSchema.parse({
  tools: false,
  streaming: false,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
    surface: 'generative',
  },
});

/**
 * Test-only IO capture: a {@link CliIo} whose `writeOut`/`writeErr` accumulate into arrays, so a test
 * can assert on the exact stdout (NDJSON / human lines) and stderr (diagnostics) a command produced.
 * Shared by the command tests and the 2.K regression harness so the capture shape never diverges.
 */
export function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    writeOut: (text) => {
      outChunks.push(text);
    },
    writeErr: (text) => {
      errChunks.push(text);
    },
    env: {},
    stdoutIsTty: false,
    stdinIsTty: false,
    // An empty, already-ended stub: a chat test that exercises the plain loop overrides it with its own stream;
    // a test that forgets reads an immediate EOF here rather than silently draining the real process.stdin.
    stdin: Readable.from([]),
  };
  return { io, out: () => outChunks.join(''), err: () => errChunks.join('') };
}

/**
 * Parse an NDJSON stdout capture into typed records for assertions: split on newlines, `JSON.parse` each
 * non-empty line to `unknown`, and REJECT a line that is not a JSON object — so a malformed or non-object
 * fixture fails loudly here rather than being silently accepted by an inline cast. The element type `T` is the
 * caller's asserted contract (the runtime guard catches structural garbage; the per-test assertions verify the
 * fields), centralizing the one narrowing the read-command tests share.
 */
export function parseNdjson<T = Record<string, unknown>>(text: string): T[] {
  return text
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): T => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`expected one JSON object per NDJSON line, got: ${line}`);
      }
      // The guard narrows to a non-null, non-array object; `T` is the caller's asserted record shape (a
      // test-only convenience). The structural garbage a real bug would emit is already rejected above.
      return parsed as T;
    });
}

/** The variant body of a RunEvent (envelope stripped) — so {@link seedRun}'s emits are type-checked per variant. */
type EventBody<T extends RunEvent['type']> = Omit<
  Extract<RunEvent, { type: T }>,
  'type' | 'runId' | 'timestamp' | 'sequenceNumber'
>;

/** One pending human gate to seed on a `paused` run (each gets a `human_gate:paused` event at node `g`). */
export interface SeedGate {
  readonly gateId: string;
  readonly gateType: 'approval' | 'input' | 'review';
  readonly message?: string;
}

/**
 * For a `paused` run, the human gate(s) to leave pending — `gate` (one) XOR `gates` (several distinct
 * `gateId`s, the fan-out case). The `never` arms make supplying both a COMPILE error rather than a silent drop.
 */
type SeedGateFields =
  | { readonly gate?: SeedGate; readonly gates?: never }
  | { readonly gate?: never; readonly gates?: readonly SeedGate[] };

export type SeedRunOptions = {
  readonly slug: string;
  readonly runId: string;
  readonly state: 'running' | 'paused' | 'completed' | 'failed';
  /** Drives `createdAt`/`updatedAt` (and the event timestamps) so a test can order runs deterministically. */
  readonly atMs?: number;
  /** For a `paused` run: also leave a BUDGET gate pending (excluded from the human-gate listings). */
  readonly budgetGateId?: string;
} & SeedGateFields;

const DEFAULT_TS_MS = 1_750_000_000_000;

/**
 * Seed one run into the history db for the read-command tests (`list`/`logs`/`status`/`gate list`, 2.I):
 * `run:started` → one node lifecycle → the requested terminal/pause state. A `paused` run carries a pending
 * suspension reason: a human and/or budget gate when one is given, else an async media-job park (the only other
 * valid pause — `RunEventSchema` rejects a `run:paused` with no reason). Events go through the real `persistEvent`
 * (so `RunEventSchema` validates them and a malformed fixture fails loudly at seed time). Returns the run id.
 */
export async function seedRun(db: Db, opts: SeedRunOptions): Promise<string> {
  const tsMs = opts.atMs ?? DEFAULT_TS_MS;
  const ts = new Date(tsMs).toISOString();
  const store = createRunHistoryStore(db, {
    uuid: () => randomUUID(),
    now: () => tsMs,
    workflow: {
      slug: opts.slug,
      name: opts.slug,
      definitionJson: JSON.stringify({
        schema_version: '1.0',
        workflow: { id: opts.slug, nodes: [], edges: [] },
      }),
    },
  });
  const workflowId = await store.resolveWorkflowId(opts.slug);
  let seq = 0;
  const emit = async <T extends RunEvent['type']>(type: T, rest: EventBody<T>): Promise<void> => {
    // Build through the schema (no `as` cast): the envelope + the per-variant `rest` are validated into a
    // `RunEvent`, so a wrong/missing field fails loudly HERE at seed time. `rest: EventBody<T>` keeps the input
    // per-variant type-checked at compile time.
    const event = RunEventSchema.parse({
      type,
      runId: opts.runId,
      timestamp: ts,
      sequenceNumber: seq,
      ...rest,
    });
    seq += 1;
    await store.persistEvent(event);
  };

  await emit('run:started', { workflowId, inputs: {}, executionMode: 'local' });
  await emit('node:started', { nodeId: 'n1', nodeType: 'transform' });
  await emit('node:completed', {
    nodeId: 'n1',
    output: {},
    tokensUsed: { input: 1, output: 2 },
    durationMs: 5,
    cumulativeCostMicrocents: 100,
  });
  if (opts.state === 'paused') {
    const gates: readonly SeedGate[] = opts.gates ?? (opts.gate === undefined ? [] : [opts.gate]);
    if (opts.budgetGateId !== undefined || gates.length > 0) {
      // A real gate parks AT node `g`, so emit its start (the step row a `status` listing shows).
      await emit('node:started', { nodeId: 'g', nodeType: 'human_in_the_loop' });
      if (opts.budgetGateId !== undefined) {
        await emit('budget:paused', {
          nodeId: 'g',
          gateId: opts.budgetGateId,
          spentMicrocents: 100,
          limitMicrocents: 50,
        });
      }
      // Each human gate (distinct gateId) folds into a separate pending entry — exercises the multi-gate fan-out.
      for (const gate of gates) {
        await emit('human_gate:paused', {
          nodeId: 'g',
          gateId: gate.gateId,
          gateType: gate.gateType,
          message: gate.message ?? 'ok?',
        });
      }
    } else {
      // No human/budget gate — model an async MEDIA-JOB park (1.AG Section D, ADR-0045 §2): a generative node
      // parks awaiting its job, so `run:paused` carries `pendingMediaJobNodeIds` (NOT a gate). This is the only
      // valid zero-gate pause — `RunEventSchema` rejects a `run:paused` that carries no suspension reason at all,
      // so the park MUST seed the parked node + its `media_job:submitted` (an empty `run:paused` is malformed).
      await emit('node:started', { nodeId: 'g', nodeType: 'agent' });
      await emit('media_job:submitted', {
        nodeId: 'g',
        jobId: 'job-1',
        provider: 'openai',
        model: 'gpt-image-1',
        modality: 'image',
        startedAt: ts,
        deadlineAt: new Date(tsMs + 60_000).toISOString(),
      });
      await emit('run:paused', { pendingGateCount: 0, gateIds: [], pendingMediaJobNodeIds: ['g'] });
    }
  } else if (opts.state === 'completed') {
    await emit('run:completed', {
      outputs: {},
      totalTokensUsed: { input: 1, output: 2 },
      totalCostMicrocents: 100,
      durationMs: 9,
    });
  } else if (opts.state === 'failed') {
    await emit('run:failed', {
      error: { code: 'internal', message: 'boom', retryable: false },
      partialOutputs: {},
    });
  }
  return opts.runId;
}
