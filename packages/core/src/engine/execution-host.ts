/**
 * The `ExecutionHost` seam (1.N, [ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md))
 * — the injected boundary that carries the **host concerns** the run loop must not reach for directly,
 * so the loop body is identical across execution modes (CLAUDE.md rule 5 — zero platform imports in
 * `packages/core`). `local` is the Phase-1 host; `cloud` (Phase 2) swaps the whole host and streams the
 * same `RunEvent`s over HTTP SSE; `managed` keeps this host and switches only behind the `@relavium/llm`
 * seam (execution-model.md §Local vs cloud). The loop never branches on the mode — it calls the host.
 *
 * Three concerns are injected: a **clock** (so the bus stamps timestamps without an ambient
 * `Date`/wall-clock and tests are deterministic), an **id source** (run/gate ids — no ambient
 * `crypto`), and a **store** (the persistence port the `Checkpointer` (1.R) and the ADR-0022
 * slug→UUID upsert hang off). The store is also what crash reconciliation reads on startup. Real
 * surfaces inject production implementations (the CLI/desktop supply `new Date().toISOString()` and a
 * UUID source); core ships only the deterministic {@link createInMemoryHost} used by the engine tests
 * and as the local reference.
 */

import type { AbortSignalLike, RunEvent } from '@relavium/shared';

/** A platform-free ISO-8601 timestamp source — injected so the engine never reads an ambient clock. */
export interface Clock {
  /** An ISO-8601 timestamp with offset (`…Z` or `±HH:MM`), matching the run-event envelope. */
  now: () => string;
}

/** A platform-free unique-id source — injected so the engine never reaches for an ambient `crypto`. */
export interface IdSource {
  /** A process-unique id (a `runId` / `gateId`); the local/cloud host supplies a UUID source. */
  newId: () => string;
}

/**
 * The minimal abort-controller shape the engine creates per run — injected so core never names the
 * ambient `AbortController` global (absent from the strict `lib: ["ES2023"]` purity build; CLAUDE.md
 * rule 5). A native `AbortController` (Node/browser/Bun) structurally satisfies it, so a real surface
 * injects `() => new AbortController()` and its `signal` is a genuine `AbortSignal` that `fetch` honours;
 * {@link createInMemoryHost} injects the in-house {@link createAbortController} for tests.
 */
export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort: (reason?: unknown) => void;
}

/**
 * An in-house, platform-free {@link AbortControllerLike} — no ambient `AbortController`. Enough for the
 * engine and stub executors (observe `aborted`, fire `abort` listeners once); a real surface injects a
 * native controller whose signal also drives `fetch`. Matching a native `AbortSignal`, a listener
 * registered **after** the signal has aborted never fires — a caller checks `signal.aborted` first
 * (the pattern the engine's node executors follow).
 */
