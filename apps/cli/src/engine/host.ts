import { randomUUID } from 'node:crypto';

import {
  InMemoryRunStore,
  createInMemoryCheckpointer,
  type Checkpointer,
  type ExecutionHost,
  type RunStore,
} from '@relavium/core';
import { fetchMediaBytes } from '@relavium/db';

/** Options for {@link createCliHost}. */
export interface CliHostOptions {
  /**
   * The {@link Checkpointer} the engine's `resumeFromCheckpoint` loads from — supplied only on the
   * cross-process gate-resume path (**2.G**), where it must reconstruct from the durable event log (the
   * `createHistoryCheckpointer` over the SQLite store). Omitted on the `run` path, which never resumes from a
   * checkpoint, so it defaults to the in-memory reconstruction (a no-op `undefined` over the durable store).
   *
   * MUST be paired with an explicit **durable** `store` reconstructed from the SAME backend — the engine reads
   * the checkpoint from here but resolves/persists through `host.store`, so a checkpointer over the default
   * in-memory store is a split-backend wiring bug that `createCliHost` rejects at construction.
   */
  readonly checkpointer?: Checkpointer;
}

/**
 * A real, node-backed {@link ExecutionHost} for the CLI — wall-clock ISO timestamps, UUID ids
 * (ADR-0022), `setTimeout` one-shot timers, and the global AbortController. `run` injects the durable
 * SQLite `RunStore` (2.H); `gate` additionally injects the durable {@link Checkpointer} (2.G) so a fresh
 * process can rehydrate a paused run from its persisted events. The host media-egress port (`fetchMedia`,
 * SSRF-validated, ADR-0043) is wired (**2.S**); the remaining media ports — `mediaStore` / `mediaReferences`
 * / `mediaWrite` — land later in 2.S, so a run that PRODUCES media still fails loud (`media_store_unavailable`,
 * never a silent byte leak) until then.
 *
 * The clock/ids/abort/timer/fetchMedia are generic Node primitives (no CLI specifics), so this is positioned
 * for later extraction to a shared node-host helper the VS Code host can reuse.
 */
export function createCliHost(
  store: RunStore = new InMemoryRunStore(),
  options?: CliHostOptions,
): ExecutionHost {
  // A durable checkpointer reads from one backend (the persisted event log) while the host's `store` does the
  // resolveWorkflowId / persistEvent writes; if `store` is the in-memory reference (incl. the default), the two
  // point at DIFFERENT backends and `resumeFromCheckpoint` would validate/persist against the wrong store. Fail
  // loud at wiring time — the only valid pairing is a durable `store` + a checkpointer reconstructed from it.
  if (options?.checkpointer !== undefined && store instanceof InMemoryRunStore) {
    throw new Error(
      'createCliHost: a checkpointer requires an explicit durable RunStore (the checkpointer must reconstruct from the same store the run persists to)',
    );
  }
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
    // The host media-egress mechanism (1.AF/D9, ADR-0043): re-host a public-HTTPS `url` media source to a
    // handle via `@relavium/db`'s `fetchMediaBytes` — the SSRF-validated, size-bounded connect (the mechanism
    // + its 23 tests are the canonical home; see ADR-0043 §2-3 / the `media-egress.ts` header). The wiring
    // rationale: `allowPrivate: false` is the default-deny posture (the BYOK local-endpoint opt-in is deferred,
    // security-review.md); the engine owns the `maxBytes` policy + the run `AbortSignal`; always wired (a
    // text-only run never invokes it); `signal` is spread conditionally so an absent one is OMITTED, not
    // assigned `undefined` (which `exactOptionalPropertyTypes` rejects).
    fetchMedia: (url, maxBytes, signal) =>
      fetchMediaBytes(url, {
        maxBytes,
        allowPrivate: false,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
