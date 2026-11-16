/** Measured, bounded compaction construction (ADR-0096/0099); no state or provider invocation. */
import type { FallbackPlanEntry, LlmMessage } from '@relavium/llm';
import { selectOwnedRequest, outputTokensReservation } from '@relavium/llm';
import { unwrapUntrusted, type Untrusted } from '../tools/untrusted.js';
import { AgentTurnError, type PreparedAgentTurnRequest } from './agent-turn.js';
import {
  OMITTED_RECEIPTS,
  renderReceiptNotice,
  renderTurnBlock,
  type TurnEvidence,
} from './turn-receipts.js';

export const COMPACTION_MAX_PASSES = 4;
export const COMPACTION_SOFT_INPUT_TOKENS = 16_384;

/** Endpoint identity, not a catalog model alias, decides whether a window is authoritative. */
export function authoritativeContextWindow(
  entry: FallbackPlanEntry | undefined,
): number | undefined {
  try {
    if (entry === undefined || entry.provider.customEndpoint === true) return undefined;
    const window = entry.provider.contextLimit?.(entry.model);
    return window !== undefined && Number.isSafeInteger(window) && window > 0 ? window : undefined;
  } catch {
    return undefined;
  }
}

export function managesOwnContext(entry: FallbackPlanEntry | undefined): boolean {
  try {
    return entry?.provider.managesOwnContext?.() === true;
  } catch {
    // An unavailable optional provider contract cannot authorise automatic summarisation.
    return true;
  }
}

/** Same owned candidate cap selection used by dispatch, governor and allowance pricing. */
export function preparedOutputReservation(
  prepared: PreparedAgentTurnRequest,
  entry: FallbackPlanEntry,
  configuredFallback: number | undefined,
): number {
  const { plan } = selectOwnedRequest(prepared.request, {
    model: entry.model,
    provider: entry.provider.id,
    endpoint: entry.provider.customEndpoint === true ? 'custom' : 'official',
  });
  return outputTokensReservation(plan, configuredFallback);
}

export function assertMeasuredInput(prepared: PreparedAgentTurnRequest): number {
  const input = prepared.inputTokensEstimate;
  if (!Number.isSafeInteger(input) || input < 0)
    throw new AgentTurnError('validation', 'the compaction request could not be measured', false);
  return input;
}

export interface CompactionWindows {
  readonly unknown: boolean;
  readonly entries: ReadonlyMap<FallbackPlanEntry, number | undefined>;
}

export function compactionWindows(prepared: PreparedAgentTurnRequest): CompactionWindows {
  if (prepared.attemptableEntries.length === 0)
    throw new AgentTurnError('validation', 'no provider can accept the compaction request', false);
  const entries = new Map(
    prepared.attemptableEntries.map((entry) => [entry, authoritativeContextWindow(entry)]),
  );
  return { entries, unknown: [...entries.values()].some((window) => window === undefined) };
}

export function compactionRequestFits(
  prepared: PreparedAgentTurnRequest,
  windows: CompactionWindows,
  configuredFallback: number | undefined,
): boolean {
  const input = assertMeasuredInput(prepared);
  if (windows.unknown && input > COMPACTION_SOFT_INPUT_TOKENS) return false;
  for (const entry of prepared.attemptableEntries) {
    const window = windows.entries.get(entry);
    if (
      window !== undefined &&
      input + preparedOutputReservation(prepared, entry, configuredFallback) > window
    )
      return false;
  }
  return true;
}

