import { randomUUID } from 'node:crypto';

import {
  InMemoryRunStore,
  createInMemoryCheckpointer,
  type Checkpointer,
  type ExecutionHost,
  type RunStore,
} from '@relavium/core';

/** Options for {@link createCliHost}. */
export interface CliHostOptions {
  /**
   * The {@link Checkpointer} the engine's `resumeFromCheckpoint` loads from — supplied only on the
   * cross-process gate-resume path (**2.G**), where it must reconstruct from the durable event log (the
   * `createHistoryCheckpointer` over the SQLite store). Omitted on the `run` path, which never resumes from a
   * checkpoint, so it defaults to the in-memory reconstruction (a no-op `undefined` over the durable store).
   */
  readonly checkpointer?: Checkpointer;
}

/**
 * A real, node-backed {@link ExecutionHost} for the CLI — wall-clock ISO timestamps, UUID ids
 * (ADR-0022), `setTimeout` one-shot timers, and the global AbortController. `run` injects the durable
 * SQLite `RunStore` (2.H); `gate` additionally injects the durable {@link Checkpointer} (2.G) so a fresh
 * process can rehydrate a paused run from its persisted events. No `mediaStore` — media host-wiring is **2.S**
 * (a media-bearing run fails loud, never leaks bytes).
 *
 * The clock/ids/abort/timer are generic Node primitives (no CLI specifics), so this is positioned
 * for later extraction to a shared node-host helper the VS Code host can reuse.
 */
export function createCliHost(
  store: RunStore = new InMemoryRunStore(),
  options?: CliHostOptions,
): ExecutionHost {
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { newId: () => randomUUID() },
    store,
    checkpointer: options?.checkpointer ?? createInMemoryCheckpointer(store),
    // A NATIVE AbortController — its `signal` is a real `AbortSignal` that the provider SDKs thread into
    // `fetch`, so a run cancel actually aborts an in-flight LLM stream (→ prompt `run:cancelled`). The
    // engine's in-house `createAbortController` is for TESTS ONLY (its signal is not `instanceof
    // AbortSignal`, so adapters drop it and a Ctrl-C can't interrupt a live stream). See execution-host.ts.
    newAbortController: () => new AbortController(),
    setTimer: (ms, onFire) => {
      const timer = setTimeout(onFire, ms);
      return () => {
        clearTimeout(timer);
      };
    },
  };
}
