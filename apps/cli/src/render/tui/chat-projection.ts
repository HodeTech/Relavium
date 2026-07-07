import type { ToolApprovalRequest } from '@relavium/core';
import type { ReasoningEffort } from '@relavium/shared';

import { MODE_LABEL, type ChatMode } from '../../chat/chat-mode.js';
import { formatCostUsd, formatDuration, formatElapsed, formatTokens } from './format.js';
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
 * Error codes whose `errorMessage` is a PROVIDER-authored, already-redacted status line safe to render in-chat —
 * distinct from {@link SAFE_MESSAGE_CODES} (static host-authored tool-denial labels) and justified separately.
 * These carry the upstream provider's own error text (`provider_auth` → "402 Insufficient Balance" / "401
 * Invalid API key", `provider_rate_limit` → "429 …", `provider_unavailable` → "503 …", `content_filter` → the
 * moderation reason). Surfacing it is safe because the seam already scrubs secret material at the single
 * `makeLlmError` choke point (packages/llm/src/llm-error.ts `scrubSecrets`) and the run-event carries only
 * `{ code, message, retryable }` — never a raw vendor object — so the message is a provider STATUS line, not a
 * prompt/model echo (the reason `tool_failed` is deliberately excluded — its message MAY carry model/MCP
 * context). It is still terminal-sanitized here regardless (`sanitizeInline`, like every display string).
 */
const PROVIDER_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'provider_auth',
  'provider_rate_limit',
  'provider_unavailable',
  'content_filter',
]);

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
  } else if (
    reason.length > 0 &&
    (SAFE_MESSAGE_CODES.has(summary.errorCode) || PROVIDER_MESSAGE_CODES.has(summary.errorCode))
  ) {
    // Surface WHY the turn died — the reason is the only place it reaches the user. Two vetted families:
    // an approval-floor denial (`error: tool_denied — not allowed in ask mode (read-only)`, a static
    // host-authored label) and a provider status line (`error: provider_auth — 402 Insufficient Balance`, the
    // upstream message, already secret-scrubbed at the seam). Unlike the run path's final-summary.ts (which
    // renders errorMessage for every code), the chat path restricts it to these two secret-free sets, since a
    // chat turn is interactive/lower-trust — every other code (e.g. `tool_failed`) shows only its code.
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
    // The producing model (2.5.H) — present ONLY on a within-turn failover (the view-model omits it when it equals
    // the bound model), so it surfaces exactly when attribution differs from the footer. Sanitized like every id.
    summary.model === undefined ? undefined : `via ${sanitizeInline(summary.model)}`,
    formatTokens(summary.tokensUsed),
    summary.durationMs === undefined ? undefined : formatDuration(summary.durationMs),
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

/** The in-flight busy line: its text plus whether it renders as a DIM, truncate-end STATUS line (compaction /
 *  shell / the pre-token "Working…" line) or as PLAIN, full-width streaming CONTENT (the answer token line). */
export interface BusyLine {
  readonly text: string;
  readonly dim: boolean;
}

/**
 * Assemble the in-flight busy line (2.5.H) — extracted from the ink render so its branch matrix is unit-tested
 * without mounting React. Four states in priority order:
 *  1. the labeled compaction moment (ADR-0062 §7);
 *  2. the `!`-shell command line (2.5.D);
 *  3. the pre-first-token live-turn STATUS — `Working… {elapsed} · Esc to stop`, a whole-second timer + the abort
 *     hint, so a running turn never reads as a frozen bare spinner;
 *  4. the streaming answer CONTENT — with a leading `…` elision marker when the live buffer's head scrolled out (a
 *     VISIBLE loss, not the old silent drop).
 * Every dynamic value (`busyCommand`, `liveTokens`) is terminal-sanitized here at the display boundary. `elapsedMs`
 * is `undefined` before a turn starts; a status line then shows no timer. Returns the text + a `dim` flag the
 * caller maps to `<Text dim wrap>` (status) vs `<Text>` (content).
 */
export function formatBusyLine(input: {
  readonly spinner: string;
  readonly compacting: boolean;
  readonly busyCommand?: string | undefined;
  readonly liveTokens: string;
  readonly liveTokensTruncated: boolean;
  readonly elapsedMs?: number | undefined;
}): BusyLine {
  const { spinner } = input;
  if (input.compacting) {
    return { text: `${spinner} ⟳ Summarizing conversation… · Esc to cancel`, dim: true };
  }
  if (input.busyCommand !== undefined) {
    return {
      text: `${spinner} ! ${sanitizeInline(input.busyCommand)} — running · Esc to cancel`,
      dim: true,
    };
  }
  const content = stripTerminalControls(input.liveTokens);
  if (content.length === 0) {
    const elapsed = input.elapsedMs === undefined ? '' : ` ${formatElapsed(input.elapsedMs)}`;
    return { text: `${spinner} Working…${elapsed} · Esc to stop`, dim: true };
  }
  return { text: `${spinner} ${input.liveTokensTruncated ? '…' : ''}${content}`, dim: false };
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
 * The context-fullness footer segment (ADR-0062 §7) — the LAST completed turn's input tokens as a percentage of
 * the model's context window, so an impending auto-compaction is ANTICIPATED rather than a surprise. `undefined`
 * (segment omitted) until a turn has completed AND the window is known (a custom base-URL model has no catalog
 * window). Clamped to [0, 100] so a preamble-heavy over-window turn never prints a nonsensical >100%.
 */
function formatContextFullness(state: SessionViewState): string | undefined {
  const { lastInputTokens, contextWindowTokens } = state;
  if (
    lastInputTokens === undefined ||
    contextWindowTokens === undefined ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  const pct = Math.min(100, Math.max(0, Math.round((lastInputTokens / contextWindowTokens) * 100)));
  return `${pct}% ctx`;
}

/**
 * The persistent session footer: the bound model, the running cost, the completed-turn count, and the context
 * fullness (ADR-0062 §7). A compact, always-visible status line beneath the prompt. The model name is sanitized
 * before display; the fullness is numbers-only.
 */
export function formatSessionFooter(state: SessionViewState): string {
  const parts = [
    state.model === undefined ? undefined : sanitizeInline(state.model),
    formatCostUsd(state.cumulativeCostMicrocents),
    `${state.turnCount} ${state.turnCount === 1 ? 'turn' : 'turns'}`,
    formatContextFullness(state),
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

/**
 * The footer including the active chat mode (ADR-0057) and — when set — the reasoning-effort tier (ADR-0066), each
 * always shown so neither `auto` mode nor a non-default effort is a hidden state. The effort is omitted when unset
 * (a non-reasoning model / no tier), so a plain chat's footer is unchanged.
 */
export function formatSessionFooterWithMode(
  state: SessionViewState,
  mode: ChatMode,
  reasoningEffort?: ReasoningEffort,
): string {
  const base = formatSessionFooter(state);
  const modePart = `${MODE_LABEL[mode]} mode`;
  const withMode = base.length > 0 ? `${base} · ${modePart}` : modePart;
  return reasoningEffort === undefined ? withMode : `${withMode} · effort: ${reasoningEffort}`;
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
