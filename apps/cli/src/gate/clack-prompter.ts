import { confirm, isCancel, note, text } from '@clack/prompts';
import type { HumanGatePausedEvent } from '@relavium/shared';

import { approvalDecision, inputDecision, rejectionDecision } from './decision.js';
import type { GatePrompter } from './prompter.js';

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
  const lines = [event.message.trim() === '' ? '(no message)' : event.message];
  if (event.expiresAt !== undefined) {
    lines.push(
      '',
      `Expires at ${event.expiresAt} — auto-${event.timeoutAction ?? 'reject'} on timeout`,
    );
  }
  return lines.join('\n');
}

export function createClackGatePrompter(deps: ClackPromptDeps = defaultDeps): GatePrompter {
  return {
    prompt: async (event) => {
      deps.note(cardBody(event), `⏸ ${GATE_TITLE[event.gateType]} · ${event.nodeId}`);

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
