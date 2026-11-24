import type { LocalDbNoticeContext } from '../db/checkpoint-notice.js';
import { acquireCommandResource, type CommandLifetime } from '../process/command-lifetime.js';
import {
  MAX_RUN_TAIL_EVENTS,
  type Db,
  type RunHistoryReader,
  type RunRecord,
  type SkippedRunEvent,
} from '@relavium/db';
import { RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS, type RunEvent } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import {
  budgetIdentifier,
  budgetPromptDetails,
  budgetPromptLabel,
  budgetResumeHints,
} from '../gate/budget.js';
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

/**
 * How long `--follow` holds back a no-owner verdict after its own loop was suspended: one lease heartbeat, counted
 * on the injected clock from the tick that found the gap. A gap between two of its ticks longer than a lease TTL
 * (a laptop that slept, a VM that was paused, a wall clock that jumped) is evidence about the clock, not about the
 * owner, whose own timers were suspended with it: a lease that looks long expired may be renewed by the owner's
 * first beat after the wake, and one beat is how long that takes at most. The lease is read again at every check
 * in that window, and the follow ends on the verdict only if it still says the lease is gone when the window ends.
 */
export const FOLLOW_RESUME_GRACE_MS = RUN_LEASE_HEARTBEAT_MS;

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
 * or a lease that expired more than a TTL ago, or no lease row on a run that is not younger than a TTL, ends the follow with one
 * stderr note and exit `0` (see {@link followOwnerVerdict}), but only after one more read of the log: the owner
 * commits its closing event and releases its lease in that order, and the lease check can land between the two.
 * If that read returns anything, the verdict is not acted on: the events are printed and the follow goes on, to
 * judge again at its next check. A run with a live lease keeps being followed.
 *
 * **A suspended process does not judge the owner (HISTORY-1).** When more than one `RUN_LEASE_TTL_MS` passed between
 * two of the loop's own ticks, the machine slept or the clock jumped, and the owner's heartbeat was suspended with
 * the follow: the lease then looks long expired although the owner is alive and about to renew it. A no-owner verdict
 * is held back for {@link FOLLOW_RESUME_GRACE_MS} from that tick, and the lease is read again at each check in the
 * window; only a lease that is still gone after it ends the follow. Framework-free.
 */
export async function logsFollowCommand(
  args: LogsCommandArgs,
  deps: LogsCommandDeps,
): Promise<ExitCode> {
  const { reader, close } = openReader(deps);
  try {
    return await followRun(args, deps, reader);
  } finally {
    if (deps.commandLifetime === undefined) close();
  }
}

/** The loop's own clock: what lets a poll tell a suspended process from a dead owner. */
interface FollowClock {
  /** The injected clock's reading at the last empty-poll tick (see {@link FOLLOW_RESUME_GRACE_MS}); a gap since it is judged by {@link judgeOwner}. */
  lastTickMs: number;
  /** The reading at the last time the owner was judged: the judgement is rated by {@link FOLLOW_LIVENESS_INTERVAL_MS}. */
  lastLivenessCheckMs: number;
  /** A no-owner verdict is held back until the injected clock reaches this: set when a gap over one TTL is seen. */
  resumeGraceUntilMs: number;
}

/**
 * What an empty poll asks about the run's owner, at the clock reading `checkedAtMs`: a verdict that ends the follow, or `undefined` to carry on.
 * It is rated (at most once per {@link FOLLOW_LIVENESS_INTERVAL_MS}) and held back after a suspension, both through `clock`, which it updates.
 */
function judgeOwner(
  clock: FollowClock,
  reader: RunHistoryReader,
  runId: string,
  checkedAtMs: number,
): OwnerVerdict | undefined {
  // More than a lease TTL since the last tick means this loop (and the owner with it) was suspended, so what the
  // lease says now is not yet evidence about the owner: hold a no-owner verdict back for one heartbeat.
  if (checkedAtMs - clock.lastTickMs > RUN_LEASE_TTL_MS) {
    clock.resumeGraceUntilMs = checkedAtMs + FOLLOW_RESUME_GRACE_MS;
  }
  clock.lastTickMs = checkedAtMs;
  if (checkedAtMs - clock.lastLivenessCheckMs >= FOLLOW_LIVENESS_INTERVAL_MS) {
    clock.lastLivenessCheckMs = checkedAtMs;
    const read = followOwnerVerdict(reader, runId, checkedAtMs);
    // The lease is read again at each check in the window; only a read that still says it is gone, after the
    // window, ends the follow. A run row that is gone is not about the clock, and is never held back.
    return read === 'no-owner' && checkedAtMs < clock.resumeGraceUntilMs ? undefined : read;
  }
  return undefined;
}

