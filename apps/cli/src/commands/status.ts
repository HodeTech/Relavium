import type { Db, RunRecord, StepRecord } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingHumanGates, type PendingGate } from '../gate/pending.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';

export interface StatusCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
}

interface RunStatus {
  readonly run: RunRecord;
  readonly steps: readonly StepRecord[];
  readonly pendingGates: readonly PendingGate[];
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
    const statuses: RunStatus[] = reader.listActiveRuns().map((run) => ({
      run,
      steps: reader.loadStepExecutions(run.id),
      // Pending human gates only matter for a paused run; reconstruct from its event log.
      pendingGates: run.status === 'paused' ? pendingHumanGates(reader.loadRunEvents(run.id)) : [],
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

/** One active run as a machine record: identity + status + per-node steps + any pending human gates. */
function toJson(status: RunStatus): unknown {
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
      durationMs: step.durationMs ?? null,
    })),
    pendingGates: status.pendingGates.map((gate) => ({
      gateId: gate.gateId,
      nodeId: gate.nodeId,
      gateType: gate.gateType,
      ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
    })),
  };
}

/** Render one run's status block: a header line, its per-node steps, then any pending gates. */
function renderRun(io: CliIo, status: RunStatus): void {
  io.writeOut(`run ${status.run.id} — ${status.run.status} (workflow ${status.run.workflowId})\n`);
  if (status.steps.length === 0) {
    io.writeOut('  (no node activity recorded yet)\n');
  }
  for (const step of status.steps) {
    const attempt = step.attemptNumber > 1 ? ` (attempt ${step.attemptNumber})` : '';
    io.writeOut(`  ${step.status.padEnd(9)} ${step.nodeId} [${step.nodeType}]${attempt}\n`);
  }
  for (const gate of status.pendingGates) {
    io.writeOut(`  ⏸ pending gate ${gate.gateId} (${gate.gateType}) at ${gate.nodeId}\n`);
  }
}
