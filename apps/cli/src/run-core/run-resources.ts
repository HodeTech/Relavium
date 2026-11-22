import { EgressWorkScope } from '../engine/egress-work.js';
import { closePreparedMcp, type WorkflowMcpRuntime } from '../engine/mcp-servers.js';
import { warnTeardown } from '../process/close-quietly.js';
import type { CliIo } from '../process/io.js';
import { storageBoundaryError } from '../process/owned-storage.js';
import type { RunLifetime } from './run-lifetime.js';

/**
 * What a run's preparation acquires and its host must release afterwards: the MCP clients and their egress
 * work, and the history database's close.
 *
 * The caller creates it before it calls `prepareRun` or `resumeRun`, which register what they acquire; the
 * caller releases it in its own `finally`, in this order: {@link releaseMcp}, then {@link closeHistoryDb}.
 * The split exists because the shell must not close the database while an MCP close is unacknowledged (its
 * process then stays alive for its exit authority); a host that cannot hang on that decides it between
 * the two calls.
 */
export class RunResources {
  mcpRuntime: WorkflowMcpRuntime | undefined;
  closeHistory: (() => void) | undefined;
  readonly mcpWork = new EgressWorkScope();
  readonly #lifetime: RunLifetime;
  readonly #io: CliIo;
  #mcpAcknowledged = true;

  constructor(lifetime: RunLifetime, io: CliIo) {
    this.#lifetime = lifetime;
    this.#io = io;
  }

  /** Passed to the MCP connector: a manager close failure is cleanup the host must not call acknowledged. */
  readonly reportMcpCloseFailure = (_serverId: string, cause: unknown): void => {
    this.#mcpAcknowledged = false;
    this.#lifetime.cleanupFailed(cause);
    warnTeardown(this.#io, 'MCP');
  };

  /** Close the MCP clients and join their work. Resolves `false` when any of it was not acknowledged. */
  async releaseMcp(): Promise<boolean> {
    // Cleanup is joined directly, never via a registry promise that depends on the host's own finally.
    // Neither cancellation nor a deadline certifies the engine/MCP/DB or terminal released.
    try {
      if (this.mcpRuntime !== undefined) {
        await closePreparedMcp(
          this.mcpRuntime.client,
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
    try {
      this.closeHistory?.();
    } catch (cause) {
      this.#lifetime.cleanupFailed(storageBoundaryError(cause));
      warnTeardown(this.#io, 'history database');
    }
  }
}
