/**
 * The Home's human-gate card
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4): what a run parked at a human gate
 * shows, and the only keys that answer it. Pure apart from the answer it hands to the run host: no ink, no clock of its own (both are
 * injected), nothing here reads a database.
 *
 * - **Chords only.** `Ctrl+Y` approves and `Ctrl+N` rejects, and only when the gate's own type accepts that decision
 *   (`decisionsForGateType`, carried on each gate): an `input` gate takes a typed value or a rejection, so `Ctrl+Y` there answers
 *   nothing. A bare letter, a pasted block, `Enter`, an arrow and a chord with `meta` answer nothing. `Esc` and `Ctrl+C` decide
 *   nothing either: they leave the card pending (`Esc` is the run view's key, `Ctrl+C` its interrupt ladder's) and neither can reject,
 *   because a rejection continues the run (the author routes on it).
 * - **The guards of the other native cards.** An affirmative chord passes dwell, quiet gap, typeahead and lockout (`createChordGuard`)
 *   and counts only while this exact frame is painted and measured (`painted`). So does a human gate's rejection, which continues the
 *   run; a budget abort is never delayed. The dwell restarts for every new frame: a different gate under the cursor, a re-read of the
 *   gates, an answer that moved the cursor. The lockout is the Home's one (`history`), shared with the consent card.
 * - **A cursor over the open gates.** With more than one, `↑`/`↓` move it and an answer applies to the gate under it only.
 * - **A budget gate is the same card with other words.** `Ctrl+Y` approves exactly the frozen allowance the log recorded (its structured
 *   field, never a figure read from text) and `Ctrl+N` aborts; an allowance that cannot be approved (unpriced, unrepresentable, legacy)
 *   accepts the abort only, so `Ctrl+Y` there answers nothing. The answer goes through the same guard, and the host re-checks the price
 *   before it claims the gate, leaving a moved price pending and abortable.
 * - **One answer in flight.** While an answer is out the card takes no other. A gate that is answered leaves the card at once, whatever
 *   the host says, so no key can answer it twice; what the host says (the leg started, the run's durable state, a refusal) is shown
 *   as the outcome. An overdue gate is the same: its deadline passing changes the words, never the keys.
 * - **Author text is behind a gutter.** A gate's message can interpolate model output. Each of its rows is drawn behind the host's
 *   `│ ` gutter, host glyphs and answer-chord tokens are removed from it, and it passes the untrusted-text floor, so nothing in it
 *   can look like the card's own rows or keys (ADR-0132's forged-legend rule).
 */

import type { GateDecision } from '@relavium/shared';

import { budgetApprovalDecision, budgetPromptDetails } from '../../gate/budget.js';
import { approvalDecision, rejectionDecision } from '../../gate/decision.js';
import { humanGateResumeHints } from '../../gate/pending.js';
import {
  isBudgetGate,
  type RunBudgetGate,
  type RunCardGate,
  type RunGate,
} from '../../home/run-gates.js';
import type { HostedLaunch, HostedResumeRequest, RunHost } from '../../home/run-host.js';
import { CliError } from '../../process/errors.js';
import { sanitizeInline, sanitizeUntrustedInline } from '../sanitize.js';
import type { ChatKey } from './chat-input.js';
import {
  createChordGuard,
  reduceChordKey,
  type ChordHistory,
  type ChordStamp,
} from './chord-guard.js';
import { formatCostUsd, type StatusColor } from './format.js';
import { homeFitsTerminal, tooSmallMessage } from './home-projection.js';
import type { NativePromptFlow } from './native-prompt-channel.js';
import type { ApprovalGuard } from './tool-review-model.js';
import { clipLine } from './sheet-frame.js';
import { wrapText } from './viewport.js';

// ---------------------------------------------------------------------------------------------------------------------
// The controller.
// ---------------------------------------------------------------------------------------------------------------------

/** Where the card is. */
export type RunCardPhase =
  /** Waiting for a chord, or for the person to leave. */
  | 'open'
  /** An answer is out: no other is taken until the host replies. */
  | 'answering'
  /** The host started the leg that carries the answer. */
  | 'answered'
  /** The host found nothing to answer: the gate was decided, or the run ended, and the notice says which. */
  | 'settled'
  /** No gate is open. */
  | 'empty';

