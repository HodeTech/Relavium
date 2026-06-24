import type { Checkpointer, RunStore } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { createCliHost } from './host.js';

/** A stand-in DURABLE store (not the in-memory reference) — what the gate path injects alongside a checkpointer. */
const durableStore: RunStore = {
  resolveWorkflowId: () => Promise.resolve('wf'),
  persistEvent: () => Promise.resolve(),
  listInterruptedRuns: () => Promise.resolve([]),
};

describe('createCliHost', () => {
  it('uses an injected checkpointer (the 2.G cross-process gate-resume seam) over the default', async () => {
    const injected: Checkpointer = { load: () => Promise.resolve(undefined) };
    const host = createCliHost(durableStore, { checkpointer: injected });
    expect(host.checkpointer).toBe(injected); // resumeFromCheckpoint loads from the durable reconstruction
    expect(await host.checkpointer.load('any')).toBeUndefined();
  });

  it('rejects a checkpointer over the in-memory store — that split-backend pairing would resume against the wrong store', () => {
    const injected: Checkpointer = { load: () => Promise.resolve(undefined) };
    // Default store (in-memory) + a durable checkpointer = read/write backends diverge → fail loud at wiring.
    expect(() => createCliHost(undefined, { checkpointer: injected })).toThrow(/durable RunStore/);
  });

  it('defaults to the in-memory checkpointer when none is injected (the run path never resumes)', () => {
    const host = createCliHost();
    expect(host.checkpointer).toBeDefined();
  });

  it('provides a NATIVE AbortController whose signal a provider SDK threads into fetch', () => {
    // Regression: the CLI host once injected the engine's in-house test `createAbortController`, whose signal
    // is NOT `instanceof AbortSignal` — so the LLM adapters (isAbortSignal gate) DROPPED it and a run cancel
    // could not abort an in-flight LLM stream, leaving Ctrl-C unable to cooperatively cancel an agent run.
    const controller = createCliHost().newAbortController();
    expect(controller.signal).toBeInstanceOf(AbortSignal); // a real AbortSignal — fetch/SDKs honour it
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('exposes a real, node-backed host (clock, ids, store, timer)', () => {
    const host = createCliHost();
    expect(typeof host.clock.now()).toBe('string'); // ISO timestamp
    expect(host.ids.newId()).toMatch(/^[0-9a-f-]{36}$/); // a UUID
    const cancel = host.setTimer(10_000, () => {});
    expect(typeof cancel).toBe('function');
    cancel(); // clears the timer — no dangling handle
  });
});
