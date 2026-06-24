import type { Db, RunHistoryReader } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingHumanGates, type PendingGate } from '../gate/pending.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';

/** A pending gate row tagged with its run id — the listing unit (`gate list` JSON record + human line). */
type GateRow = PendingGate & { readonly runId: string };

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
    const rows = targetRunIds(reader, args.runId).flatMap((runId) =>
      pendingHumanGates(reader.loadRunEvents(runId)).map((gate): GateRow => ({ runId, ...gate })),
    );

    if (deps.global.json) {
      writeRecordLines(deps.io, rows);
      return EXIT_CODES.success;
    }
    renderGateRows(deps.io, rows, args.runId);
    return EXIT_CODES.success;
  } finally {
    close();
  }
}

/**
 * The run ids to scan for pending gates: every paused run (only a `paused` run can hold a pending human gate —
 * the engine settles to `paused` before persisting `human_gate:paused`, checkpoint.ts), or the one requested
 * run. An unknown requested `runId` is an invalid invocation (exit `2`).
 */
function targetRunIds(reader: RunHistoryReader, runId: string | undefined): string[] {
  if (runId === undefined) {
    return reader
      .listActiveRuns()
      .filter((run) => run.status === 'paused')
      .map((run) => run.id);
  }
  const run = reader.loadRun(runId);
  if (run === undefined) {
    throw new CliError('invalid_invocation', `no run found with id ${runId}`);
  }
  return [run.id];
}

/** Render the pending-gate rows as one terse line each (or a clear empty message scoped to the query). */
function renderGateRows(io: CliIo, rows: readonly GateRow[], runId: string | undefined): void {
  if (rows.length === 0) {
    io.writeOut(
      runId === undefined
        ? 'No pending human gates.\n'
        : `Run ${runId} has no pending human gate.\n`,
    );
    return;
  }
  io.writeOut(`Pending human gates (${rows.length}):\n`);
  for (const row of rows) {
    const message = row.message === '' ? '' : `  "${row.message}"`;
    io.writeOut(`  ${row.runId}  ${row.gateId}  ${row.gateType}  node=${row.nodeId}${message}\n`);
  }
}
