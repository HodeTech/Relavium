import {
  EngineStateError,
  WorkflowValidationError,
  validateWorkflowWithCatalog,
  type RunHandle,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowModelCatalog,
} from '@relavium/core';
import type {
  ErrorCode,
  HumanGatePausedEvent,
  RunDurability,
  RunEvent,
  RunPausedEvent,
} from '@relavium/shared';

import type { GatePrompter } from '../gate/prompter.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { RunRenderer } from '../render/renderer.js';
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

/** A run's terminal disposition (`undefined` means the stream ended with no terminal/paused — an abnormal unwind). */
export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

export interface DriveRunDeps {
  readonly engine: WorkflowEngine;
  readonly handle: RunHandle;
  /**
   * Constructs the renderer — called INSIDE, after the SIGINT handler is registered, so a renderer-construction
   * throw (e.g. `ink`'s `render()`) still unwinds through the same finally (cancel the live run, remove the
   * listener) instead of leaving a running engine with no cooperative-cancel handler.
   */
  readonly makeRenderer: () => RunRenderer;
  /** Present only in the interactive TUI path; absent (or `undefined`) → a human-gate pause breaks to the
   * gate-paused exit `3` (the callers pass `selectGatePrompter(...)`, which is `GatePrompter | undefined`). */
  readonly gatePrompter?: GatePrompter | undefined;
  readonly io: CliIo;
}

/**
 * Drive a live run's event stream to a terminal/paused outcome — the SHARED core of `relavium run` (a fresh
 * `engine.start`) and `relavium gate` (a resumed `engine.resumeFromCheckpoint`), so the two never fork the
 * event loop, the SIGINT contract, or the renderer teardown (2.G).
 *
 * It: registers the cooperative-cancel SIGINT handler (`process.on`, never `once` — see below), feeds every
 * event to the renderer, resolves an interactive human gate **inline** when a {@link GatePrompter} is present
 * (suspend the TUI → prompt → `engine.resume` → re-mount, all on the same in-memory run), and on a
 * non-interactive pause breaks to the gate-paused exit. The renderer is finalized even on a throw, and the
 * SIGINT handler removed LAST — so `ink`'s `signal-exit` never becomes the sole SIGINT listener mid-teardown
 * (which would re-raise → exit 130; the 2.E Ctrl-C contract).
 */
export async function driveRun(deps: DriveRunDeps): Promise<RunOutcome | undefined> {
  const { engine, handle, makeRenderer, gatePrompter, io } = deps;
  let outcome: RunOutcome | undefined;
  let cancelRequested = false;
  /** gateIds a prompter handled inline (resolved OR cancelled) — so a stale aggregate `run:paused` is ignored. */
  const handledGates = new Set<string>();

  // Register the cancel handler the instant the run is live — BEFORE constructing the renderer — so a failure
  // building the renderer (ink's `render()` throwing) can never leave a running engine with no cooperative-cancel
  // handler; a Ctrl-C in that window still routes to handle.cancel(). The finally removes it, so it can't leak.
  const onSigint = (): void => {
    if (cancelRequested) {
      // A second Ctrl-C while the cooperative cancel is still draining — force a clean, deterministic exit
      // rather than hang (e.g. a provider ignoring the abort), and never the bare-signal 130.
      process.exit(EXIT_CODES.workflowFailed);
    }
    cancelRequested = true;
    handle.cancel(); // cooperative cancel → run:cancelled (idempotent, safe post-terminal)
  };
  // `process.on`, NOT `process.once`: an interactive run mounts ink, which registers a `signal-exit` SIGINT
  // listener that RE-RAISES SIGINT (→ 128+2 = exit 130) BUT ONLY when it is the sole remaining SIGINT listener.
  // A `once` handler removes itself the instant it fires, so signal-exit then sees only itself and re-raises —
  // killing the run at 130 before the cooperative cancel completes. Staying registered keeps signal-exit from
  // re-raising, so cancel → run:cancelled → exit 1 wins. Removed in the finally.
  process.on('SIGINT', onSigint);
  // G0's residue on this path: ink hides the cursor while it renders and `signal-exit` does not handle
  // SIGTSTP, so a Ctrl-Z during a run left the user's terminal with a permanently invisible cursor. Narrow by
  // design — this path enters neither the alternate screen nor mouse reporting, so there is nothing else to
  // release. Removed in the finally alongside the SIGINT handler.
  const jobControl = wireRunJobControl({ write: (text) => io.writeOut(text) });
  let renderer: RunRenderer | undefined;
  try {
    renderer = makeRenderer();
    for await (const event of handle.events) {
      renderer.onEvent(event);
      outcome = nextOutcome(outcome, event);

      if (event.type === 'human_gate:paused' && gatePrompter !== undefined) {
        handledGates.add(event.gateId);
        await resolveGateInline(engine, handle, renderer, gatePrompter, event, io);
        continue; // a resolve continues the run; a cancel drains it to run:cancelled — keep consuming either way
      }
      // A non-breaking run:paused (a prompter handled every gate inline, no media park) is informational —
      // the resumed run continues. Only a real pause (CI/plain/json, or an unresolvable park) stops → exit 3.
      if (
        event.type === 'run:paused' &&
        shouldBreakOnPause(event, gatePrompter !== undefined, handledGates)
      ) {
        break;
      }
    }
  } finally {
    // No terminal/paused outcome means we're unwinding abnormally (renderer construction threw, or the event
    // stream rejected) — cancel the still-live run so it doesn't keep executing unsupervised while the error
    // propagates (cancel is idempotent + safe post-terminal).
    if (outcome === undefined) {
      handle.cancel();
    }
    jobControl.dispose();
    // Tear the renderer down even on a throw: the ink TUI must unmount to restore the terminal and write its
    // persistent final summary. The `?.` is a no-op for the line/NDJSON renderers and when `renderer` is still
    // undefined (construction threw). A teardown error must NOT mask the run's real outcome/error — surface it
    // to stderr and move on.
    try {
      await renderer?.finalize?.();
    } catch (teardownErr) {
      io.writeErr(
        `renderer teardown failed: ${teardownErr instanceof Error ? teardownErr.message : String(teardownErr)}\n`,
      );
    }
    // Remove our SIGINT handler LAST — keep it registered across ink's unmount (renderer.finalize) so a Ctrl-C
    // during unmount still hits us (forcing a clean exit 1) and ink's `signal-exit` never becomes the sole SIGINT
    // listener (which would re-raise → 130). After finalize, ink has unsubscribed its own listener.
    process.removeListener('SIGINT', onSigint);
  }
  return outcome;
}

