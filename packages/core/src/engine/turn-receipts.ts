/**
 * Content-free tool receipts ([ADR-0128](../../../../docs/decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md)).
 *
 * A receipt is what a later request may say about an earlier completed turn's tool calls: a label from the
 * code-owned built-in catalog (or the fixed `other_tool`) and one of the four recorded outcomes. Nothing else
 * survives — no argument, result, path, stored id, byte size or free-form name — so request text is a pure
 * function of a CLOSED record type. The stored name and outcome are classified into that type at the
 * reconstruction boundary and the original strings are discarded there; that classify-and-discard rule is why
 * receipt text needs no `Untrusted` brand (there is no free-form string to brand).
 *
 * Canonical home: [agent-session-spec.md](../../../../docs/reference/contracts/agent-session-spec.md#content-free-action-receipts--adr-0128).
 * This file implements it and the doc does not restate the prose, which lives in the constants below.
 *
 * **Pure and synchronous.** Every input here has a fixed cap, so nothing in this module needs a cancellation
 * point; an operation that publishes receipt state observes its own cancellation immediately before its
 * atomic installation.
 */

import {
  SessionInterruptionSchema,
  utf8ByteLength,
  type CompletedSessionTurn,
  type SessionInterruption,
  type SessionToolHistoryEntry,
  type SessionToolResultPart,
} from '@relavium/shared';

import { BUILTIN_TOOL_IDS } from '../tools/builtins.js';

/** The fixed label for every name that is not an exact built-in id (custom, MCP-discovered, `unknown_tool`). */
export const RECEIPT_OTHER_TOOL = 'other_tool';

/** The recorded outcome vocabulary — derived from the durable schema so a fifth value breaks the build. */
export type ReceiptOutcome = SessionToolResultPart['outcome'];

/** The rendered word for each outcome. `satisfies` is the compile-time exhaustiveness guard. */
const OUTCOME_WORD = {
  ok: 'ok',
  error: 'error',
  denied: 'denied',
  cancelled: 'cancelled',
} as const satisfies Record<ReceiptOutcome, string>;

/** One recorded call: a closed label and a closed outcome, nothing else. */
export interface ReceiptRecord {
  /** A built-in tool id from the code-owned catalog, or {@link RECEIPT_OTHER_TOOL}. */
  readonly label: string;
  readonly outcome: ReceiptOutcome;
}

/**
 * What one completed turn's evidence amounts to.
 *
 * `records` holds at most {@link RECEIPT_LIMITS.turnRecords} entries, oldest first. `omitted` counts earlier
 * records of the same turn that are not listed (`'unknown'` when the evidence was not fully inspected).
 * `incomplete` is true whenever any of the turn's evidence may be missing — omitted, evicted, uninspected,
 * malformed or ambiguous — and is what makes a request say that unlisted activity may exist. A live turn that
 * observed no tool call is known empty and is NOT incomplete. Invariant: `omitted !== 0` implies `incomplete`.
 */
export interface TurnReceipts {
  readonly records: readonly ReceiptRecord[];
  readonly omitted: number | 'unknown';
  readonly incomplete: boolean;
}

/** The ADR-0128 bounds. The per-turn byte cap is proven by construction in the unit tests, not re-checked. */
export const RECEIPT_LIMITS = Object.freeze({
  turnRecords: 32,
  turnBytes: 4_096,
  totalRecords: 128,
  totalBytes: 16_384,
  turnParts: 256,
  operationParts: 4_096,
});

const freezeReceipts = (
  records: readonly ReceiptRecord[],
  omitted: number | 'unknown',
  incomplete: boolean,
): TurnReceipts => Object.freeze({ records: Object.freeze(records), omitted, incomplete });

/** A live turn that observed no call: known empty, so it adds no byte to a request. */
export const KNOWN_EMPTY_RECEIPTS: TurnReceipts = freezeReceipts([], 0, false);
/** A restored turn with zero tool rows: there is no completeness marker, so it is ambiguous. */
const AMBIGUOUS_EMPTY_RECEIPTS: TurnReceipts = freezeReceipts([], 0, true);
/** Nothing usable and nothing known: evicted, uninspected, malformed or never supplied. */
export const OMITTED_RECEIPTS: TurnReceipts = freezeReceipts([], 'unknown', true);