/** The body of {@link logsFollowCommand} once the reader is open: print the log, then follow it until it ends. */
async function followRun(
  args: LogsCommandArgs,
  deps: LogsCommandDeps,
  reader: RunHistoryReader,
): Promise<ExitCode> {
  const run = requireRun(reader, args.runId);
  const failedOnly = args.failed === true;
  const history = readHistory(reader, args.runId);
  writeSkippedNote(deps.io, history.skipped);
  writeLog(deps, run, history.events, failedOnly);

  const now = deps.now ?? Date.now;
  const startMs = now();
  const clock: FollowClock = {
    lastTickMs: startMs,
    lastLivenessCheckMs: startMs,
    resumeGraceUntilMs: Number.NEGATIVE_INFINITY,
  };
  let cursor = history.scannedThroughSeq;
  let state = history.events.reduce((previous, event) => observeFollow(previous, event), QUIET_RUN);
  /** One read after the cursor, printed through the same filter and writer; the events it returned. */
  const readAndPrintTail = (): readonly RunEvent[] => {
    const tail = reader.loadRunEventsAfter(args.runId, cursor, MAX_RUN_TAIL_EVENTS);
    // The cursor moves over the rows this read skipped too (`scannedThroughSeq`, never the last event's
    // number): parked on the last readable event, a log whose tail a newer binary wrote would be re-read, and
    // its skip note repeated, on every poll.
    cursor = tail.scannedThroughSeq;
    writeSkippedNote(deps.io, tail.skipped);
    for (const event of tail.events) {
      // A run that closes in the failure view with no failure before it says so, as the log it replays does.
      if (failedOnly && !state.sawFailure && closesWithoutFailure(event)) writeNoFailureLine(deps);
      state = observeFollow(state, event);
      if (!failedOnly || inFailureView(event)) writeFollowed(deps, run.id, event, failedOnly);
    }
    return tail.events;
  };
  for (;;) {
    const end = followEnd(state);
    if (end === 'gate') writeGateNotice(deps, reader, run.id);
    if (end !== undefined) return EXIT_CODES.success;
    // A stopped owner refuses here, before another read, whatever the wait below did.
    deps.commandLifetime?.work.assertAdmitting();
    if (readAndPrintTail().length > 0) continue;
    // Nothing new, and the run is neither over nor parked at a gate (the top of the loop ended it): ask, but
    // not on every poll, whether anyone is still going to write to it.
    const verdict = judgeOwner(clock, reader, run.id, now());
    if (verdict !== undefined) {
      // The owner may have committed its closing event and released its lease between the read above and the
      // lease check, so a verdict alone must not end the follow before that event is shown: read once more,
      // and print what it returns, first. Whatever it returns, the follow goes on: a closing event, or a gate
      // park, ends it at the top of the loop as it always does (the note, which would say the run was left
      // unsettled, is not written), and any other event shows the run was still writing, so the verdict is
      // judged again at the next check. Only a read that returns nothing ends the follow on the note.
      if (readAndPrintTail().length > 0) continue;
      writeOwnerNote(deps, run.id, verdict);
      return EXIT_CODES.success;
    }
    await (deps.sleep ?? hostSleep)(FOLLOW_POLL_INTERVAL_MS, deps.commandLifetime?.work.signal);
  }
}

/** Why a followed run can no longer grow: its row is gone, or nothing is renewing a lease on it. */
type OwnerVerdict = 'run-gone' | 'no-owner';

