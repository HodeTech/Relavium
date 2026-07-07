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

/**
 * Context-overflow heuristic (2.5.H): a request that exceeds the model context window surfaces as `validation` (a
 * provider `bad_request`), a code shared with an authoring/shape error — so we can only DISTINGUISH the overflow by
 * a keyword match on the (never-displayed) provider MESSAGE (`error.message`, never the error `code`). The markers
 * cover the common provider message phrasings: OpenAI "maximum context length", Anthropic "prompt is too long" AND
 * "…exceed context limit", Gemini "input token count … exceeds". They are deliberately CONTEXT/TOKEN-qualified (no
 * bare "exceeds the maximum" / "token limit", which a param 400 like "temperature exceeds the maximum" would
 * false-match). This is a SECONDARY net — 2.5.F auto-compaction (ADR-0062) pre-empts most overflows; it fires for a
 * model with no known window or `auto_compact = false`. Reading the message for a keyword is NOT displaying it (the
 * hint returned is a STATIC host string), so no provider text is echoed.
 */
const CONTEXT_OVERFLOW_MARKERS: readonly string[] = [
  'context window',
  'context length', // OpenAI "maximum context length is N tokens"
  'context limit', // Anthropic "input length and max_tokens exceed context limit"
  'maximum context',
  'prompt is too long', // Anthropic
  'too many tokens',
  'input token count', // Gemini
];

function looksLikeContextOverflow(message: string | undefined): boolean {
  if (message === undefined || message.length === 0) return false;
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * An **actionable, secret-free recovery hint** for a failed turn's `ErrorCode` (2.5.H) — a one-line next step that
 * makes explicit **the session survives** (a failed turn settles `session:turn_completed`, never a terminal, so the
 * REPL stays live). Extends the "say so plainly" philosophy from the 2.5.A capability gap to the transport / quota /
 * limit classes. Returns `undefined` for a code that is structurally unreachable on the chat
 * `session:turn_completed.error` path: a cancel settles as `stopReason: 'aborted'` with **no** `error`, so
 * `cancelled` never appears there; `sandbox_error` and `run_timeout` are WorkflowEngine-only (a provider timeout on
 * the session path classifies as `provider_unavailable`). The returned string is ALWAYS a static host label — it
 * never interpolates the provider `message` (only the context-overflow heuristic READS it, to pick the right hint).
 */
export function errorRecoveryHint(code: string | undefined, message?: string): string | undefined {
  switch (code) {
    case 'provider_rate_limit':
      return 'Rate-limited by the provider — Relavium already retried with backoff + failover. The session is still active; resend if the turn did not finish.';
    case 'provider_unavailable':
      return 'The provider was unavailable — Relavium tried the fallback chain. The session is still active; try again.';
    case 'provider_auth':
      return 'Provider authentication failed — check the API key, or unlock the OS keychain if it locked mid-session. The session is still active; fix the key (`relavium provider …`) and resend.';
    case 'content_filter':
      return 'The provider blocked the content by its policy. The session is still active; rephrase and resend.';
    case 'validation':
      // Only the context-overflow shape gets an actionable hint — a generic validation error has no chat-side remedy.
      return looksLikeContextOverflow(message)
        ? 'The request exceeded the model context window — run `/compact` or `/trim` to reclaim room, then resend. The session is still active.'
        : undefined;
    case 'tool_failed':
      // A tool_failed reaching a completed turn is a NON-recoverable failure (a side-effecting or budget-exhausted
      // tool) — the summary line already names the likely cause (a path / an unavailable target, e.g. an MCP
      // server). Do NOT promise a retry (there is no session-level tool retry) or a blind "try again" (a
      // side-effecting failure is fail-fast BECAUSE a re-run is unsafe); guide to fixing the cause.
      return 'A tool call failed. The session is still active; fix the path or target (or check the MCP server) and resend.';
    case 'tool_unavailable':
      // A host/config gap — the capability arm (`fs`/`process`/`egress`/…) is not wired for the SESSION, so a plain
      // resend re-fails identically (it is not a `/mode`-style runtime toggle). Do NOT promise the model can just
      // proceed without it; guide to rephrasing / re-wiring — mirrors the tool_failed no-blind-retry correction.
      return "That tool isn't wired for this session (a host/config gap). The session is still active; rephrase to avoid needing it, or wire the capability and start a fresh session.";
    case 'tool_denied':
      return 'The tool was denied by the current mode/policy — switch with `/mode` if that was intended. The session is still active.';
    case 'budget_exceeded':
      return 'The turn hit the session cost cap — raise `[chat].max_cost_microcents`, or `/clear` to reset the running total. The session is still active.';
    case 'turn_limit':
      // Two producers: the per-turn tool-call ceiling AND the session HARD round cap (agent-session.ts). "Send
      // another message" fixes the first but is re-blocked by the second — so cover both without asserting a cause.
      return 'The turn hit a turn/tool-call limit. The session is still active; send another message — if it is blocked again immediately, the session hit its hard turn cap (`/clear` to start fresh).';
    case 'internal':
      // No `correlationId` on the session path (that field is WorkflowEngine-only, ADR-0036), so do not send the
      // user looking for a log id that this surface never produces — and no dangling "report it" with no channel.
      return 'An unexpected error occurred. The session is still active; try again — `/doctor` can check your setup if it keeps happening.';
    default:
      // Structurally unreachable on the session `turn_completed.error` path (`cancelled` settles as `aborted` with
      // no error; `sandbox_error` / `run_timeout` are WorkflowEngine-only) OR an unknown/future code — no hint.
      return undefined;
  }
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
  /** True when the pre-token label should read "Thinking…" rather than "Working…" (2.5.H). This is the DERIVED
   *  "the model is plausibly reasoning" signal — the caller computes it via {@link reasoningLabelActive} (reasoning
   *  streamed this turn AND no tool call is currently executing), NOT the raw "any reasoning streamed" flag, so a
   *  tool round shows "Working…". Absent/false ⇒ a plain (or tool-running) turn shows "Working…". */
  readonly reasoningActive?: boolean | undefined;
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
    const label = input.reasoningActive === true ? 'Thinking…' : 'Working…';
    const elapsed = input.elapsedMs === undefined ? '' : ` ${formatElapsed(input.elapsedMs)}`;
    return { text: `${spinner} ${label}${elapsed} · Esc to stop`, dim: true };
  }
  return { text: `${spinner} ${input.liveTokensTruncated ? '…' : ''}${content}`, dim: false };
}

