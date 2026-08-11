/**
 * The durable-truth oracle (`CR-91`) — does a run's LIVE answer survive a restart?
 *
 * The e2e harness could already prove that a run streamed a terminal and that the terminal said what the test
 * expected. That is one view, taken in-process, while the engine that produced it is still alive. It cannot
 * catch the failure class phase 2.6.5 exists for: a caller receives `run:completed` with outputs while the
 * durable log says the run failed, or a restart reconciles the same run to a DIFFERENT terminal, or a resume
 * re-runs work the log already records as done. Every one of those is invisible to a live assertion.
 *
 * So this compares several views of the same run and reports where they disagree:
 *
 * 1. **live** — the terminal the caller drained from `RunHandle.events`.
 * 2. **history** — the terminal as it exists in the store, read back.
 * 3. **after reconcile** — the history a *fresh* engine leaves behind after `reconcile()` on restart.
 * 4. **checkpoint** — the status `reconstructCheckpointState` derives from the durable log alone. A resume
 *    seeds itself from this, so if it disagrees with the terminal, a resumed run does the wrong work.
 * 5. **the durable prefix itself** — sequence numbers gap-free and ordered, exactly one terminal, and the
 *    terminal last. Not a "view" of the terminal, but the property every other view silently assumes.
 *
 * They are four PROJECTIONS of two sources (the live stream and the store), not four independent
 * observations — worth saying because an earlier version of this docblock called them independent, and in an
 * in-memory harness views 1 and 2 are literally the same object.
 *
 * **What it CAN and CANNOT instrument, stated because the phase doc once claimed more.** It expresses
 * `CR-92` (terminal durable truth) and `CR-10` (the durable log is an ordered, gap-free prefix). It does NOT
 * express `CR-11` — it has no concept of run ownership or a fencing token — and it does NOT express `CR-12`,
 * which is about external effects and needs an effect-journal view plus a side-effect counter this module
 * does not model. Those two need their own predicates; this one is not the instrument for them.
 *
 * It also does not yet cover the RESUME view that `CR-91`'s acceptance criterion names. View 4 folds the log
 * locally, which is close but not the same thing: a real resume goes through the host's `Checkpointer`, and
 * the CLI's implementation uses ADR-0075's STRICT read that refuses a log with an uninterpretable row. A
 * resume that would refuse therefore reads here as a clean fold. `loadCheckpoint` exists so a caller can
 * supply the real port; when it is absent the verdict says the fold was local.
 *
 * **It returns a verdict rather than throwing.** A thrower is hard to test and forces every caller into the
 * same message; a structured verdict lets callers assert on the specific disagreement, and lets this module
 * have its own tests. {@link formatDurableTruth} renders it when a caller just wants a readable diff.
 */

import type { RunEvent, RunStatus } from '@relavium/shared';

import { reconstructCheckpointState } from './checkpoint.js';

/** The run terminals. Exactly one closes a run (ADR-0036); the oracle's whole job is to check they agree. */
const TERMINALS = new Set<RunEvent['type']>(['run:completed', 'run:failed', 'run:cancelled']);

/** The run status each terminal implies — the checkpoint fold must arrive at the same one. */
const STATUS_FOR: Partial<Record<RunEvent['type'], RunStatus>> = {
  'run:completed': 'completed',
  'run:failed': 'failed',
  'run:cancelled': 'cancelled',
};

/**
 * A terminal reduced to what must agree across views: its type, and the payload a consumer acts on.
 *
 * Deliberately NOT the whole event. `timestamp` and `sequenceNumber` are envelope fields the bus stamps, and
 * comparing them would make every restart look like a disagreement while catching nothing — the failure this
 * oracle is for is a terminal whose TYPE or OUTPUT changed, not one whose clock moved.
 */