/**
 * Whether a followed run can no longer grow. Two cases: the run row is gone, or nothing owns the run. A run parked
 * on a media job alone keeps its lease while the engine polls the job, so it keeps being followed; a run parked at
 * a gate released its lease, but the loop has already ended on that gate before this runs. `undefined` means the
 * follow carries on.
 *
 * The no-owner rule is ADR-0079's (the 2026-11-06 amendment) and ADR-0140 §2's `stalled` rule: the owner renews its
 * lease every `RUN_LEASE_HEARTBEAT_MS` and tolerates missed beats, and a wall clock that jumps (a sleeping laptop)
 * can pass `expiresAt` before the next beat lands, so a lease counts as gone only MORE than one `RUN_LEASE_TTL_MS` after
 * it expired (`now > expiresAt + TTL`, the strict rule `isStalled` applies: a lease that expired exactly one TTL ago is
 * still live); and a run with no lease row counts only once it is no longer younger than that
 * ({@link startedWithinLeaseTtl}, the same young rule `isStalled` applies), because a younger run may not have taken
 * its lease yet, or was started by a version that takes none.
 */
function followOwnerVerdict(
  reader: RunHistoryReader,
  runId: string,
  nowMs: number,
): OwnerVerdict | undefined {
  const run = reader.loadRun(runId);
  if (run === undefined) return 'run-gone';
  const lease = reader.loadRunLeases([runId]).get(runId);
  if (lease === undefined) return startedWithinLeaseTtl(run, nowMs) ? undefined : 'no-owner';
  return nowMs > lease.expiresAt + RUN_LEASE_TTL_MS ? 'no-owner' : undefined;
}

/**
 * Whether `run` started within one lease TTL of `nowMs`, on either side, as the engine's reconcile measures it
 * (ADR-0079): strictly less than a TTL before now, and strictly less than a TTL ahead of it. A start slightly in the
 * future (skew between processes) counts as recent, but one a full TTL or more ahead means a clock moved, and the run
 * falls back to the lease rule; a start exactly a TTL before now is judged too. A run that has not started is counted
 * from its creation; a time that does not parse is never recent.
 */
function startedWithinLeaseTtl(run: RunRecord, nowMs: number): boolean {
  const age = nowMs - Date.parse(run.startedAt ?? run.createdAt);
  return age > -RUN_LEASE_TTL_MS && age < RUN_LEASE_TTL_MS;
}

/**
 * The stderr note that says why a follow ended on a verdict (never stdout, so `--json`'s stream stays pure). It
 * reports what was looked for and not found, since a run a version that takes no lease started cannot be told from a
 * dead one, and it says nothing about the log's future.
 */
function writeOwnerNote(deps: LogsCommandDeps, runId: string, verdict: OwnerVerdict): void {
  const id = sanitizeInline(runId);
  if (verdict === 'run-gone') {
    deps.io.writeErr(
      `note: run ${id} is no longer in the history, so there is nothing more to follow.\n`,
    );
    return;
  }
  deps.io.writeErr(
    `note: no running process found for run ${id}; following stops.\n` +
      `\`relavium status ${id}\` shows where it stands.\n`,
  );
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
    // The log ends on a call that scans NOTHING past its cursor, never on a short page: the tail read stops at its
    // scan cap too (`MAX_RUN_TAIL_SCAN_ROWS`, PR #102 review), and a log whose rows are mostly a newer binary's
    // returns a short page, even an empty one, with readable rows still after it. The same rule `pageRunEvents` ends on.
    if (page.scannedThroughSeq <= scannedThroughSeq) return { events, skipped, scannedThroughSeq };
    scannedThroughSeq = page.scannedThroughSeq;
  }
}

/** What `--follow` has learned about the run's state from the events it has seen, in order. */
interface FollowState {
  readonly terminal: boolean;
  /** The run's latest `run:paused` named a gate and nothing has answered it since. */
  readonly parkedAtGate: boolean;
  /** An event that carries a failure has been seen: the failure view has something to show besides the close. */
  readonly sawFailure: boolean;
}

const QUIET_RUN: FollowState = { terminal: false, parkedAtGate: false, sawFailure: false };

