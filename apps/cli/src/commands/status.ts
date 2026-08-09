import type { Db, RunHistoryReader, RunRecord, StepRecord } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingHumanGates, type PendingGate } from '../gate/pending.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';
import { sanitizeInline } from '../render/sanitize.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';

export interface StatusCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
}

interface ActiveRunStatus {
  readonly run: RunRecord;
  readonly steps: readonly StepRecord[];
  readonly pendingGates: readonly PendingGate[];
  /** `true` when this run's event log could not be read, so `pendingGates` is a stand-in (#W15-15). */
  readonly gatesUnavailable: boolean;
}

/**
 * The `relavium status` core (**2.I**) — show the active/paused runs (`listActiveRuns`) and each run's per-node
 * step status (`loadStepExecutions`). For a run paused at a human gate it also surfaces the pending `gateId`(s)
 * with gate type + node id, so an operator can pass the right one to `relavium gate <runId> --gate <gateId>`
 * (canonical: [commands.md](../../../docs/reference/cli/commands.md)). `--json` emits one record per run.
 * Framework-free; no `runId` argument (it lists every active run).
 */
export function statusCommand(deps: StatusCommandDeps): ExitCode {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = openHistoryReader(homeDir, deps.openDb);
  try {
    const statuses: ActiveRunStatus[] = reader.listActiveRuns().map((run) => ({
      run,
      steps: reader.loadStepExecutions(run.id),
      // Only a `paused` run can hold a pending human gate: persisting a `human_gate:paused` event folds the
      // run's status to `paused` (run-history-store applyDerived), so reconstruct the log only for those — a
      // `running` run has no pending gate.
      // Per-run isolation (`readPerRunOrDegrade`): one damaged row in one run must not blank the whole list.
      // The degradation travels WITH the value (#W15-15) — an empty `pendingGates` on a damaged run would
      // otherwise read as "this run has no gates" when the truth is "its gates could not be read".
      ...gatesOf(reader, run),
    }));

    if (deps.global.json) {
      writeRecordLines(deps.io, statuses.map(toJson));
      return EXIT_CODES.success;
    }

    if (statuses.length === 0) {
      deps.io.writeOut('No active runs.\n');
      return EXIT_CODES.success;
    }
    for (const status of statuses) {
      renderRun(deps.io, status);
    }
    return EXIT_CODES.success;
  } finally {
    close();
  }
}

/**
 * A paused run's pending gates, plus whether they could be read at all (#W15-15). Only a `paused` run can hold
 * one — persisting `human_gate:paused` folds the run's status to `paused` (run-history-store `applyDerived`) —
 * so a `running` run is answered without touching its log, and is never "unavailable".
 */
function gatesOf(
  reader: RunHistoryReader,
  run: RunRecord,
): { pendingGates: readonly PendingGate[]; gatesUnavailable: boolean } {
  if (run.status !== 'paused') {
    return { pendingGates: [], gatesUnavailable: false };
  }
  const read = readPerRunOrDegrade<readonly PendingGate[]>([], () =>
    pendingHumanGates(reader.loadRunEvents(run.id)),
  );
  return { pendingGates: read.value, gatesUnavailable: read.degraded };
}

/** One active run as a machine record: identity + status + per-node steps + any pending human gates. */
function toJson(status: ActiveRunStatus): unknown {
  return {
    runId: status.run.id,
    workflowId: status.run.workflowId,
    status: status.run.status,
    startedAt: status.run.startedAt ?? null,
    steps: status.steps.map((step) => ({
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      status: step.status,
      attemptNumber: step.attemptNumber,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      durationMs: step.durationMs ?? null,
      costMicrocents: step.costMicrocents,
    })),
    // Present ONLY when the log could not be read, so an existing consumer's records are unchanged and a
    // careful one can tell a damaged run from a run with nothing pending (#W15-15).
    ...(status.gatesUnavailable
      ? { gatesUnavailable: true, gatesUnavailableReason: 'corrupt_event_log' }
      : {}),
    pendingGates: status.pendingGates.map((gate) => ({
      gateId: gate.gateId,
      nodeId: gate.nodeId,
      gateType: gate.gateType,
      message: gate.message,
      ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
    })),
  };
}

/** Render one run's status block: a header line, its per-node steps, then any pending gates. */
function renderRun(io: CliIo, status: ActiveRunStatus): void {
  io.writeOut(`run ${status.run.id} — ${status.run.status} (workflow ${status.run.workflowId})\n`);
  if (status.steps.length === 0) {
    io.writeOut('  (no node activity recorded yet)\n');
  }
  for (const step of status.steps) {
    const attempt = step.attemptNumber > 1 ? ` (attempt ${step.attemptNumber})` : '';
    io.writeOut(`  ${step.status.padEnd(9)} ${step.nodeId} [${step.nodeType}]${attempt}\n`);
  }
  if (status.gatesUnavailable) {
    // NOT silence (#W15-15). Without this line a run whose gates were lost to a damaged `run_events` row
    // rendered identically to a paused run with nothing pending — the reader's own listing being the place
    // they would come to find out which run is broken.
    io.writeOut("  ⚠ pending gates unavailable — this run's event log could not be read\n");
  }
  for (const gate of status.pendingGates) {
    // The SAME `human_gate:paused.message` the interactive prompt sanitizes (`clack-prompter.ts`), and it is
    // `resolveTemplate(node.message_template, …)` — i.e. interpolated upstream NODE OUTPUT, the most
    // model-controlled string in the product. The TUI leaf was hardened; this command leaf was not, so a
    // pasted OSC 52 / OSC 8 / CSI payload reached the terminal intact here (G34/#57's class).
    const message = gate.message === '' ? '' : ` — "${sanitizeInline(gate.message)}"`;
    io.writeOut(`  ⏸ pending gate ${gate.gateId} (${gate.gateType}) at ${gate.nodeId}${message}\n`);
  }
}
