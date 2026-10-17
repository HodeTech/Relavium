import { EngineStateError, type RunHandle, type WorkflowEngine } from '@relavium/core';
import { toUserFacing } from '../process/errors.js';
import { CliError } from '../process/cli-error.js';
import type { CliInvocation } from '../process/invocation.js';
import { createCliInvocation } from '../process/invocation.js';
import type { WorkflowSafetyExit } from '../process/exit-observations.js';
import type { OwnerRetirement } from '../process/invocation-registry.js';
import type { CliIo } from '../process/io.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import { defaultSubscribeSignals } from '../process/signals.js';
import { subscribeWithSignalCustody } from '../process/signal-custody.js';
import { WorkflowTerminal } from './workflow-terminal.js';
import { ownNotification } from '../process/owned-notification.js';
import type { EffectNoticeOwner } from '../engine/effect-retention.js';

/** Single command owner: registration/signals precede its first owned asynchronous preparation. */
export class WorkflowLifetime {
  readonly invocation: CliInvocation;
  readonly terminal: WorkflowTerminal;
  readonly effectNoticeOwner: EffectNoticeOwner;
  readonly #cancel = new AbortController();
  readonly #stoppedMarker = new Error('Workflow command stopped.');
  readonly #retired: Promise<OwnerRetirement>;
  #resolveRetired: (value: OwnerRetirement) => void = () => undefined;
  readonly #removeSignals: () => void;
  #engine: WorkflowEngine | undefined;
  #runId: string | undefined;
  #handle: RunHandle | undefined;
  #cancelledHandle: RunHandle | undefined;
  #engineCancelRequested = false;
  #stopped = false;
  #interrupted = false;
  #safety: WorkflowSafetyExit | undefined;
  #hostSafe = true;
  #cleanupAcknowledged = true;

