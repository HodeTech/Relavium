/**
 * `RunEventBus` (1.N) — the engine's **in-house, platform-free** typed pub/sub over the
 * `@relavium/shared` `RunEvent` union ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)).
 * It is deliberately **not** a Node `EventEmitter` (`node:events` is banned in `packages/core/src` by
 * the engine-purity fence — CLAUDE.md rule 5) and **not** a third-party emitter (a new engine runtime
 * dependency would need its own ADR — rule 2). A typed pub/sub over a closed discriminated union is
 * trivial to own and types directly on `RunEvent`, which a loosely-typed library cannot.
 *
 * This is the **single producer-side translation point** the ADR mandates: the one site that assigns
 * the **monotonic, gap-free `sequenceNumber`** (per correlation key — `runId` for a run, `sessionId`
 * for a session) and the ISO-8601 `timestamp`, and the one validation gate (every event is checked
 * against `RunOrSessionEventSchema` before delivery unless a host opts out on a hot path). Callers hand
 * the bus an *envelope-less* {@link RunEventDraft}; the bus stamps the envelope. Secret masking / `toolInput`
 * sanitization happen *upstream* of the bus (the engine masks `run:started.inputs`; a node sanitizes
 * its own `toolInput`) — the bus's job is the envelope + validation, not redaction.
 *
 * Subscribers are **passive consumers** (cost, UI, persistence-as-observer): a subscriber throwing is
 * isolated so it can neither corrupt the sequence nor break sibling subscribers or the producer — and
 * it is **never silently swallowed** (docs/standards/error-handling.md): it is routed to
 * `onListenerError`, or re-thrown out-of-band on a microtask so it surfaces as an unhandled rejection.
 */

import {
  RunOrSessionEventSchema,
  type RunEvent,
  type RunOrSessionEvent,
  type SessionEvent,
} from '@relavium/shared';

/** Distribute `Omit` across each member of a union so the discriminated union is preserved. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A **run** event minus the envelope fields the bus stamps centrally (`timestamp`, `sequenceNumber`). The
 * producer — the `WorkflowEngine` — supplies the type, the `runId`, and the payload; the bus assigns the
 * rest. Distributive, so each union member keeps its own required payload shape. Deliberately **run-precise**
 * (not the wide bus union) so the run loop keeps `RunEvent` typing end to end — `next`/`emit` map a run draft
 * back to a `RunEvent`, so e.g. a terminal-type check stays narrow.
 */
export type RunEventDraft = DistributiveOmit<RunEvent, 'timestamp' | 'sequenceNumber'>;

/**
 * A **session** event minus the stamped envelope — what the `AgentSession`→bus sink (1.W,
 * {@link ./session-handle.ts}) supplies after attaching the `sessionId`. The session counterpart of
 * {@link RunEventDraft}; `next`/`emit` map it back to a `SessionEvent`.
 */
export type SessionEventDraft = DistributiveOmit<SessionEvent, 'timestamp' | 'sequenceNumber'>;

/**
 * Either draft — the full set the **one shared bus** accepts (ADR-0036 "one bus, two namespaces"). Each
 * producer keeps its precise draft type (run / session); this is the bus's correlation-key-agnostic union,
 * the type the `next`/`emit` implementation (and the {@link RunEventBusOptions} hot path) is written against.
 */
export type BusEventDraft = RunEventDraft | SessionEventDraft;

/**
 * A **run-scoped** subscriber — the listener type `RunHandle.subscribe` exposes; it only ever sees its
 * own run's events (the handle filters by `runId`), so it stays typed on the narrower `RunEvent`.
 */
export type RunEventListener = (event: RunEvent) => void;

/**
 * A **bus** subscriber — sees the full `RunEvent | SessionEvent` stream the one shared bus carries. The
 * per-correlation handles (`RunHandle` / `SessionHandle`) wrap this, filtering to their own key.
 */
export type BusEventListener = (event: RunOrSessionEvent) => void;

export interface RunEventBusOptions {
  /** Injected ISO-8601 timestamp source (the host clock) — keeps the bus platform-free + testable. */
  readonly now: () => string;
  /**
   * Validate every event against `RunOrSessionEventSchema` (the combined run+session gate) before
   * delivery (default `true`). A host may pass `false` to skip validation on a high-frequency hot path
   * (e.g. `agent:token` floods) in production; tests and the conformance suite keep it on. Even off, the
   * `sequenceNumber`/envelope are still stamped — only the Zod check is skipped.
   */
  readonly validate?: boolean;
  /**
   * Sink for a subscriber that throws. If unset, the error is re-thrown out-of-band (on a microtask)
   * so it surfaces as an unhandled rejection rather than being swallowed — the producer and sibling
   * subscribers are never affected either way.
   */
  readonly onListenerError?: (error: unknown, event: RunOrSessionEvent) => void;
}

