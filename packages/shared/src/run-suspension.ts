/** Provider-free ordered suspension history shared by checkpoint and interruption discovery. */
import type { BudgetAllowanceState, BudgetAuthorizationState } from './budget-authorization.js';
import type {
  RunEvent,
  HumanGatePausedEvent,
  HumanGateResumedEvent,
  MediaJobSubmittedEvent,
} from './run-event.js';
import { deepStructuralEquals } from './deep-equal.js';

type Identity = Pick<HumanGatePausedEvent, 'runId' | 'nodeId' | 'gateId'>;
type Deadline = Pick<HumanGatePausedEvent, 'timeoutMs' | 'timeoutAction' | 'expiresAt'>;
type PausedAuthority = Extract<BudgetAuthorizationState, { state: 'paused' }>;
type DecidedAuthority = Extract<BudgetAuthorizationState, { state: 'decided' }>;
type BudgetPause = Extract<RunEvent, { type: 'budget:paused' }>;
export type RunSuspensionCorruption =
  | 'gate_identity_conflict'
  | 'gate_state_conflict'
  | 'legacy_gate_join_missing'
  | 'legacy_gate_join_ambiguous';
export class RunSuspensionCorruptionError extends Error {
  readonly code: RunSuspensionCorruption;
  constructor(code: RunSuspensionCorruption) {
    super('the stored gate history is inconsistent');
    this.name = 'RunSuspensionCorruptionError';
    this.code = code;
  }
}
export interface PendingGateProjection extends Identity, Deadline {
  readonly isBudgetGate: boolean;
  readonly allowance?: BudgetAllowanceState;
}
export type GateTransition =
  | { readonly kind: 'paused'; readonly gate: PendingGateProjection }
  | {
      readonly kind: 'budget_decided';
      readonly gate: PendingGateProjection;
      readonly decision: 'approved' | 'rejected';
    }
  | {
      readonly kind: 'human_decided';
      readonly gate: PendingGateProjection;
      readonly event: HumanGateResumedEvent;
    };
