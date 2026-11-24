import type { RunHandle, WorkflowEngine } from '@relavium/core';

import type { RendererCreationOwner } from '../commands/workflow-terminal.js';
import type { EffectNoticeOwner } from '../engine/effect-retention.js';
import type { WorkflowSafetyExit } from '../process/exit-observations.js';
import type { CliInvocation } from '../process/invocation.js';
import type { RunRenderer } from '../render/renderer.js';
import type { RunJobControl } from '../render/run-job-control.js';

/**
 * The terminal view a hosted run drives, as `driveRun` uses it
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1).
 *
 * `WorkflowTerminal` is the shell's implementation. The Home's own terminal owner is the other host's.
 */
export interface RunTerminalView {
  /** Once sealed, no new view, prompt or input acquisition may start. */
  readonly sealed: boolean;
  /** Hand the input back (suspend the live view's raw mode); the same release is reused until a new view operation. */
  releaseInput(): Promise<void>;
  createJobControl(
    factory: (adopt: (control: RunJobControl) => void) => RunJobControl,
  ): RunJobControl;
  createRenderer(factory: (creation: RendererCreationOwner) => RunRenderer): RunRenderer;
  /** A prompt's fulfilment is its release contract; rejection or abort alone is never the acknowledgement. */
  runPrompt<T>(factory: () => Promise<T>): Promise<T>;
  runViewOperation<T>(factory: () => T | Promise<T>, mayAcquire?: boolean): Promise<T>;
}

/**
 * Everything the shared run core (`prepareRun`, `resumeRun`, `driveRun`) needs from the host that owns the
 * process: signal custody, the stop request, the failure and safety observations, the adopted engine and
 * handle, and the terminal view.
 *
 * Two hosts implement it: `WorkflowLifetime` (the shell — it owns signal custody and registers the
 * `workflow` and `terminal` owners with its invocation) and, in MVP-8 step 3, the Home's hosted-run
 * lifetime. The interface lists exactly what the core uses today and nothing a host-specific `execute` or
 * `finish` does; the core never drives either.
 */
export interface RunLifetime {
  /** The invocation whose registry, budget and native-process owner the run's resources are registered with. */
  readonly invocation: CliInvocation;
  readonly terminal: RunTerminalView;
  /** Delivers advisory notices from the effect-journal retention passes under the original owner. */
  readonly effectNoticeOwner: EffectNoticeOwner;
  /** Aborts when the host asks the run to stop (a signal, a deadline, a refusal elsewhere). */
  readonly signal: AbortSignal;
  readonly stopped: boolean;
  /** Throws the host's stopped marker once a stop was requested; called between awaits of the preparation. */
  checkpoint(): void;
  /** True only for the host's own stopped marker, never for a failure that happened to coincide with a stop. */
  isStoppedFailure(cause: unknown): boolean;
  stop(): void;
  adoptEngine(engine: WorkflowEngine, runId?: string): void;
  adoptHandle(handle: RunHandle): void;
  /** Publish a workflow safety exit (8, 7, 5, 6) and whether the host may now retire its owner. */
  publish(safety: WorkflowSafetyExit | undefined, hostSafe: boolean): void;
  /** Observe an advisory sink or formatter fault under this owner, before the engine recovers from it. */
  notification<Args extends unknown[]>(consume: (...args: Args) => void): (...args: Args) => void;
  failure(cause: unknown): void;
  /** Cleanup could not be acknowledged: the host keeps its resources owned and bounds its retention. */
  cleanupFailed(cause: unknown): void;
}
