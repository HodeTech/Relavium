import { randomUUID } from 'node:crypto';

import {
  InMemoryRunStore,
  createInMemoryCheckpointer,
  type ExecutionHost,
  type RunStore,
} from '@relavium/core';

/**
 * A real, node-backed {@link ExecutionHost} for the CLI — wall-clock ISO timestamps, UUID ids
 * (ADR-0022), `setTimeout` one-shot timers, and the global AbortController. The run store is the
 * in-memory reference for now; durable SQLite history via `@relavium/db` lands in **2.H**. No
 * `mediaStore` — media host-wiring is **2.S** (a media-bearing run fails loud, never leaks bytes).
 *
 * The clock/ids/abort/timer are generic Node primitives (no CLI specifics), so this is positioned
 * for later extraction to a shared node-host helper the VS Code host can reuse.
 */
export function createCliHost(store: RunStore = new InMemoryRunStore()): ExecutionHost {
  return {
    clock: { now: () => new Date().toISOString() },
    ids: { newId: () => randomUUID() },
    store,
    checkpointer: createInMemoryCheckpointer(store),
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
