import { randomUUID } from 'node:crypto';

import { createRunHistoryStore, type Db } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';

import type { CliIo } from './process/io.js';

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
      return parsed as T;
    });
}

/** The variant body of a RunEvent (envelope stripped) — so {@link seedRun}'s emits are type-checked per variant. */
type EventBody<T extends RunEvent['type']> = Omit<
  Extract<RunEvent, { type: T }>,
  'type' | 'runId' | 'timestamp' | 'sequenceNumber'
>;

export interface SeedRunOptions {
  readonly slug: string;
  readonly runId: string;
  readonly state: 'running' | 'paused' | 'completed';
  /** Drives `createdAt`/`updatedAt` (and the event timestamps) so a test can order runs deterministically. */
  readonly atMs?: number;
  /** For a `paused` run: leave a human gate pending so reconstruct / `status` / `gate list` surface it. */
  readonly gate?: {
    readonly gateId: string;
    readonly gateType: 'approval' | 'input' | 'review';
    readonly message?: string;
  };
  /** For a `paused` run: also leave a BUDGET gate pending (excluded from the human-gate listings). */
  readonly budgetGateId?: string;
}

const DEFAULT_TS_MS = 1_750_000_000_000;

/**
 * Seed one run into the history db for the read-command tests (`list`/`logs`/`status`/`gate list`, 2.I):
 * `run:started` → one node lifecycle → the requested terminal/pause state. A `paused` run can carry a pending
 * human and/or budget gate. Events go through the real `persistEvent` (so `RunEventSchema` validates them and a
 * malformed fixture fails loudly at seed time). Returns the run id.
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
    const event = {
      type,
      runId: opts.runId,
      timestamp: ts,
      sequenceNumber: seq,
      ...rest,
    } as Extract<RunEvent, { type: T }>;
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
    await emit('node:started', { nodeId: 'g', nodeType: 'human_in_the_loop' });
    let parked = false;
    if (opts.budgetGateId !== undefined) {
      await emit('budget:paused', {
        nodeId: 'g',
        gateId: opts.budgetGateId,
        spentMicrocents: 100,
        limitMicrocents: 50,
      });
      parked = true;
    }
    if (opts.gate !== undefined) {
      await emit('human_gate:paused', {
        nodeId: 'g',
        gateId: opts.gate.gateId,
        gateType: opts.gate.gateType,
        message: opts.gate.message ?? 'ok?',
      });
      parked = true;
    }
    if (!parked) {
      // No specific gate supplied — still GUARANTEE the run parks (a media-job-style park), so `state: 'paused'`
      // is never silently a 'running' run. run:paused folds to status 'paused' with no pending human gate.
      await emit('run:paused', { pendingGateCount: 0, gateIds: [] });
    }
  } else if (opts.state === 'completed') {
    await emit('run:completed', {
      outputs: {},
      totalTokensUsed: { input: 1, output: 2 },
      totalCostMicrocents: 100,
      durationMs: 9,
    });
  }
  return opts.runId;
}
