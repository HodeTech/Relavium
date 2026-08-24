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

import {
  type AbortSignalLike,
  AppendConflictError,
  blocksResume,
  type DurableWriteContext,
  EffectConflictError,
  EffectTransitionError,
  type EffectCorrelation,
  type EffectDispatchPort,
  type EffectResumePort,
  effectScope,
  type EffectSlot,
  type EffectState,
  type EffectTier,
  LeaseFencedError,
  type MediaReferencePort,
  type MediaStore,
  type MediaWritePort,
  nodeIdFromRunScope,
  type RunEvent,
  type RunLeaseInfo,
  type RunLeasePort,
  type TerminalOutbox,
} from '@relavium/shared';

import { type Checkpointer, reconstructCheckpointState } from './checkpoint.js';

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
  /**
   * Durably append one **run** event (the engine awaits this for a boundary/terminal event before
   * delivery). Typed on `RunEvent`: the run store persists only run events. The shared bus also carries
   * `session:*` events (ADR-0036), but those are never routed here — session persistence is `history.db` /
   * `session_messages`, workstream 1.X, out of the run store's scope.
   *
   * **`ctx` is OPTIONAL at the type level, which is NARROWER than ADR-0078 §2's `persistEvent(event, ctx)`.**
   * Recorded as a deviation rather than presented as the decision, because §4 of the same ADR rejects exactly
   * this shape for the outbox port — "optional here would mean a host that forgets the port silently has no
   * guarantee". The two differ in what absence means: a host with no outbox loses a guarantee it was supposed
   * to provide, while a caller with no `ctx` holds no belief for the guard to check, and the guard's whole job
   * is to catch a STALE belief. Requiring it would force every direct-seeding fixture in the repo to fabricate
   * one, which is a worse failure mode: a fabricated belief is a wrong belief.
   *
   * The residual risk is real and named: a future production caller that forgets `ctx` writes unguarded and
   * nothing fails. What closes it is that the engine has exactly two `persistEvent` call sites — `#emitDurable`
   * and `reconcile()` — both of which pass it, both of which are pinned by tests. A store may refuse an
   * unguarded write outright; none does today.
   */
  persistEvent: (event: RunEvent, ctx?: DurableWriteContext) => Promise<void>;
  /** Runs with a `run:started` but no terminal event — for startup crash reconciliation. */
  listInterruptedRuns: () => Promise<readonly InterruptedRun[]>;
  /**
   * The FROZEN workflow definition this run started on, as the JSON the store persisted
   * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
   * §5) — `runs.workflow_definition_snapshot` in the SQLite store.
   *
   * **A method on this seam rather than a new port**, because the graph is the one piece of a run's identity
   * the event log does not carry: `run:started` names a `workflowId` surrogate, not the content. Reading it
   * here is what lets `resumeFromCheckpoint` refuse a workflow that is the same slug with different content —
   * the "subtler same-slug-edited-content drift" the identity guard's own comment named and deferred.
   *
   * **REQUIRED, returning `string | undefined`.** Required so a host author has to decide: a store that keeps
   * no frozen definition says so by answering `undefined`, and the engine then skips content verification with
   * that fact stated, rather than a host silently omitting a property and losing the guarantee (the failure
   * mode ADR-0078 §4 names for the outbox port). `undefined` means "this store will not give you a snapshot
   * for this run", never "the snapshot is empty".
   *
   * The SQLite implementation also answers `undefined` for a SOFT-DELETED run. That is a store's decision
   * about its own rows rather than a second meaning — a deleted run is not resumable, and `relavium gate`
   * refuses one before the engine is reached — but the wording matters: a host that ever loaded a checkpoint
   * for a soft-deleted run would otherwise get content verification silently skipped while believing the
   * store had none to give.
   */
  readWorkflowSnapshot: (runId: string) => Promise<string | undefined>;
}

/**
 * Arm a one-shot timer: invoke `onFire` **once** after `ms`, unless the returned disarm is called first.
 * Injected so core never names the ambient `setTimeout`/`clearTimeout` (absent from the strict
 * `lib: ["ES2023"]` purity build; CLAUDE.md rule 5). A real surface injects a `setTimeout`-backed timer;
 * {@link createManualTimerController} provides a deterministic manual timer the engine tests fire by hand.
 * Used by the human gate (1.Q) and budget governor (1.AC) for `timeout_ms` deadlines (ADR-0036 Decision 5)
 * — never a sleep/poll loop, so the completion-driven scheduler stays event-driven.
 */
