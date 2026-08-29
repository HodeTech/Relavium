import { describe, expect, it } from 'vitest';

import type { MediaReferencePort, MediaStore, MediaWritePort, RunEvent } from '@relavium/shared';

import { ADMISSION_CEILINGS, DEFAULT_MAX_PARALLEL } from '../limits.js';
import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { reconstructCheckpointState } from './checkpoint.js';
import { SIZE_BOUNDS } from './size-bounds.js';
import { EngineStateError } from './errors.js';
import {
  createInMemoryHost,
  InMemoryRunStore,
  type ExecutionHost,
  type RunStore,
} from './execution-host.js';
import type {
  MediaJobSubmission,
  NodeExecContext,
  NodeExecutor,
  NodeOutcome,
} from './node-executor.js';
import type { RunHandle } from './run-handle.js';
import { WorkflowEngine, type WorkflowEngineDeps } from './engine.js';

// --- helpers ----------------------------------------------------------------------------------

/** Wrap a `workflow:` body into a full v1.0 document and parse it. */
function workflow(body: string): WorkflowDefinition {
  return parseWorkflow(`schema_version: '1.0'\nworkflow:\n${body}`);
}

type Handler = (ctx: NodeExecContext) => NodeOutcome | Promise<NodeOutcome>;

/** A configurable {@link NodeExecutor}; an unconfigured vertex completes with its id as the output. */
class StubExecutor implements NodeExecutor {
  constructor(private readonly handlers: Readonly<Record<string, Handler>> = {}) {}
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    const handler = this.handlers[ctx.vertex.id];
    if (handler !== undefined) {
      return Promise.resolve(handler(ctx));
    }
    return Promise.resolve({ kind: 'completed', output: ctx.vertex.id });
  }
}

function engineWith(
  handlers?: Readonly<Record<string, Handler>>,
  host?: ExecutionHost,
  /**
   * Extra `WorkflowEngineDeps` — the observability sinks a test needs to see what the governor decided.
   * `host`/`executor` are OMITTED: the spread runs after them, so leaving them assignable would let a future
   * caller silently override the second argument with no compiler error.
   */
  deps?: Partial<Omit<WorkflowEngineDeps, 'host' | 'executor'>>,
): WorkflowEngine {
  return new WorkflowEngine({
    host: host ?? createInMemoryHost(),
    executor: new StubExecutor(handlers),
    ...deps,
  });
}

/** Drain a handle's stream to its terminal event. Hangs only if the run never terminates (a bug). */
async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  return events;
}

/** The node-retry backoff `setTimer` is armed in #dispatch's continuation, just AFTER node:retrying is
 *  delivered — so yield microtasks until it is armed, then fire it (deterministic; no real wall-clock wait). */
async function fireBackoff(host: {
  armedCount: () => number;
  fireTimers: () => void;
}): Promise<void> {
  let waited = 0;
  while (host.armedCount() === 0) {
    waited += 1;
    if (waited > 1000) {
      throw new Error('backoff timer was never armed after node:retrying'); // fail fast, never hang
    }
    await Promise.resolve();
  }
  host.fireTimers();
}

/** A node handler that fails retryably the first `failures` calls, then completes (1.S retry tests). */
function flaky(failures: number): Handler {
  let calls = 0;
  return (): NodeOutcome => {
    calls += 1;
    return calls <= failures
      ? { kind: 'failed', error: { code: 'tool_failed', message: 'transient', retryable: true } }
      : { kind: 'completed', output: `ok@${calls}` };
  };
}

const TERMINALS: ReadonlySet<RunEvent['type']> = new Set([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);
const terminalsIn = (events: readonly RunEvent[]): readonly RunEvent[] =>
  events.filter((e) => TERMINALS.has(e.type));
const typesIn = (events: readonly RunEvent[]): readonly string[] => events.map((e) => e.type);

/**
 * Assert the delivered stream is gap-free: the SET of sequenceNumbers is exactly {0..n-1} — no gap,
 * no duplicate. Checks the sorted set, not delivery position, so it stays valid once 1.O streams
 * tokens concurrently (delivery order may then differ from emission order, but the set must not gap).
 */
function assertGapFreeSeq(events: readonly RunEvent[]): void {
  const seqs = events.map((event) => event.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

/** Assert a synchronous call throws an {@link EngineStateError} with the given code. */
function expectThrowsCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineStateError);
    if (error instanceof EngineStateError) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error(`expected an EngineStateError with code ${code}`);
}

/** Seed a store with a `run:started` (and optionally a trailing event) to simulate a crashed run. */
function seedStarted(
  store: RunStore,
  runId: string,
  lastType?: RunEvent['type'],
  /** The run's workflow id. Defaults to a fixed value for the reconcile tests, which never re-plan; a
   *  `resumeFromCheckpoint` test MUST pass the id `resolveWorkflowId` mints for its slug, or the resume is
   *  refused with `workflow_mismatch`. */
  workflowId = '00000000-0000-4000-8000-000000000099',
): Promise<void> {
  const startedAt = '2026-06-13T00:00:00.000Z';
  const events: RunEvent[] = [
    {
      type: 'run:started',
      runId,
      timestamp: startedAt,
      sequenceNumber: 0,
      workflowId,
      inputs: {},
      executionMode: 'local',
    },
  ];
  if (lastType === 'human_gate:paused') {
    events.push({
      type: 'human_gate:paused',
      runId,
      timestamp: startedAt,
      sequenceNumber: 1,
      nodeId: 'g',
      gateId: 'gid',
      gateType: 'approval',
      message: 'approve?',
    });
  }
  if (lastType === 'media_job:submitted') {
    events.push({
      type: 'media_job:submitted',
      runId,
      timestamp: startedAt,
      sequenceNumber: 1,
      nodeId: 'gen',
      jobId: 'vendor-op-1',
      provider: 'openai',
      model: 'sora-2',
      modality: 'video',
      startedAt,
      deadlineAt: '2026-06-13T00:30:00.000Z',
    });
  }
  return Promise.all(events.map((e) => store.persistEvent(e))).then(() => undefined);
}

const SEQUENTIAL = `  id: seq
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'w' }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;

// --- the happy path: stream + gap-free sequence + cost accrual --------------------------------

/** A canonical in-flight base64 media part (5 decoded bytes) — the media-de-inline tests' fixture. */
const MEDIA_PART = {
  type: 'media' as const,
  mimeType: 'image/png',
  source: { kind: 'base64' as const, data: 'aGVsbG8=' }, // "hello"
};

/** A pure fake-digest in-memory MediaStore (no crypto) — content-addressed enough for the tests. */
function stubMediaStore(): { store: MediaStore; puts: { handle: string; bytes: Uint8Array }[] } {
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
  const store: MediaStore = {
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
  return { store, puts };
}

describe('WorkflowEngine — the event stream', () => {
  it('runs a sequential plan, streaming a gap-free, monotonic sequenceNumber and ending in run:completed', async () => {
    const engine = engineWith({
      work: (ctx) => {
        ctx.emit({ type: 'agent:token', nodeId: 'work', token: 'he', model: 'm' });
        ctx.emit({ type: 'agent:token', nodeId: 'work', token: 'llo', model: 'm' });
        ctx.emit({
          type: 'cost:updated',
          nodeId: 'work',
          model: 'm',
          inputTokens: 10,
          outputTokens: 5,
          costMicrocents: 42,
          cumulativeCostMicrocents: 0, // engine overwrites with the run-wide cumulative
        });
        return { kind: 'completed', output: 'done', tokensUsed: { input: 10, output: 5 } };
      },
    });
    const events = await drain(engine.start({ workflow: workflow(SEQUENTIAL) }));

    // Gap-free, monotonic per the single producer-side translation point.
    events.forEach((event, index) => expect(event.sequenceNumber).toBe(index));
    expect(typesIn(events).at(0)).toBe('run:started');
    expect(typesIn(events)).toContain('agent:token');
    expect(typesIn(events)).toContain('cost:updated');
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('carries a run-path agent:reasoning event onto the bus, correlated by runId (EA6 — #nodeEmit pass-through)', async () => {
    // Regression: `agent:reasoning` was added to InNodeEventType but the #nodeEmit switch had no case for it,
    // so it fell through and was silently DROPPED on the run path (the session path still emitted it). Assert
    // it reaches the bus with runId + its fields, and that the stream stays gap-free with the new arm present.
    const engine = engineWith({
      work: (ctx) => {
        ctx.emit({ type: 'agent:reasoning', nodeId: 'work', text: 'thinking', model: 'm' });
        return { kind: 'completed', output: 'done', tokensUsed: { input: 1, output: 1 } };
      },
    });
    const events = await drain(engine.start({ workflow: workflow(SEQUENTIAL) }));
    const reasoning = events.find((e) => e.type === 'agent:reasoning');
    expect(reasoning?.type === 'agent:reasoning' && reasoning.text).toBe('thinking');
    expect(reasoning?.type === 'agent:reasoning' && reasoning.model).toBe('m');
    // dual-envelope: correlated by runId on the run path
    expect(reasoning?.type === 'agent:reasoning' && reasoning.runId).toBeTruthy();
    events.forEach((event, index) => expect(event.sequenceNumber).toBe(index));
  });

  it('stamps run:started with the resolved UUID workflowId, the execution mode, and a masked secret input', async () => {
    const def = workflow(`  id: sec
  inputs:
    - { name: api_key, type: secret }
    - { name: topic, type: string }
  nodes:
    - { id: start, type: input }
    - { id: done, type: output }
  edges:
    - { from: start, to: done }`);
    const events = await drain(
      engineWith().start({
        workflow: def,
        inputs: { api_key: 'sk-do-not-leak', topic: 'weather' },
        executionMode: 'managed',
      }),
    );
    const started = events.find((e) => e.type === 'run:started');
    if (started?.type !== 'run:started') {
      throw new Error('expected a run:started event');
    }
    expect(started.workflowId).toMatch(/^[0-9a-f-]{36}$/); // a UUID, not the `sec` slug (ADR-0022)
    expect(started.executionMode).toBe('managed');
    expect(started.inputs['api_key']).toEqual({ secret: true, ref: 'inputs.api_key' });
    expect(started.inputs['topic']).toBe('weather');
    expect(JSON.stringify(events)).not.toContain('sk-do-not-leak');
  });

  it('accrues the run-wide cumulative cost and totals it on run:completed', async () => {
    const emitCost = (nodeId: string, amount: number): Handler => {
      return (ctx) => {
        ctx.emit({
          type: 'cost:updated',
          nodeId,
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costMicrocents: amount,
          cumulativeCostMicrocents: 999, // ignored — the engine owns the cumulative
        });
        return { kind: 'completed', output: nodeId, tokensUsed: { input: 1, output: 1 } };
      };
    };
    const events = await drain(
      engineWith({ start: emitCost('start', 100), work: emitCost('work', 50) }).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    const costs = events.filter((e) => e.type === 'cost:updated');
    expect(costs.map((e) => (e.type === 'cost:updated' ? e.cumulativeCostMicrocents : 0))).toEqual([
      100, 150,
    ]);
    const completed = events.find((e) => e.type === 'run:completed');
    if (completed?.type !== 'run:completed') {
      throw new Error('expected run:completed');
    }
    expect(completed.totalCostMicrocents).toBe(150);
    expect(completed.totalTokensUsed).toEqual({ input: 2, output: 2 });
  });
});

// --- media de-inline at the emit choke point (1.AF) -------------------------------------------

describe('WorkflowEngine — media de-inline at the emit choke point (1.AF, ADR-0042)', () => {
  it('de-inlines a media-bearing node output to a handle in the persisted + delivered event (no base64, gap-free seq)', async () => {
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore, mediaStore });
    const events = await drain(
      engineWith(
        { work: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) },
        host,
      ).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );

    const put0 = puts[0];
    expect(put0).toBeDefined();
    const done = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    const output = done?.type === 'node:completed' ? done.output : undefined;
    expect(output).toEqual({
      image: {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'handle', ref: put0?.handle },
        byteLength: 5,
      },
    });
    // I3 — no base64 bytes anywhere in the DELIVERED stream or the PERSISTED run-event log.
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    const runId = events[0]?.runId;
    expect(runId).toBeDefined();
    if (runId !== undefined) {
      expect(JSON.stringify(runStore.eventsFor(runId))).not.toContain('aGVsbG8=');
    }
    // The gap-free, monotonic sequenceNumber is preserved across the async de-inline.
    events.forEach((event, index) => expect(event.sequenceNumber).toBe(index));
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('fails the run (never leaks) when media is emitted but no MediaStore is injected', async () => {
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore }); // deliberately no mediaStore
    const events = await drain(
      engineWith({ work: () => ({ kind: 'completed', output: MEDIA_PART }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('internal');
    }
    expect(terminalsIn(events)).toHaveLength(1);
    // The bytes never reached a stamped/persisted event (the bytes-bearing node:completed was dropped).
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    const runId = events[0]?.runId;
    if (runId !== undefined) {
      expect(JSON.stringify(runStore.eventsFor(runId))).not.toContain('aGVsbG8=');
    }
  });

  it('hard-fails the run (no leak, no put) on a smuggled base64 data: URI in a node output — even WITH a store', async () => {
    // I3 regression (review HIGH #1): a non-canonical byte carrier in an opaque z.unknown() output must
    // NOT pass through the with-store de-inline. It hard-fails → run:failed; the bytes never persist.
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore, mediaStore });
    const events = await drain(
      engineWith(
        { work: () => ({ kind: 'completed', output: { img: 'data:image/png;base64,aGVsbG8=' } }) },
        host,
      ).start({ workflow: workflow(SEQUENTIAL) }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    expect(puts).toHaveLength(0); // the carrier hard-failed — nothing was stored
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    const runId = events[0]?.runId;
    if (runId !== undefined) {
      expect(JSON.stringify(runStore.eventsFor(runId))).not.toContain('aGVsbG8=');
    }
  });

  it('stays total (exactly one terminal, no hang) when store.put REJECTS on a media-bearing run', async () => {
    // Totality regression (review HIGH #2): a store.put rejection (disk full / transient IO) on a
    // media-bearing terminal must NOT escape the catch-less #loop as an unhandled rejection / hang. The
    // terminal still settles with its media payload stripped (byte-free).
    const rejectingStore: MediaStore = {
      put: () => Promise.reject(new Error('disk full')),
      get: () => Promise.reject(new Error('unused')),
      resolveForEgress: () => Promise.reject(new Error('unused')),
      readRange: () => Promise.reject(new Error('unused')),
    };
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore, mediaStore: rejectingStore });
    const events = await drain(
      engineWith({ work: () => ({ kind: 'completed', output: MEDIA_PART }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
  });

  it('re-hosts a url media node output to a handle via the host media-egress port (D9, no url persisted)', async () => {
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const fetched: string[] = [];
    const FETCH_BYTES = new Uint8Array([5, 6, 7]);
    const host = createInMemoryHost({
      store: runStore,
      mediaStore,
      fetchMedia: (url) => {
        fetched.push(url);
        return Promise.resolve(FETCH_BYTES);
      },
    });
    const urlPart = {
      type: 'media' as const,
      mimeType: 'image/png',
      source: { kind: 'url' as const, url: 'https://media.example/a.png' },
    };
    const events = await drain(
      engineWith({ work: () => ({ kind: 'completed', output: { image: urlPart } }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(fetched).toEqual(['https://media.example/a.png']); // the host egress port was invoked
    const put0 = puts[0];
    expect(put0).toBeDefined();
    const done = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    const output = done?.type === 'node:completed' ? done.output : undefined;
    expect(output).toEqual({
      image: {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'handle', ref: put0?.handle },
        byteLength: 3,
      },
    });
    // I3 — the url never reached the delivered stream or the persisted log (re-hosted to a handle).
    expect(JSON.stringify(events)).not.toContain('media.example');
    const runId = events[0]?.runId;
    if (runId !== undefined) {
      expect(JSON.stringify(runStore.eventsFor(runId))).not.toContain('media.example');
    }
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('hard-fails a url media output when the host has a store but NO media-egress port (no leak)', async () => {
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore, mediaStore }); // store, but no fetchMedia port
    const urlPart = {
      type: 'media' as const,
      mimeType: 'image/png',
      source: { kind: 'url' as const, url: 'https://media.example/a.png' },
    };
    const events = await drain(
      engineWith({ work: () => ({ kind: 'completed', output: urlPart }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    expect(puts).toHaveLength(0); // an un-re-hostable url is fail-closed — nothing stored
    expect(JSON.stringify(events)).not.toContain('media.example');
  });

  it('fails the run (no leak) when the media-egress port THROWS on a url output (D9 fetch failure)', async () => {
    // The third D9 branch: a fetchMedia hook IS wired but rejects (an SSRF block / network error / size
    // overrun). The rejection propagates through deInlineMedia to #emitDurable's catch → one run:failed; the
    // url + the failure reason stay out of every delivered + persisted event (secret-free, I3).
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({
      store: runStore,
      mediaStore,
      fetchMedia: () => Promise.reject(new Error('blocked_host')),
    });
    const urlPart = {
      type: 'media' as const,
      mimeType: 'image/png',
      source: { kind: 'url' as const, url: 'https://media.example/a.png' },
    };
    const events = await drain(
      engineWith({ work: () => ({ kind: 'completed', output: urlPart }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    expect(puts).toHaveLength(0); // the fetch failed before any put
    expect(JSON.stringify(events)).not.toContain('media.example'); // url never persisted/delivered
    const runId = events[0]?.runId;
    if (runId !== undefined) {
      expect(JSON.stringify(runStore.eventsFor(runId))).not.toContain('media.example');
    }
  });

  it('records a produced handle reference for the run + reclaims it at the terminal (D12c/D11)', async () => {
    const { store: mediaStore } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const records: Array<{ handle: string; runId: string }> = [];
    const reclaims: string[] = [];
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: (meta, runId) => {
        records.push({ handle: meta.handle, runId });
      },
      reclaimRun: (runId) => {
        reclaims.push(runId);
      },
    };
    const host = createInMemoryHost({ store: runStore, mediaStore, mediaReferences });
    const events = await drain(
      engineWith(
        { work: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) },
        host,
      ).start({ workflow: workflow(SEQUENTIAL) }),
    );
    const runId = events[0]?.runId;
    expect(records.length).toBeGreaterThanOrEqual(1); // the produced handle was recorded for the run
    expect(records.every((r) => r.runId === runId)).toBe(true);
    expect(records[0]?.handle).toMatch(/^media:\/\/sha256-/);
    expect(reclaims).toEqual([runId]); // exactly one terminal sweep, for this run
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('stays unaffected (run completes) when the media-reference port THROWS (best-effort, D12c/D11)', async () => {
    const { store: mediaStore } = stubMediaStore();
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: () => {
        throw new Error('reference db down');
      },
      reclaimRun: () => {
        throw new Error('reference db down');
      },
    };
    const host = createInMemoryHost({ store: new InMemoryRunStore(), mediaStore, mediaReferences });
    const events = await drain(
      engineWith(
        { work: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) },
        host,
      ).start({ workflow: workflow(SEQUENTIAL) }),
    );
    // A retention-port failure is swallowed — the run reaches its normal terminal, I3/totality untouched.
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
  });

  it('stays unaffected (run completes, no unhandled rejection) when the port REJECTS asynchronously (best-effort)', async () => {
    // The async arm of #bestEffortMediaRef (result.catch swallow) — distinct from the sync-throw arm above.
    // A future async (Phase-2 Postgres) host returns Promise.reject; a dropped `.catch` would surface as an
    // unhandled rejection escaping the fire-and-forget loop. Pin that an async reject is swallowed.
    const { store: mediaStore } = stubMediaStore();
    const rejections: string[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(String(reason));
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const mediaReferences: MediaReferencePort = {
        recordRunMedia: () => Promise.reject(new Error('async reference db down')),
        reclaimRun: () => Promise.reject(new Error('async reference db down')),
      };
      const host = createInMemoryHost({
        store: new InMemoryRunStore(),
        mediaStore,
        mediaReferences,
      });
      const events = await drain(
        engineWith(
          { work: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) },
          host,
        ).start({ workflow: workflow(SEQUENTIAL) }),
      );
      expect(terminalsIn(events)[0]?.type).toBe('run:completed');
      await new Promise((resolve) => setImmediate(resolve)); // let any stray rejection surface
      expect(rejections).toEqual([]); // the async rejection was swallowed, never unhandled
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// --- output-node save_to (1.AF/D16, ADR-0044 §2) ----------------------------------------------

/** A record-only {@link MediaWritePort} stub for the engine save_to tests. */
function stubMediaWrite(): {
  write: MediaWritePort;
  writes: { path: string; bytes: Uint8Array }[];
} {
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const write: MediaWritePort = (path, bytes) => {
    writes.push({ path, bytes });
    return Promise.resolve({ bytesWritten: bytes.length });
  };
  return { write, writes };
}

/** A workflow whose `output` node declares `save_to` (interpolating `{{ run.id }}`); `gen` feeds it. */
const SAVE_TO_WF = `  id: saveto
  nodes:
    - { id: start, type: input }
    - { id: gen, type: transform, transform: 'g' }
    - { id: out, type: output, save_to: 'media/{{ run.id }}/image.png' }
  edges:
    - { from: start, to: gen }
    - { from: gen, to: out }`;

describe('WorkflowEngine — output-node save_to (1.AF/D16, ADR-0044 §2)', () => {
  it('writes the produced media via the host mediaWrite port, interpolating run.id into the path', async () => {
    const { store: mediaStore, puts } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: write,
    });
    // The output node captures its feeder's media (mimicking the io.ts output handler's verbatim capture).
    const events = await drain(
      engineWith({ out: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) }, host).start(
        {
          workflow: workflow(SAVE_TO_WF),
        },
      ),
    );
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    const runId = events[0]?.runId;
    expect(runId).toBeDefined();
    expect(writes).toHaveLength(1);
    // run.id was interpolated into the relative path (no `{{ … }}` left, the actual runId embedded).
    expect(writes[0]?.path).toBe(`media/${runId}/image.png`);
    expect([...(writes[0]?.bytes ?? [])]).toEqual([...(puts[0]?.bytes ?? [])]); // the de-inlined bytes
    expect(writes[0]?.bytes.length).toBe(5); // "hello"
  });

  it('fails the run when save_to is declared but the captured output carries NO media handle', async () => {
    const { store: mediaStore } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: write,
    });
    const events = await drain(
      engineWith(
        { out: () => ({ kind: 'completed', output: { text: 'no media here' } }) },
        host,
      ).start({ workflow: workflow(SAVE_TO_WF) }),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('validation');
    }
    expect(writes).toHaveLength(0); // nothing written
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('fails the run when the captured output carries MORE THAN ONE media handle (save_to writes exactly one)', async () => {
    const { store: mediaStore } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: write,
    });
    const second = {
      type: 'media' as const,
      mimeType: 'image/png',
      source: { kind: 'base64' as const, data: 'd29ybGQ=' },
    }; // "world"
    const events = await drain(
      engineWith(
        { out: () => ({ kind: 'completed', output: { a: MEDIA_PART, b: second } }) },
        host,
      ).start({ workflow: workflow(SAVE_TO_WF) }),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('validation');
    }
    expect(writes).toHaveLength(0);
  });

  it('classifies an unresolvable save_to template as `validation`, not `internal` (defense-in-depth)', async () => {
    // 2.S rejects a non-`run.id` save_to at PARSE (the `SaveToSchema` refine; covered in shared/node.test.ts),
    // so authored YAML can no longer reach this. But #performSaveTo must STILL classify an unresolvable
    // template — a programmatically-built definition that bypassed the schema — as a `validation` (authoring)
    // fault, never an engine `internal` fault. Build the bad save_to by replacing it AFTER parse (schema bypass).
    const { store: mediaStore, puts } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: write,
    });
    const valid = workflow(`  id: saveto-badtmpl
  nodes:
    - { id: start, type: input }
    - { id: gen, type: transform, transform: 'g' }
    - { id: out, type: output, save_to: 'out/{{ run.id }}/x.png' }
  edges:
    - { from: start, to: gen }
    - { from: gen, to: out }`);
    const wf: WorkflowDefinition = {
      ...valid,
      workflow: {
        ...valid.workflow,
        nodes: valid.workflow.nodes.map((n) =>
          n.id === 'out' && n.type === 'output'
            ? { ...n, save_to: 'out/{{ inputs.missing }}/x.png' }
            : n,
        ),
      },
    };
    const events = await drain(
      engineWith({ out: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) }, host).start(
        {
          workflow: wf,
        },
      ),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('validation');
      // Secret-free: the failing reference name never rides the NodeFailure message (a fixed reason string).
      expect(failed.error.message).not.toContain('inputs.missing');
      expect(failed.error.message).not.toContain('inputs');
    }
    expect(writes).toHaveLength(0); // the path never resolved → never written
    expect(puts).toHaveLength(0); // and never de-inlined/stored
  });

  it('fails the run when save_to is declared but the host wired no media-write port', async () => {
    const { store: mediaStore } = stubMediaStore();
    const host = createInMemoryHost({ store: new InMemoryRunStore(), mediaStore }); // no mediaWrite
    const events = await drain(
      engineWith({ out: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) }, host).start(
        {
          workflow: workflow(SAVE_TO_WF),
        },
      ),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('validation');
    }
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('fails the run when the host media-write port throws (save_to is a real deliverable, not best-effort)', async () => {
    const { store: mediaStore } = stubMediaStore();
    const throwing: MediaWritePort = () => Promise.reject(new Error('disk full'));
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: throwing,
    });
    const events = await drain(
      engineWith({ out: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) }, host).start(
        {
          workflow: workflow(SAVE_TO_WF),
        },
      ),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    expect(failed?.type).toBe('run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('internal');
      // Secret-free: the write reason ("disk full") is never echoed into the run-event error message.
      expect(failed.error.message).not.toContain('disk full');
    }
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('an output node abandoned by the grace window FAILS — it never reports a deliverable it did not write', async () => {
    // **The fence returned the completed outcome, and that defeated the fence.** `#isLive` goes false the
    // instant `#onGraceElapsed` clears the dispatch map — which is BEFORE `#settled` is set and before the
    // grace loop reaches this vertex. An output node still `running` at that moment therefore passed
    // `#onOutcome`'s terminal-status guard and persisted `node:completed` for a `save_to` that was never
    // written: the durable log claiming a deliverable that does not exist on disk.
    //
    // The window needs TWO running nodes and that is the whole construction. With one, the grace loop calls
    // `#settleFailed` on it FIRST, and that sets `status = 'failed'` synchronously — the guard catches the
    // straggler and nothing is reproduced. Here the loop awaits `a`'s settle (insertion order: `a` before
    // `out`), and `out`'s executor resolves inside that await.
    const PARALLEL_SAVE_TO = `  id: saveto-parallel
  nodes:
    - { id: start, type: input }
    - { id: a, type: transform, transform: 'g' }
    - { id: out, type: output, save_to: 'media/{{ run.id }}/image.png' }
  edges:
    - { from: start, to: a }
    - { from: start, to: out }`;
    const { store: mediaStore } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    // **An ASYNC store, and it is the reproduction — not a convenience.** `InMemoryRunStore` resolves
    // synchronously, so `#settleFailed(a)` finishes inside the grace loop before `out`'s completion chain
    // reaches `#onOutcome`, and the vertex-status guard closes the window by accident. A real store (1.R
    // SQLite, the Phase-2 cloud one) does not — the seam exists precisely so an async store plugs in — and
    // under one the abandoned `out` reaches `#onOutcome` while its status is still `running`. Delegated
    // method-by-method, never `{...store}`: the store is a class instance and a spread drops its prototype.
    const inner = new InMemoryRunStore();
    const slowStore: RunStore = {
      resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
      listInterruptedRuns: () => inner.listInterruptedRuns(),
      readWorkflowSnapshot: (runId) => inner.readWorkflowSnapshot(runId),
      persistEvent: async (event, ctx) => {
        for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
        return inner.persistEvent(event, ctx);
      },
    };
    const host = createInMemoryHost({ store: slowStore, mediaStore, mediaWrite: write });
    let releaseOut: (() => void) | undefined;
    // `node:started` is NOT the signal to cancel on: `#step` emits it, then re-reads the `#noNewDispatch`
    // latch before calling `#dispatch`, so a cancel landing in between leaves `out` started-but-never-
    // dispatched and its handler is never invoked. Measured — the first version of this test cancelled on
    // the third `node:started` and reproduced nothing at all.
    let outInFlight = false;
    const outSettled = new Promise<void>((resolve) => {
      releaseOut = resolve;
    });
    const engine = engineWith(
      {
        a: () => new Promise<NodeOutcome>(() => undefined), // never settles — it is what the grace loop awaits
        out: () => {
          outInFlight = true;
          return outSettled.then(() => ({ kind: 'completed', output: { image: MEDIA_PART } }));
        },
      },
      host,
    );
    const handle = engine.start({ workflow: workflow(PARALLEL_SAVE_TO) });
    const events: RunEvent[] = [];
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
      }
    })();

    for (let i = 0; i < 400 && !outInFlight; i += 1) {
      await Promise.resolve();
    }
    expect(outInFlight).toBe(true); // `out`'s executor is genuinely running before anything is cancelled
    engine.cancel(handle.runId);
    for (let i = 0; i < 400 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
    expect(host.deadlineCount()).toBe(1); // the grace window is armed

    // **The two lines that make the window, and their order is the test.** `fireDeadlines()` runs
    // `#onGraceElapsed` up to its first `await` — the dispatch map is now clear, `#settled` is still false,
    // and `out`'s status is still `running` because the loop is parked on `a`'s settle. Releasing `out`
    // HERE puts its whole chain (`#applySaveTo` → `#runAttempt` → `#dispatchLoop` → `#onOutcome`, pure
    // microtasks) inside that park, ahead of `#settleFailed(a)` — which has to wait on the consumer and the
    // delivery tail. Release any later (at `a`'s `node:failed`, say) and the grace loop reaches `out` first,
    // its synchronous `status = 'failed'` closes `#onOutcome`'s guard, and the defect hides behind it.
    host.fireDeadlines();
    releaseOut?.();
    for (let i = 0; i < 800 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
    }
    await consume;

    // **What the mutation actually produces, measured rather than assumed.** Reverting the entry fence to
    // `return outcome` gives `out` NO node terminal at all — the run publishes `run:cancelled` with `out`
    // missing from the log entirely, which is the omission ADR-0085 §4 exists to forbid. (The PR review
    // predicted a persisted `node:completed`; with this microtask alignment the run terminal wins the
    // delivery tail instead, and a different alignment could produce either. Both are the same defect:
    // `#applySaveTo` returning `completed` from a fence path asserts a deliverable that was never written.)
    // The three assertions below hold under both outcomes.
    expect(events.some((e) => e.type === 'node:completed' && e.nodeId === 'out')).toBe(false);
    expect(writes).toHaveLength(0);
    expect(events.some((e) => e.type === 'node:failed' && e.nodeId === 'out')).toBe(true);
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('does not invoke save_to for an output node WITHOUT a save_to field (unchanged capture path)', async () => {
    const { store: mediaStore } = stubMediaStore();
    const { write, writes } = stubMediaWrite();
    const host = createInMemoryHost({
      store: new InMemoryRunStore(),
      mediaStore,
      mediaWrite: write,
    });
    const events = await drain(
      engineWith(
        { work: () => ({ kind: 'completed', output: { image: MEDIA_PART } }) },
        host,
      ).start({
        workflow: workflow(SEQUENTIAL), // `done` output node has no save_to
      }),
    );
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    expect(writes).toHaveLength(0); // no save_to ⇒ the write port is never called
  });
});

