import type { Db } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { openHistoryReader } from '../history/reader.js';

export interface LogsCommandArgs {
  readonly runId: string;
}

/** How many skipped-row sequence numbers the ADR-0074 §5 note names before it elides — same bound-the-diagnostic
 *  reasoning as `background-failure.ts`'s `MAX_REPORTED`: the COUNT is the signal, the numbers are the lead. */
const MAX_REPORTED_SKIPS = 8;

export interface LogsCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
}

/**
 * The `relavium logs <runId>` core (**2.I**) — replay a past run's persisted `run_events` in `seq` order (the
 * same data the desktop run-detail drawer replays). `--json` emits each raw `RunEvent` as one NDJSON line —
 * the same `RunEvent` data `relavium run --json` streamed (the spec's "raw RunEvent JSON" flag); the human mode
 * prints a terse line per event. An unknown `runId` is an invalid invocation (exit `2`). Framework-free.
 */
export function logsCommand(args: LogsCommandArgs, deps: LogsCommandDeps): ExitCode {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const { reader, close } = openHistoryReader(homeDir, deps.openDb);
  try {
    const run = reader.loadRun(args.runId);
    if (run === undefined) {
      throw new CliError('invalid_invocation', `no run found with id ${args.runId}`);
    }
    const { events, skipped } = reader.loadRunEventLog(args.runId);

    // ADR-0074 §5: rows a NEWER binary wrote are dropped from the read. Say so — the count below and the `[seq]`
    // column would otherwise present a short log with a hole in its sequence as a complete one, and
    // `sse-event-schema.md` §Transport tells consumers to diagnose exactly that as data loss. It goes to
    // STDERR in both modes, so `--json`'s stdout stays a pure NDJSON `RunEvent` stream (the flag's contract).
    if (skipped.length > 0) {
      // BOUNDED, like `background-failure.ts`'s `MAX_REPORTED`: a run replayed under a much newer binary could
      // skip thousands of rows, and one unbounded line of comma-separated integers is not a diagnostic. The count
      // is the signal; the first few numbers are the lead.
      const shown = skipped.slice(0, MAX_REPORTED_SKIPS).map((row) => row.sequenceNumber);
      const seqs = skipped.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
      const one = skipped.length === 1;
      deps.io.writeErr(
        `note: ${skipped.length} event${one ? '' : 's'} written by a newer version of Relavium ` +
          `${one ? 'was' : 'were'} skipped (seq ${seqs}). Upgrade to read ${one ? 'it' : 'them'}.\n`,
      );
    }

    if (deps.global.json) {
      writeRecordLines(deps.io, events); // raw RunEvent per line — identical to the `run --json` stream
      return EXIT_CODES.success;
    }

    deps.io.writeOut(
      `run ${run.id} — ${run.status} (${events.length} event${events.length === 1 ? '' : 's'})\n`,
    );
    for (const event of events) {
      deps.io.writeOut(`${formatLogLine(event)}\n`);
    }
    return EXIT_CODES.success;
  } finally {
    close();
  }
}

/** A terse one-line human rendering of a durable event: `[<seq>] <type> <nodeId?> <detail?>`. */
function formatLogLine(event: RunEvent): string {
  const head = `[${event.sequenceNumber}] ${event.type}`;
  const node = 'nodeId' in event && typeof event.nodeId === 'string' ? ` ${event.nodeId}` : '';
  return `${head}${node}${detailOf(event)}`;
}

/** The event-type-specific tail of a log line — secret-free (the engine masks before persistence). */
function detailOf(event: RunEvent): string {
  switch (event.type) {
    case 'human_gate:paused':
      return ` — gate ${event.gateId} (${event.gateType})`;
    case 'human_gate:resumed':
      return ` — ${event.decision} by ${event.decidedBy}`;
    case 'node:failed':
    case 'run:failed':
      return ` — ${event.error.code}`;
    case 'node:retrying':
      return ` — ${event.error.code} (attempt ${event.attemptNumber ?? 1})`;
    case 'budget:estimate_committed':
      // ADR-0074 §1 — an ESTIMATE, said in those words. `logs` was the only human surface that showed the event
      // existed at all, and it showed no amount.
      return ` — ~${event.estimateMicrocents}µ¢ estimated, possibly billed (~${event.cumulativeConservativeMicrocents}µ¢ total)`;
    case 'run:completed':
      return ' — completed';
    case 'run:cancelled':
      return ' — cancelled';
    default:
      return '';
  }
}
