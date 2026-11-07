import type { GateDecision } from '@relavium/shared';

import type { GateType } from './node-executor.js';

/**
 * The decisions a human gate of each type accepts (2.6.K, ruled by the maintainer on 2026-11-05): an `approval`
 * or `review` gate is approved or rejected; an `input` gate takes its input or is rejected. A budget gate has its
 * own rules (`budgetApprovalAmount`).
 */
const DECISIONS_BY_GATE_TYPE: Readonly<Record<GateType, readonly GateDecision['decision'][]>> = {
  approval: ['approved', 'rejected'],
  review: ['approved', 'rejected'],
  input: ['input_provided', 'rejected'],
};

/** Whether a human gate of `gateType` accepts a decision of this kind. */
export function gateAcceptsDecision(
  gateType: GateType,
  decision: GateDecision['decision'],
): boolean {
  return DECISIONS_BY_GATE_TYPE[gateType].includes(decision);
}

/** The decision kinds a human gate of `gateType` accepts, for an actionable refusal. */
export function decisionsForGateType(gateType: GateType): readonly GateDecision['decision'][] {
  return DECISIONS_BY_GATE_TYPE[gateType];
}
