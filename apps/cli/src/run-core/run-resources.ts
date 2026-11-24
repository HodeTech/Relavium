import { EgressWorkScope } from '../engine/egress-work.js';
import { closePreparedMcp, type WorkflowMcpRuntime } from '../engine/mcp-servers.js';
import { warnTeardown } from '../process/close-quietly.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import type { RunLifetime } from './run-lifetime.js';

/** The one-use operations of a {@link RunResources}; the closed set keeps every misuse message fixed text. */
type SingleUseSlot =
  | 'MCP connection'
  | 'history close capture'
  | 'MCP release'
  | 'history database close';

/**
 * A reuse is a host bug, never a user fault: the owner holds one run's MCP runtime and database handle, so a
 * second run on it would inherit the first run's clients and close its connection. The message names the
 * misuse and the operation only; it never carries a stored value.
 */
function reused(slot: SingleUseSlot): CliError {
  return new CliError(
    'internal',
    `a RunResources was reused: its ${slot} ran twice; create one RunResources for each run`,
  );
}

/**
 * What a run's preparation acquires and its host must release afterwards: the MCP clients and their egress
 * work, and the history database's close.
 *
 * **One run, one owner.** The caller creates it before it calls `prepareRun` or `resumeRun`, which register
 * what they acquire through {@link connectMcp} and {@link captureHistoryClose}; the caller releases it in its
 * own `finally`, in this order: {@link releaseMcp}, then {@link closeHistoryDb}. Each of the four runs at
 * most once and a second call throws, so a host that reuses one object for two runs fails loudly instead of
 * inheriting the first run's MCP runtime and closing its database handle.
 *
 * The split exists because the shell must not close the database while an MCP close is unacknowledged (its
 * process then stays alive for its exit authority); a host that cannot hang on that decides it between
 * the two calls.
 */
export class RunResources {
  readonly mcpWork = new EgressWorkScope();
  readonly #lifetime: RunLifetime;
  readonly #io: CliIo;
  #mcpRuntime: WorkflowMcpRuntime | undefined;
  #closeHistory: (() => void) | undefined;
  #mcpConnectClaimed = false;
  #historyCaptured = false;
  #mcpReleased = false;
  #historyClosed = false;
  #mcpAcknowledged = true;

  constructor(lifetime: RunLifetime, io: CliIo) {
    this.#lifetime = lifetime;
    this.#io = io;
  }

  /**
   * Connect the run's MCP servers and register the runtime for {@link releaseMcp}.
   *
   * The single-use guard is checked **before** `connect` runs, so a misused owner never spawns a child that
   * nothing is going to close. The runtime is registered only once `connect` resolves; a rejection leaves
   * nothing to release, because the connector closes what it started on its own failure.
   */
  async connectMcp(
    connect: () => Promise<WorkflowMcpRuntime | undefined>,
  ): Promise<WorkflowMcpRuntime | undefined> {
    if (this.#mcpConnectClaimed || this.#mcpReleased) throw reused('MCP connection');
    this.#mcpConnectClaimed = true;
    this.#mcpRuntime = await connect();
    return this.#mcpRuntime;
  }

  /** Register the history database's close, as `acquireNativeResource` hands it over. */
  captureHistoryClose(close: () => void): void {
    if (this.#historyCaptured || this.#historyClosed) throw reused('history close capture');
    this.#historyCaptured = true;
    this.#closeHistory = close;
  }

  /** Passed to the MCP connector: a manager close failure is cleanup the host must not call acknowledged. */
  readonly reportMcpCloseFailure = (_serverId: string, cause: unknown): void => {
    this.#mcpAcknowledged = false;
    this.#lifetime.cleanupFailed(cause);
    warnTeardown(this.#io, 'MCP');
  };

  /** Close the MCP clients and join their work. Resolves `false` when any of it was not acknowledged. */
  async releaseMcp(): Promise<boolean> {
    if (this.#mcpReleased) throw reused('MCP release');
    this.#mcpReleased = true;
    // Cleanup is joined directly, never via a registry promise that depends on the host's own finally.
    // Neither cancellation nor a deadline certifies the engine/MCP/DB or terminal released.
    try {
      if (this.#mcpRuntime !== undefined) {
        await closePreparedMcp(
          this.#mcpRuntime.client,
          this.reportMcpCloseFailure,
          this.#lifetime.invocation.registry.budget,
        );
      }
    } catch (cause) {
      this.#mcpAcknowledged = false;
      this.#lifetime.cleanupFailed(cause);
      warnTeardown(this.#io, 'MCP');
    }
    this.mcpWork.seal();
    try {
      await this.mcpWork.done;
    } catch (cause) {
      this.#mcpAcknowledged = false;
      this.#lifetime.cleanupFailed(cause);
    }
    return this.#mcpAcknowledged;
  }

  closeHistoryDb(): void {
    if (this.#historyClosed) throw reused('history database close');
    this.#historyClosed = true;
    try {
      this.#closeHistory?.();
    } catch (cause) {
      this.#lifetime.cleanupFailed(storageBoundaryError(cause));
      warnTeardown(this.#io, 'history database');
    }
  }
}
