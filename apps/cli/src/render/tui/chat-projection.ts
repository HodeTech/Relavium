import type { ToolDisplay } from './tool-display.js';
import type { Memory } from '@relavium/shared';

import { sanitizeInline, sanitizeUntrustedInline, stripTerminalControls } from '../sanitize.js';
import { parseMarkdown, layoutMarkdown, type MarkdownBlock } from '../markdown/index.js';
import { formatReportedCost, formatTokens } from './format.js';
import { blankMarkerGlyphs, glyph, glyphWithWord, withGlyphForm } from './glyphs.js';
import { guardEntryRows, logicalLineStarts, TEXT_FORM_YOUR_TURN } from './transcript-guard.js';
import { formatDuration, formatElapsed, formatUsd } from '../notation.js';
import type {
  SessionViewState,
  ToolCallView,
  TranscriptEntry,
  TurnSummary,
} from './session-view-model.js';
import { exitKey, keyToken, legend } from './legend.js';
import type { ScrollGeometry } from './scroll.js';
import { wrapText, type DisplayLine } from './viewport.js';
import { clipLine } from './sheet-frame.js';

/**
 * Pure projection helpers for the `relavium chat` ink `ChatApp` (workstream **2.M**) — extracted so the
 * displayed strings are unit-tested without mounting React, reusing the 2.E `format.ts` cost/duration/token
 * formatters. Each is a thin, deterministic projection of {@link SessionViewState}; the React view only
 * arranges them in `ink` `Box`/`Text`.
 */

export { stripTerminalControls };

/** The max length of a typed denial reason (`[c]`, Step 14) — bounds what rides the `ToolDeniedByUserError` into
 *  the turn outcome / `--json` / logs, so a pasted wall of text can't blow up one error line. */
export const MAX_APPROVAL_REASON_CHARS = 300;
export const MAX_APPROVAL_REASON_INPUT_CHARS = 4096;
const OMITTED_DENIAL_EXPLANATION = 'denial explanation omitted (too long)';
const DENIAL_REASON_DISCLOSURE =
  'Your reason may appear in session and redirected output. This is not a private note.';

/** Explicit privacy scope, prewrapped without truncating it on a narrow terminal. */
export function denialReasonDisclosure(columns: number): readonly string[] {
  return wrapText(DENIAL_REASON_DISCLOSURE, Math.max(1, columns));
}

function capCodeUnits(text: string, maximum: number): string {
  const lastUnit = text.charCodeAt(maximum - 1); // NOSONAR — inspect a possible split surrogate
  const end = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? maximum - 1 : maximum;
  return text.slice(0, end);
}

/** Mixed host/user diagnostics, never proof of a secret-free origin or permission to retry. */
export function projectDenialExplanation(message: string): string {
  if (message.length > 4096) return OMITTED_DENIAL_EXPLANATION;
  const clean = sanitizeUntrustedInline(message).replace(/\s+/gu, ' ').trim();
  return clean.length <= 1024 ? clean : `${capCodeUnits(clean, 1023)}…`;
}

/**
 * Sanitize + bound a USER-typed diagnostic explanation for the approval seam (`[c]`, Step 14).
 * Run the existing finite secret backstop on the original input before control normalization and capping.
 * This does not recognize arbitrary personal text or secret fragments. Returns `undefined` for an
 * empty/whitespace reason so the answer degrades to a plain reject (no dangling `": "` in the denial). The value
 * flows into `ToolApprovalDecision.reject.reason`, including existing error/event/JSON diagnostic copies.
 */
export function sanitizeApprovalReason(text: string): string | undefined {
  if (text.length > MAX_APPROVAL_REASON_INPUT_CHARS) return OMITTED_DENIAL_EXPLANATION;
  const clean = sanitizeUntrustedInline(text).trim();
  if (clean.length === 0) return undefined;
  if (clean.length <= MAX_APPROVAL_REASON_CHARS) return clean;
  return capCodeUnits(clean, MAX_APPROVAL_REASON_CHARS);
}

/**
 * Vetted message families. tool_denied can combine fixed host framing with a user's diagnostic explanation;
 * it always uses bounded untrusted projection. Other codes keep their existing reason/status contracts.
 * Unknown/tool_failed messages can contain tool/model context and are not echoed.
 */
const SAFE_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'tool_denied',
  'tool_unavailable',
  'context_overflow',
]);

/**
 * Error codes whose `errorMessage` is a PROVIDER-authored, already-redacted status line safe to render in-chat —
 * distinct from {@link SAFE_MESSAGE_CODES} and justified separately.
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
 * A one-line per-turn summary: counts/codes and selected diagnostic families, with tool denials protected
 * as mixed-origin text. The finite backstop does not promise arbitrary user content is nonsensitive.
 */