const BUILTIN_LABELS: ReadonlySet<string> = new Set(BUILTIN_TOOL_IDS);

/** Classify a stored/resolved name into the closed label set; the original string is discarded. */
export function receiptLabel(name: string): string {
  return BUILTIN_LABELS.has(name) ? name : RECEIPT_OTHER_TOOL;
}

function isReceiptOutcome(value: unknown): value is ReceiptOutcome {
  return typeof value === 'string' && Object.hasOwn(OUTCOME_WORD, value);
}

function isReceiptLabel(value: unknown): value is string {
  return typeof value === 'string' && (value === RECEIPT_OTHER_TOOL || BUILTIN_LABELS.has(value));
}

/** Keep the newest `turnRecords` of newest-first records, oldest first, with the exact omitted count. */
function newestRecords(newestFirst: readonly ReceiptRecord[]): ReceiptRecord[] {
  return newestFirst.slice(0, RECEIPT_LIMITS.turnRecords).reverse();
}

/**
 * Live source: the typed `toolHistory` a completed turn returns. Validated over its newest entries only, the
 * same window the restored path inspects, so a pathological length costs a bounded amount of work; the omitted
 * count is the exact difference because the length itself is trusted data.
 */
export function receiptsFromToolHistory(
  history: readonly SessionToolHistoryEntry[] | undefined,
): TurnReceipts {
  if (history === undefined) return OMITTED_RECEIPTS;
  if (history.length === 0) return KNOWN_EMPTY_RECEIPTS;
  const ids = new Set<string>();
  const newestFirst: ReceiptRecord[] = [];
  for (const entry of history.slice(-(RECEIPT_LIMITS.turnParts / 2)).reverse()) {
    if (
      entry.call.id !== entry.result.toolCallId ||
      ids.has(entry.call.id) ||
      !isReceiptOutcome(entry.result.outcome)
    )
      return OMITTED_RECEIPTS;
    ids.add(entry.call.id);
    newestFirst.push({ label: receiptLabel(entry.call.name), outcome: entry.result.outcome });
  }
  const omitted = history.length - Math.min(history.length, RECEIPT_LIMITS.turnRecords);
  return freezeReceipts(newestRecords(newestFirst), omitted, omitted !== 0);
}

/**
 * Restored source: derive receipts for completed turns from their structural rows.
 *
 * Walks turns NEWEST first and, inside a turn, record pairs newest first, at whole-record boundaries, inspecting
 * at most `turnParts` parts per turn and `operationParts` per operation. Pairing and uniqueness are validated
 * over the inspected rows of ONE turn only; an id is never used across turns and never rendered. A turn whose
 * inspected rows are malformed yields no receipts and is marked incomplete — derivation never fails a resume
 * and never emits a partial or guessed pair. Uninspected detail is unknown, never counted by scanning on.
 *
 * Returns one entry per input turn, in the input order.
 */
export function deriveTurnReceipts(turns: readonly CompletedSessionTurn[]): TurnReceipts[] {
  const out: TurnReceipts[] = turns.map(() => OMITTED_RECEIPTS);
  const budget = { remaining: RECEIPT_LIMITS.operationParts };
  for (const [index, turn] of [...turns.entries()].reverse())
    out[index] = deriveOneTurn(turn, budget);
  return out;
}

