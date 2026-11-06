import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { acquireCommandResource, type CommandLifetime } from '../process/command-lifetime.js';
import type { RunEvent, RunStatus } from '@relavium/shared';

import type { Db, RunHistoryReader, RunRecord, StepRecord } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { pendingGateDisplays, type PendingGate, type PendingBudgetGate } from '../gate/pending.js';
import {
  budgetIdentifier,
  budgetPromptDetails,
  budgetPromptLabel,
  budgetResumeHints,
} from '../gate/budget.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';
import { sanitizeInline } from '../render/sanitize.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';
import { readRunUsageCoverage, UNVERIFIED_USAGE } from '../history/usage-coverage.js';
import { createFileTerminalOutbox } from '../engine/terminal-outbox.js';
import { terminalOutboxPath } from '../history/open.js';

/** `relavium status [runId]` — one run, active or finished, instead of every active run (MVP-1). */
export interface StatusCommandArgs {
  readonly runId?: string;
}

export interface StatusCommandDeps {
  readonly commandLifetime?: CommandLifetime;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (
    homeDir: string,
    captureClose?: (close: () => void) => void,
    noticeContext?: LocalDbNoticeContext,
  ) => { db: Db; close: () => void };
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
  io: CliIo,
): Promise<ReadonlySet<string>> {
  try {
    const events = await (read ?? defaultReadTerminalOutbox)(homeDir);
    return new Set(
      events.map((event) => event.runId).filter((id): id is string => id !== undefined),
    );
  } catch {
    // Fixed diagnostic only: filesystem errors may carry private paths or persisted text.
    io.writeErr(
      'Warning: terminal outbox unavailable; held terminal status could not be verified.\n',
    );
    return new Set();
  }
}

/** A run in one of these already has its durable terminal; an outbox entry for it is stale, not held. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

const defaultReadTerminalOutbox = (homeDir: string): Promise<readonly RunEvent[]> =>
  createFileTerminalOutbox(terminalOutboxPath(homeDir)).list();

interface ActiveRunStatus {
  readonly run: RunRecord;
  readonly usage: ReturnType<typeof readRunUsageCoverage>;
  readonly usageUnavailable: boolean;
  /** `true` when this run's terminal is held in the outbox — its outcome is known but not yet durable. */
  readonly terminalHeld: boolean;
  readonly steps: readonly StepRecord[];
  readonly pendingGates: readonly PendingGate[];
  readonly pendingBudgetGates: readonly PendingBudgetGate[];
  /** `true` when this run's event log could not be read, so `pendingGates` is a stand-in (#W15-15). */
  readonly gatesUnavailable: boolean;
}

/**
 * The `relavium status` core (**2.I**) — show the active/paused runs (`listActiveRuns`) and each run's per-node
 * step status (`loadStepExecutions`). For a run paused at a human gate it also surfaces the pending `gateId`(s)
 * with gate type + node id, so an operator can pass the right one to `relavium gate <runId> --gate <gateId>`
 * (canonical: [commands.md](../../../docs/reference/cli/commands.md)). `--json` emits one record per run.
 * Framework-free. With a `runId` it shows that one run, active or finished; without, every active run.
 */