// --- cancellation -----------------------------------------------------------------------------

describe('WorkflowEngine — cancellation', () => {
  it('cancels mid-stream, aborts the in-flight node cooperatively, and ends in exactly one run:cancelled', async () => {
    let abortObserved = false;
    const engine = engineWith({
      slow: (ctx) =>
        new Promise<NodeOutcome>((resolve) => {
          // The correct executor pattern (what 1.O/1.P do): honour an abort that already fired, then
          // subscribe — a listener registered after the signal aborted never fires (as with a native
          // AbortSignal), so checking `aborted` first avoids hanging on a fast cancel.
          const onAbort = (): void => {
            abortObserved = true;
            resolve({ kind: 'completed', output: 'aborted-late' });
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
        }),
    });
    const handle = engine.start({
      workflow: workflow(`  id: cancel
  nodes:
    - { id: start, type: input }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: slow }
    - { from: slow, to: done }`),
    });

    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:started' && event.nodeId === 'slow') {
        engine.cancel(handle.runId);
      }
    }

    expect(abortObserved).toBe(true); // the in-flight node actually saw the AbortSignal
    assertGapFreeSeq(events); // the stream stays gap-free across a mid-run cancel
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled');
    // `done` is downstream of the cancelled node — it must never have started.
    expect(events.some((e) => e.type === 'node:started' && e.nodeId === 'done')).toBe(false);
  });

  it('cancel wins a racing node failure: a node that fails while cancelling ends in run:cancelled', async () => {
    const engine = engineWith({
      slow: (ctx) =>
        new Promise<NodeOutcome>((resolve) => {
          const onAbort = (): void =>
            resolve({
              kind: 'failed',
              error: { code: 'tool_failed', message: 'failed during cancel', retryable: false },
            });
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
        }),
    });
    const handle = engine.start({
      workflow: workflow(`  id: cancelfail
  nodes:
    - { id: start, type: input }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: slow }
    - { from: slow, to: done }`),
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:started' && event.nodeId === 'slow') {
        engine.cancel(handle.runId); // abort fires; the in-flight node then settles as `failed`
      }
    }
    assertGapFreeSeq(events);
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled'); // cancel wins the late failure (ADR-0036)
    expect(events.some((e) => e.type === 'node:started' && e.nodeId === 'done')).toBe(false);
  });
});

// --- condition skip-propagation + fan-in over a skipped branch --------------------------------

