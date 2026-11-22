import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { acquireCommandResource, type CommandLifetime } from '../process/command-lifetime.js';
import {
  MAX_RUN_TAIL_EVENTS,
  type Db,
  type RunHistoryReader,
  type RunRecord,
  type SkippedRunEvent,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { budgetResumeHints } from '../gate/budget.js';
import { humanGateResumeHints, pendingGateDisplays } from '../gate/pending.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { hostSleep } from '../process/sleep.js';
import { writeRecordLines } from '../render/records.js';
import { formatRunOutputs } from '../render/run-outputs.js';
import { sanitizeInline } from '../render/sanitize.js';
import { openHistoryReader, type OpenedReader } from '../history/reader.js';

export interface LogsCommandArgs {
  readonly runId: string;
  /** `--failed` (ADR-0140 §7): only the events that carry a failure, and the run's closing event. */
  readonly failed?: boolean;
}

/** How long `--follow` waits between polls that found nothing new (ADR-0140 §7). Fixed, not configurable. */
export const FOLLOW_POLL_INTERVAL_MS = 500;

/**
 * How often `--follow` asks whether anything still owns the run it is waiting on, counted on the injected clock
 * from the moment the follow starts (so a run that has only just begun is not judged in its first second). A
 * dead owner never writes the terminal event the follow waits for.
 */
export const FOLLOW_LIVENESS_INTERVAL_MS = 1000;

/** How many skipped-row sequence numbers the ADR-0074 §5 note names before it elides — same bound-the-diagnostic
 *  reasoning as the fixed native background-diagnostic bound: the COUNT is the signal, the numbers are the lead. */
const MAX_REPORTED_SKIPS = 8;

export interface LogsCommandDeps {
  readonly commandLifetime?: CommandLifetime;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly openDb?: (
    homeDir: string,
    captureClose?: (close: () => void) => void,
    noticeContext?: LocalDbNoticeContext,
  ) => { db: Db; close: () => void };
  /** The wait between `--follow` polls; abort-aware. Tests inject one so no real time passes. */
  readonly sleep?: typeof hostSleep;
  /** The clock (epoch ms) `--follow` rates its liveness check by and compares a lease's expiry with. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The `relavium logs <runId>` core (**2.I**) — replay a past run's persisted `run_events` in `seq` order (the
 * same data the desktop run-detail drawer replays). `--json` emits each raw `RunEvent` as one NDJSON line —
 * the same `RunEvent` data `relavium run --json` streamed (the spec's "raw RunEvent JSON" flag); the human mode
 * prints a terse line per event. An unknown `runId` is an invalid invocation (exit `2`). `--failed` keeps only the
 * events that carry a failure and the run's closing event (ADR-0140 §7). Framework-free.
 */
export function logsCommand(args: LogsCommandArgs, deps: LogsCommandDeps): ExitCode {
  const { reader, close } = openReader(deps);
  try {
    const run = requireRun(reader, args.runId);
    const { events, skipped } = reader.loadRunEventLog(args.runId);

    // ADR-0074 §5: rows a NEWER binary wrote are dropped from the read. Say so — the count below and the `[seq]`
    // column would otherwise present a short log with a hole in its sequence as a complete one, and
    // `sse-event-schema.md` §Transport tells consumers to diagnose exactly that as data loss. It goes to
    // STDERR in both modes, so `--json`'s stdout stays a pure NDJSON `RunEvent` stream (the flag's contract).
    writeSkippedNote(deps.io, skipped);
    writeLog(deps, run, events, args.failed === true);
    return EXIT_CODES.success;
  } finally {
    if (deps.commandLifetime === undefined) close();
  }
}

/**
 * `relavium logs <runId> --follow` (ADR-0140 §7): print the log exactly as {@link logsCommand} prints it, then keep
 * reading the durable events written after it and print each as it arrives, until the run is terminal or parked at
 * a gate. It ends with exit `0` whatever the run's own outcome (a log reader reports no run's result); a signal
 * ends it through the command lifetime's existing stop (the next write or poll finds the owner stopped, and the
 * wait itself is abort-aware), so the signal exits stay the process's own.
 *
 * **A dead owner ends it too.** A run whose process was killed (or whose media park outlived its owner) never
 * gets a terminal event, so a poll that found nothing also asks, at most once per
 * {@link FOLLOW_LIVENESS_INTERVAL_MS} of the injected clock, whether the run still has an owner: the run row gone,
 * or no lease row, or a lease that has expired, ends the follow with one stderr note and exit `0` (see
 * {@link followEndsForWantOfOwner}). A run with a live lease keeps being followed. Framework-free.
 */
export async function logsFollowCommand(
  args: LogsCommandArgs,
  deps: LogsCommandDeps,
): Promise<ExitCode> {
  const { reader, close } = openReader(deps);
  try {
    const run = requireRun(reader, args.runId);
    const failedOnly = args.failed === true;
    const history = readHistory(reader, args.runId);
    writeSkippedNote(deps.io, history.skipped);
    writeLog(deps, run, history.events, failedOnly);

    const now = deps.now ?? Date.now;
    let lastLivenessCheckMs = now();
    let cursor = history.scannedThroughSeq;
    let state = history.events.reduce(observeFollow, QUIET_RUN);
    for (;;) {
      const end = followEnd(state);
      if (end === 'gate') writeGateNotice(deps, reader, run.id);
      if (end !== undefined) return EXIT_CODES.success;
      // A stopped owner refuses here, before another read, whatever the wait below did.
      deps.commandLifetime?.work.assertAdmitting();
      const tail = reader.loadRunEventsAfter(args.runId, cursor, MAX_RUN_TAIL_EVENTS);
      // The cursor moves over the rows this read skipped too (`scannedThroughSeq`, never the last event's
      // number): parked on the last readable event, a log whose tail a newer binary wrote would be re-read, and
      // its skip note repeated, on every poll.
      cursor = tail.scannedThroughSeq;
      writeSkippedNote(deps.io, tail.skipped);
      for (const event of tail.events) {
        state = observeFollow(state, event);
        if (!failedOnly || inFailureView(event)) writeFollowed(deps, run.id, event, failedOnly);
      }
      if (tail.events.length === 0) {
        // Nothing new, and the run is neither over nor parked at a gate (the top of the loop ended it): ask, but
        // not on every poll, whether anyone is still going to write to it.
        const checkedAtMs = now();
        if (checkedAtMs - lastLivenessCheckMs >= FOLLOW_LIVENESS_INTERVAL_MS) {
          lastLivenessCheckMs = checkedAtMs;
          if (followEndsForWantOfOwner(deps, reader, run.id, checkedAtMs))
            return EXIT_CODES.success;
        }
        await (deps.sleep ?? hostSleep)(FOLLOW_POLL_INTERVAL_MS, deps.commandLifetime?.work.signal);
      }
    }
  } finally {
    if (deps.commandLifetime === undefined) close();
  }
}

/**
 * Whether a followed run can no longer grow, and the one stderr note that says why (never stdout, so `--json`'s
 * stream stays pure). Two cases end it: the run row is gone, or the run holds no live lease — no lease row, or one
 * whose `expiresAt` is at or before `nowMs`. A run parked on a media job alone keeps its lease while the engine
 * polls the job, so it keeps being followed; a run parked at a gate released its lease, but the loop has already
 * ended on that gate before this runs.
 */
function followEndsForWantOfOwner(
  deps: LogsCommandDeps,
  reader: RunHistoryReader,
  runId: string,
  nowMs: number,
): boolean {
  const id = sanitizeInline(runId);
  if (reader.loadRun(runId) === undefined) {
    deps.io.writeErr(
      `note: run ${id} is no longer in the history, so there is nothing more to follow.\n`,
    );
    return true;
  }
  const lease = reader.loadRunLeases([runId]).get(runId);
  if (lease !== undefined && lease.expiresAt > nowMs) return false;
  deps.io.writeErr(
    `note: run ${id} has no live owner, so its log will not grow. ` +
      `\`relavium status ${id}\` shows where it stands; the next \`relavium run\` or Home start settles it.\n`,
  );
  return true;
}

/** Open the history reader the way every `logs` mode does: resolved home, command-lifetime custody of the close. */
function openReader(deps: LogsCommandDeps): OpenedReader {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  return acquireCommandResource(deps.commandLifetime, (captureClose) =>
    openHistoryReader(homeDir, deps.openDb, captureClose, {
      io: deps.io,
      invocation: deps.commandLifetime?.invocation,
    }),
  );
}

function requireRun(reader: RunHistoryReader, runId: string): RunRecord {
  const run = reader.loadRun(runId);
  if (run === undefined) throw new CliError('invalid_invocation', `no run found with id ${runId}`);
  return run;
}

/**
 * The whole existing log, read through the poll's own tail read so the cursor it ends on is exact. Exported for
 * its test only (a fake reader proves the accumulation holds at sizes a real log would take minutes to build).
 */
export function readHistory(
  reader: Pick<RunHistoryReader, 'loadRunEventsAfter'>,
  runId: string,
): {
  readonly events: readonly RunEvent[];
  readonly skipped: readonly SkippedRunEvent[];
  readonly scannedThroughSeq: number;
} {
  const events: RunEvent[] = [];
  const skipped: SkippedRunEvent[] = [];
  let scannedThroughSeq = -1;
  for (;;) {
    const page = reader.loadRunEventsAfter(runId, scannedThroughSeq, MAX_RUN_TAIL_EVENTS);
    // A loop, not `push(...rows)`: a spread passes every element as an argument and throws a RangeError past about
    // 125,000 of them, and a log full of rows a newer binary wrote can skip that many.
    for (const event of page.events) events.push(event);
    for (const row of page.skipped) skipped.push(row);
    scannedThroughSeq = page.scannedThroughSeq;
    // The tail read holds out for a full page while readable rows remain, so a short page is the end of the log.
    if (page.events.length < MAX_RUN_TAIL_EVENTS) return { events, skipped, scannedThroughSeq };
  }
}

/** What `--follow` has learned about the run's state from the events it has seen, in order. */
interface FollowState {
  readonly terminal: boolean;
  /** The run's latest `run:paused` named a gate and nothing has answered it since. */
  readonly parkedAtGate: boolean;
}

const QUIET_RUN: FollowState = { terminal: false, parkedAtGate: false };

function observeFollow(state: FollowState, event: RunEvent): FollowState {
  switch (event.type) {
    case 'run:completed':
    case 'run:failed':
    case 'run:cancelled':
      return { ...state, terminal: true };
    // The aggregate park, emitted once the run is idle with gates pending: node-boundary granularity, and never for
    // a gate a sibling branch is still running past. A park on a media job alone names no gate to answer.
    case 'run:paused':
      return { ...state, parkedAtGate: event.gateIds.length > 0 };
    case 'human_gate:resumed':
      return { ...state, parkedAtGate: false };
    case 'budget:authorization':
      return event.authorization.state === 'decided' ? { ...state, parkedAtGate: false } : state;
    default:
      return state;
  }
}

function followEnd(state: FollowState): 'terminal' | 'gate' | undefined {
  if (state.terminal) return 'terminal';
  return state.parkedAtGate ? 'gate' : undefined;
}

/** The events `--failed` keeps: the ones that carry a failure, and the run's closing event. */
function inFailureView(event: RunEvent): boolean {
  switch (event.type) {
    case 'node:failed':
    case 'node:retrying':
    case 'run:failed':
    case 'run:completed':
    case 'run:cancelled':
      return true;
    default:
      return false;
  }
}

/** One event as `--follow` receives it: one NDJSON line under `--json`, else the human row. One write per line. */
function writeFollowed(
  deps: LogsCommandDeps,
  runId: string,
  event: RunEvent,
  failedOnly: boolean,
): void {
  if (deps.global.json) writeRecordLines(deps.io, [event]);
  else writeHumanEvent(deps.io, runId, event, !failedOnly);
}

/**
 * The line that says a followed run is waiting and how to answer it. It names the same commands `relavium status`
 * prints for each pending gate (one gate's, and a count of the rest). Under `--json` it goes to stderr, so stdout
 * stays a pure `RunEvent` stream.
 */
function writeGateNotice(deps: LogsCommandDeps, reader: RunHistoryReader, runId: string): void {
  const id = sanitizeInline(runId);
  const gates = readPerRunOrDegrade<readonly (readonly string[])[]>([], () => {
    const pending = pendingGateDisplays(reader.loadRunEventLog(runId).events);
    return [
      ...pending.pendingBudgetGates.map((gate) =>
        budgetResumeHints(runId, gate.gateId, gate.allowance),
      ),
      ...pending.pendingGates.map((gate) =>
        humanGateResumeHints(runId, gate.gateId, gate.gateType),
      ),
    ];
  }).value;
  const [first, ...rest] = gates;
  const answer =
    first === undefined
      ? `\`relavium status ${id}\` shows how to answer it`
      : `${first.join('; ')}${rest.length === 0 ? '' : ` (${rest.length} more: \`relavium status ${id}\` lists them)`}`;
  const line = `${sanitizeInline(`run ${id} is paused at a gate — ${answer}`)}\n`;
  if (deps.global.json) deps.io.writeErr(line);
  else deps.io.writeOut(line);
}

/** The stderr note for rows a newer binary wrote (ADR-0074 §5); nothing when no row was skipped. */
function writeSkippedNote(io: CliIo, skipped: readonly SkippedRunEvent[]): void {
  if (skipped.length === 0) return;
  // BOUNDED, like the fixed native background-diagnostic bound: a run replayed under a much newer binary could
  // skip thousands of rows, and one unbounded line of comma-separated integers is not a diagnostic. The count
  // is the signal; the first few numbers are the lead. Each is read back from history.db, whose `seq` column takes
  // any text, so it gets the one-line floor too.
  const shown = skipped
    .slice(0, MAX_REPORTED_SKIPS)
    .map((row) => sanitizeInline(String(row.sequenceNumber)));
  const seqs = skipped.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
  const one = skipped.length === 1;
  io.writeErr(
    `note: ${skipped.length} event${one ? '' : 's'} written by a newer version of Relavium ` +
      `${one ? 'was' : 'were'} skipped (seq ${seqs}). Upgrade to read ${one ? 'it' : 'them'}.\n`,
  );
}

/** The log as the mode asks for it: NDJSON `RunEvent`s under `--json`, else the header and one row per event. */
function writeLog(
  deps: LogsCommandDeps,
  run: RunRecord,
  events: readonly RunEvent[],
  failedOnly: boolean,
): void {
  const shown = failedOnly ? events.filter(inFailureView) : events;
  if (deps.global.json) {
    writeRecordLines(deps.io, shown); // raw RunEvent per line — identical to the `run --json` stream
    return;
  }
  writeHumanLog(deps.io, run, events, shown, failedOnly);
}

/** The human rendering: a header line, one row per event, and the workflow's outputs under the terminal row. */
function writeHumanLog(
  io: CliIo,
  run: RunRecord,
  events: readonly RunEvent[],
  shown: readonly RunEvent[],
  failedOnly: boolean,
): void {
  const total = `${events.length} event${events.length === 1 ? '' : 's'}`;
  // Both are read back from history.db, the trust boundary, so each gets the one-line floor the rows below get.
  io.writeOut(
    `run ${sanitizeInline(run.id)} — ${sanitizeInline(run.status)} (${failedOnly ? `${shown.length} of ${total}` : total})\n`,
  );
  for (const event of shown) writeHumanEvent(io, run.id, event, !failedOnly);
}

/**
 * One human row, with the workflow's outputs under a `run:completed` row when `withOutputs` (MVP-A1, bounded and
 * sanitized by the shared formatter). `--failed` leaves them out: it is a view of failures, one row per event.
 */
function writeHumanEvent(io: CliIo, runId: string, event: RunEvent, withOutputs: boolean): void {
  // One row per event: the line carries stored fields (a gate id, `decidedBy`, a node id), so it gets the
  // one-line floor before it reaches the terminal, as the plain run renderer does.
  io.writeOut(`${sanitizeInline(formatLogLine(event))}\n`);
  if (withOutputs && event.type === 'run:completed') {
    for (const line of formatRunOutputs(event.outputs, '    ', runId)) {
      io.writeOut(`${line}\n`);
    }
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
    // The persisted-run twin of the plain renderer's `skip` line. Without the reason this row says a node
    // did not run and not why, which is the same "silent skip" gap the live surface had.
    case 'node:skipped':
      return ` — ${event.reason}`;
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