export type SetTimer = (ms: number, onFire: () => void, kind?: TimerKind) => () => void;

/**
 * What a timer's firing MEANS — a distinction that is load-bearing, not bookkeeping.
 *
 * - **`work`** (the default): firing ADVANCES the run. A gate/run `timeout_ms` deadline, a retry backoff
 *   (ADR-0040), a media poll re-arm (ADR-0045). The run is waiting on it, it fires a bounded number of
 *   times, and something observable happens when it does.
 * - **`liveness`**: firing advances NOTHING. Today this is only the ADR-0079 §6 lease heartbeat: it re-arms
 *   itself for as long as the run lives, and its whole job is to tell another process "still here".
 *
 * Conflating the two costs real things in both directions. In a test, `fireTimers()` drives a run forward by
 * firing what it is waiting on — a self-re-arming beat in that set means a drive-to-quiescence loop never
 * terminates and `armedCount()` stops answering "is this run waiting on anything?". In production, a work
 * timer SHOULD hold the event loop open (the run is parked on it) while a perpetual liveness beat must never
 * be the only reason a process cannot exit — which is why the CLI host `unref()`s exactly this kind.
 */
export type TimerKind = 'work' | 'liveness';

/**
 * The injected execution-mode seam: clock + id source + persistence + checkpointer + abort + timer,
 * nothing platform-specific. The loop never branches on the execution mode — it calls the host.
 */
export interface ExecutionHost {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly store: RunStore;
  /**
   * The read side that reconstructs a run's {@link CheckpointState} from persisted rows so an interrupted
   * run (crash, or suspended at a gate) can resume (1.R). Kept separate from the write `store` port. The
   * real SQLite/cloud one is Phase-2/CLI; the in-memory reference is {@link createInMemoryCheckpointer}.
   */
  readonly checkpointer: Checkpointer;
  /** Create a fresh abort controller for a run — injected so core never names the ambient global. */
  readonly newAbortController: () => AbortControllerLike;
  /** Arm a one-shot timer (gate / run `timeout_ms`); see {@link SetTimer}. */
  readonly setTimer: SetTimer;
  /**
   * The host blob store the engine de-inlines in-flight media into at the one emit/persist choke point
   * (1.AF, [ADR-0042](../../../../docs/decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)).
   * **Optional and absent-tolerant**: a text-only host (or a run that produces no media) leaves it
   * `undefined` and never enters a byte path. The engine references it only by the handle string; a host
   * (CLI/VS Code filesystem CAS, desktop Rust CAS) injects an implementation. A media-bearing event with
   * NO store injected is a loud configuration breach (`media_store_unavailable`), never a silent byte leak.
   */
  readonly mediaStore?: MediaStore;
  /**
   * The host media-egress mechanism (1.AF/D9, [ADR-0043](../../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md))
   * — fetch the bytes at a public-HTTPS `url` with the SSRF-validated, size-bounded connect the engine
   * binds into `deInlineMedia`'s url-rehost hook. The engine supplies the `maxBytes` **policy** + the run
   * `AbortSignal`; the host performs the validated I/O (DNS-resolve + connect-by-validated-IP + per-hop
   * redirect re-validation). **Optional + absent-tolerant**: with no egress mechanism a `url` media source
   * hard-fails at the de-inline choke point (an un-re-hosted url may never persist, I3). The Node reference
   * is `@relavium/db`'s `fetchMediaBytes`.
   */
  readonly fetchMedia?: HostMediaFetch;
  /**
   * The host media-reference lifecycle port (1.AF/D12c + D11,
   * [ADR-0042](../../../../docs/decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)
   * §3-4): the engine records a produced handle's run reference at the de-inline choke point and reclaims
   * the run's references at its terminal event. **Optional + best-effort** — a record/reclaim failure is a
   * retention concern, never an I3/run-correctness break. The Node reference is `@relavium/db`'s
   * `createMediaReferencePort(MediaReferenceStore)`; a text-only host (or a host that does not track media
   * retention) leaves it `undefined`.
   */
  readonly mediaReferences?: MediaReferencePort;
  /**
   * The host media-write port (1.AF/D16, [ADR-0044](../../../../docs/decisions/0044-media-access-governance-read-media-save-to-cost.md)
   * §2) — the `save_to` write **mechanism**. The engine resolves an `output` node's `save_to` template to a
   * relative path and its single produced handle to bytes (via {@link ExecutionHost.mediaStore}), then calls
   * this port; the host jails the relative path (`realpath`+`commonpath`, symlinks OFF) under its own scope
   * root and writes. **Optional**: a host with no write surface leaves it `undefined`, and a `save_to` then
   * fails the node with a clear configuration error (never a silent skip — `save_to` is a real deliverable,
   * NOT best-effort). The Node reference is `@relavium/db`'s `createFilesystemMediaWrite(scopeRoot)`.
   */
  readonly mediaWrite?: MediaWritePort;
  /**
   * Where a terminal the store would not accept is held so a later start can retry it (ADR-0078 §4).
   *
   * **Required, unlike the media ports above.** Those are absent-tolerant because a text-only host
   * legitimately has no media; there is no legitimate host with no terminal durability, so optional here
   * would mean a host that forgets it silently has no guarantee — a fail-open default inside a fail-closed
   * item, invisible at every call site. `createInMemoryHost` ships a reference implementation, following the
   * `newAbortController` precedent.
   */
  readonly terminalOutbox: TerminalOutbox;
  /**
   * Cross-process run ownership (ADR-0079). **Required**, for the same reason `terminalOutbox` is: there is
   * no legitimate host with no ownership guarantee, so optional would mean a host that forgets it silently
   * has none. `createInMemoryHost` ships a reference implementation.
   */
  readonly runLeases: RunLeasePort;
}

