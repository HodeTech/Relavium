import type { ToolApprovalRequest } from '@relavium/core';

import { MODE_LABEL, type ChatMode } from '../../chat/chat-mode.js';
import { formatCostUsd, formatDuration, formatTokens } from './format.js';
import type { SessionViewState, ToolCallView, TurnSummary } from './session-view-model.js';

/**
 * Pure projection helpers for the `relavium chat` ink `ChatApp` (workstream **2.M**) — extracted so the
 * displayed strings are unit-tested without mounting React, reusing the 2.E `format.ts` cost/duration/token
 * formatters. Each is a thin, deterministic projection of {@link SessionViewState}; the React view only
 * arranges them in `ink` `Box`/`Text`.
 */

/* eslint-disable no-control-regex */
// The terminal-sanitizer matcher, composed from one named source fragment per ESC-introduced escape family so a
// future edit touches a single, clearly-scoped family rather than one dense expression. SECURITY-SENSITIVE: the
// alternation below is byte-for-byte the prior single literal — keep behavior exact (covered by the strip tests).
/** OSC (`ESC ]`) + DCS/PM/APC/SOS (`ESC P`/`^`/`_`/`X`) string sequences, sharing one body. The terminator (BEL
 *  or ST) is REQUIRED, so an UNterminated introducer does NOT match here — it falls through to {@link ESC_2BYTE}
 *  (only its 2-byte form stripped), leaving the following text visible. An optional terminator would instead
 *  swallow the whole remainder of the string, silently erasing legitimate model output. */
const ESC_STRING_SEQ = String.raw`\x1b[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)`;
/** CSI (`ESC [` colors/cursor) — the parameter / intermediate / final-byte form. */
const ESC_CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`;
/** Any remaining 2-byte `ESC <0x40–0x5f>` escape (incl. an unterminated OSC/DCS/PM/APC introducer). */
const ESC_2BYTE = String.raw`\x1b[@-Z\\-_]`;
/** Every ESC-introduced sequence, composed from the named families above. */
const ESC_SEQUENCES = new RegExp(`${ESC_STRING_SEQ}|${ESC_CSI}|${ESC_2BYTE}`, 'g');
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
 * Sanitize a single-line dynamic identifier (a tool id, the bound model name, a persisted session title) for
 * terminal display: strip the ANSI/OSC/control bytes {@link stripTerminalControls} removes, then collapse any
 * surviving tab/newline to a single space so the value cannot spoof extra terminal lines or columns inside a
 * one-line annotation/footer/list row.
 */
export function sanitizeInline(text: string): string {
  return stripTerminalControls(text).replace(/[\t\n]+/g, ' ');
}

/**
 * Error codes whose `errorMessage` is safe to render in-chat. This leans on a load-bearing project-wide
 * contract, not a two-string allowlist: EVERY `tool_denied` / `tool_unavailable` message across the engine is,
 * by the `ToolDispatchError` reason-only rule (packages/core/src/tools/errors.ts; tool-registry.md §errors), a
 * static host/engine-authored LABEL that never interpolates an argument value, path, URL, or secret — the
 * ADR-0057 approval-floor denials ("not allowed in ask mode (read-only)", "refusing to write inside a protected
 * directory", "fs (read-only in this session)") plus every `ToolPolicyError` / `HostDeniedError` reason. Other
 * codes (validation / execution_failed / …) MAY carry prompt/model context, so only the code is shown for them.
 * A new denial subclass becomes chat-visible automatically once its code is one of these — which is safe
 * precisely because the reason-only contract binds it too (the message is still terminal-sanitized regardless).
 */
const SAFE_MESSAGE_CODES: ReadonlySet<string> = new Set(['tool_denied', 'tool_unavailable']);

/**
 * A one-line per-turn summary shown after a completed assistant turn: the stop reason (or the error code +,
 * for the vetted approval-floor codes, its secret-free reason), the turn's token usage, and its duration.
 * Secret-free — it carries only counts/codes + a whitelisted reason label, never argument text.
 */
export function formatTurnSummary(summary: TurnSummary): string {
  // Terminal-sanitize the whitelisted reason (like every other display string here) BEFORE the whitespace
  // collapse — the whitelisted messages are host-authored ASCII today, but the render boundary must strip any
  // ANSI/OSC/control byte regardless so the whitelist stays robust to a future producer.
  const reason =
    summary.errorMessage === undefined
      ? ''
      : sanitizeInline(summary.errorMessage).replace(/\s+/gu, ' ').trim();
  let head: string;
  if (summary.errorCode === undefined) {
    head = summary.stopReason;
  } else if (reason.length > 0 && SAFE_MESSAGE_CODES.has(summary.errorCode)) {
    // Surface WHY a governed action was denied — the reason is the only place it reaches the user, and the turn
    // died on it (e.g. `error: tool_denied — not allowed in ask mode (read-only)`). Unlike the run path's
    // final-summary.ts (which renders errorMessage for every code), the chat path restricts it to the vetted
    // approval-floor codes, since a chat turn is interactive/lower-trust.
    head = `error: ${summary.errorCode} — ${reason}`;
  } else if (summary.errorCode === 'tool_failed') {
    // A tool call ended the turn (a repeated failure spent the correction budget, or a non-recoverable tool
    // error). On the chat surface a file-not-found is usually fed back to the model (ADR-0057 recoverToolFailures)
    // so it seldom reaches here — but when the turn DOES die on tool_failed we owe the user more than a bare code.
    // We must NOT echo `errorMessage` (a tool_failed message MAY carry model/prompt/MCP-server context — the very
    // reason it is outside SAFE_MESSAGE_CODES); instead a STATIC, host-authored hint at the most common real
    // cause: a path outside the session workspace (the #1 launch-cwd gotcha) or an unavailable target.
    head =
      "error: tool_failed — a tool call failed (a path may be outside this session's workspace, or the target was unavailable)";
  } else {
    head = `error: ${summary.errorCode}`;
  }
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

/** The footer including the active chat mode (ADR-0057) — the mode is always shown so `auto` is never hidden. */
export function formatSessionFooterWithMode(state: SessionViewState, mode: ChatMode): string {
  const base = formatSessionFooter(state);
  const modePart = `${MODE_LABEL[mode]} mode`;
  return base.length > 0 ? `${base} · ${modePart}` : modePart;
}

/**
 * The secret-free target line for an approval prompt — the resolved path / command / host from the preview
 * (the registry already stripped any secret / query string). Sanitized for display; empty when the action
 * class carries no pre-dispatch target (e.g. `web_search` / `mcp_call`, where the action class alone is shown).
 */
export function formatApprovalTarget(request: ToolApprovalRequest): string {
  const { path, command, host } = request.preview;
  const target = path ?? command ?? host ?? '';
  return target.length > 0 ? sanitizeInline(target) : '';
}
