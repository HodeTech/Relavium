import { formatCostUsd, formatDuration, formatTokens } from './format.js';
import type { SessionViewState, ToolCallView, TurnSummary } from './session-view-model.js';

/**
 * Pure projection helpers for the `relavium chat` ink `ChatApp` (workstream **2.M**) — extracted so the
 * displayed strings are unit-tested without mounting React, reusing the 2.E `format.ts` cost/duration/token
 * formatters. Each is a thin, deterministic projection of {@link SessionViewState}; the React view only
 * arranges them in `ink` `Box`/`Text`.
 */

/**
 * A one-line per-turn summary shown after a completed assistant turn: the stop reason (or the error code),
 * the turn's token usage, and its duration. Secret-free — it carries only counts/codes, never argument text.
 */
export function formatTurnSummary(summary: TurnSummary): string {
  const parts: string[] = [];
  if (summary.errorCode !== undefined) {
    parts.push(`error: ${summary.errorCode}`);
  } else {
    parts.push(summary.stopReason);
  }
  parts.push(formatTokens(summary.tokensUsed));
  if (summary.durationMs !== undefined) {
    parts.push(formatDuration(summary.durationMs));
  }
  return parts.join(' · ');
}

/**
 * A tool-call annotation line for the in-flight turn — the namespaced tool id and whether its result has
 * arrived. Never renders the tool's arguments or result bytes (those can carry user/secret data); only the id.
 */
export function formatToolCall(call: ToolCallView): string {
  return `→ ${call.toolId} ${call.resolved ? '✓' : '…'}`;
}

/**
 * The persistent session footer: the bound model, the running cost, and the completed-turn count. A compact,
 * always-visible status line beneath the prompt.
 */
export function formatSessionFooter(state: SessionViewState): string {
  const parts: string[] = [];
  if (state.model !== undefined) {
    parts.push(state.model);
  }
  parts.push(formatCostUsd(state.cumulativeCostMicrocents));
  parts.push(`${state.turnCount} ${state.turnCount === 1 ? 'turn' : 'turns'}`);
  return parts.join(' · ');
}