/** The host media-egress port: a public-HTTPS `url` → its bytes, under an engine-supplied size bound. */
export type HostMediaFetch = (
  url: string,
  maxBytes: number,
  signal?: AbortSignalLike,
) => Promise<Uint8Array>;

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
  // An async media-job park (1.AG Section D, ADR-0045 §2-3): `media_job:submitted` is persisted in its own
  // turn BEFORE the later `run:paused`, so a crash in that window leaves it as the durable last event. The
  // run is re-attachable — the checkpoint fold derives a `pendingMediaJobs` slot from it and
  // `resumeFromCheckpoint` re-polls the opaque jobId (never re-submits). Reconciling it to `run:failed` would
  // orphan a paid, still-generating provider LRO, so it must be left for the resume path — like a gate park.
  'media_job:submitted',
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
  readonly #definitionJson: string | undefined;

  /**
   * @param definitionJson The frozen `WorkflowDefinition` JSON this store records, mirroring the SQLite
   * store's construction-time `deps.workflow.definitionJson`. Omitted ⇒ this store holds no frozen
   * definition, so {@link readWorkflowSnapshot} answers `undefined` and a resume skips content verification
   * — which is the honest answer for a fixture that was never given one, not a silently disabled check.
   */
  constructor(definitionJson?: string) {
    this.#definitionJson = definitionJson;
  }

  readWorkflowSnapshot(runId: string): Promise<string | undefined> {
    return Promise.resolve(this.#events.has(runId) ? this.#definitionJson : undefined);
  }

  resolveWorkflowId(slug: string): Promise<string> {
    let id = this.#workflowIds.get(slug);
    if (id === undefined) {
      id = counterUuid(++this.#workflowCounter);
      this.#workflowIds.set(slug, id);
    }
    return Promise.resolve(id);
  }

  persistEvent(event: RunEvent, ctx?: DurableWriteContext): Promise<void> {
    if (event.runId === undefined) {
      return Promise.resolve(); // a dual event with no runId is out of the run store's scope (1.N)
    }
    const bucket = this.#events.get(event.runId);
    // The SAME compare-and-append the SQLite store applies (ADR-0078 §2). A reference implementation that
    // accepts what the real store rejects makes every `packages/core` test prove nothing — the divergence
    // would surface only in `apps/cli`, which is the one place these tests exist to keep it out of.
    const expected = ctx?.expectedLastSequenceNumber;
    if (expected !== undefined) {
      const actual = (bucket ?? []).reduce((max, e) => Math.max(max, e.sequenceNumber), -1);
      if (actual !== expected) {
        return Promise.reject(new AppendConflictError(event.runId, expected, actual));
      }
      // …and the SAME not-ahead guard, for the same reason the equality check is mirrored here: the equality
      // alone does not order the log, because a legitimate sequence gap makes a stale event's number both
      // unique and lower. A reference store that accepted what SQLite rejects would hide exactly this.
      if (event.sequenceNumber <= actual) {
        return Promise.reject(
          new AppendConflictError(event.runId, expected, actual, event.sequenceNumber),
        );
      }
    }
    // The SAME fence check the SQLite store applies (ADR-0079 §2), and it belongs here for the identical
    // reason the guard above does. Its absence was measured, not theorised: with the fence unenforced here,
    // DELETING it from the engine's one write choke point left all 3,568 tests in the repo green — the
    // single mechanism ADR-0079 rests on, provable nowhere.
    //
    // Two absences are deliberately NOT rejections, and they are different absences. A write carrying no
    // `ctx.fence` makes no ownership claim, so there is nothing stale to catch — the real store fails open
    // on an absent token too. And a store with **no lease table bound** models a fixture that expresses no
    // ownership at all; the SQLite store has no such state (`run_leases` always exists), so its missing-ROW
    // arm can only ever mean the lease is gone, which is a refusal. Collapsing the two made an unbound
    // fixture reject every fence-carrying write.
    const leases = this.#leases;
    if (ctx?.fence !== undefined && leases !== undefined) {
      const held = leases.peek(event.runId);
      if (
        held === undefined ||
        held.ownerId !== ctx.fence.ownerId ||
        held.generation !== ctx.fence.generation
      ) {
        return Promise.reject(
          new LeaseFencedError(
            event.runId,
            ctx.fence.ownerId,
            ctx.fence.generation,
            held?.generation,
          ),
        );
      }
    }
    if (bucket === undefined) {
      this.#events.set(event.runId, [event]);
    } else {
      bucket.push(event);
    }
    return Promise.resolve();
  }

  /**
   * The lease port this store's fence rule reads, bound ONCE and then shared (ADR-0079 §2).
   *
   * **The binding lives on the STORE, not on the host, and that is the point.** In reality there is one
   * `run_leases` table per `history.db`, so every process writing that database consults the same leases —
   * and the tests that model two processes do exactly what reality does: build two hosts over one store.
   * Minting a lease port per host instead would make the second host's fences unrecognisable to the first's,
   * which is the in-memory twin of the durable-store-plus-in-memory-leases wiring bug `createCliHost`
   * rejects out loud. Binding here makes that mistake unrepresentable.
   *
   * A store with nothing bound accepts any fence — the pre-CR-11 behaviour, which is what a fixture that
   * never seeds a lease needs.
   */
  bindLeases(port: InMemoryRunLeases): InMemoryRunLeases {
    this.#leases ??= port;
    return this.#leases;
  }

  #leases: InMemoryRunLeases | undefined;

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
 * A deterministic, manual {@link SetTimer}: arming registers a timer but never fires it on a wall clock;
 * a test fires every still-armed timer by calling {@link ManualTimerController.fireTimers}. This keeps
 * gate/run-timeout tests reproducible and platform-free (no ambient `setTimeout`). Firing snapshots the
 * armed set first, so a callback that arms or disarms timers cannot perturb the in-progress sweep.
 */
export interface ManualTimerController {
  readonly setTimer: SetTimer;
  /**
   * Fire every currently-armed **work** timer once (in arm order), then drop it. A disarmed timer never
   * fires. Liveness timers are deliberately excluded — see {@link TimerKind}: they advance nothing and
   * re-arm themselves, so a drive-to-quiescence loop that fired them would never terminate.
   */
  readonly fireTimers: () => void;
  /** The count of still-armed **work** timers — for a test asserting a gate's timer was disarmed on resume. */
  readonly armedCount: () => number;
  /** Fire every currently-armed **liveness** timer once — the ADR-0079 heartbeat, exercised explicitly. */
  readonly fireLiveness: () => void;
  /** The count of still-armed **liveness** timers — for a test asserting the heartbeat was disarmed. */
  readonly livenessCount: () => number;
}

export function createManualTimerController(): ManualTimerController {
  interface ManualTimer {
    armed: boolean;
    readonly kind: TimerKind;
    readonly onFire: () => void;
  }
  const timers = new Set<ManualTimer>();
  // Snapshot the armed set BEFORE firing: a callback may arm a new timer (which must NOT fire in this same
  // sweep — the heartbeat re-arms itself, so firing live would spin forever) or disarm a sibling; iterating
  // the live Set would do both. The snapshot is required, not a convenience.
  const fire = (kind: TimerKind): void => {
    const due = Array.from(timers).filter((timer) => timer.kind === kind);
    for (const timer of due) {
      if (timer.armed) {
        timer.armed = false;
        timers.delete(timer);
        timer.onFire();
      }
    }
  };
  const count = (kind: TimerKind): number =>
    Array.from(timers).filter((timer) => timer.kind === kind).length;
  return {
    setTimer: (_ms, onFire, kind = 'work') => {
      const timer: ManualTimer = { armed: true, kind, onFire };
      timers.add(timer);
      return () => {
        timer.armed = false;
        timers.delete(timer);
      };
    },
    fireTimers: () => {
      fire('work');
    },
    armedCount: () => count('work'),
    fireLiveness: () => {
      fire('liveness');
    },
    livenessCount: () => count('liveness'),
  };
}

/**
 * A deterministic in-memory {@link ExecutionHost} for the engine tests and the local reference: a clock
 * that advances 1ms per read from a fixed base (valid ISO-8601, reproducible), a counter id source, an
 * {@link InMemoryRunStore}, and a manual timer fired by hand (exposed as {@link fireTimers}/
 * {@link armedCount}). A real surface injects wall-clock/UUID/`setTimeout` sources instead.
 */
/**
 * The reference {@link TerminalOutbox} — in memory, so it survives nothing, which is the point of saying so.
 *
 * ADR-0078 §4 chose a host-owned outbox precisely so a REAL host can put it somewhere the store's fault
 * cannot reach (a separate file). This one exists to make the port required without breaking every test
 * double, and to give the engine's own tests something to assert against. A surface that ships this as its
 * outbox has the guarantee in name only — the entries die with the process that could not write them.
 */
export function createInMemoryTerminalOutbox(): TerminalOutbox {
  const held = new Map<string, RunEvent>();
  return {
    put: (event) => {
      if (event.runId !== undefined) held.set(event.runId, event);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...held.values()]),
    remove: (runId) => {
      held.delete(runId);
      return Promise.resolve();
    },
  };
}

/**
 * The reference {@link RunLeasePort} — in memory, so it guards nothing across processes, which is the point
 * of saying so.
 *
 * ADR-0079 chose a DURABLE lease precisely so two processes can be told apart; this one exists to make the
 * port required without breaking every test double, and to give the engine's own tests a deterministic
 * clock. A surface that ships this has the guarantee in name only.
 *
 * `now` is injected rather than read from an ambient clock so a test can drive expiry without waiting.
 */
/** The in-memory {@link RunLeasePort} plus the synchronous peek {@link InMemoryRunStore} needs. */
export type InMemoryRunLeases = RunLeasePort & {
  /**
   * The held lease, read SYNCHRONOUSLY — for {@link InMemoryRunStore}'s fence rule, which sits inside a
   * `persistEvent` that must stay synchronous-returning. `read` is the async port method a surface uses;
   * this is the same state without the microtask, which the store cannot afford to spend without changing
   * the delivery ordering every engine test depends on.
   */
  peek: (runId: string) => { ownerId: string; generation: number } | undefined;
};

export function createInMemoryRunLeases(now: () => number = () => Date.now()): InMemoryRunLeases {
  const held = new Map<string, RunLeaseInfo>();
  const readLive = (runId: string): RunLeaseInfo | undefined => {
    const lease = held.get(runId);
    return lease === undefined ? undefined : { ...lease, live: lease.expiresAt > now() };
  };
  return {
    acquire: (runId, ownerId, ttlMs) => {
      const current = readLive(runId);
      // A DIFFERENT owner holding a LIVE lease is the only refusal — same owner is a renewal, expired is a
      // takeover. Identical to the SQLite store's rule; a reference that diverges proves nothing.
      if (current !== undefined && current.ownerId !== ownerId && current.live) {
        return Promise.resolve(undefined);
      }
      const generation = (current?.generation ?? 0) + 1;
      held.set(runId, { runId, ownerId, generation, expiresAt: now() + ttlMs, live: true });
      return Promise.resolve({ ownerId, generation });
    },
    heartbeat: (runId, fence, ttlMs) => {
      const current = held.get(runId);
      if (
        current === undefined ||
        current.ownerId !== fence.ownerId ||
        current.generation !== fence.generation
      ) {
        return Promise.resolve(false); // taken over — the heartbeat is how the loser finds out
      }
      held.set(runId, { ...current, expiresAt: now() + ttlMs });
      return Promise.resolve(true);
    },
    release: (runId, fence) => {
      const current = held.get(runId);
      // Scoped to (owner, generation) so a fenced-out process cannot free the new holder's lease on the way
      // down — a release must never steal.
      if (
        current !== undefined &&
        current.ownerId === fence.ownerId &&
        current.generation === fence.generation
      ) {
        held.delete(runId);
      }
      return Promise.resolve();
    },
    read: (runId) => Promise.resolve(readLive(runId)),
    peek: (runId) => {
      const lease = held.get(runId);
      return lease === undefined
        ? undefined
        : { ownerId: lease.ownerId, generation: lease.generation };
    },
  };
}

/** Whether a port carries the synchronous {@link InMemoryRunLeases.peek} the reference store's fence needs. */
function isInMemoryRunLeases(port: RunLeasePort | undefined): port is InMemoryRunLeases {
  return port !== undefined && 'peek' in port && typeof port.peek === 'function';
}

/**
 * Pick the lease port for an in-memory-backed host AND bind it to the store, so the fence is really enforced.
 *
 * **An INJECTED port is bound too, and that is the point.** Binding only the defaulted one meant a fixture
 * that passed its own `runLeases` silently ran with fence enforcement OFF — green for exactly the reason
 * this whole mechanism exists to eliminate. `bindLeases` is `??=`, so two hosts that each mint a port over
 * one store still share the FIRST table: that is what models reality, where one `history.db` has one
 * `run_leases` table no matter how many processes write it.
 *
 * A port with no `peek` (the real SQLite `createRunLeasePort`) is not bindable and leaves the store
 * unbound — correct, because such a fixture is pairing the reference store with a durable lease table and
 * the store cannot consult it synchronously.
 */
export function resolveInMemoryLeases(
  store: RunStore,
  injected: RunLeasePort | undefined,
  now: () => number,
): RunLeasePort {
  if (!(store instanceof InMemoryRunStore)) return injected ?? createInMemoryRunLeases(now);
  const candidate = isInMemoryRunLeases(injected) ? injected : undefined;
  if (injected !== undefined && candidate === undefined) return injected; // durable port, not bindable
  const bound = store.bindLeases(candidate ?? createInMemoryRunLeases(now));
  if (candidate !== undefined && bound !== candidate) {
    throw new Error(
      "resolveInMemoryLeases: this store is already bound to a DIFFERENT lease port — two hosts over one store must share one lease table, or neither can recognise the other's fences",
    );
  }
  return bound;
}

/**
 * The in-memory reference {@link EffectDispatchPort} (ADR-0080) — for a fixture that genuinely DOES dispatch
 * effects, where `unwiredEffectJournal()` would correctly refuse.
 *
 * It enforces the same UNIQUE identity the SQLite journal does, for the reason every reference in this file
 * enforces its real counterpart's rule: a reference that accepts what the real store rejects makes every
 * `packages/core` test prove nothing.
 */
export function createInMemoryEffectJournalStore(): {
  /** A port for one correlation — every port from this store shares ONE row table, as one `history.db` does. */
  readonly for: (correlation: EffectCorrelation) => EffectDispatchPort;
  /** The READ half the resume gate consumes, over the same rows (effect-journal.md §4). */
  readonly resume: EffectResumePort;
  readonly rows: () => readonly {
    scope: string;
    slot: EffectSlot;
    toolId: string;
    tier: EffectTier;
    state: EffectState;
    result?: unknown;
  }[];
} {
  interface Row {
    scope: string;
    slot: EffectSlot;
    toolId: string;
    tier: EffectTier;
    state: EffectState;
    /** A stand-in for the host's SHA-256: only EQUALITY matters, and core cannot hash (engine purity). */
    argsKey: string;
    /**
     * The retained result AS JSON TEXT, exactly as `run_effects.result_json` holds it — never the live
     * object.
     *
     * Holding the object by reference made this reference store strictly more capable than the real one, and
     * a review found what that hid: `JSON.stringify` DELETES a property whose value is `undefined`, so a
     * legitimately-`undefined` tool result came back from SQLite as a metadata object and replayed as that
     * object. Every core test over the replay gate passed, because none of them crossed a JSON boundary.
     */
    resultJson?: string;
  }
  const rows = new Map<string, Row>();
  const key = (scope: string, slot: EffectSlot, toolId: string): string =>
    `${scope}|${String(slot)}|${toolId}`;
  return {
    for: (correlation) => {
      const scope = effectScope(correlation);
      return {
        prepare: (slot, toolId, tier, redactedArgs) => {
          const held = rows.get(key(scope, slot, toolId));
          const argsKey = JSON.stringify(redactedArgs) ?? 'undefined';
          if (held !== undefined) {
            // The SAME three-part test the real store applies (§4's replay row). A reference that accepted
            // what SQLite refuses — or refused what it replays — would make every core test over the gate
            // vacuous; this repo has been bitten by exactly that divergence before.
            if (
              held.state === 'committed' &&
              held.argsKey === argsKey &&
              held.resultJson !== undefined
            ) {
              // Parsed back, exactly as the real store does — so a value that does not survive the round
              // trip fails HERE, in core, rather than only against SQLite in `apps/cli`.
              return Promise.resolve({
                outcome: 'replay',
                result: JSON.parse(held.resultJson) as unknown,
              });
            }
            return Promise.reject(new EffectConflictError({ scope, slot, toolId }));
          }
          rows.set(key(scope, slot, toolId), {
            scope,
            slot,
            toolId,
            tier,
            state: 'prepared',
            argsKey,
          });
          return Promise.resolve({ outcome: 'proceed' });
        },
        settle: (slot, toolId, state, result) => {
          const row = rows.get(key(scope, slot, toolId));
          // Only out of `prepared`, mirroring the store: `committed → ambiguous` would claim we do not know
          // what the target did while retaining the result proving we do.
          //
          // …and a settle that moves NOTHING is refused loudly, exactly as the SQLite store now refuses it.
          // Leaving durable truth alone is right; reporting that the transition happened is not — the effect
          // may have landed and the record does not say so, which is the one condition
          // `ToolEffectNeedsAttentionError` exists for.
          if (row?.state !== 'prepared') {
            return Promise.reject(new EffectTransitionError({ scope, slot, toolId }, state, 0));
          }
          {
            // Serialized on the way in, as `resultJson: JSON.stringify(result)` does in the SQLite store.
            const resultJson = result === undefined ? undefined : JSON.stringify(result);
            rows.set(key(scope, slot, toolId), {
              ...row,
              state,
              ...(resultJson === undefined ? {} : { resultJson }),
            });
          }
          return Promise.resolve();
        },
      };
    },
    resume: {
      unresolvedForRun: (runId) => {
        const prefix = `run:${encodeURIComponent(runId)}:`;
        return Promise.resolve(
          [...rows.values()]
            // `blocksResume` reads `{ state, result }`, and the row holds the result as JSON TEXT now — so
            // it is parsed back for the predicate. Passing the row directly made `result` permanently
            // `undefined`, which read as "every committed row blocks", the opposite of the truth.
            .filter(
              (row) =>
                row.scope.startsWith(prefix) &&
                blocksResume({
                  state: row.state,
                  ...(row.resultJson === undefined
                    ? {}
                    : { result: JSON.parse(row.resultJson) as unknown }),
                }),
            )
            .map((row) => ({
              identity: { scope: row.scope, slot: row.slot, toolId: row.toolId },
              state: row.state,
              tier: row.tier,
              nodeId: nodeIdFromRunScope(row.scope) ?? '(unknown node)',
            })),
        );
      },
    },
    // `argsKey` is the reference's stand-in for the host's digest and is deliberately NOT exposed: a test
    // asserting on it would be asserting on a fixture detail the real store does not share.
    rows: () =>
      [...rows.values()].map((row) => ({
        scope: row.scope,
        slot: row.slot,
        toolId: row.toolId,
        tier: row.tier,
        state: row.state,
        ...(row.resultJson === undefined ? {} : { result: JSON.parse(row.resultJson) as unknown }),
      })),
  };
}

export function createInMemoryEffectJournal(correlation: EffectCorrelation): EffectDispatchPort & {
  /** Test/inspection helper — the rows written, in write order. */
  readonly rows: () => readonly {
    slot: EffectSlot;
    toolId: string;
    tier: EffectTier;
    state: EffectState;
    result?: unknown;
  }[];
} {
  // Built ON the shared store rather than duplicating it, so the one-correlation convenience can never
  // diverge from the many-correlation reality a `history.db` actually is.
  const store = createInMemoryEffectJournalStore();
  return { ...store.for(correlation), rows: () => store.rows() };
}

export function createInMemoryHost(options?: {
  store?: RunStore;
  checkpointer?: Checkpointer;
  baseEpochMs?: number;
  /** Inject a media store so a run that produces media de-inlines it (1.AF); omit for a text-only host. */
  mediaStore?: MediaStore;
  /** Inject a media-egress fetch so a `url` media source is re-hosted (1.AF/D9); omit to hard-fail urls. */
  fetchMedia?: HostMediaFetch;
  /** Inject a media-reference lifecycle port so produced handles are recorded + reclaimed (1.AF/D12c+D11). */
  mediaReferences?: MediaReferencePort;
  /** Inject a media-write port so an `output` node's `save_to` writes its produced media (1.AF/D16). */
  mediaWrite?: MediaWritePort;
  /** Inject a terminal outbox (ADR-0078 §4); omit for the in-memory reference below. */
  terminalOutbox?: TerminalOutbox;
  /** Inject a run-lease port (ADR-0079); omit for the in-memory reference, which shares this host's clock. */
  runLeases?: RunLeasePort;
}): ExecutionHost & { store: RunStore; terminalOutbox: TerminalOutbox } & Pick<
    ManualTimerController,
    'fireTimers' | 'armedCount' | 'fireLiveness' | 'livenessCount'
  > {
  let tick = options?.baseEpochMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  let idCounter = 0;
  const store = options?.store ?? new InMemoryRunStore();
  const timers = createManualTimerController();
  // The reference lease shares this host's clock, so a test that advances `tick` also ages the lease — note
  // `createInMemoryHost`'s clock ADVANCES on every read, so a TTL assertion must pin its own.
  const leases = resolveInMemoryLeases(store, options?.runLeases, () => tick);
  return {
    clock: { now: () => new Date(tick++).toISOString() },
    ids: { newId: () => `id-${++idCounter}` },
    store,
    checkpointer: options?.checkpointer ?? createInMemoryCheckpointer(store),
    newAbortController: createAbortController,
    setTimer: timers.setTimer,
    ...(options?.mediaStore ? { mediaStore: options.mediaStore } : {}),
    ...(options?.fetchMedia ? { fetchMedia: options.fetchMedia } : {}),
    ...(options?.mediaReferences ? { mediaReferences: options.mediaReferences } : {}),
    ...(options?.mediaWrite ? { mediaWrite: options.mediaWrite } : {}),
    terminalOutbox: options?.terminalOutbox ?? createInMemoryTerminalOutbox(),
    runLeases: leases,
    fireTimers: timers.fireTimers,
    armedCount: timers.armedCount,
    fireLiveness: timers.fireLiveness,
    livenessCount: timers.livenessCount,
  };
}

/**
 * The in-memory reference {@link Checkpointer}: reconstructs from an {@link InMemoryRunStore}'s event log
 * ({@link reconstructCheckpointState}). For any other (opaque) store it returns `undefined` — a custom
 * store must supply its own checkpointer. Deterministic + dependency-free, for the engine tests.
 */
export function createInMemoryCheckpointer(store: RunStore): Checkpointer {
  return {
    load: (runId) =>
      Promise.resolve(
        store instanceof InMemoryRunStore
          ? reconstructCheckpointState(store.eventsFor(runId))
          : undefined,
      ),
  };
}
