import {
  decisionsForGateType,
  reconstructCheckpointState,
  type CheckpointState,
} from '@relavium/core';
import type { GateDecision, HumanGatePausedEvent, RunEvent } from '@relavium/shared';
import { budgetPromptContext, resumeCommandBase, type BudgetPromptContext } from './budget.js';
import { FLAG_FOR_DECISION } from './decision.js';

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
 * resume path cannot disagree on the FOLD (they deliberately differ on the READ — ADR-0075 makes the resume refuse a log a display still shows, so a discovery surface may list a gate `relavium gate` will decline) on what is pending. Budget gates (`isBudgetGate`) are excluded — those are the
 * `relavium budget resume` surface (ADR-0028), not human gates. Each pending gate's display detail (`gateType`,
 * `message`, `expiresAt`) comes from its own `human_gate:paused` event, so an operator sees what to resolve.
 */
export function pendingHumanGates(events: readonly RunEvent[]): PendingGate[] {
  return pendingGateDisplays(events).pendingGates;
}

/** The label each decision's copyable command carries in `status`, beside the budget hints' `approve:` / `reject:`. */
const HINT_LABEL: Readonly<Record<GateDecision['decision'], string>> = {
  approved: 'approve',
  rejected: 'reject',
  input_provided: 'input',
};

/**
 * The commands that continue a pending human gate, one per decision its type accepts (`decisionsForGateType`) —
 * the human-gate counterpart of `budgetResumeHints`, under the same rule: a copyable command is built only from
 * unchanged, shell-inert recorded identifiers (`resumeCommandBase`), and any other identifier gets a sentence
 * naming the flags instead. An input gate's value is the operator's to supply, so its line keeps the `<json>`
 * placeholder, which a shell refuses to run as pasted rather than resolving the gate with it.
 */
export function humanGateResumeHints(
  runId: string,
  gateId: string,
  gateType: PendingGate['gateType'],
): readonly string[] {
  const decisions = decisionsForGateType(gateType);
  const command = resumeCommandBase('human', runId, gateId);
  if (command === undefined) {
    const flags = decisions.map((decision) => FLAG_FOR_DECISION[decision]).join(' or ');
    return [`Use relavium gate with the recorded run and gate IDs and ${flags}.`];
  }
  return decisions.map(
    (decision) => `${HINT_LABEL[decision]}: ${command} ${FLAG_FOR_DECISION[decision]}`,
  );
}

/**
 * The nodes whose latest gate event is a decision: a `human_gate:resumed` after the node last started or parked. The
 * projection never closes a human gate's step row (no `node:completed` follows the decision, though the engine marks
 * the gate vertex completed), so `status` reads the decision here. A node that starts or parks again, as a loop does,
 * is undecided until its next decision. A budget gate's events name its agent node, which `status` does not relabel.
 */
export function decidedGateNodes(events: readonly RunEvent[]): ReadonlySet<string> {
  const decided = new Set<string>();
  for (const event of events) {
    if (event.type === 'node:started' || event.type === 'human_gate:paused') {
      decided.delete(event.nodeId);
    } else if (event.type === 'human_gate:resumed') {
      decided.add(event.nodeId);
    }
  }
  return decided;
}

export interface PendingBudgetGate {
  readonly gateId: string;
  readonly nodeId: string;
  readonly allowance: BudgetPromptContext;
  readonly expiresAt?: string;
}

/** A read-only scalar projection, including authority-only crash prefixes; it cannot authorize a resume. */
export function pendingGateDisplays(events: readonly RunEvent[]): {
  pendingGates: PendingGate[];
  pendingBudgetGates: PendingBudgetGate[];
} {
  const checkpoint = reconstructCheckpointState(events);
  if (checkpoint === undefined) return { pendingGates: [], pendingBudgetGates: [] };
  return {
    pendingGates: humanGateDisplays(events, checkpoint),
    pendingBudgetGates: checkpoint.pendingGates
      .filter((gate) => gate.isBudgetGate)
      .map((gate) => ({
        gateId: gate.gateId,
        nodeId: gate.nodeId,
        allowance: budgetPromptContext(gate.allowance),
        ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
      })),
  };
}

function humanGateDisplays(
  events: readonly RunEvent[],
  checkpoint: CheckpointState,
): PendingGate[] {
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
  const result: PendingGate[] = [];
  for (const gate of pending) {
    const paused = pausedByGate.get(gate.gateId);
    // Invariant: a non-budget pending gate was folded FROM a `human_gate:paused` event, so its detail is
    // always present. If it somehow is not (a corrupt/hand-edited log), OMIT the gate rather than fabricate a
    // `gateType` — a wrong type would mislead an operator into passing the wrong `relavium gate` flag.
    if (paused === undefined) {
      continue;
    }
    result.push({
      gateId: gate.gateId,
      nodeId: gate.nodeId,
      gateType: paused.gateType,
      message: paused.message,
      ...(paused.expiresAt === undefined ? {} : { expiresAt: paused.expiresAt }),
    });
  }
  return result;
}