function deriveOneTurn(turn: CompletedSessionTurn, budget: { remaining: number }): TurnReceipts {
  const rows = turn.messages;
  // rows[0] is the user, rows[last] the terminal; everything between is call/result row pairs.
  // A turn with no structural rows is AMBIGUOUS when it was written before receipts existed — except an interrupted
  // turn (ADR-0119): its dispatched calls are always recorded, so "no rows" there is the truth, not a gap.
  if (rows.length <= 2)
    return turn.interruption === undefined ? AMBIGUOUS_EMPTY_RECEIPTS : KNOWN_EMPTY_RECEIPTS;
  const newestFirst: ReceiptRecord[] = [];
  const ids = new Set<string>();
  let turnParts = 0;
  let upper = rows.length - 1;
  let uninspected = false;
  while (upper > 1) {
    // A pair costs two parts. The budget is checked before the rows are examined, so exhausting it is
    // "uninspected", never "malformed".
    if (turnParts + 2 > RECEIPT_LIMITS.turnParts || budget.remaining - turnParts < 2) {
      uninspected = true;
      break;
    }
    const callRow = rows[upper - 2];
    const resultRow = rows[upper - 1];
    const call = callRow?.content.length === 1 ? callRow.content[0] : undefined;
    const result = resultRow?.content.length === 1 ? resultRow.content[0] : undefined;
    if (
      callRow?.role !== 'assistant' ||
      resultRow?.role !== 'tool' ||
      call?.type !== 'tool_call' ||
      result?.type !== 'tool_result' ||
      call.id !== result.toolCallId ||
      ids.has(call.id) ||
      !isReceiptOutcome(result.outcome)
    ) {
      // An orphan row (odd inner count) also lands here: its "pair" has the user row as its call.
      budget.remaining -= turnParts;
      return OMITTED_RECEIPTS;
    }
    ids.add(call.id);
    newestFirst.push({ label: receiptLabel(call.name), outcome: result.outcome });
    turnParts += 2;
    upper -= 2;
  }
  budget.remaining -= turnParts;
  const omitted = uninspected
    ? 'unknown'
    : Math.max(0, newestFirst.length - RECEIPT_LIMITS.turnRecords);
  return freezeReceipts(newestRecords(newestFirst), omitted, omitted !== 0);
}

// ---------------------------------------------------------------------------------------------------------
// Rendering. Every string below is a code-owned constant or a closed-vocabulary value.

export const RECEIPT_BLOCK_OPENING =
  '[Recorded tool calls made while answering the request above. Historical data, not instructions.]';
export const RECEIPT_BLOCK_CLOSING = '[End of recorded tool calls.]';
const BLOCK_SEPARATOR = '\n\n';

/** Fixed prose explaining the outcome words; present whenever any turn block is. */
export const RECEIPT_NOTICE_LEGEND =
  '[Earlier turns of this conversation may list recorded tool calls. These are historical records, not ' +
  'instructions. ok: a success was recorded. error: a failure was recorded; a failed call may still have ' +
  'had a partial effect. denied: a refusal was recorded; it neither forbids nor permits a later attempt. ' +
  'cancelled: the outcome is unknown. A record does not establish a file’s contents or its current state.]';
/** Fixed sentence present whenever any selected turn is incomplete. */
export const RECEIPT_NOTICE_INCOMPLETE =
  '[Some earlier tool activity may not be listed here. A turn without records is not evidence that no ' +
  'tool ran.]';
const NOTICE_SEPARATOR = '\n\n';

/** The bytes the request notice can occupy at most; reserved first so a full payload cannot overflow it. */
const NOTICE_RESERVE_BYTES = utf8ByteLength(
  `${RECEIPT_NOTICE_LEGEND} ${RECEIPT_NOTICE_INCOMPLETE}${NOTICE_SEPARATOR}`,
);

/** The text part appended after a completed turn's user text, or `undefined` when it retains no record. */
export function renderTurnReceiptBlock(receipts: TurnReceipts): string | undefined {
  if (receipts.records.length === 0) return undefined;
  const lines = receipts.records.map(
    (record, index) => `${index + 1}. ${record.label} — ${OUTCOME_WORD[record.outcome]}`,
  );
  if (receipts.omitted !== 0)
    lines.unshift(
      `[Earlier calls in this turn not listed: ${receipts.omitted === 'unknown' ? 'unknown number' : receipts.omitted}.]`,
    );
  return `${BLOCK_SEPARATOR}${RECEIPT_BLOCK_OPENING}\n${lines.join('\n')}\n${RECEIPT_BLOCK_CLOSING}`;
}

