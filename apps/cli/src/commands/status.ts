import type { RunEvent } from '@relavium/shared';

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
import { createFileTerminalOutbox } from '../engine/terminal-outbox.js';
import { terminalOutboxPath } from '../history/open.js';

export interface StatusCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
  /** Injected in tests; production reads `~/.relavium/terminal-outbox.ndjson` through the file outbox. */
  readonly readTerminalOutbox?: (homeDir: string) => Promise<readonly RunEvent[]>;
}

/**
 * The run ids whose terminal is sitting in the outbox, or an empty set if it cannot be read.
 *
 * Best-effort by design: an unreadable outbox must degrade `status` to what it showed before, never fail it.
 */
async function heldTerminalRunIds(
  homeDir: string,
  read: StatusCommandDeps['readTerminalOutbox'],
): Promise<ReadonlySet<string>> {
  try {
    const events = await (read ?? defaultReadTerminalOutbox)(homeDir);
    return new Set(
      events.map((event) => event.runId).filter((id): id is string => id !== undefined),
    );
  } catch {
    return new Set();
  }
}

const defaultReadTerminalOutbox = (homeDir: string): Promise<readonly RunEvent[]> =>
  createFileTerminalOutbox(terminalOutboxPath(homeDir)).list();

interface ActiveRunStatus {
  readonly run: RunRecord;
  /** `true` when this run's terminal is held in the outbox — its outcome is known but not yet durable. */
  readonly terminalHeld: boolean;
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
export async function statusCommand(deps: StatusCommandDeps): Promise<ExitCode> {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = openHistoryReader(homeDir, deps.openDb);
  // Runs whose TERMINAL is held in the outbox (ADR-0078 §4/§5) — read, never drained.
  //
  // A run in that state is still `running` in the derived projection, so it appears here as an ordinary
  // active run with nothing saying its outcome is already known. Exit code 5 tells a script to "re-check
  // `relavium status <runId>` after a subsequent invocation", and a review found that instruction can never
  // resolve on its own: only `run` and `gate` drain the outbox, because only they construct a
  // `WorkflowEngine`. A user who does the natural thing — ask for status again — sees the same stale truth
  // forever. Naming the state here is what makes the documented remedy actionable.
  //
  // READ-ONLY, deliberately. Draining is a write that claims a run lease; a status read must not take
  // ownership of a run another process may be finishing right now.
  const held = await heldTerminalRunIds(homeDir, deps.readTerminalOutbox);
  try {
    const statuses: ActiveRunStatus[] = reader.listActiveRuns().map((run) => ({
      run,
      terminalHeld: held.has(run.id),
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
    // The run's outcome is already known and only its durable record is missing — the exit-5 state. A
    // machine consumer needs this to tell "still working" from "finished, not yet recorded".
    terminalHeld: status.terminalHeld,
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
  if (status.terminalHeld) {
    // The run reads `running` because its terminal never became durable; without this line the exit-5
    // instruction ("re-check `relavium status`") has nothing to show the user on the re-check.
    io.writeOut(
      '  ⚠ this run has FINISHED — its terminal is held in the outbox and is not durable yet.\n' +
        '    Recovery is attempted by `relavium run` and `relavium gate`; the next one retries it.\n',
    );
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
