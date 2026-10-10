/** Measured, bounded compaction construction (ADR-0096/0099); no state or provider invocation. */
import type { FallbackPlanEntry, LlmMessage } from '@relavium/llm';
import { selectOwnedRequest, outputTokensReservation } from '@relavium/llm';
import { unwrapUntrusted, type Untrusted } from '../tools/untrusted.js';
import { AgentTurnError, type PreparedAgentTurnRequest } from './agent-turn.js';

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

export function renderConversationToSummarise(
  priorSummary: Untrusted<string> | undefined,
  foldable: readonly LlmMessage[],
): LlmMessage {
  const parts: string[] = [];
  if (priorSummary !== undefined)
    parts.push(
      `Summary of the conversation so far:\n${unwrapUntrusted(priorSummary)}`,
      'The conversation then continued:',
    );
  for (const message of foldable) {
    const text = messageText(message);
    if (text.length > 0) parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
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
): { readonly prepared: PreparedAgentTurnRequest; readonly end: number } {
  let best: { prepared: PreparedAgentTurnRequest; end: number } | undefined;
  for (let end = start + 1; end <= foldable.length; end++) {
    const prepared = prepare(
      renderConversationToSummarise(priorSummary, foldable.slice(start, end)),
    );
    if (!fits(prepared)) break;
    best = { prepared, end };
  }
  if (best !== undefined) return best;
  const message = foldable[start];
  if (message === undefined)
    throw new AgentTurnError('validation', 'the compaction has no foldable message', false);
  const characters = Array.from(messageText(message));
  const truncated = (keep: number): PreparedAgentTurnRequest => {
    const head = Math.ceil(keep / 2),
      tail = Math.floor(keep / 2);
    const text = `${characters.slice(0, head).join('')}\n[engine: omitted ${characters.length - keep} character(s) from this message]\n${tail === 0 ? '' : characters.slice(-tail).join('')}`;
    return prepare(
      renderConversationToSummarise(priorSummary, [
        { role: message.role, content: [{ type: 'text', text }] },
      ]),
    );
  };
  let prepared = truncated(0);
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
