import { confirm, isCancel, note, text } from '@clack/prompts';
import type { HumanGatePausedEvent } from '@relavium/shared';

import { approvalDecision, inputDecision, rejectionDecision, DECIDED_BY_CLI } from './decision.js';
import type { GatePrompter } from './prompter.js';
import { budgetIdentifier, budgetPromptDetails, type BudgetPromptContext } from './budget.js';
import { sanitizeInline, stripTerminalControls } from '../render/sanitize.js';

/**
 * The `@clack/prompts`-backed {@link GatePrompter} (2.G, [ADR-0047](../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md))
 * — the ONLY place `@clack/prompts` is imported on the run path, mirroring how `ink` is confined to the TUI
 * renderer. It renders a card from the `human_gate:paused` event and collects the decision: approve / reject
 * (+ optional comment) for an `approval` / `review` gate, or a free-text value for an `input` gate. The
 * prompt fns are injectable so the routing + cancel logic is unit-tested without a TTY.
 */

/** The narrow slice of `@clack/prompts` the prompter uses — injectable so the branching is testable. */
export interface ClackPromptDeps {
  readonly note: (message: string, title: string) => void;
  readonly confirm: (opts: {
    message: string;
    active: string;
    inactive: string;
  }) => Promise<boolean | symbol>;
  readonly text: (opts: { message: string; placeholder?: string }) => Promise<string | symbol>;
  /** Clack's cancel sentinel guard (Ctrl-C / ESC) — a real type guard so a non-cancel value narrows. */
  readonly isCancel: (value: unknown) => value is symbol;
}

const defaultDeps: ClackPromptDeps = {
  note: (message, title) => {
    note(message, title);
  },
  confirm: (opts) => confirm(opts),
  text: (opts) => text(opts),
  isCancel,
};

const GATE_TITLE: Record<HumanGatePausedEvent['gateType'], string> = {
  approval: 'Approval gate',
  review: 'Review gate',
  input: 'Input gate',
};

/** The boxed card body shown above the prompt — the gate message, plus the deadline when the gate has one. */
function cardBody(event: HumanGatePausedEvent): string {
  const message = stripTerminalControls(event.message);
  const lines = [message.trim() === '' ? '(no message)' : message];
  if (event.expiresAt !== undefined) {
    lines.push(
      '',
      `Expires at ${sanitizeInline(event.expiresAt)} — auto-${sanitizeInline(event.timeoutAction ?? 'reject')} on timeout`,
    );
  }
  return lines.join('\n');
}

export function createClackGatePrompter(deps: ClackPromptDeps = defaultDeps): GatePrompter {
  return {
    prompt: async (event, budget) => {
      if (budget !== undefined) return promptBudget(deps, event, budget);
      deps.note(
        cardBody(event),
        `⏸ ${GATE_TITLE[event.gateType]} · ${sanitizeInline(event.nodeId)}`,
      );

      if (event.gateType === 'input') {
        // A human types a value: kept as the raw string (predictable). The structured/JSON path is the
        // scripted `relavium gate --input <json>` flag (see decision.ts `parseGateInput`). The prompt label is
        // a generic 'Enter value' — the gate's message is already shown in the card above, so repeating it on
        // the prompt line would just echo the same text twice.
        const value = await deps.text({ message: 'Enter value', placeholder: '' });
        return deps.isCancel(value) ? null : inputDecision(value);
      }

      const approved = await deps.confirm({
        message: 'Approve?',
        active: 'Approve',
        inactive: 'Reject',
      });
      if (deps.isCancel(approved)) {
        return null;
      }
      if (approved) {
        return approvalDecision();
      }
      const comment = await deps.text({
        message: 'Reason for rejection (optional)',
        placeholder: '',
      });
      return deps.isCancel(comment) ? null : rejectionDecision(comment);
    },
  };
}

/** Render each recorded budget state without deriving or recalculating its authority. */
function budgetPromptBody(budget: BudgetPromptContext): string {
  if (budget.kind === 'amount')
    return `Frozen allowance: ${budget.microcents} microcents. Approval funds this agent execution only.`;
  if (budget.kind === 'legacy')
    return 'Legacy budget gate: no frozen allowance. Continuing grants no allowance; current budget checks still apply.';
  if (budget.reason === 'unpriced') return 'Reject only: this execution has no priced allowance.';
  return 'Reject only: this execution allowance cannot be represented safely.';
}

/** Budget confirmation is binary and bound to the recorded scalar A, including explicit zero. */
async function promptBudget(
  deps: ClackPromptDeps,
  event: HumanGatePausedEvent,
  budget: BudgetPromptContext,
): Promise<Awaited<ReturnType<GatePrompter['prompt']>>> {
  const body = budgetPromptBody(budget);
  const lines = [body, ...budgetPromptDetails(budget)];
  if (event.expiresAt !== undefined) lines.push(`Expires at ${budgetIdentifier(event.expiresAt)}`);
  deps.note(
    lines.join('\n'),
    `⏸ Budget gate · ${budgetIdentifier(event.gateId)} · ${budgetIdentifier(event.nodeId)}`,
  );
  if (budget.kind === 'reject_only') {
    const rejected = await deps.confirm({
      message: 'Reject this budget gate?',
      active: 'Reject',
      inactive: 'Cancel run',
    });
    return deps.isCancel(rejected) || !rejected ? null : rejectionDecision();
  }
  const approved = await deps.confirm({
    message:
      budget.kind === 'amount'
        ? `Approve exactly ${budget.microcents} microcents?`
        : 'Continue without a budget allowance?',
    active: budget.kind === 'amount' ? 'Approve exact amount' : 'Continue',
    inactive: 'Reject',
  });
  if (deps.isCancel(approved)) return null;
  if (!approved) return rejectionDecision();
  return budget.kind === 'amount'
    ? {
        decision: 'approved',
        decidedBy: DECIDED_BY_CLI,
        approvedAmountMicrocents: budget.microcents,
      }
    : approvalDecision();
}
