import { CliError } from './cli-error.js';
import {
  ExitObservations,
  assertTerminatingSignalNumber,
  type WorkflowSafetyExit,
} from './exit-observations.js';

/** Process termination backstop, never a receipt deadline or host-safe-close acknowledgement. */
export const FATAL_TERMINATION_MS = 3_000;

export interface InvocationClock {
  readonly now: () => number;
  readonly schedule: (milliseconds: number, fire: () => void) => () => void;
}

export interface RemainingBudget {
  readonly deadline: () => number | undefined;
  readonly remainingMs: () => number | undefined;
}

export type OwnerFailureCode =
  | 'internal'
  | 'storage_unavailable'
  | 'cli_internal'
  | 'output_unavailable';

/** Supplied by the creation owner after actual lifetime settlement, separately from cleanup attempts. */
export interface OwnerRetirement {
  readonly kind: 'settled';
  readonly failure?: OwnerFailureCode;
}

interface OwnerBase {
  readonly retired: Promise<OwnerRetirement>;
  /**
   * Synchronously seal admission/request finite cancellation, including at zero remaining budget.
   * At expiry, never launch an async helper; a returned promise may only observe already-started work.
   */
  readonly stop: (budget: RemainingBudget) => void | Promise<void>;
  readonly join: (budget: RemainingBudget) => void | Promise<void>;
  /** Classify only facts at this owned boundary; the registry never probes a private cause tree. */
  readonly classifyFailure: (stage: OwnerStage, cause: unknown) => OwnerFailureCode;
}

export interface WorkflowOwner extends OwnerBase {
  readonly kind: 'workflow';
  readonly readSafetyExit: () => WorkflowSafetyExit | undefined;
}

export interface SessionOwner extends OwnerBase {
  readonly kind: 'session';
  readonly surface: 'chat' | 'home' | 'agent';
}

/** Management/maintenance operations own raw work and cleanup, never workflow receipt health. */
export interface CommandOwner extends OwnerBase {
  readonly kind: 'command';
}

export interface TerminalOwner extends OwnerBase {
  readonly kind: 'terminal';
  readonly restore: (budget: RemainingBudget) => void | Promise<void>;
}

export interface NativeOwner extends OwnerBase {
  readonly kind: 'native-group' | 'native-pid' | 'windows-live-root';
  /** Current creation-owned eligibility. Group authority can outlive its leader; PID/root authority cannot. */
  readonly mayReap: () => boolean;
  /** A request/attempt, never target close ACK. Concrete PID/PGID/facility stays in the native adapter. */
  readonly reap: (budget: RemainingBudget) => void | Promise<void>;
  /** Adjust/cancel already-entered helper work only; synchronous notification grants no new entry or ACK. */
  readonly budgetChanged?: (budget: RemainingBudget) => void;
  /** Finite synchronous exit fallback only; never start an async helper or acknowledge native closure. */
  readonly exitReap?: () => void;
}

export type InvocationOwner =
  | WorkflowOwner
  | SessionOwner
  | CommandOwner
  | TerminalOwner
  | NativeOwner;
export type OwnerStage =
  | 'stop'
  | 'join'
  | 'restore'
  | 'reap'
  | 'retirement'
  | 'health'
  | 'budget'
  | 'exit';

export interface OwnerLease {
  readonly assertAdmitting: () => void;
  /** Close this owner only. Completion reports actual retirement, not receipt success. */
  readonly close: () => Promise<OwnerCloseResult>;
}

export interface OwnerCloseResult {
  readonly kind: 'retired' | 'unacknowledged';
}

export type TerminationRequest =
  | { readonly kind: 'normal' }
  | { readonly kind: 'infrastructure'; readonly code: 'cli_internal' | 'output_unavailable' }
  | { readonly kind: 'cooperative_cancel'; readonly outcome: 1 | 4; readonly deadline: number }
  | { readonly kind: 'signal'; readonly signalNumber: number; readonly deadline?: number };

export interface InvocationCloseResult {
  readonly kind: 'settled' | 'deadline';
  readonly unacknowledgedOwners: number;
}

interface Entry {
  readonly owner: InvocationOwner;
  readonly retirement: Promise<void>;
  readonly resolveRetirement: () => void;
  readonly stages: Map<OwnerStage, Promise<void>>;
  closing: boolean;
  retired: boolean;
  closeResult: Promise<OwnerCloseResult> | undefined;
  sampling: boolean;
  budgetObserved: boolean;
  budgetDeadline: number | undefined;
  budgetExpired: boolean;
  budgetReentered: boolean;
}