/** The correlation key of a draft — `runId` on a run, `sessionId` on a session (exactly one). */
function correlationKey(draft: BusEventDraft): string | undefined {
  if ('runId' in draft && draft.runId !== undefined) {
    return draft.runId;
  }
  if ('sessionId' in draft && draft.sessionId !== undefined) {
    return draft.sessionId;
  }
  return undefined;
}

export class RunEventBus {
  readonly #now: () => string;
  readonly #validate: boolean;
  readonly #onListenerError: ((error: unknown, event: RunOrSessionEvent) => void) | undefined;
  readonly #listeners = new Set<BusEventListener>();
  /** Per-correlation-key sequence counters — the single authoritative monotonic source. */
  readonly #sequence = new Map<string, number>();

  constructor(options: RunEventBusOptions) {
    this.#now = options.now;
    this.#validate = options.validate ?? true;
    this.#onListenerError = options.onListenerError;
  }

  /**
   * Stamp a draft into a full, validated event (a `RunEvent` on a run draft, a `SessionEvent` on a session
   * draft — the overloads keep the producer's precise type) — assigning the next `sequenceNumber` for its
   * correlation key and the `timestamp` — **without** delivering it. Split from {@link deliver} so the
   * engine can `await` a durable persist between stamping and delivery for a node-boundary / terminal
   * event (persistence-before-delivery, ADR-0036) while the `sequenceNumber` is still assigned here, at
   * the one authoritative point. The counter increments only on a successful stamp.
   */
  next(draft: RunEventDraft): RunEvent;
  next(draft: SessionEventDraft): SessionEvent;
  next(draft: BusEventDraft): RunOrSessionEvent;
  next(draft: BusEventDraft): RunOrSessionEvent {
    const key = correlationKey(draft);
    if (key === undefined) {
      // Internal invariant: the engine always sets exactly one correlation key. Guarded so a bug
      // surfaces loudly here rather than as a mis-keyed (and therefore ungapped) sequence.
      throw new Error('RunEventBus.next: event draft has neither runId nor sessionId');
    }
    const sequenceNumber = this.#sequence.get(key) ?? 0;
    // Re-adding the two envelope fields the draft omitted reconstitutes a full event — TS infers the
    // union back, so no assertion is needed; the optional Zod parse (the combined run+session gate) is
    // the runtime check.
    const candidate = { ...draft, timestamp: this.#now(), sequenceNumber };
    const event = this.#validate ? RunOrSessionEventSchema.parse(candidate) : candidate;
    this.#sequence.set(key, sequenceNumber + 1);
    return event;
  }

  /**
   * Seed the next `sequenceNumber` for a correlation key — used ONLY when rehydrating a run from a
   * checkpoint (1.R), so events emitted after resume continue gap-free from the last persisted seq.
   * Idempotent before any `next(key)`; never lower an already-advanced counter (a no-op guard).
   */
  seedSequence(key: string, next: number): void {
    const current = this.#sequence.get(key) ?? 0;
    if (next > current) {
      this.#sequence.set(key, next);
    }
  }

  /** Fan a fully-stamped event out to every subscriber, isolating a throwing subscriber. */
  deliver(event: RunOrSessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#reportListenerError(error, event);
      }
    }
  }

  /** Stamp and deliver in one step — for a transient (non-durable) event such as `agent:token`. */
  emit(draft: RunEventDraft): RunEvent;
  emit(draft: SessionEventDraft): SessionEvent;
  emit(draft: BusEventDraft): RunOrSessionEvent;
  emit(draft: BusEventDraft): RunOrSessionEvent {
    const event = this.next(draft);
    this.deliver(event);
    return event;
  }

  /** Subscribe a passive consumer; returns an idempotent unsubscribe. */
  subscribe(listener: BusEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #reportListenerError(error: unknown, event: RunOrSessionEvent): void {
    if (this.#onListenerError !== undefined) {
      try {
        this.#onListenerError(error, event);
        return;
      } catch (sinkError) {
        // The sink itself threw — it must NEVER bubble back into deliver() and break the producer or
        // sibling subscribers. Surface the secondary failure out-of-band instead.
        this.#surfaceOutOfBand(sinkError);
        return;
      }
    }
    // No sink: surface out-of-band rather than swallow (no-silent-catch) and without breaking the
    // producer or sibling subscribers.
    this.#surfaceOutOfBand(error);
  }

  /**
   * Re-throw out-of-band on a microtask so it becomes an observable unhandled rejection — the ES-only
   * (no DOM/Node lib) equivalent of `queueMicrotask`, never breaking the in-progress `deliver()`.
   */
  #surfaceOutOfBand(error: unknown): void {
    void Promise.resolve().then(() => {
      throw error;
    });
  }
}
