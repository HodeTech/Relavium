import { EngineStateError, type RunHandle, type WorkflowEngine } from '@relavium/core';

import type { EffectNoticeOwner } from '../engine/effect-retention.js';
import { toUserFacing } from '../process/errors.js';
import type { WorkflowSafetyExit } from '../process/exit-observations.js';
import type { CliInvocation } from '../process/invocation.js';
import type { OwnerFailureCode, OwnerRetirement } from '../process/invocation-registry.js';
import { ownNotification } from '../process/owned-notification.js';
import type { RunJobControl } from '../render/run-job-control.js';
import type { RunLifetime, RunTerminalView } from '../run-core/run-lifetime.js';

/**
 * What a hosted leg's {@link HostedRunLifetime.finish} reports.
 *
 * `retired`: the leg's cleanup was acknowledged, so its owner left the Home's registry. `retained`: it was not
 * (the handle never departed, or a cleanup could not be acknowledged), so the owner stays registered and the
 * Home's finite-exit bound is what ends the wait. Either way `finish()` itself returns.
 */
export type HostedLegRetirement = 'retired' | 'retained';

/** The one inert job control every hosted leg gets: the Home already owns the terminal's job control. */
const INERT_JOB_CONTROL: RunJobControl = Object.freeze({ dispose: () => undefined });

/**
 * The classification an owner-stage fault is recorded under: the fault's own, not a constant.
 *
 * `WorkflowLifetime` files every owner-stage fault as `cli_internal`, which is right for a process that exists
 * to run one command: the process is over either way. In the Home the same constant would start the invocation's
 * fatal bound, and one leg's classified failure (a storage refusal, say) would end the Home with it
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §6). What the
 * registry cannot express (an invocation or ownership refusal) is recorded as the operational `internal`; an
 * unclassifiable fault stays `cli_internal`, because `toUserFacing` already files it there.
 */
function ownerFailureCode(cause: unknown): OwnerFailureCode {
  const { code } = toUserFacing(cause);
  switch (code) {
    case 'cli_internal':
    case 'output_unavailable':
    case 'storage_unavailable':
    case 'internal':
      return code;
    default:
      return 'internal';
  }
}

/**
 * The lifetime of ONE hosted leg of a run started or resumed inside the Home: the second implementation of
 * {@link RunLifetime}, beside the shell's `WorkflowLifetime`
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1, §6).
 *
 * A fresh instance is built for every leg, because a leg is one engine's hosting of a run and an owner is
 * retired for good when its leg's cleanup is acknowledged.
 *
 * It is `WorkflowLifetime` minus everything the Home already owns, and plus the three differences the Home
 * needs:
 *
 * - **It registers first.** The `workflow` owner is registered with the Home's invocation registry in the
 *   constructor, which the host runs before any work is admitted (before `prepareRun` builds the engine), so a
 *   termination request that arrives during preparation reaches this leg.
 * - **It claims nothing the Home holds.** No signal custody (the Home's surface claimed it, and a second claim
 *   throws), no signal subscription (an external signal goes to the Home's one finite-exit authority, which
 *   stops this owner), no terminal owner (the view is the Home's) and no job control (`createJobControl` is
 *   inert, or `driveRun` would install a second one).
 * - **It classifies by cause and never waits forever.** An owner-stage fault is filed under its own
 *   classification (see {@link ownerFailureCode}), a leg's ordinary outcomes are view state and are not
 *   published, and {@link HostedRunLifetime.finish} returns for a leg that did not retire, where the shell's
 *   keeps its process alive for the exit authority the Home already has.
 *
 * Only the workflow SAFETY facts (money not confirmed 8, an effect needing attention 7, a held terminal 5, taken
 * over elsewhere 6) and infrastructure faults reach the Home's exit code, through the registry's sticky
 * priority; a leg's `0`, `1`, `3` or cancel never does.
 */
export class HostedRunLifetime implements RunLifetime {
  readonly invocation: CliInvocation;
  readonly terminal: RunTerminalView;
  readonly effectNoticeOwner: EffectNoticeOwner;
  readonly #cancel = new AbortController();
  readonly #stoppedMarker = new Error('Hosted run stopped.');
  readonly #retired: Promise<OwnerRetirement>;
  #resolveRetired: (value: OwnerRetirement) => void = () => undefined;
  #engine: WorkflowEngine | undefined;
  #runId: string | undefined;
  #handle: RunHandle | undefined;
  #cancelledHandle: RunHandle | undefined;
  #engineCancelRequested = false;
  #stopped = false;
  #safety: WorkflowSafetyExit | undefined;
  #hostSafe = true;
  #cleanupAcknowledged = true;
  #finishing: Promise<HostedLegRetirement> | undefined;

