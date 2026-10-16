import type { ChildProcess } from 'node:child_process';

import type { StdioNativeLifetime, StdioNativeObserver } from '@relavium/mcp';

import { CliError } from './cli-error.js';
import type { CliInvocation } from './invocation.js';
import {
  FATAL_TERMINATION_MS,
  type InvocationRegistry,
  type OwnerLease,
  type OwnerRetirement,
  type RemainingBudget,
} from './invocation-registry.js';
import {
  verifyWindowsTaskkillFacility,
  WindowsTeardownUnavailableError,
  type WindowsTaskkillFacility,
} from './windows-teardown.js';

/** The actual native surface; command result/error and native close are separate observations. */
export interface NativeChildHandle {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signalCode?: string | null | undefined;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal: 'SIGKILL'): unknown;
}

export interface NativeProcessReservation {
  /** Recheck after every preparation await, immediately before the actual spawn. */
  readonly assertAdmitting: () => void;
  /** Transfer a child that this creation actually entered, even if stop won during entry. */
  readonly bindChild: (child: NativeChildHandle) => void;
  /** Only the creation owner can prove that construction refused without creating a child. */
  readonly abandon: () => void;
  /** One cancellation operation; settlement waits actual target and already-created helper close. */
  readonly stop: () => Promise<void>;
  readonly whenClosed: Promise<void>;
}

export interface NativeProcessController {
  readonly reserve: (kind: 'group' | 'pid') => Promise<NativeProcessReservation>;
  readonly observeMcp: () => Promise<McpNativeReservation>;
}

export interface McpNativeReservation extends StdioNativeObserver {
  /** The bridge calls this if startup refuses before the SDK ownership attachment. */
  readonly abandonIfUnattached: () => void;
}

export interface NativeProcessPorts {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly schedule: (milliseconds: number, fire: () => void) => () => void;
  /** Positive PID only for liveness; a negative target is allowed solely for a created detached group. */
  readonly signal: (target: number, signal: 0 | 'SIGKILL') => void;
  readonly verifyWindows: () => Promise<WindowsTaskkillFacility>;
  readonly subscribeExit: (listener: () => void) => () => void;
}

const unboundedBudget: RemainingBudget = Object.freeze({
  deadline: () => undefined,
  remainingMs: () => undefined,
});
const controllers = new WeakMap<InvocationRegistry, NativeProcessController>();

/** Explicit invocation identity, never an ambient current invocation or completed PID history. */
export function nativeProcessesForInvocation(
  invocation: CliInvocation | undefined,
): NativeProcessController | undefined {
  if (invocation === undefined) return undefined;
  let controller = controllers.get(invocation.registry);
  if (controller === undefined) {
    controller = createNativeProcessController(invocation.registry);
    controllers.set(invocation.registry, controller);
  }
  return controller;
}

/**
 * Inert construction. Each actual creation reserves before facility verification/native entry.
 * Without an invocation this supplies local tool cleanup only, never process-wide fatal ownership.
 */
export function createNativeProcessController(
  registry?: InvocationRegistry,
  ports: NativeProcessPorts = nativePorts(),
): NativeProcessController {
  let facility: Promise<WindowsTaskkillFacility> | undefined;
  let active = 0;
  let removeExit: (() => void) | undefined;
  const acquire = (): (() => void) => {
    if (registry !== undefined && active === 0)
      removeExit = ports.subscribeExit(() => registry.reapNativeAtExit());
    active++;
    return () => {
      active--;
      if (active !== 0) return;
      const remove = removeExit;
      removeExit = undefined;
      remove?.();
    };
  };
  const prepare = async (kind: 'group' | 'pid'): Promise<NativeCreation> => {
    registry?.assertAdmitting();
    const release = acquire();
    let creation: NativeCreation;
    try {
      creation = new NativeCreation(kind, registry, ports, release);
    } catch (cause) {
      release();
      throw cause;
    }
    try {
      if (ports.platform === 'win32') {
        facility ??= ports.verifyWindows();
        creation.setFacility(await facility);
      }
      creation.assertAdmitting();
      return creation;
    } catch (cause) {
      creation.abandon();
      throw cause;
    }
  };
  return Object.freeze({
    reserve: async (kind: 'group' | 'pid') => (await prepare(kind)).reservation(),
    observeMcp: async () => {
      const creation = await prepare('pid');
      return Object.freeze({
        attach: (lifetime: StdioNativeLifetime) => creation.bindMcp(lifetime),
        beforeStart: () => creation.assertAdmitting(),
        abandonIfUnattached: () => creation.abandonIfUnattached(),
      });
    },
  });
}

