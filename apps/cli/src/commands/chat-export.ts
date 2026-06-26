import { SessionExportedEventSchema } from '@relavium/shared';

import { exportSession } from '../chat/export.js';
import { loadResolvedConfig } from '../config/load.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';

/**
 * `relavium chat-export <sessionId>` (2.P) — export a persisted session to a `.relavium.yaml` **scaffold** for
 * review before commit ([ADR-0026](../../../docs/decisions/0026-session-export-to-workflow.md)). It writes the
 * file (cwd `<id>.relavium.yaml` by default, `--out <path>` to override, never overwriting without `--force`),
 * marks the session row `exported` with the written path (provenance), and prints the path — or, under
 * `--json`, emits a single `session:exported` event. Framework-free (no commander/ink). An unknown sessionId or
 * an existing target file (without `--force`) is a clean exit-2 invocation fault; success is exit 0.
 */

export interface ChatExportCommandArgs {
  readonly sessionId: string;
  /** `--out <path>`: write the scaffold here (absolute, or relative to cwd) instead of `<id>.relavium.yaml`. */
  readonly out?: string;
  /** `--force`: overwrite an existing file at the target path. */
  readonly force: boolean;
}

export interface ChatExportCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable session-store opener — tests pass an in-memory store; production opens `~/.relavium/history.db`. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
  /** Wall-clock (ms) for the `exported` row timestamp + the event timestamp (injectable for tests). */
  readonly now?: () => number;
}

export function chatExportCommand(
  args: ChatExportCommandArgs,
  deps: ChatExportCommandDeps,
): ExitCode {
  const now = deps.now ?? Date.now;
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  try {
    const result = exportSession({
      store: opened.store,
      sessionId: args.sessionId,
      cwd: deps.global.cwd,
      ...(args.out === undefined ? {} : { outPath: args.out }),
      force: args.force,
    });

    // Mark the session `exported` + record the path (provenance, ADR-0026). Safe here — this is a NON-live
    // session (no concurrent persister), unlike the in-REPL `/export` which deliberately does not mark the row.
    // The file write is the durable contract, so a provenance-mark fault degrades to a warning (stderr, so
    // stdout stays pure under --json) rather than failing an export whose scaffold already landed on disk.
    try {
      opened.store.updateSession({
        ...result.record,
        status: 'exported',
        exportedWorkflowPath: result.path,
        updatedAt: new Date(now()).toISOString(),
      });
    } catch (err) {
      deps.io.writeErr(
        `note: scaffold written but could not mark the session exported: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    if (deps.global.json) {
      // The machine output is the one documented `session:exported` event (validated at the boundary).
      const event = SessionExportedEventSchema.parse({
        type: 'session:exported',
        sessionId: args.sessionId,
        timestamp: new Date(now()).toISOString(),
        sequenceNumber: result.sequenceNumber,
        workflowPath: result.path,
      });
      deps.io.writeOut(`${JSON.stringify(event)}\n`);
    } else {
      deps.io.writeOut(`Exported session ${args.sessionId} to ${result.path}\n`);
    }
    return EXIT_CODES.success;
  } finally {
    opened.close();
  }
}