  /**
   * @param invocation the HOME's invocation: its registry, finite-exit authority and budget.
   * @param view the Home's own terminal view; every member but `createJobControl` is the Home's.
   */
  constructor(invocation: CliInvocation, view: RunTerminalView) {
    Object.freeze(this.#stoppedMarker);
    this.invocation = invocation;
    this.#retired = new Promise((resolve) => {
      this.#resolveRetired = resolve;
    });
    this.terminal = Object.freeze({
      get sealed(): boolean {
        return view.sealed;
      },
      releaseInput: () => view.releaseInput(),
      createJobControl: (): RunJobControl => INERT_JOB_CONTROL,
      createRenderer: (factory: Parameters<RunTerminalView['createRenderer']>[0]) =>
        view.createRenderer(factory),
      runPrompt: <T>(factory: () => Promise<T>): Promise<T> => view.runPrompt(factory),
      runViewOperation: <T>(factory: () => T | Promise<T>, mayAcquire?: boolean): Promise<T> =>
        view.runViewOperation(factory, mayAcquire),
    });
    this.effectNoticeOwner = Object.freeze({
      signal: this.signal,
      assertAdmitting: () => this.checkpoint(),
      failure: (cause: unknown) => this.failure(cause),
      work: Object.freeze({
        retainWork: <T>(factory: () => Promise<T>): Promise<T> =>
          this.terminal.runViewOperation(factory, false),
      }),
    });
    // Last, so a constructor that throws leaves no owner behind that nothing can retire. It still runs before
    // the host does any work, and `register` itself refuses once the invocation is terminating.
    invocation.registry.register({
      kind: 'workflow',
      retired: this.#retired,
      stop: () => this.stop(),
      join: () => this.#retired.then(() => undefined),
      readSafetyExit: () => this.#safety,
      classifyFailure: (_stage, cause) => ownerFailureCode(cause),
    });
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
  /** Request the cooperative cancel of this leg: the engine's own, idempotent per handle. */
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
  /**
   * Classify a fault by the same projection the shell uses (`toUserFacing`). An infrastructure fault
   * (`cli_internal`, `output_unavailable`) is a fact about the Home's process and starts its fatal bound. Every
   * other classification (an invalid invocation, a storage refusal, a taken-over run) is this leg's own: the host
   * shows it in the run view, and it is not published, because the Home outlives the leg and only the safety
   * facts and infrastructure faults may survive it.
   */
  failure(cause: unknown): void {
    if (this.isStoppedFailure(cause)) return;
    const classified = toUserFacing(cause);
    if (classified.code === 'cli_internal' || classified.code === 'output_unavailable') {
      this.invocation.registry.observations.observeFailure(classified.code);
      this.invocation.finiteExit.fail(classified.code);
    }
  }
  cleanupFailed(cause: unknown): void {
    this.#cleanupAcknowledged = false;
    this.failure(cause);
    // Failure to acknowledge owned cleanup is infrastructure uncertainty regardless of the original operation's
    // classification. Retention must always have a bound.
    this.invocation.finiteExit.fail('cli_internal');
  }
  /**
   * Called once, after the leg's actual cleanup tail (the departure, the primary reader and the leg's own
   * MCP clients and work), never by a deadline or a cancellation.
   *
   * It retires the owner when that cleanup was acknowledged, and ALWAYS returns. The shell's `finish()` waits
   * forever for a leg that is not host-safe, which is how its process is kept alive for its exit authority; the
   * Home's own owners hold that authority, so here the leg that is not host-safe is `retained` (its owner stays
   * registered and the Home's finite-exit bound applies) and the caller is not left holding a promise that never
   * settles. A second call returns the first call's answer.
   */
  finish(): Promise<HostedLegRetirement> {
    this.#finishing ??= Promise.resolve().then((): HostedLegRetirement => {
      if (!this.#cleanupAcknowledged) this.#hostSafe = false;
      if (!this.#hostSafe) return 'retained';
      this.#resolveRetired({ kind: 'settled' });
      return 'retired';
    });
    return this.#finishing;
  }
}