export async function statusCommand(
  deps: StatusCommandDeps,
  args: StatusCommandArgs = {},
): Promise<ExitCode> {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = acquireCommandResource(deps.commandLifetime, (captureClose) =>
    openHistoryReader(homeDir, deps.openDb, captureClose, {
      io: deps.io,
      invocation: deps.commandLifetime?.invocation,
    }),
  );
  // Runs whose TERMINAL is held in the outbox (ADR-0078 §4/§5) — read, never drained.
  //
  // A run in that state is still `running` in the derived projection, so it appears here as an ordinary
  // active run with nothing saying its outcome is already known. Exit code 5 tells a script to read
  // `relavium status <runId>`, and a review found that instruction could never resolve on its own: status
  // itself never drains (only a later `run`, `gate`, `budget resume` or Home open does). A user who does the
  // natural thing — ask for status again — would see the same stale truth. Naming the state here is what makes
  // the documented remedy actionable.
  //
  // Only for a run that is still non-terminal. In the reconcile race (commands.md, exit 5) the reconciler's
  // `run:failed` is durable and the run's own refused terminal is ALSO held; that entry is stale, and the next
  // drain drops it rather than landing it. Calling such a run "finished, not durable yet" would be false.
  //
  // READ-ONLY, deliberately. Draining is a write that claims a run lease; a status read must not take
  // ownership of a run another process may be finishing right now.
  try {
    const held = await heldTerminalRunIds(homeDir, deps.readTerminalOutbox, deps.io);
    const runs =
      args.runId === undefined ? reader.listActiveRuns() : [requireRun(reader, args.runId)];
    const statuses: ActiveRunStatus[] = runs.map((run) => {
      let steps: readonly StepRecord[] = [];
      const usage = readPerRunOrDegrade(
        {
          totalCostMicrocents: run.totalCostMicrocents,
          usageCoverage: UNVERIFIED_USAGE,
          unpricedCalls: 0,
          nodes: new Map(),
        },
        () =>
          readRunUsageCoverage(reader, run.id, (snapshot) => {
            steps = snapshot;
          }),
      );
      // A strict read's step amounts and usage fold share one SQLite snapshot. On a damaged log,
      // retain discoverable step detail with explicitly unverified coverage, never the partial fold.
      if (usage.degraded) steps = reader.loadStepExecutions(run.id);
      return {
        run,
        usage: usage.value,
        usageUnavailable: usage.degraded,
        terminalHeld: held.has(run.id) && !TERMINAL_STATUSES.has(run.status),
        steps,
        // Native authority and companion crash prefixes can leave either active status with pending gates.
        // Per-run isolation (`readPerRunOrDegrade`): one damaged row in one run must not blank the whole list.
        // The degradation travels WITH the value (#W15-15) — an empty `pendingGates` on a damaged run would
        // otherwise read as "this run has no gates" when the truth is "its gates could not be read".
        // A FINISHED run (`status <runId>`) has nothing pending, whatever its log left open: a run cancelled or
        // failed while a gate waited never resolves that gate: `gate` / `budget resume` answer it with an exit-0
        // `nothing to resume`, and `gate list` skips it.
        ...(TERMINAL_STATUSES.has(run.status) ? NOTHING_PENDING : gatesOf(reader, run)),
      };
    });

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
    if (deps.commandLifetime === undefined) close();
  }
}

/** The run `status <runId>` names, active or finished (soft-deleted excluded), as `logs` resolves it. */
function requireRun(reader: RunHistoryReader, runId: string): RunRecord {
  const run = reader.loadRun(runId);
  if (run === undefined) {
    throw new CliError('invalid_invocation', `no run found with id ${runId}`);
  }
  return run;
}

/** What a finished run has pending: nothing (see the call site). */
const NOTHING_PENDING = {
  pendingGates: [],
  pendingBudgetGates: [],
  gatesUnavailable: false,
} as const;

/** Reconstruct once per active run: a companion crash may leave a running projection with pending gates. */
function gatesOf(
  reader: RunHistoryReader,
  run: RunRecord,
): {
  pendingGates: readonly PendingGate[];
  pendingBudgetGates: readonly PendingBudgetGate[];
  gatesUnavailable: boolean;
} {
  const read = readPerRunOrDegrade<ReturnType<typeof pendingGateDisplays>>(
    { pendingGates: [], pendingBudgetGates: [] },
    () => pendingGateDisplays(reader.loadRunEvents(run.id)),
  );
  return { ...read.value, gatesUnavailable: read.degraded };
}