/**
 * The compact mid-stream abort hint (2.5.H / EA7). The pre-first-token STATUS line carries "· Esc to stop"
 * inline, and the compaction/shell status lines carry their own "· Esc to cancel" — but once answer CONTENT
 * streams the busy line becomes full-width, wrapping text with no room for the affordance, even though `Esc`
 * still aborts the whole turn. Returns the standalone hint the caller renders as a dim line BENEATH the streaming
 * content, or `undefined` for a STATUS line (`busy.dim`) that already shows its inline hint — so the affordance
 * is visible for the ENTIRE turn without ever double-printing. Keyed off the same `dim` flag the caller maps, so
 * there is one source of truth for status-vs-content.
 */
export function streamingAbortHint(busy: BusyLine): string | undefined {
  return busy.dim ? undefined : 'Esc to stop';
}

/**
 * Whether the pre-token busy line should read "Thinking…" (vs "Working…") — the turn streamed reasoning AND no tool
 * call is currently executing (2.5.H). During a tool round the model idle-waits on the tool, so the label falls
 * back to "Working…" rather than claiming the model is thinking while a tool runs. Extracted + exported so this
 * derivation (the fix for the "Thinking… during tool execution" mislabel) is unit-tested, not just inline glue.
 * NOTE: `liveToolCalls` is bounded (`MAX_LIVE_TOOL_CALLS`); in the pathological >bound parallel-tools case an
 * evicted-but-still-unresolved old call could read as resolved here — cosmetic-only (the panel + tool lines are
 * unaffected), acceptable given the generous bound and this engine's typically-ordered resolution.
 */
export function reasoningLabelActive(
  hasReasoning: boolean,
  liveToolCalls: readonly ToolCallView[],
): boolean {
  return hasReasoning && !liveToolCalls.some((call) => !call.resolved);
}

/** The collapsible "thinking" panel (2.5.H): a header (always, carrying the Ctrl+T toggle hint) + the reasoning
 *  BODY only when EXPANDED. The caller renders it only when the turn actually streamed reasoning. */
export interface ReasoningPanel {
  readonly header: string;
  /** The reasoning text — present only when EXPANDED (`visible`); absent when collapsed. */
  readonly body?: string;
}

/**
 * The max terminal ROWS the EXPANDED reasoning body may occupy (2.5.H). The store already bounds the reasoning
 * buffer to {@link MAX_LIVE_TOKEN_CHARS} (4000) CHARACTERS, but on a short/narrow terminal that wraps to many
 * dozens of rows in the live (non-`<Static>`) region — a churning, flickering panel that buries the answer below
 * it. Tailing the DISPLAYED body to the last N rendered rows (see {@link formatReasoningPanel}) keeps the panel
 * compact regardless of terminal size, while the FULL reasoning is still persisted from the raw events.
 */
export const MAX_REASONING_PANEL_LINES = 12;

/** The assumed width when the caller passes no live column count (a headless/test render, or a non-TTY stdout with
 *  no `.columns`). 80 is the conventional terminal width + the 80×24 degrade floor the harness pins. */