export interface TerminalView {
  readonly type: RunEvent['type'];
  /** `run:completed.outputs` / `run:failed.partialOutputs`, canonically stringified. `run:cancelled` has none. */
  readonly outputs?: string;
  /** `run:failed.error.code`, when the terminal carries one. */
  readonly errorCode?: string;
  /**
   * The rest of `run:failed.error`'s identity. Dropped in the first version, and the omission let a real
   * defect through: a live `{tool_failed, nodeId:'A', retryable:false}` compared equal to a durable
   * `{tool_failed, nodeId:'B', retryable:true}`. A flipped `retryable` changes whether a surface offers a
   * retry, and `nodeId` names the root cause.
   */
  readonly errorRetryable?: boolean;
  readonly errorNodeId?: string;
  /**
   * The secret-free id joined to the internal log (ADR-0036) — the single best discriminator here, because it
   * identifies THIS terminal event. It differs across views only when the terminal was genuinely rewritten,
   * which is exactly the defect.
   */
  readonly correlationId?: string;
  /** The run-wide realized total the terminal reports, when it carries one. */
  readonly costMicrocents?: number;
  /** `run:completed.totalTokensUsed`, restored by the same fold as cost — comparing one and not the other
   *  was an inconsistency, not a decision. */
  readonly tokens?: string;
}

export interface DurableTruthVerdict {
  readonly agrees: boolean;
  readonly runId: string;
  readonly live: TerminalView | undefined;
  readonly history: TerminalView | undefined;
  readonly afterReconcile: TerminalView | undefined;
  readonly checkpointStatus: RunStatus | undefined;
  /**
   * Where {@link checkpointStatus} came from. `'local-fold'` means this module folded the log itself, which
   * is NOT the resume path — a real resume goes through the host's `Checkpointer` and may refuse a log this
   * fold reads happily (ADR-0075). Supply `loadCheckpoint` to get `'checkpointer'`.
   */
  readonly checkpointSource: 'local-fold' | 'checkpointer';
  /** How many terminals the durable log holds. Anything but 1 breaks exactly-one-terminal (ADR-0036). */
  readonly durableTerminalCount: number;
  /** Events `reconcile()` produced FOR THIS RUN — it repairs every interrupted run and returns them all. */
  readonly reconciledCount: number;
  /** One sentence per disagreement, in the order checked. Empty iff `agrees`. */
  readonly disagreements: readonly string[];
}

/**
 * Stringify a payload for comparison, key-order-insensitively and WITHOUT ever throwing out of the oracle.
 *
 * A bare `JSON.stringify` fails twice: `{a:1,b:2}` and `{b:2,a:1}` compare unequal, which is a false failure
 * the moment either side has been through a store round-trip — the whole point of this module; and a circular
 * or `bigint` payload throws, turning the instrument itself into the failure with no verdict at all.
 */
function canonical(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val: unknown): unknown => {
      if (typeof val === 'bigint') return `${val.toString()}n`;
      if (typeof val !== 'object' || val === null || Array.isArray(val)) return val;
      // Codepoint order, NOT `localeCompare` — the comparison must be identical on every machine that runs
      // this oracle. `localeCompare` honours the host locale (and its ICU build), so two runs of the same
      // payload can canonicalize to different strings under different `LC_ALL`s, which is a disagreement
      // manufactured by the instrument. The order itself is arbitrary; only its stability matters.
      return Object.fromEntries(
        Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    });
  } catch (error) {
    // A true cycle (or any other unserializable payload) becomes a single marker rather than escaping. The
    // first version tried to be cleverer, with a `WeakSet` marking objects it had already visited — and got
    // it WRONG in a way that caused the very failure this function exists to prevent: the set was never
    // un-marked on the way back up, so it flagged every REPEATED reference, not every circular one.
    // `{ a: shared, b: shared }` serialized as `{"a":{…},"b":"[circular]"}` while a structurally identical
    // payload built from two separate objects serialized normally — so two equal outputs disagreed. A
    // `fan_in` echoing one value into two keys is enough to hit it. Native `JSON.stringify` already tracks
    // the ANCESTRY correctly; letting it throw and catching here is both simpler and right.
    return `[uncomparable: ${error instanceof Error ? error.name : 'unknown'}]`;
  }
}

function viewOf(event: RunEvent | undefined): TerminalView | undefined {
  if (event === undefined) return undefined;
  switch (event.type) {
    case 'run:completed':
      return {
        type: event.type,
        outputs: canonical(event.outputs),
        costMicrocents: event.totalCostMicrocents,
        tokens: canonical(event.totalTokensUsed),
      };
    case 'run:failed':
      return {
        type: event.type,
        outputs: canonical(event.partialOutputs),
        errorCode: event.error.code,
        errorRetryable: event.error.retryable,
        ...(event.error.nodeId === undefined ? {} : { errorNodeId: event.error.nodeId }),
        ...(event.error.correlationId === undefined
          ? {}
          : { correlationId: event.error.correlationId }),
        ...(event.cumulativeCostMicrocents === undefined
          ? {}
          : { costMicrocents: event.cumulativeCostMicrocents }),
      };
    case 'run:cancelled':
      return {
        type: event.type,
        ...(event.cumulativeCostMicrocents === undefined
          ? {}
          : { costMicrocents: event.cumulativeCostMicrocents }),
      };
    default:
      return undefined;
  }
}