export function createAbortController(): AbortControllerLike {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: AbortSignalLike = {
    get aborted(): boolean {
      return aborted;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    abort: () => {
      if (aborted) {
        return;
      }
      aborted = true;
      for (const listener of listeners) {
        listener();
      }
      listeners.clear();
    },
  };
}

/**
 * A run interrupted before it reached a terminal event — what crash reconciliation finds on startup.
 * `resumable` distinguishes a run parked at a human/budget gate (checkpoint-resumable) from one that was
 * mid-execution when the process died (non-resumable → reconciled to `run:failed`).
 */
export interface InterruptedRun {
  readonly runId: string;
  readonly workflowId: string;
  /** `true` when the run was suspended at a gate (resumable); `false` when it died mid-execution. */
  readonly resumable: boolean;
  /** The highest `sequenceNumber` already persisted for this run — the reconcile event continues from it. */
  readonly lastSequenceNumber: number;
}

/**
 * The persistence port (1.N defines it; 1.R wires a SQLite-backed one; Phase-2 cloud another). There is
 * **no separate checkpoint table** — the checkpoint is derived from these rows (ADR-0003). 1.N needs
 * only: resolve the authored slug to the surrogate `workflows.id` UUID (ADR-0022), append events (the
 * node-boundary/terminal write the engine awaits *before* delivery), and enumerate interrupted runs for
 * reconciliation.
 */
export interface RunStore {
  /**
   * Resolve (upserting if needed) the authored workflow slug to its surrogate `workflows.id` UUID, so
   * `run:started.workflowId` is always a UUID enforced in one place (ADR-0022).
   */
  resolveWorkflowId: (slug: string) => Promise<string>;
  /** Durably append one run event (the engine awaits this for a boundary/terminal event before delivery). */
  persistEvent: (event: RunEvent) => Promise<void>;
  /** Runs with a `run:started` but no terminal event — for startup crash reconciliation. */
  listInterruptedRuns: () => Promise<readonly InterruptedRun[]>;
}

/**
 * The injected execution-mode seam: clock + id source + persistence + abort, nothing platform-specific.
 * The Phase-1 slice ships `clock.now()`; the one-shot **timer** port (for gate / run `timeout_ms`
 * deadlines — ADR-0036 Decision 5) is added when the human gate (1.Q) and budget governor (1.AC) wire
 * timeouts, since 1.N arms no timers.
 */
export interface ExecutionHost {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly store: RunStore;
  /** Create a fresh abort controller for a run — injected so core never names the ambient global. */
  readonly newAbortController: () => AbortControllerLike;
}

// --- In-memory reference implementation (engine tests + the local reference) -------------------

const TERMINAL_TYPES: ReadonlySet<RunEvent['type']> = new Set([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);
const RESUMABLE_LAST_TYPES: ReadonlySet<RunEvent['type']> = new Set([
  'human_gate:paused',
  'run:paused',
  'budget:paused',
]);

/** Format a counter into a syntactically-valid (RFC-4122-shaped) UUID — deterministic for tests. */
function counterUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * An in-memory {@link RunStore} — deterministic and dependency-free. Persists events per run so a *new*
 * engine constructed over the *same* store sees the prior "process'" runs, which is how the tests
 * simulate crash-then-restart reconciliation. Slugs map to stable counter UUIDs.
 */
export class InMemoryRunStore implements RunStore {
  readonly #events = new Map<string, RunEvent[]>();
  readonly #workflowIds = new Map<string, string>();
  #workflowCounter = 0;

  resolveWorkflowId(slug: string): Promise<string> {
    let id = this.#workflowIds.get(slug);
    if (id === undefined) {
      id = counterUuid(++this.#workflowCounter);
      this.#workflowIds.set(slug, id);
    }
    return Promise.resolve(id);
  }

  persistEvent(event: RunEvent): Promise<void> {
    if (event.runId === undefined) {
      return Promise.resolve(); // session events are out of the run store's scope (1.N)
    }
    const bucket = this.#events.get(event.runId);
    if (bucket === undefined) {
      this.#events.set(event.runId, [event]);
    } else {
      bucket.push(event);
    }
    return Promise.resolve();
  }

  listInterruptedRuns(): Promise<readonly InterruptedRun[]> {
    const interrupted: InterruptedRun[] = [];
    for (const [runId, events] of this.#events) {
      const started = events.find(
        (e): e is Extract<RunEvent, { type: 'run:started' }> => e.type === 'run:started',
      );
      if (started === undefined) {
        continue;
      }
      if (events.some((e) => TERMINAL_TYPES.has(e.type))) {
        continue; // already settled
      }
      const last = events.at(-1);
      interrupted.push({
        runId,
        workflowId: started.workflowId,
        resumable: last !== undefined && RESUMABLE_LAST_TYPES.has(last.type),
        lastSequenceNumber: events.reduce((max, e) => Math.max(max, e.sequenceNumber), -1),
      });
    }
    return Promise.resolve(interrupted);
  }

  /** Test/inspection helper — the persisted event log for a run, in append order. */
  eventsFor(runId: string): readonly RunEvent[] {
    return this.#events.get(runId) ?? [];
  }
}

/**
 * A deterministic in-memory {@link ExecutionHost} for the engine tests and the local reference: a clock
 * that advances 1ms per read from a fixed base (valid ISO-8601, reproducible), a counter id source, and
 * an {@link InMemoryRunStore}. A real surface injects wall-clock/UUID sources instead.
 */
export function createInMemoryHost(options?: {
  store?: RunStore;
  baseEpochMs?: number;
}): ExecutionHost & { store: RunStore } {
  let tick = options?.baseEpochMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  let idCounter = 0;
  return {
    clock: { now: () => new Date(tick++).toISOString() },
    ids: { newId: () => `id-${++idCounter}` },
    store: options?.store ?? new InMemoryRunStore(),
    newAbortController: createAbortController,
  };
}
