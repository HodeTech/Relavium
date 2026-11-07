import {
  EngineStateError,
  WorkflowValidationError,
  validateWorkflowToolArms,
  validateWorkflowWithCatalog,
  type RunHandle,
  type RunDeparture,
  type WorkflowDefinition,
  type WorkflowEngine,
  type ToolHostArm,
  type WorkflowModelCatalog,
} from '@relavium/core';
import type {
  ErrorCode,
  GateDecision,
  HumanGatePausedEvent,
  RunDurability,
  RunEvent,
  RunPausedEvent,
} from '@relavium/shared';

import type { GatePrompter } from '../gate/prompter.js';
import { budgetIdentifier, budgetPromptContext, type BudgetPromptContext } from '../gate/budget.js';
import { sanitizeInline, sanitizeUntrustedInline, stringifyJsonLine } from '../render/sanitize.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import { detectOutputMode, isCiEnv } from '../process/output-mode.js';
import type { CliIo } from '../process/io.js';
import type { RunRenderer } from '../render/renderer.js';
import type { RendererCreationOwner } from './workflow-terminal.js';
import type { WorkflowLifetime } from './workflow-lifetime.js';
import { wireRunJobControl } from '../render/run-job-control.js';

/**
 * The D15 catalog load-check, shared by `run` (a fresh load) and `gate` (a resume — re-validated against the
 * CURRENT catalog so a model that lost a capability between the run and the resume is caught consistently, not
 * only at the runtime FallbackChain pre-skip). An incapable / malformed-generative authored `output_modalities`
 * surfaces as an `invalid_invocation` CliError (exit 2), like a parse fault; any other throw propagates.
 */