const REASONING_PANEL_FALLBACK_COLUMNS = 80;

/**
 * Tail `text` to its last {@link MAX_REASONING_PANEL_LINES} RENDERED rows at the given width — a long logical line
 * counts as `⌈len / columns⌉` wrapped rows (never < 1), so both many short lines AND one very long line are bounded.
 * When the single most-recent logical line alone exceeds the row budget its HEAD is sliced so the tail still fits.
 * Returns the kept body + whether anything was dropped (`tailed`), so the caller can show the head-elision marker.
 *
 * The row count is APPROXIMATE, not exact: `.length` (UTF-16 units) stands in for ink's display-width wrap, so a
 * wide-glyph (CJK/emoji) line under-counts and a combining-mark line over-counts — the panel can render up to ~2×
 * on wide text; the prepended `…` marker in {@link formatReasoningPanel} can add one more row. This matches the
 * store's existing `.length`-based 4000-char cap and avoids a `string-width` runtime dependency; the bound is a
 * cosmetic anti-flicker guard, so an off-by-a-row on unusual scripts is acceptable.
 */
function tailToRenderedRows(
  text: string,
  columns: number | undefined,
): { body: string; tailed: boolean } {
  // `>= 1` (not `> 0`): a fractional 0<columns<1 would floor to 0 and make `rowsOf` divide by zero. In practice
  // the caller always passes an integer ≥ 1 (`process.stdout.columns` / the Home's `size.cols`), so this is a floor.
  const width =
    columns !== undefined && Math.floor(columns) >= 1
      ? Math.floor(columns)
      : REASONING_PANEL_FALLBACK_COLUMNS;
  const rowsOf = (line: string): number => Math.max(1, Math.ceil(line.length / width));
  // Drop ONE trailing newline before splitting: a live buffer cut off right after a line break (very common
  // between stream chunks) ends in '\n', which `split` turns into a phantom empty last segment. That segment
  // would cost a full budget row (`rowsOf('')` clamps to 1) and could prematurely drop a REAL line + flash the
  // elision marker for content that hasn't arrived yet. Stripping exactly one '\n' treats the not-yet-filled
  // next line as zero rows while KEEPING any intentional trailing blank line (a "\n\n" loses only the last).
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const kept: string[] = [];
  let rows = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (rows + rowsOf(line) > MAX_REASONING_PANEL_LINES) {
      // The tail is full. If we have kept nothing yet, this single (oldest-included) line is itself taller than the
      // whole budget — keep only its last budget×width chars so the most recent reasoning still shows. Otherwise
      // stop: the already-kept newer lines fill the budget and older ones are dropped.
      if (kept.length === 0) {
        kept.unshift(line.slice(line.length - MAX_REASONING_PANEL_LINES * width));
      }
      return { body: kept.join('\n'), tailed: true };
    }
    kept.unshift(line);
    rows += rowsOf(line);
  }
  return { body: kept.join('\n'), tailed: false };
}

/**
 * Project the in-flight reasoning into the collapsible panel (2.5.H). Collapsed (default): a dim header with the
 * Ctrl+T toggle hint, so the user knows thinking is available without it flooding the view. Expanded: the header +
 * the reasoning BODY — terminal-sanitized at this display boundary (newline-preserving, it is multi-line prose),
 * bounded to ~the last {@link MAX_REASONING_PANEL_LINES} rendered rows (an approximate width count — see
 * {@link tailToRenderedRows}) so a full 4000-char buffer cannot wrap into a flickering, screen-filling panel on a
 * short terminal, with a leading `…` elision marker when the buffer's head scrolled out — via the store's char cap
 * (`liveReasoningTruncated`) OR this row tail (parity with the answer stream).
 */
export function formatReasoningPanel(input: {
  readonly liveReasoning: string;
  readonly liveReasoningTruncated: boolean;
  readonly visible: boolean;
  /** Live terminal width in columns, for bounding the expanded body to the last N RENDERED rows. Render-only +
   *  cosmetic (parity with `nowMs`): the owner passes `process.stdout.columns` / its resize-tracked width. Absent
   *  or < 1 ⇒ the {@link REASONING_PANEL_FALLBACK_COLUMNS} default, so the row bound still applies headless/in tests. */
  readonly columns?: number | undefined;
}): ReasoningPanel {
  const header = `✻ Reasoning · Ctrl+T ${input.visible ? 'hide' : 'show'}`;
  if (!input.visible) {
    return { header };
  }
  const { body, tailed } = tailToRenderedRows(
    stripTerminalControls(input.liveReasoning),
    input.columns,
  );
  const elided = input.liveReasoningTruncated || tailed;
  return { header, body: `${elided ? '…' : ''}${body}` };
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