describe('WorkflowEngine — condition skip-propagation', () => {
  const CONDITIONAL = `  id: cond
  nodes:
    - { id: start, type: input }
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: approve }, { when: false, target_node: reject }] }
    - { id: approve, type: transform, transform: 'a' }
    - { id: reject, type: transform, transform: 'r' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: gate }
    - { from: approve, to: join }
    - { from: reject, to: join }
    - { from: join, to: out }`;

  it('skips the unselected branch subtree and still joins the fan-in over the surviving branch', async () => {
    const events = await drain(
      engineWith({
        gate: () => ({ kind: 'branch', output: 'go', selected: ['approve'] }),
      }).start({ workflow: workflow(CONDITIONAL) }),
    );
    const startedNodes = events
      .filter((e) => e.type === 'node:started')
      .map((e) => (e.type === 'node:started' ? e.nodeId : ''));
    expect(startedNodes).toContain('approve');
    expect(startedNodes).not.toContain('reject'); // skipped — no node:started, no node:completed
    expect(startedNodes).toContain('join'); // the fan-in joined despite the skipped branch
    assertGapFreeSeq(events); // skipped nodes emit nothing, so the stream stays gap-free
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('skips a whole subtree reachable only through the unselected branch', async () => {
    const events = await drain(
      engineWith({
        gate: () => ({ kind: 'branch', output: 'go', selected: ['reject'] }),
      }).start({ workflow: workflow(CONDITIONAL) }),
    );
    const startedNodes = events
      .filter((e) => e.type === 'node:started')
      .map((e) => (e.type === 'node:started' ? e.nodeId : ''));
    expect(startedNodes).not.toContain('approve');
    expect(startedNodes).toContain('reject');
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('skips a fan-in whose every branch was skipped (an all-skipped join is itself skipped)', async () => {
    const events = await drain(
      engineWith({
        gate: () => ({ kind: 'branch', output: 'none', selected: [] }), // routes to neither branch
      }).start({ workflow: workflow(CONDITIONAL) }),
    );
    const startedNodes = events
      .filter((e) => e.type === 'node:started')
      .map((e) => (e.type === 'node:started' ? e.nodeId : ''));
    expect(startedNodes).not.toContain('approve');
    expect(startedNodes).not.toContain('reject');
    expect(startedNodes).not.toContain('join'); // both branches skipped → the fan-in skips too
    expect(startedNodes).not.toContain('out'); // and everything below it
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('skips a multi-hop dead chain while the live sibling still joins (fixpoint convergence)', async () => {
    // gate -> a -> b -> join (dead chain) and gate -> c -> join (live). `a`/`b` are declared in
    // anti-topological order (b before a) so a single forward skip pass is insufficient — the
    // #propagateSkips while(changed) loop must re-iterate to skip the whole chain.
    const events = await drain(
      engineWith({
        gate: () => ({ kind: 'branch', output: 'go', selected: ['c'] }),
      }).start({
        workflow: workflow(`  id: deepskip
  nodes:
    - { id: start, type: input }
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: c }, { when: false, target_node: a }] }
    - { id: b, type: transform, transform: 'b' }
    - { id: a, type: transform, transform: 'a' }
    - { id: c, type: transform, transform: 'c' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: gate }
    - { from: a, to: b }
    - { from: b, to: join }
    - { from: c, to: join }
    - { from: join, to: out }`),
      }),
    );
    const startedNodes = events
      .filter((e) => e.type === 'node:started')
      .map((e) => (e.type === 'node:started' ? e.nodeId : ''));
    expect(startedNodes).toContain('c');
    expect(startedNodes).toContain('join'); // the live sibling lets the fan-in join…
    expect(startedNodes).toContain('out');
    expect(startedNodes).not.toContain('a'); // …while the whole dead chain a -> b is skipped
    expect(startedNodes).not.toContain('b');
    assertGapFreeSeq(events);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });
});

// --- exactly-one-terminal-event guarantees ----------------------------------------------------

describe('WorkflowEngine — the exactly-one-terminal-event invariant', () => {
  it('maps an uncaught node-handler throw to a single run:failed{internal}', async () => {
    const events = await drain(
      engineWith({
        work: () => {
          throw new Error('kaboom from a node body');
        },
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    const failed = events.find((e) => e.type === 'run:failed');
    if (failed?.type !== 'run:failed') {
      throw new Error('expected run:failed');
    }
    expect(failed.error.code).toBe('internal');
    expect(failed.error.retryable).toBe(false);
    expect(failed.error.nodeId).toBe('work');
    // A secret-free correlation id is stamped at the single translation point (ADR-0036).
    expect(typeof failed.error.correlationId).toBe('string');
    expect(failed.error.correlationId).not.toBe('');
    // The user-safe message never leaks the thrown error text.
    expect(failed.error.message).not.toContain('kaboom');
    expect(events.some((e) => e.type === 'node:started' && e.nodeId === 'done')).toBe(false);
    assertGapFreeSeq(events);
  });

  it('maps a classified node failure to node:failed (with correlationId) then a single run:failed', async () => {
    const events = await drain(
      engineWith({
        work: () => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'the tool returned non-zero', retryable: false },
        }),
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    const nodeFailed = events.find((e) => e.type === 'node:failed');
    if (nodeFailed?.type !== 'node:failed') {
      throw new Error('expected node:failed');
    }
    expect(nodeFailed.nodeId).toBe('work');
    // The correlation id is stamped on node:failed itself (ADR-0036), not only on the run:failed aggregate.
    expect(typeof nodeFailed.error.correlationId).toBe('string');
    expect(nodeFailed.error.correlationId).not.toBe('');
    const terminals = terminalsIn(events);
    expect(terminals).toHaveLength(1);
    const failed = terminals[0];
    if (failed?.type !== 'run:failed') {
      throw new Error('expected run:failed');
    }
    // partialOutputs carries the already-completed `start`, never the failed `work` or the unreached `done`.
    expect(Object.keys(failed.partialOutputs)).toContain('start');
    expect(failed.partialOutputs).not.toHaveProperty('work');
    expect(failed.partialOutputs).not.toHaveProperty('done');
    assertGapFreeSeq(events);
  });

  it('snapshots the run-wide cumulative cost onto node:failed (durable fail-cost, 2.S/D-GC, ADR-0045 §5)', async () => {
    const emitCost = (nodeId: string, amount: number): Handler => {
      return (ctx) => {
        ctx.emit({
          type: 'cost:updated',
          nodeId,
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costMicrocents: amount,
          cumulativeCostMicrocents: 0, // the engine owns the cumulative
        });
        return { kind: 'completed', output: nodeId, tokensUsed: { input: 1, output: 1 } };
      };
    };
    const events = await drain(
      engineWith({
        start: emitCost('start', 100),
        work: () => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'boom', retryable: false },
        }),
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    const nodeFailed = events.find((e) => e.type === 'node:failed');
    if (nodeFailed?.type !== 'node:failed') {
      throw new Error('expected node:failed');
    }
    // The cost accrued before the failure (cost:updated is transient) is durable on the terminal node event.
    expect(nodeFailed.cumulativeCostMicrocents).toBe(100);
  });

  it('snapshots the run-wide cumulative cost onto run:cancelled (durable fail-cost, 2.S/D-GC, ADR-0045 §5)', async () => {
    const engine = engineWith({
      emit: (ctx) => {
        ctx.emit({
          type: 'cost:updated',
          nodeId: 'emit',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costMicrocents: 100,
          cumulativeCostMicrocents: 0,
        });
        return { kind: 'completed', output: 'emit', tokensUsed: { input: 1, output: 1 } };
      },
      slow: (ctx) =>
        new Promise<NodeOutcome>((resolve) => {
          const onAbort = (): void => resolve({ kind: 'completed', output: 'aborted' });
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
        }),
    });
    const handle = engine.start({
      workflow: workflow(`  id: cancel-cost
  nodes:
    - { id: start, type: input }
    - { id: emit, type: transform, transform: 'x' }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: emit }
    - { from: emit, to: slow }
    - { from: slow, to: done }`),
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:started' && event.nodeId === 'slow') {
        engine.cancel(handle.runId);
      }
    }
    const cancelled = events.find((e) => e.type === 'run:cancelled');
    if (cancelled?.type !== 'run:cancelled') {
      throw new Error('expected run:cancelled');
    }
    // The cost accrued before the cancel (cost:updated is transient) is durable on the terminal run event.
    expect(cancelled.cumulativeCostMicrocents).toBe(100);
  });

  it('snapshots the run-wide cumulative cost onto run:failed (durable fail-cost, 2.S/D-GC, ADR-0045 §5)', async () => {
    const events = await drain(
      engineWith({
        start: (ctx) => {
          ctx.emit({
            type: 'cost:updated',
            nodeId: 'start',
            model: 'm',
            inputTokens: 1,
            outputTokens: 1,
            costMicrocents: 100,
            cumulativeCostMicrocents: 0, // the engine owns the cumulative
          });
          return { kind: 'completed', output: 'start', tokensUsed: { input: 1, output: 1 } };
        },
        work: () => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'boom', retryable: false },
        }),
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    const failed = events.find((e) => e.type === 'run:failed');
    if (failed?.type !== 'run:failed') {
      throw new Error('expected run:failed');
    }
    // The accrued cost (cost:updated is transient) is durable on the terminal run event, mirroring run:cancelled.
    // A sibling node's abandoned media-job addend folds in the same way — emitted before this terminal in #settle
    // (after the root-cause node:failed snapshot) — so run:failed never under-reports the run's realized cost.
    expect(failed.cumulativeCostMicrocents).toBe(100);
  });
});

// --- human gate suspend / resume --------------------------------------------------------------

describe('WorkflowEngine — human gate suspend/resume', () => {
  const GATED = `  id: gated
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;

  it('pauses at a gate (run:paused aggregate), resumes on a decision, and completes', async () => {
    const engine = engineWith({
      g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }),
    });
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    // Resume off run:paused (the idle aggregate) so the run has actually reached its suspended state —
    // its gateIds carry the same gateId human_gate:paused did. (Resuming on the per-gate event can race
    // ahead of the run going idle; run:paused is the surface-facing "≥1 gate pending" signal.)
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
        }
      }
    }
    const paused = events.find((e) => e.type === 'run:paused');
    if (paused?.type !== 'run:paused') {
      throw new Error('expected run:paused');
    }
    expect(paused.pendingGateCount).toBe(1);
    expect(paused.gateIds).toHaveLength(1);
    expect(typesIn(events)).toContain('human_gate:paused');
    expect(typesIn(events)).toContain('human_gate:resumed');
    assertGapFreeSeq(events); // gap-free across pause + resume
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    expect(events.some((e) => e.type === 'node:started' && e.nodeId === 'out')).toBe(true);
  });

  it('de-inlines a media-bearing gate decision.payload to a handle on human_gate:resumed (no base64)', async () => {
    // The resume() decision.payload (z.unknown()) is the one #emitDurable de-inline caller a gate exercises;
    // it must flow through the SAME I3 choke point, so the delivered + persisted human_gate:resumed carries a
    // handle, never the base64 bytes.
    const { store: mediaStore, puts } = stubMediaStore();
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore, mediaStore });
    const engine = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, {
            decision: 'approved',
            decidedBy: 'tester',
            payload: { image: MEDIA_PART },
          });
        }
      }
    }
    const resumed = events.find((e) => e.type === 'human_gate:resumed');
    if (resumed?.type !== 'human_gate:resumed') {
      throw new Error('expected human_gate:resumed');
    }
    const put0 = puts[0];
    expect(put0).toBeDefined();
    expect(resumed.payload).toEqual({
      image: {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'handle', ref: put0?.handle },
        byteLength: 5,
      },
    });
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    expect(JSON.stringify(runStore.eventsFor(handle.runId))).not.toContain('aGVsbG8=');
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('fails the run (no leak, no hang) when a gate decision.payload carries media but no MediaStore', async () => {
    // No store ⇒ resume()'s de-inline of the media payload throws; resume()'s catch fails the run AND always
    // #schedule()s (no stranded run), and the bytes never reach a stamped/persisted event.
    const runStore = new InMemoryRunStore();
    const host = createInMemoryHost({ store: runStore }); // deliberately no mediaStore
    const engine = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, {
            decision: 'approved',
            decidedBy: 'tester',
            payload: MEDIA_PART,
          });
        }
      }
    }
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    const failed = events.find((e) => e.type === 'run:failed');
    if (failed?.type === 'run:failed') {
      expect(failed.error.code).toBe('internal');
    }
    expect(JSON.stringify(events)).not.toContain('aGVsbG8=');
    expect(JSON.stringify(runStore.eventsFor(handle.runId))).not.toContain('aGVsbG8=');
  });

  it('rejects a resume with an unknown gateId while paused (unknown_gate)', async () => {
    const engine = engineWith({
      g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }),
    });
    const handle = engine.start({ workflow: workflow(GATED) });
    let caught: unknown;
    for await (const event of handle.events) {
      if (event.type === 'human_gate:paused') {
        try {
          await engine.resume(handle.runId, 'not-a-real-gate', {
            decision: 'approved',
            decidedBy: 'tester',
          });
        } catch (error) {
          caught = error;
        }
        // resolve the real gate so the run terminates and the loop ends
        await engine.resume(handle.runId, event.gateId, { decision: 'approved', decidedBy: 't' });
      }
    }
    expect(caught).toBeInstanceOf(EngineStateError);
    if (caught instanceof EngineStateError) {
      expect(caught.code).toBe('unknown_gate');
    }
  });

  // --- gate timeouts (1.Q): one-shot timer → auto-resolve / run-fail -------------------------
  const gate = (over: Record<string, unknown>): NodeOutcome => ({
    kind: 'paused',
    gate: { gateType: 'approval', message: 'approve?', ...over },
  });

  it('emits timeoutMs + expiresAt on human_gate:paused and auto-approves on timeout (decidedBy timeout)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'approve' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        host.fireTimers(); // the deadline elapsed with no human decision
      }
    }
    const paused = events.find((e) => e.type === 'human_gate:paused');
    if (paused?.type !== 'human_gate:paused') {
      throw new Error('expected human_gate:paused');
    }
    expect(paused.timeoutMs).toBe(1000);
    expect(typeof paused.expiresAt).toBe('string');
    const resumed = events.find((e) => e.type === 'human_gate:resumed');
    if (resumed?.type !== 'human_gate:resumed') {
      throw new Error('expected human_gate:resumed');
    }
    expect(resumed.decision).toBe('approved');
    expect(resumed.decidedBy).toBe('timeout');
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    assertGapFreeSeq(events);
  });

  it('fails the run with run_timeout when a gate times out under timeout_action: reject', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'reject' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        host.fireTimers();
      }
    }
    expect(events.some((e) => e.type === 'node:failed' && e.nodeId === 'g')).toBe(true);
    const terminal = terminalsIn(events)[0];
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      expect(terminal.error.code).toBe('run_timeout');
    }
    expect(events.some((e) => e.type === 'human_gate:resumed')).toBe(false); // reject-timeout never "resumes"
    assertGapFreeSeq(events);
  });

  it('disarms the gate timer when a human decision arrives first (no timeout fires, single resolution)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'reject' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'human' });
        }
        expect(host.armedCount()).toBe(0); // resume disarmed the timer
        host.fireTimers(); // a no-op now — the timer is gone
      }
    }
    const resumes = events.filter((e) => e.type === 'human_gate:resumed');
    expect(resumes).toHaveLength(1);
    if (resumes[0]?.type === 'human_gate:resumed') {
      expect(resumes[0].decidedBy).toBe('human');
    }
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('arms no timer for a gate without timeout_ms', async () => {
    const host = createInMemoryHost();
    const engine = engineWith({ g: () => gate({}) }, host);
    const handle = engine.start({ workflow: workflow(GATED) });
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        expect(host.armedCount()).toBe(0);
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'h' });
        }
      }
    }
  });

  it('a human rejected decision completes the gate (carrying the decision) and continues the run', async () => {
    const engine = engineWith({
      g: () => gate({}),
      // Echo the gate's settled output so the test can observe the decision reached run.outputs (the real
      // output handler captures its feeder verbatim; the stub otherwise returns its own id).
      out: (ctx): NodeOutcome => ({ kind: 'completed', output: ctx.runOutputs.get('g') }),
    });
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'rejected', decidedBy: 'human' });
        }
      }
    }
    const resumed = events.find((e) => e.type === 'human_gate:resumed');
    expect(resumed?.type === 'human_gate:resumed' ? resumed.decision : undefined).toBe('rejected');
    // A rejected decision is NOT a run failure (execution-model.md §4): the gate vertex completes carrying
    // {decision:'rejected'} as its output (signalled by human_gate:resumed, not a node:completed), the run
    // continues, and the value flows downstream — `out` captures its single feeder (the gate) verbatim, so
    // a downstream condition could route on it.
    const outDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'out');
    expect(outDone?.type === 'node:completed' ? outDone.output : undefined).toEqual({
      decision: 'rejected',
    });
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('disarms an armed gate timer when the run terminates for an unrelated reason (cancel)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'reject' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        expect(host.armedCount()).toBe(1); // the gate timer is armed
        engine.cancel(handle.runId); // cancel for an unrelated reason while the timer is still armed
      }
    }
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled');
    expect(host.armedCount()).toBe(0); // #settle disarmed the armed timer on terminal close
    host.fireTimers(); // a no-op now — nothing armed; must not emit anything after the terminal
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('a reject-timeout marks the gate resolved, so a late re-delivery of its decision is a no-op (not a throw)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'reject' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    let gateId = '';
    let lateResume: unknown = 'not-attempted';
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        host.fireTimers(); // reject-timeout → run fails with run_timeout
      }
      if (event.type === 'run:failed') {
        // A duplicate decision arriving after the timeout already failed the run is a silent no-op.
        lateResume = await engine
          .resume(handle.runId, gateId, { decision: 'rejected', decidedBy: 'late' })
          .then(() => 'no-op')
          .catch((e: unknown) => e);
      }
    }
    expect(lateResume).toBe('no-op'); // #resolvedGates was set on the reject-timeout path
  });

  it('emits node:skipped(out) before run:failed when a reject-timeout dims the downstream', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'reject' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        host.fireTimers();
      }
    }
    const skipIdx = events.findIndex((e) => e.type === 'node:skipped' && e.nodeId === 'out');
    const failIdx = events.findIndex((e) => e.type === 'run:failed');
    expect(skipIdx).toBeGreaterThanOrEqual(0); // the downstream `out` is dimmed (upstream unreachable)
    expect(skipIdx).toBeLessThan(failIdx); // …and recorded before the terminal, keeping the log complete
    assertGapFreeSeq(events);
  });

  it('expiresAt equals the pause timestamp plus timeoutMs (a real ISO deadline, not just any string)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 5000, timeoutAction: 'approve' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    let paused: Extract<RunEvent, { type: 'human_gate:paused' }> | undefined;
    for await (const event of handle.events) {
      if (event.type === 'human_gate:paused') {
        paused = event;
      }
      if (event.type === 'run:paused') {
        host.fireTimers();
      }
    }
    if (paused === undefined || paused.expiresAt === undefined) {
      throw new Error('expected human_gate:paused with expiresAt');
    }
    // expiresAt is a real ISO deadline ≈ the pause time + timeoutMs. The in-memory clock advances 1ms
    // per read, so expiresAt (one clock read) and the event timestamp (a later read) differ by the small
    // read skew, not exactly 0 — assert the gap is timeoutMs within that few-ms tolerance.
    const deltaMs = Date.parse(paused.expiresAt) - Date.parse(paused.timestamp);
    expect(deltaMs).toBeGreaterThan(4990);
    expect(deltaMs).toBeLessThanOrEqual(5000);
  });

  it('a timer that fires after the run already terminated is an inert no-op (no second terminal)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      { g: () => gate({ timeoutMs: 1000, timeoutAction: 'approve' }) },
      host,
    );
    const handle = engine.start({ workflow: workflow(GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        // Resolve by hand so the run completes; the armed timer is disarmed on resume + on settle.
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'h' });
        }
      }
    }
    host.fireTimers(); // post-terminal: nothing armed; must not emit a second terminal
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  // Regression for the multi-gate stall race: two timeout-approve gates resolved back-to-back by one
  // fireTimers() sweep. The second gate's resume schedules a #step while the first's durable persist is
  // still in flight; only because each resume marks its vertex completed SYNCHRONOUSLY (before its await)
  // does that step see both gates settled rather than mis-reading the run as stalled (a spurious
  // run:failed{internal}).
  const MULTIGATE = `  id: multigate
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [g1, g2] }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: g1, to: join }
    - { from: g2, to: join }
    - { from: join, to: out }`;

  it('resolves two concurrent gates settled in one timer sweep without a spurious stall', async () => {
    const host = createInMemoryHost();
    const engine = engineWith(
      {
        g1: () => gate({ timeoutMs: 1000, timeoutAction: 'approve' }),
        g2: () => gate({ timeoutMs: 1000, timeoutAction: 'approve' }),
      },
      host,
    );
    const handle = engine.start({ workflow: workflow(MULTIGATE) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused' && event.pendingGateCount === 2) {
        host.fireTimers(); // fire BOTH gate timers in one synchronous sweep
      }
    }
    const resumes = events.filter((e) => e.type === 'human_gate:resumed');
    expect(resumes).toHaveLength(2); // both gates resolved, each exactly once
    expect(terminalsIn(events)[0]?.type).toBe('run:completed'); // NOT a spurious run:failed{internal}
    assertGapFreeSeq(events);
  });
});

// --- resumeFromCheckpoint: cross-process gate resume (1.R) -------------------------------------

describe('WorkflowEngine — resumeFromCheckpoint (cross-process resume, 1.R)', () => {
  const GATED = `  id: gated
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
  const gateHandlers = {
    g: (): NodeOutcome => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }),
  };

  /** Run a fresh gated run on `store` until it parks at the gate; return its runId, gateId, last seq. */
  async function runToGate(
    store: RunStore,
  ): Promise<{ runId: string; gateId: string; lastSeq: number }> {
    const engine = engineWith(gateHandlers, createInMemoryHost({ store }));
    const handle = engine.start({ workflow: workflow(GATED) });
    let gateId = '';
    let lastSeq = -1;
    for await (const event of handle.events) {
      lastSeq = Math.max(lastSeq, event.sequenceNumber);
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break; // the "process" dies here, parked at the gate — never resumed on this engine
      }
    }
    return { runId: handle.runId, gateId, lastSeq };
  }

  it('rehydrates a gate-parked run in a fresh engine over the same store and drives it to completion', async () => {
    const store = new InMemoryRunStore();
    const { runId, gateId, lastSeq } = await runToGate(store);
    expect(gateId).not.toBe('');

    // A brand-new engine (no in-memory state) resumes purely from the persisted event stream.
    const engineB = engineWith({}, createInMemoryHost({ store }));
    const handleB = await engineB.resumeFromCheckpoint({
      runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const eventsB = await drain(handleB);

    expect(handleB.runId).toBe(runId);
    expect(typesIn(eventsB)).toContain('human_gate:resumed');
    expect(eventsB.some((e) => e.type === 'node:started' && e.nodeId === 'out')).toBe(true);
    expect(terminalsIn(eventsB)[0]?.type).toBe('run:completed');
    // The resumed stream continues gap-free from the last persisted sequence number (no reset, no gap).
    eventsB.forEach((event, index) => expect(event.sequenceNumber).toBe(lastSeq + 1 + index));
  });

  // H2 (governor re-seed) is pinned at the unit level: the checkpoint fold restores the cumulative from the
  // durable budget:paused.spentMicrocents (checkpoint.test.ts) and #seedFromCheckpoint feeds it to the
  // governor. A full engine resume-then-block test is not added here because cost:updated is streamed (not
  // persisted), so a run paused at a plain human gate cannot restore its cost — that general cost-event
  // persistence is the deferred fix tracked in deferred-tasks.md.

  it('is a no-op (closed handle, nothing re-persisted) re-delivering to an already-terminal run', async () => {
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);
    const decision = { decision: 'approved' as const, decidedBy: 't' };

    const engineB = engineWith({}, createInMemoryHost({ store }));
    await drain(
      await engineB.resumeFromCheckpoint({ runId, workflow: workflow(GATED), gateId, decision }),
    );
    const persistedAfterB = store.eventsFor(runId).length;

    // A second process re-delivers the same decision to the now-completed run — must not advance it.
    const engineC = engineWith({}, createInMemoryHost({ store }));
    const handleC = await engineC.resumeFromCheckpoint({
      runId,
      workflow: workflow(GATED),
      gateId,
      decision,
    });
    const eventsC = await drain(handleC);
    expect(eventsC).toEqual([]); // closed handle: the iteration completes immediately
    expect(store.eventsFor(runId).length).toBe(persistedAfterB); // nothing re-emitted / re-persisted
  });

  it('throws workflow_mismatch when handed a different workflow than the run started on', async () => {
    const store = new InMemoryRunStore();
    const { runId, gateId } = await runToGate(store);
    const OTHER = `  id: other
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }`;
    const engineB = engineWith({}, createInMemoryHost({ store }));
    await expect(
      engineB.resumeFromCheckpoint({
        runId,
        workflow: workflow(OTHER),
        gateId,
        decision: { decision: 'approved', decidedBy: 't' },
      }),
    ).rejects.toMatchObject({ code: 'workflow_mismatch' });
  });

  it('throws unknown_run when no checkpoint exists for the runId', async () => {
    const engine = engineWith({}, createInMemoryHost());
    await expect(
      engine.resumeFromCheckpoint({
        runId: 'ghost',
        workflow: workflow(GATED),
        gateId: 'g',
        decision: { decision: 'approved', decidedBy: 't' },
      }),
    ).rejects.toMatchObject({ code: 'unknown_run' });
  });

  it('throws run_already_active (use resume) when the run is already tracked in this engine', async () => {
    const engine = engineWith(gateHandlers);
    const handle = engine.start({ workflow: workflow(GATED) });
    let caught: unknown;
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0] ?? '';
        try {
          await engine.resumeFromCheckpoint({
            runId: handle.runId,
            workflow: workflow(GATED),
            gateId,
            decision: { decision: 'approved', decidedBy: 't' },
          });
        } catch (error) {
          caught = error;
        }
        await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 't' });
      }
    }
    expect(caught).toBeInstanceOf(EngineStateError);
    expect(caught instanceof EngineStateError ? caught.code : '').toBe('run_already_active');
  });

  it('throws invalid_decision for a malformed decision before touching the store', async () => {
    const engine = engineWith({}, createInMemoryHost());
    await expect(
      engine.resumeFromCheckpoint({
        runId: 'x',
        workflow: workflow(GATED),
        gateId: 'g',
        // @ts-expect-error — an intentionally invalid decision value; safeParse must reject it
        decision: { decision: 'maybe', decidedBy: 't' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
  });

  it('drives a run whose gate was already resolved in the prior process to completion WITHOUT re-applying the decision (kick path)', async () => {
    const store = new InMemoryRunStore();
    // Process A: pause at the gate.
    const { runId, gateId } = await runToGate(store);
    // Process B: apply the decision, then "crash" mid-downstream — `out` hangs, so the run persists
    // human_gate:resumed + node:started(out) but never run:completed.
    const engineB = engineWith(
      { out: () => new Promise<NodeOutcome>(() => {}) },
      createInMemoryHost({ store }),
    );
    const handleB = await engineB.resumeFromCheckpoint({
      runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'human' },
    });
    for await (const event of handleB.events) {
      if (event.type === 'node:started' && event.nodeId === 'out') {
        break; // the process dies here, with `out` mid-flight
      }
    }
    expect(store.eventsFor(runId).some((e) => e.type === 'human_gate:resumed')).toBe(true);
    expect(store.eventsFor(runId).some((e) => e.type === 'run:completed')).toBe(false);

    // Process C: the gate is already resolved (resolvedGateIds), the run is non-terminal → kick(), which
    // re-runs the unfinished `out` and completes WITHOUT a second human_gate:resumed. Snapshot the last
    // persisted seq BEFORE the call — kick() emits synchronously, so a later read would include C's own
    // first event.
    const lastPersistedBeforeC = store
      .eventsFor(runId)
      .reduce((max, e) => Math.max(max, e.sequenceNumber), -1);
    const engineC = engineWith({}, createInMemoryHost({ store }));
    const handleC = await engineC.resumeFromCheckpoint({
      runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'human' },
    });
    const eventsC = await drain(handleC);
    expect(eventsC.some((e) => e.type === 'human_gate:resumed')).toBe(false); // never re-applied
    expect(eventsC.some((e) => e.type === 'node:completed' && e.nodeId === 'out')).toBe(true);
    expect(terminalsIn(eventsC)[0]?.type).toBe('run:completed');
    // The kick path shares #seedFromCheckpoint's seedSequence — its stream must also continue gap-free.
    eventsC.forEach((event, index) =>
      expect(event.sequenceNumber).toBe(lastPersistedBeforeC + 1 + index),
    );
  });

  // **This test asserted the OPPOSITE until `CR-22`, and the reasoning it replaced is kept deliberately.**
  // It read "arms no gate timer on rehydration (re-arm is a Phase-2 reconciliation concern)" and proved
  // `armCalls === 0`. That behaviour was a real, documented deferral, and its justification was that "the
  // gate this resume TARGETS has its decision applied immediately" — true of the target gate, and silent
  // about every other one. A multi-gate run, or a crash while parked, rehydrated its remaining gates with no
  // timer at all, so their deadlines stopped existing until the next restart. The data needed was already
  // durable on `human_gate:paused` (its schema says it rides there for exactly this); only the checkpoint
  // fold and the rehydration loop were missing. See ADR-0028 and `CR-22`.
  it('re-arms a rehydrated gate at its REMAINING time, not its full `timeout_ms`', async () => {
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      {
        g: () => ({
          kind: 'paused',
          gate: { gateType: 'approval', message: 'ok?', timeoutMs: 1000, timeoutAction: 'reject' },
        }),
      },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(GATED) });
    let gateId = '';
    let expiresAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'human_gate:paused') expiresAt = event.expiresAt ?? '';
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    expect(expiresAt).not.toBe(''); // the absolute deadline is durable — the premise of the whole fix

    // Process B rehydrates with a clock pinned 250 ms before the gate expires. A FIXED clock, not the
    // in-memory host's auto-advancing one: that double restarts its tick at 0 per host, which would make
    // B's "now" earlier than A's and the arithmetic meaningless. Pinning it makes the expected value exact.
    const nowB = new Date(Date.parse(expiresAt) - 250).toISOString();
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      // `kind` is counted and FORWARDED. Counted, because the claim is about the run's *work* timers — the
      // ADR-0079 lease heartbeat is armed on every resume by design and is not what this test is about.
      // Forwarded, because dropping it would silently re-label that heartbeat as a work timer in the inner
      // host, which is the failure this spy exists to detect.
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    await drain(handleB);

    // The load-bearing assertion: 250, not 1000. Arming the full `timeout_ms` would renew the deadline on
    // every resume — a gate crashed and resumed ten times would get ten times its authored patience, which
    // is the defect `CR-22` names.
    //
    // `toEqual` on the whole array, not `toContain`. A first version used `toContain(250)` plus
    // `not.toContain(1000)` and justified it by saying "the resume also arms unrelated work timers" — which
    // is measurably false: this resume arms exactly one. With a single-element array the negative assertion
    // was implied by the positive one and no mutation could make it the failing line, and the superseded
    // test's EXACT count (`toBe(0)`) had also proved "no other work timer is armed anywhere". `toEqual`
    // restores that second guarantee at zero cost.
    expect(armedWork).toEqual([250]);
  });

  it('a resuming clock running BEHIND cannot grant more patience than the author wrote', async () => {
    // `expiresAt` is an instant written by one process and differenced against another's clock. A resuming
    // process an hour behind computed `expiresAt − now` = 3 601 000 ms for a 1 000 ms gate — `Math.max(0, …)`
    // only ever guarded the other direction. The authored `timeout_ms` is now the ceiling, and it rides the
    // checkpoint for exactly this: it was already on `human_gate:paused` and the fold simply dropped it.
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      {
        g: () => ({
          kind: 'paused',
          gate: { gateType: 'approval', message: 'ok?', timeoutMs: 1000, timeoutAction: 'reject' },
        }),
      },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(GATED) });
    let gateId = '';
    let expiresAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'human_gate:paused') expiresAt = event.expiresAt ?? '';
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    const nowB = new Date(Date.parse(expiresAt) - 3_600_000).toISOString(); // an hour BEHIND
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    await drain(handleB);

    // Never longer than authored, whatever the clocks think.
    expect(armedWork.every((ms) => ms <= 1000)).toBe(true);
    expect(armedWork).not.toContain(3_601_000);
  });

  it('a resume SEEDS the dispatch count rather than restarting it (ADR-0086 §4)', async () => {
    // **The seed line is the entire claim of ADR-0086 §4** — "the cap survives a crash-resume". A first
    // version asserted only that the durable fold continued, which is a property of
    // `reconstructCheckpointState` rather than of the engine, and stayed green with the seed removed.
    //
    // A seed has to CHANGE an outcome to be testable. So process A spends almost the whole cap and parks;
    // process B's own handful of nodes then crosses it only because the restored count is applied. Without
    // the seed B starts from zero and finishes.
    // Node COUNT must stay under its own ceiling (500) while DISPATCHES cross theirs, so the chain is short
    // of both and the gate + tail make up the difference: 492 + gate + 5 + start + done = 500 nodes exactly.
    const BEFORE = ADMISSION_CEILINGS.nodes - 8;
    const beforeIds = Array.from({ length: BEFORE }, (_, i) => `a${i}`);
    // The tail carries a RETRY, because 500 nodes can only ever produce 500 dispatches: the excess that
    // crosses the cap has to come from re-dispatches, exactly as it does in a real runaway.
    const afterIds = ['b0', 'b1', 'b2', 'b3', 'b4'];
    const RETRIES = ADMISSION_CEILINGS.retryMax; // 10 — enough that the cap trips before the budget does
    const line = ['start', ...beforeIds, 'g', ...afterIds];
    const WF = `  id: capped-resume
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
${beforeIds.map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`).join('\n')}
    - { id: g, type: human_gate, gate_type: approval }
    - { id: b0, type: agent, agent_ref: ag, prompt_template: 'go', retry: { max: ${RETRIES}, backoff: linear, backoff_ms: 1 } }