/** Only text from cross-turn history is summarised. Roles remain data inside one user message. */
function messageText(message: LlmMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * The summariser's input. `evidence[i]`, when given, is the content-free tool evidence of the retained turn
 * whose user message is `foldable[i]` (ADR-0128), plus — for an interrupted turn — its interruption (ADR-0119):
 * the same bounded projection a request carries, so the summary can account for earlier recorded tool calls and
 * for a turn that ended without an answer. The receipt block, the interruption sentence and the single notice
 * are code-owned text (the question notes inside the block are quoted model/person strings, ADR-0133), appended AFTER the message text and never flattened into it, which is
 * what keeps oversized-message truncation from clipping a record.
 */
export function renderConversationToSummarise(
  priorSummary: Untrusted<string> | undefined,
  foldable: readonly LlmMessage[],
  evidence?: readonly (TurnEvidence | undefined)[],
): LlmMessage {
  const parts: string[] = [];
  if (priorSummary !== undefined)
    parts.push(
      `Summary of the conversation so far:\n${unwrapUntrusted(priorSummary)}`,
      'The conversation then continued:',
    );
  const notice = renderReceiptNotice(
    (evidence ?? []).flatMap((entry) => (entry === undefined ? [] : [entry.receipts])),
  );
  if (notice !== undefined) parts.push(notice.trim());
  for (const [index, message] of foldable.entries()) {
    const entry = evidence?.[index];
    const block = entry === undefined ? undefined : renderTurnBlock(entry);
    const text = messageText(message);
    if (text.length > 0 || block !== undefined)
      parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}${block ?? ''}`);
  }
  return { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/** Greedily consume whole messages. Only an individually oversized foldable message is truncated. */
export function prepareCompactionChunk(
  foldable: readonly LlmMessage[],
  start: number,
  priorSummary: Untrusted<string> | undefined,
  prepare: (message: LlmMessage) => PreparedAgentTurnRequest,
  fits: (prepared: PreparedAgentTurnRequest) => boolean,
  evidence?: readonly (TurnEvidence | undefined)[],
): { readonly prepared: PreparedAgentTurnRequest; readonly end: number } {
  let best: { prepared: PreparedAgentTurnRequest; end: number } | undefined;
  for (let end = start + 1; end <= foldable.length; end++) {
    const prepared = prepare(
      renderConversationToSummarise(
        priorSummary,
        foldable.slice(start, end),
        evidence?.slice(start, end),
      ),
    );
    if (!fits(prepared)) break;
    best = { prepared, end };
  }
  if (best !== undefined) return best;
  const message = foldable[start];
  if (message === undefined)
    throw new AgentTurnError('validation', 'the compaction has no foldable message', false);
  const characters = Array.from(messageText(message));
  // Head/tail truncation touches the message TEXT only. This message's receipts ride beside it as whole
  // records; if even an empty text cannot fit with them, they are dropped whole (disclosed through the notice,
  // because the dropped state is incomplete) before the existing "does not fit" failure — never clipped. An
  // interruption sentence stays: it is a fixed few hundred bytes and its calls clause follows the dropped state.
  let ownEvidence = evidence?.[start];
  const truncated = (keep: number): PreparedAgentTurnRequest => {
    const head = Math.ceil(keep / 2),
      tail = Math.floor(keep / 2);
    const text = `${characters.slice(0, head).join('')}\n[engine: omitted ${characters.length - keep} character(s) from this message]\n${tail === 0 ? '' : characters.slice(-tail).join('')}`;
    return prepare(
      renderConversationToSummarise(
        priorSummary,
        [{ role: message.role, content: [{ type: 'text', text }] }],
        [ownEvidence],
      ),
    );
  };
  let prepared = truncated(0);
  if (!fits(prepared) && ownEvidence !== undefined && ownEvidence.receipts.records.length > 0) {
    ownEvidence = { ...ownEvidence, receipts: OMITTED_RECEIPTS };
    prepared = truncated(0);
  }
  if (!fits(prepared))
    throw new AgentTurnError(
      'validation',
      'the summariser system, running summary and omission marker do not fit',
      false,
    );
  let low = 0,
    high = Math.max(0, characters.length - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2),
      candidate = truncated(middle);
    if (fits(candidate)) {
      low = middle;
      prepared = candidate;
    } else high = middle - 1;
  }
  return { prepared, end: start + 1 };
}
