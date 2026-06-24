import { reconstructCheckpointState } from '@relavium/core';
import type { HumanGatePausedEvent, RunEvent } from '@relavium/shared';

/** A pending human gate on a paused run — the discovery row `relavium gate list` / `status` surface (2.I). */
export interface PendingGate {
  readonly gateId: string;
  readonly nodeId: string;
  /** The gate kind (`approval` / `input` / `review`), reused from the event type (no separate enum export). */
  readonly gateType: HumanGatePausedEvent['gateType'];
  readonly message: string;
  readonly expiresAt?: string;
}

/**
 * The human gates still pending on a run, derived from its persisted event log — the same authoritative
 * reconstruction `relavium gate` resumes from (`reconstructCheckpointState`), so `gate list`/`status` and the
 * resume path can never disagree on what is pending. Budget gates (`isBudgetGate`) are excluded — those are the
 * `relavium budget resume` surface (ADR-0028), not human gates. Each pending gate's display detail (`gateType`,
 * `message`, `expiresAt`) comes from its own `human_gate:paused` event, so an operator sees what to resolve.
 */
export function pendingHumanGates(events: readonly RunEvent[]): PendingGate[] {
  const checkpoint = reconstructCheckpointState(events);
  if (checkpoint === undefined) {
    return [];
  }
  const pending = checkpoint.pendingGates.filter((gate) => !gate.isBudgetGate);
  if (pending.length === 0) {
    return [];
  }
  // A pending gate was raised by a `human_gate:paused` event; index the latest one per gateId for its detail.
  const pausedByGate = new Map<string, Extract<RunEvent, { type: 'human_gate:paused' }>>();
  for (const event of events) {
    if (event.type === 'human_gate:paused') {
      pausedByGate.set(event.gateId, event);
    }
  }
  return pending.map((gate): PendingGate => {
    const paused = pausedByGate.get(gate.gateId);
    return {
      gateId: gate.gateId,
      nodeId: gate.nodeId,
      gateType: paused?.gateType ?? 'approval',
      message: paused?.message ?? '',
      ...(paused?.expiresAt === undefined ? {} : { expiresAt: paused.expiresAt }),
    };
  });
}
