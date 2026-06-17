/**
 * `SessionHandle` + `createSessionEventSink` (1.W) — the session counterpart of {@link RunHandle},
 * wiring `AgentSession`'s ([ADR-0024](../../../../docs/decisions/0024-agent-first-entry-point-agentsession.md))
 * injected {@link SessionEventSink} onto the **one shared** {@link RunEventBus}
 * ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) "one bus,
 * two namespaces"). `AgentSession` emits *envelope-free* drafts; {@link createSessionEventSink} attaches the
 * `sessionId`, and the bus stamps the **per-session** `sequenceNumber` + `timestamp` at its one authoritative
 * translation point (the per-`sessionId` counter is independent of any run's per-`runId` counter on the same
 * bus). {@link createSessionHandle} exposes the session's stream + cancel, mirroring `createRunHandle`.
 *
 * Terminal semantics differ from a run: a session is **long-lived across turns**, so the stream stays open
 * across `session:turn_completed` (a per-turn boundary, not a terminal) and closes **only** on
 * `session:cancelled` — the session's sole terminal (`session:exported` is a 1.Z side event, never a
 * terminal). See [sse-event-schema.md](../../../../docs/reference/contracts/sse-event-schema.md) §"The session
 * stream".
 */

import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentTokenEvent,
  CostUpdatedEvent,
  RunOrSessionEvent,
  SessionEvent,
} from '@relavium/shared';

import type { SessionEventSink } from './agent-session.js';
import type { RunEventBus } from './event-bus.js';
import { BoundedEventStream, DEFAULT_STREAM_CAPACITY } from './event-stream.js';

/**
 * The fully-stamped events a session stream carries: the five `session:*` lifecycle events plus the four
 * dual-envelope in-turn events (`agent:token` / `agent:tool_call` / `agent:tool_result` / `cost:updated`),
 * here carrying `sessionId`. The complete session stream per sse-event-schema.md §"Session event namespace".
 */
export type SessionStreamHandleEvent =
  | SessionEvent
  | AgentTokenEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | CostUpdatedEvent;

/** The session's sole stream terminal — `turn_completed` is per-turn; `exported` (1.Z) is a side event. */
const TERMINAL_SESSION_TYPES: ReadonlySet<SessionStreamHandleEvent['type']> = new Set([
  'session:cancelled',
]);

/** True iff `event` carries this session's `sessionId` — narrows the bus union to the session stream. */
function isForSession(event: RunOrSessionEvent, sessionId: string): event is SessionStreamHandleEvent {
  return 'sessionId' in event && event.sessionId === sessionId;
}

/** The handle a surface holds for an agent session — its id, event stream, and cooperative cancel. */
export interface SessionHandle {
  /** The session id (`sessionId`) this handle observes — the key on every event in its stream. */
  readonly sessionId: string;
  /** The canonical session event stream; stays open across turns, completes on `session:cancelled`. */
  readonly events: AsyncIterable<SessionStreamHandleEvent>;
  /** Attach an additional passive observer (cost / UI); returns an idempotent unsubscribe. */
  subscribe: (listener: (event: SessionStreamHandleEvent) => void) => () => void;
  /** Request cooperative cancellation of the in-flight turn / session (delegates to `AgentSession.cancel`). */
  cancel: () => void;
  /** Resolves when the primary consumer's buffer has drained below capacity — a backpressure knob. */
  whenConsumersReady: () => Promise<void>;
}

/**
 * The injected {@link SessionEventSink} implemented over the bus: `AgentSession` hands it an envelope-free
 * draft (no `sessionId`), this attaches the `sessionId`, and `bus.emit` stamps the per-session
 * `sequenceNumber` + `timestamp` and validates against the combined run+session gate. The single
 * producer-side translation point for a session (the run-side counterpart is the engine's `#emitDurable`).
 */
export function createSessionEventSink(bus: RunEventBus, sessionId: string): SessionEventSink {
  return (event) => {
    // `agent:file_patch_proposed` is a RUN-ONLY event (`...runBase`, requires `runId`) emitted by the
    // AgentRunner workflow adapter — a "run-only concern … never here" for the shared turn core
    // (agent-turn.ts), so a session never actually emits it. It is the one `NodeStreamEvent` arm with no
    // session-carrying schema member, so it could not validate on the bus. Drop it at this single
    // translation point — the contract boundary 1.W owns — keeping the session stream to its
    // sse-event-schema.md contract (the five `session:*` + the four dual `agent:*`/`cost:updated`).
    if (event.type === 'agent:file_patch_proposed') {
      return;
    }
    // Attach the correlation key; the bus then stamps the per-session sequenceNumber + timestamp and
    // validates against the combined RunOrSessionEventSchema. After the guard the body is a `session:*`
    // lifecycle body or one of the four dual `agent:*`/`cost:updated` bodies, so `+ sessionId` is a
    // BusEventDraft the session-side `emit` overload accepts (a session lifecycle → `SessionEventDraft`,
    // a dual body → the optional-`sessionId` `RunEventDraft` arm). The bus stamps and returns it.
    bus.emit({ ...event, sessionId });
  };
}

/**
 * Wire a {@link SessionHandle} over a bus, scoped to `sessionId`. Subscribes the primary stream at
 * construction (before `session:started`); on `session:cancelled` closes the stream and unsubscribes so the
 * `for await` completes exactly once and nothing leaks. The filter scopes to this session even on a bus
 * shared with runs/other sessions (ADR-0036).
 */
export function createSessionHandle(
  bus: RunEventBus,
  sessionId: string,
  cancel: () => void,
  capacity: number = DEFAULT_STREAM_CAPACITY,
): SessionHandle {
  const primary = new BoundedEventStream<SessionStreamHandleEvent>(capacity);
  const unsubscribe = bus.subscribe((event) => {
    if (!isForSession(event, sessionId)) {
      return; // not this session's event (a run event, or another session)
    }
    primary.push(event);
    if (TERMINAL_SESSION_TYPES.has(event.type)) {
      primary.close();
      unsubscribe();
    }
  });
  return {
    sessionId,
    events: primary,
    subscribe: (listener) =>
      bus.subscribe((event) => {
        if (isForSession(event, sessionId)) {
          listener(event);
        }
      }),
    cancel,
    whenConsumersReady: () => primary.whenDrained(),
  };
}