function observeFollow(state: FollowState, event: RunEvent): FollowState {
  switch (event.type) {
    case 'node:failed':
    case 'node:retrying':
      return { ...state, sawFailure: true };
    case 'run:failed':
      return { ...state, terminal: true, sawFailure: true };
    case 'run:completed':
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
  return carriesFailure(event) || closesWithoutFailure(event);
}

/** An event that carries a failure: a node's, a node's retry, or the run's own. */
function carriesFailure(event: RunEvent): boolean {
  switch (event.type) {
    case 'node:failed':
    case 'node:retrying':
    case 'run:failed':
      return true;
    default:
      return false;
  }
}

/** A closing event that is not itself a failure: a failure view that ends on one has no failure to show. */
function closesWithoutFailure(event: RunEvent): boolean {
  return event.type === 'run:completed' || event.type === 'run:cancelled';
}

/**
 * The one line a failure view prints, before the closing event, when the run closed and nothing failed in it: a
 * header and a lone closing row would not say whether no failure happened or the view hid one. Human mode only,
 * since under `--json` stdout is the events and nothing else (the closing event is the answer).
 */
const NO_FAILURE_LINE = 'no failure events in this run.\n';

function writeNoFailureLine(deps: LogsCommandDeps): void {
  if (!deps.global.json) deps.io.writeOut(NO_FAILURE_LINE);
}

/** Whether a failure view of `events` closes with nothing to show but the close: the line above belongs to it. */
function closedWithoutFailure(events: readonly RunEvent[]): boolean {
  return events.some(closesWithoutFailure) && !events.some(carriesFailure);
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

/** One pending gate as the gate notice shows it: its title, any notes on it, and the commands that answer it. */
interface GateAnswer {
  readonly title: string;
  readonly notes: readonly string[];
  readonly commands: readonly string[];
}

/**
 * The lines that say a followed run is waiting and how to answer it. They are the ones `relavium status` prints for
 * a pending gate, the same helpers' text, with each command on its own indented row (a recorded id is a UUID, and a
 * line that joined the commands wrapped in the middle of one): the first gate's title (for a budget gate, its
 * allowance, then the excluded-candidate notes) and commands, and a count of the rest. Under `--json` it goes to
 * stderr, so stdout stays a pure `RunEvent` stream.
 */
function writeGateNotice(deps: LogsCommandDeps, reader: RunHistoryReader, runId: string): void {
  const id = sanitizeInline(runId);
  const gates = readPerRunOrDegrade<readonly GateAnswer[]>([], () => {
    const pending = pendingGateDisplays(reader.loadRunEventLog(runId).events);
    return [
      ...pending.pendingBudgetGates.map(
        (gate): GateAnswer => ({
          title: `pending budget gate ${budgetIdentifier(gate.gateId)} at ${budgetIdentifier(gate.nodeId)} — ${budgetPromptLabel(gate.allowance)}`,
          notes: budgetPromptDetails(gate.allowance),
          commands: budgetResumeHints(runId, gate.gateId, gate.allowance),
        }),
      ),
      ...pending.pendingGates.map(
        (gate): GateAnswer => ({
          title: `pending gate ${gate.gateId} (${gate.gateType}) at ${gate.nodeId}`,
          notes: [],
          commands: humanGateResumeHints(runId, gate.gateId, gate.gateType),
        }),
      ),
    ];
  }).value;
  const [first, ...rest] = gates;
  const lines =
    first === undefined
      ? [`run ${id} is paused at a gate; \`relavium status ${id}\` shows how to answer it.`]
      : [
          `run ${id} is paused at a gate:`,
          `  ${first.title}`,
          ...first.notes.map((note) => `    ${note}`),
          ...first.commands.map((command) => `    ${command}`),
          ...(rest.length === 0
            ? []
            : [
                `  ${rest.length} more pending gate${rest.length === 1 ? '' : 's'}: \`relavium status ${id}\` lists ${rest.length === 1 ? 'it' : 'them'}`,
              ]),
        ];
  // Every line carries recorded text (an id, a node id, a note), so each gets the one-line floor before the write.
  const text = lines.map((line) => `${sanitizeInline(line)}\n`).join('');
  if (deps.global.json) deps.io.writeErr(text);
  else deps.io.writeOut(text);
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
  const count = failedOnly ? `${shown.length} of ${total}` : total;
  io.writeOut(`run ${sanitizeInline(run.id)} — ${sanitizeInline(run.status)} (${count})\n`);
  if (failedOnly && closedWithoutFailure(events)) io.writeOut(NO_FAILURE_LINE);
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