/**
 * The LAST terminal, not the first.
 *
 * A duplicated log is caught by the count check either way, but `find` made two views disagree by
 * construction: `reconstructCheckpointState` folds run status last-wins, so view 4 read the last terminal
 * while views 2 and 3 read the first. Taking the last aligns them and leaves duplication to the count.
 */
function terminalIn(events: readonly RunEvent[]): RunEvent | undefined {
  return [...events].reverse().find((event) => TERMINALS.has(event.type));
}

function describe(view: TerminalView | undefined): string {
  if (view === undefined) return 'none';
  // EVERY compared field, not a subset. The first version rendered only type/code/cost/outputs — so a pair
  // differing solely in `errorRetryable` or `correlationId` printed BYTE-IDENTICALLY on both sides of a
  // `DISAGREES` verdict, leaving a reader with no visible reason for exactly the fields that matter most.
  const parts: string[] = [view.type];
  if (view.errorCode !== undefined) parts.push(`code=${view.errorCode}`);
  if (view.errorRetryable !== undefined) parts.push(`retryable=${String(view.errorRetryable)}`);
  if (view.errorNodeId !== undefined) parts.push(`node=${view.errorNodeId}`);
  if (view.correlationId !== undefined) parts.push(`correlationId=${view.correlationId}`);
  if (view.costMicrocents !== undefined) parts.push(`cost=${view.costMicrocents}`);
  if (view.tokens !== undefined) parts.push(`tokens=${view.tokens}`);
  if (view.outputs !== undefined) parts.push(`outputs=${view.outputs}`);
  return parts.join(' ');
}

function sameView(a: TerminalView | undefined, b: TerminalView | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.type === b.type &&
    a.outputs === b.outputs &&
    a.errorCode === b.errorCode &&
    a.errorRetryable === b.errorRetryable &&
    a.errorNodeId === b.errorNodeId &&
    a.correlationId === b.correlationId &&
    a.costMicrocents === b.costMicrocents &&
    a.tokens === b.tokens
  );
}

export interface DurableTruthInput {
  readonly runId: string;
  /** The terminal the caller drained from the live stream, or `undefined` if the stream produced none. */
  readonly live: RunEvent | undefined;
  /** Read the run's persisted events — the same store the run was executed against. */
  readonly eventsFor: (runId: string) => readonly RunEvent[] | Promise<readonly RunEvent[]>;
  /**
   * Run `reconcile()` as a FRESH engine over that same store, exactly as a restarted process would. Omit only
   * when the caller has already restarted for its own reasons; then view 3 is skipped and the verdict says so.
   */
  readonly reconcile?: () => Promise<readonly RunEvent[]>;
  /**
   * The host's real `Checkpointer.load` — what a resume actually goes through. Supply it and view 4 observes
   * the resume path (including ADR-0075's strict read, which REFUSES a log with an uninterpretable row);
   * omit it and the verdict folds the log locally and records that it did.
   */
  readonly loadCheckpoint?: (runId: string) => Promise<{ runStatus: RunStatus } | undefined>;
  /**
   * What the run is expected to look like on disk, and it changes what counts as a disagreement.
   *
   * - `'settled'` (default): the run closed under its own power. `reconcile()` must find nothing to do, and a
   *   changed terminal is a defect.
   * - `'repaired'`: the run DIED without a terminal and a restart is expected to write one. Then a durable
   *   terminal appearing where there was none is the PASS condition, not a failure.
   *
   * Without this, a correct crash repair — the exact scenario this phase exists for — reported as
   * `a restart CHANGED the terminal: before=none after=run:failed`, so no crash test could use the oracle.
   */
  readonly expect?: 'settled' | 'repaired';
}

/**
 * Bind everything to THIS run before comparing anything. Without it the oracle happily reports agreement on
 * another run's log — measured — and `durableTerminalCount === 1` does not catch it, because the other run
 * has a terminal too. A store that ignores its id argument, or a caller that crosses two runs, both land
 * here; and `CR-11`'s whole scenario is two owners over one store.
 */