/**
 * Resolve an interactive human gate without leaving the live run: hand the terminal to the `@clack/prompts`
 * card (suspend the TUI), collect a decision, then re-mount. A `null` decision (the user aborted the prompt
 * with Ctrl-C / ESC) cooperatively cancels the whole run; otherwise the decision is applied to the in-memory
 * run via `engine.resume`, which emits `human_gate:resumed` and continues — both flow back through the loop.
 */
async function resolveGateInline(
  engine: WorkflowEngine,
  handle: RunHandle,
  renderer: RunRenderer,
  prompter: GatePrompter,
  event: HumanGatePausedEvent,
  io: CliIo,
): Promise<void> {
  let decision: Awaited<ReturnType<GatePrompter['prompt']>>;
  await renderer.suspend?.();
  try {
    decision = await prompter.prompt(event);
  } finally {
    // Re-mount best-effort: a re-mount failure (ink's render() throwing) must NOT mask the prompt's decision
    // or its error — a throwing `finally` would replace the try's outcome. Surface it to stderr and move on,
    // exactly like driveRun's teardown (finalize) guard above.
    try {
      await renderer.resume?.();
    } catch (resumeErr) {
      io.writeErr(
        `failed to restore the live view after the gate prompt: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}\n`,
      );
    }
  }
  if (decision === null) {
    handle.cancel();
    return;
  }
  try {
    await engine.resume(event.runId, event.gateId, decision);
  } catch (err) {
    // A Ctrl-C during the prompt cooperatively cancels the run (the SIGINT handler calls handle.cancel());
    // if that settles the run in the window between the prompt returning and this await, the engine refuses
    // the now-moot decision with `run_already_terminal`. That is a clean cancellation, not a fault — return
    // and let the loop drain the buffered run:cancelled (→ outcome 'cancelled'), never a generic "internal
    // error". Any other engine refusal is a real bug and re-throws.
    if (err instanceof EngineStateError && err.code === 'run_already_terminal') {
      return;
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
): ExitCode {
  if (terminalErrorCode === 'effect_needs_attention' && durability !== 'uncertain') {
    // Outranks an ordinary `failed`, but NOT an uncertain disposition — and that ordering is the point.
    // The two describe independent uncertainties: `7` says an external effect may be outstanding, `5`/`6`
    // say this process does not know whether its terminal was recorded (or that another process owns the
    // run). When both hold, the terminal itself is in doubt, so the code that describes the RECORD wins —
    // a caller that cannot trust the record cannot act on what the record says the reason was. A review
    // caught this as an assertion the code made and did not test; it is now the tested behaviour.
    return EXIT_CODES.effectNeedsAttention;
  }
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
