import { describe, expect, it } from 'vitest';

import type { MediaReferencePort, MediaStore, MediaWritePort, RunEvent } from '@relavium/shared';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { EngineStateError } from './errors.js';
import {
  createInMemoryHost,
  InMemoryRunStore,
  type ExecutionHost,
  type RunStore,
} from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';
import type { RunHandle } from './run-handle.js';
import { WorkflowEngine } from './engine.js';

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
): WorkflowEngine {
  return new WorkflowEngine({
    host: host ?? createInMemoryHost(),
    executor: new StubExecutor(handlers),
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
function seedStarted(store: RunStore, runId: string, lastType?: RunEvent['type']): Promise<void> {
  const startedAt = '2026-06-13T00:00:00.000Z';
  const events: RunEvent[] = [
    {
      type: 'run:started',
      runId,
      timestamp: startedAt,
      sequenceNumber: 0,
      workflowId: '00000000-0000-4000-8000-000000000099',
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

  it('arms no gate timer on rehydration (re-arm is a Phase-2 reconciliation concern)', async () => {
    const store = new InMemoryRunStore();
    // Process A: pause at a gate that carries a timeout.
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
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break;
      }
    }
    // Process B rehydrates. Spy on setTimer to prove it is NEVER called during rehydration — distinguishing
    // "never armed" from "armed then disarmed on resume" (which armedCount alone could not).
    const baseHostB = createInMemoryHost({ store });
    let armCalls = 0;
    const hostB: typeof baseHostB = {
      ...baseHostB,
      setTimer: (ms, onFire) => {
        armCalls += 1;
        return baseHostB.setTimer(ms, onFire);
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
    expect(armCalls).toBe(0); // rehydration armed no timer at all (re-arm is a Phase-2 concern)
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
      },
    };
    const reconciled = await new WorkflowEngine({ host, executor: new StubExecutor() }).reconcile();
    // crash-a's write failed and is skipped; crash-b still reconciled — one fault doesn't abandon the rest.
    expect(reconciled.map((e) => e.runId)).toEqual(['crash-b']);
  });
});