// Observe actual native Promise settlement, bypassing overridden then/foreign thenable protocols.
const nativeThen: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;

/**
 * Pure invocation lifetime coordinator. Runtime adapters own physical facts and DB-close permission.
 * Successful retirement releases closures; finite sticky diagnoses survive. No process or service imports.
 */
export class InvocationRegistry {
  readonly observations: ExitObservations;
  readonly #clock: InvocationClock;
  readonly #entries = new Set<Entry>();
  readonly #failures = new Set<string>();
  readonly #budget: RemainingBudget;
  readonly #waiters = new Set<() => void>();
  readonly #deferredCloses = new Set<() => void>();
  #admitting = true;
  #deadline: number | undefined;
  #expired = false;
  #disarm: (() => void) | undefined;
  #termination: Promise<InvocationCloseResult> | undefined;
  #sampling = false;
  #finished = false;
  #stopping = false;
  #terminationObserver: (() => void) | undefined;
  #notifying = false;
  #notifyingBudget = false;
  #budgetCallbackEntry: Entry | undefined;
  #reapingAtExit = false;

  constructor(clock: InvocationClock, observations = new ExitObservations()) {
    this.#clock = clock;
    this.observations = observations;
    this.#budget = Object.freeze({
      deadline: () => this.#deadline,
      remainingMs: () => this.#remainingMs(),
    });
  }

  get activeOwners(): number {
    return this.#entries.size;
  }
  /** Bounded by the fixed owner-kind × stage × code vocabulary, not completed attempt count. */
  get failureKinds(): number {
    return this.#failures.size;
  }

  /** The same live absolute budget used by owners; settling cleanup never renews it. */
  get budget(): RemainingBudget {
    return this.#budget;
  }

  /** Published before callbacks; a native coordinator can observe autonomous owner escalation. */
  get termination(): Promise<InvocationCloseResult> | undefined {
    return this.#termination;
  }

  /** One invocation-owned process adapter, not an unbounded history of subscribers. */
  observeTermination(listener: () => void): () => void {
    if (this.#terminationObserver !== undefined) throw new CliError('cli_internal', '');
    this.#terminationObserver = listener;
    if (this.#termination !== undefined) this.#notifyTermination();
    return () => {
      if (this.#terminationObserver === listener) this.#terminationObserver = undefined;
    };
  }

  assertAdmitting(): void {
    if (!this.#admitting) throw new CliError('cli_internal', '');
  }

  register(owner: InvocationOwner): OwnerLease {
    this.assertAdmitting();
    // Creation-specific capabilities cannot change after registration through the caller's object.
    owner = Object.freeze({ ...owner });
    let resolveRetirement = (): void => undefined;
    const retirement = new Promise<void>((resolve) => {
      resolveRetirement = resolve;
    });
    const entry: Entry = {
      owner,
      retirement,
      resolveRetirement,
      stages: new Map(),
      closing: false,
      retired: false,
      closeResult: undefined,
      sampling: false,
      budgetObserved: false,
      budgetDeadline: undefined,
      budgetExpired: false,
      budgetReentered: false,
    };
    this.#entries.add(entry);
    // Registration observes lifetime only: joining an idle session here would falsely retire future turns.
    if (
      !this.#observe(
        owner.retired,
        (result) => this.#retire(entry, result),
        (cause) => this.#failed(entry, 'retirement', cause),
      )
    ) {
      this.#record(entry, 'retirement', 'cli_internal');
    }
    // The native adapter sees current state before creation, without using the coordinator's observer.
    if (this.#notifyingBudget) this.#notifyBudget(entry);
    else this.#notifyBudgets();
    return Object.freeze({
      assertAdmitting: () => {
        this.assertAdmitting();
        if (entry.closing || entry.retired) throw new CliError('cli_internal', '');
      },
      close: () => this.#closeEntry(entry),
    });
  }

  /** Publish the shared promise BEFORE entering callbacks, including reentrant failures. */
  terminate(request: TerminationRequest): Promise<InvocationCloseResult> {
    if (request.kind === 'cooperative_cancel') {
      if ((request.outcome !== 1 && request.outcome !== 4) || !Number.isFinite(request.deadline))
        throw new CliError('cli_internal', '');
    }
    if (request.kind === 'signal') {
      // Pure validation precedes sealing; a malformed internal request must not leave a pending coordinator.
      assertTerminatingSignalNumber(request.signalNumber);
      if (request.deadline !== undefined && !Number.isFinite(request.deadline))
        throw new CliError('cli_internal', '');
    }
    if (this.#termination !== undefined) {
      this.#observeRequest(request);
      return this.#termination;
    }
    this.#admitting = false;
    let finish: (value: InvocationCloseResult) => void = () => undefined;
    this.#termination = new Promise<InvocationCloseResult>((resolve) => {
      finish = resolve;
    });
    const entries = [...this.#entries];
    this.#stopping = true;
    try {
      this.#observeRequest(request);
      this.#notifyTermination();
      for (const entry of entries) {
        entry.closing = true;
        this.#attempt(entry, 'stop', entry.owner.stop);
      }
    } finally {
      this.#stopping = false;
    }
    // Every stop has entered before any join/reap/restore; none is serially awaited.
    for (const entry of entries) this.#startTails(entry);
    const deferred = [...this.#deferredCloses];
    this.#deferredCloses.clear();
    for (const close of deferred) close();
    const joins = Promise.all(entries.map((entry) => this.#entryFinished(entry))).then(
      () => undefined,
    );
    void this.#wait(joins).then((settled) => {
      this.#sampleHealth();
      this.#finished = true;
      if (settled) this.#disarmTimer();
      finish(
        Object.freeze({
          kind: settled ? 'settled' : 'deadline',
          unacknowledgedOwners: this.#entries.size,
        }),
      );
      this.#notifyTermination();
    });
    return this.#termination;
  }

  /** Actual workflow facts may strengthen disposition while another owner remains pending. */
  sampleWorkflowHealth(): void {
    this.#sampleHealth();
  }

  /** Attempt only finite existing native capabilities; exit cannot await or certify any resource closed. */
  reapNativeAtExit(): void {
    if (this.#reapingAtExit) return;
    this.#reapingAtExit = true;
    try {
      // Snapshot creation owners: callback reentry cannot add another exit obligation to this pass.
      for (const entry of [...this.#entries]) {
        const owner = entry.owner;
        if (entry.retired || !isNativeOwner(owner) || owner.exitReap === undefined) continue;
        try {
          if (owner.mayReap() === true) owner.exitReap();
        } catch {
          // Exit has no async cleanup tail or diagnostic sink. Retain only the fixed observation.
          this.#failures.add(`${owner.kind}:exit:cli_internal`);
          this.observations.observeFailure('cli_internal');
        }
      }
    } finally {
      this.#reapingAtExit = false;
    }
  }

  #closeEntry(entry: Entry): Promise<OwnerCloseResult> {
    if (entry.closeResult !== undefined) return entry.closeResult;
    let finish: (value: OwnerCloseResult) => void = () => undefined;
    entry.closeResult = new Promise<OwnerCloseResult>((resolve) => {
      finish = resolve;
    });
    entry.closing = true;
    this.#attempt(entry, 'stop', entry.owner.stop);
    const join = (): void => {
      this.#startTails(entry);
      void this.#wait(this.#entryFinished(entry)).then((settled) => {
        finish(Object.freeze({ kind: settled ? 'retired' : 'unacknowledged' }));
      });
    };
    if (this.#stopping) this.#deferredCloses.add(join);
    else join();
    return entry.closeResult;
  }

  #startTails(entry: Entry): void {
    this.#attempt(entry, 'join', entry.owner.join);
    const owner = entry.owner;
    if (owner.kind === 'terminal') this.#attempt(entry, 'restore', owner.restore);
    else if (isNativeOwner(owner)) {
      if (!this.#canStart() || entry.retired) return;
      try {
        if (owner.mayReap()) this.#attempt(entry, 'reap', owner.reap);
      } catch (cause) {
        this.#failed(entry, 'reap', cause);
      }
    }
  }

  #entryFinished(entry: Entry): Promise<void> {
    return Promise.all([entry.retirement, ...entry.stages.values()]).then(() => undefined);
  }

  #attempt(
    entry: Entry,
    stage: OwnerStage,
    operation: (budget: RemainingBudget) => void | Promise<void>,
  ): void {
    if (entry.stages.has(stage) || entry.retired) return;
    // Expiry cannot excuse another owner's finite cancellation request. Runtime stop adapters
    // must respect the zero-budget contract; joins/restore/reap helpers remain deadline-gated.
    if (stage !== 'stop' && !this.#canStart()) return;
    let finish = (): void => undefined;
    const observed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    entry.stages.set(stage, observed);
    try {
      const raw = operation(this.#budget);
      if (raw === undefined) finish();
      else if (
        !this.#observe(raw, finish, (cause) => {
          this.#failed(entry, stage, cause);
          finish();
        })
      ) {
        this.#record(entry, stage, 'cli_internal');
        // Observation setup failure is not raw settlement. Keep the attempt and lifetime unacknowledged.
      }
    } catch (cause) {
      this.#failed(entry, stage, cause);
      finish();
    }
  }

  #observe<T>(
    raw: Promise<T>,
    resolved: (value: T) => void,
    rejected: (cause: unknown) => void,
  ): boolean {
    try {
      if (typeof nativeThen !== 'function') return false;
      Reflect.apply(nativeThen, raw, [resolved, rejected]);
      return true;
    } catch {
      return false;
    }
  }

  #retire(entry: Entry, result: OwnerRetirement): void {
    try {
      // A hostile getter or malformed adapter payload is not a lifetime witness.
      const kind: unknown = Object.getOwnPropertyDescriptor(result, 'kind')?.value;
      const descriptor = Object.getOwnPropertyDescriptor(result, 'failure');
      const failure: unknown = descriptor?.value;
      if (
        kind !== 'settled' ||
        (descriptor !== undefined && (!('value' in descriptor) || !isOwnerFailureCode(failure)))
      ) {
        this.#record(entry, 'retirement', 'cli_internal');
        return;
      }
      entry.retired = true;
      this.#health(entry);
      if (isOwnerFailureCode(failure)) this.#record(entry, 'retirement', failure);
      this.#entries.delete(entry);
      entry.resolveRetirement();
    } catch (cause) {
      this.#failed(entry, 'retirement', cause);
    }
  }

  #health(entry: Entry): void {
    if (entry.owner.kind !== 'workflow' || entry.sampling) return;
    entry.sampling = true;
    try {
      this.observations.observeWorkflowSafety(entry.owner.readSafetyExit());
    } catch (cause) {
      this.#failed(entry, 'health', cause);
    } finally {
      entry.sampling = false;
    }
  }

  #sampleHealth(): void {
    if (this.#sampling) return;
    this.#sampling = true;
    try {
      for (const entry of this.#entries) this.#health(entry);
    } finally {
      this.#sampling = false;
    }
  }

  #failed(entry: Entry, stage: OwnerStage, cause: unknown): void {
    let observedAt: number;
    try {
      observedAt = this.#now();
    } catch {
      this.#record(entry, stage, 'cli_internal');
      return;
    }
    try {
      this.#record(entry, stage, entry.owner.classifyFailure(stage, cause), observedAt);
    } catch {
      this.#record(entry, stage, 'cli_internal', observedAt);
    }
  }

  #record(entry: Entry, stage: OwnerStage, code: OwnerFailureCode, observedAt?: number): void {
    if (!isOwnerFailureCode(code)) code = 'cli_internal';
    this.#failures.add(`${entry.owner.kind}:${stage}:${code}`);
    this.observations.observeFailure(code);
    if (code === 'cli_internal' || code === 'output_unavailable') {
      // A callback's first infrastructure failure has the same absolute budget as an external fatal request.
      // Recoverable background rejection is deliberately a separate observation API.
      try {
        if (observedAt !== undefined) this.#tighten(observedAt + FATAL_TERMINATION_MS);
        void this.terminate({ kind: 'infrastructure', code });
      } catch {
        this.observations.observeFailure('cli_internal');
        this.#expire();
      }
    }
  }

  #observeRequest(request: TerminationRequest): void {
    if (request.kind === 'infrastructure') {
      this.observations.observeFailure(request.code);
      try {
        this.#tighten(this.#now() + FATAL_TERMINATION_MS);
      } catch {
        this.observations.observeFailure('cli_internal');
        this.#expire();
      }
    } else if (request.kind === 'cooperative_cancel') {
      this.observations.observeCooperativeCancel(request.outcome);
      try {
        this.#tighten(request.deadline);
      } catch {
        this.observations.observeFailure('cli_internal');
        this.#expire();
      }
    } else if (request.kind === 'signal') {
      this.observations.observeTerminatingSignal(request.signalNumber);
      if (request.deadline !== undefined) {
        try {
          this.#tighten(request.deadline);
        } catch {
          this.observations.observeFailure('cli_internal');
          this.#expire();
        }
      }
    }
    this.#sampleHealth();
    this.#notifyTermination();
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value)) throw new CliError('cli_internal', '');
    return value;
  }

  #remainingMs(): number | undefined {
    if (this.#expired) return 0;
    if (this.#deadline === undefined) return undefined;
    try {
      const remaining = Math.max(0, this.#deadline - this.#now());
      if (remaining === 0) this.#expire();
      return this.#expired ? 0 : remaining;
    } catch {
      this.observations.observeFailure('cli_internal');
      this.#expire();
      return 0;
    }
  }

  #tighten(deadline: number): void {
    if (!Number.isFinite(deadline)) throw new CliError('cli_internal', '');
    if (this.#expired) return;
    if (this.#deadline !== undefined && this.#deadline <= deadline) return;
    this.#deadline = deadline;
    const callbackEntry = this.#budgetCallbackEntry;
    if (callbackEntry !== undefined) {
      if (callbackEntry.budgetReentered) {
        // A callback that keeps producing tighter deadlines cannot monopolize a notification drain.
        // Expiry is stronger than the accepted deadline; other owners still receive the final zero budget.
        this.#expire();
        this.#record(callbackEntry, 'budget', 'cli_internal');
        return;
      }
      callbackEntry.budgetReentered = true;
    }
    this.#disarmTimer();
    if (this.#expired) return;
    const remaining = deadline - this.#now();
    if (remaining <= 0) this.#expire();
    else if (!this.#finished) this.#disarm = this.#clock.schedule(remaining, () => this.#expire());
    this.#notifyBudgets();
    this.#notifyTermination();
  }

  #notifyBudgets(): void {
    if (this.#notifyingBudget) return;
    this.#notifyingBudget = true;
    for (const entry of this.#entries) entry.budgetReentered = false;
    try {
      // Each native entry may tighten once in this drain; repeated self-tightening expires it above.
      // Rescan current entries so a sibling already notified before a tighter reentrant request sees it.
      let notified: boolean;
      do {
        notified = false;
        for (const entry of this.#entries) if (this.#notifyBudget(entry)) notified = true;
      } while (notified);
    } finally {
      this.#notifyingBudget = false;
    }
  }

  #notifyBudget(entry: Entry): boolean {
    const owner = entry.owner;
    if (
      entry.retired ||
      !isNativeOwner(owner) ||
      owner.budgetChanged === undefined ||
      (entry.budgetObserved &&
        entry.budgetDeadline === this.#deadline &&
        entry.budgetExpired === this.#expired)
    )
      return false;
    entry.budgetObserved = true;
    entry.budgetDeadline = this.#deadline;
    entry.budgetExpired = this.#expired;
    const previous = this.#budgetCallbackEntry;
    let failed = false;
    this.#budgetCallbackEntry = entry;
    try {
      owner.budgetChanged(this.#budget);
    } catch {
      // This fixed native protocol never passes raw callback faults to a plugin/owner classifier.
      failed = true;
    } finally {
      this.#budgetCallbackEntry = previous;
    }
    if (failed) this.#record(entry, 'budget', 'cli_internal');
    return true;
  }

  #notifyTermination(): void {
    const listener = this.#terminationObserver;
    if (listener === undefined || this.#termination === undefined || this.#notifying) return;
    this.#notifying = true;
    try {
      // Native adapters schedule their finalization; synchronous notification cannot acknowledge an owner.
      listener();
    } catch {
      this.observations.observeFailure('cli_internal');
      try {
        void this.terminate({ kind: 'infrastructure', code: 'cli_internal' });
      } catch {
        this.#expire();
      }
    } finally {
      this.#notifying = false;
    }
  }

  #disarmTimer(): void {
    const disarm = this.#disarm;
    this.#disarm = undefined;
    try {
      disarm?.();
    } catch {
      this.observations.observeFailure('cli_internal');
      this.#expire();
    }
  }

  #expire(): void {
    if (this.#expired) return;
    this.#expired = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
    this.#notifyBudgets();
  }

  #canStart(): boolean {
    try {
      if (!this.#expired && this.#deadline !== undefined && this.#now() >= this.#deadline)
        this.#expire();
    } catch {
      this.observations.observeFailure('cli_internal');
      this.#expire();
    }
    return !this.#expired;
  }

  #wait(work: Promise<void>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const expired = (): void => resolve(false);
      if (this.#expired) {
        resolve(false);
        return;
      }
      this.#waiters.add(expired);
      // Retire each waiter on actual completion; an immortal expiry Promise would retain one per closed owner.
      void work.then(() => {
        this.#waiters.delete(expired);
        resolve(true);
      });
    });
  }
}

function isNativeOwner(owner: InvocationOwner): owner is NativeOwner {
  return (
    owner.kind === 'native-group' ||
    owner.kind === 'native-pid' ||
    owner.kind === 'windows-live-root'
  );
}

function isOwnerFailureCode(value: unknown): value is OwnerFailureCode {
  return (
    value === 'internal' ||
    value === 'storage_unavailable' ||
    value === 'cli_internal' ||
    value === 'output_unavailable'
  );
}