/** One state of the card, as the view and the tests read it. Replaced, never mutated: its identity is the frame's. */
export interface RunCardSnapshot {
  readonly runId: string;
  /** The gates still open, in the order the log raised them (a run's human gates, then its budget gates). */
  readonly gates: readonly RunCardGate[];
  /** Which of them the next chord answers. */
  readonly cursor: number;
  readonly phase: RunCardPhase;
  /** The host's words for the last answer (an outcome or a refusal), or `undefined`. Plain text: the projection cleans it. */
  readonly notice: string | undefined;
  /** `notice` is a refusal: nothing was answered and the gate is still open. */
  readonly refused: boolean;
}

/** What one key did, for the host that routed it. Nothing here is the answer itself: that goes to `resume`. */
export type RunCardKeyOutcome =
  /** The key meant nothing to the card: it is typing, a paste, `Esc`, `Ctrl+C` or a chord the gate does not accept. */
  | { readonly kind: 'ignored' }
  /** The cursor moved. */
  | { readonly kind: 'moved' }
  /** A chord that a guard layer (or an unpainted frame) refused: an approval, or a human gate's rejection. The gate is untouched. */
  | { readonly kind: 'refused' }
  /** An answer was sent for this gate. */
  | { readonly kind: 'answered'; readonly gateId: string; readonly decision: GateDecision };

export interface RunCardDeps {
  readonly runId: string;
  readonly gates: readonly RunCardGate[];
  /** Answer one gate: the run host's `resume`, with the native flow around it (see {@link createGateResumer}). */
  readonly resume: (request: Omit<HostedResumeRequest, 'secrets'>) => Promise<HostedLaunch>;
  /** The monotonic clock the guard runs on (default `performance.now`). */
  readonly now?: () => number;
  /** The guard's numbers (default the product's own); `0` switches a layer off. */
  readonly guard?: ApprovalGuard | undefined;
  /**
   * The Home's one chord history (`createChordHistory`), shared with the MCP consent card and the exit guard: an answer on this card
   * stamps the same lockout the next card reads, so a key held down through an answer cannot answer what the answer opens. Default:
   * this card's own (a card that stands alone).
   */
  readonly history?: ChordHistory | undefined;
  /**
   * Whether this exact snapshot is on screen right now, measured and flushed at 80×24. The default is `false`: a host that has not
   * said so can never approve anything.
   */
  readonly painted?: (snapshot: RunCardSnapshot) => boolean;
}

export interface RunCard {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => RunCardSnapshot;
  /** One key from the host's one input owner. */
  readonly input: (input: string, key: ChatKey) => RunCardKeyOutcome;
  /** A bracketed paste: it answers nothing, and it counts as typing for the guard. */
  readonly paste: (text: string) => void;
  /** A key reached the host while this card's frame could not take it (not painted, or the terminal too small): typing, for the guard. */
  readonly unseenInput: () => void;
  /** The host measured and flushed this exact snapshot as a new frame: the dwell counts from here. */
  readonly shown: (snapshot: RunCardSnapshot) => void;
  /** The run's gates, read again: the cursor stays on its gate when that is still open. */
  readonly update: (gates: readonly RunCardGate[]) => void;
  readonly dispose: () => void;
}

/** The host's words, through the untrusted-text floor: a refusal can quote a message the run core composed from stored text. */
function plain(message: string): string {
  return sanitizeUntrustedInline(message);
}

/**
 * The decision a chord means for a gate, or `undefined` when the gate does not accept it. A budget approval is built from the gate's own
 * structured allowance and from nothing else: with no priced amount there is nothing to approve, whatever `accepts` says.
 */
function decisionFor(chord: 'allow' | 'deny', gate: RunCardGate): GateDecision | undefined {
  const kind = chord === 'allow' ? 'approved' : 'rejected';
  if (!gate.accepts.includes(kind)) return undefined;
  if (kind === 'rejected') return rejectionDecision();
  if (!isBudgetGate(gate)) return approvalDecision();
  return gate.allowance.kind === 'amount'
    ? budgetApprovalDecision(gate.allowance.microcents)
    : undefined;
}