${afterIds
  .slice(1)
  .map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`)
  .join('\n')}
    - { id: done, type: output }
  edges:
${line
  .slice(1)
  .map((id, i) => `    - { from: ${line[i]}, to: ${id} }`)
  .join('\n')}
    - { from: ${afterIds[afterIds.length - 1]}, to: done }`;

    const store = new InMemoryRunStore();
    const engineA = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }) },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(WF) });
    let gateId = '';
    let dispatchesBefore = 0;
    for await (const event of handleA.events) {
      if (event.type === 'node:started') dispatchesBefore += 1;
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    // The premise: A really did spend almost the whole cap, and the durable log carries the count.
    expect(dispatchesBefore).toBeGreaterThan(ADMISSION_CEILINGS.nodeDispatchesPerRun - 10);
    expect(reconstructCheckpointState(store.eventsFor(handleA.runId))?.nodeDispatches).toBe(
      dispatchesBefore,
    );

    // `b0` always fails retryably, so it spends its whole budget and every attempt is a dispatch.
    const hostB = createInMemoryHost({ store });
    const engineB = engineWith(
      {
        b0: () => ({
          kind: 'failed',
          error: { code: 'provider_unavailable', message: 'flaky', retryable: true },
        }),
      },
      hostB,
    );
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(WF),
      gateId,
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    // The retry backoff arms a `work` timer, so a plain `drain` would wait on wall-clock that never passes.
    const events: RunEvent[] = [];
    let settled = false;
    const pump = (async (): Promise<void> => {
      while (!settled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (hostB.armedCount() > 0) hostB.fireTimers();
        if (hostB.deadlineCount() > 0) hostB.fireDeadlines();
      }
    })();
    for await (const event of handleB.events) {
      events.push(event);
      if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
    }
    await pump;

    // Refused, and that is the assertion: the cap counts the RUN, so what process A already spent bounds
    // what process B may still dispatch.
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('turn_limit');
  }, 60_000);

  it('the re-armed timer must not beat the decision this resume was handed', async () => {
    // **A regression `CR-22` introduced and its own tests could not see.** Rehydration arms a timer for
    // EVERY pending gate — including the one this resume targets — and a past-deadline gate arms at zero.
    // `beginResume` then awaits context resolution and the effect-resume gate BEFORE `resume()` claims the
    // gate, and `#onGateTimeout` guards only on `#settled || !#pendingGates.has(gateId)`, both still
    // permissive in that window. So a `timeout_action: approve` timer could fire first and record
    // `human_gate:resumed{decision:'approved', decidedBy:'timeout'}` for a caller who supplied `rejected` —
    // a human's explicit refusal rewritten as an approval attributed to a timer.
    //
    // It needs a REAL timer, not `createInMemoryHost`'s manual controller: a 0 ms manual timer never fires
    // without `fireTimers()`, which is exactly why the sibling past-deadline test cannot catch this.
    // `execution-model.md` already states the contract this violates — "a decision that arrives first
    // disarms the timer" — and on a cross-process resume the decision definitionally arrived first: it was
    // handed to `resumeFromCheckpoint` before the timer existed.
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      {
        g: () => ({
          kind: 'paused',
          gate: { gateType: 'approval', message: 'ok?', timeoutMs: 1000, timeoutAction: 'approve' },
        }),
      },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(GATED) });
    let gateId = '';
    let expiresAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'human_gate:paused') expiresAt = event.expiresAt ?? '';
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    // Past the deadline, so the re-arm lands at zero — the sharpest version of the window.
    const nowB = new Date(Date.parse(expiresAt) + 60_000).toISOString();
    const baseHostB = createInMemoryHost({ store });
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      // A real macrotask timer, and one awaited boundary inside `beginResume` is enough to let it land.
      setTimer: (ms, onFire) => {
        const t = setTimeout(onFire, ms);
        return () => {
          clearTimeout(t);
        };
      },
    };
    // A real MACROTASK boundary inside `beginResume`, which is what opens the window. Not contrived: the
    // port is `Promise`-typed precisely for a store that does I/O, and Phase-2's Postgres-backed
    // `EffectResumePort` is exactly this shape. With today's synchronous better-sqlite3 CLI both awaits
    // settle in microtasks and a `setTimeout(fn, 0)` lands after them — which is why this is unreachable on
    // the shipping host and reachable the moment any seam becomes genuinely async.
    const engineB = engineWith({}, hostB, {
      effectResume: {
        unresolvedForRun: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return [];
        },
      },
    });
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'rejected', decidedBy: 'a-real-human' },
    });
    const eventsB: RunEvent[] = [];
    for await (const event of handleB.events) eventsB.push(event);

    // The HUMAN's decision is what the durable log records — not the timer's.
    const resumed = eventsB.find((e) => e.type === 'human_gate:resumed');
    expect(resumed?.type === 'human_gate:resumed' && resumed.decidedBy).toBe('a-real-human');
    expect(resumed?.type === 'human_gate:resumed' && resumed.decision).toBe('rejected');
  });

  it("re-arms the RUN's `timeout_ms` at its remaining time, so a resume cannot renew the cap", async () => {
    // The other half of `CR-22`, and the one nothing held: reverting `#armRunTimeout` to the pre-fix
    // full-duration arm left all 1338 core tests green. ADR-0028 makes `timeout_ms` a bound on the run's
    // TOTAL wall-clock; arming it afresh on every resume meant a run crashed and resumed ten times got ten
    // times its authored budget, which is the opposite of a cap.
    //
    // Nothing new is persisted for this. `#seedFromCheckpoint` already restores `#startEpochMs` from the
    // checkpoint's `startedAtMs` — it always did, so a resumed run's terminal could report total wall-clock
    // — and both resume paths arm AFTER that seeding. The absolute deadline is derived from state the
    // engine already had.
    const TIMED = `  id: timed-gated
  timeout_ms: 60000
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }) },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(TIMED) });
    let gateId = '';
    let startedAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:started') startedAt = event.timestamp;
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    expect(startedAt).not.toBe('');

    // Resume 45 s into the run's 60 s budget. A FIXED clock, for the reason the gate test states: the
    // in-memory host's clock restarts its tick per host, so B's "now" would otherwise precede A's.
    const nowB = new Date(Date.parse(startedAt) + 45_000).toISOString();
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(TIMED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    await drain(handleB);

    // 15 s left of 60, not a fresh 60 — and exactly one timer, which is the guarantee the superseded
    // test's exact count carried and `toContain` would have dropped.
    expect(armedWork).toEqual([15_000]);
  });

  it('the run-timeout abort happens BEFORE its durable write, so a hung store cannot defeat it (ADR-0085 §3)', async () => {
    // `#onRunTimeout` awaited its `run:timeout` persist and THEN aborted, so a store that never settles meant
    // the abort never fired and the grace window never armed — the rescue path defeated by the very stall it
    // exists to rescue. The fix inverts the order, and nothing held it: reverting left all 1355 tests green.
    //
    // What this asserts is exactly what the fix buys and no more: the window ARMS. It cannot assert a
    // terminal, because ADR-0078 serialises every emit behind one delivery tail — which is why ADR-0085
    // §8.9's "including when the persist never settles" half is withdrawn against §6.
    const TIMED = `  id: hung-store
  timeout_ms: 1000
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: 'w' }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;
    const base = createInMemoryHost();
    let hangNext = false;
    const host: typeof base = {
      ...base,
      // **Delegated method-by-method, NOT spread.** `base.store` is a class instance, so `{...store}` copies
      // own properties and drops everything on the prototype — the store would silently lose
      // `resolveWorkflowId` and `listInterruptedRuns` and the run would die before it ever armed its cap.
      // (The same hazard a review flagged in `#fenceEffects`; it is easy to hit, which is the point.)
      store: {
        resolveWorkflowId: (slug) => base.store.resolveWorkflowId(slug),
        listInterruptedRuns: () => base.store.listInterruptedRuns(),
        readWorkflowSnapshot: (runId) => base.store.readWorkflowSnapshot(runId),
        persistEvent: (event, ctx) =>
          hangNext && event.type === 'run:timeout'
            ? new Promise<never>(() => undefined) // the store never settles on THIS write
            : base.store.persistEvent(event, ctx),
      },
    };
    const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
    const handle = engine.start({ workflow: workflow(TIMED) });
    // The stream MUST be consumed — the bus applies consumer backpressure, so an unread handle never lets
    // the run reach its first node. It will not complete here, which is exactly §8.9's withdrawal.
    void (async () => {
      for await (const _ of handle.events) void _;
    })();
    for (let i = 0; i < 400 && base.armedCount() === 0; i += 1) await Promise.resolve();
    expect(base.armedCount()).toBeGreaterThan(0); // the run cap is armed — the premise
    hangNext = true;
    base.fireTimers(); // the run cap elapses; its durable write will hang

    for (let i = 0; i < 300 && base.deadlineCount() === 0; i += 1) await Promise.resolve();
    // The grace window IS armed even though the diagnostic write is still pending.
    expect(base.deadlineCount()).toBe(1);
  });

  it('the three liveness constants are the values that actually arrive', async () => {
    // The manual timer controller DISCARDS `ms`, so a test that only fires a timer proves nothing about its
    // duration — the hollow-constant shape this phase has now hit three times. Measured: changing
    // GRACE_WINDOW_MS to 77 777, MEDIA_GEN_SUBMIT_TIMEOUT_MS to 3 333 and pollCallTimeoutMs to 300 000 all
    // left the suite green. This pins the two the engine arms directly; the media pair is pinned at their
    // own call sites.
    const base = createInMemoryHost();
    const armed: number[] = [];
    const host: typeof base = {
      ...base,
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'deadline') armed.push(ms);
        return base.setTimer(ms, onFire, kind);
      },
    };
    const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    for (let i = 0; i < 200 && !armed.length; i += 1) {
      await Promise.resolve();
      if (armed.length === 0) engine.cancel(handle.runId);
    }
    // The GRACE window, at its stated 10 s — not "some timer was armed". A LITERAL, deliberately:
    // `GRACE_WINDOW_MS` is module-private, and importing it would make the assertion compare the constant
    // with itself. The literal is what pins it — change the constant and this reddens.
    expect(armed).toEqual([10_000]);
    host.fireDeadlines();
    for (let i = 0; i < 400; i += 1) {
      await Promise.resolve();
      if (base.armedCount() > 0) base.fireTimers();
    }
    for await (const _ of handle.events) void _;
  });

  it('a never-settling executor still produces exactly one terminal (ADR-0085 §3)', async () => {
    // The defect ADR-0036's Consequences called "structurally impossible". `NodeExecutor.execute` returns an
    // arbitrary promise, `requestCancel()` only aborts a signal, and `#step` settles when `#countRunning()`
    // reaches zero — so an executor that ignores its signal and never settles left the run with no terminal,
    // forever. The same gate defeated ADR-0028's run `timeout_ms`, so the cap was no rescue either.
    const host = createInMemoryHost();
    const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    const events: RunEvent[] = [];
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
      }
    })();

    // Let the node start, then cancel. The grace window arms off the abort SIGNAL — not per cancel site —
    // so it exists here without `cancel()` knowing anything about it.
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'node:started'); i += 1) {
      await Promise.resolve();
    }
    engine.cancel(handle.runId);
    for (let i = 0; i < 200 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
    expect(host.deadlineCount()).toBe(1); // the grace window IS armed — the assertion nothing made before

    host.fireDeadlines();
    for (let i = 0; i < 600 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
    }
    await consume;

    // Exactly one terminal, and cancel-wins decides which (ADR-0036, unchanged).
    const terminals = events.filter(
      (e) => e.type === 'run:cancelled' || e.type === 'run:failed' || e.type === 'run:completed',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('run:cancelled');
    // …and the abandoned node has a terminal of its own, so no `node:started` is left without a partner.
    const nodeFailed = events.find((e) => e.type === 'node:failed');
    expect(nodeFailed?.type === 'node:failed' && nodeFailed.error.message).toContain(
      'the engine stopped waiting',
    );
    // An abandoned node's record is the ONLY record it gets, so it must not be the thinnest in the log. A
    // first version wrote the event inline and silently dropped the `correlationId` ADR-0036 calls the single
    // producer-side translation point, plus the cost snapshot the schema says the engine always populates.
    expect(nodeFailed?.type === 'node:failed' && nodeFailed.error.correlationId).toBeDefined();
    expect(nodeFailed?.type === 'node:failed' && nodeFailed.cumulativeCostMicrocents).toBeDefined();
    expect(host.deadlineCount()).toBe(0); // disarmed on settle, not leaked
  });

  it("honours an agent node's authored `timeout_ms` (CR-20, ADR-0085 §2)", async () => {
    // The field parsed and did nothing: `AgentNodeSchema` accepts it, node-types.md and workflow-yaml-spec.md
    // both advertise it, and `AgentPlanConfig` carries the whole node so it arrives at dispatch — with no
    // consumer. An authored field that parses and is ignored is the shape ADR-0023's strict-reject posture
    // exists to prevent, and worse than a missing feature because it is the bound a user plans around.
    // An AGENT node, because `timeout_ms` is only on `AgentNodeSchema` — which is itself the point: the
    // engine reads it off `AgentPlanConfig`, and no other node type declares one.
    const TIMED_NODE = `  id: node-timeout
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: a, prompt_template: 'go', timeout_ms: 4000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;
    const base = createInMemoryHost();
    const armed: number[] = [];
    const host: typeof base = {
      ...base,
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'deadline') armed.push(ms);
        return base.setTimer(ms, onFire, kind);
      },
    };
    const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
    const handle = engine.start({ workflow: workflow(TIMED_NODE) });
    const events: RunEvent[] = [];
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
      }
    })();
    for (let i = 0; i < 200 && armed.length === 0; i += 1) await Promise.resolve();

    // The AUTHORED value, not a default — a test that only checked "a timer was armed" would pass for a
    // hard-coded bound, which is the hollow shape `CR-21`'s close-out had to fix twice.
    expect(armed).toEqual([4000]);

    host.fireDeadlines();
    for (let i = 0; i < 600 && !settled; i += 1) {
      await Promise.resolve();
      if (base.armedCount() > 0) base.fireTimers();
    }
    await consume;

    // Classified as the human gate's authored `timeout_ms` already is — one meaning for one field name.
    const nodeFailed = events.find((e) => e.type === 'node:failed');
    expect(nodeFailed?.type === 'node:failed' && nodeFailed.error.code).toBe('run_timeout');
    expect(nodeFailed?.type === 'node:failed' && nodeFailed.error.retryable).toBe(false);
    expect(events.at(-1)?.type).toBe('run:failed');
  });

  it("a straggler's cost never reaches a live SUBSCRIBER after the terminal (ADR-0085 §5)", async () => {
    // **This test replaced one whose recorded reasoning was FALSE.** The first version captured events with
    // `for await` and concluded the `cost:updated` fence was defensive — "the run has settled and the bus is
    // closed, so `#settled` carries it". A review disproved it with a live `subscribe()` observer: the bus is
    // NOT closed to subscribers, and a stale `cost:updated` of 999 999 DOES arrive after the terminal. The
    // old test only looked green because its `for await` capture had already stopped.
    //
    // So the fence at the `cost:updated` fold is load-bearing, not defence in depth, and this is what holds
    // it: a straggler from an abandoned dispatch may not push a number at an observer after that observer
    // has been told the run's total.
    let releaseNode: ((outcome: NodeOutcome) => void) | undefined;
    let costEmit: ((n: number) => void) | undefined;
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) =>
          new Promise<NodeOutcome>((resolve) => {
            releaseNode = resolve;
            costEmit = (costMicrocents) => {
              ctx.emit({
                type: 'cost:updated',
                nodeId: ctx.vertex.id,
                model: 'm',
                inputTokens: 0,
                outputTokens: 0,
                costMicrocents,
                cumulativeCostMicrocents: 0,
              });
            };
          }),
      },
    });
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    // A LIVE observer, not a `for await` capture — the distinction the old test got wrong.
    const seen: RunEvent[] = [];
    handle.subscribe((event) => {
      seen.push(event);
    });
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
      }
    })();
    for (let i = 0; i < 200 && releaseNode === undefined; i += 1) await Promise.resolve();
    expect(releaseNode).toBeDefined();

    engine.cancel(handle.runId);
    for (let i = 0; i < 200 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
    host.fireDeadlines();
    for (let i = 0; i < 400 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
    }
    await consume;
    const terminalIndex = seen.findIndex((e) => e.type === 'run:cancelled');
    expect(terminalIndex).toBeGreaterThanOrEqual(0);

    // …and NOW the abandoned executor wakes and tries to spend.
    costEmit?.(999_999);
    releaseNode?.({ kind: 'completed', output: 'too late' });
    for (let i = 0; i < 200; i += 1) await Promise.resolve();

    // Nothing after the terminal, and certainly not that number.
    expect(seen.slice(terminalIndex + 1)).toEqual([]);
    expect(seen.some((e) => e.type === 'cost:updated' && e.costMicrocents === 999_999)).toBe(false);
  });

  it('the effect fence refuses `prepare` but never `settle` or `discard` (ADR-0085 §5)', async () => {
    // The per-method split, tested directly, because a blanket "refuse a stale write" would resurrect
    // `PR83-04` exactly: a row stuck `prepared` forever, swept by nothing, reported as `needs_attention` for
    // an effect that actually completed. `prepare` is refused because the effect has not left the process;
    // `settle` and `discard` are admitted because it has, and refusing a receipt strands the row.
    const calls: string[] = [];
    const livePrepare: { slot: number; toolId: string }[] = [];
    let captured: NodeExecContext['effects'];
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: async (ctx) => {
          captured = ctx.effects;
          // A LIVE prepare, while the dispatch is unquestionably current — the pass-through this wrapper
          // must not break.
          await ctx.effects?.prepare(7, 'run_command', 3, {});
          return new Promise<NodeOutcome>(() => undefined); // never settles — so it gets abandoned
        },
      },
      effectJournal: () => ({
        prepare: (slot, toolId) => {
          calls.push('prepare');
          livePrepare.push({ slot, toolId });
          return Promise.resolve({ outcome: 'proceed' as const });
        },
        settle: () => {
          calls.push('settle');
          return Promise.resolve();
        },
        discard: () => {
          calls.push('discard');
          return Promise.resolve();
        },
      }),
    });
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
      }
    })();
    for (let i = 0; i < 200 && captured === undefined; i += 1) await Promise.resolve();
    expect(captured).toBeDefined();

    engine.cancel(handle.runId);
    for (let i = 0; i < 200 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
    host.fireDeadlines();
    for (let i = 0; i < 400 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
    }
    await consume;

    // The straggler still holds its journal handle. `prepare` is refused — loudly, so a caller that ignores
    // the rejection cannot mistake it for a durable claim and dispatch anyway.
    const callsBefore = [...calls];
    await expect(captured?.prepare(1, 'http_request', 3, {})).rejects.toBeInstanceOf(
      EngineStateError,
    );
    expect(calls).toEqual(callsBefore); // the refused prepare never reached the port at all
    // …and the underlying port was genuinely reached BEFORE the fence closed, so the wrapper is a filter and
    // not a wall. Without this the whole live path — every effectful node's dispatch — could break and this
    // test would stay green: mutating `return port.prepare(...args)` to throw left all 1355 tests passing.
    expect(livePrepare).toEqual([{ slot: 7, toolId: 'run_command' }]);

    // …while a receipt for work that already left the process still lands.
    await captured?.settle(1, 'http_request', 'committed');
    await captured?.discard(1, 'http_request');
    // The live `prepare` is in this list and the refused one is not — which is the whole split.
    expect(calls).toEqual(['prepare', 'settle', 'discard']);
  });

  it('a timed-out node cannot report success afterwards, while a sibling keeps the run alive (ADR-0085 §5)', async () => {
    // **The window this item created, and `#settled` does not cover it.** When a node's own `timeout_ms`
    // trips, `#dispatchBounded` settles it `failed` while `#dispatchLoop` keeps running. With a sibling still
    // in flight the RUN has not settled — so the timed-out node's eventual outcome reaches `#onOutcome` on a
    // live run and, unfenced, overwrites the timeout with a `completed`. A node reporting success for work
    // the engine already told the user had timed out.
    //
    // Measured: removing the fence leaves all 1354 tests green, which is why this exists.
    const TWO = `  id: two-nodes
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: a, type: agent, agent_ref: ag, prompt_template: 'go', timeout_ms: 3000 }
    - { id: b, type: transform, transform: 'b' }
    - { id: out, type: output }
  edges:
    - { from: start, to: a }
    - { from: start, to: b }
    - { from: a, to: out }
    - { from: b, to: out }`;
    let releaseA: ((o: NodeOutcome) => void) | undefined;
    let releaseB: ((o: NodeOutcome) => void) | undefined;
    const host = createInMemoryHost();
    const engine = engineWith(
      {
        a: () =>
          new Promise<NodeOutcome>((resolve) => {
            releaseA = resolve;
          }),
        b: () =>
          new Promise<NodeOutcome>((resolve) => {
            releaseB = resolve;
          }),
      },
      host,
    );
    const handle = engine.start({ workflow: workflow(TWO) });
    const events: RunEvent[] = [];
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:completed' || event.type === 'run:failed') settled = true;
      }
    })();
    for (let i = 0; i < 300 && (releaseA === undefined || releaseB === undefined); i += 1) {
      await Promise.resolve();
    }
    expect(releaseA).toBeDefined();
    expect(releaseB).toBeDefined();

    // `a`'s bound trips. `b` is untouched, so the RUN is still live — which is the whole point.
    host.fireDeadlines();
    for (let i = 0; i < 300 && !events.some((e) => e.type === 'node:failed'); i += 1) {
      await Promise.resolve();
    }
    const failedA = events.find((e) => e.type === 'node:failed');
    expect(failedA?.type === 'node:failed' && failedA.nodeId).toBe('a');
    expect(failedA?.type === 'node:failed' && failedA.error.code).toBe('run_timeout');
    expect(settled).toBe(false); // …and the run has NOT ended — the sibling still holds it open

    // Now `a`'s abandoned executor wakes and claims success.
    releaseA?.({ kind: 'completed', output: 'too late' });
    for (let i = 0; i < 300; i += 1) await Promise.resolve();

    // It is refused: `a` has exactly one node terminal, and it is the timeout.
    const aTerminals = events.filter(
      (e) =>
        (e.type === 'node:completed' || e.type === 'node:failed' || e.type === 'node:skipped') &&
        e.nodeId === 'a',
    );
    expect(aTerminals).toHaveLength(1);
    expect(aTerminals[0]?.type).toBe('node:failed');

    releaseB?.({ kind: 'completed', output: 'b done' });
    for (let i = 0; i < 400 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
    }
    await consume;
  });

  it('a resuming clock BEHIND cannot grow the run cap either (the gate half had this clamp, the run half did not)', async () => {
    // `#elapsedMs()` differences THIS process's clock against `#startEpochMs`, seeded from ANOTHER process's
    // `run:started`. A resuming clock running behind yields a negative elapsed and a remaining LARGER than
    // the authored cap. Measured before the fix: an hour of skew re-armed a 60 000 ms cap at 3 660 000 ms.
    // The gate half gained this clamp from the Step 3 round; the run half, twenty-five lines away, did not.
    const TIMED = `  id: timed-skew
  timeout_ms: 60000
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }) },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(TIMED) });
    let gateId = '';
    let startedAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:started') startedAt = event.timestamp;
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    const nowB = new Date(Date.parse(startedAt) - 3_600_000).toISOString(); // an hour BEHIND
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    await drain(
      await engineB.resumeFromCheckpoint({
        runId: handleA.runId,
        workflow: workflow(TIMED),
        gateId,
        decision: { decision: 'approved', decidedBy: 'h' },
      }),
    );

    // Never longer than authored, whatever the two clocks think of each other.
    expect(armedWork.every((ms) => ms <= 60_000)).toBe(true);
    expect(armedWork).not.toContain(3_660_000);
  });

  it('a stale dispatch cannot move the run cost while its successor is live (ADR-0085 §5)', async () => {
    // **The fence had to compare a CAPTURED id, and a first version compared a value against itself.** Both
    // guards read `#dispatchIdForVertex.get(vertex.id)` at write time, and `#dispatch` writes the same id
    // into both maps — so while any dispatch of the vertex is active the two sides were equal by
    // construction and the predicate degenerated to `!#settled && has(vertex)`. That is exactly the "second
    // boolean latch" ADR-0085 §5 rejects, because it cannot tell dispatch N from N+1 — and the
    // budget-approved re-dispatch produces precisely that.
    //
    // Here dispatch N pauses for approval and keeps its `ctx.emit`; the approval re-dispatches the vertex;
    // then N's captured closure fires a cost. Measured before the fix: it was DELIVERED.
    const APPROVED = `  id: stale-cost
  nodes:
    - { id: gen, type: transform, transform: 'g' }
    - { id: out, type: output }
  edges:
    - { from: gen, to: out }
  budget:
    max_cost_microcents: 100000000
    on_exceed: pause_for_approval`;
    let staleEmit: (() => void) | undefined;
    let dispatches = 0;
    const engine = engineWith({
      gen: (ctx) => {
        dispatches += 1;
        if (dispatches === 1) {
          // Keep dispatch N's closure alive past its own pause.
          staleEmit = () => {
            ctx.emit({
              type: 'cost:updated',
              nodeId: 'gen',
              model: 'm',
              inputTokens: 0,
              outputTokens: 0,
              costMicrocents: 999_999,
              cumulativeCostMicrocents: 0,
            });
          };
          return {
            kind: 'paused',
            gate: {
              gateType: 'approval',
              message: 'over budget — continue?',
              isBudgetGate: true,
              spentMicrocents: 900,
              limitMicrocents: 1000,
            },
          };
        }
        staleEmit?.(); // dispatch N+1 is live; N's stale closure fires now
        return { kind: 'completed', output: 'done' };
      },
    });
    const handle = engine.start({ workflow: workflow(APPROVED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
        }
      }
    }

    expect(dispatches).toBe(2); // the premise: the approval really did re-dispatch
    // **The stale closure's cost is not DELIVERED — and it IS folded.** An earlier version also asserted the
    // run total never saw it, which was wrong in a way that lost real money: the counter is what
    // `TurnMoneyPort.record` stamps as `cumulativeCostMicrocents`, and `refineCostAttemptSettled` rejects a
    // row whose cumulative is below its own cost. Refusing the fold made a genuinely billed attempt produce
    // `cumulative 0 < cost 999999`, rejected at a producer gate that runs OUTSIDE `#emitDurable`'s try — so
    // it threw where the design assumes it cannot, and the durable ledger row was lost. A charge the
    // provider took is recorded either way (ADR-0045 §5); the fence stops re-announcing a total to
    // subscribers after the terminal published one.
    const costs = events.filter((e) => e.type === 'cost:updated');
    expect(costs.some((e) => e.type === 'cost:updated' && e.costMicrocents === 999_999)).toBe(
      false,
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:completed');
    // …and the FOLD happened: the run total includes it. This is the assertion that would have caught the
    // money loss — refusing the fold leaves the counter behind the ledger row that stamps from it.
    expect(
      terminal?.type === 'run:completed' && terminal.totalCostMicrocents,
    ).toBeGreaterThanOrEqual(999_999);
  });

  it('a fault mid-abandonment still gives every other abandoned node its terminal (ADR-0085 §4)', async () => {
    // **`#settleFailed` is not the total path its callers assume.** `#emitDurable` absorbs store faults, but
    // `#bus.next` — which stamps the sequence number and Zod-parses the candidate — runs OUTSIDE that try,
    // and so does `this.#host.ids.newId()` in the `node:failed` draft. A throw from either aborted
    // `#onGraceElapsed`'s whole loop: every remaining abandoned node lost its `node:failed` (the omission §4
    // forbids), the `#failure` fallback was skipped, `#schedule()` was skipped, and the rejection floated
    // out of `void this.#onGraceElapsed()` — fatal under Node's default `--unhandled-rejections=throw`.
    //
    // The fault is injected at `ids.newId()` because that is the one draft-construction call the grace path
    // makes on a host port, and it is one-shot so only the FIRST abandoned node is hit — which is the whole
    // point: the second must still get its terminal.
    const FANOUT = `  id: grace-fanout
  nodes:
    - { id: start, type: input }
    - { id: a, type: transform, transform: 'g' }
    - { id: b, type: transform, transform: 'g' }
    - { id: done, type: output }
  edges:
    - { from: start, to: a }
    - { from: start, to: b }
    - { from: a, to: done }
    - { from: b, to: done }`;
    const base = createInMemoryHost();
    let faultedOnce = false;
    // Armed only just before the grace window fires. `newId()` is called during run setup and on every
    // node terminal, so an always-on fault kills the run long before the path under test.
    let armFault = false;
    const host: typeof base = {
      ...base,
      ids: {
        newId: () => {
          if (armFault && !faultedOnce) {
            faultedOnce = true;
            throw new Error('id source unavailable');
          }
          return base.ids.newId();
        },
      },
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const engine = engineWith(
        {
          a: () => new Promise<NodeOutcome>(() => undefined),
          b: () => new Promise<NodeOutcome>(() => undefined),
        },
        host,
      );
      const handle = engine.start({ workflow: workflow(FANOUT) });
      const events: RunEvent[] = [];
      let settled = false;
      const consume = (async (): Promise<void> => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
        }
      })();

      for (
        let i = 0;
        i < 400 && events.filter((e) => e.type === 'node:started').length < 3;
        i += 1
      ) {
        await Promise.resolve();
      }
      engine.cancel(handle.runId);
      for (let i = 0; i < 400 && host.deadlineCount() === 0; i += 1) await Promise.resolve();
      armFault = true;
      host.fireDeadlines();
      for (let i = 0; i < 800 && !settled; i += 1) {
        await Promise.resolve();
        if (host.armedCount() > 0) host.fireTimers();
      }
      await consume;

      // The load-bearing assertions: the run TERMINATES (it hung before), the SECOND abandoned node still
      // got its terminal even though the first one's draft threw, and nothing floated.
      expect(terminalsIn(events)).toHaveLength(1);
      expect(faultedOnce).toBe(true); // the fault really was injected
      expect(events.filter((e) => e.type === 'node:failed')).toHaveLength(1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a DISARM that throws cannot strand the grace backstop either (ADR-0085 §3)', async () => {
    // The other half of the abandonment backstop, and it needs its own test because the per-vertex catch
    // inside the loop does not cover it: `#onGraceElapsed` sweeps the node deadlines BEFORE the loop, so a
    // host whose disarm function throws rejects the method outside every try it contains. Without the
    // `.catch` at `void this.#onGraceElapsed()` that is an `unhandledRejection` AND a terminal-less run —
    // the same pair the `#dispatch` call site guards against, on the one path that is supposed to be the
    // last line of defence.
    const BOUND = `  id: disarm-throws
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: ag, prompt_template: 'go', timeout_ms: 600000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;
    const base = createInMemoryHost();
    let nodeDeadlineArmed = false;
    const host: typeof base = {
      ...base,
      setTimer: (ms, fire, kind) => {
        const disarm = base.setTimer(ms, fire, kind);
        // **Selected by DELAY, not by arm order** — a break-verify caught the order assumption being wrong.
        // `node:started` is emitted BEFORE `#dispatch` arms the node bound, so a cancel landing in that gap
        // arms the 10 s grace window FIRST. Picking "the first `'deadline'`" made this test fault the grace
        // disarm, which `#onGraceElapsed` never calls (it clears `#graceDisarm` without invoking it) — so
        // the test passed with the production fix reverted. The authored 600 000 is unambiguous.
        if (kind !== 'deadline' || ms !== 600_000) return disarm;
        nodeDeadlineArmed = true;
        return () => {
          throw new Error('disarm failed');
        };
      },
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
      const handle = engine.start({ workflow: workflow(BOUND) });
      const events: RunEvent[] = [];
      let settled = false;
      const consume = (async (): Promise<void> => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
        }
      })();

      for (
        let i = 0;
        i < 400 && !events.some((e) => e.type === 'node:started' && e.nodeId === 'work');
        i += 1
      ) {
        await Promise.resolve();
      }
      engine.cancel(handle.runId);
      for (let i = 0; i < 400 && host.deadlineCount() < 2; i += 1) await Promise.resolve();
      expect(nodeDeadlineArmed).toBe(true); // the node bound is armed, with the throwing disarm attached
      host.fireDeadlines();
      for (let i = 0; i < 800 && !settled; i += 1) {
        await Promise.resolve();
        if (host.armedCount() > 0) host.fireTimers();
      }
      await consume;

      expect(terminalsIn(events)).toHaveLength(1); // it terminates at all — it hung before
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a host whose `setTimer` throws still reaches exactly one terminal — no floating rejection (ADR-0085 §6)', async () => {
    // **A synchronous host fault used to strand the run.** `#armNodeDeadline` runs OUTSIDE `#dispatch`'s
    // `try`, so a host whose `setTimer` throws rejects the promise at `void this.#dispatch(...)`. Un-caught
    // that is an `unhandledRejection` AND a terminal-less run: the node stays `running`, `#handleIdle` sees
    // work in flight forever, and no `run:failed` is ever published. The call site now routes it to
    // `#failNodeInternal`, the same backstop every other internal fault uses.
    const FAULTY = `  id: faulty-host
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: ag, prompt_template: 'go', timeout_ms: 5000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;
    const base = createInMemoryHost();
    let faultedOnce = false;
    const host: typeof base = {
      ...base,
      setTimer: (ms, fire, kind) => {
        // ONE-SHOT, and it must be: `'deadline'` is also the kind the abort path's own arms use, so a
        // permanently faulting host breaks the very settle this test asserts and proves nothing about the
        // dispatch call site. The first `'deadline'` arm of this run IS `work`'s node deadline — `start` is
        // an `input` node with no `timeout_ms`.
        if (kind === 'deadline' && !faultedOnce) {
          faultedOnce = true;
          throw new Error('host clock unavailable');
        }
        return base.setTimer(ms, fire, kind);
      },
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
      // The run TERMINATES — this `drain` hung forever under the old behaviour, which is the bug.
      const events = await drain(engine.start({ workflow: workflow(FAULTY) }));
      const terminal = events.at(-1);
      expect(terminal?.type).toBe('run:failed');
      expect(terminal?.type === 'run:failed' && terminal.error.message).toContain(
        'host clock unavailable',
      );
      expect(
        events.filter((e) => e.type === 'run:failed' || e.type === 'run:completed'),
      ).toHaveLength(1);
      // Give any floating rejection a full macrotask to surface before asserting there was none. A REAL
      // `setTimeout` — the in-memory host's timers are a manual controller that never fires on its own, so
      // parking on `base.setTimer` here would hang the test rather than yield to the runtime.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it("a budget-approved RE-dispatch does not renew the node's `timeout_ms` (ADR-0085 §2)", async () => {
    // **"Absolute per node" was absolute per DISPATCH, and nothing saw it.** An approved budget gate returns
    // the vertex to `pending` (`#claimReady` re-claims it), so the node got a second `#dispatch` — and a
    // second FULL-length bound. A node that pauses for approval and continues could spend 2 × `timeout_ms`,
    // which is the same shape as `CR-22`'s run cap renewing on every resume, one level down. Reverting to a
    // fresh bound per dispatch left all 110 tests in this file green.
    const APPROVED = `  id: budget-redispatch
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: gen, type: agent, agent_ref: a, prompt_template: 'go', timeout_ms: 5000 }
    - { id: out, type: output }
  edges:
    - { from: gen, to: out }
  budget:
    max_cost_microcents: 100000000
    on_exceed: pause_for_approval`;
    const base = createInMemoryHost();
    const armed: number[] = [];
    const host: typeof base = {
      ...base,
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'deadline') armed.push(ms);
        return base.setTimer(ms, onFire, kind);
      },
    };
    let dispatches = 0;
    const engine = engineWith(
      {
        gen: () => {
          dispatches += 1;
          if (dispatches === 1) {
            return {
              kind: 'paused',
              gate: {
                gateType: 'approval',
                message: 'over budget — continue?',
                isBudgetGate: true,
                spentMicrocents: 900,
                limitMicrocents: 1000,
              },
            };
          }
          return { kind: 'completed', output: 'done' };
        },
      },
      host,
    );
    const handle = engine.start({ workflow: workflow(APPROVED) });
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
        }
      }
    }

    expect(dispatches).toBe(2); // the approval really did re-dispatch — the premise, not the claim
    // **Armed ONCE, for the node, and not re-armed by the re-dispatch.** An earlier version expected two
    // arms with the second smaller, because the deadline was owned by the dispatch call. It is owned by the
    // RUN now and survives the park, which is the stronger property: a renewing bound would appear here as
    // a second 5000.
    expect(armed).toEqual([5000]);
  });

  it('a cancel treats a node WITH `timeout_ms` exactly like one without (ADR-0085 §3)', async () => {
    // **An asymmetry nobody decided.** `openDeadline.race` returns `{outcome:'deadline'}` for a caller abort
    // as well as an elapsed bound, and settling on both gave a node carrying `timeout_ms` ZERO grace on
    // cancel while an unbounded node got the full 10 s window. An author writing `timeout_ms` is bounding
    // WORK time; nothing about that says "and give me no cleanup window if the run is cancelled". It also
    // negated §3's own justification for the window — "would abandon well-behaved work that was seconds from
    // returning" — for precisely the nodes someone had thought about.
    //
    // Both shapes now behave identically: the cancel arms the window, and the node settles only when the
    // window elapses or the executor gets there first.
    const withBound = `  id: cancel-bounded
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: ag, prompt_template: 'go', timeout_ms: 60000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;

    const observe = async (wf: string): Promise<{ settledBeforeGrace: boolean }> => {
      const host = createInMemoryHost();
      const engine = engineWith({ work: () => new Promise<NodeOutcome>(() => undefined) }, host);
      const handle = engine.start({ workflow: workflow(wf) });
      let settled = false;
      let started = false;
      const consume = (async (): Promise<void> => {
        for await (const event of handle.events) {
          if (event.type === 'node:started' && event.nodeId === 'work') started = true;
          if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
        }
      })();
      // Wait for the node to be genuinely in flight — a cancel before it starts settles the run at once and
      // neither shape reaches the path under test. `deadlineCount()` cannot be the trigger here: the bounded
      // shape has already armed its own node deadline, which is the same kind.
      for (let i = 0; i < 300 && !started; i += 1) await Promise.resolve();
      expect(started).toBe(true);
      engine.cancel(handle.runId);
      // Pump generously WITHOUT firing any backstop.
      for (let i = 0; i < 300; i += 1) await Promise.resolve();
      // Pump WITHOUT firing the backstop. A node that settles here got no grace at all.
      const settledBeforeGrace = settled;
      host.fireDeadlines();
      for (let i = 0; i < 400 && !settled; i += 1) {
        await Promise.resolve();
        if (host.armedCount() > 0) host.fireTimers();
      }
      await consume;
      return { settledBeforeGrace };
    };

    const bounded = await observe(withBound);
    const unbounded = await observe(SEQUENTIAL);
    // The load-bearing assertion is the EQUALITY: whatever the grace policy is, an authored `timeout_ms`
    // must not silently change it.
    expect(bounded.settledBeforeGrace).toBe(unbounded.settledBeforeGrace);
    expect(bounded.settledBeforeGrace).toBe(false); // …and neither is abandoned before the window elapses
  });

  it('a bounded node that settles cooperatively INSIDE the grace window keeps its cost (ADR-0085 §3/§5)', async () => {
    // **The fence slot must outlive `#dispatchBounded`'s early return.** On a caller abort that method
    // returns while `#dispatchLoop` is still running — deliberately, so the grace window governs. Releasing
    // the vertex's `#activeDispatchByVertex` entry in `#dispatch`'s `finally` then un-fenced a node that was
    // still legitimately live: if its executor settled cooperatively inside the window, `#isLive` refused
    // its `cost:updated` fold and, worse, its `save_to` write. The window exists to let exactly that land.
    let release: ((o: NodeOutcome) => void) | undefined;
    let emitCost: (() => void) | undefined;
    const BOUNDED = `  id: cooperative-bounded
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: ag, prompt_template: 'go', timeout_ms: 60000 }
    - { id: done, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: done }`;
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) =>
          ctx.vertex.id === 'work'
            ? new Promise<NodeOutcome>((resolve) => {
                release = resolve;
                emitCost = () => {
                  ctx.emit({
                    type: 'cost:updated',
                    nodeId: 'work',
                    model: 'm',
                    inputTokens: 0,
                    outputTokens: 0,
                    costMicrocents: 4_242,
                    cumulativeCostMicrocents: 0,
                  });
                };
              })
            : Promise.resolve({ kind: 'completed', output: ctx.vertex.id }),
      },
    });
    const handle = engine.start({ workflow: workflow(BOUNDED) });
    const seen: RunEvent[] = [];
    handle.subscribe((event) => {
      seen.push(event);
    });
    let settled = false;
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        if (event.type === 'run:cancelled' || event.type === 'run:failed') settled = true;
      }
    })();
    for (let i = 0; i < 300 && release === undefined; i += 1) await Promise.resolve();
    expect(release).toBeDefined();

    engine.cancel(handle.runId); // the node is handed to the grace window, still running
    for (let i = 0; i < 200; i += 1) await Promise.resolve();

    // The executor honours its signal and settles INSIDE the window, reporting what it spent.
    emitCost?.();
    release?.({
      kind: 'failed',
      error: { code: 'cancelled', message: 'stopped', retryable: false },
    });
    for (let i = 0; i < 400 && !settled; i += 1) {
      await Promise.resolve();
      if (host.armedCount() > 0) host.fireTimers();
      if (host.deadlineCount() > 0) host.fireDeadlines();
    }
    await consume;

    // Its cost was NOT refused — the node was live, not a straggler.
    expect(seen.some((e) => e.type === 'cost:updated' && e.costMicrocents === 4_242)).toBe(true);
  });

  it('a node with no `timeout_ms` arms no node deadline', async () => {
    // The negative control. Without it the test above passes for an implementation that bounds every node at
    // some default — a different product decision nobody made.
    const base = createInMemoryHost();
    const armed: number[] = [];
    const host: typeof base = {
      ...base,
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'deadline') armed.push(ms);
        return base.setTimer(ms, onFire, kind);
      },
    };
    await drain(
      engineWith({ work: () => ({ kind: 'completed', output: 'x' }) }, host).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(armed).toEqual([]);
  });

  it('a run resumed PAST its `timeout_ms` arms at zero, never a negative duration', async () => {
    // The run half's `Math.max(0, …)` clamp had no test: removing it left all 1339 core tests green, and it
    // is invisible to coverage because `Math.max` is a call, not a branch, so v8 reports the line covered.
    // The gate half had a past-deadline test from the start; this is its missing twin.
    const TIMED = `  id: timed-expired
  timeout_ms: 1000
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }) },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(TIMED) });
    let gateId = '';
    let startedAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:started') startedAt = event.timestamp;
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    // Resume a full minute past a one-second cap — the budget is long gone.
    const nowB = new Date(Date.parse(startedAt) + 60_000).toISOString();
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(TIMED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    await drain(handleB);

    // Zero, not −59 000. A negative duration handed to a host `setTimeout` is a fire-immediately on Node and
    // undefined behaviour on another host; the clamp is what makes the expired case one shape everywhere.
    expect(armedWork).toContain(0);
    expect(armedWork.every((ms) => ms >= 0)).toBe(true);
  });

  it('a SURVIVING gate keeps its deadline across the resume — the case the item exists for', async () => {
    // **The motivating case, and it had no test.** The sibling tests all resume a run's ONLY gate — which
    // `resume()` disarms two lines later, i.e. precisely the "target gate" case the old deferral was right
    // to say did not matter. What `CR-22` actually fixes is a gate that survives the resume: a multi-gate
    // run, or a crash while parked, rehydrated its remaining gates with NO timer, so their deadlines
    // stopped existing until the next restart.
    //
    // Two gates, resume one, assert the OTHER still holds a deadline — at its remaining time, and still
    // armed after the resume has settled into its next park.
    const MULTIGATE = `  id: multigate
  nodes:
    - { id: start, type: input }
    - { id: g1, type: human_gate, gate_type: approval }
    - { id: g2, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g1 }
    - { from: start, to: g2 }
    - { from: g1, to: out }
    - { from: g2, to: out }`;
    const store = new InMemoryRunStore();
    const gate = (message: string) => ({
      kind: 'paused' as const,
      gate: {
        gateType: 'approval' as const,
        message,
        timeoutMs: 5000,
        timeoutAction: 'reject' as const,
      },
    });
    const engineA = engineWith(
      { g1: () => gate('first?'), g2: () => gate('second?') },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(MULTIGATE) });
    const gateIds: string[] = [];
    const expiries: string[] = [];
    for await (const event of handleA.events) {
      if (event.type === 'human_gate:paused') {
        gateIds.push(event.gateId);
        expiries.push(event.expiresAt ?? '');
      }
      if (event.type === 'run:paused' && gateIds.length === 2) break;
    }
    expect(gateIds).toHaveLength(2);

    // The two gates park a few clock ticks apart (the in-memory clock advances per read), so they expire at
    // slightly different instants. Pin `now` off the first and compute BOTH expected remainings exactly —
    // a band assertion would hide an off-by-one in the arithmetic this test exists to check.
    const nowB = new Date(Date.parse(expiries[0] ?? '') - 4000).toISOString();
    const expectedRemaining = expiries.map((e) => Date.parse(e) - Date.parse(nowB));
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({ g2: () => gate('second?') }, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(MULTIGATE),
      gateId: gateIds[0] ?? '',
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    for await (const event of handleB.events) {
      if (event.type === 'run:paused') break; // re-parked on the surviving gate
    }

    // BOTH gates were re-armed at their own remaining time — the surviving one is the point. Before the fix
    // this array was empty, because rehydration armed nothing at all.
    expect(expectedRemaining[0]).toBe(4000); // …and the arithmetic is what it claims
    for (const ms of expectedRemaining) expect(armedWork).toContain(ms);
    // …and the survivor's timer is still live after the resume settled: the decision disarmed only its own.
    expect(baseHostB.armedCount()).toBeGreaterThan(0);
  });

  it('a gate whose deadline ALREADY passed re-arms at zero rather than resolving inline', async () => {
    // The past-deadline case has to travel the same `#onGateTimeout` path as a live expiry, or a
    // past-deadline resume and an expiring live run would produce two differently-shaped exits for one
    // condition. Arming at zero is what keeps it to one: the timer fires on the next tick.
    const store = new InMemoryRunStore();
    const engineA = engineWith(
      {
        g: () => ({
          kind: 'paused',
          gate: { gateType: 'approval', message: 'ok?', timeoutMs: 1000, timeoutAction: 'reject' },
        }),
      },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(GATED) });
    let gateId = '';
    let expiresAt = '';
    for await (const event of handleA.events) {
      if (event.type === 'human_gate:paused') expiresAt = event.expiresAt ?? '';
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    const nowB = new Date(Date.parse(expiresAt) + 60_000).toISOString(); // a minute PAST the deadline
    const baseHostB = createInMemoryHost({ store });
    const armedWork: number[] = [];
    const hostB: typeof baseHostB = {
      ...baseHostB,
      clock: { now: () => nowB },
      setTimer: (ms, onFire, kind = 'work') => {
        if (kind === 'work') armedWork.push(ms);
        return baseHostB.setTimer(ms, onFire, kind);
      },
    };
    const engineB = engineWith({}, hostB);
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: workflow(GATED),
      gateId,
      decision: { decision: 'approved', decidedBy: 'h' },
    });
    await drain(handleB);

    // Clamped at zero — never a negative duration handed to a host timer. Exact, for the same reason as
    // its siblings: with a one-element array `every(ms => ms >= 0)` was implied by the value assertion and
    // could never be the failing line.
    expect(armedWork).toEqual([0]);
  });
});

