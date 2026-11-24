import type { RunDeparture } from '@relavium/core';
import type { ErrorCode, RunDurability } from '@relavium/shared';

import { outcomeToExitCode, type RunOutcome } from '../commands/drive.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { WorkflowSafetyExit } from '../process/exit-observations.js';
import { displayRunId, relaviumRunCommand } from '../render/run-command-text.js';
import type { LegKind } from '../run-core/finish-leg.js';

/**
 * How a hosted leg ended, as the Home shows it
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3: the leg's
 * outcome is view state).
 *
 * - `completed`, `failed`, `cancelled`, `paused`: the four ordinary outcomes.
 * - `uncertain`: the run's record or an external consequence cannot be confirmed (exit 8, 7 or 5 in the shell).
 * - `taken_over`: another process owns the run now; this host stopped without claiming an outcome (exit 6).
 * - `settled`: a resume leg found the run already settled by another process, so there was nothing to resume.
 */
export type HostedRunDisposition =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'uncertain'
  | 'taken_over'
  | 'settled';

/**
 * What the Home knows when a leg has departed: the facts `finishLeg` reads, and nothing from the stream. The
 * handle's disposition is read AFTER the departure and handed in as plain values, so this module never holds a
 * handle and can never subscribe to one.
 */
export interface HostedRunTerminalInput {
  readonly leg: LegKind;
  /** The run's id as the host holds it. It is interpolated only after the sanitize floor. */
  readonly runId: string;
  /** What `driveRun` returned; `undefined` is a stream that ended with no terminal and no pause. */
  readonly outcome: RunOutcome | undefined;
  /** `handle.durability()`, read after the departure. */
  readonly durability: RunDurability;
  /** `handle.terminalError()`, read after the departure. Read for its one safety code, never shown. */
  readonly terminalError: ErrorCode | undefined;
  /** The departure the leg acknowledged (`detached` or `closed`, never `continue`). */
  readonly departure: Exclude<RunDeparture, { readonly kind: 'continue' }>;
}

/** Data only: the Home paints it, and it never writes, exits or reads a stream. */
export interface HostedRunTerminal {
  readonly disposition: HostedRunDisposition;
  /**
   * The workflow safety fact the leg carries (8, 7, 5 or 6), when it carries one. It is DESCRIBED here and
   * PUBLISHED by the leg's owner (`HostedRunLifetime.publish`), never from this value: the Home's exit code
   * comes from the registry, not from a card.
   */
  readonly safety: WorkflowSafetyExit | undefined;
  /** One line, from a fixed vocabulary plus the sanitized run id. */
  readonly headline: string;
  /** The remedy line (what to do, and what not to), when the disposition has one. */
  readonly remedy: string | undefined;
}

// The one rule lives in `render/run-command-text.ts`, shared with the shell's epilogue and the final summary; the cards import it from here.
export { displayRunId, relaviumRunCommand };

/**
 * Turn a departed leg's facts into the text and the Home-side disposition of its card.
 *
 * The mapping reuses `outcomeToExitCode`, the one owner of the outcome-to-exit contract, so a card can never
 * disagree with what the shell's own `run` and `gate` would have exited with for the same leg. The wording is a
 * closed vocabulary: the only interpolated value is the run id, passed through `displayRunId`. No stored
 * value, no event text, no error message and no stderr line reaches a string here, so there is nothing for a
 * hostile workflow or a secret to ride in on.
 */
export function describeHostedRunTerminal(input: HostedRunTerminalInput): HostedRunTerminal {
  const id = displayRunId(input.runId);
  const exit = outcomeToExitCode(
    input.outcome,
    input.durability,
    input.terminalError,
    input.departure,
    input.leg === 'resume',
  );
  const logs = relaviumRunCommand('logs', input.runId);
  const effectRemedy = 'Do not retry; inspect the target and resolve the effect record.';
  switch (exit) {
    case EXIT_CODES.moneyDurabilityUncertain: {
      const effectAlso =
        input.departure.effectNeedsAttention || input.terminalError === 'effect_needs_attention';
      return card(
        'uncertain',
        8,
        `Run ${id}: required money receipts could not be confirmed.`,
        `Do not repeat paid work; check provider billing and ${logs}.${effectAlso ? ` ${effectRemedy}` : ''}`,
      );
    }
    case EXIT_CODES.effectNeedsAttention:
      return card(
        'uncertain',
        7,
        `Run ${id}: an external effect needs attention.`,
        `${effectRemedy} Read ${logs}.`,
      );
    case EXIT_CODES.durabilityUncertain:
      return card(
        'uncertain',
        5,
        `Run ${id} finished, but its record may not have been written.`,
        `The result is held and retried the next time relavium starts; read ${relaviumRunCommand('status', input.runId)} for the durable outcome.`,
      );
    case EXIT_CODES.runOwnedElsewhere:
      return takenOverTerminal(input.runId);
    case EXIT_CODES.gatePaused:
      return card(
        'paused',
        undefined,
        `Run ${id} is paused and waiting for an answer.`,
        'Open the run to continue it.',
      );
    case EXIT_CODES.success:
      // A success with no outcome is only reachable for a resume leg that closed with no event: the run had
      // already been settled by another process.
      return input.outcome === undefined
        ? card('settled', undefined, `Run ${id} was already settled; nothing to resume.`, undefined)
        : card('completed', undefined, `Run ${id} completed.`, undefined);
    case EXIT_CODES.workflowFailed:
      if (input.outcome === 'cancelled')
        return card(
          'cancelled',
          undefined,
          `Run ${id} was cancelled; a cancelled run cannot be resumed.`,
          undefined,
        );
      if (input.outcome === undefined)
        return card(
          'failed',
          undefined,
          `Run ${id} ended without recording an outcome.`,
          `Read ${logs} for what actually happened.`,
        );
      return card('failed', undefined, `Run ${id} failed.`, `Read ${logs} for the cause.`);
    default:
      // `outcomeToExitCode` returns none of 2, 4 or 9; a new code must be named above, not shown as a failure.
      return card('failed', undefined, `Run ${id} ended unexpectedly.`, `Read ${logs}.`);
  }
}

/**
 * The card of a run another process took over. It needs no fact beyond the run's id, so the host can still show it when the departure it
 * would read the other facts from cannot be read a second time (the leg was already refused as taken over).
 */
export function takenOverTerminal(runId: string): HostedRunTerminal {
  const id = displayRunId(runId);
  return card(
    'taken_over',
    6,
    `Run ${id} was taken over by another process; this one stopped without recording an outcome.`,
    `Read ${relaviumRunCommand('logs', runId)} for what actually happened.`,
  );
}

function card(
  disposition: HostedRunDisposition,
  safety: WorkflowSafetyExit | undefined,
  headline: string,
  remedy: string | undefined,
): HostedRunTerminal {
  return Object.freeze({ disposition, safety, headline, remedy });
}
