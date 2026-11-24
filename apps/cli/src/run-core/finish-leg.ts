import type { RunHandle } from '@relavium/core';
import type { Db } from '@relavium/db';

import { isTerminalOutcome, outcomeToExitCode, type RunOutcome } from '../commands/drive.js';
import { sweepCommittedEffects, type EffectNoticeOwner } from '../engine/effect-retention.js';
import { sweepMediaAtTerminal, type sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { RemainingBudget } from '../process/invocation-registry.js';
import type { CliIo } from '../process/io.js';
import type { NoticeSurface } from '../render/notice-surface.js';
import { displayRunId, relaviumRunCommand } from '../render/run-command-text.js';
import { sanitizeInline } from '../render/sanitize.js';

/**
 * Which leg of a run just ended: `start` is a run's first leg (`relavium run`), `resume` is a leg that
 * resumed a parked run from its checkpoint (`relavium gate`, `relavium budget resume`).
 *
 * The leg decides exactly three rules, each of which the two commands already answered differently before
 * this function existed. They are kept apart on purpose, not unified:
 *
 * 1. **The no-terminal idempotent exit.** A `resume` leg whose stream closed with no `run:*` event and a
 *    durable disposition is a doubled decision, so it exits `0`; a `start` leg that closes with no outcome
 *    is an abnormal unwind and exits as a failure. (`outcomeToExitCode`'s `idempotentClosed` argument.)
 * 2. **A taken-over run.** A `resume` leg REFUSES with a typed `run_owned_elsewhere` error before it
 *    sweeps anything, because the caller can retry the decision; a `start` leg has nothing to retry, so it
 *    says what happened on stderr AFTER its sweeps and returns the exit code.
 * 3. **The settled no-op.** Only a `resume` leg can close an already-settled run, and it says so and exits
 *    `0` before any sweep.
 */
export type LegKind = 'start' | 'resume';

/**
 * What the epilogue reads of its host, and no more: the invocation's shared budget (the retention passes do
 * not start after the original deadline) and the owner that delivers the effect sweep's advisory notice.
 * Every `RunLifetime` satisfies it.
 */
export interface LegLifetime {
  readonly invocation: { readonly registry: { readonly budget: RemainingBudget } };
  readonly effectNoticeOwner: EffectNoticeOwner;
}

/** Where the Home's card says a run is read: its own browser, on the tab where a finished run is listed. */
export const READ_RUN_IN_HOME = 'the run in /workflows (History tab)';

export interface FinishLegInput {
  readonly leg: LegKind;
  /**
   * Where the line a taken-over run writes to {@link io} is READ: the shell names `relavium logs`, a hosted leg (every line becomes a
   * notice inside the TUI) names the Home's own run browser ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6,
   * MVP-11 OD-20). REQUIRED, so a host that forgets it fails the typecheck.
   */
  readonly noticeSurface: NoticeSurface;
  /** The run's id as the caller holds it: `handle.runId` for a start, the requested run id for a resume. */
  readonly runId: string;
  readonly lifetime: LegLifetime;
  readonly io: CliIo;
  /** `--json`: the settled notice moves to stderr so stdout stays a pure event stream. */
  readonly json: boolean;
  /** Read AFTER the departure, never before: departing is what settles the disposition. */
  readonly handle: Pick<RunHandle, 'depart' | 'durability' | 'terminalError'>;
  /** What `driveRun` returned; `undefined` is a stream that ended with no terminal and no pause. */
  readonly outcome: RunOutcome | undefined;
  /** The durable history, absent on the in-memory embedding path (which has no journal and no CAS to sweep). */
  readonly db: Db | undefined;
  readonly mediaCasRoot: string | undefined;
  readonly mediaGcGraceMs: number | undefined;
  /** The run-end host media GC; tests spy on it, production passes `sweepHostMediaBestEffort`. */
  readonly sweepMedia: typeof sweepHostMediaBestEffort;
}

/**
 * The shared epilogue of one leg: the departure, the exit code, the retention passes, and what a taken-over
 * run says. `relavium run`, `relavium gate` and `relavium budget resume` ran the same sequence in two
 * copies; the Home's hosted run is the third caller, so it has one home here.
 *
 * The order is the contract:
 *
 * 1. **Depart**, and refuse a departure that continues. The handle's durability and terminal error are read
 *    only after this, because the departure is what settles them.
 * 2. **Map the outcome to an exit code.** The handle's disposition OUTRANKS the outcome (ADR-0078 §5): a
 *    delivered `run:completed` whose durable write did not land must not exit 0. It is read off the HANDLE,
 *    never from a `subscribe()`: the resume gate can settle `run:failed` inside `resumeFromCheckpoint`'s
 *    await, before the caller has a handle to subscribe to, and `subscribe` has no replay — a review
 *    measured a late subscriber seeing `undefined` and a resume reporting exit 1 for a run that had
 *    stopped for an unresolved external effect. `terminalError()` is captured on the handle's own
 *    construction-time subscription, which no ordering can outrun.
 * 3. **The leg-specific takeover and settled rules** (see {@link LegKind}).
 * 4. **The retention passes**, both optional, neither started after the original deadline, and both only for
 *    a TERMINAL outcome. A paused run is resumable, so its committed effect rows and its media must survive.
 *    - The effect-journal sweep (effect-journal.md §9): a terminal run can no longer be resumed, so its
 *      COMMITTED rows have no reader left and go. Unresolved rows are untouched by construction.
 *    - The host media GC (2.S/D-GC, ADR-0042 §4): best-effort, never fails the run.
 *
 * Returns the exit code the caller returns. A `resume` leg throws instead of returning for a taken-over run.
 */
export async function finishLeg(input: FinishLegInput): Promise<ExitCode> {
  const { leg, runId, lifetime, io, handle, outcome, db } = input;
  const departure = await handle.depart();
  if (departure.kind === 'continue')
    throw new CliError('internal', 'run departure was not acknowledged');
  const exitCode = outcomeToExitCode(
    outcome,
    handle.durability(),
    handle.terminalError(),
    departure,
    leg === 'resume',
  );

  if (leg === 'resume') {
    // An uncertain NONTERMINAL outcome is fenced, including a buffered stale pause. A delivered
    // terminal with uncertainty instead belongs to the outbox/exit-5 path. A durable later
    // pause still exits 3. Neither durability nor the outcome alone makes these distinctions.
    if (exitCode === EXIT_CODES.runOwnedElsewhere) {
      throw new CliError(
        'run_owned_elsewhere',
        `this process could not confirm ownership of run ${displayRunId(runId)} during the resume and stopped — read ${relaviumRunCommand('logs', runId)} for its real outcome, then retry if the gate is still pending`,
      );
    }
    if (outcome === undefined && exitCode === EXIT_CODES.success) {
      // **Two very different runs close with no `run:*` event, and telling them apart matters.** A closed
      // handle (the engine's own checkpoint re-read found the run terminal — a concurrent `relavium gate`
      // settled it between our pre-check and the engine's) is an idempotent no-op. A run FENCED mid-resume
      // (ADR-0079 §5) also emits no terminal by design — and reporting that as "already settled … exit 0"
      // is the worst available answer: this process cannot report settlement, even when its earlier gate
      // decision is already durable, and an automation loop records success. The disposition separates them at no
      // cost: `createClosedRunHandle` reports `durable`, a fenced handle reports `uncertain`.
      const notice = `run ${sanitizeInline(runId)} already settled; nothing to resume\n`;
      if (input.json) io.writeErr(notice);
      else io.writeOut(notice);
      return EXIT_CODES.success;
    }
  }

  // Both retention passes are optional: do not start new maintenance after the original deadline.
  // Already-entered work and mandatory engine/input/MCP/database joins retain their own barriers.
  // `db` is undefined for an in-memory embedding/test path, which has no journal to sweep.
  if (
    isTerminalOutcome(outcome) &&
    db !== undefined &&
    lifetime.invocation.registry.budget.remainingMs() !== 0
  ) {
    sweepCommittedEffects(io, db, runId, lifetime.effectNoticeOwner);
  }
  await sweepMediaAtTerminal({
    sweep: input.sweepMedia,
    isTerminal: isTerminalOutcome(outcome),
    db,
    casRoot: input.mediaCasRoot,
    currentRunId: runId,
    graceMs: input.mediaGcGraceMs,
    budget: lifetime.invocation.registry.budget,
  });

  // **Say what happened.** A fenced run writes no terminal by design (ADR-0079 §5), so the renderer's final
  // summary falls through to a bare "run ended" and the user is left with an exit code and no explanation of
  // why their run stopped. stderr, so `--json` stdout stays a clean stream.
  if (leg === 'start' && exitCode === EXIT_CODES.runOwnedElsewhere) {
    const where =
      input.noticeSurface === 'tui' ? READ_RUN_IN_HOME : relaviumRunCommand('logs', runId);
    io.writeErr(
      `run ${displayRunId(runId)} was taken over by another process; this one stopped without recording an outcome — read ${where} for what actually happened\n`,
    );
  }
  return exitCode;
}