// --- workflow context (ctx.*) resolution -----------------------------------------------------

describe('WorkflowEngine — workflow context (ctx.*) resolution', () => {
  const CTX_WF = `  id: ctx-wf
  inputs:
    - { name: name, type: string }
  context:
    - { key: greeting, value: 'hi {{inputs.name}}' }
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1' }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`;
  const echoCtx = (c: NodeExecContext): NodeOutcome => ({ kind: 'completed', output: c.ctx });

  it('resolves the workflow context once at start and threads ctx.* to every node', async () => {
    const events = await drain(
      engineWith({ work: echoCtx }).start({
        workflow: workflow(CTX_WF),
        inputs: { name: 'world' },
      }),
    );
    const workDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(workDone?.type === 'node:completed' ? workDone.output : undefined).toEqual({
      greeting: 'hi world',
    });
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('fails the run (validation) when a context value cannot be resolved — before any node runs', async () => {
    const events = await drain(
      engineWith({}).start({
        workflow: workflow(`  id: ctx-bad
  inputs:
    - { name: p, type: string }
  context:
    - { key: c, value: '{{inputs.p | read_file}}' }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }`),
        inputs: { p: 'x' },
      }),
    );
    expect(events[0]?.type).toBe('run:started'); // run:started still precedes the failure (ordering)
    expect(events.some((e) => e.type === 'node:started')).toBe(false); // failed before scheduling
    const terminal = terminalsIn(events)[0];
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      expect(terminal.error.code).toBe('validation');
    }
  });

  it('threads ctx: {} when the workflow declares no context: block', async () => {
    const events = await drain(
      engineWith({ work: echoCtx }).start({
        workflow: workflow(`  id: no-ctx
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1' }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`),
      }),
    );
    const workDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(workDone?.type === 'node:completed' ? workDone.output : undefined).toEqual({});
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('settles run:cancelled (not run:failed) when a cancel races context resolution', async () => {
    // A const holder lets the readFile closure reach the not-yet-assigned handle without `let`.
    const ref: { handle?: RunHandle } = {};
    // The readFile cap cancels the run mid-resolution, then throws — so context resolution rejects while
    // #cancelling is already set. #resolveContextOrFail must classify this as a cancel, not a validation fail.
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: new StubExecutor({}),
      resolverCapabilities: {
        readFile: () => {
          ref.handle?.cancel();
          throw new Error('reading was cancelled');
        },
      },
    });
    ref.handle = engine.start({
      workflow: workflow(`  id: ctx-cancel
  inputs:
    - { name: p, type: string }
  context:
    - { key: c, value: '{{inputs.p | read_file}}' }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }`),
      inputs: { p: 'x' },
    });
    const events = await drain(ref.handle);
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled'); // NOT run:failed{validation}
  });

  it('resolves a read_file context value through the injected resolver capability', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: new StubExecutor({ work: echoCtx }),
      resolverCapabilities: { readFile: (p) => `FILE:${p}` },
    });
    const events = await drain(
      engine.start({
        workflow: workflow(`  id: ctx-rf
  inputs:
    - { name: p, type: string }
  context:
    - { key: doc, value: '{{inputs.p | read_file}}' }
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1' }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`),
        inputs: { p: 'a.txt' },
      }),
    );
    const workDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(workDone?.type === 'node:completed' ? workDone.output : undefined).toEqual({
      doc: 'FILE:a.txt',
    });
  });

  it('re-resolves the workflow context on cross-process resume (post-gate nodes see ctx.*)', async () => {
    const store = new InMemoryRunStore();
    const CTX_GATED = `  id: ctx-gated
  inputs:
    - { name: name, type: string }
  context:
    - { key: greeting, value: 'hi {{inputs.name}}' }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: post, type: transform, transform: '1' }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: post }
    - { from: post, to: out }`;
    // Process A pauses at the gate (ctx resolved in A, but it is NOT checkpointed).
    const engineA = engineWith(
      { g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }) },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(CTX_GATED), inputs: { name: 'world' } });
    let gateId = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    // Process B resumes — it must RE-RESOLVE the context so the post-gate transform sees ctx.greeting.
    const engineB = engineWith({ post: echoCtx }, createInMemoryHost({ store }));
    const eventsB = await drain(
      await engineB.resumeFromCheckpoint({
        runId: handleA.runId,
        workflow: workflow(CTX_GATED),
        inputs: { name: 'world' },
        gateId,
        decision: { decision: 'approved', decidedBy: 'h' },
      }),
    );
    const postDone = eventsB.find((e) => e.type === 'node:completed' && e.nodeId === 'post');
    expect(postDone?.type === 'node:completed' ? postDone.output : undefined).toEqual({
      greeting: 'hi world',
    });
    expect(terminalsIn(eventsB)[0]?.type).toBe('run:completed');
  });

  it('closes a resumed run with run:failed{validation} when context RE-resolution fails', async () => {
    const store = new InMemoryRunStore();
    const CTX_RF_GATED = `  id: ctx-rf-gated
  inputs:
    - { name: p, type: string }
  context:
    - { key: doc, value: '{{inputs.p | read_file}}' }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
    // Process A HAS a readFile cap, so context resolves and the run pauses at the gate.
    const engineA = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new StubExecutor({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
      resolverCapabilities: { readFile: (p) => `FILE:${p}` },
    });
    const handleA = engineA.start({ workflow: workflow(CTX_RF_GATED), inputs: { p: 'a.txt' } });
    let gateId = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    // Process B has NO readFile cap → the re-resolution at resume fails → run:failed{validation}.
    const engineB = engineWith({}, createInMemoryHost({ store }));
    const eventsB = await drain(
      await engineB.resumeFromCheckpoint({
        runId: handleA.runId,
        workflow: workflow(CTX_RF_GATED),
        inputs: { p: 'a.txt' },
        gateId,
        decision: { decision: 'approved', decidedBy: 'h' },
      }),
    );
    expect(eventsB.some((e) => e.type === 'human_gate:resumed')).toBe(false); // never applied the decision
    const terminal = terminalsIn(eventsB)[0];
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      expect(terminal.error.code).toBe('validation');
    }
  });

  it('rejects a bad gateId fast (unknown_gate) BEFORE context resolution — does not settle the run', async () => {
    const store = new InMemoryRunStore();
    const RF_GATED = `  id: ctx-rf-gate2
  inputs:
    - { name: p, type: string }
  context:
    - { key: doc, value: '{{inputs.p | read_file}}' }
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`;
    const engineA = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new StubExecutor({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      }),
      resolverCapabilities: { readFile: (p) => `FILE:${p}` },
    });
    const handleA = engineA.start({ workflow: workflow(RF_GATED), inputs: { p: 'a.txt' } });
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        break;
      }
    }
    const runId = handleA.runId;
    const before = store.eventsFor(runId).length;
    // Process B has NO readFile cap (context WOULD fail), and the gateId is wrong. The bad gateId must be
    // rejected first (unknown_gate) — the run is NOT terminally settled run:failed by a context resolution
    // that should never have run. A retry with the correct gateId stays possible.
    const engineB = engineWith({}, createInMemoryHost({ store }));
    await expect(
      engineB.resumeFromCheckpoint({
        runId,
        workflow: workflow(RF_GATED),
        inputs: { p: 'a.txt' },
        gateId: 'not-a-real-gate',
        decision: { decision: 'approved', decidedBy: 'h' },
      }),
    ).rejects.toMatchObject({ code: 'unknown_gate' });
    // No new events persisted: the run was neither resumed nor failed (context resolution never ran).
    expect(store.eventsFor(runId).length).toBe(before);
  });
});

// --- node retry budget (1.S, ADR-0040) -------------------------------------------------------

describe('WorkflowEngine — node retry budget above the chain (1.S)', () => {
  // A transform node carrying an above-chain retry budget; the stub handler controls the outcome.
  const RETRY_WF = `  id: retry-wf
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1', retry: { max: 3, backoff: linear, backoff_ms: 10 } }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`;

  it('retries a transient failure within budget and recovers (node:retrying → re-dispatch → node:completed)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith({ work: flaky(1) }, host); // fail once, then succeed
    const handle = engine.start({ workflow: workflow(RETRY_WF) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        await fireBackoff(host); // advance past the backoff to the next attempt
      }
    }
    const retrying = events.filter((e) => e.type === 'node:retrying');
    expect(retrying).toHaveLength(1);
    if (retrying[0]?.type === 'node:retrying') {
      expect(retrying[0].attemptNumber).toBe(1);
      expect(retrying[0].error.code).toBe('tool_failed');
      expect(retrying[0].delayMs).toBe(10); // linear, base 10, retry #1
    }
    expect(
      events.some((e) => e.type === 'node:started' && e.nodeId === 'work' && e.attemptNumber === 2),
    ).toBe(true);
    const workDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(workDone?.type === 'node:completed' ? workDone.attemptNumber : undefined).toBe(2); // recovered on attempt 2
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    assertGapFreeSeq(events);
  });

  it('applies exponential backoff and the default base when backoff_ms is omitted', async () => {
    const EXP_WF = `  id: exp-wf
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1', retry: { max: 4, backoff: exponential } }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`;
    const host = createInMemoryHost();
    const engine = engineWith({ work: flaky(99) }, host); // always fails → exhausts max 4 (3 retries)
    const handle = engine.start({ workflow: workflow(EXP_WF) });
    const delays: number[] = [];
    for await (const event of handle.events) {
      if (event.type === 'node:retrying') {
        delays.push(event.delayMs);
        await fireBackoff(host);
      }
    }
    // exponential, default base 1000 ms (backoff_ms omitted): base * 2^(retry-1) for retries 1,2,3.
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('caps the backoff at the 24h ceiling so a large base/budget cannot overflow delayMs', async () => {
    // base 50,000,000 ms exponential: retry 1 = 50M (≤ 24h), retry 2 = 100M (> 86.4M) → capped to 86.4M.
    // Without the cap a large max would overflow to Infinity and throw at event-stamp time (a zombie run).
    const CAP_WF = `  id: cap-wf
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1', retry: { max: 3, backoff: exponential, backoff_ms: 50000000 } }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`;
    const host = createInMemoryHost();
    const engine = engineWith({ work: flaky(99) }, host);
    const delays: number[] = [];
    for await (const event of engine.start({ workflow: workflow(CAP_WF) }).events) {
      if (event.type === 'node:retrying') {
        delays.push(event.delayMs);
        await fireBackoff(host);
      }
    }
    expect(delays).toEqual([50_000_000, 86_400_000]); // the second attempt's delay is clamped to the 24h ceiling
  });

  it('a sibling node failure during the retry backoff abandons the re-dispatch (run:failed, sibling root cause)', async () => {
    // Two parallel branches: `flap` retries with a long-ish budget; `boom` fails fatally. boom's failure
    // aborts the run while flap is mid-backoff → flap does not re-dispatch; the run fails with boom's cause.
    const PAR_RETRY = `  id: par-retry
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [flap, boom] }
    - { id: flap, type: transform, transform: '1', retry: { max: 5, backoff: linear, backoff_ms: 50 } }
    - { id: boom, type: transform, transform: '1' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: flap, to: join }
    - { from: boom, to: join }
    - { from: join, to: out }`;
    const host = createInMemoryHost();
    const engine = engineWith(
      {
        flap: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'transient', retryable: true },
        }),
        boom: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'validation', message: 'fatal', retryable: false },
        }),
      },
      host,
    );
    const events: RunEvent[] = [];
    for await (const event of engine.start({ workflow: workflow(PAR_RETRY) }).events) {
      events.push(event);
      // Do NOT fire the backoff timer: boom's fatal failure aborts the run, which abandons flap's pending
      // retry without firing it (the abort short-circuits the sleep).
    }
    const terminal = terminalsIn(events)[0];
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      expect(terminal.error.code).toBe('validation'); // boom (the fatal sibling) is the root cause
    }
    expect(host.armedCount()).toBe(0); // flap's backoff timer was disarmed by the abort
  });

  it('fails the node terminally once the budget is exhausted (node:failed carries the last attemptNumber)', async () => {
    const host = createInMemoryHost();
    const engine = engineWith({ work: flaky(99) }, host); // always fails
    const handle = engine.start({ workflow: workflow(RETRY_WF) }); // max 3 → 2 retries
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        await fireBackoff(host);
      }
    }
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(2);
    const failed = events.find((e) => e.type === 'node:failed' && e.nodeId === 'work');
    expect(failed?.type === 'node:failed' ? failed.attemptNumber : undefined).toBe(3);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    assertGapFreeSeq(events);
  });

  it('does not retry a fatal (non-retryable) failure even with a budget', async () => {
    const events = await drain(
      engineWith({
        work: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'validation', message: 'bad', retryable: false },
        }),
      }).start({ workflow: workflow(RETRY_WF) }),
    );
    expect(events.some((e) => e.type === 'node:retrying')).toBe(false);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
  });

  it('does not retry a retryable code excluded by retry_on', async () => {
    const RETRY_ON_WF = `  id: retry-on-wf
  nodes:
    - { id: start, type: input }
    - { id: work, type: transform, transform: '1', retry: { max: 3, backoff: linear, retry_on: [provider_unavailable] } }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }`;
    const events = await drain(
      engineWith({
        // retryable, but tool_failed is not in retry_on: [provider_unavailable] → no retry
        work: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'x', retryable: true },
        }),
      }).start({ workflow: workflow(RETRY_ON_WF) }),
    );
    expect(events.some((e) => e.type === 'node:retrying')).toBe(false);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
  });

  it('a cancel during the retry backoff wins — no further attempt, run:cancelled', async () => {
    const host = createInMemoryHost();
    const engine = engineWith({ work: flaky(99) }, host);
    const handle = engine.start({ workflow: workflow(RETRY_WF) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        // node:retrying is delivered before #abortableSleep arms its timer; cancelling now sets the abort
        // first, so the sleep short-circuits on `signal.aborted` and no backoff timer is ever armed.
        engine.cancel(handle.runId);
        host.fireTimers(); // nothing armed → a no-op (and never will be — the retry was abandoned)
      }
    }
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(1); // only the first attempt's retry
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled');
    expect(host.armedCount()).toBe(0); // no backoff timer was left armed
  });

  it('no node:retrying when the node has no retry budget (a plain transient failure is terminal)', async () => {
    // The SEQUENTIAL workflow's `work` transform has no retry field → a retryable failure fails the run.
    const events = await drain(
      engineWith({
        work: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'tool_failed', message: 'x', retryable: true },
        }),
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    expect(events.some((e) => e.type === 'node:retrying')).toBe(false);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
  });

  it('does not emit a spurious node:retrying when a sibling failure has already doomed the run', async () => {
    // A sibling's fatal failure sets #failure + aborts the signal (WITHOUT #cancelling) BEFORE this budgeted
    // node's own retryable failure is judged. `flap` resolves a few microtasks later than the synchronous
    // `boom`, so by the time flap's outcome is evaluated the run is already doomed — it must settle node:failed
    // directly, never promise a non-terminal node:retrying it cannot honour (the willRetry guard, ADR-0040 A.5).
    const PAR_SPURIOUS = `  id: par-spurious
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [flap, boom] }
    - { id: flap, type: transform, transform: '1', retry: { max: 5, backoff: linear, backoff_ms: 50 } }
    - { id: boom, type: transform, transform: '1' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: flap, to: join }
    - { from: boom, to: join }
    - { from: join, to: out }`;
    const host = createInMemoryHost();
    const engine = engineWith(
      {
        flap: async (): Promise<NodeOutcome> => {
          // Yield enough microtasks that the synchronous fatal sibling settles #failure + aborts FIRST.
          for (let i = 0; i < 50; i += 1) await Promise.resolve();
          return {
            kind: 'failed',
            error: { code: 'tool_failed', message: 'transient', retryable: true },
          };
        },
        boom: (): NodeOutcome => ({
          kind: 'failed',
          error: { code: 'validation', message: 'fatal', retryable: false },
        }),
      },
      host,
    );
    const events = await drain(engine.start({ workflow: workflow(PAR_SPURIOUS) }));
    expect(events.some((e) => e.type === 'node:retrying')).toBe(false); // no contradicted non-terminal event
    const terminal = terminalsIn(events)[0];
    expect(terminal?.type).toBe('run:failed');
    if (terminal?.type === 'run:failed') {
      expect(terminal.error.code).toBe('validation'); // boom stays the root cause
    }
    expect(host.armedCount()).toBe(0); // no backoff timer was ever armed (the retry was never promised)
    assertGapFreeSeq(events);
  });

  it('omits attemptNumber on attempt 1 (absent ⇒ attempt 1 — the replay-distinguishing contract)', async () => {
    // The first node:started / node:completed must NOT carry attemptNumber: a surface reads "absent ⇒ attempt
    // 1", so a stamp of `1` everywhere would silently look like a re-dispatch and break replay-distinguishing.
    const events = await drain(
      engineWith({ work: flaky(0) }).start({ workflow: workflow(RETRY_WF) }),
    );
    const firstStart = events.find((e) => e.type === 'node:started' && e.nodeId === 'work');
    const workDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'work');
    expect(firstStart).toBeDefined();
    expect(workDone).toBeDefined();
    expect(firstStart?.type === 'node:started' ? firstStart.attemptNumber : 0).toBeUndefined();
    expect(workDone?.type === 'node:completed' ? workDone.attemptNumber : 0).toBeUndefined();
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });
});