function checkRunBinding(
  runId: string,
  live: RunEvent | undefined,
  before: readonly RunEvent[],
): readonly string[] {
  const out: string[] = [];
  const foreign = before.filter((event) => event.runId !== runId);
  if (foreign.length > 0) {
    out.push(
      `eventsFor(${runId}) returned ${foreign.length} event(s) belonging to another run ` +
        `(e.g. ${String(foreign[0]?.runId)}) — every view below would be comparing the wrong log`,
    );
  }
  if (live !== undefined && live.runId !== runId) {
    out.push(`the live terminal carries runId ${live.runId}, not ${runId}`);
  }
  return out;
}

function checkLiveVsHistory(
  expectRepaired: boolean,
  live: TerminalView | undefined,
  history: TerminalView | undefined,
): readonly string[] {
  const out: string[] = [];
  if (expectRepaired) {
    // A run that died mid-flight: nothing durable yet, and nothing live either.
    if (history !== undefined) {
      out.push(
        `expected a run needing repair, but the log already holds a terminal (${describe(history)})`,
      );
    }
    if (live !== undefined) {
      out.push(
        `expected a run that died without a terminal, but the live stream produced ${describe(live)}`,
      );
    }
  } else if (!sameView(live, history)) {
    out.push(
      `live and durable history disagree: live=${describe(live)} history=${describe(history)}`,
    );
  }
  return out;
}

function checkReconcileOutcome(
  expectRepaired: boolean,
  history: TerminalView | undefined,
  afterReconcile: TerminalView | undefined,
  reconciledCount: number,
): readonly string[] {
  const out: string[] = [];
  if (expectRepaired) {
    if (afterReconcile === undefined) {
      out.push(
        'a restart left the run with NO durable terminal — a crashed run must reconcile to one',
      );
    }
    if (reconciledCount === 0) {
      out.push('reconcile() produced no event for this run, so nothing repaired it');
    }
    return out;
  }
  if (!sameView(history, afterReconcile)) {
    out.push(
      `a restart CHANGED the terminal: before=${describe(history)} after=${describe(afterReconcile)}`,
    );
  }
  if (history !== undefined && reconciledCount > 0) {
    out.push(
      `reconcile() produced ${reconciledCount} event(s) for a run that already had a durable terminal ` +
        `(${describe(history)}) — reconciliation repairs a run that died WITHOUT one, never one that landed`,
    );
  }
  return out;
}

/**
 * Exactly-one-terminal (ADR-0036) plus the durable ORDER property (`CR-10`). Every view above assumes the
 * latter and none of them checked it: a log committed out of order, or with an event after its terminal, used
 * to verdict `agrees`.
 *
 * **What is checkable here, and what is NOT** — the distinction cost a wrong assertion, so it is written
 * down. The durable log's sequence numbers are a strictly increasing SUBSEQUENCE of the run's, never
 * `0..n-1`: streamed events (`agent:token`, `cost:updated`, …) take numbers and are deliberately never
 * persisted. A real completed run reads `[0,1,2,3,5,10,11,12,13,14]`, and asserting `0..n-1` failed it.
 *
 * So "no persisted event is missing from the middle" — CR-10's actual property — is NOT expressible from
 * the log alone: a streamed event's absence is indistinguishable from a lost one. CR-10's acceptance needs
 * a store harness that knows which events it was ASKED to persist. What the log can prove on its own is
 * that it starts at `run:started` (always seq 0, always durable) and only ever moves forward.
 */
function checkLogShape(ours: readonly RunEvent[], terminalCount: number): readonly string[] {
  const out: string[] = [];
  if (terminalCount !== 1) {
    out.push(
      `the durable log holds ${terminalCount} terminal(s); exactly one closes a run (ADR-0036)`,
    );
  }

  const seqs = ours.map((event) => event.sequenceNumber);
  if (seqs.some((seq, index) => index > 0 && seq <= (seqs[index - 1] ?? -1))) {
    out.push(
      `the durable log is not ordered: sequenceNumbers ${JSON.stringify(seqs)} — a higher seq committed ` +
        `before a lower one, so the checkpoint fold can read a state its causal predecessor never reached`,
    );
  }
  if (seqs.length > 0 && seqs[0] !== 0) {
    out.push(
      `the durable log starts at sequenceNumber ${String(seqs[0])}, not 0 — \`run:started\` is always ` +
        `persisted and always first, so the head of the log is missing`,
    );
  }
  const last = ours.at(-1);
  if (last !== undefined && terminalCount === 1 && !TERMINALS.has(last.type)) {
    out.push(
      `the durable log continues past its terminal (last event is '${last.type}') — exactly one terminal ` +
        `CLOSES a run, so nothing may follow it`,
    );
  }
  return out;
}

