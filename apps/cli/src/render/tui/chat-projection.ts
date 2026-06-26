import { formatCostUsd, formatDuration, formatTokens } from './format.js';
import type { SessionViewState, ToolCallView, TurnSummary } from './session-view-model.js';

/**
 * Pure projection helpers for the `relavium chat` ink `ChatApp` (workstream **2.M**) — extracted so the
 * displayed strings are unit-tested without mounting React, reusing the 2.E `format.ts` cost/duration/token
 * formatters. Each is a thin, deterministic projection of {@link SessionViewState}; the React view only
 * arranges them in `ink` `Box`/`Text`.
 */

/* eslint-disable no-control-regex */
/**
 * ESC-introduced sequences, in four arms:
 *  1. OSC (`ESC ]` title/hyperlink/clipboard) — terminator REQUIRED (BEL or ST). An UNterminated `ESC]…` does
 *     not match here (so it falls to arm 4 and only its 2-byte introducer is stripped, leaving the rest of the
 *     text visible) — an optional terminator would instead swallow the whole remainder of the string,
 *     silently erasing legitimate model output after an injected prefix.
 *  2. DCS/PM/APC/SOS string sequences (`ESC P`/`ESC ^`/`ESC _`/`ESC X`) — terminator REQUIRED (same rationale);
 *     consumes the payload through ST so terminated string sequences leave nothing behind.
 *  3. CSI (`ESC [` colors/cursor) — the parameter/intermediate/final byte form.
 *  4. Any remaining 2-byte `ESC <0x40–0x5f>` escape (incl. an unterminated OSC/DCS/PM/APC introducer).
 */
const ESC_SEQUENCES =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
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
 * Sanitize a single-line dynamic identifier (a tool id, the bound model name) for terminal display: strip the
 * ANSI/OSC/control bytes {@link stripTerminalControls} removes, then collapse any surviving tab/newline to a
 * single space so the value cannot spoof extra terminal lines or columns inside a one-line annotation/footer.
 */
function sanitizeInline(text: string): string {
  return stripTerminalControls(text).replace(/[\t\n]+/g, ' ');
}

/**
 * A one-line per-turn summary shown after a completed assistant turn: the stop reason (or the error code),
 * the turn's token usage, and its duration. Secret-free — it carries only counts/codes, never argument text.
 */
export function formatTurnSummary(summary: TurnSummary): string {
  const head = summary.errorCode === undefined ? summary.stopReason : `error: ${summary.errorCode}`;
  const parts = [
    head,
    formatTokens(summary.tokensUsed),
    summary.durationMs === undefined ? undefined : formatDuration(summary.durationMs),
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

/**
 * A tool-call annotation line for the in-flight turn — the namespaced tool id and whether its result has
 * arrived. Never renders the tool's arguments or result bytes (those can carry user/secret data); only the id,
 * which (being model-named) is sanitized so it cannot inject terminal control sequences.
 */
export function formatToolCall(call: ToolCallView): string {
  return `→ ${sanitizeInline(call.toolId)} ${call.resolved ? '✓' : '…'}`;
}

/**
 * The persistent session footer: the bound model, the running cost, and the completed-turn count. A compact,
 * always-visible status line beneath the prompt. The model name is sanitized before display.
 */
export function formatSessionFooter(state: SessionViewState): string {
  const parts = [
    state.model === undefined ? undefined : sanitizeInline(state.model),
    formatCostUsd(state.cumulativeCostMicrocents),
    `${state.turnCount} ${state.turnCount === 1 ? 'turn' : 'turns'}`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}