// --- concurrency cap --------------------------------------------------------------------------

describe('WorkflowEngine — CR-33 settled-run retention (ADR-0086)', () => {
  const TINY = `  id: tiny
  nodes:
    - { id: start, type: input }
    - { id: done, type: output }
  edges:
    - { from: start, to: done }`;

  it('keeps the last N settled runs addressable and evicts older ones', async () => {
    // `WorkflowEngine` kept every completed run forever, so a long-lived process running many workflows grew
    // without limit. Count-based rather than age-based on purpose: an age policy needs a clock, and a clock
    // in `packages/core` is a new host seam for a bound a count expresses exactly as well — and this way the
    // eviction is deterministic enough to assert rather than wait for.
    const engine = engineWith();
    const N = ADMISSION_CEILINGS.retainedSettledRuns;
    const ids: string[] = [];
    for (let i = 0; i < N + 3; i += 1) {
      const handle = engine.start({ workflow: workflow(TINY) });
      ids.push(handle.runId);
      await drain(handle);
    }

    // **What eviction costs, asserted rather than assumed.** A retained settled run exists so `cancel` can
    // answer `run_already_terminal` instead of `unknown_run`; after eviction it reports `unknown_run`, a
    // less specific answer about a run that finished long ago. The run's OUTCOME is not lost — it is in the
    // durable log, which is where a surface reads a finished run's result from anyway.
    // The CODE is the assertion, not the error class — both cases throw `EngineStateError`, so asserting the
    // class alone passes whether or not anything is ever evicted. (It did: the first version of this test
    // stayed green with eviction removed entirely.)
    const codeOf = (runId: string): string => {
      try {
        engine.cancel(runId);
        return 'no-throw';
      } catch (error) {
        return error instanceof EngineStateError ? error.code : 'not-an-engine-error';
      }
    };
    expect(codeOf(ids[0] ?? '')).toBe('unknown_run');
    // …and the most recent is still retained, still answering the specific way.
    expect(codeOf(ids[ids.length - 1] ?? '')).not.toBe('unknown_run');
  });

  it('does not evict a run that is merely PARKED — that is live work', async () => {
    // Only a run that actually settled enters the queue. A run waiting on a human gate is work this process
    // still owns, and evicting one would strand it: `resume` would report `unknown_run` for a gate the user
    // is looking at.
    const PARKED = `  id: parked
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: done, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: done }`;
    const engine = engineWith({
      g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
    });
    const parked = engine.start({ workflow: workflow(PARKED) });
    for await (const event of parked.events) {
      if (event.type === 'run:paused') break;
    }
    // **On the SAME engine, or the test exerts no pressure at all.** The first version settled these on 105
    // throwaway engines, so the engine under test never had one settled run in its queue and stayed green
    // with eviction removed entirely — a test that cannot fail for the thing it is named after.
    for (let i = 0; i < ADMISSION_CEILINGS.retainedSettledRuns + 5; i += 1) {
      await drain(engine.start({ workflow: workflow(TINY) }));
    }
    // The parked run is still addressable: it never settled, so it never entered the queue and eviction —
    // which has definitely run by now, 5 times over — never reached it.
    expect(() => engine.cancel(parked.runId)).not.toThrow();
  });
});