function checkCheckpoint(
  viaPort: boolean,
  checkpointStatus: RunStatus | undefined,
  afterReconcile: TerminalView | undefined,
): readonly string[] {
  const expectedStatus = afterReconcile === undefined ? undefined : STATUS_FOR[afterReconcile.type];
  if (expectedStatus === undefined || checkpointStatus === expectedStatus) return [];
  return [
    `the checkpoint ${viaPort ? 'port' : 'fold'} says ` +
      `'${String(checkpointStatus)}' while the durable terminal says '${expectedStatus}' — a resume seeds ` +
      `itself from it, so it would do the wrong work`,
  ];
}

/**
 * Compare the four views. Cheap enough to call at the end of every e2e run; it reads the log twice and runs
 * one reconcile.
 */
export async function checkDurableTruth(input: DurableTruthInput): Promise<DurableTruthVerdict> {
  const disagreements: string[] = [];
  const expectRepaired = input.expect === 'repaired';

  const before = [...(await input.eventsFor(input.runId))];
  disagreements.push(...checkRunBinding(input.runId, input.live, before));

  // EVERY view below reads the filtered log, not the raw one. Reporting the foreign events above and then
  // comparing against them anyway was the bug in the first version of this binding: a store that ignored its
  // id argument had `history` read ANOTHER run's terminal, and `durableTerminalCount` counted it — so the
  // verdict named the right cause while every downstream number described the wrong run.
  let ours = before.filter((event) => event.runId === input.runId);

  const live = viewOf(input.live);
  const history = viewOf(terminalIn(ours));
  disagreements.push(...checkLiveVsHistory(expectRepaired, live, history));

  let reconciledCount = 0;
  let afterReconcile = history;
  if (input.reconcile !== undefined) {
    const reconciled = await input.reconcile();
    // Per-RUN, not the whole array. `reconcile()` repairs every interrupted run in the store and returns all
    // of their events, so attributing the raw count to this run produced a factually wrong message and a
    // false failure the moment a second run existed — which is, again, `CR-11`'s exact shape.
    reconciledCount = reconciled.filter((event) => event.runId === input.runId).length;
    ours = [...(await input.eventsFor(input.runId))].filter((event) => event.runId === input.runId);
    afterReconcile = viewOf(terminalIn(ours));
    disagreements.push(
      ...checkReconcileOutcome(expectRepaired, history, afterReconcile, reconciledCount),
    );
  }

  const terminalCount = ours.filter((event) => TERMINALS.has(event.type)).length;
  disagreements.push(...checkLogShape(ours, terminalCount));

  const viaPort = input.loadCheckpoint !== undefined;
  const loaded = await input.loadCheckpoint?.(input.runId);
  const checkpointStatus = viaPort
    ? loaded?.runStatus
    : reconstructCheckpointState(ours)?.runStatus;
  disagreements.push(...checkCheckpoint(viaPort, checkpointStatus, afterReconcile));

  return {
    agrees: disagreements.length === 0,
    runId: input.runId,
    live,
    history,
    afterReconcile,
    checkpointStatus,
    checkpointSource: input.loadCheckpoint === undefined ? 'local-fold' : 'checkpointer',
    durableTerminalCount: terminalCount,
    reconciledCount,
    disagreements,
  };
}

/** Render a verdict for an assertion message — every view on its own line, so the diff reads at a glance. */
export function formatDurableTruth(verdict: DurableTruthVerdict): string {
  return [
    `durable truth for run ${verdict.runId}: ${verdict.agrees ? 'AGREES' : 'DISAGREES'}`,
    `  live            : ${describe(verdict.live)}`,
    `  history         : ${describe(verdict.history)}`,
    `  after reconcile : ${describe(verdict.afterReconcile)}`,
    `  checkpoint      : ${String(verdict.checkpointStatus)} (${verdict.checkpointSource})`,
    `  terminals in log: ${verdict.durableTerminalCount}`,
    ...verdict.disagreements.map((d) => `  ✖ ${d}`),
  ].join('\n');
}