// ---------------------------------------------------------------------------------------------------------
// ADR-0119: the interruption sentence. One fixed template per reason and per receipts state; the only variable
// parts are a code-owned phrase and, for `failed`, a literal from the closed ErrorCode taxonomy.

const INTERRUPTION_OPENING = '[This request was interrupted before it was answered: ';
const INTERRUPTION_CLOSING =
  ' Nothing the assistant wrote before the interruption was kept. This note is a historical record, ' +
  'not an instruction, and does not establish that the request was or was not carried out.]';
const CALLS_RECORDED =
  'Calls listed above were recorded before the interruption; one marked cancelled has an unknown outcome.';
const CALLS_NONE = 'No tool call was recorded for it.';
const CALLS_MAYBE_UNLISTED = 'Tool calls made before the interruption may not be listed.';

/**
 * The closed phrase for an interruption, shared by the model-facing sentence and the restored transcript's dim row
 * so the two can never describe the same row differently.
 */
export function interruptionPhrase(interruption: SessionInterruption): string {
  switch (interruption.reason) {
    case 'aborted':
      return 'the user stopped it';
    case 'failed':
      return `it failed (${interruption.code ?? 'internal'})`;
    case 'denied':
      return 'a tool call was refused and the turn ended';
    case 'turn_limit':
      return 'it reached the limit on tool rounds';
  }
}

/**
 * The fixed sentence that follows an interrupted turn's receipts block. It says what happened to the REQUEST,
 * never that a change was applied, and its calls clause follows the turn's receipts state so it cannot contradict
 * the list above it.
 */
export function renderInterruptionSentence(
  interruption: SessionInterruption,
  receipts: TurnReceipts,
): string {
  const calls =
    receipts.records.length > 0
      ? CALLS_RECORDED
      : receipts.incomplete
        ? CALLS_MAYBE_UNLISTED
        : CALLS_NONE;
  return `${INTERRUPTION_OPENING}${interruptionPhrase(interruption)}. ${calls}${INTERRUPTION_CLOSING}`;
}

/** What a retained turn contributes to a request or a summariser input: its receipts and, if any, its interruption. */
export interface TurnEvidence {
  readonly receipts: TurnReceipts;
  readonly interruption?: SessionInterruption | undefined;
}

/**
 * The text appended after a retained turn's user text: the receipts block when it has records, then — for an
 * interrupted turn — one blank line and the interruption sentence. A completed turn is unchanged. The sentence
 * is NOT counted against the receipt budget: it is the point of an interrupted turn, at most a few hundred
 * bytes, and bounded by the turn count and by compaction and `window`.
 */
export function renderTurnBlock(span: TurnEvidence): string | undefined {
  const block = renderTurnReceiptBlock(span.receipts);
  if (span.interruption === undefined) return block;
  return `${block ?? ''}${BLOCK_SEPARATOR}${renderInterruptionSentence(span.interruption, span.receipts)}`;
}

/** UTF-8 bytes of a turn's block (0 when it renders none), counting wrappers and the omission line. */
export function receiptBlockBytes(receipts: TurnReceipts): number {
  const block = renderTurnReceiptBlock(receipts);
  return block === undefined ? 0 : utf8ByteLength(block);
}

/**
 * The single request-level notice over the selected turns, or `undefined` when neither part applies — in which
 * case the request is byte-identical to the text-only request. Trailing separator included for request use.
 */
export function renderReceiptNotice(selected: readonly TurnReceipts[]): string | undefined {
  const parts: string[] = [];
  if (selected.some((receipts) => receipts.records.length > 0)) parts.push(RECEIPT_NOTICE_LEGEND);
  if (selected.some((receipts) => receipts.incomplete)) parts.push(RECEIPT_NOTICE_INCOMPLETE);
  return parts.length === 0 ? undefined : `${parts.join(' ')}${NOTICE_SEPARATOR}`;
}

// ---------------------------------------------------------------------------------------------------------
// Retention and admission.