/** Where the cursor lands in `gates` after a re-read: on `gateId` when it is still there, else clamped. */
function cursorAfter(
  gates: readonly RunCardGate[],
  gateId: string | undefined,
  previous: number,
): number {
  const kept = gateId === undefined ? -1 : gates.findIndex((gate) => gate.gateId === gateId);
  return kept >= 0 ? kept : Math.max(0, Math.min(previous, gates.length - 1));
}

/** Two reads of one gate: the same id, node, deadline and what the card shows of it. */
function sameGate(a: RunCardGate, b: RunCardGate): boolean {
  if (a.gateId !== b.gateId || a.nodeId !== b.nodeId || a.expiresAt !== b.expiresAt) return false;
  if (isBudgetGate(a) || isBudgetGate(b))
    return (
      isBudgetGate(a) &&
      isBudgetGate(b) &&
      JSON.stringify(a.allowance) === JSON.stringify(b.allowance)
    );
  return (
    a.gateType === b.gateType && a.message === b.message && a.timeoutAction === b.timeoutAction
  );
}

/** Two reads of the same gates: a periodic re-read that found nothing new must not mint a new frame (and restart the dwell). */
function sameGates(a: readonly RunCardGate[], b: readonly RunCardGate[]): boolean {
  return (
    a.length === b.length &&
    a.every((gate, index) => {
      const other = b[index];
      return other !== undefined && sameGate(gate, other);
    })
  );
}

const SEND_FAILED: HostedLaunch = Object.freeze({
  kind: 'refused',
  reason: 'rejected',
  message: 'The answer could not be sent.',
});