export function assertWorkflowCatalogValid(
  workflow: WorkflowDefinition,
  catalog: WorkflowModelCatalog,
): void {
  try {
    validateWorkflowWithCatalog(workflow, catalog);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * The run-path tool pre-flight (2.6.A, MVP-1): a workflow granting a built-in whose host arm `relavium run` does
 * not wire (`web_search`, `http_request`, `read_clipboard`, `notify`) is refused before the run starts, as an
 * `invalid_invocation` CliError (exit 2), instead of failing with `tool_unavailable` partway through.
 */
export function assertWorkflowToolArmsWired(
  workflow: WorkflowDefinition,
  unwired: readonly ToolHostArm[],
): void {
  try {
    validateWorkflowToolArms(workflow, { unwired });
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}

/** A run's terminal disposition (`undefined` means the stream ended with no terminal/paused — an abnormal unwind). */
export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

/** Preserve an opaque host failure after cleanup without inspecting or coercing its cause. */
function rethrowDriveFailure(original: unknown): never {
  throw original;
}

export interface DriveRunDeps {
  readonly lifetime: WorkflowLifetime;
  readonly engine: WorkflowEngine;
  readonly handle: RunHandle;
  /**
   * Construct after the command reserves its workflow/terminal owners and signal subscription. The
   * creation token transfers native rollback custody before a partially allocating constructor can throw.
   */
  readonly makeRenderer: (creation: RendererCreationOwner) => RunRenderer;
  /** Present only in the interactive TUI path; absent (or `undefined`) → a human-gate pause breaks to the
   * gate-paused exit `3` (the callers pass `selectGatePrompter(...)`, which is `GatePrompter | undefined`). */
  readonly gatePrompter?: GatePrompter | undefined;
  /** Construct input adapters inside the same ownership boundary as the renderer. */
  readonly makeGatePrompter?: () => GatePrompter | undefined;
  readonly io: CliIo;
  /** Local diagnostics use NDJSON stderr when the command selected --json. */
  readonly json?: boolean;
}

/**
 * Drive a live run's event stream to a terminal/paused outcome — the SHARED core of `relavium run` (a fresh
 * `engine.start`) and `relavium gate` (a resumed `engine.resumeFromCheckpoint`), so the two never fork the
 * event loop, the SIGINT contract, or the renderer teardown (2.G).
 *
 * The command's existing lifetime owns signals through preparation and cleanup. This driver keeps one
 * primary reader across inline gate prompts, temporary input release and actual departure. Cooperative
 * cancellation may still paint the final outcome; finite/infrastructure shutdown permanently seals view
 * entry and joins actual native release independently of summary rendering. The command removes its
 * subscription only after actual cleanup, so Ink cannot become the sole signal listener mid-teardown.
 */
export async function driveRun(deps: DriveRunDeps): Promise<RunOutcome | undefined> {
  const { engine, handle, makeRenderer, io } = deps;
  const lifetime = deps.lifetime;
  lifetime.adoptEngine(engine, handle.runId);
  lifetime.adoptHandle(handle);
  const terminal = lifetime.terminal;
  let gatePrompter = deps.gatePrompter;
  let outcome: RunOutcome | undefined;
  let cancelRequested = false;
  let streamEnded = false;
  let primaryDone = false;
  let finalDurability: RunDurability | undefined;
  let finalTerminalError: ErrorCode | undefined;
  let healthRead = false;
  let inlineRefused = false;
  let inlineTerminating = false;
  let activePrompt: AbortController | undefined;
  /**
   * The gate card on screen. A decision for its gate that this card did not make — a deadline's — closes it and says
   * so, so an answer typed after that is not silently dropped by the engine's idempotent resume. One that lands in
   * the moment between the deadline's claim and its event still can be (recorded in deferred-tasks.md).
   */
  let openCard:
    | {
        readonly gate: HumanGatePausedEvent;
        readonly controller: AbortController;
        /** The decision this card returned, once it has: the resumed event that carries it is the card's own. */
        answered?: { readonly decision: string; readonly decidedBy: string };
        decided?: string;
      }
    | undefined;
  /**
   * Close the open card when `decidedBy`, not this card, decided its gate: matched by gate id when the resumed event
   * names one (a budget companion), otherwise by node (every human-gate resume, and a legacy companion). Records how
   * it was decided for the stderr notice. The card's own decision is the one it returned, matched by its decision and
   * `decidedBy`: before the card answers, any decision for its gate came from elsewhere. `decidedBy` alone cannot
   * tell, since every CLI decision is marked `cli` and a prompter may mark its own otherwise.
   */
  const closeCardDecidedElsewhere = (
    gateId: string | undefined,
    nodeId: string,
    decision: string,
    decidedBy: string,
  ): void => {
    const card = openCard;
    if (card === undefined) return;
    if (card.answered?.decision === decision && card.answered.decidedBy === decidedBy) return;
    // A human-gate resume (and a legacy companion) names the node, not the gate.
    if (gateId === undefined ? nodeId !== card.gate.nodeId : gateId !== card.gate.gateId) return;
    card.decided ??= `${decision}${decidedBy === 'timeout' ? ' by its deadline' : ` by ${decidedBy}`}`;
    card.controller.abort();
  };
  let renderer: RunRenderer | undefined;
  let driveError: { readonly cause: unknown } | undefined;
  const recordFault = (cause: unknown): void => {
    if (lifetime.isStoppedFailure(cause)) return;
    driveError ??= { cause };
    lifetime.failure(cause);
  };
  let inputReleased = false;
  let inputReleaseFailed = false;
  let departure: Exclude<RunDeparture, { readonly kind: 'continue' }> | undefined;
  let departureWork: Promise<RunDeparture> | undefined;
  let revision = 0;
  const waiters = new Set<() => void>();
  const gates = new Map<string, HumanGatePausedEvent>();
  const handledGates = new Set<string>();
  const budgetContexts = new Map<
    string,
    { readonly nodeId: string; readonly context: BudgetPromptContext }
  >();
  let pause: RunPausedEvent | undefined;
  const mayPrompt = (): boolean =>
    !lifetime.stopped &&
    !terminal.sealed &&
    !cancelRequested &&
    !inlineRefused &&
    !inlineTerminating &&
    !isTerminalOutcome(outcome);
  const wake = (): void => {
    revision += 1;
    const pending = [...waiters];
    waiters.clear();
    for (const notify of pending) notify();
  };
  const progressAfter = (seen: number): Promise<void> =>
    new Promise((resolve) => {
      waiters.add(resolve);
      if (revision !== seen) {
        waiters.delete(resolve);
        resolve();
      }
    });
  const diagnostic = (code: 'cleanup_pending' | 'cleanup_failed', message: string): void => {
    try {
      io.writeErr(
        deps.json === true
          ? stringifyJsonLine({ type: 'diagnostic', code, message }) + '\n'
          : message + '\n',
      );
    } catch {
      lifetime.failure(new CliError('output_unavailable', ''));
    }
  };
  /**
   * Await `work`, and say on stderr when it has not settled 250 ms after it was asked to stop. Without `stopped` the
   * work is cleanup from the start. A gate card is not: a person answering it takes as long as they take, and a line
   * written under an open card throws off its redraws, so its notice waits for the card's abort.
   */
  const joined = async <T>(work: Promise<T>, stopped?: AbortSignal): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      timer ??= setTimeout(
        () =>
          diagnostic(
            'cleanup_pending',
            'Run cleanup is still pending; input and run resources remain owned.',
          ),
        250,
      );
    };
    if (stopped === undefined || stopped.aborted) arm();
    else stopped.addEventListener('abort', arm, { once: true });
    try {
      return await work;
    } finally {
      stopped?.removeEventListener('abort', arm);
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const retainUnacknowledged = async (): Promise<never> => {
    lifetime.cleanupFailed(new CliError('cli_internal', ''));
    diagnostic(
      'cleanup_failed',
      'Run cleanup could not be acknowledged; input and run resources remain owned.',
    );
    return await new Promise<never>(() => {});
  };
  const onStop = (): void => {
    cancelRequested = true;
    activePrompt?.abort();
    wake();
  };
  const requestCancellation = (): void => {
    if (cancelRequested) return;
    onStop();
    lifetime.stop();
  };
  lifetime.signal.addEventListener('abort', onStop);
  if (lifetime.stopped) requestCancellation();
  let jobControl: ReturnType<typeof wireRunJobControl> | undefined;
  let iterator: AsyncIterator<RunEvent> | undefined;
  const beginDeparture = (): Promise<RunDeparture> => {
    if (departureWork !== undefined) return departureWork;
    const pending = Promise.resolve().then(() => handle.depart());
    departureWork = pending;
    // Observe rejection immediately, including while an input owner is still settling.
    void pending.then((claim) => {
      if (claim.kind !== 'continue') {
        departure = claim;
        publishHealth();
      }
    }, recordFault);
    return pending;
  };
  const publishHealth = (): void => {
    if (primaryDone && !healthRead) {
      healthRead = true;
      // Neither getter is authority until positive primary done; attempt both independently.
      try {
        finalDurability = handle.durability();
      } catch (cause) {
        recordFault(cause);
      }
      try {
        finalTerminalError = handle.terminalError();
      } catch (cause) {
        recordFault(cause);
      }
    }
    const exit = outcomeToExitCode(outcome, finalDurability, finalTerminalError, departure);
    lifetime.publish(
      exit === 8 || exit === 7 || exit === 5 || exit === 6 ? exit : undefined,
      primaryDone && departure !== undefined,
    );
  };
  // Exactly one primary reader remains live across prompts, input ACKs and host joins.
  // There is no event spool: only the current pause and pending gate projections are retained.
  const primary = (async (): Promise<void> => {
    try {
      iterator = handle.events[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          primaryDone = true;
          break;
        }
        const event = next.value;
        if (event.runId !== handle.runId) continue;
        outcome = nextOutcome(outcome, event);
        if (event.type === 'run:paused') pause = event;
        if (event.type === 'budget:authorization') {
          if (event.authorization.state === 'paused') {
            budgetContexts.set(event.gateId, {
              nodeId: event.nodeId,
              context: budgetPromptContext(event.authorization.allowance),
            });
          } else {
            gates.delete(event.gateId);
            budgetContexts.delete(event.gateId);
            if (event.authorization.decision === 'rejected') inlineTerminating = true;
          }
        } else if (event.type === 'budget:paused' && !budgetContexts.has(event.gateId)) {
          budgetContexts.set(event.gateId, {
            nodeId: event.nodeId,
            context: budgetPromptContext(
              event.allowanceQuote === undefined
                ? undefined
                : { kind: 'frozen', quote: event.allowanceQuote },
            ),
          });
        } else if (event.type === 'human_gate:paused') {
          if (!handledGates.has(event.gateId)) gates.set(event.gateId, event);
        } else if (event.type === 'human_gate:resumed') {
          // The pause that parked this gate is over. Kept, it would make every later event attempt a departure once
          // inline prompting stops (a card closed under the user), re-mounting the live view each time; the engine
          // announces a fresh `run:paused` for any gate still pending when it is next idle.
          pause = undefined;
          // Legacy resumed companions identify the node, not a gate id.
          for (const [id, pending] of gates) {
            if (pending.nodeId === event.nodeId) {
              gates.delete(id);
              budgetContexts.delete(id);
            }
          }
          closeCardDecidedElsewhere(event.gateId, event.nodeId, event.decision, event.decidedBy);
        }
        if (isTerminalOutcome(outcome)) {
          inlineTerminating = true;
          activePrompt?.abort();
          // Host cleanup progresses even if a prompt or native input release ignores abort.
          void beginDeparture();
        }
        try {
          if (!terminal.sealed) renderer?.onEvent(event);
        } catch (error) {
          recordFault(error);
          requestCancellation();
        }
        wake();
      }
    } catch (error) {
      recordFault(error);
      requestCancellation();
      // A rejected reader is never primary done, but available departure health must progress even
      // while an entered prompt ignores abort. The same owned promise still gates actual cleanup.
      void beginDeparture();
    } finally {
      streamEnded = true;
      void beginDeparture();
      publishHealth();
      wake();
    }
  })();
  const releaseInput = async (): Promise<boolean> => {
    if (inputReleased) return true;
    if (inputReleaseFailed && renderer?.releaseInput === undefined)
      return await retainUnacknowledged();
    try {
      await joined(terminal.releaseInput());
      inputReleased = true;
      inputReleaseFailed = false;
      return true;
    } catch (cause) {
      recordFault(cause);
      inputReleaseFailed = true;
      diagnostic(
        'cleanup_failed',
        'Input release was not acknowledged; input and run resources remain owned.',
      );
      requestCancellation();
      return false;
    }
  };
  let safe = false;
  try {
    try {
      if (!lifetime.stopped && !terminal.sealed) {
        if (
          detectOutputMode({
            stdoutIsTty: io.stdoutIsTty,
            json: deps.json === true,
            ci: isCiEnv(io.env),
          }) === 'tui'
        )
          jobControl = terminal.createJobControl((adopt) =>
            wireRunJobControl({
              write: (text) => io.writeOut(text),
              adopt,
              onFailure: (cause) => {
                // A recoverable self-stop refusal is not the run's eventual outcome.
                // Unexpected native faults must reach its original owner before reattachment.
                if (toUserFacing(cause).exitCode === EXIT_CODES.infrastructureFailed)
                  lifetime.failure(cause);
              },
            }),
          );
        if (deps.makeGatePrompter !== undefined) gatePrompter = deps.makeGatePrompter();
        renderer = terminal.createRenderer(makeRenderer);
      }
    } catch (error) {
      recordFault(error);
      requestCancellation();
    }
    for (;;) {
      const seen = revision;
      const gate = gates.values().next().value;
      if (
        gate !== undefined &&
        gatePrompter !== undefined &&
        renderer !== undefined &&
        mayPrompt()
      ) {
        const controller = new AbortController();
        activePrompt = controller;
        const card: NonNullable<typeof openCard> = { gate, controller };
        openCard = card;
        const recorded = budgetContexts.get(gate.gateId);
        try {
          const handled = await joined(
            resolveGateInline(
              engine,
              {
                requestCancellation,
                mayPrompt,
                expectTerminal: () => {
                  inlineTerminating = true;
                },
                inputReleaseFailed: () => {
                  inputReleaseFailed = true;
                },
                signal: controller.signal,
                runPrompt: (invoke) => terminal.runPrompt(invoke),
                decidedElsewhere: () => card.decided,
                answered: (decision) => {
                  card.answered = { decision: decision.decision, decidedBy: decision.decidedBy };
                },
                runViewOperation: (invoke, mayAcquire) =>
                  terminal.runViewOperation(invoke, mayAcquire),
                failed: recordFault,
              },
              renderer,
              gatePrompter,
              gate,
              io,
              recorded?.nodeId === gate.nodeId ? recorded.context : undefined,
            ),
            controller.signal,
          );
          if (handled) {
            handledGates.add(gate.gateId);
            gates.delete(gate.gateId);
          } else inlineRefused = true;
          // A card closed under the user can leave keys in flight that the next card would take as its answer
          // (Clack's `y` approves outright), so this run's later gates are left for the command its summary names.
          if (card.decided !== undefined) inlineRefused = true;
        } catch (error) {
          recordFault(error);
          requestCancellation();
        } finally {
          if (activePrompt === controller) activePrompt = undefined;
          if (openCard === card) openCard = undefined;
        }
        continue;
      }
      const wantsDeparture =
        streamEnded ||
        isTerminalOutcome(outcome) ||
        (!cancelRequested &&
          !inlineTerminating &&
          pause !== undefined &&
          shouldBreakOnPause(pause, gatePrompter !== undefined && !inlineRefused, handledGates));
      if (wantsDeparture) {
        if (!(await releaseInput())) {
          await progressAfter(seen);
          continue;
        }
        const claim = await joined(beginDeparture()).catch(async () => {
          requestCancellation();
          return await retainUnacknowledged();
        });
        if (claim.kind !== 'continue') {
          departure = claim;
          publishHealth();
          await joined(primary);
          publishHealth();
          if (!primaryDone) return await retainUnacknowledged();
          safe = true;
          break;
        }
        departureWork = undefined;
        // Continue preserves the same reader and live view. Retry only after actual progress.
        if (!isTerminalOutcome(outcome) && !streamEnded) {
          try {
            await terminal.runViewOperation(() => renderer?.resume?.());
            inputReleased = false;
          } catch (error) {
            recordFault(error);
            requestCancellation();
          }
        }
      }
      await progressAfter(seen);
    }
    publishHealth();
    try {
      if (!terminal.sealed) await terminal.runViewOperation(() => renderer?.finalize?.(), false);
    } catch (cause) {
      recordFault(cause);
      diagnostic('cleanup_failed', 'The run view could not write its final summary after cleanup.');
    }
    if (departure !== undefined) {
      reportDepartureHealth(
        io,
        deps.json === true,
        departure,
        finalDurability ?? 'durable',
        outcome,
        finalTerminalError,
      );
    }
    if (driveError !== undefined) {
      const finalExitCode = outcomeToExitCode(
        outcome,
        finalDurability,
        finalTerminalError,
        departure,
      );
      if (
        departure !== undefined &&
        (finalExitCode === EXIT_CODES.moneyDurabilityUncertain ||
          finalExitCode === EXIT_CODES.effectNeedsAttention ||
          finalExitCode === EXIT_CODES.durabilityUncertain ||
          finalExitCode === EXIT_CODES.runOwnedElsewhere)
      ) {
        diagnostic(
          'cleanup_failed',
          'The command also failed while driving the run; final receipt health takes priority.',
        );
      } else return rethrowDriveFailure(driveError.cause);
    }
    return outcome;
  } finally {
    // This finally is reachable only after the actual input, engine and primary ACKs.
    // An unacknowledged input owner deliberately retains SIGINT and command resources.
    if (safe && departure !== undefined) {
      try {
        jobControl?.dispose();
      } catch (cause) {
        recordFault(cause);
        diagnostic('cleanup_failed', 'The run job-control listeners could not be released.');
      } finally {
        lifetime.signal.removeEventListener('abort', onStop);
      }
      try {
        await iterator?.return?.();
      } catch (cause) {
        recordFault(cause);
        diagnostic(
          'cleanup_failed',
          'The primary reader could not finish its local cleanup after run departure.',
        );
      }
    }
  }
}

interface InlineGateLifecycle {
  readonly requestCancellation: () => void;
  readonly mayPrompt: () => boolean;
  readonly expectTerminal: () => void;
  readonly inputReleaseFailed: () => void;
  readonly signal: AbortSignal;
  readonly runPrompt: (
    invoke: () => ReturnType<GatePrompter['prompt']>,
  ) => ReturnType<GatePrompter['prompt']>;
  /** How the gate was decided while its card was open, when something other than the card decided it. */
  readonly decidedElsewhere: () => string | undefined;
  /** Record the decision the card returned, so the resumed event that carries it is not taken for another's. */
  readonly answered: (decision: GateDecision) => void;
  readonly failed: (cause: unknown) => void;
  readonly runViewOperation: (
    invoke: () => void | Promise<void>,
    mayAcquire?: boolean,
  ) => Promise<void>;
}

async function promptUntilStopped(
  invoke: () => ReturnType<GatePrompter['prompt']>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<GatePrompter['prompt']>>> {
  if (signal.aborted) return null;
  // Abort requests release; only the underlying prompt's settlement acknowledges it.
  return await invoke();
}

/**
 * Resolve an interactive human gate without leaving the live run: hand the terminal to the `@clack/prompts`
 * card (suspend the TUI), collect a decision, then re-mount. A `null` decision (the user aborted the card with
 * Ctrl-C / ESC at its approve or input step, or with Ctrl-C at the optional rejection reason, where Esc instead
 * keeps the rejection) cooperatively cancels the whole run; otherwise the decision is applied to the in-memory
 * run via `engine.resume`, which emits `human_gate:resumed` and continues — both flow back through the loop.
 */
async function resolveGateInline(
  engine: WorkflowEngine,
  lifecycle: InlineGateLifecycle,
  renderer: RunRenderer,
  prompter: GatePrompter,
  event: HumanGatePausedEvent,
  io: CliIo,
  budget?: BudgetPromptContext,
): Promise<boolean> {
  let decision: Awaited<ReturnType<GatePrompter['prompt']>>;
  let reported = false;
  /** Say, once, that nothing from this terminal was recorded because something else decided the gate first. */
  const reportDecidedElsewhere = (): void => {
    const decided = lifecycle.decidedElsewhere();
    if (reported || decided === undefined) return;
    reported = true;
    io.writeErr(
      `Gate ${sanitizeInline(event.gateId)} was already decided (${sanitizeInline(decided)}); ` +
        'no answer from this terminal was recorded. Later gates in this run are not prompted here.\n',
    );
  };
  try {
    await lifecycle.runViewOperation(() => renderer.suspend?.(), false);
  } catch (error) {
    lifecycle.inputReleaseFailed();
    throw error;
  }
  try {
    if (!lifecycle.mayPrompt()) return true;
    decision = await promptUntilStopped(
      () => lifecycle.runPrompt(() => prompter.prompt(event, budget, lifecycle.signal)),
      lifecycle.signal,
    );
    if (decision !== null) lifecycle.answered(decision);
    // Said while the terminal is still the prompt's, so it lands under the card rather than inside the live view.
    reportDecidedElsewhere();
  } catch (cause) {
    // Preserve the prompt failure before a competing restoration failure enters its finally.
    lifecycle.failed(cause);
    throw cause;
  } finally {
    // Re-mount best-effort: a re-mount failure (ink's render() throwing) must NOT mask the prompt's decision
    // or its error — a throwing `finally` would replace the try's outcome. Surface it to stderr and move on,
    // exactly like driveRun's teardown (finalize) guard above.
    try {
      if (lifecycle.mayPrompt()) await lifecycle.runViewOperation(() => renderer.resume?.());
    } catch (resumeErr) {
      lifecycle.failed(resumeErr);
      lifecycle.requestCancellation();
      io.writeErr('The live view could not be restored after the gate prompt.\n');
    }
  }
  if (lifecycle.signal.aborted) {
    // The deadline may have decided the gate after the prompt returned, aborting this card too.
    reportDecidedElsewhere();
    return true;
  }
  if (decision === null) {
    lifecycle.requestCancellation();
    return true;
  }
  try {
    await engine.resume(event.runId, event.gateId, decision);
    // A resume the engine ignores because the gate is already decided is silent; say so if that is why.
    reportDecidedElsewhere();
    return true;
  } catch (err) {
    // A Ctrl-C during the prompt cooperatively cancels the run (the SIGINT handler calls handle.cancel());
    // if that settles the run in the window between the prompt returning and this await, the engine refuses
    // the now-moot decision with `run_already_terminal`. That is a clean cancellation, not a fault — return
    // and let the loop drain the buffered run:cancelled (→ outcome 'cancelled'), never a generic "internal
    // error". Any other engine refusal is a real bug and re-throws.
    if (err instanceof EngineStateError && err.code === 'run_already_terminal') {
      lifecycle.expectTerminal();
      return true;
    }
    if (
      budget !== undefined &&
      err instanceof EngineStateError &&
      err.code === 'invalid_decision'
    ) {
      io.writeErr(
        `budget gate ${budgetIdentifier(event.gateId)} remains pending: ${sanitizeUntrustedInline(err.message)}\n`,
      );
      return false;
    }
    throw err;
  }
}

/**
 * Whether an aggregate `run:paused` should stop the loop (→ gate-paused exit `3`). With no prompter (CI /
 * `--json` / no-TTY) it always stops. With a prompter, every human gate was already resolved inline by the
 * time its aggregate pause arrives (events are delivered in `sequenceNumber` order), so the pause is
 * informational — UNLESS it carries a gate we never handled or a media-job park, neither resolvable inline.
 */
export function shouldBreakOnPause(
  event: RunPausedEvent,
  hasPrompter: boolean,
  handledGates: ReadonlySet<string>,
): boolean {
  if (!hasPrompter) {
    return true;
  }
  const mediaPark = (event.pendingMediaJobNodeIds?.length ?? 0) > 0;
  const unhandledGate = event.gateIds.some((gateId) => !handledGates.has(gateId));
  return mediaPark || unhandledGate;
}

/**
 * Map a {@link RunOutcome} (or `undefined` — the stream ended with no terminal/paused, an abnormal unwind) plus
 * the handle's durability disposition to a CLI exit code. The single owner of the outcome→exit contract, shared by `run` and `gate` so the two can
 * never drift and a new `RunOutcome` variant has exactly one place to update. (`gate` handles its own
 * `undefined` case — an idempotent closed-handle resume → exit 0 — BEFORE calling this; here `undefined` is the
 * generic abnormal-unwind → failure, which is what `run` wants.)
 */
export function outcomeToExitCode(
  outcome: RunOutcome | undefined,
  /**
   * The handle's durability disposition (ADR-0078 §5). `'uncertain'` OUTRANKS a `completed` outcome: the
   * terminal was delivered in-process but its durable write did not land, so exiting 0 would tell a script
   * the run is recorded when it is not — the exact claim `CR-92` exists to stop. Absent ⇒ treated as
   * durable, which is what every pre-CR-92 caller assumed and what a surface with no handle can honestly say.
   */
  durability?: RunDurability,
  /**
   * The `ErrorCode` on the run's terminal, when it failed
   * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §8). Read for exactly one
   * code today: `effect_needs_attention`, whose remedy is unlike every other failure's — do NOT retry, go
   * look at the target, then resolve the row.
   *
   * Read from the TERMINAL rather than from `durability()`, deliberately. The disposition means one thing
   * (ADR-0078 §5: did the terminal's write land) and it is `'durable'` here — the run recorded its failure
   * correctly. Overloading `'uncertain'` would send this to exit 5, whose documented remedy ("held in the
   * outbox and retried on the next start") is false: nothing will drain, because nothing is pending.
   */
  terminalErrorCode?: ErrorCode,
  departure?: Exclude<RunDeparture, { readonly kind: 'continue' }>,
  idempotentClosed = false,
): ExitCode {
  if (departure?.moneyDurability === 'uncertain') return EXIT_CODES.moneyDurabilityUncertain;
  if (departure?.effectNeedsAttention || terminalErrorCode === 'effect_needs_attention')
    return EXIT_CODES.effectNeedsAttention;
  if (durability === 'uncertain') {
    // **No TERMINAL + `uncertain` is a FENCED run, not an unwritten terminal** (ADR-0079 §5 vs ADR-0078 §5).
    // The two share the disposition and need opposite advice. A fenced loser deliberately writes nothing to
    // the outbox — the run belongs to another process and is being recorded by it right now — so exit 5's
    // documented remedy ("held in the outbox and retried on the next start") is false for it, and a script
    // following that advice waits for a drain that will never happen.
    //
    // The discriminator is `isTerminalOutcome`, NOT `outcome === undefined`, and the difference is a real
    // bug this once had: `run:paused` also sets `outcome`, and the engine buffers that event before it
    // discovers the fence. An inline gate prompt therefore delivers a stale `run:paused` AFTER the run has
    // been fenced, leaving `outcome === 'paused'` — so the `undefined` test took the wrong branch and
    // reported exit 5 for the flagship two-terminal race this code exists to classify. A pause is not a
    // terminal, which is exactly what `isTerminalOutcome` already says.
    return isTerminalOutcome(outcome)
      ? EXIT_CODES.durabilityUncertain
      : EXIT_CODES.runOwnedElsewhere;
  }
  if (outcome === undefined && idempotentClosed) return EXIT_CODES.success;
  switch (outcome) {
    case 'completed':
      return EXIT_CODES.success;
    case 'paused':
      return EXIT_CODES.gatePaused;
    default:
      // failed / cancelled / (an abnormal no-terminal `undefined`) → non-zero workflow failure.
      return EXIT_CODES.workflowFailed;
  }
}

/** Final local health is stderr-only and independent of the ordered RunEvent stdout rail. */
export function reportDepartureHealth(
  io: CliIo,
  json: boolean,
  departure: Exclude<RunDeparture, { readonly kind: 'continue' }>,
  durability: RunDurability,
  outcome: RunOutcome | undefined,
  terminalErrorCode?: ErrorCode,
): void {
  const exitCode = outcomeToExitCode(outcome, durability, terminalErrorCode, departure);
  const effectNeedsAttention =
    departure.effectNeedsAttention || terminalErrorCode === 'effect_needs_attention';
  const code =
    exitCode === EXIT_CODES.moneyDurabilityUncertain
      ? 'money_durability_uncertain'
      : exitCode === EXIT_CODES.effectNeedsAttention
        ? 'effect_needs_attention'
        : undefined;
  if (code === undefined) return;
  const terminalDurability =
    isTerminalOutcome(outcome) && durability !== 'pending' ? durability : 'none';
  const effectAdvice = 'Do not retry; inspect the target and resolve the effect record.';
  const message =
    code === 'money_durability_uncertain'
      ? 'Required money receipts could not be confirmed. Do not repeat paid work; check provider billing and the run log.' +
        (effectNeedsAttention ? ` ${effectAdvice}` : '')
      : `An external effect needs attention. ${effectAdvice}`;
  io.writeErr(
    json
      ? stringifyJsonLine({
          type: 'diagnostic',
          code,
          message,
          terminalDurability,
          effectNeedsAttention,
        }) + '\n'
      : message +
          ` Terminal durability: ${terminalDurability}; effect needs attention: ${effectNeedsAttention}.\n`,
  );
}

/**
 * Did the run reach a TERMINAL disposition (`completed | failed | cancelled`)? `paused` is non-terminal (the run
 * is resumable) and `undefined` is an abnormal no-terminal unwind — neither is terminal. The single owner of the
 * "is this run done" predicate, shared by `run`/`gate` so the run-end host media GC fires only on a real terminal
 * (2.S/D-GC — never while a run is merely paused, whose media it must keep for the resume).
 */
export function isTerminalOutcome(
  outcome: RunOutcome | undefined,
): outcome is Exclude<RunOutcome, 'paused'> {
  return outcome !== undefined && outcome !== 'paused';
}

function nextOutcome(current: RunOutcome | undefined, event: RunEvent): RunOutcome | undefined {
  switch (event.type) {
    case 'run:completed':
      return 'completed';
    case 'run:failed':
      return 'failed';
    case 'run:cancelled':
      return 'cancelled';
    case 'run:paused':
      return 'paused';
    default:
      return current;
  }
}
