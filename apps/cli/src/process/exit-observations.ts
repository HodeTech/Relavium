import { CLI_ERROR_POLICY, CliError, type CliErrorCode } from './cli-error.js';
import { EXIT_CODES } from './exit-codes.js';

/** Only runtime workflow adapters may supply actual RunHandle safety facts. */
export type WorkflowSafetyExit = 8 | 7 | 5 | 6;
export type OrdinaryExit = 0 | 1 | 2 | 3 | 4 | 6;

export function assertTerminatingSignalNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 127)
    throw new CliError('cli_internal', '');
}

const SAFETY_RANK: Readonly<Record<WorkflowSafetyExit, number>> = Object.freeze({
  8: 4,
  7: 3,
  5: 2,
  6: 1,
});

/** Finite sticky invocation facts, not a history of completed owners or raw failures. */
export class ExitObservations {
  #safety: WorkflowSafetyExit | undefined;
  #infrastructure = false;
  #output = false;
  #signal: number | undefined;
  #ordinary: OrdinaryExit = EXIT_CODES.success;
  #background = false;

  observeWorkflowSafety(value: WorkflowSafetyExit | undefined): void {
    if (value !== undefined && value !== 8 && value !== 7 && value !== 5 && value !== 6) {
      throw new CliError('cli_internal', '');
    }
    if (
      value !== undefined &&
      (this.#safety === undefined || SAFETY_RANK[value] > SAFETY_RANK[this.#safety])
    ) {
      this.#safety = value;
    }
  }

  /** Publish a surface outcome, not each failed chat turn or nested chat-end consumed by Home. */
  observeOutcome(value: OrdinaryExit): void {
    if (value !== 0 && value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 6) {
      throw new CliError('cli_internal', '');
    }
    // One authoritative surface supplies this slot. An established nonzero cannot be erased by later success.
    if (this.#ordinary === EXIT_CODES.success) this.#ordinary = value;
  }

  observeFailure(code: CliErrorCode): void {
    if (typeof code !== 'string' || !Object.hasOwn(CLI_ERROR_POLICY, code))
      throw new CliError('cli_internal', '');
    const policy = CLI_ERROR_POLICY[code];
    if (policy.origin === 'infrastructure') this.#infrastructure = true;
    else if (policy.origin === 'output') this.#output = true;
    else {
      switch (policy.exitCode) {
        case 0:
        case 1:
        case 2:
        case 3:
        case 4:
        case 6:
          this.observeOutcome(policy.exitCode);
          break;
        default:
          // A code policy is not authority to invent workflow-only receipt health.
          this.#infrastructure = true;
      }
    }
  }

  /** An actually terminating external signal; cooperative cancellation/raw Ctrl-C are ordinary outcomes. */
  observeTerminatingSignal(signalNumber: number): void {
    assertTerminatingSignalNumber(signalNumber);
    this.#signal ??= signalNumber;
  }

  /** Keepalive backstop only. This neither stops admission nor overrides an established nonzero. */
  observeBackgroundFailure(): void {
    this.#background = true;
  }

  exitCode(): number {
    if (this.#safety !== undefined) return this.#safety;
    if (this.#infrastructure || this.#output) return EXIT_CODES.infrastructureFailed;
    if (this.#signal !== undefined) return 128 + this.#signal;
    if (this.#ordinary === EXIT_CODES.success && this.#background)
      return EXIT_CODES.infrastructureFailed;
    return this.#ordinary;
  }

  infrastructureCode(): 'output_unavailable' | 'cli_internal' | undefined {
    if (this.#output) return 'output_unavailable';
    if (this.#infrastructure || this.#background) return 'cli_internal';
    return undefined;
  }

  /** Background keepalive uncertainty is deliberately excluded from fatal shutdown authority. */
  hasInfrastructureFailure(): boolean {
    return this.#infrastructure || this.#output;
  }

  hasTerminatingSignal(): boolean {
    return this.#signal !== undefined;
  }
}