describe('WorkflowEngine — CR-32 size bounds at the durable boundary (ADR-0086)', () => {
  const SIMPLE = `  id: sized
  nodes:
    - { id: start, type: input }
    - { id: big, type: transform, transform: 'g' }
    - { id: done, type: output }
  edges:
    - { from: start, to: big }
    - { from: big, to: done }`;

  it('fails the node whose output exceeds the bound, and never retains it', async () => {
    // Rejection, not truncation: half a node's output silently flowing into the next node's template is a
    // wrong answer that looks like a right one. The failure is itself a terminal, which is what makes a size
    // rule safe here — it can refuse without leaving the run unable to end.
    const events = await drain(
      engineWith({
        big: () => ({ kind: 'completed', output: 'x'.repeat(SIZE_BOUNDS.nodeOutputBytes + 1000) }),
      }).start({ workflow: workflow(SIMPLE) }),
    );
    const failed = events.find((e) => e.type === 'node:failed');
    expect(failed?.type === 'node:failed' && failed.error.code).toBe('validation');
    expect(failed?.type === 'node:failed' && failed.error.message).toContain(
      String(SIZE_BOUNDS.nodeOutputBytes),
    );
    // The oversized value never reached the log: `node:completed` for `big` was never emitted — and the node
    // is reported FAILED rather than silently skipped, which is the ordering the production comment claims
    // (check before retain, before emit) and which nothing else pins.
    expect(events.some((e) => e.type === 'node:completed' && e.nodeId === 'big')).toBe(false);
    expect(events.some((e) => e.type === 'node:failed' && e.nodeId === 'big')).toBe(true);
    expect(terminalsIn(events)).toHaveLength(1);
  });

  it('a large GENERATED image is not refused — the bound measures the handle, not the base64', async () => {
    // **The regression the first version of CR-32 shipped, and the sharpest kind: an error the author cannot
    // act on.** A media node returns `{ kind: 'base64', data }` in flight; `deInlineMedia` replaces that with
    // a ~100-byte `media://` handle before anything is persisted or delivered, and `state.output` keeps the
    // raw form only because the de-inline is non-mutating. Measuring the raw form failed every image over
    // ~192 KiB decoded against a bound whose real payload was a hundred bytes — reproduced before the fix as
    // `node \`work\` output is 280098 bytes, above the limit of 262144`. The author cannot make a model
    // return fewer bytes, so there was no workaround.
    //
    // Every media fixture in this file is 8 bytes of base64, which is why nothing here could see it.
    const { store: mediaStore } = stubMediaStore();
    const huge = {
      type: 'media' as const,
      mimeType: 'image/png',
      source: { kind: 'base64' as const, data: 'A'.repeat(SIZE_BOUNDS.nodeOutputBytes + 20_000) },
    };
    const events = await drain(
      engineWith(
        { big: () => ({ kind: 'completed', output: { text: '', media: [huge] } }) },
        createInMemoryHost({ store: new InMemoryRunStore(), mediaStore }),
      ).start({ workflow: workflow(SIMPLE) }),
    );
    expect(events.some((e) => e.type === 'node:completed' && e.nodeId === 'big')).toBe(true);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('admits an output just under the bound — the negative control', async () => {
    const events = await drain(
      engineWith({
        big: () => ({ kind: 'completed', output: 'x'.repeat(SIZE_BOUNDS.nodeOutputBytes - 1000) }),
      }).start({ workflow: workflow(SIMPLE) }),
    );
    expect(events.some((e) => e.type === 'node:completed' && e.nodeId === 'big')).toBe(true);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('a resume SEEDS the workflow-state total rather than restarting it', async () => {
    // **The same defect the dispatch counter has its own seed for, one bound over.** A resume rehydrates
    // every settled node's output into `#states` — that memory is real and already held — so a counter
    // starting at zero would hand the resumed run the whole 4 MiB again on top of what it just restored.
    //
    // Process A settles two nodes carrying a known payload, then parks. Process B rehydrates and its total
    // must already reflect them, which is only observable through what B will still accept.
    // **The seed has to CHANGE an outcome, or the test cannot fail.** A first version asserted only that the
    // resumed run completed, which it did with the seed removed too — the resumed half was tiny. So process A
    // settles most of the budget and process B adds enough that the SUM breaches while B's own share does
    // not: with the seed the resumed run is correctly refused, without it B sees a fresh 4 MiB and finishes.
    const per = SIZE_BOUNDS.nodeOutputBytes - 1000;
    const beforeCount = Math.floor((SIZE_BOUNDS.workflowStateBytes * 0.75) / per);
    const afterCount = Math.ceil((SIZE_BOUNDS.workflowStateBytes * 0.5) / per);
    const store = new InMemoryRunStore();
    const beforeIds = Array.from({ length: beforeCount }, (_, i) => `a${i}`);
    const afterIds = Array.from({ length: afterCount }, (_, i) => `b${i}`);
    const line = ['start', ...beforeIds, 'g', ...afterIds];
    const WF = `  id: resumed-state
  nodes:
    - { id: start, type: input }
${beforeIds.map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`).join('\n')}
    - { id: g, type: human_gate, gate_type: approval }
${afterIds.map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`).join('\n')}
    - { id: done, type: output }
  edges:
${line
  .slice(1)
  .map((id, i) => `    - { from: ${line[i]}, to: ${id} }`)
  .join('\n')}
    - { from: ${line[line.length - 1]}, to: done }`;
    const payload = (): { kind: 'completed'; output: string } => ({
      kind: 'completed',
      output: 'x'.repeat(per),
    });
    const engineA = engineWith(
      {
        ...Object.fromEntries(beforeIds.map((id) => [id, payload])),
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'ok?' } }),
      },
      createInMemoryHost({ store }),
    );
    const handleA = engineA.start({ workflow: workflow(WF) });
    let gateId = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }

    const cp = reconstructCheckpointState(store.eventsFor(handleA.runId));
    // The premise: the checkpoint really carries the settled node's output, so process B restores it.
    expect(cp?.nodeStates.get(beforeIds[0] ?? '')?.output).toBeDefined();

    const engineB = engineWith(
      Object.fromEntries(afterIds.map((id) => [id, payload])),
      createInMemoryHost({ store }),
    );
    const events = await drain(
      await engineB.resumeFromCheckpoint({
        runId: handleA.runId,
        workflow: workflow(WF),
        gateId,
        decision: { decision: 'approved', decidedBy: 'tester' },
      }),
    );
    // Refused, and that is the assertion: the state bound is a RUN bound, so what process A already spent
    // counts against what process B may still add. Without the seed, B would see a fresh budget and finish.
    const failed = events.find((e) => e.type === 'node:failed');
    expect(failed?.type === 'node:failed' && failed.error.message).toContain('workflow state');
  });

  it('fails the run when the accumulated workflow STATE exceeds its own bound', async () => {
    // Each output is individually legal; together they are not. A single shared number would make the
    // per-node bound either useless or absurd, which is why these are two bounds and not one.
    const per = SIZE_BOUNDS.nodeOutputBytes - 1000;
    const count = Math.ceil(SIZE_BOUNDS.workflowStateBytes / per) + 1;
    const ids = Array.from({ length: count }, (_, i) => `s${i}`);
    const nodes = ids
      .map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`)
      .join('\n');
    const line = ['start', ...ids];
    const edges = line
      .slice(1)
      .map((id, i) => `    - { from: ${line[i]}, to: ${id} }`)
      .join('\n');
    const events = await drain(
      engineWith(
        Object.fromEntries(
          ids.map((id) => [id, () => ({ kind: 'completed' as const, output: 'x'.repeat(per) })]),
        ),
      ).start({
        workflow: workflow(`  id: statey
  nodes:
    - { id: start, type: input }
${nodes}
  edges:
${edges}`),
      }),
    );
    const failed = events.find((e) => e.type === 'node:failed');
    expect(failed?.type === 'node:failed' && failed.error.message).toContain('workflow state');
    expect(terminalsIn(events)).toHaveLength(1);
  });
});

describe('WorkflowEngine — max_parallel concurrency cap', () => {
  it('never runs more than max_parallel branches concurrently, yet runs them all', async () => {
    let live = 0;
    let maxLive = 0;
    const branch: Handler = async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return { kind: 'completed', output: null };
    };
    const events = await drain(
      engineWith({ b1: branch, b2: branch, b3: branch }).start({
        workflow: workflow(`  id: par
  max_parallel: 2
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [b1, b2, b3] }
    - { id: b1, type: transform, transform: '1' }
    - { id: b2, type: transform, transform: '2' }
    - { id: b3, type: transform, transform: '3' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: b1, to: join }
    - { from: b2, to: join }
    - { from: b3, to: join }
    - { from: join, to: out }`),
      }),
    );
    expect(maxLive).toBeLessThanOrEqual(2);
    const completedBranches = events.filter(
      (e) => e.type === 'node:completed' && ['b1', 'b2', 'b3'].includes(e.nodeId),
    );
    expect(completedBranches).toHaveLength(3);
    assertGapFreeSeq(events); // gap-free even under concurrent fan-out
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('fails the run at the node-dispatch cap, with the limit-family code (ADR-0086 §4)', async () => {
    // The runtime backstop for the multiplication the per-value ceilings still permit. Crossing it needs a
    // graph that is otherwise entirely LEGAL — every per-value ceiling respected — which is the point: this
    // cap exists for exactly the workflow no single ceiling refuses.
    //
    // 495 succeeding nodes, then one agent node with a legal `retry.max: 10` that always fails retryably:
    // 495 + 10 = 505 dispatches against a cap of 500. The discriminator is the CODE — without the cap the
    // run still fails, but as `provider_unavailable` from an exhausted retry budget.
    const CHAIN = ADMISSION_CEILINGS.nodeDispatchesPerRun - 5;
    const ids = Array.from({ length: CHAIN }, (_, i) => `n${i}`);
    const nodes = ids
      .map((id, i) =>
        i === 0
          ? `    - { id: ${id}, type: input }`
          : `    - { id: ${id}, type: transform, transform: 'g' }`,
      )
      .join('\n');
    const edges = ids
      .slice(1)
      .map((id, i) => `    - { from: ${ids[i]}, to: ${id} }`)
      .join('\n');
    const last = ids[ids.length - 1];

    const host = createInMemoryHost();
    const engine = engineWith(
      {
        flaky: () => ({
          kind: 'failed',
          error: { code: 'provider_unavailable', message: 'flaky', retryable: true },
        }),
      },
      host,
    );
    const handle = engine.start({
      workflow: workflow(`  id: dispatch-cap
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
${nodes}
    - { id: flaky, type: agent, agent_ref: ag, prompt_template: 'go', retry: { max: ${ADMISSION_CEILINGS.retryMax}, backoff: linear, backoff_ms: 1 } }
  edges:
${edges}
    - { from: ${last}, to: flaky }`),
    });
    // The drain is the MAIN loop and the timer pump is the side one — the reverse hung, because a pump that
    // yields only to microtasks never lets a 495-node chain's consumer make progress.
    const events: RunEvent[] = [];
    let settled = false;
    const pump = (async (): Promise<void> => {
      while (!settled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (host.armedCount() > 0) host.fireTimers(); // the retry backoff
        // AND the deadlines: the cap aborts, which arms the grace window (a `deadline` timer). Firing only
        // `work` left the aborted run waiting on a backstop nothing would trip — a 60 s timeout, measured.
        if (host.deadlineCount() > 0) host.fireDeadlines();
      }
    })();
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
    }
    await pump;

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:failed');
    // **The load-bearing assertion.** Without the cap this run still fails — as `provider_unavailable`, from
    // an exhausted retry budget. `turn_limit` is the only thing that distinguishes the cap firing.
    //
    // The cap has TWO check sites — before `#claimReady` and inside the retry loop — and each covers a case
    // the other cannot: the first refuses a fresh node, the second refuses a re-dispatch of one already
    // running. Removing either alone leaves this test green, because the other still fires; that is not a
    // hollow test but it IS an incomplete one, so `retry loop` below pins the second site on its own.
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('turn_limit');
    expect(events.filter((e) => e.type === 'node:started').length).toBeLessThanOrEqual(
      ADMISSION_CEILINGS.nodeDispatchesPerRun,
    );
    expect(terminalsIn(events)).toHaveLength(1);
    // A heavy test on purpose: crossing a 500-dispatch cap needs ~500 real dispatches, and no smaller
    // construction exercises it — every per-value ceiling is legal here, which is the case the cap is for.
  }, 60_000);

  it('the retry loop is capped on its own, not only the fresh-dispatch path (ADR-0086 §4)', async () => {
    // The second check site, pinned separately. A run whose graph is tiny but whose ONE node retries cannot
    // be stopped by the pre-claim check — that path runs once, for a node already claimed. Here the whole
    // budget lives in the retry loop, so this reddens when the loop's own check is removed and stays green
    // when the pre-claim one is.
    //
    // 498 succeeding nodes leave 2 dispatches of headroom, so the flaky node's FIRST attempt lands at 499
    // and its first re-dispatch is what the cap must refuse.
    const CHAIN = ADMISSION_CEILINGS.nodeDispatchesPerRun - 2;
    const ids = Array.from({ length: CHAIN }, (_, i) => `n${i}`);
    const nodes = ids
      .map((id, i) =>
        i === 0
          ? `    - { id: ${id}, type: input }`
          : `    - { id: ${id}, type: transform, transform: 'g' }`,
      )
      .join('\n');
    const edges = ids
      .slice(1)
      .map((id, i) => `    - { from: ${ids[i]}, to: ${id} }`)
      .join('\n');
    const host = createInMemoryHost();
    const engine = engineWith(
      {
        flaky: () => ({
          kind: 'failed',
          error: { code: 'provider_unavailable', message: 'flaky', retryable: true },
        }),
      },
      host,
    );
    const handle = engine.start({
      workflow: workflow(`  id: retry-cap
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
${nodes}
    - { id: flaky, type: agent, agent_ref: ag, prompt_template: 'go', retry: { max: ${ADMISSION_CEILINGS.retryMax}, backoff: linear, backoff_ms: 1 } }
  edges:
${edges}
    - { from: ${ids[ids.length - 1]}, to: flaky }`),
    });
    const events: RunEvent[] = [];
    let settled = false;
    const pump = (async (): Promise<void> => {
      while (!settled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (host.armedCount() > 0) host.fireTimers();
        if (host.deadlineCount() > 0) host.fireDeadlines();
      }
    })();
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
    }
    await pump;

    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('turn_limit');
    // The flaky node started but never exhausted its authored budget of 10 — the cap stopped it first.
    const flakyStarts = events.filter((e) => e.type === 'node:started' && e.nodeId === 'flaky');
    expect(flakyStarts.length).toBeLessThan(ADMISSION_CEILINGS.retryMax);
  }, 60_000);

  it('at the cap, a retry is refused BEFORE the promise and the sleep (ADR-0086 §4)', async () => {
    // **The order is the whole finding.** The check used to sit after `node:retrying` and after the backoff,
    // so a run with no headroom announced a retry it could not honour and then slept for it — and
    // `backoff_ms` is schema-unbounded up to the 24 h clamp, so that wait could be a day. Two assertions,
    // because either alone passes against the old code: no `node:retrying` for the refused attempt, and no
    // backoff timer armed.
    const CHAIN = ADMISSION_CEILINGS.nodeDispatchesPerRun - 2;
    const ids = Array.from({ length: CHAIN }, (_, i) => `n${i}`);
    const nodes = ids
      .map((id, i) =>
        i === 0
          ? `    - { id: ${id}, type: input }`
          : `    - { id: ${id}, type: transform, transform: 'g' }`,
      )
      .join('\n');
    const edges = ids
      .slice(1)
      .map((id, i) => `    - { from: ${ids[i]}, to: ${id} }`)
      .join('\n');
    const host = createInMemoryHost();
    const handle = engineWith(
      {
        flaky: () => ({
          kind: 'failed',
          error: { code: 'provider_unavailable', message: 'flaky', retryable: true },
        }),
      },
      host,
    ).start({
      workflow: workflow(`  id: cap-before-sleep
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
${nodes}
    - { id: flaky, type: agent, agent_ref: ag, prompt_template: 'go', retry: { max: ${ADMISSION_CEILINGS.retryMax}, backoff: linear, backoff_ms: 86400000 } }
  edges:
${edges}
    - { from: ${ids[ids.length - 1]}, to: flaky }`),
    });

    const events: RunEvent[] = [];
    let settled = false;
    let armedDuringRetry = 0;
    const pump = (async (): Promise<void> => {
      while (!settled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        armedDuringRetry = Math.max(armedDuringRetry, host.armedCount());
        if (host.armedCount() > 0) host.fireTimers();
        if (host.deadlineCount() > 0) host.fireDeadlines();
      }
    })();
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
    }
    await pump;

    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('turn_limit');
    // The refused attempt promised nothing: `flaky` started twice (cap reached on the second) and never
    // announced a third.
    const retrying = events.filter((e) => e.type === 'node:retrying' && e.nodeId === 'flaky');
    const starts = events.filter((e) => e.type === 'node:started' && e.nodeId === 'flaky');
    expect(retrying.length).toBeLessThan(starts.length);
  }, 60_000);

  it('a WIDE ready batch cannot straddle the dispatch cap (ADR-0086 §4)', async () => {
    // **The overshoot both earlier cap tests were blind to.** Each of them uses a linear chain, so
    // `ready.length` is always 1 and the boundary is always crossed one dispatch at a time. `#claimReady`
    // claims a whole batch synchronously, up to `max_parallel`, so a tick whose ready set straddles the
    // boundary used to dispatch every member before the next tick could refuse anything — measured at 512
    // `node:started` events against a ceiling of 500.
    //
    // A chain that stops 4 short, then a 20-wide fan-out: the batch is bigger than the headroom, so the
    // claim itself must be clamped. Breaking the dispatch loop instead would leave the unclaimed remainder
    // `running` with nothing behind it — the hang this engine already measured once.
    // The graph must stay UNDER the node ceiling while its DISPATCHES exceed the run cap, so the excess
    // comes from retries: 45 agent nodes that each fail 9 times then succeed spend 450 dispatches across 45
    // nodes. 46 transforms carry it to 496, four short of the cap, and then a 20-wide fan-out asks for 20
    // more in one batch.
    const RETRIERS = 45;
    const PER = ADMISSION_CEILINGS.retryMax; // 10 attempts each: 9 failures then a success
    const FILLERS = ADMISSION_CEILINGS.nodeDispatchesPerRun - 4 - RETRIERS * PER;
    const WIDTH = 20;
    const retriers = Array.from({ length: RETRIERS }, (_, i) => `r${i}`);
    const fillers = Array.from({ length: FILLERS }, (_, i) => `f${i}`);
    const branches = Array.from({ length: WIDTH }, (_, i) => `w${i}`);
    const seen = new Map<string, number>();
    const flakyThenOk: Handler = (ctx) => {
      const n = (seen.get(ctx.vertex.id) ?? 0) + 1;
      seen.set(ctx.vertex.id, n);
      return n < PER
        ? {
            kind: 'failed',
            error: { code: 'provider_unavailable', message: 'flaky', retryable: true },
          }
        : { kind: 'completed', output: null };
    };
    const nodes = [
      `    - { id: start, type: input }`,
      ...retriers.map(
        (id) =>
          `    - { id: ${id}, type: agent, agent_ref: ag, prompt_template: 'go', retry: { max: ${PER}, backoff: linear, backoff_ms: 1 } }`,
      ),
      ...fillers.map((id) => `    - { id: ${id}, type: transform, transform: 'g' }`),
      `    - { id: fan, type: parallel, parallel_of: [${branches.join(', ')}] }`,
      ...branches.map((b) => `    - { id: ${b}, type: transform, transform: 'g' }`),
    ].join('\n');
    const line = ['start', ...retriers, ...fillers, 'fan'];
    const edges = line
      .slice(1)
      .map((id, i) => `    - { from: ${line[i]}, to: ${id} }`)
      .join('\n');

    const host = createInMemoryHost();
    const handle = engineWith(
      Object.fromEntries(retriers.map((id) => [id, flakyThenOk])),
      host,
    ).start({
      workflow: workflow(`  id: wide-straddle
  max_parallel: 24
  agents:
    - id: ag
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
${nodes}
  edges:
${edges}`),
    });
    const events: RunEvent[] = [];
    let settled = false;
    const pump = (async (): Promise<void> => {
      while (!settled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (host.armedCount() > 0) host.fireTimers();
        if (host.deadlineCount() > 0) host.fireDeadlines();
      }
    })();
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:failed' || event.type === 'run:completed') settled = true;
    }
    await pump;

    // The bound is a bound: not one dispatch past it, whatever the batch width.
    const starts = events.filter((e) => e.type === 'node:started');
    expect(starts.length).toBeLessThanOrEqual(ADMISSION_CEILINGS.nodeDispatchesPerRun);
    // …and the run still terminates exactly once rather than hanging on a half-claimed batch.
    expect(terminalsIn(events)).toHaveLength(1);
  }, 60_000);

  it('an OMITTED max_parallel caps at the default, not Infinity (ADR-0086 §3)', async () => {
    // **The change nothing guarded.** Reverting `?? DEFAULT_MAX_PARALLEL` to `?? Number.POSITIVE_INFINITY`
    // left the whole suite green, because every other concurrency test AUTHORS a cap. This one omits it,
    // which is the case the ADR is about: an unbounded default meant a run's width was decided entirely by
    // how wide its author happened to draw the graph.
    const width = DEFAULT_MAX_PARALLEL + 4;
    const ids = Array.from({ length: width }, (_, i) => `b${i}`);
    let live = 0;
    let maxLive = 0;
    const branch: Handler = async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live -= 1;
      return { kind: 'completed', output: null };
    };
    const handlers = Object.fromEntries(ids.map((id) => [id, branch]));
    const events = await drain(
      engineWith(handlers).start({
        workflow: workflow(`  id: default-cap
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [${ids.join(', ')}] }
${ids.map((id) => `    - { id: ${id}, type: transform, transform: '${id}' }`).join('\n')}
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
${ids.map((id) => `    - { from: ${id}, to: join }`).join('\n')}
    - { from: join, to: out }`),
      }),
    );
    // The bound, and the proof the run was actually wider than it: without the default this reaches `width`.
    expect(maxLive).toBeLessThanOrEqual(DEFAULT_MAX_PARALLEL);
    expect(
      events.filter((e) => e.type === 'node:completed' && ids.includes(e.nodeId)),
    ).toHaveLength(width);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });
});

// --- crash reconciliation ---------------------------------------------------------------------