/** One active run as a machine record: identity + status + per-node steps + any pending human gates. */
function toJson(status: ActiveRunStatus): unknown {
  return {
    runId: status.run.id,
    workflowId: status.run.workflowId,
    status: status.run.status,
    totalCostMicrocents: status.usage.totalCostMicrocents,
    usageCoverage: status.usage.usageCoverage,
    unpricedCalls: status.usage.unpricedCalls,
    ...(status.usageUnavailable
      ? { usageUnavailable: true, usageUnavailableReason: 'unreadable_event_log' }
      : {}),
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
      usageCoverage: status.usage.nodes.get(step.nodeId) ?? UNVERIFIED_USAGE,
    })),
    // Present ONLY when the log could not be read, so a
    // careful one can tell a damaged run from a run with nothing pending (#W15-15).
    ...(status.gatesUnavailable
      ? { gatesUnavailable: true, gatesUnavailableReason: 'corrupt_event_log' }
      : {}),
    pendingBudgetGates: status.pendingBudgetGates.map((gate) => ({
      gateId: budgetIdentifier(gate.gateId),
      nodeId: budgetIdentifier(gate.nodeId),
      allowance: gate.allowance,
      ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
    })),
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
  // Every identifier here is read back from history.db, so each is printed one-line with controls stripped, as
  // the gate message below is (the run path writes only validated ids, but the file is the trust boundary).
  const finished = TERMINAL_STATUSES.has(status.run.status);
  io.writeOut(
    `run ${sanitizeInline(status.run.id)} — ${status.run.status} (workflow ${sanitizeInline(status.run.workflowId)})\n`,
  );
  if (status.usageUnavailable) {
    io.writeOut("  ⚠ usage coverage unavailable — this run's event log could not be read\n");
  }
  if (status.steps.length === 0) {
    io.writeOut(finished ? '  (no node ran)\n' : '  (no node activity recorded yet)\n');
  }
  for (const step of status.steps) {
    const attempt = step.attemptNumber > 1 ? ` (attempt ${step.attemptNumber})` : '';
    // A run terminal does not close a step row the node never finished, so under a finished run it says so.
    const shown = finished && step.status === 'running' ? 'stopped' : step.status;
    io.writeOut(
      `  ${shown.padEnd(9)} ${sanitizeInline(step.nodeId)} [${sanitizeInline(step.nodeType)}]${attempt}\n`,
    );
  }
  if (status.terminalHeld) {
    // The run reads `running` because its terminal never became durable; without this line the exit-5
    // instruction ("re-check `relavium status`") has nothing to show the user on the re-check.
    io.writeOut(
      '  ⚠ this run has FINISHED — its terminal is held in the outbox and is not durable yet.\n' +
        '    Recovery is attempted by `relavium run`, `relavium gate`, `relavium budget resume` and opening the\n' +
        '    `relavium` Home; the next one retries it.\n',
    );
  }
  if (status.gatesUnavailable) {
    // NOT silence (#W15-15). Without this line a run whose gates were lost to a damaged `run_events` row
    // rendered identically to a paused run with nothing pending — the reader's own listing being the place
    // they would come to find out which run is broken.
    io.writeOut("  ⚠ pending gates unavailable — this run's event log could not be read\n");
  }
  for (const gate of status.pendingBudgetGates) {
    const gateId = budgetIdentifier(gate.gateId);
    io.writeOut(
      `  ⏸ pending budget gate ${gateId} at ${budgetIdentifier(gate.nodeId)} — ${budgetPromptLabel(gate.allowance)}\n`,
    );
    for (const detail of budgetPromptDetails(gate.allowance)) io.writeOut(`    ${detail}\n`);
    for (const hint of budgetResumeHints(status.run.id, gate.gateId, gate.allowance))
      io.writeOut(`    ${hint}\n`);
  }
  for (const gate of status.pendingGates) {
    // The SAME `human_gate:paused.message` the interactive prompt sanitizes (`clack-prompter.ts`), and it is
    // `resolveTemplate(node.message_template, …)` — i.e. interpolated upstream NODE OUTPUT, the most
    // model-controlled string in the product. The TUI leaf was hardened; this command leaf was not, so a
    // pasted OSC 52 / OSC 8 / CSI payload reached the terminal intact here (G34/#57's class).
    const message = gate.message === '' ? '' : ` — "${sanitizeInline(gate.message)}"`;
    io.writeOut(
      `  ⏸ pending gate ${sanitizeInline(gate.gateId)} (${gate.gateType}) at ${sanitizeInline(gate.nodeId)}${message}\n`,
    );
  }
}