  constructor(
    invocation: CliInvocation | undefined,
    io: CliIo,
    subscribeSignals = defaultSubscribeSignals,
  ) {
    Object.freeze(this.#stoppedMarker);
    this.invocation = invocation ?? createCliInvocation();
    this.invocation.finiteExit.activateFallback();
    this.#retired = new Promise((resolve) => {
      this.#resolveRetired = resolve;
    });
    this.invocation.registry.register({
      kind: 'workflow',
      retired: this.#retired,
      stop: () => this.stop(),
      join: () => this.#retired.then(() => undefined),
      readSafetyExit: () => this.#safety,
      classifyFailure: () => 'cli_internal',
    });
    this.terminal = new WorkflowTerminal(
      this.invocation.registry,
      io,
      () => this.checkpoint(),
      (cause) => this.failure(cause),
    );
    this.effectNoticeOwner = Object.freeze({
      signal: this.signal,
      assertAdmitting: () => this.checkpoint(),
      failure: (cause: unknown) => this.failure(cause),
      work: Object.freeze({
        retainWork: <T>(factory: () => Promise<T>): Promise<T> =>
          this.terminal.runViewOperation(factory, false),
      }),
    });
    this.#removeSignals = subscribeWithSignalCustody(
      this.invocation.signalCustody,
      subscribeSignals,
      (signo) => {
        if (
          signo === 2 &&
          !this.#interrupted &&
          this.invocation.registry.termination === undefined
        ) {
          this.#interrupted = true;
          this.stop();
        } else {
          this.invocation.finiteExit.signal(signo);
        }
      },
    );
  }
  get signal(): AbortSignal {
    return this.#cancel.signal;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  checkpoint(): void {
    if (this.#stopped) throw this.#stoppedMarker;
  }
  isStoppedFailure(cause: unknown): boolean {
    return cause === this.#stoppedMarker;
  }
  stop(): void {
    this.#stopped = true;
    this.#cancel.abort(this.#stoppedMarker);
    try {
      if (this.#handle !== undefined && this.#cancelledHandle !== this.#handle) {
        this.#cancelledHandle = this.#handle;
        this.#handle.cancel();
      } else if (
        this.#handle === undefined &&
        this.#engine !== undefined &&
        this.#runId !== undefined &&
        !this.#engineCancelRequested
      ) {
        this.#engineCancelRequested = true;
        this.#engine.cancel(this.#runId);
      }
    } catch (cause) {
      if (
        !(cause instanceof EngineStateError) ||
        (cause.code !== 'unknown_run' && cause.code !== 'run_already_terminal')
      )
        this.failure(cause);
    }
  }
  adoptEngine(engine: WorkflowEngine, runId?: string): void {
    this.#engine = engine;
    this.#runId = runId;
    if (this.#stopped) this.stop();
  }
  adoptHandle(handle: RunHandle): void {
    this.#handle = handle;
    this.#hostSafe = false;
    if (this.#stopped) this.stop();
  }
  publish(safety: WorkflowSafetyExit | undefined, hostSafe: boolean): void {
    this.invocation.registry.observations.observeWorkflowSafety(safety);
    const rank: Readonly<Record<WorkflowSafetyExit, number>> = { 8: 4, 7: 3, 5: 2, 6: 1 };
    if (safety !== undefined && (this.#safety === undefined || rank[safety] > rank[this.#safety]))
      this.#safety = safety;
    this.#hostSafe ||= hostSafe;
  }
  /** Observe advisory sink/formatter faults before engine recovery, using this original owner. */
  notification<Args extends unknown[]>(consume: (...args: Args) => void): (...args: Args) => void {
    return ownNotification(
      {
        signal: this.signal,
        assertAdmitting: () => this.checkpoint(),
        failure: (cause) => this.failure(cause),
      },
      consume,
    );
  }
  failure(cause: unknown): void {
    if (this.isStoppedFailure(cause)) return;
    const classified = toUserFacing(cause);
    this.invocation.registry.observations.observeFailure(classified.code);
    if (classified.code === 'cli_internal' || classified.code === 'output_unavailable')
      this.invocation.finiteExit.fail(classified.code);
  }
  cleanupFailed(cause: unknown): void {
    this.#cleanupAcknowledged = false;
    this.failure(cause);
  }
  async execute(body: () => Promise<ExitCode>): Promise<ExitCode> {
    let result: ExitCode = EXIT_CODES.workflowFailed;
    let failed: { readonly cause: unknown } | undefined;
    try {
      result = await body();
      // Publish the authoritative return before either owner can retire and unblock finite exit.
      if (result === 8 || result === 7 || result === 5 || result === 6)
        this.invocation.registry.observations.observeWorkflowSafety(result);
      else if (result === 9) this.invocation.finiteExit.fail('cli_internal');
      else this.invocation.registry.observations.observeOutcome(result);
    } catch (cause) {
      if (!this.isStoppedFailure(cause)) {
        failed = { cause };
        this.failure(cause);
      } else this.invocation.registry.observations.observeOutcome(EXIT_CODES.workflowFailed);
    } finally {
      await this.finish();
    }
    const combined = this.invocation.registry.observations.exitCode();
    if (
      failed !== undefined &&
      (this.#safety === undefined || toUserFacing(failed.cause).exitCode === this.#safety)
    ) {
      if (combined === 9 && toUserFacing(failed.cause).exitCode !== 9)
        throw new CliError(
          this.invocation.registry.observations.infrastructureCode() ?? 'cli_internal',
          '',
          { cause: failed.cause },
        );
      throw failed.cause;
    }
    // A terminating signal already routes physical exit through the shared finite capability.
    return combined >= 0 && combined <= 9 ? combinedExit(combined) : result;
  }
  /** Called only after the command's actual cleanup tail, never by a deadline or cancellation. */
  async finish(): Promise<void> {
    if (!this.#cleanupAcknowledged) this.#hostSafe = false;
    if (this.#hostSafe) this.#resolveRetired({ kind: 'settled' });
    await this.terminal.finish();
    if (!this.#hostSafe) await new Promise<never>(() => {});
    this.#removeSignals();
  }
}

function combinedExit(value: number): ExitCode {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
      return value;
    default:
      return EXIT_CODES.infrastructureFailed;
  }
}
