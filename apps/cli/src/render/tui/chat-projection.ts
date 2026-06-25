import { formatCostUsd, formatDuration, formatTokens } from './format.js';
import type { SessionViewState, ToolCallView, TurnSummary } from './session-view-model.js';

/**
 * Pure projection helpers for the `relavium chat` ink `ChatApp` (workstream **2.M**) — extracted so the
 * displayed strings are unit-tested without mounting React, reusing the 2.E `format.ts` cost/duration/token
 * formatters. Each is a thin, deterministic projection of {@link SessionViewState}; the React view only
 * arranges them in `ink` `Box`/`Text`.
 */

/* eslint-disable no-control-regex */
/** ESC-introduced sequences (ANSI CSI colors/cursor, OSC title/hyperlink/clipboard, and other ESC escapes). */
const ESC_SEQUENCES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
/** Remaining C0/C1 control bytes — keep only TAB (\x09) and LINE FEED (\x0a). */
const BARE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/**
 * Strip terminal control sequences from text that will be written to a terminal — so model output (or pasted
 * input) cannot inject ANSI/OSC escapes (colors, a cursor jump, a window-title/clipboard/hyperlink write, a
 * `\r` line-overwrite). Applied at the **display** boundary only; the PERSISTED transcript keeps the raw text
 * (it is user/model data, not displayed back through a shell). Keeps printable text plus tabs and newlines.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(ESC_SEQUENCES, '').replace(BARE_CONTROLS, '');
}

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
