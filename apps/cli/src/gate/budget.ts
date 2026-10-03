import type { CheckpointState } from '@relavium/core';
import {
  BudgetMicrocentsSchema,
  type BudgetAllowanceState,
  type GateDecision,
} from '@relavium/shared';

import { CliError } from '../process/errors.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { DECIDED_BY_CLI, rejectionDecision } from './decision.js';

export interface BudgetDecisionFlags {
  readonly approveAmount?: string;
  readonly abort?: boolean;
}

/** Validate the amount transport before opening history, connecting tools or claiming a run. */
export function budgetDecisionFromFlags(flags: BudgetDecisionFlags): GateDecision {
  const approving = flags.approveAmount !== undefined;
  const aborting = flags.abort === true;
  if (approving === aborting) {
    throw new CliError(
      'invalid_invocation',
      'specify exactly one of --approve-amount <microcents> or --abort',
    );
  }
  if (aborting) return rejectionDecision();
  const raw = flags.approveAmount;
  const parsed = BudgetMicrocentsSchema.safeParse(Number(raw));
  if (raw === undefined || !/^[0-9]+$/.test(raw) || !parsed.success) {
    throw new CliError(
      'invalid_invocation',
      '--approve-amount must be a non-negative safe integer in decimal microcents',
    );
  }
  return {
    decision: 'approved',
    decidedBy: DECIDED_BY_CLI,
    approvedAmountMicrocents: parsed.data,
  };
}

/** A display projection of recorded authority; pricing remains the engine's responsibility. */
export function budgetAllowanceLabel(allowance: BudgetAllowanceState | undefined): string {
  return budgetPromptLabel(budgetPromptContext(allowance));
}

/** One scalar label for prompts, status and streaming views; it never receives provenance. */
export function budgetPromptLabel(context: BudgetPromptContext): string {
  if (context.kind === 'legacy') return 'legacy gate: no frozen allowance';
  if (context.kind === 'amount') return `${context.microcents} microcents`;
  return context.reason === 'unpriced'
    ? 'reject only: no priced allowance'
    : 'reject only: allowance cannot be represented safely';
}

