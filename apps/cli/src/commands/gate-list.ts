import type { Db } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingHumanGates } from '../gate/pending.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';

export interface GateListCommandArgs {
  /** Optional: list the pending gates of ONE run; omitted ⇒ every paused run. */
  readonly runId?: string;
}

export interface GateListCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
}

/**
 * The `relavium gate list [<runId>]` core (**2.I**) — list the pending human gates across all paused runs, or
 * of one run, so an operator can pick the `gateId` to pass to `relavium gate <runId> --gate <gateId>` (the
 * multi-gate discovery surface the 2.G `gate` command's `--gate` requirement points at). It rests on the SAME
 * `pendingHumanGates` reconstruction the resume path uses, so the two can never disagree; budget gates are
 * excluded (that is `relavium budget resume`). An unknown `runId` is an invalid invocation (exit `2`).
 */
export function gateListCommand(args: GateListCommandArgs, deps: GateListCommandDeps): ExitCode {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = openHistoryReader(homeDir, deps.openDb);
  try {
    const runIds: string[] = [];
    if (args.runId !== undefined) {
      const run = reader.loadRun(args.runId);
      if (run === undefined) {
        throw new CliError('invalid_invocation', `no run found with id ${args.runId}`);
      }
      runIds.push(run.id);
    } else {
      // Only `paused` runs can hold a pending human gate: the engine settles a run to `paused` *before* it
      // persists the `human_gate:paused` event (checkpoint.ts), so a `running`/`pending` run never has one —
      // filtering here avoids reconstructing every active run's log only to find no gate.
      for (const run of reader.listActiveRuns()) {
        if (run.status === 'paused') {
          runIds.push(run.id);
        }
      }
    }

    const rows = runIds.flatMap((runId) =>
      pendingHumanGates(reader.loadRunEvents(runId)).map((gate) => ({ runId, ...gate })),
    );

    if (deps.global.json) {
      writeRecordLines(deps.io, rows);
      return EXIT_CODES.success;
    }

    if (rows.length === 0) {
      deps.io.writeOut(
        args.runId === undefined
          ? 'No pending human gates.\n'
          : `Run ${args.runId} has no pending human gate.\n`,
      );
      return EXIT_CODES.success;
    }
    deps.io.writeOut(`Pending human gates (${rows.length}):\n`);
    for (const row of rows) {
      const message = row.message === '' ? '' : `  "${row.message}"`;
      deps.io.writeOut(
        `  ${row.runId}  ${row.gateId}  ${row.gateType}  node=${row.nodeId}${message}\n`,
      );
    }
    return EXIT_CODES.success;
  } finally {
    close();
  }
}