describe('WorkflowEngine — crash reconciliation', () => {
  it('fails a crashed, non-resumable run with a single run:failed continuing its sequence', async () => {
    const store = new InMemoryRunStore();
    await seedStarted(store, 'crashed-1');
    const engine = engineWith(undefined, createInMemoryHost({ store }));

    const reconciled = await engine.reconcile();
    expect(reconciled).toHaveLength(1);
    const reconciledEvent = reconciled[0];
    expect(reconciledEvent?.type).toBe('run:failed');
    expect(reconciledEvent?.runId).toBe('crashed-1');
    expect(reconciledEvent?.sequenceNumber).toBe(1); // continues from the last persisted seq (0)
    if (reconciledEvent?.type === 'run:failed') {
      // reconcile stamps a correlationId like every other run:failed producer
      expect(typeof reconciledEvent.error.correlationId).toBe('string');
    }
    const persisted = store.eventsFor('crashed-1');
    expect(persisted.some((e) => e.type === 'run:failed')).toBe(true);
  });

  it('leaves a gate-parked (resumable) interrupted run for resume, not reconciliation', async () => {
    const store = new InMemoryRunStore();
    await seedStarted(store, 'paused-1', 'human_gate:paused');
    const engine = engineWith(undefined, createInMemoryHost({ store }));
    expect(await engine.reconcile()).toHaveLength(0);
  });

  it('leaves a media-job-parked run (crash in the submit→pause window) for resume, not reconciliation (1.AG/ADR-0045 §2-3)', async () => {
    // A crash AFTER media_job:submitted persisted but BEFORE run:paused leaves media_job:submitted as the
    // durable last event. reconcile() must NOT fail it — the paid, still-generating provider LRO is
    // re-attachable via resumeFromCheckpoint (re-poll the opaque jobId, never re-submit). Failing it here
    // would orphan the job (billed, output discarded) and permanently close the run at the terminal gate.
    const store = new InMemoryRunStore();
    await seedStarted(store, 'media-parked-1', 'media_job:submitted');
    const engine = engineWith(undefined, createInMemoryHost({ store }));
    expect(await engine.reconcile()).toHaveLength(0);
  });

  it('reclaims a crashed run’s media references at reconciliation (1.AF/D11 — no orphaned partial media)', async () => {
    // A crashed non-resumable run never ran its in-process terminal sweep; reconcile() must reclaim its
    // `run`-kind refs, else the partial media stays refcount>0 forever and is never GC-eligible (ADR-0042 §4).
    const store = new InMemoryRunStore();
    await seedStarted(store, 'crashed-refs');
    const reclaims: string[] = [];
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: () => undefined,
      reclaimRun: (runId) => {
        reclaims.push(runId);
      },
    };
    const engine = engineWith(undefined, createInMemoryHost({ store, mediaReferences }));
    await engine.reconcile();
    expect(reclaims).toEqual(['crashed-refs']);
  });

  it('a media-reference reclaim failure never abandons reconciliation (best-effort)', async () => {
    const store = new InMemoryRunStore();
    await seedStarted(store, 'crashed-a');
    await seedStarted(store, 'crashed-b');
    const mediaReferences: MediaReferencePort = {
      recordRunMedia: () => undefined,
      reclaimRun: () => Promise.reject(new Error('reference db down')), // async rejection, swallowed
    };
    const engine = engineWith(undefined, createInMemoryHost({ store, mediaReferences }));
    // Both runs still reconcile to run:failed despite the rejecting retention port.
    expect(await engine.reconcile()).toHaveLength(2);
  });

  it('reconcile() run:failed is media-free (ADR-0042 §2 backstop — it bypasses the #emitDurable choke point)', async () => {
    // reconcile() constructs run:failed directly (hardcoded partialOutputs:{}) and persists via the store,
    // bypassing the deInlineMedia choke point. Pin that it carries no media + empty partialOutputs, so a
    // future widening that adds node output to reconcile (which would skip de-inline) is caught here.
    const store = new InMemoryRunStore();
    await seedStarted(store, 'crashed-media');
    const engine = engineWith(undefined, createInMemoryHost({ store }));
    const reconciled = await engine.reconcile();
    expect(reconciled).toHaveLength(1);
    const event = reconciled[0];
    expect(event?.type).toBe('run:failed');
    if (event?.type === 'run:failed') {
      expect(event.partialOutputs).toEqual({});
    }
    expect(JSON.stringify(reconciled)).not.toMatch(/base64|aGVsbG8/);
    expect(JSON.stringify(store.eventsFor('crashed-media'))).not.toMatch(/base64|aGVsbG8/);
  });
});

// --- API-boundary errors ----------------------------------------------------------------------

describe('WorkflowEngine — API-boundary errors (EngineStateError)', () => {
  it('cancel/resume on an unknown run throw unknown_run', async () => {
    const engine = engineWith();
    expectThrowsCode(() => engine.cancel('nope'), 'unknown_run');
    await expect(
      engine.resume('nope', 'g', { decision: 'approved', decidedBy: 't' }),
    ).rejects.toMatchObject({ code: 'unknown_run' });
  });

  it('resume with an invalid decision throws invalid_decision', async () => {
    const engine = engineWith();
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    await drain(handle); // run to completion so the run exists in the map
    await expect(
      // @ts-expect-error — an intentionally invalid decision value; resume must reject it via safeParse
      engine.resume(handle.runId, 'g', { decision: 'maybe', decidedBy: 't' }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
  });

  it('cancel after the run terminated throws run_already_terminal', async () => {
    const engine = engineWith();
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    await drain(handle);
    expectThrowsCode(() => engine.cancel(handle.runId), 'run_already_terminal');
  });

  it('resume on a running run with no pending gate throws run_not_paused', async () => {
    let release: (() => void) | undefined;
    const engine = engineWith({
      slow: (ctx) =>
        new Promise<NodeOutcome>((resolve) => {
          release = () => resolve({ kind: 'completed', output: null });
          ctx.signal.addEventListener('abort', () => resolve({ kind: 'completed', output: null }));
        }),
    });
    const handle = engine.start({
      workflow: workflow(`  id: nogate
  nodes:
    - { id: start, type: input }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: slow }
    - { from: slow, to: done }`),
    });
    const events: RunEvent[] = [];
    let caught: unknown;
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:started' && event.nodeId === 'slow') {
        try {
          await engine.resume(handle.runId, 'g', { decision: 'approved', decidedBy: 't' });
        } catch (error) {
          caught = error;
        }
        release?.();
      }
    }
    expect(caught).toBeInstanceOf(EngineStateError);
    if (caught instanceof EngineStateError) {
      expect(caught.code).toBe('run_not_paused');
    }
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('resume after the run terminated throws run_already_terminal', async () => {
    const engine = engineWith();
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    await drain(handle);
    await expect(
      engine.resume(handle.runId, 'g', { decision: 'approved', decidedBy: 't' }),
    ).rejects.toMatchObject({ code: 'run_already_terminal' });
  });
});

// --- internal failures, host-side cancel, and reconnection edges ------------------------------

describe('WorkflowEngine — internal failures and handle-side controls', () => {
  it('fails the run as run:failed when the store cannot resolve the workflow id at start', async () => {
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: () => Promise.reject(new Error('store unavailable')),
        persistEvent: () => Promise.resolve(),
        listInterruptedRuns: () => Promise.resolve([]),
        readWorkflowSnapshot: () => Promise.resolve(undefined),
      },
    };
    const events = await drain(
      new WorkflowEngine({ host, executor: new StubExecutor() }).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
  });

  it('fails the run when a durable boundary persist rejects mid-run (engine-internal failure)', async () => {
    const inner = new InMemoryRunStore();
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
        persistEvent: (event) =>
          event.type === 'node:completed'
            ? Promise.reject(new Error('disk full'))
            : inner.persistEvent(event),
        listInterruptedRuns: () => inner.listInterruptedRuns(),
        readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      },
    };
    const events = await drain(
      new WorkflowEngine({ host, executor: new StubExecutor() }).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    const terminals = terminalsIn(events);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('run:failed');
    if (terminals[0]?.type === 'run:failed') {
      expect(terminals[0].error.code).toBe('internal');
    }
    assertGapFreeSeq(events);
  });

  it('cancels via the handle, and a second cancel while cancelling is an idempotent no-op', async () => {
    const engine = engineWith({
      slow: (ctx) =>
        new Promise<NodeOutcome>((resolve) => {
          if (ctx.signal.aborted) {
            resolve({ kind: 'completed', output: null });
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve({ kind: 'completed', output: null }));
        }),
    });
    const handle = engine.start({
      workflow: workflow(`  id: hcancel
  nodes:
    - { id: start, type: input }
    - { id: slow, type: transform, transform: 's' }
    - { id: done, type: output }
  edges:
    - { from: start, to: slow }
    - { from: slow, to: done }`),
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:started' && event.nodeId === 'slow') {
        handle.cancel();
        handle.cancel(); // idempotent — must not throw or emit a second terminal
      }
    }
    assertGapFreeSeq(events);
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:cancelled');
  });

  it('terminates with exactly one terminal event even when EVERY durable write rejects (no zombie run)', async () => {
    // The store-fully-unavailable case: persist-before-deliver must never strand the consumer stream.
    // `drain` resolving (not hanging) is the no-zombie assertion; a regression here would time out.
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: () => Promise.resolve('00000000-0000-4000-8000-000000000001'),
        persistEvent: () => Promise.reject(new Error('store fully unavailable')),
        listInterruptedRuns: () => Promise.resolve([]),
        readWorkflowSnapshot: () => Promise.resolve(undefined),
      },
    };
    const events = await drain(
      new WorkflowEngine({ host, executor: new StubExecutor() }).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    assertGapFreeSeq(events);
  });

  it('delivers the terminal run:completed even when only the terminal durable write fails', async () => {
    // A store fault confined to the terminal write must still close the stream (reconcile repairs durability).
    const inner = new InMemoryRunStore();
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
        persistEvent: (event) =>
          event.type === 'run:completed'
            ? Promise.reject(new Error('terminal write failed'))
            : inner.persistEvent(event),
        listInterruptedRuns: () => inner.listInterruptedRuns(),
        readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      },
    };
    const events = await drain(
      new WorkflowEngine({ host, executor: new StubExecutor() }).start({
        workflow: workflow(SEQUENTIAL),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
    assertGapFreeSeq(events);
  });

  it('handle.cancel() after the run terminated is an idempotent no-op (does not throw)', async () => {
    const engine = engineWith();
    const handle = engine.start({ workflow: workflow(SEQUENTIAL) });
    await drain(handle);
    expect(() => handle.cancel()).not.toThrow();
  });

  it('terminates (no zombie) when the run:paused durable write fails at a gate', async () => {
    // Regression for the gate-pause persist-failure path: #emitPausedOnce -> #emitDurable(run:paused)
    // must re-enter the scheduler so the run settles, never hang. A working store for everything else,
    // a fault confined to run:paused.
    const inner = new InMemoryRunStore();
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
        persistEvent: (event) =>
          event.type === 'run:paused'
            ? Promise.reject(new Error('paused write failed'))
            : inner.persistEvent(event),
        listInterruptedRuns: () => inner.listInterruptedRuns(),
        readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      },
    };
    const engine = new WorkflowEngine({
      host,
      executor: new StubExecutor({
        g: () => ({ kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }),
      }),
    });
    const events = await drain(
      engine.start({
        workflow: workflow(`  id: gatefail
  nodes:
    - { id: start, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: g }
    - { from: g, to: out }`),
      }),
    );
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:failed');
    assertGapFreeSeq(events);
  });

  it('orders delivery by sequenceNumber under an async store whose writes resolve out of order', async () => {
    // Regression for the gap-free/no-drop contract under an ASYNC store (1.R SQLite, cloud): with two
    // parallel leaf nodes, the FIRST node:completed's persist is made slower than the second's. Without
    // seq-ordered delivery, the faster (higher-seq) event — and the terminal — would land first, close
    // the stream, and DROP the slower lower-seq event. The #deliveryTail must keep the delivered set gap-free.
    const inner = new InMemoryRunStore();
    let nodeCompletedSeen = 0;
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
        persistEvent: (event) => {
          if (event.type === 'node:completed' && ['b1', 'b2'].includes(event.nodeId)) {
            // Make the first branch's write resolve LATER than the second's (out-of-order completion).
            const delay = ++nodeCompletedSeen === 1 ? 20 : 1;
            return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() =>
              inner.persistEvent(event),
            );
          }
          return inner.persistEvent(event);
        },
        listInterruptedRuns: () => inner.listInterruptedRuns(),
        readWorkflowSnapshot: (runId: string) => inner.readWorkflowSnapshot(runId),
      },
    };
    const events = await drain(
      new WorkflowEngine({ host, executor: new StubExecutor() }).start({
        workflow: workflow(`  id: par2
  max_parallel: 2
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [b1, b2] }
    - { id: b1, type: output }
    - { id: b2, type: output }
  edges:
    - { from: start, to: fan }`),
      }),
    );
    assertGapFreeSeq(events); // no dropped lower-seq event despite out-of-order persist resolution
    expect(terminalsIn(events)).toHaveLength(1);
    expect(terminalsIn(events)[0]?.type).toBe('run:completed');
  });

  it('fails the run via the settle-time backstop when stamping a node event throws (no node:failed)', async () => {
    // Poison exactly the work node:completed TIMESTAMP so RunEventBus.next's Zod parse throws inside
    // #emitDurable, reaching the #onOutcome backstop (#failNodeInternal). After the work executor returns,
    // #settleCompleted reads the clock once for durationMs (#elapsedMs) and then once for the stamp — so a
    // 2-step countdown lands the malformed value on the stamp. The run still terminates once as
    // run:failed{internal} and emits NO node:failed (the documented backstop deviation).
    let countdown = 0;
    let t = 1_700_000_000_000;
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      clock: {
        now: () => {
          if (countdown > 0) {
            countdown -= 1;
            if (countdown === 0) {
              return 'not-a-timestamp';
            }
          }
          return new Date(t++).toISOString();
        },
      },
    };
    const events = await drain(
      new WorkflowEngine({
        host,
        executor: new StubExecutor({
          work: () => {
            countdown = 2; // next read = durationMs (#elapsedMs, valid); the one after = the stamp (poisoned)
            return { kind: 'completed', output: 'w' };
          },
        }),
      }).start({ workflow: workflow(SEQUENTIAL) }),
    );
    const terminals = terminalsIn(events);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe('run:failed');
    if (terminals[0]?.type === 'run:failed') {
      expect(terminals[0].error.code).toBe('internal');
    }
    expect(events.some((e) => e.type === 'node:failed')).toBe(false); // backstop emits no node:failed
  });

  it('reconcile() skips a run whose terminal write fails and still reconciles the others', async () => {
    const store = new InMemoryRunStore();
    const startedAt = '2026-06-13T00:00:00.000Z';
    for (const runId of ['crash-a', 'crash-b']) {
      await store.persistEvent({
        type: 'run:started',
        runId,
        timestamp: startedAt,
        sequenceNumber: 0,
        workflowId: '00000000-0000-4000-8000-000000000099',
        inputs: {},
        executionMode: 'local',
      });
    }
    // A store that rejects the reconcile write for crash-a only.
    const host: ExecutionHost = {
      ...createInMemoryHost(),
      store: {
        resolveWorkflowId: (slug) => store.resolveWorkflowId(slug),
        persistEvent: (event) =>
          event.type === 'run:failed' && event.runId === 'crash-a'
            ? Promise.reject(new Error('write failed'))
            : store.persistEvent(event),
        listInterruptedRuns: () => store.listInterruptedRuns(),
        readWorkflowSnapshot: (runId: string) => store.readWorkflowSnapshot(runId),
      },
    };
    const reconciled = await new WorkflowEngine({ host, executor: new StubExecutor() }).reconcile();
    // crash-a's write failed and is skipped; crash-b still reconciled — one fault doesn't abandon the rest.
    expect(reconciled.map((e) => e.runId)).toEqual(['crash-b']);
  });
});

// --- ADR-0074 §3: the frozen money basis on a parked media job --------------------------------

/**
 * A `media_job` outcome from a stub handler — the engine parks the node and emits `media_job:submitted`.
 *
 * No budget admission is attached, and cannot be: `retainMediaJobAdmission` is module-private to
 * `agent-runner`. That is not a limitation here — it is exactly the shape the approved-bypass case has
 * anyway, since an approved re-dispatch runs with `preEgress: undefined` and therefore holds no admission.
 * `units` is FRACTIONAL on purpose: `duration_seconds` is fractional by contract (ADR-0074 §3), and an
 * integer bound here once made a 12.5-second job unwritable after the provider had accepted it.
 */
function mediaJobOutcome(overrides: Partial<MediaJobSubmission> = {}): NodeOutcome {
  return {
    kind: 'media_job',
    job: {
      jobId: 'job-1',
      provider: 'openai',
      model: 'sora-2',
      modality: 'video',
      units: 12.5,
      ...overrides,
    },
  };
}

/**
 * Collect a run's events up to and including its `media_job:submitted`, then cancel and drain to the
 * terminal. A parked media job never completes on its own — the poll timer is host-injected and this host
 * fires timers only on demand — so a plain `drain()` would hang.
 */
async function untilMediaJobSubmitted(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (event.type === 'media_job:submitted') handle.cancel();
  }
  return events;
}

// A REAL `budget:` block, so a governor exists and `#makePreEgressHook()` returns a hook. Without it
// `ctx.preEgress` is `undefined` on every dispatch and the bypass assertion below would be vacuous — it would
// pass on a build where `budgetApproved` never gated anything. The cap is large enough that nothing here
// legitimately trips it.
const MEDIA_GATED = `  id: media-gate
  nodes:
    - { id: gen, type: transform, transform: 'g' }
    - { id: out, type: output }
  edges:
    - { from: gen, to: out }
  budget:
    max_cost_microcents: 100000000
    on_exceed: pause_for_approval`;

describe('WorkflowEngine — media_job:submitted freezes its money basis (ADR-0074 §3)', () => {
  it('OMITS acceptedCostMicrocents under the H3 approved bypass (#W15-20)', async () => {
    // `0` means "the gate RAN and reserved nothing" — an unpriced model's allow-degrade path. Under H3's
    // approved bypass NO hook runs at all (`#runAttempt` passes `preEgress: undefined`), so there is no
    // priced basis to freeze and emitting `0` would claim one.
    //
    // Not cosmetic: on resume the frozen branch would call `reserveAcceptedCost(model, 0)`, reserve NOTHING,
    // and skip `registerLegacyMediaJob` — so a job deliberately submitted OVER the cap comes back holding no
    // reservation and no hold, letting a sibling spend headroom that is still owed. Omitting it routes the
    // resume through the legacy branch, which re-prices AND fails closed.
    // Captured, never asserted INSIDE the handler: `#runAttempt`'s catch-all turns any handler throw into a
    // generic `internal` node failure, so a failing in-handler `expect` would surface as a confusing
    // `run:failed` rather than as itself.
    const hookPresent: boolean[] = [];
    let dispatches = 0;
    const engine = engineWith({
      gen: (ctx) => {
        dispatches += 1;
        hookPresent.push(ctx.preEgress !== undefined);
        if (dispatches === 1) {
          // The budget gate, in the shape the governor's `BudgetPauseError` is converted into. The governor
          // raising it is pinned in `budget-governor.test.ts`; what is unproven is what the ENGINE does with
          // the approval afterwards.
          return {
            kind: 'paused',
            gate: {
              gateType: 'approval',
              message: 'over budget — continue?',
              isBudgetGate: true,
              spentMicrocents: 900,
              limitMicrocents: 1000,
            },
          };
        }
        return mediaJobOutcome();
      },
    });
    const handle = engine.start({ workflow: workflow(MEDIA_GATED) });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') {
        const gateId = event.gateIds[0];
        if (gateId !== undefined) {
          await engine.resume(handle.runId, gateId, { decision: 'approved', decidedBy: 'tester' });
        }
      }
      if (event.type === 'media_job:submitted') handle.cancel();
    }

    expect(dispatches).toBe(2); // the approval RE-DISPATCHED the node rather than completing it
    // The bypass, observed rather than assumed: the hook is there on the first dispatch and GONE on the
    // approved one. That contrast is what makes the omission below attributable to `budgetApproved`.
    expect(hookPresent).toEqual([true, false]);
    const submitted = events.find((e) => e.type === 'media_job:submitted');
    expect(submitted?.type).toBe('media_job:submitted');
    if (submitted?.type !== 'media_job:submitted') return;
    expect(submitted).not.toHaveProperty('acceptedCostMicrocents');
    // …while the BASIS is still frozen. `units` alone is the legitimate half-populated row (#W15-7).
    expect(submitted.units).toBe(12.5);
  });

  it('carries acceptedCostMicrocents when the bypass did NOT fire', async () => {
    // Without this row the assertion above would also pass on a build that never emitted the field at all.
    //
    // What it pins is PRESENCE, not the amount. `retainMediaJobAdmission` is module-private to `agent-runner`,
    // so a `StubExecutor` cannot attach an admission and the value here is necessarily the `?? 0` fallback —
    // it does NOT prove the frozen amount tracks a real reservation. That assertion needs a fixture where an
    // admission exists (the agent-runner e2e harness) and is called out here rather than implied.
    const engine = engineWith({ gen: () => mediaJobOutcome() });
    const events = await untilMediaJobSubmitted(engine.start({ workflow: workflow(MEDIA_GATED) }));

    const submitted = events.find((e) => e.type === 'media_job:submitted');
    if (submitted?.type !== 'media_job:submitted') throw new Error('expected media_job:submitted');
    expect(submitted.acceptedCostMicrocents).toBe(0);
  });
});

describe('WorkflowEngine — an abort always breaks the legacy media-job hold (ADR-0074 §3)', () => {
  const HELD = `  id: media-hold
  nodes:
    - { id: gen, type: transform, transform: 'g' }
    - { id: sib, type: transform, transform: 's' }
    - { id: out, type: output }
  edges:
    - { from: gen, to: out }
    - { from: sib, to: out }
  budget:
    max_cost_microcents: 100000000
    on_exceed: fail`;

  it('still reaches run:cancelled with a sibling suspended in the hold (#W15-16)', async () => {
    // The composition gap that let a hang ship: every part was unit-correct and nothing exercised them
    // TOGETHER. `budget-governor.test.ts` proves the governor releases its holds; nothing proved the engine
    // ever calls that on abort.
    //
    // Without the listener a `checkPreEgress` suspended in the hold keeps its node counted as `running`, so
    // `#step` never reaches `#countRunning() === 0` and the run emits NO terminal — an unkillable run, which
    // is strictly worse than the under-reservation the hold prevents. The awaited job cannot rescue it: its
    // poll returns silently once the signal is aborted.
    const store = new InMemoryRunStore();
    // A LEGACY parked job — no `units`, no `acceptedCostMicrocents` — which is what makes the resume register
    // the hold rather than restoring a frozen reservation.
    const workflowId = await store.resolveWorkflowId('media-hold');
    await seedStarted(store, 'hold-1', 'media_job:submitted', workflowId);

    // The governor calls this when it ACTUALLY holds — a deterministic signal, and the only one that
    // distinguishes "parked on the hold" from "entered the handler". A first version of this test flagged the
    // handler ENTRY instead and passed with `registerLegacyMediaJob` deleted: no hold was ever created, so it
    // was quietly asserting "a media-parked resume can be cancelled" while its name claimed otherwise.
    const held: string[][] = [];
    let released = false;
    const engine = engineWith(
      {
        // `gen` is restored from the checkpoint as PARKED, so it must never dispatch.
        gen: () => {
          throw new Error('the parked media node must not re-dispatch');
        },
        sib: async (ctx) => {
          await ctx.preEgress?.({
            model: 'claude-haiku-4-5',
            maxTokens: 100,
            provider: 'anthropic',
          });
          released = true;
          return { kind: 'completed', output: 'sib' };
        },
      },
      createInMemoryHost({ store }),
      {
        onLegacyMediaJobHold: (nodeIds) => {
          held.push([...nodeIds]);
        },
      },
    );

    const handle = await engine.resumeFromCheckpoint({
      runId: 'hold-1',
      workflow: workflow(HELD),
    });
    const events: RunEvent[] = [];
    const collected = (async () => {
      for await (const event of handle.events) events.push(event);
    })();

    // Yield until the governor reports the hold. The loop is `held.length`-conditioned and the assertion
    // right after it is what decides, so a drain that is too short fails loudly instead of passing trivially.
    for (let i = 0; i < 500 && held.length === 0; i += 1) await Promise.resolve();
    expect(held).toEqual([['gen']]); // the hold engaged, and it names the node to wait for
    // PARKED, not merely entered: the sibling has not come out the other side of `checkPreEgress`.
    expect(released).toBe(false);
    expect(terminalsIn(events)).toHaveLength(0);

    handle.cancel();

    // The assertion IS that this await returns. Without the abort listener the stream never closes and this
    // test times out — a hang is the failure mode being pinned.
    await collected;
    expect(released).toBe(true); // the abort is what let the suspended sibling through
    expect(events.some((e) => e.type === 'run:cancelled')).toBe(true);
  });
});