export type BudgetGateSelection =
  | { readonly kind: 'resume'; readonly gateId: string }
  | { readonly kind: 'idempotent'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Budget discovery uses the strict checkpoint, including authority-only crash prefixes. */
export function selectBudgetGate(
  checkpoint: CheckpointState,
  requested: string | undefined,
): BudgetGateSelection {
  if (TERMINAL.has(checkpoint.runStatus)) {
    return {
      kind: 'idempotent',
      message: `run ${checkpoint.runStatus}; nothing to resume`,
    };
  }
  const pending = checkpoint.pendingGates.filter((gate) => gate.isBudgetGate);
  const choices = pending.map(
    (gate) => `${budgetIdentifier(gate.gateId)}: ${budgetAllowanceLabel(gate.allowance)}`,
  );
  const list = choices.length === 0 ? '' : ` (pending budget gates: ${choices.join('; ')})`;
  if (requested !== undefined) {
    const gate = pending.find((gate) => gate.gateId === requested);
    if (gate !== undefined) return { kind: 'resume', gateId: gate.gateId };
    if (checkpoint.resolvedGateIds.includes(requested)) {
      return {
        kind: 'idempotent',
        message: `gate ${budgetIdentifier(requested)} already resolved`,
      };
    }
    return {
      kind: 'invalid',
      message: `no pending budget gate ${budgetIdentifier(requested)} on run${list}`,
    };
  }
  const [only, ...rest] = pending;
  if (only === undefined) {
    return {
      kind: 'invalid',
      message: 'the run is not paused at a budget gate',
    };
  }
  return rest.length === 0
    ? { kind: 'resume', gateId: only.gateId }
    : {
        kind: 'invalid',
        message: `more than one budget gate is pending — pass --gate <gateId>:${list}`,
      };
}

/** Cheap native amount/kind refusals precede secrets/MCP; the engine rechecks the whole quote. */
export function assertBudgetDecision(
  allowance: BudgetAllowanceState | undefined,
  decision: GateDecision,
): void {
  if (decision.decision === 'rejected') return;
  const label = budgetAllowanceLabel(allowance);
  if (allowance?.kind !== 'frozen') {
    throw new CliError(
      'invalid_invocation',
      'this legacy budget gate has no frozen amount to approve; --abort rejects it. ' +
        'An interactive legacy continuation grants no allowance and remains governed by the current cap.',
    );
  }
  const result = allowance.quote;
  if (result.kind !== 'quoted' || result.quote.amount.kind !== 'representable') {
    throw new CliError('invalid_invocation', `${label}; use --abort to reject the budget gate`);
  }
  if (
    decision.decision !== 'approved' ||
    decision.approvedAmountMicrocents !== result.quote.amount.microcents
  ) {
    throw new CliError(
      'invalid_invocation',
      `the frozen allowance is ${label}; --approve-amount must equal that amount`,
    );
  }
}

/** The prompt receives only scalar authority, never private pricing/model provenance. */
export type BudgetPromptContext =
  | { readonly kind: 'amount'; readonly microcents: number }
  | {
      readonly kind: 'reject_only';
      readonly reason: 'unpriced' | 'unrepresentable';
    }
  | { readonly kind: 'legacy' };

export function budgetPromptContext(
  allowance: BudgetAllowanceState | undefined,
): BudgetPromptContext {
  if (allowance?.kind !== 'frozen') return { kind: 'legacy' };
  const result = allowance.quote;
  if (result.kind === 'unpriced') return { kind: 'reject_only', reason: 'unpriced' };
  return result.quote.amount.kind === 'unrepresentable'
    ? { kind: 'reject_only', reason: 'unrepresentable' }
    : { kind: 'amount', microcents: result.quote.amount.microcents };
}

/** Gate/node IDs are untrusted display text; do not echo secret-shaped or unbounded values. */
export function budgetIdentifier(id: string): string {
  const safe = sanitizeUntrustedInline(id);
  return safe.length > 160 ? `${safe.slice(0, 160)}…` : safe;
}

/** Raw triple identity joins display companions without relying on redacted labels. */
export function budgetGateIdentity(gate: {
  readonly runId: string;
  readonly nodeId: string;
  readonly gateId: string;
}): string {
  return JSON.stringify([gate.runId, gate.nodeId, gate.gateId]);
}

/** A command base exists only for unchanged, shell-inert recorded identifiers. */
export function resumeCommandBase(
  kind: 'human' | 'budget',
  runId: string,
  gateId: string,
): string | undefined {
  if (
    [runId, gateId].some(
      (id) => budgetIdentifier(id) !== id || id.startsWith('-') || !/^[A-Za-z0-9_.:-]+$/.test(id),
    )
  )
    return undefined;
  return `${kind === 'budget' ? 'relavium budget resume' : 'relavium gate'} ${runId} --gate ${gateId}`;
}

/** Complete, copyable operator commands; the display never turns provenance into authorization. */
export function budgetResumeHints(
  runId: string,
  gateId: string,
  context: BudgetPromptContext,
): readonly string[] {
  // Copyable shell commands use only unchanged, shell-inert identifiers. A historical or
  // redacted display id must not become an executable shell fragment or an invented gate id.
  const command = resumeCommandBase('budget', runId, gateId);
  if (command === undefined) {
    const choice =
      context.kind === 'amount' ? `--approve-amount ${context.microcents} or --abort` : '--abort';
    return [`Use relavium budget resume with the recorded run and gate IDs and ${choice}.`];
  }
  const reject = `reject: ${command} --abort`;
  return context.kind === 'amount'
    ? [`approve: ${command} --approve-amount ${context.microcents}`, reject]
    : [reject];
}