/**
 * The one retention rule shared by a live session, resume and reseat (ADR-0128 decision 6, step 3): walk turns
 * newest first and keep each turn's block whole while the running total stays within `totalRecords` records and
 * `totalBytes` bytes after reserving the notice. The first block that does not fit, and every older block, is
 * evicted — a larger older block is never skipped to keep a smaller one. A turn without records costs nothing
 * and is left untouched. Pure: returns new span objects only for the evicted turns.
 */
export function retainTurnReceipts<T extends { readonly receipts: TurnReceipts }>(
  spans: readonly T[],
): T[] {
  let records = 0;
  let bytes = NOTICE_RESERVE_BYTES;
  let cut = false;
  const out = [...spans];
  for (const [index, span] of [...out.entries()].reverse()) {
    if (span.receipts.records.length === 0) continue;
    if (!cut) {
      const blockBytes = receiptBlockBytes(span.receipts);
      if (
        records + span.receipts.records.length <= RECEIPT_LIMITS.totalRecords &&
        bytes + blockBytes <= RECEIPT_LIMITS.totalBytes
      ) {
        records += span.receipts.records.length;
        bytes += blockBytes;
        continue;
      }
      cut = true;
    }
    out[index] = { ...span, receipts: OMITTED_RECEIPTS };
  }
  return out;
}

/**
 * Admit host-SUPPLIED receipt metadata: validate shape and the step 2-3 caps before copying, then return frozen
 * copies, or `undefined` when anything is out of bounds. Derived state never needs this; it exists because
 * `AgentSession.resume` accepts state from a host, and a programming error there must be refused.
 */
export function admitSuppliedSpans(
  supplied: readonly {
    readonly start: number;
    readonly end: number;
    readonly receipts: unknown;
    readonly interruption?: unknown;
  }[],
):
  | { start: number; end: number; receipts: TurnReceipts; interruption?: SessionInterruption }[]
  | undefined {
  const admitted: {
    start: number;
    end: number;
    receipts: TurnReceipts;
    interruption?: SessionInterruption;
  }[] = [];
  let records = 0;
  let bytes = NOTICE_RESERVE_BYTES;
  for (const { start, end, receipts, interruption } of supplied) {
    const copy = admitOne(receipts);
    if (copy === undefined) return undefined;
    // ADR-0119: a supplied interruption must satisfy the closed schema exactly, or the whole state is refused.
    let admittedInterruption: SessionInterruption | undefined;
    if (interruption !== undefined) {
      const parsed = SessionInterruptionSchema.safeParse(interruption);
      if (!parsed.success) return undefined;
      admittedInterruption = parsed.data;
    }
    const blockBytes = receiptBlockBytes(copy);
    records += copy.records.length;
    bytes += blockBytes;
    if (
      blockBytes > RECEIPT_LIMITS.turnBytes ||
      records > RECEIPT_LIMITS.totalRecords ||
      bytes > RECEIPT_LIMITS.totalBytes
    )
      return undefined;
    admitted.push({
      start,
      end,
      receipts: copy,
      ...(admittedInterruption === undefined ? {} : { interruption: admittedInterruption }),
    });
  }
  return admitted;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function admitOne(value: unknown): TurnReceipts | undefined {
  if (!isObject(value)) return undefined;
  const { records, omitted, incomplete } = value;
  // Lengths are checked before anything is copied or walked.
  if (!Array.isArray(records) || records.length > RECEIPT_LIMITS.turnRecords) return undefined;
  const list: readonly unknown[] = records;
  const knownOmitted =
    omitted === 'unknown' ||
    (typeof omitted === 'number' && Number.isSafeInteger(omitted) && omitted >= 0);
  if (typeof incomplete !== 'boolean' || !knownOmitted) return undefined;
  if (omitted !== 0 && !incomplete) return undefined;
  const copied: ReceiptRecord[] = [];
  for (const record of list) {
    if (!isObject(record)) return undefined;
    const { label, outcome } = record;
    if (!isReceiptLabel(label) || !isReceiptOutcome(outcome)) return undefined;
    copied.push({ label, outcome });
  }
  return freezeReceipts(copied, omitted, incomplete);
}