export function formatTurnSummary(summary: TurnSummary): string {
  let reason = '';
  if (summary.errorMessage !== undefined) {
    reason =
      summary.errorCode === 'tool_denied'
        ? projectDenialExplanation(summary.errorMessage)
        : sanitizeInline(summary.errorMessage).replace(/\s+/gu, ' ').trim();
  }
  let head: string;
  if (summary.errorCode === undefined) {
    head = summary.stopReason;
  } else if (summary.errorCode === 'turn_limit' && summary.stoppedAtCheckpoint !== undefined) {
    // The person answered the continue checkpoint "stop" (ADR-0136 §2): say that, not "error: turn_limit".
    head = `stopped at a checkpoint after ${summary.stoppedAtCheckpoint} tool round${summary.stoppedAtCheckpoint === 1 ? '' : 's'}`;
  } else if (
    reason.length > 0 &&
    (SAFE_MESSAGE_CODES.has(summary.errorCode) || PROVIDER_MESSAGE_CODES.has(summary.errorCode))
  ) {
    // Explain only vetted families. A denial's fixed framing does not make its optional user text trusted.
    head = `error: ${summary.errorCode} — ${reason}`;
  } else if (summary.errorCode === 'tool_failed') {
    // A tool call ended the turn (a repeated failure spent the correction budget, or a non-recoverable tool
    // error). On the chat surface a file-not-found is usually fed back to the model (ADR-0057 recoverToolFailures)
    // so it seldom reaches here — but when the turn DOES die on tool_failed we owe the user more than a bare code.
    // We must NOT echo `errorMessage` (a tool_failed message MAY carry model/prompt/MCP-server context — the very
    // reason it is outside SAFE_MESSAGE_CODES); instead a STATIC, host-authored hint at the most common real
    // cause: a path outside the session workspace (the #1 launch-cwd gotcha) or an unavailable target.
    const failed = (summary.failedTools ?? [])
      .map(({ toolId, count }) => {
        const name = [...sanitizeInline(toolId)].slice(0, 40).join('');
        return count > 1 ? `${name} \u00d7${count}` : name;
      })
      .filter((entry) => entry.length > 0);
    head =
      failed.length === 0
        ? "error: tool_failed — a tool call failed (a path may be outside this session's workspace, or the target was unavailable)"
        : `error: tool_failed — failed calls ended the turn: ${failed.join(', ')} (a path may be outside this session's workspace, or the target was unavailable)`;
  } else {
    head = `error: ${summary.errorCode}`;
  }
  if (summary.errorCode === 'context_overflow') {
    head += ` ${contextOverflowRemedy(summary.memoryPolicy, summary.toolsRan ?? true)}`;
  }
  const parts = [
    head,
    // The producing model (2.5.H) — present ONLY on a within-turn failover (the view-model omits it when it equals
    // the bound model), so it surfaces exactly when attribution differs from the footer. Sanitized like every id.
    summary.model === undefined ? undefined : `via ${sanitizeInline(summary.model)}`,
    formatTokens(summary.tokensUsed),
    // The time the SYSTEM took: a wait on an approval card is the person's, shown on its own.
    summary.durationMs === undefined
      ? undefined
      : formatDuration(Math.max(0, summary.durationMs - (summary.waitedMs ?? 0))),
    summary.waitedMs === undefined
      ? undefined
      : `${formatDuration(summary.waitedMs)} waiting for you`,
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

/** One policy-aware remedy for classified overflows and the legacy endpoint-message heuristic. */
export function contextOverflowRemedy(
  memory: Readonly<Memory> | undefined,
  toolsRan: boolean,
): string {
  const history =
    memory?.type === 'none'
      ? 'Use a shorter message or choose a model with a larger context window.'
      : memory?.type === 'window'
        ? 'Use `/trim`, shorten the message, or choose a model with a larger context window; a smaller `window_size` applies to a new session.'
        : 'Run `/compact` or `/trim`, shorten the message, or choose a model with a larger context window.';
  const continuation = toolsRan
    ? 'Check the effects of tools that already ran before asking to continue; resending can repeat them.'
    : 'Then send the revised request.';
  return `${history} ${continuation} The session is still active.`;
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

export function errorRecoveryHint(
  code: string | undefined,
  message?: string,
  context?: Pick<TurnSummary, 'memoryPolicy' | 'toolsRan' | 'stoppedAtCheckpoint'>,
): string | undefined {
  switch (code) {
    case 'provider_rate_limit':
      return 'Rate-limited by the provider — Relavium already retried with backoff + failover. The session is still active; resend if the turn did not finish.';
    case 'provider_unavailable':
      return 'The provider was unavailable — Relavium tried the fallback chain. The session is still active; try again.';
    case 'provider_auth':
      return 'Provider authentication failed — check the API key, or unlock the OS keychain if it locked mid-session. The session is still active; fix the key from the Home (/providers) and resend.';
    case 'content_filter':
      return 'The provider blocked the content by its policy. The session is still active; rephrase and resend.';
    case 'context_overflow':
      return undefined; // The visible engine fact and the same policy-aware remedy are in the summary.
    case 'validation':
      // Only the context-overflow shape gets an actionable hint — a generic validation error has no chat-side remedy.
      return looksLikeContextOverflow(message)
        ? `The request exceeded the model context window. ${contextOverflowRemedy(context?.memoryPolicy, context?.toolsRan ?? true)}`
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
      return "The tool was denied. Check the reported reason and the session's permissions or safety requirements. Help: https://github.com/HodeTech/Relavium/blob/main/docs/runbooks/troubleshoot-tool-denials.md. The session is still active.";
    case 'budget_exceeded':
      return 'The turn hit the session cost cap — raise `[chat].max_cost_microcents`, or `/clear` to reset the running total. The session is still active.';
    case 'effect_needs_attention':
      // An external effect whose outcome this process cannot establish (ADR-0080). The session SURVIVES — a
      // chat discloses and continues rather than blocking, because there is no operator queue here — but the
      // hint must not suggest resending: a resend is the duplicate the journal exists to prevent. Point at
      // the target, which is the only place the truth lives.
      return 'A tool may have completed its effect before the error — this is not retried automatically, because retrying could repeat it. The session is still active; check the target before asking again.';
    case 'turn_limit':
      if (context?.stoppedAtCheckpoint !== undefined)
        return 'You stopped the turn at a checkpoint. The session is still active; send another message to continue.';
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

/**
 * Project ONE transcript entry to its LOGICAL display lines — prefixes, styles, and display-boundary sanitization,
 * but NO width-wrapping (a returned `text` may still contain `\n`). The single source of the transcript's rendered
 * CONTENT: {@link wrapEntry} wraps these to terminal rows for the viewport, and {@link transcriptDocument} joins them
 * unwrapped for the `/edit` hatch (2.6.F Step 5d) — so the on-screen transcript and the one handed to `$EDITOR` can
 * never disagree about what the conversation said.
 *
 * Sanitization happens HERE, once, for every consumer: a `user` entry becomes `> {text}` (the TEXT FORM's own prefix,
 * {@link TEXT_FORM_YOUR_TURN}, in every form of the screen: the screen draws the host's marker over it in {@link wrapEntry},
 * and the `/edit`, `/copy` and `/scrollback` documents keep this one); a `notice` its text; an `assistant` entry its
 * text, then the one-line summary (a leading space, as `TranscriptLine`), then the optional recovery-hint line.
 * The marker glyphs of the screen's rows are guarded in {@link wrapEntry}, not here: the documents are the text forms,
 * whose `> ` is the host's own and cannot be blanked (ADR-0145 §6).
 */
export function entryLines(
  entry: TranscriptEntry,
  displays?: ReadonlyMap<string, ToolDisplay>,
): DisplayLine[] {
  if (entry.role === 'tools') {
    const lines: DisplayLine[] = [];
    for (let start = 0; start < entry.calls.length; start += 4)
      lines.push({
        style: 'notice',
        text: entry.calls
          .slice(start, start + 4)
          .map((call) => formatToolCall(call, displays?.get(call.id)))
          .join(' · '),
      });
    if ((entry.omitted ?? 0) > 0) {
      const last = lines.at(-1);
      if (last !== undefined)
        lines[lines.length - 1] = {
          ...last,
          text: last.text + ` · ${entry.omitted} omitted calls`,
        };
      else lines.push({ style: 'notice', text: `${entry.omitted} omitted calls` });
    }
    return lines;
  }
  if (entry.role === 'user') {
    return [{ text: `${TEXT_FORM_YOUR_TURN}${stripTerminalControls(entry.text)}`, style: 'user' }];
  }
  if (entry.role === 'notice') {
    return [{ text: stripTerminalControls(entry.text), style: 'notice' }];
  }
  const lines: DisplayLine[] = [{ text: stripTerminalControls(entry.text), style: 'assistant' }];
  if (entry.summary === undefined) return lines;
  lines.push({ text: ` ${formatTurnSummary(entry.summary)}`, style: 'summary' });
  const hint = errorRecoveryHint(
    entry.summary.errorCode,
    entry.summary.errorMessage,
    entry.summary,
  );
  if (hint !== undefined) lines.push({ text: ` → ${hint}`, style: 'hint' });
  return lines;
}

/** Wrap ONE transcript entry to its width-wrapped display lines — the per-entry unit {@link wrapTranscript} caches. */
const entryParseCache = new WeakMap<TranscriptEntry, readonly MarkdownBlock[]>();

function wrapEntry(
  entry: TranscriptEntry,
  cols: number,
  color: boolean,
  displays?: ReadonlyMap<string, ToolDisplay>,
): DisplayLine[] {
  const wrapped: DisplayLine[] = [];
  // The rows are built in the form the colour setting asks for: the plain glyph forms when colour is off (ADR-0145 §5).
  const source = withGlyphForm(!color, () => entryLines(entry, displays));
  let offset = 0;
  if (color && entry.role === 'assistant') {
    let blocks = entryParseCache.get(entry);
    if (blocks === undefined) {
      blocks = parseMarkdown(source[0]?.text ?? '');
      entryParseCache.set(entry, blocks);
    }
    for (const line of layoutMarkdown(blocks, cols)) {
      wrapped.push({ ...line, style: 'assistant' });
    }
    offset = 1;
  }
  for (const line of source.slice(offset)) {
    for (const row of wrapText(line.text, cols)) wrapped.push({ text: row, style: line.style });
  }
  // The speaker marker's guard (ADR-0145 §6), on the FINISHED rows: after the markdown layout and the wrap, so a row that starts with a marker
  // glyph by wrapping or by layout is guarded as one that started with it in the source; the glyph and the space that replaces it are one column,
  // so no row changes width and the row count is the one the scroll and the selection were built on. The person's own first row gets the host's
  // marker as data.
  const hostNotice = entry.role === 'notice' && entry.hostLead !== undefined;
  return guardEntryRows(entry, wrapped, {
    ascii: !color,
    lineStarts: hostNotice ? logicalLineStarts(source[0]?.text ?? '', cols) : undefined,
  });
}

/**
 * The whole transcript as ONE plain-text document for the `/edit` hatch (2.6.F Step 5d, ADR-0068 §e) — the same
 * sanitized content the viewport shows ({@link entryLines}), joined UNWRAPPED so the user's editor re-flows it at its
 * own width instead of inheriting the terminal's column count. Sanitized like every other display boundary: an editor
 * renders bidi/RTL overrides, so a Trojan-Source reordering (CVE-2021-42574) in model output would spoof the reading
 * order of the very transcript the user opened it to inspect.
 */
export function transcriptDocument(transcript: readonly TranscriptEntry[]): string {
  return transcript.flatMap((entry) => entryLines(entry).map((line) => line.text)).join('\n');
}

/**
 * PER-ENTRY wrap cache (2.6.F Step 4b-3, ADR-0068 §c). A `WeakMap` keyed on the IMMUTABLE, append-only transcript
 * ENTRY object → its last wrap `{ cols, lines }`. `wrapTranscript` re-wraps the whole transcript on each append (a new
 * immutable transcript reference busts the render memo) + on each scroll keypress (`liveScrollGeometry`); caching per
 * entry turns an append into O(history) map lookups + ONE `wrapEntry` (the new entry), and a re-render at an unchanged
 * `cols` is all hits. Unlike a fixed-size LRU it NEVER thrashes on a transcript larger than the cache (the Step-4b-3
 * Opus-review pathology): it holds exactly the live entries (GC reclaims a dropped one), and a resize REPLACES each
 * entry's single cached wrap rather than accumulating. The cached `lines` are shared + read-only (the viewport only
 * reads `text`/`style`).
 */
const entryWrapCache = new WeakMap<
  TranscriptEntry,
  { cols: number; color: boolean; lines: readonly DisplayLine[] }
>();

/**
 * Flatten the completed transcript into width-wrapped, style-tagged {@link DisplayLine}s for the full-screen
 * alt-screen viewport (2.6.F Step 4b, ADR-0068 §c) — the counterpart of ink's `<Static>` on the inline renderer.
 * Reproduces `TranscriptLine`'s CONTENT + prefixes + styles + sanitization: a `user` entry becomes `> {text}` (style
 * `user`); a `notice` its dim text; an `assistant` entry its text, then the gray one-line summary (a leading space,
 * as `TranscriptLine`), then the optional yellow recovery-hint line. Every text is sanitized here at the display
 * boundary (`stripTerminalControls`, newlines kept) exactly as `TranscriptLine` does, so a streamed/pasted control
 * sequence can neither forge a row nor inject ANSI. The wrapping counts RENDERED terminal rows (the viewport scroll
 * math is defined over the returned line count). Inline and full-screen share these word-wrapped rows and semantic
 * spans; color-disabled output wraps the sanitized source, preserving its markers.
 */
export function wrapTranscript(
  transcript: readonly TranscriptEntry[],
  cols: number,
  color = false,
  displays?: ReadonlyMap<string, ToolDisplay>,
): DisplayLine[] {
  if (!Number.isFinite(cols) || cols < 1) return [];
  const out: DisplayLine[] = [];
  for (const entry of transcript) {
    if (entry.role === 'tools' && displays !== undefined) {
      out.push(...wrapEntry(entry, cols, color, displays));
      continue;
    }
    const cached = entryWrapCache.get(entry);
    let lines: readonly DisplayLine[];
    if (cached?.cols === cols && cached.color === color) {
      lines = cached.lines;
    } else {
      lines = wrapEntry(entry, cols, color);
      entryWrapCache.set(entry, { cols, color, lines });
    }
    for (const line of lines) out.push(line);
  }
  return out;
}

/**
 * The LIVE alt-screen scroll geometry for a scroll keypress (2.6.F Step 4b-2, [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c):
 * the transcript wrapped at the CURRENT width for an up-to-the-tick `totalLines`, paired with the viewport's
 * last-measured `height`. The owner reads this by wrapping the store's transcript AT the keypress (a rare, user-driven
 * event — never per frame) so `reduceScroll` sees the freshest bottom, rather than the `onMeasure`-lifted geometry ref
 * which lags by up to one commit: a burst of streamed lines landing between a commit and its post-commit measure
 * effect would leave the ref's `totalLines` UNDER-counted, and `settle` would then resume-follow against that stale
 * (too-small) bottom — yanking a paused reader to the tail on a single PgDn (Step-4b-2 Sonnet review). The `height`
 * lag is benign by contrast: it only changes on a resize / live-region reflow (which re-renders + re-measures), and
 * the viewport re-clamps the window against its own fresh `props.lines.length` regardless.
 */
export function liveScrollGeometry(
  transcript: readonly TranscriptEntry[],
  cols: number,
  measuredHeight: number,
  color = false,
  displays?: ReadonlyMap<string, ToolDisplay>,
): ScrollGeometry {
  return {
    totalLines: wrapTranscript(transcript, cols, color, displays).length,
    height: measuredHeight,
  };
}

/**
 * What `Esc` says while a turn runs (ADR-0145 §2, the decide class: it stops the turn and keeps the session, EA7). One constant for the
 * busy line, the abort hint under streamed content and the paused-display line, so the key says the same words on every state of the turn.
 */
export const STOP_THE_TURN = exitKey.decide('stops the turn');

/** What `Esc` says while a compaction or a `!` command runs: the same abort, stated for what is being cancelled. */
const CANCEL_IT = exitKey.decide('cancels it');

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
 *  3. the pre-first-token live-turn STATUS — `Working… {elapsed} · Esc stops the turn`, a whole-second timer + the abort
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
  /** The terminal's width, for the row estimate. Absent ⇒ the projection's fallback. */
  readonly columns?: number | undefined;
  /** How many rendered rows the streaming content may occupy ({@link liveAnswerRowBudget}). Absent ⇒ unbounded, the
   *  INLINE renderer's behaviour: it has no fixed-height frame to overflow. */
  readonly maxRows?: number | undefined;
}): BusyLine {
  const { spinner } = input;
  if (input.compacting) {
    return {
      text: legend([{ text: `${spinner} ⟳ Summarizing conversation…` }], CANCEL_IT),
      dim: true,
    };
  }
  if (input.busyCommand !== undefined) {
    return {
      text: legend(
        [{ text: `${spinner} ! ${sanitizeInline(input.busyCommand)} — running` }],
        CANCEL_IT,
      ),
      dim: true,
    };
  }
  // While a card waits for the person there is no busy line: the sheet takes the prompt block's place and its rule carries the wait clock
  // (ADR-0147 §2: the `Waiting for your answer` row and its spinner retired).
  // The streamed answer is the model's, and this row is drawn above the prompt among the host's own: it cannot draw a marker (ADR-0145 §6). The
  // glyph and the space that replaces it are one column, so the tail's row estimate below is the one it was.
  const sanitized = blankMarkerGlyphs(stripTerminalControls(input.liveTokens));
  if (sanitized.length === 0) {
    const label = input.reasoningActive === true ? 'Thinking…' : 'Working…';
    const elapsed = input.elapsedMs === undefined ? '' : ` ${formatElapsed(input.elapsedMs)}`;
    return { text: legend([{ text: `${spinner} ${label}${elapsed}` }], STOP_THE_TURN), dim: true };
  }
  // The alt screen's live region is a FIXED-HEIGHT box: an unbounded busy line does not scroll, it collides with its
  // siblings and overwrites them. Bound it to the caller's row budget, the same discipline the reasoning panel uses.
  // The inline renderer passes none — it has no frame to overflow.
  const { body, tailed } =
    input.maxRows === undefined
      ? { body: sanitized, tailed: false }
      : tailToRenderedRows(sanitized, input.columns, input.maxRows);
  const elided = input.liveTokensTruncated || tailed;
  return { text: `${spinner} ${elided ? '…' : ''}${body}`, dim: false };
}

/**
 * The compact mid-stream abort hint (2.5.H / EA7). The pre-first-token STATUS line carries "· Esc stops the turn"
 * inline, and the compaction/shell status lines carry their own "· Esc cancels it" — but once answer CONTENT
 * streams the busy line becomes full-width, wrapping text with no room for the affordance, even though `Esc`
 * still aborts the whole turn. Returns the standalone hint the caller renders as a dim line BENEATH the streaming
 * content, or `undefined` for a STATUS line (`busy.dim`) that already shows its inline hint — so the affordance
 * is visible for the ENTIRE turn without ever double-printing. Keyed off the same `dim` flag the caller maps, so
 * there is one source of truth for status-vs-content.
 */
export function streamingAbortHint(busy: BusyLine): string | undefined {
  return busy.dim ? undefined : legend([], STOP_THE_TURN);
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

/** A row of the in-flight turn drawn above a docked sheet, by its role: the view colours it as the prompt block colours the same row. */
export interface DockedTurnRow {
  readonly text: string;
  readonly tone: 'warning' | 'tool' | 'reasoning' | 'note';
}

/**
 * The rows of the reasoning panel's body a docked sheet leaves it, at most, expanded or not ({@link dockedTurnRows}): the sheet's rule must never
 * stand under a screenful of the model's words.
 */
export const DOCKED_REASONING_BODY_ROWS = 3;
/** The indent of a reasoning body row above a docked sheet: no row of the model's begins where the sheet's rule and the host's rows begin. */
const DOCKED_REASONING_INDENT = '  ';

/**
 * The in-flight turn as it stays on screen while a sheet is docked ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §1, ADR-0129 "the conversation visible above it"): the lead row's warnings (newest first, one row), this turn's tool-call lines with their
 * outcomes, the reasoning panel's header and body, and the interrupt note, each cut to `columns`. NOT the busy line: under a card that waits it
 * would say `Working…`, which is false. At most `maxRows`. The HOST's rows come first (unit 8 fix wave 2, S2-2): the warnings row, the interrupt
 * note and the newest tool lines keep their room, and the reasoning gets only what is left: its header, then at most
 * {@link DOCKED_REASONING_BODY_ROWS} rows of its body (the newest, `…` where the rest was cut), each set in by two columns, so the model's words
 * never fill the rows above the sheet and none of them begins where the sheet's rule does. Pure; it reads the glyph form in force (the caller
 * runs it inside `withGlyphForm`).
 */
export function dockedTurnRows(input: {
  readonly warnings: readonly string[];
  readonly toolLines: readonly string[];
  readonly reasoning: ReasoningPanel | undefined;
  readonly interrupt: string | undefined;
  readonly columns: number;
  readonly maxRows: number;
}): readonly DockedTurnRow[] {
  const width = Math.max(1, Math.floor(input.columns));
  const maxRows = Math.max(0, Math.floor(input.maxRows));
  const row = (text: string, tone: DockedTurnRow['tone']): DockedTurnRow => ({
    text: clipLine(text, width),
    tone,
  });
  const warning =
    input.warnings.length === 0
      ? []
      : [
          row(
            [...input.warnings]
              .reverse()
              .map((said) => `${glyph('warning')} ${stripTerminalControls(said)}`)
              .join('  '),
            'warning',
          ),
        ];
  const interrupt = input.interrupt === undefined ? [] : [row(input.interrupt, 'note')];
  // The newest tool lines take the rows the warnings and the interrupt note leave; the reasoning takes what the tool lines leave.
  const toolRoom = Math.max(0, maxRows - warning.length - interrupt.length);
  const tools =
    toolRoom === 0 ? [] : input.toolLines.slice(-toolRoom).map((line) => row(line, 'tool'));
  const reasoning = dockedReasoningRows(input.reasoning, width, toolRoom - tools.length);
  // Drawn in the turn's own order; a room smaller than the host's own rows keeps the newest of them (the interrupt note last).
  const rows = [...warning, ...tools, ...reasoning, ...interrupt];
  return rows.slice(Math.max(0, rows.length - maxRows));
}

/** The reasoning panel's rows above a docked sheet, in at most `room` rows: its header, then the newest rows of its body, set in, capped. */
function dockedReasoningRows(
  panel: ReasoningPanel | undefined,
  width: number,
  room: number,
): readonly DockedTurnRow[] {
  if (panel === undefined || room < 1) return [];
  const header: DockedTurnRow = { text: clipLine(panel.header, width), tone: 'reasoning' };
  const inner = Math.max(1, width - DOCKED_REASONING_INDENT.length);
  const body = panel.body ?? '';
  const lines = body === '' ? [] : body.split('\n').flatMap((line) => wrapText(line, inner));
  const keep = Math.min(DOCKED_REASONING_BODY_ROWS, room - 1, lines.length);
  if (keep < 1) return [header];
  const shown = lines.slice(-keep);
  if (shown.length < lines.length) shown[0] = `…${shown[0] ?? ''}`;
  return [
    header,
    ...shown.map(
      (line): DockedTurnRow => ({
        text: clipLine(`${DOCKED_REASONING_INDENT}${line}`, width),
        tone: 'reasoning',
      }),
    ),
  ];
}

/**
 * The max terminal ROWS the EXPANDED reasoning body may occupy (2.5.H). The store already bounds the reasoning
 * buffer to {@link MAX_LIVE_TOKEN_CHARS} (4000) CHARACTERS, but on a short/narrow terminal that wraps to many
 * dozens of rows in the live (non-`<Static>`) region — a churning, flickering panel that buries the answer below
 * it. Tailing the DISPLAYED body to the last N rendered rows (see {@link formatReasoningPanel}) keeps the panel
 * compact regardless of terminal size, while the FULL reasoning is still persisted from the raw events.
 */
export const MAX_REASONING_PANEL_LINES = 12;

/** The fallback terminal height when the caller has none (a detached / zero-sized TTY). */
const LIVE_ANSWER_FALLBACK_ROWS = 24;

/**
 * How many rendered rows the STREAMING answer may occupy in the alt screen's fixed-height live region.
 *
 * The frame is `height: rows` and ink clips it there, so an unbounded busy line does not scroll — it COLLIDES with
 * its siblings. Reproduced at 80×24 with a 900-character answer (well under {@link MAX_LIVE_TOKEN_CHARS}): the
 * "Esc to stop" hint and the streamed text landed on the SAME row, overwriting each other, and the transcript
 * viewport was squeezed from 22 rows to 13 (2.6.F Step 6h, Sonnet review).
 *
 * A third of the terminal keeps the viewport, the prompt and the footer intact at every supported size. Nothing is
 * lost: the live region shows a TAIL with the same `…` marker the character cap uses, and the completed turn lands
 * in the transcript whole — since Step 6g's caps-lift, all of it.
 */
export function liveAnswerRowBudget(terminalRows: number | undefined): number {
  const rows =
    terminalRows !== undefined && Math.floor(terminalRows) >= 1
      ? Math.floor(terminalRows)
      : LIVE_ANSWER_FALLBACK_ROWS;
  return Math.max(1, Math.floor(rows / 3));
}

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
 * store's existing `.length`-based cap; the bound is a
 * cosmetic anti-flicker guard, so an off-by-a-row on unusual scripts is acceptable.
 */
function tailToRenderedRows(
  text: string,
  columns: number | undefined,
  maxRows: number = MAX_REASONING_PANEL_LINES,
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
    if (rows + rowsOf(line) > maxRows) {
      // The tail is full. If we have kept nothing yet, this single (oldest-included) line is itself taller than the
      // whole budget — keep only its last budget×width chars so the most recent reasoning still shows. Otherwise
      // stop: the already-kept newer lines fill the budget and older ones are dropped.
      if (kept.length === 0) {
        kept.unshift(line.slice(line.length - maxRows * width));
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
  const header = `✻ Reasoning · ${keyToken('Ctrl+T')} ${input.visible ? 'hide' : 'show'}`;
  if (!input.visible) {
    return { header };
  }
  // The reasoning is the model's words in the live region: it cannot draw a marker either (ADR-0145 §6).
  const { body, tailed } = tailToRenderedRows(
    blankMarkerGlyphs(stripTerminalControls(input.liveReasoning)),
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
export function formatToolCall(call: ToolCallView, display?: ToolDisplay): string {
  return `${glyph('toolCall')} ${toolCallText(call, display)}`;
}

/**
 * The words of a tool-call row without the host's `▸` that leads it: the margin draws the mark on the grid (unit 9), the content column carries
 * this. {@link formatToolCall} is the two joined, so the plain driver and the documents keep today's row byte for byte.
 */
export function toolCallText(call: ToolCallView, display?: ToolDisplay): string {
  const outcome = display?.outcome ?? call.outcome ?? legacyToolOutcome(call);
  // A mark is never alone: the word stands beside the glyph (`denied` is the cancelled glyph with the call's own word).
  const marks = {
    success: glyphWithWord('completed'),
    failure: glyphWithWord('failed'),
    denied: `${glyph('cancelled')} denied`,
    unknown: '? outcome unknown',
    running: '…',
  };
  // The host's own `▸` leads the row; the tool's id and its target are not the host's (a model names the id, a path names the target), so a glyph
  // of the speaker marker's set in either is blanked here, where the row is built: the row cannot be blanked whole (ADR-0145 §6). The target is
  // sanitised by the store that built it; the row strips terminal controls from it again (and makes it one line) rather than trust that.
  const target =
    display?.target === undefined
      ? ''
      : ` → ${blankMarkerGlyphs(sanitizeInline(stripTerminalControls(display.target)))}`;
  const stats =
    display?.stats === undefined
      ? ''
      : ` · +${display.stats.addedLines} -${display.stats.removedLines}`;
  return `${blankMarkerGlyphs(sanitizeInline(stripTerminalControls(call.toolId)))} ${marks[outcome]}${target}${stats}`;
}

function legacyToolOutcome(call: ToolCallView): NonNullable<ToolCallView['outcome']> | 'running' {
  if (!call.resolved) return 'running';
  if (call.success === true) return 'success';
  if (call.success === false) return 'failure';
  return 'unknown';
}

/**
 * The context-fullness footer segment (ADR-0062 §7) — the LAST completed turn's input tokens as a percentage of
 * the model's context window, so an impending auto-compaction is ANTICIPATED rather than a surprise. `undefined`
 * (segment omitted) until a turn has completed AND the window is known (a custom base-URL model has no catalog
 * window). Clamped to [0, 100] so a preamble-heavy over-window turn never prints a nonsensical >100%.
 */
function formatContextFullness(state: SessionViewState): string | undefined {
  const pct = contextFullnessPercent(state);
  return pct === undefined ? undefined : `${pct}% ctx`;
}

/** The figure behind {@link formatContextFullness}, 0 to 100, or `undefined` when there is none to give (no turn completed, or the window is unknown). */
export function contextFullnessPercent(state: SessionViewState): number | undefined {
  const { lastInputTokens, contextWindowTokens } = state;
  if (
    lastInputTokens === undefined ||
    contextWindowTokens === undefined ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((lastInputTokens / contextWindowTokens) * 100)));
}

/**
 * The persistent session footer: the bound model, the running cost, the completed-turn count, and the context
 * fullness (ADR-0062 §7). A compact, always-visible status line beneath the prompt. The model name is sanitized
 * before display; the fullness is numbers-only.
 */
export function formatSessionFooter(state: SessionViewState): string {
  const parts = [
    state.model === undefined ? undefined : sanitizeInline(state.model),
    formatReportedCost(state.cumulativeCostMicrocents, state.usageCoverage, state.unpricedCalls),
    `${state.turnCount} ${state.turnCount === 1 ? 'turn' : 'turns'}`,
    formatContextFullness(state),
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

/**
 * The chat's cost in the two forms its status line needs ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2). `full` is what the old footer wrote, word for word ({@link formatReportedCost}: `$0.1235`, or `$0.1235 known; usage unverified` when the
 * accounting could not verify the figure). `qualified` is whether any qualifier is present, which is whether the amount is only what is KNOWN.
 * `short` is the same amount with the language's own qualifier and no reasons: `$0.1235 known`. It is the FIRST WORDS of the full form, so the
 * short form needs no new notation and no legend of its own (`known` says the figure is the known part of a bigger unknown), a bare amount
 * never stands for a qualified one, and the full form, which has room whenever the line does, says why. An unqualified cost is its own short form.
 */
export function chatCostForms(state: SessionViewState): {
  readonly full: string;
  readonly short: string;
  readonly qualified: boolean;
} {
  const full = formatReportedCost(
    state.cumulativeCostMicrocents,
    state.usageCoverage,
    state.unpricedCalls,
  );
  const amount = formatUsd(state.cumulativeCostMicrocents);
  const qualified = full !== amount;
  return { full, short: qualified ? `${amount} known` : full, qualified };
}