interface Target {
  readonly readPid: () => number | undefined;
  readonly isClosed: () => boolean;
  readonly isExited: () => boolean;
  readonly cancel?: (() => void) | undefined;
  readonly cooperativeClose?: (() => Promise<void>) | undefined;
}

class NativeCreation {
  readonly #kind: 'group' | 'pid';
  readonly #registry: InvocationRegistry | undefined;
  readonly #ports: NativeProcessPorts;
  readonly #budget: RemainingBudget;
  readonly #released: () => void;
  readonly #lease: OwnerLease | undefined;
  readonly #closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #resolveRetired: (retirement: OwnerRetirement) => void;
  #target: Target | undefined;
  #facility: WindowsTaskkillFacility | undefined;
  #sealed = false;
  #retired = false;
  #targetClosed = false;
  #groupPid: number | undefined;
  #cancelEntered = false;
  #cooperativeEntered = false;
  #helper: ChildProcess | undefined;
  #helperEntered = false;
  #helperClosed = true;
  #helperFailed = false;
  #helperCancelling = false;
  #helperDeadline: number | undefined;
  #timerDeadline: number | undefined;
  #removeHelperTimer: (() => void) | undefined;
  #failure = false;
  #exitReaping = false;

  constructor(
    kind: 'group' | 'pid',
    registry: InvocationRegistry | undefined,
    ports: NativeProcessPorts,
    released: () => void,
  ) {
    this.#kind = kind;
    this.#registry = registry;
    this.#ports = ports;
    this.#released = released;
    this.#budget = registry?.budget ?? unboundedBudget;
    let resolveClosed = (): void => undefined;
    this.#closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    let resolveRetired: (retirement: OwnerRetirement) => void = () => undefined;
    const retired = new Promise<OwnerRetirement>((resolve) => {
      resolveRetired = resolve;
    });
    this.#resolveRetired = resolveRetired;
    this.#lease = registry?.register({
      kind:
        ports.platform === 'win32'
          ? 'windows-live-root'
          : kind === 'group'
            ? 'native-group'
            : 'native-pid',
      retired,
      stop: () => this.#requestStop(),
      join: () => this.#closed,
      mayReap: () => this.#eligible() || (this.#helper !== undefined && !this.#helperClosed),
      reap: () => this.#requestStop(),
      budgetChanged: () => this.#updateHelperBudget(),
      exitReap: () => this.#finiteExitReap(),
      classifyFailure: () => 'cli_internal',
    });
  }

  setFacility(facility: WindowsTaskkillFacility): void {
    this.#facility = facility;
  }

  assertAdmitting(): void {
    this.#lease?.assertAdmitting();
    if (this.#sealed || this.#retired) throw new CliError('cli_internal', '');
  }

  reservation(): NativeProcessReservation {
    return Object.freeze({
      assertAdmitting: () => this.assertAdmitting(),
      bindChild: (child: NativeChildHandle) => this.bindChild(child),
      abandon: () => this.abandon(),
      stop: () => {
        try {
          this.#requestStop();
        } catch {
          this.#failed();
        }
        return this.#closed;
      },
      whenClosed: this.#closed,
    });
  }

  abandon(): void {
    if (this.#target !== undefined) throw new CliError('cli_internal', '');
    this.#sealed = true;
    this.#targetClosed = true;
    this.#finish();
  }

  abandonIfUnattached(): void {
    if (this.#target === undefined) this.abandon();
  }

  bindChild(child: NativeChildHandle): void {
    let closed = false;
    let exited = false;
    const pid = positivePid(child.pid);
    this.#bind({
      readPid: () => pid,
      isClosed: () => closed,
      isExited: () => exited || child.exitCode != null || child.signalCode != null,
      cancel: () => {
        child.kill('SIGKILL');
      },
    });
    // An error diagnoses the command, not native closure. Callers retain their public error contract.
    child.on('error', () => undefined);
    child.on('exit', () => {
      exited = true;
      if (this.#kind === 'group' && this.#ports.platform !== 'win32') this.#signalGroup();
    });
    child.on('close', () => {
      closed = true;
      if (this.#kind === 'group' && this.#ports.platform !== 'win32') this.#signalGroup();
      this.#targetClosed = true;
      this.#finish();
    });
    if (this.#sealed) this.#requestStop();
  }

  bindMcp(lifetime: StdioNativeLifetime): void {
    this.#bind({
      readPid: lifetime.readPid,
      isClosed: lifetime.isClosed,
      // The public SDK has no exit event. Immediate liveness below supplies the explicit best-effort limit.
      isExited: lifetime.isClosed,
      cooperativeClose: lifetime.close,
    });
    void lifetime.whenClosed.then(
      () => {
        this.#targetClosed = true;
        this.#finish();
      },
      () => this.#failed(),
    );
    if (this.#sealed) this.#requestStop();
  }

  #bind(target: Target): void {
    if (this.#target !== undefined || this.#retired) throw new CliError('cli_internal', '');
    this.#target = target;
    if (this.#kind === 'group' && this.#ports.platform !== 'win32')
      this.#groupPid = positivePid(target.readPid());
  }

  #eligible(): boolean {
    if (this.#retired || this.#target === undefined) return false;
    if (this.#kind === 'group' && this.#ports.platform !== 'win32')
      return this.#groupPid !== undefined;
    return !this.#targetClosed && !this.#target.isClosed() && !this.#target.isExited();
  }

  #requestStop(): void {
    this.#sealed = true;
    if (this.#target === undefined || this.#retired) return;
    if (!this.#cancelEntered) {
      this.#cancelEntered = true;
      if (this.#ports.platform === 'win32') this.#startWindowsHelper();
      else if (this.#kind === 'group') this.#signalGroup();
      else this.#signalPid();
    }
    if (!this.#cooperativeEntered && this.#target.cooperativeClose !== undefined) {
      this.#cooperativeEntered = true;
      try {
        void this.#target.cooperativeClose().catch(() => this.#failed());
      } catch {
        this.#failed();
      }
    }
  }

  #signalGroup(): void {
    const pid = this.#groupPid;
    if (pid === undefined || this.#retired) return;
    try {
      this.#ports.signal(-pid, 'SIGKILL');
    } catch (cause) {
      if (!absentTarget(cause)) this.#failed();
    }
  }

  #livePid(): number | undefined {
    if (!this.#eligible()) return undefined;
    const pid = positivePid(this.#target?.readPid());
    if (pid === undefined) return undefined;
    try {
      this.#ports.signal(pid, 0);
      return pid;
    } catch (cause) {
      if (!absentTarget(cause)) this.#failed();
      return undefined;
    }
  }

  #signalPid(): void {
    const pid = this.#livePid();
    if (pid === undefined) {
      // A synchronously returned child can have no PID when native spawn later emits error/close.
      // Its own handle remains creation-owned; never substitute a guessed or historical PID.
      if (this.#eligible() && positivePid(this.#target?.readPid()) === undefined) {
        try {
          this.#target?.cancel?.();
        } catch {
          this.#failed();
        }
      }
      return;
    }
    try {
      this.#ports.signal(pid, 'SIGKILL');
    } catch (cause) {
      if (!absentTarget(cause)) this.#failed();
    }
  }

  #finiteExitReap(): void {
    // No helper/async close/retirement/DB ACK can be started in a process exit callback.
    this.#exitReaping = true;
    try {
      if (this.#kind === 'group' && this.#ports.platform !== 'win32') this.#signalGroup();
      else this.#signalPid();
      if (this.#helper !== undefined && !this.#helperClosed) this.#cancelHelper();
    } finally {
      this.#exitReaping = false;
    }
  }

  #startWindowsHelper(): void {
    const remaining = this.#remaining();
    if (remaining === 0) {
      this.#signalPid();
      return;
    }
    const pid = this.#livePid();
    if (pid === undefined) return;
    // Reserve helper lifetime before entering the facility: registry admission may already be sealed.
    if (this.#helperEntered) return;
    this.#helperEntered = true;
    this.#helperClosed = false;
    try {
      if (this.#facility === undefined) throw new WindowsTeardownUnavailableError();
      this.#helperDeadline = this.#ports.now() + FATAL_TERMINATION_MS;
      if (!Number.isFinite(this.#helperDeadline)) throw new CliError('cli_internal', '');
      // Liveness/clock ports can synchronously tighten or expire admission. The initial sample
      // cannot authorize a new helper after that reentry; the final check uses the same live budget.
      if (this.#remaining() === 0 || !this.#eligible()) {
        this.#helperClosed = true;
        this.#signalPid();
        this.#finish();
        return;
      }
      const helper = this.#facility.spawn(pid);
      this.#helper = helper;
      helper.on('error', () => {
        this.#helperFailed = true;
        this.#failed();
        this.#cancelHelper();
        this.#signalPid();
      });
      helper.on('close', (code) => {
        this.#helperClosed = true;
        this.#clearHelperTimer();
        // The root may finish cooperatively between the live check and taskkill's request.
        // A nonzero result with a proved-closed/now-absent root is not a new infrastructure fault.
        if (code !== 0 && !this.#helperFailed && this.#livePid() !== undefined) {
          this.#failed();
          this.#signalPid();
        }
        this.#finish();
      });
      this.#updateHelperBudget();
    } catch {
      // A synchronous native factory refusal created no helper. If binding failed after spawn,
      // retain uncertainty and cancellation authority instead of fabricating its native close.
      if (this.#helper === undefined) this.#helperClosed = true;
      else this.#cancelHelper();
      this.#failed();
      this.#signalPid();
      this.#finish();
    }
  }

  #remaining(): number | undefined {
    try {
      const remaining = this.#budget.remainingMs();
      if (remaining === undefined || (Number.isFinite(remaining) && remaining >= 0))
        return remaining;
    } catch {
      // A failed live budget never authorizes a fresh helper.
    }
    this.#failed();
    return 0;
  }

  #updateHelperBudget(): void {
    if (this.#helper === undefined || this.#helperClosed) return;
    try {
      const now = this.#ports.now();
      const remaining = this.#remaining();
      const deadline = Math.min(
        this.#helperDeadline ?? now,
        remaining === undefined ? Infinity : now + remaining,
      );
      if (!Number.isFinite(now) || !Number.isFinite(deadline))
        throw new CliError('cli_internal', '');
      if (deadline <= now) {
        this.#clearHelperTimer();
        this.#cancelHelper();
        // Cancelling the helper is not target close. Make only the already-owned finite root request.
        this.#signalPid();
        return;
      }
      if (this.#timerDeadline !== undefined && this.#timerDeadline <= deadline) return;
      this.#clearHelperTimer();
      this.#timerDeadline = deadline;
      this.#removeHelperTimer = this.#ports.schedule(deadline - now, () => {
        this.#clearHelperTimer();
        this.#cancelHelper();
        this.#signalPid();
        this.#failed();
      });
    } catch {
      this.#cancelHelper();
      this.#failed();
    }
  }

  #cancelHelper(): void {
    if (this.#helper === undefined || this.#helperClosed || this.#helperCancelling) return;
    // ChildProcess.kill can emit error synchronously. Its listener may request cancellation
    // again; suppress that reentry while allowing a later independent finite request.
    this.#helperCancelling = true;
    try {
      this.#helper.kill('SIGKILL');
    } catch {
      this.#failed();
    } finally {
      this.#helperCancelling = false;
    }
  }

  #clearHelperTimer(): void {
    const remove = this.#removeHelperTimer;
    this.#removeHelperTimer = undefined;
    this.#timerDeadline = undefined;
    try {
      remove?.();
    } catch {
      this.#failed();
    }
  }

  #failed(): void {
    if (this.#failure) return;
    this.#failure = true;
    if (this.#exitReaping) this.#registry?.observations.observeFailure('cli_internal');
    else if (this.#registry !== undefined)
      void this.#registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
  }

  #finish(): void {
    if (this.#retired || !this.#targetClosed || !this.#helperClosed) return;
    this.#retired = true;
    this.#clearHelperTimer();
    this.#groupPid = undefined;
    try {
      this.#released();
    } catch {
      this.#failed();
    }
    this.#resolveRetired(
      Object.freeze(
        this.#failure ? { kind: 'settled', failure: 'cli_internal' } : { kind: 'settled' },
      ),
    );
    this.#resolveClosed();
  }
}

function positivePid(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Owned native signal errors only; never consult an arbitrary nested cause or interpolate errno. */
function absentTarget(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return Object.getOwnPropertyDescriptor(cause, 'code')?.value === 'ESRCH';
}

function nativePorts(): NativeProcessPorts {
  return {
    platform: process.platform,
    now: () => performance.now(),
    schedule: (milliseconds, fire) => {
      const timer = setTimeout(fire, milliseconds);
      return () => clearTimeout(timer);
    },
    signal: (target, signal) => {
      process.kill(target, signal);
    },
    verifyWindows: verifyWindowsTaskkillFacility,
    subscribeExit: (listener) => {
      process.on('exit', listener);
      return () => process.off('exit', listener);
    },
  };
}