interface GateHistory extends Identity {
  active: boolean;
  budget: boolean;
  deadline: Deadline;
  allowance?: BudgetAllowanceState;
  authorityPause?: PausedAuthority;
  authorityDecision?: DecidedAuthority;
  budgetPause?: BudgetPause;
  humanDecision?: HumanGateResumedEvent;
}
function corrupt(): never {
  throw new RunSuspensionCorruptionError('gate_state_conflict');
}
function mergeDeadline(prior: Deadline, next: Deadline): Deadline {
  if (
    prior.timeoutMs !== undefined &&
    next.timeoutMs !== undefined &&
    prior.timeoutMs !== next.timeoutMs
  )
    corrupt();
  if (
    prior.timeoutAction !== undefined &&
    next.timeoutAction !== undefined &&
    prior.timeoutAction !== next.timeoutAction
  )
    corrupt();
  if (
    prior.expiresAt !== undefined &&
    next.expiresAt !== undefined &&
    prior.expiresAt !== next.expiresAt
  )
    corrupt();
  const timeoutMs = next.timeoutMs ?? prior.timeoutMs;
  const timeoutAction = next.timeoutAction ?? prior.timeoutAction;
  const expiresAt = next.expiresAt ?? prior.expiresAt;
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(timeoutAction === undefined ? {} : { timeoutAction }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}
function assertDeadlineFits(authority: Deadline, companion: Deadline): void {
  if (companion.timeoutMs !== undefined && companion.timeoutMs !== authority.timeoutMs) corrupt();
  if (companion.timeoutAction !== undefined && companion.timeoutAction !== authority.timeoutAction)
    corrupt();
  if (companion.expiresAt !== undefined && companion.expiresAt !== authority.expiresAt) corrupt();
}
function mergeAllowance(history: GateHistory, allowance: BudgetAllowanceState): void {
  if (history.allowance !== undefined && !deepStructuralEquals(history.allowance, allowance))
    corrupt();
  history.allowance = allowance;
}
function snapshot(history: GateHistory): PendingGateProjection {
  return Object.freeze({
    runId: history.runId,
    nodeId: history.nodeId,
    gateId: history.gateId,
    isBudgetGate: history.budget,
    ...history.deadline,
    ...(history.allowance === undefined ? {} : { allowance: history.allowance }),
  });
}
function isResolved(history: GateHistory): boolean {
  return history.authorityDecision !== undefined || history.humanDecision !== undefined;
}
function compareCompanionDecision(authority: DecidedAuthority, event: HumanGateResumedEvent): void {
  if (authority.decision !== event.decision || authority.decidedBy !== event.decidedBy) corrupt();
  if (
    event.approvedAmountMicrocents !== undefined &&
    event.approvedAmountMicrocents !== authority.approvedAmountMicrocents
  )
    corrupt();
  if (event.payload !== undefined) corrupt();
}

/** Ordered gate histories remain independent of terminal node outputs and current outstanding gates. */
export class RunSuspensionReducer {
  readonly #gates = new Map<string, Map<string, GateHistory>>();
  readonly #media = new Map<string, Map<string, MediaJobSubmittedEvent>>();
  readonly #terminalRuns = new Set<string>();
  readonly #terminalNodes = new Map<string, Set<string>>();
  #find(identity: Identity): GateHistory | undefined {
    const history = this.#gates.get(identity.runId)?.get(identity.gateId);
    if (history !== undefined && history.nodeId !== identity.nodeId)
      throw new RunSuspensionCorruptionError('gate_identity_conflict');
    return history;
  }
  #create(identity: Identity, active: boolean): GateHistory {
    if (this.#terminalNodes.get(identity.runId)?.has(identity.nodeId) === true) corrupt();
    let gates = this.#gates.get(identity.runId);
    if (gates === undefined) {
      gates = new Map();
      this.#gates.set(identity.runId, gates);
    }
    const history: GateHistory = {
      runId: identity.runId,
      nodeId: identity.nodeId,
      gateId: identity.gateId,
      active,
      budget: false,
      deadline: {},
    };
    gates.set(identity.gateId, history);
    return history;
  }
  #budget(history: GateHistory): void {
    if (!history.budget && history.humanDecision !== undefined) corrupt();
    history.budget = true;
  }
  #retireNode(identity: Pick<Identity, 'runId' | 'nodeId'>): void {
    let terminal = this.#terminalNodes.get(identity.runId);
    if (terminal === undefined) {
      terminal = new Set();
      this.#terminalNodes.set(identity.runId, terminal);
    }
    terminal.add(identity.nodeId);
    this.#media.get(identity.runId)?.delete(identity.nodeId);
    for (const gate of this.#gates.get(identity.runId)?.values() ?? []) {
      if (gate.nodeId === identity.nodeId) gate.active = false;
    }
  }
  #authority(
    event: Extract<RunEvent, { type: 'budget:authorization' }>,
  ): GateTransition | undefined {
    const state = event.authorization;
    const history = this.#find(event) ?? this.#create(event, true);
    this.#budget(history);
    mergeAllowance(history, state.allowance);
    const priorAuthority = history.authorityPause ?? history.authorityDecision;
    if (
      priorAuthority !== undefined &&
      !deepStructuralEquals(mergeDeadline({}, priorAuthority), mergeDeadline({}, state))
    )
      corrupt();
    assertDeadlineFits(state, history.deadline);
    history.deadline = mergeDeadline(history.deadline, state);
    if (state.state === 'paused') {
      if (history.authorityPause !== undefined) {
        if (!deepStructuralEquals(history.authorityPause, state)) corrupt();
        return undefined;
      }
      if (
        history.budgetPause !== undefined &&
        (history.budgetPause.spentMicrocents !== state.spentMicrocents ||
          history.budgetPause.limitMicrocents !== state.limitMicrocents)
      )
        corrupt();
      history.authorityPause = state;
      return isResolved(history) || !history.active
        ? undefined
        : { kind: 'paused', gate: snapshot(history) };
    }
    if (history.authorityDecision !== undefined) {
      if (!deepStructuralEquals(history.authorityDecision, state)) corrupt();
      return undefined;
    }
    if (history.humanDecision !== undefined) {
      compareCompanionDecision(state, history.humanDecision);
    }
    const alreadyResolved = isResolved(history);
    if (!alreadyResolved && !history.active) corrupt();
    history.authorityDecision = state;
    history.active = false;
    if (state.decision === 'rejected') this.#retireNode(history);
    return alreadyResolved
      ? undefined
      : { kind: 'budget_decided', gate: snapshot(history), decision: state.decision };
  }
  #pause(event: HumanGatePausedEvent | BudgetPause): GateTransition | undefined {
    const history = this.#find(event) ?? this.#create(event, true);
    if (event.allowanceQuote !== undefined)
      mergeAllowance(history, { kind: 'frozen', quote: event.allowanceQuote });
    if (event.type === 'budget:paused') {
      this.#budget(history);
      if (history.allowance === undefined) history.allowance = { kind: 'legacy_no_allowance' };
      if (
        history.budgetPause !== undefined &&
        (history.budgetPause.spentMicrocents !== event.spentMicrocents ||
          history.budgetPause.limitMicrocents !== event.limitMicrocents)
      )
        corrupt();
      if (
        history.authorityPause !== undefined &&
        (history.authorityPause.spentMicrocents !== event.spentMicrocents ||
          history.authorityPause.limitMicrocents !== event.limitMicrocents)
      )
        corrupt();
      history.budgetPause = event;
    } else {
      const authority = history.authorityPause ?? history.authorityDecision;
      if (authority !== undefined) assertDeadlineFits(authority, event);
      history.deadline = mergeDeadline(history.deadline, event);
    }
    return isResolved(history) || !history.active
      ? undefined
      : { kind: 'paused', gate: snapshot(history) };
  }
  #resume(event: HumanGateResumedEvent): GateTransition | undefined {
    let history: GateHistory | undefined;
    if (event.gateId !== undefined) {
      history = this.#find({ ...event, gateId: event.gateId });
      if (history === undefined) throw new RunSuspensionCorruptionError('legacy_gate_join_missing');
    } else {
      const outstanding = [...(this.#gates.get(event.runId)?.values() ?? [])].filter(
        (g) => g.nodeId === event.nodeId && g.active && !isResolved(g),
      );
      if (outstanding.length !== 1)
        throw new RunSuspensionCorruptionError(
          outstanding.length === 0 ? 'legacy_gate_join_missing' : 'legacy_gate_join_ambiguous',
        );
      history = outstanding[0];
      if (history === undefined) throw new RunSuspensionCorruptionError('legacy_gate_join_missing');
    }
    if (event.allowanceQuote !== undefined)
      mergeAllowance(history, { kind: 'frozen', quote: event.allowanceQuote });
    // The pre-ADR-0097 producer accepted input on an unquoted budget gate. Its recorded input is a
    // rejection, never an agent output or an allowance. Normalize only this historical form; a native
    // authority or frozen quote continues to require a binary, payload-free budget decision.
    if (
      history.budget &&
      event.decision === 'input_provided' &&
      event.approvedAmountMicrocents === undefined &&
      history.authorityPause === undefined &&
      history.authorityDecision === undefined &&
      history.allowance?.kind !== 'frozen'
    )
      event = { ...event, decision: 'rejected', payload: undefined };
    if (history.budget && (event.decision === 'input_provided' || event.payload !== undefined))
      corrupt();
    if (history.authorityDecision !== undefined)
      compareCompanionDecision(history.authorityDecision, event);
    if (history.humanDecision !== undefined) {
      const prior = history.humanDecision;
      if (
        prior.decision !== event.decision ||
        prior.decidedBy !== event.decidedBy ||
        !deepStructuralEquals(prior.payload, event.payload) ||
        // A decided authority independently validates both present amounts. Its witness makes an
        // absent historical amount equivalent to the matching grant, without inventing an amount.
        // Without that witness, different optional amounts remain contradictory persisted state.
        (history.authorityDecision === undefined &&
          prior.approvedAmountMicrocents !== event.approvedAmountMicrocents)
      )
        corrupt();
      return undefined;
    }
    if (history.authorityDecision !== undefined) {
      history.humanDecision = event;
      return undefined;
    }
    if (!history.active) corrupt();
    history.humanDecision = event;
    history.active = false;
    if (history.budget) {
      if (event.decision === 'input_provided') corrupt();
      if (event.decision === 'rejected') this.#retireNode(history);
      return { kind: 'budget_decided', gate: snapshot(history), decision: event.decision };
    }
    return { kind: 'human_decided', gate: snapshot(history), event };
  }
  apply(event: RunEvent): GateTransition | undefined {
    if (event.type === 'budget:authorization') return this.#authority(event);
    if (event.type === 'budget:paused' || event.type === 'human_gate:paused')
      return this.#pause(event);
    if (event.type === 'human_gate:resumed') return this.#resume(event);
    if (event.type === 'media_job:submitted') {
      if (this.#terminalNodes.get(event.runId)?.has(event.nodeId) === true) return undefined;
      let media = this.#media.get(event.runId);
      if (media === undefined) {
        media = new Map();
        this.#media.set(event.runId, media);
      }
      media.set(event.nodeId, event);
      return undefined;
    }
    if (
      event.type === 'node:completed' ||
      event.type === 'node:failed' ||
      event.type === 'node:skipped'
    ) {
      this.#retireNode(event);
    }
    if (
      event.type === 'run:completed' ||
      event.type === 'run:failed' ||
      event.type === 'run:cancelled'
    )
      this.#terminalRuns.add(event.runId);
    return undefined;
  }
  pendingGates(runId: string): readonly PendingGateProjection[] {
    return Object.freeze(
      [...(this.#gates.get(runId)?.values() ?? [])]
        .filter((g) => g.active && !isResolved(g))
        .map(snapshot),
    );
  }
  resolvedGateIds(runId: string): readonly string[] {
    return Object.freeze(
      [...(this.#gates.get(runId)?.values() ?? [])].filter(isResolved).map((g) => g.gateId),
    );
  }
  pendingMediaJobs(runId: string): readonly MediaJobSubmittedEvent[] {
    return Object.freeze([...(this.#media.get(runId)?.values() ?? [])]);
  }
  budgetRejections(runId: string): readonly Pick<Identity, 'nodeId' | 'gateId'>[] {
    return Object.freeze(
      [...(this.#gates.get(runId)?.values() ?? [])]
        .filter(
          (g) =>
            g.budget && (g.authorityDecision?.decision ?? g.humanDecision?.decision) === 'rejected',
        )
        .map((g) => Object.freeze({ nodeId: g.nodeId, gateId: g.gateId })),
    );
  }
  isResumable(runId: string): boolean {
    return (
      !this.#terminalRuns.has(runId) &&
      (this.pendingGates(runId).length > 0 || this.pendingMediaJobs(runId).length > 0)
    );
  }
}
