import type { Db, RunHistoryReader } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingHumanGates, type PendingGate } from '../gate/pending.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';
import { sanitizeInline } from '../render/sanitize.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';

/** How many unreadable run ids the #W15-15 warning names before it elides — same bound-the-diagnostic
 *  reasoning as `logs.ts`'s `MAX_REPORTED_SKIPS`. */
const MAX_REPORTED_UNREADABLE = 8;

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
 * `pendingHumanGates` reconstruction the resume path uses, so the two cannot disagree on the FOLD (they deliberately differ on the READ — ADR-0075 makes the resume refuse a log a display still shows, so a discovery surface may list a gate `relavium gate` will decline); budget gates are
 * excluded (that is `relavium budget resume`). An unknown `runId` is an invalid invocation (exit `2`).
 */
export function gateListCommand(args: GateListCommandArgs, deps: GateListCommandDeps): ExitCode {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = openHistoryReader(homeDir, deps.openDb);
  try {
    // Per-run isolation (`readPerRunOrDegrade`) for the no-arg ALL-RUNS form: one damaged run used to abort the
    // whole listing. With an explicit `runId` there is only one run, so degrading would silently answer "no
    // gates" for a run the user named — that must still fail loudly, and it does (the throw propagates).
    const runIds = targetRunIds(reader, args.runId);
    const rows: GateRow[] = [];
    const unreadableRunIds: string[] = [];
    for (const runId of runIds) {
      const read = (): readonly PendingGate[] => pendingHumanGates(reader.loadRunEvents(runId));
      if (args.runId !== undefined) {
        rows.push(...read().map((gate): GateRow => ({ runId, ...gate })));
        continue;
      }
      const result = readPerRunOrDegrade<readonly PendingGate[]>([], read);
      // #W15-15: a degraded run used to contribute nothing and say nothing, so "No pending human gates."
      // covered a run whose gates had been LOST. Both output modes now name it.
      if (result.degraded) unreadableRunIds.push(runId);
      rows.push(...result.value.map((gate): GateRow => ({ runId, ...gate })));
    }

    if (deps.global.json) {
      // One extra record per unreadable run, on the SAME one-record-per-line stream (ADR-0049). It carries no
      // `gateId`, so a consumer selecting gates is unaffected while a careful one can tell "damaged" from
      // "none". A stderr-only note (the `logs --json` precedent) would have kept stdout pure but left the
      // machine contract silently short of gates, which is the defect itself.
      writeRecordLines(deps.io, [
        ...rows,
        ...unreadableRunIds.map((runId) => ({ runId, unavailable: 'corrupt_event_log' })),
      ]);
      return EXIT_CODES.success;
    }
    renderUnreadableRuns(deps.io, unreadableRunIds);
    renderGateRows(deps.io, rows, args.runId);
    return EXIT_CODES.success;
  } finally {
    close();
  }
}

/**
 * Name the runs whose gates could not be read, on **stderr** so the human listing on stdout stays pipeable
 * (#W15-15). Bounded like `logs.ts`'s skipped-row note: the COUNT is the signal, the first few ids are the
 * lead. No remedy is offered because the CLI genuinely has none for a damaged row — naming the run is what
 * makes it diagnosable, and what lets a user restore just that history DB from a backup.
 */
function renderUnreadableRuns(io: CliIo, runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  const shown = runIds.slice(0, MAX_REPORTED_UNREADABLE);
  const ids = runIds.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
  const one = runIds.length === 1;
  io.writeErr(
    `warning: ${runIds.length} run${one ? '' : 's'} could not be read, so ${one ? 'its' : 'their'} ` +
      `pending gates are NOT listed below (${ids}).\n`,
  );
}

/**
 * The run ids to scan for pending gates: every paused run (only a `paused` run can hold a pending human gate —
 * persisting a `human_gate:paused` event folds the run's status to `paused`, run-history-store applyDerived),
 * or the one requested run. An unknown requested `runId` is an invalid invocation (exit `2`).
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
  // A non-paused run cannot hold a pending human gate — skip it (don't replay its whole event log only to
  // find none), the same guard `statusCommand` applies. The empty result yields the clear "no pending" message.
  return run.status === 'paused' ? [run.id] : [];
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
    // Same untrusted `human_gate:paused.message` as `status.ts` — see the note there.
    const message = row.message === '' ? '' : `  "${sanitizeInline(row.message)}"`;
    io.writeOut(`  ${row.runId}  ${row.gateId}  ${row.gateType}  node=${row.nodeId}${message}\n`);
  }
}