export function createRunCard(deps: RunCardDeps): RunCard {
  const guard = createChordGuard({
    now: deps.now ?? (() => performance.now()),
    guard: deps.guard,
    history: deps.history,
  });
  const painted = deps.painted ?? (() => false);
  const listeners = new Set<() => void>();
  let disposed = false;
  let snapshot: RunCardSnapshot = Object.freeze({
    runId: deps.runId,
    gates: deps.gates,
    cursor: 0,
    phase: deps.gates.length === 0 ? 'empty' : 'open',
    notice: undefined,
    refused: false,
  });
  guard.begin();

  const publish = (next: Omit<RunCardSnapshot, 'runId'>): void => {
    snapshot = Object.freeze({ runId: deps.runId, ...next });
    for (const listener of listeners) listener();
  };
  const focused = (): RunCardGate | undefined => snapshot.gates[snapshot.cursor];

  /** The host refused: nothing was answered, so the gate is open again where it was, with the host's words. */
  const reopen = (before: RunCardSnapshot, gate: RunCardGate, message: string): void => {
    // A re-read that landed meanwhile saw the gate still pending (the answer had not been recorded): keep what it read.
    const gates = snapshot.gates.some((entry) => entry.gateId === gate.gateId)
      ? snapshot.gates
      : before.gates;
    guard.begin();
    publish({
      gates,
      cursor: Math.max(0, cursorAfter(gates, gate.gateId, before.cursor)),
      phase: 'open',
      notice: plain(message),
      refused: true,
    });
  };

  /** The host took the answer: the leg started, or there was nothing to answer and the host says what the log holds. */
  const accepted = (
    launch: Exclude<HostedLaunch, { kind: 'refused' }>,
    gate: RunCardGate,
  ): void => {
    const gates = snapshot.gates.filter((entry) => entry.gateId !== gate.gateId);
    guard.begin(); // whatever is under the cursor now is a new frame: its dwell starts when it is shown
    const base = { gates, cursor: cursorAfter(gates, undefined, 0), refused: false };
    if (launch.kind === 'settled') {
      // Nothing ran: the gate was decided, or the run ended, before this answer arrived. The gates that remain are still answerable.
      publish({
        ...base,
        phase: gates.length === 0 ? 'settled' : 'open',
        notice: plain(launch.message),
      });
      return;
    }
    publish({
      ...base,
      phase: 'answered',
      notice: 'Answered. The run continues in the background.',
    });
  };

  const send = (gate: RunCardGate, decision: GateDecision): void => {
    // The gate leaves the card the moment it is answered: from here no key can answer it a second time, whatever the host replies.
    const before = snapshot;
    publish({
      gates: before.gates.filter((entry) => entry.gateId !== gate.gateId),
      cursor: 0,
      phase: 'answering',
      notice: undefined,
      refused: false,
    });
    let reply: Promise<HostedLaunch>;
    try {
      reply = deps.resume({
        runId: gate.runId,
        gate: gate.gateId,
        kind: isBudgetGate(gate) ? 'budget' : 'human',
        decision,
      });
    } catch {
      reply = Promise.resolve(SEND_FAILED);
    }
    void reply
      .catch((): HostedLaunch => SEND_FAILED)
      .then((launch) => {
        if (disposed) return;
        if (launch.kind === 'refused') reopen(before, gate, launch.message);
        else accepted(launch, gate);
      });
  };

  const move = (delta: 1 | -1, stamp: ChordStamp): RunCardKeyOutcome => {
    guard.foreign(stamp);
    const count = snapshot.gates.length;
    if (count < 2) return { kind: 'ignored' };
    guard.begin(); // a different gate under the cursor is a new frame
    publish({ ...snapshot, cursor: (snapshot.cursor + delta + count) % count });
    return { kind: 'moved' };
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    input: (input, key) => {
      const stamp = guard.stamp();
      const gate = focused();
      if (snapshot.phase !== 'open' || gate === undefined) {
        guard.foreign(stamp);
        return { kind: 'ignored' };
      }
      // `Esc` and `Ctrl+C` are the view's keys and decide nothing here.
      if (key.escape === true || (key.ctrl === true && input.toLowerCase() === 'c')) {
        guard.foreign(stamp);
        return { kind: 'ignored' };
      }
      if (key.upArrow === true && key.ctrl !== true && key.meta !== true) return move(-1, stamp);
      if (key.downArrow === true && key.ctrl !== true && key.meta !== true) return move(1, stamp);
      const chord = reduceChordKey(input, key);
      const decision = chord === undefined ? undefined : decisionFor(chord, gate);
      if (chord === undefined || decision === undefined) {
        guard.foreign(stamp);
        return { kind: 'ignored' };
      }
      // A human gate's rejection continues the run (the author routes on it), so it passes every layer an approval does. A budget abort
      // stops the step at the budget, and refusing is the safe answer there: it is never delayed.
      const strict = chord === 'allow' || !isBudgetGate(gate);
      if (guard.decide(stamp, chord, painted(snapshot), strict) === undefined)
        return { kind: 'refused' };
      send(gate, decision);
      return { kind: 'answered', gateId: gate.gateId, decision };
    },
    paste: () => {
      guard.foreign(guard.stamp());
    },
    unseenInput: () => {
      guard.foreign(guard.stamp());
    },
    shown: (frame) => {
      if (frame === snapshot && snapshot.phase === 'open') guard.shown();
    },
    update: (gates) => {
      if (disposed) return;
      const under = focused()?.gateId;
      const cursor = cursorAfter(gates, under, snapshot.cursor);
      if (snapshot.phase === 'answering') {
        // The answer in flight settles the card; a re-read only refreshes what is still open.
        if (!sameGates(gates, snapshot.gates)) publish({ ...snapshot, gates, cursor });
        return;
      }
      if (gates.length === 0) {
        if (snapshot.phase === 'open') publish({ ...snapshot, gates, cursor: 0, phase: 'empty' });
        return;
      }
      if (snapshot.phase === 'open' && sameGates(gates, snapshot.gates)) return;
      if (snapshot.phase !== 'open' || gates[cursor]?.gateId !== under) guard.begin();
      publish({
        gates,
        cursor,
        phase: 'open',
        // What the last answer said belongs to the card it answered: it stays while the card stays open, and goes with a new one.
        notice: snapshot.phase === 'open' ? snapshot.notice : undefined,
        refused: snapshot.phase === 'open' && snapshot.refused,
      });
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The answer, with the native flow around it.
// ---------------------------------------------------------------------------------------------------------------------

type SlotFlow = Pick<NativePromptFlow, 'password'>;

/**
 * The values of a resumed run's masked slots, one native masked field per slot, in the order the run core names them. The value lives
 * in the prompt channel and in this call's result; nothing is kept. A field that is left (`Esc`, `Ctrl+C`) leaves the whole answer,
 * and the gate stays pending.
 */
export function createSlotSecretPort(
  flow: SlotFlow,
): (names: readonly string[]) => Promise<Readonly<Record<string, string>>> {
  return async (names) => {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [index, name] of names.entries()) {
      const answer = await flow.password({
        message: `Secret input ${String(index + 1)} of ${String(names.length)}: ${name}`,
        validate: (value) => (value.trim() === '' ? 'A secret input cannot be blank.' : undefined),
        escape: 'cancel',
      });
      if (typeof answer !== 'string')
        throw new CliError(
          'invalid_invocation',
          'The answer was cancelled. The gate is still pending.',
        );
      out[name] = answer;
    }
    return out;
  };
}

/**
 * `RunHost.resume` with the native flow around it. A resumed leg may need the Home's own prompts while it prepares (a masked slot,
 * and the MCP consent card for a local program this machine holds no grant for), and the channel answers only while a flow is open, so
 * this opens one for exactly that long: from the answer to the leg's start, never for the leg itself.
 *
 * With another prompt already open the flow cannot begin: that is a refusal ("busy"), not a queue.
 */
export function createGateResumer(deps: {
  readonly host: Pick<RunHost, 'resume'>;
  readonly flow: Pick<NativePromptFlow, 'begin' | 'end' | 'busy' | 'password'>;
}): (request: Omit<HostedResumeRequest, 'secrets'>) => Promise<HostedLaunch> {
  return async (request) => {
    try {
      deps.flow.begin();
    } catch {
      return {
        kind: 'refused',
        reason: 'busy',
        message: 'Another prompt is open. Finish it, then answer the gate.',
      };
    }
    try {
      deps.flow.busy('Answering the gate…');
      return await deps.host.resume({ ...request, secrets: createSlotSecretPort(deps.flow) });
    } finally {
      // Closing the flow never changes the answer already sent: a leg that started is a started leg, and an `end` that rejects (a picker
      // that did not drain, a renderer that went away) must not turn it into "The answer could not be sent." The fault is discarded here:
      // the flow's own owner reports what it needs to, and this port has nowhere else to put it.
      try {
        await deps.flow.end();
      } catch {
        // discarded on purpose, see above
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------------------------------------------------

/** How many rows of a gate's message the card shows. */
export const RUN_CARD_MESSAGE_ROWS = 4;
/** How many gates the list shows at once. */
export const RUN_CARD_LIST_ROWS = 4;
/** The host's gutter: every row of author text starts with it, so column 0 belongs to the host. */
export const RUN_CARD_GUTTER = '│ ';

/** The card's states, each with a glyph and a word (colour only reinforces them). */
export type RunCardState =
  | 'waiting'
  | 'overdue'
  | 'answering'
  | 'answered'
  | 'decided'
  | 'not-answered'
  | 'none';

interface Appearance {
  readonly glyph: string;
  readonly word: string;
  readonly tone: StatusColor;
}

export const RUN_CARD_APPEARANCE: Readonly<Record<RunCardState, Appearance>> = {
  waiting: { glyph: '‖', word: 'waiting for you', tone: 'yellow' },
  overdue: { glyph: '⚠', word: 'overdue', tone: 'red' },
  answering: { glyph: '◌', word: 'answering', tone: 'cyan' },
  answered: { glyph: '✓', word: 'answered', tone: 'green' },
  decided: { glyph: '○', word: 'already decided', tone: 'gray' },
  'not-answered': { glyph: '✗', word: 'not answered', tone: 'red' },
  none: { glyph: '○', word: 'no open gate', tone: 'gray' },
};

export type RunCardRole =
  | 'title'
  | 'author'
  | 'fact'
  /** The frozen allowance of a budget gate: the one figure the card is about. */
  | 'amount'
  | 'warn'
  | 'note'
  | 'list'
  | 'cursor'
  | 'keys';

export interface RunCardRow {
  readonly text: string;
  readonly role: RunCardRole;
}

export interface RunCardProjection {
  /** `false` below 80×24: only `tooSmall` and `keys` are shown, and no key answers. */
  readonly fits: boolean;
  readonly tooSmall: string | undefined;
  readonly state: RunCardState;
  readonly glyph: string;
  readonly word: string;
  readonly tone: StatusColor;
  readonly rows: readonly RunCardRow[];
  /** The gate under the cursor is overdue. */
  readonly overdue: boolean;
}

export interface RunCardProjectionInput {
  readonly columns: number;
  readonly rows: number;
  /** Wall-clock milliseconds, for the deadline: the only clock the projection reads. */
  readonly nowMs: number;
}

/** Host glyphs and card-drawing characters, none of which an author's text may carry (`HOST_GLYPH` of the ask-user tool, widened). */
const HOST_GLYPHS = /[›✎█▸●○✓✗▶‖⊘⚠◌■◆─-╿]/gu;
/** An answer-chord token: `Ctrl+Y`, `control-n`, `^Y`. */
const CHORD_TOKENS = /\b(?:ctrl|control)\s*[+-]\s*[a-z]\b|(?<![\w^])\^[a-z]\b/giu;

/** One line of author text, safe to put behind the gutter: untrusted-text floor, no host glyph, no answer chord. */
function authorLine(text: string): string {
  return sanitizeUntrustedInline(text).replace(HOST_GLYPHS, ' ').replace(CHORD_TOKENS, '[chord]');
}

/** The author's message as at most {@link RUN_CARD_MESSAGE_ROWS} rows of `width` columns, each a row of author text. */
function messageRows(message: string, width: number): readonly string[] {
  const rows = message
    .split('\n')
    .flatMap((line) => wrapText(authorLine(line), width))
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (rows.length <= RUN_CARD_MESSAGE_ROWS) return rows;
  const kept = rows.slice(0, RUN_CARD_MESSAGE_ROWS);
  kept[RUN_CARD_MESSAGE_ROWS - 1] = clipLine(`${kept[RUN_CARD_MESSAGE_ROWS - 1] ?? ''}…`, width);
  return kept;
}

/** The instant the deadline passes, or `undefined` for a gate with none (or one that does not parse). */
function deadline(gate: RunCardGate): number | undefined {
  if (gate.expiresAt === undefined) return undefined;
  const at = Date.parse(gate.expiresAt);
  return Number.isFinite(at) ? at : undefined;
}

export function isGateOverdue(gate: RunCardGate, nowMs: number): boolean {
  const at = deadline(gate);
  return at !== undefined && nowMs >= at;
}

function stateOf(
  snapshot: RunCardSnapshot,
  gate: RunCardGate | undefined,
  nowMs: number,
): RunCardState {
  switch (snapshot.phase) {
    case 'answering':
      return 'answering';
    case 'answered':
      return 'answered';
    case 'settled':
      return 'decided';
    case 'empty':
      return 'none';
    case 'open':
      if (snapshot.refused) return 'not-answered';
      return gate !== undefined && isGateOverdue(gate, nowMs) ? 'overdue' : 'waiting';
  }
}

function policyWords(gate: RunGate): string {
  if (gate.timeoutAction === 'approve') return 'On timeout: the gate is approved.';
  if (gate.timeoutAction === 'reject') return 'On timeout: the run fails (run_timeout).';
  return 'No timeout policy was recorded for it.';
}

/** The keys the open card offers, in the legend's grammar. Only what the gate accepts, and only host text. */
function keysFor(snapshot: RunCardSnapshot, gate: RunCardGate | undefined): string {
  switch (snapshot.phase) {
    case 'answering':
      return 'Answering… · Esc leaves the view';
    case 'answered':
    case 'settled':
    case 'empty':
      return 'Esc closes';
    case 'open': {
      const parts: string[] = [];
      if (snapshot.gates.length > 1) parts.push('↑/↓ choose a gate');
      // A budget gate's `Ctrl+N` aborts the run's step at the budget; the allowance Ctrl+Y funds is the card's own row, not the legend's.
      const budget = gate !== undefined && isBudgetGate(gate);
      if (gate?.accepts.includes('approved') === true) parts.push('Ctrl+Y approves');
      if (gate?.accepts.includes('rejected') === true)
        parts.push(budget ? 'Ctrl+N aborts' : 'Ctrl+N rejects');
      parts.push('Esc leaves it pending');
      return parts.join(' · ');
    }
  }
}

function gateKind(gate: RunCardGate): string {
  return isBudgetGate(gate) ? 'budget' : sanitizeInline(gate.gateType);
}

/** What an overdue gate adds: when it passed, what the engine does at the deadline (a human gate's policy), and that the answer counts. */
function overdueRows(gate: RunCardGate, width: number): readonly RunCardRow[] {
  const rows: RunCardRow[] = [
    {
      role: 'warn',
      text: clipLine(`Overdue since ${sanitizeInline(gate.expiresAt ?? '')}.`, width),
    },
  ];
  if (!isBudgetGate(gate)) rows.push({ role: 'warn', text: clipLine(policyWords(gate), width) });
  rows.push({
    role: 'fact',
    text: clipLine(
      'Your answer is still taken; if another process settled it first, this says so.',
      width,
    ),
  });
  return rows;
}

/** What a human gate's keys do: a rejection continues the run, and an `input` gate takes a typed value this card does not. */
function humanGateNotes(gate: RunGate, width: number): readonly RunCardRow[] {
  if (gate.accepts.includes('approved'))
    return [
      {
        role: 'fact',
        text: clipLine(
          'Rejecting does not stop the run: the workflow routes on a rejection.',
          width,
        ),
      },
    ];
  // An input gate takes a typed value, which this card does not: say where the answer goes instead of offering a key for it.
  const hint = humanGateResumeHints(gate.runId, gate.gateId, gate.gateType)[0];
  return [
    {
      role: 'fact',
      text: clipLine(
        `This gate takes a typed value, which this card cannot take.${hint === undefined ? '' : ` ${hint}`}`,
        width,
      ),
    },
  ];
}

/** How many excluded-candidate notices a budget card shows; the rest are counted. */
export const RUN_CARD_EXCLUDED_ROWS = 3;

/** The words for an allowance that cannot be approved. */
function abortOnlyWords(
  allowance: Exclude<RunBudgetGate['allowance'], { kind: 'amount' }>,
): string {
  if (allowance.kind === 'legacy')
    return 'This legacy budget gate has no frozen allowance, so it can only be aborted here.';
  return allowance.reason === 'unpriced'
    ? 'This execution has no priced allowance, so it can only be aborted.'
    : 'This execution allowance cannot be represented safely, so it can only be aborted.';
}

/**
 * What a budget gate shows ([ADR-0097](../../../../../docs/decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md),
 * ADR-0139 §4): the frozen allowance from the gate's structured field and nothing else (no figure is read from a message, a node name or
 * an excluded notice), what approving it funds, the excluded candidates behind the gutter, and what aborting does. An allowance that
 * cannot be approved says so instead of showing an amount.
 */
function budgetRows(gate: RunBudgetGate, width: number): readonly RunCardRow[] {
  const allowance = gate.allowance;
  const rows: RunCardRow[] = [];
  if (allowance.kind === 'amount') {
    rows.push(
      {
        role: 'amount',
        text: clipLine(
          `Frozen allowance: ${formatCostUsd(allowance.microcents)} (${String(allowance.microcents)} microcents)`,
          width,
        ),
      },
      {
        role: 'fact',
        text: clipLine('Approval funds this agent execution only, for exactly this amount.', width),
      },
    );
  } else {
    rows.push({ role: 'warn', text: clipLine(abortOnlyWords(allowance), width) });
  }
  const excluded = budgetPromptDetails(allowance);
  for (const line of excluded.slice(0, RUN_CARD_EXCLUDED_ROWS))
    rows.push({
      role: 'author',
      text: clipLine(`${RUN_CARD_GUTTER}${authorLine(line)}`, width),
    });
  if (excluded.length > RUN_CARD_EXCLUDED_ROWS)
    rows.push({
      role: 'fact',
      text: clipLine(
        `${RUN_CARD_GUTTER}… ${String(excluded.length - RUN_CARD_EXCLUDED_ROWS)} more excluded`,
        width,
      ),
    });
  rows.push({
    role: 'fact',
    text: clipLine('Aborting dispatches no agent and fails the run (budget_exceeded).', width),
  });
  return rows;
}

/** The facts under the author's message: where the gate sits, its deadline, and what an answer does. */
function gateFacts(gate: RunCardGate, width: number, overdue: boolean): readonly RunCardRow[] {
  const rows: RunCardRow[] = [
    {
      role: 'fact',
      text: clipLine(
        `node ${sanitizeInline(gate.nodeId)} · ${gateKind(gate)} gate` +
          (gate.expiresAt === undefined || overdue
            ? ''
            : ` · expires ${sanitizeInline(gate.expiresAt)}`),
        width,
      ),
    },
  ];
  if (overdue) rows.push(...overdueRows(gate, width));
  rows.push(...(isBudgetGate(gate) ? budgetRows(gate, width) : humanGateNotes(gate, width)));
  return rows;
}

function listRows(snapshot: RunCardSnapshot, width: number): readonly RunCardRow[] {
  const count = snapshot.gates.length;
  if (count < 2) return [];
  const first = Math.max(
    0,
    Math.min(snapshot.cursor - Math.floor(RUN_CARD_LIST_ROWS / 2), count - RUN_CARD_LIST_ROWS),
  );
  const window = snapshot.gates.slice(first, first + RUN_CARD_LIST_ROWS);
  const rows: RunCardRow[] = window.map((gate, index): RunCardRow => {
    const at = first + index;
    const here = at === snapshot.cursor;
    return {
      role: here ? 'cursor' : 'list',
      text: clipLine(
        `${here ? '▸' : ' '} ${sanitizeInline(gate.gateId)} · ${gateKind(gate)} · node ${sanitizeInline(gate.nodeId)}`,
        width,
      ),
    };
  });
  if (count > window.length)
    rows.push({ role: 'list', text: clipLine(`  … ${String(count)} gates open`, width) });
  return rows;
}

/**
 * The card as the terminal shows it. Pure: the same snapshot, size and time are always the same rows. Below 80×24 it is the enlarge
 * line and the key line only, and the view takes no key as an answer.
 */
export function projectRunCard(
  snapshot: RunCardSnapshot,
  input: RunCardProjectionInput,
): RunCardProjection {
  const gate = snapshot.gates[snapshot.cursor];
  const fits = homeFitsTerminal(input.columns, input.rows);
  const state = stateOf(snapshot, gate, input.nowMs);
  const appearance = RUN_CARD_APPEARANCE[state];
  const overdue = state === 'overdue';
  const width = Math.max(1, Math.floor(input.columns) - 2);
  const keys: RunCardRow = { role: 'keys', text: clipLine(keysFor(snapshot, gate), width) };
  if (!fits) {
    return {
      fits,
      tooSmall: tooSmallMessage(input.columns, input.rows),
      state,
      ...appearance,
      rows: [keys],
      overdue,
    };
  }
  const place =
    snapshot.gates.length > 1
      ? `  ·  gate ${String(snapshot.cursor + 1)} of ${String(snapshot.gates.length)}`
      : '';
  const rows: RunCardRow[] = [
    {
      role: 'title',
      text: clipLine(
        `${appearance.glyph} ${appearance.word}${place}  ·  run ${sanitizeInline(snapshot.runId)}`,
        width,
      ),
    },
  ];
  if (snapshot.phase === 'open' && gate !== undefined) {
    const gutter = RUN_CARD_GUTTER;
    // A budget gate has no author text: what it shows is the host's own words and the structured allowance.
    if (!isBudgetGate(gate))
      for (const line of messageRows(gate.message, Math.max(1, width - gutter.length)))
        rows.push({ role: 'author', text: `${gutter}${line}` });
    rows.push(...gateFacts(gate, width, overdue));
    rows.push(...listRows(snapshot, width));
  }
  if (snapshot.notice !== undefined)
    rows.push(
      ...wrapText(sanitizeInline(snapshot.notice), width)
        .slice(0, 2)
        .map((text): RunCardRow => ({ role: 'note', text: clipLine(text, width) })),
    );
  rows.push(keys);
  return { fits, tooSmall: undefined, state, ...appearance, rows, overdue };
}
