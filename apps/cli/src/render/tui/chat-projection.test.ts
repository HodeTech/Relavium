import { describe, expect, it } from 'vitest';

import type { ToolApprovalRequest } from '@relavium/core';
import { ERROR_CODES } from '@relavium/shared';

import {
  entryLines,
  errorRecoveryHint,
  formatApprovalTarget,
  formatBusyLine,
  formatReasoningPanel,
  formatSessionFooter,
  formatSessionFooterWithMode,
  formatToolCall,
  formatTurnSummary,
  liveScrollGeometry,
  MAX_APPROVAL_REASON_CHARS,
  MAX_REASONING_PANEL_LINES,
  reasoningLabelActive,
  sanitizeApprovalReason,
  sanitizeInline,
  transcriptDocument,
  streamingAbortHint,
  stripTerminalControls,
  wrapTranscript,
  liveAnswerRowBudget,
} from './chat-projection.js';
import { formatDuration, formatTokens } from './format.js';
import {
  initialSessionViewState,
  type TranscriptEntry,
  INLINE_TRANSCRIPT_BOUND,
} from './session-view-model.js';

describe('chat-projection', () => {
  describe('formatTurnSummary', () => {
    it('renders the stop reason, the token counts, and the duration for a successful turn', () => {
      const line = formatTurnSummary({
        stopReason: 'stop',
        tokensUsed: { input: 10, output: 5 },
        durationMs: 1500,
      });
      const parts = line.split(' · ');
      expect(parts).toHaveLength(3); // stop · tokens · duration
      expect(parts[0]).toBe('stop');
      expect(line).toContain(formatTokens({ input: 10, output: 5 })); // the token segment is rendered
      expect(line).toContain(formatDuration(1500)); // the duration segment is rendered
    });

    it('surfaces the error code (not the stop reason) for a failed turn', () => {
      const line = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'turn_limit',
      });
      expect(line).toContain('error: turn_limit');
    });

    it('renders the producing model as "via {model}" ONLY when set (2.5.H failover attribution)', () => {
      const base = {
        stopReason: 'stop' as const,
        tokensUsed: { input: 10, output: 5 },
        durationMs: 1200,
      };
      // A plain turn (no failover) carries no model ⇒ the summary is unchanged (the footer shows the bound model).
      expect(formatTurnSummary(base)).not.toContain('via');
      const withModel = formatTurnSummary({ ...base, model: 'claude-opus-4-8' });
      expect(withModel).toContain('via claude-opus-4-8');
      // Order: stop · via {model} · tokens · duration
      expect(withModel.split(' · ')).toEqual([
        'stop',
        'via claude-opus-4-8',
        formatTokens({ input: 10, output: 5 }),
        formatDuration(1200),
      ]);
    });

    it('sanitizes the producing model name (a control sequence cannot ride the attribution segment)', () => {
      const line = formatTurnSummary({
        stopReason: 'stop',
        tokensUsed: { input: 1, output: 1 },
        model: 'evil\x1b[31mmodel', // a real ANSI CSI color escape embedded in the id
      });
      expect(line).toContain('via evilmodel'); // the ANSI is stripped at the display boundary
      expect(line).not.toContain('\x1b'); // …and no raw ESC byte reaches the terminal
    });

    it('surfaces the secret-free REASON for a tool_denied / tool_unavailable turn (the actionable ADR-0057 codes)', () => {
      const denied = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'tool_denied',
        errorMessage: 'not allowed in ask mode (read-only)',
      });
      expect(denied).toContain('error: tool_denied — not allowed in ask mode (read-only)');
      const unavailable = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'tool_unavailable',
        errorMessage: 'fs (read-only in this session)',
      });
      expect(unavailable).toContain('error: tool_unavailable — fs (read-only in this session)');
    });

    it('surfaces the PROVIDER status message for a provider_* / content_filter turn (already secret-scrubbed at the seam)', () => {
      // The 402 "Insufficient Balance" case: the classifier now maps it to provider_auth (not internal), and the
      // footer shows the upstream message so the user sees WHY — a provider status line, not a prompt echo.
      const auth = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'provider_auth',
        errorMessage: '402 Insufficient Balance',
      });
      expect(auth).toContain('error: provider_auth — 402 Insufficient Balance');
      for (const code of [
        'provider_rate_limit',
        'provider_unavailable',
        'content_filter',
      ] as const) {
        const line = formatTurnSummary({
          stopReason: 'error',
          tokensUsed: { input: 0, output: 0 },
          errorCode: code,
          errorMessage: 'upstream reason',
        });
        expect(line).toContain(`error: ${code} — upstream reason`);
      }
    });

    it('does NOT render the message for a non-whitelisted code (it may carry prompt context)', () => {
      const line = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'execution_failed',
        errorMessage: 'some model-derived context that must not be shown',
      });
      expect(line).toContain('error: execution_failed');
      expect(line).not.toContain('model-derived context');
    });

    it('shows a STATIC actionable hint for a tool_failed turn, never echoing the (context-carrying) message', () => {
      // ADR-0057 (A): a tool_failed message MAY carry model/MCP-server context (so it stays OUT of
      // SAFE_MESSAGE_CODES), but a bare `error: tool_failed` is unhelpful — render a host-authored STATIC hint
      // at the #1 real cause (a path outside the session workspace) WITHOUT echoing errorMessage.
      const line = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'tool_failed',
        errorMessage: 'some model/MCP-derived context that must not be shown',
      });
      expect(line).toContain('error: tool_failed —'); // an actionable hint, not the bare code
      expect(line).toContain("outside this session's workspace");
      expect(line).not.toContain('model/MCP-derived context'); // the raw message is NOT echoed (F4 constraint)
    });

    it('terminal-sanitizes the rendered reason (strips ANSI/OSC/control bytes) and omits an empty reason', () => {
      const ESC = String.fromCharCode(0x1b);
      const BEL = String.fromCharCode(0x07);
      const line = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'tool_denied',
        errorMessage: `${ESC}]0;pwn${BEL}denied\r\n here`, // an OSC title-set + BEL + CRLF
      });
      // eslint-disable-next-line no-control-regex -- asserting NO control byte survives the sanitizer
      expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false); // no raw control byte reaches the terminal
      expect(line).toContain('error: tool_denied');
      // A whitespace-only reason renders the bare code (no dangling em-dash).
      const empty = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'tool_denied',
        errorMessage: '   ',
      });
      expect(empty.split(' \u00b7 ')[0]).toBe('error: tool_denied');
    });

    it('renders the EA7 "aborted" stop reason as a plain label (no error segment)', () => {
      const line = formatTurnSummary({
        stopReason: 'aborted',
        tokensUsed: { input: 7, output: 4 },
      });
      const parts = line.split(' · ');
      expect(parts[0]).toBe('aborted'); // the aborted turn renders its stop reason, not an error
      expect(line).not.toContain('error');
      expect(line).toContain(formatTokens({ input: 7, output: 4 }));
    });

    it('omits the duration segment when the duration is unknown (stop + tokens only)', () => {
      const line = formatTurnSummary({ stopReason: 'stop', tokensUsed: { input: 1, output: 1 } });
      const parts = line.split(' · ');
      expect(parts).toHaveLength(2); // stop · tokens — the duration segment is ABSENT
      expect(parts[0]).toBe('stop');
      expect(parts[1]).toBe(formatTokens({ input: 1, output: 1 }));
    });
  });

  describe('errorRecoveryHint (2.5.H actionable error taxonomy)', () => {
    // The codes that deliberately get NO unconditional hint — user-initiated or WorkflowEngine-only (not
    // chat-reachable). `validation` is MESSAGE-conditional (only the context-overflow shape, covered by the
    // heuristic test below). Every OTHER `ErrorCode` MUST have a session-survives hint; deriving from ERROR_CODES
    // makes a NEW code force a decision here (the test fails until it is classified) rather than silently
    // falling through to no hint.
    const NO_HINT: ReadonlySet<string> = new Set(['cancelled', 'sandbox_error', 'run_timeout']);
    const CONDITIONAL: ReadonlySet<string> = new Set(['validation']);

    it('classifies EVERY ErrorCode: a session-survives hint, or a deliberate no-hint (drift-guarded)', () => {
      for (const code of ERROR_CODES) {
        if (CONDITIONAL.has(code)) continue; // message-dependent — asserted by the heuristic test below
        const hint = errorRecoveryHint(code);
        if (NO_HINT.has(code)) {
          expect(hint, code).toBeUndefined();
        } else {
          expect(hint, code).toBeDefined();
          expect(hint, code).toContain('session is still active');
        }
      }
      expect(errorRecoveryHint(undefined)).toBeUndefined(); // a successful/aborted turn carries no code
    });

    it('hints /compact·/trim for a context-overflow validation (the message heuristic), else no hint', () => {
      for (const msg of [
        "This model's maximum context length is 8192 tokens", // OpenAI
        'prompt is too long: 210000 tokens > 200000 maximum', // Anthropic form 1
        'input length and max_tokens exceed context limit: 200500 > 200000', // Anthropic form 2
        'input token count (1050000) exceeds the maximum number of tokens', // Gemini
      ]) {
        const hint = errorRecoveryHint('validation', msg);
        expect(hint, msg).toContain('/compact');
        expect(hint, msg).toContain('context window');
      }
      // A generic validation error (no context markers) has no chat-side remedy ⇒ no hint (just the bare code shows).
      expect(errorRecoveryHint('validation', 'field `model` is required')).toBeUndefined();
      expect(errorRecoveryHint('validation')).toBeUndefined();
    });

    it('does NOT false-match a param-range validation error (the markers are context/token-qualified)', () => {
      // A 400 for an out-of-range parameter must NOT suggest /compact — the markers deliberately dropped the bare
      // "exceeds the maximum" / "token limit" phrasings that these would otherwise trip.
      expect(
        errorRecoveryHint('validation', 'temperature 3.0 exceeds the maximum of 2.0'),
      ).toBeUndefined();
      expect(
        errorRecoveryHint('validation', 'max_tokens 999999 is above the model token limit'),
      ).toBeUndefined();
    });

    it('NEVER echoes the provider message — the hint is a static host string (security)', () => {
      // The heuristic READS the message to pick the hint, but the returned text is static — a secret-ish substring
      // in the message must never reach the terminal through the hint.
      const hint = errorRecoveryHint(
        'validation',
        'context length exceeded; key=sk-LEAK-should-not-appear',
      );
      expect(hint).toContain('/compact'); // the heuristic matched ("context length")
      expect(hint).not.toContain('sk-LEAK'); // …but the raw message is NOT echoed
    });
  });

  describe('formatToolCall', () => {
    it('marks an unresolved call as pending and a resolved call as done — id only, no arguments', () => {
      expect(formatToolCall({ id: 'tc-1', toolId: 'read_file', resolved: false })).toBe(
        '→ read_file …',
      );
      expect(formatToolCall({ id: 'tc-1', toolId: 'read_file', resolved: true })).toBe(
        '→ read_file ✓',
      );
    });

    it('sanitizes a model-named tool id so it cannot inject control sequences or spoof lines', () => {
      const line = formatToolCall({
        id: 'tc-1',
        toolId: '\x1b[31mread\x1b]0;x\x07\nfile',
        resolved: false,
      });
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(line).not.toMatch(/[\x00-\x1f\x7f]/); // no ESC/CR/NUL/tab/newline survived
      expect(line).toBe('→ read file …'); // escapes stripped; the bare newline collapsed to a space
    });
  });

  describe('formatBusyLine (2.5.H live-turn feedback)', () => {
    const base = {
      spinner: '⠋',
      compacting: false,
      liveTokens: '',
      liveTokensTruncated: false,
    } as const;

    it('renders the compaction moment first (dim, ADR-0062 §7), winning over every other state', () => {
      const line = formatBusyLine({ ...base, compacting: true, liveTokens: 'ignored' });
      expect(line).toEqual({ text: '⠋ ⟳ Summarizing conversation… · Esc to cancel', dim: true });
      // Compaction has top priority — even paired with a (mutually-exclusive in practice) shell command it wins.
      const withShell = formatBusyLine({ ...base, compacting: true, busyCommand: 'npm test' });
      expect(withShell.text).toBe('⠋ ⟳ Summarizing conversation… · Esc to cancel');
    });

    it('renders the `!`-shell command line (dim) and sanitizes the command', () => {
      const line = formatBusyLine({ ...base, busyCommand: 'npm\x1b[31m test' });
      expect(line.dim).toBe(true);
      expect(line.text).toBe('⠋ ! npm test — running · Esc to cancel'); // ANSI stripped
    });

    it('shows the pre-first-token status with the live elapsed + abort hint (dim)', () => {
      const line = formatBusyLine({ ...base, elapsedMs: 3200 });
      expect(line).toEqual({ text: '⠋ Working… 3s · Esc to stop', dim: true });
    });

    it('omits the timer when no turn is in flight yet (elapsedMs undefined)', () => {
      const line = formatBusyLine(base);
      expect(line).toEqual({ text: '⠋ Working… · Esc to stop', dim: true });
    });

    it('renders streaming content plain (not dim) with the spinner and no elision when untruncated', () => {
      const line = formatBusyLine({ ...base, liveTokens: 'hello world', elapsedMs: 9999 });
      expect(line).toEqual({ text: '⠋ hello world', dim: false }); // the timer is not shown once content streams
    });

    it('prefixes a leading elision marker flush against the content when the head scrolled out', () => {
      const line = formatBusyLine({ ...base, liveTokens: 'tail', liveTokensTruncated: true });
      expect(line.text).toBe('⠋ …tail'); // "…" is adjacent to the content — no spurious space
      expect(line.dim).toBe(false);
    });

    it('sanitizes streamed content (a control byte cannot reach the terminal)', () => {
      const line = formatBusyLine({ ...base, liveTokens: 'ok\x1b[2Jclear' });
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(line.text).not.toMatch(/\x1b/);
      expect(line.text).toBe('⠋ okclear');
    });

    it('labels the pre-token status "Thinking…" when reasoning is active, else "Working…" (2.5.H)', () => {
      expect(formatBusyLine({ ...base, reasoningActive: true, elapsedMs: 2000 }).text).toBe(
        '⠋ Thinking… 2s · Esc to stop',
      );
      expect(formatBusyLine({ ...base, elapsedMs: 2000 }).text).toBe('⠋ Working… 2s · Esc to stop');
      // Once answer tokens stream, the content wins regardless of reasoningActive (no label).
      expect(formatBusyLine({ ...base, reasoningActive: true, liveTokens: 'hi' }).text).toBe(
        '⠋ hi',
      );
    });
  });

  describe('streamingAbortHint (2.5.H / EA7 — the abort affordance persists during streaming)', () => {
    const base = {
      spinner: '⠋',
      compacting: false,
      liveTokens: '',
      liveTokensTruncated: false,
    } as const;

    it('returns the standalone hint for a streaming CONTENT line (which has no inline hint)', () => {
      const content = formatBusyLine({ ...base, liveTokens: 'the answer streams' });
      expect(content.dim).toBe(false);
      expect(streamingAbortHint(content)).toBe('Esc to stop');
    });

    it('returns undefined for every STATUS line — they already carry their own inline hint (no double-print)', () => {
      // Pre-token ("· Esc to stop"), compaction ("· Esc to cancel"), and shell ("· Esc to cancel") are all dim.
      expect(streamingAbortHint(formatBusyLine({ ...base, elapsedMs: 1000 }))).toBeUndefined();
      expect(streamingAbortHint(formatBusyLine({ ...base, compacting: true }))).toBeUndefined();
      expect(
        streamingAbortHint(formatBusyLine({ ...base, busyCommand: 'npm test' })),
      ).toBeUndefined();
    });
  });

  describe('reasoningLabelActive (2.5.H — Thinking… only when no tool is executing)', () => {
    const call = (resolved: boolean) => ({ id: 't', toolId: 'read_file', resolved });

    it('is true when reasoning streamed and every tool call is resolved (or there are none)', () => {
      expect(reasoningLabelActive(true, [])).toBe(true); // the initial thinking phase (no tools yet)
      expect(reasoningLabelActive(true, [call(true)])).toBe(true); // a resolved tool ⇒ back to thinking/composing
    });

    it('is false while ANY tool call is unresolved (the model idle-waits — show "Working…")', () => {
      expect(reasoningLabelActive(true, [call(false)])).toBe(false);
      expect(reasoningLabelActive(true, [call(true), call(false)])).toBe(false); // a mix ⇒ still executing
    });

    it('is false when no reasoning streamed this turn (a plain turn)', () => {
      expect(reasoningLabelActive(false, [])).toBe(false);
      expect(reasoningLabelActive(false, [call(true)])).toBe(false);
    });
  });

  describe('formatReasoningPanel (2.5.H thinking panel)', () => {
    const base = { liveReasoning: 'weighing the options', liveReasoningTruncated: false } as const;

    it('collapsed: a header with the "show" hint and NO body', () => {
      const panel = formatReasoningPanel({ ...base, visible: false });
      expect(panel).toEqual({ header: '✻ Reasoning · Ctrl+T show' });
      expect(panel.body).toBeUndefined();
    });

    it('expanded: the header switches to "hide" and the sanitized body is present', () => {
      const panel = formatReasoningPanel({ ...base, visible: true });
      expect(panel.header).toBe('✻ Reasoning · Ctrl+T hide');
      expect(panel.body).toBe('weighing the options');
    });

    it('prefixes a leading elision marker on the body when the buffer head scrolled out', () => {
      const panel = formatReasoningPanel({
        liveReasoning: 'tail thoughts',
        liveReasoningTruncated: true,
        visible: true,
      });
      expect(panel.body).toBe('…tail thoughts');
    });

    it('sanitizes the reasoning body (newline-preserving) so a control sequence cannot reach the terminal', () => {
      const panel = formatReasoningPanel({
        liveReasoning: 'line1\x1b[31m\nline2',
        liveReasoningTruncated: false,
        visible: true,
      });
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(panel.body).not.toMatch(/\x1b/);
      expect(panel.body).toBe('line1\nline2'); // ANSI stripped, the newline (multi-line prose) kept
    });

    describe('bounds the expanded body to the last N rendered rows (2.5.H)', () => {
      it('keeps every line when the body fits within the row budget', () => {
        const body = ['a', 'b', 'c'].join('\n');
        const panel = formatReasoningPanel({
          liveReasoning: body,
          liveReasoningTruncated: false,
          visible: true,
          columns: 80,
        });
        expect(panel.body).toBe(body); // under budget ⇒ no tail, no marker
      });

      it('keeps everything with NO marker when the rows sum to EXACTLY the budget', () => {
        // Exactly MAX one-char lines at width 80 = exactly 12 rendered rows — the boundary case: the loop ends
        // naturally (nothing dropped), so `tailed` is false and no leading marker is added.
        const lines = Array.from({ length: MAX_REASONING_PANEL_LINES }, (_, i) => String(i));
        const body = lines.join('\n');
        const panel = formatReasoningPanel({
          liveReasoning: body,
          liveReasoningTruncated: false,
          visible: true,
          columns: 80,
        });
        expect(panel.body).toBe(body); // == budget ⇒ kept whole, no `…`
      });

      it('tails MANY short lines to the last N and prefixes the elision marker', () => {
        // 30 one-char lines = 30 rendered rows (each short line is its own row) — well over the 12-row budget.
        const lines = Array.from({ length: 30 }, (_, i) => String(i));
        const panel = formatReasoningPanel({
          liveReasoning: lines.join('\n'),
          liveReasoningTruncated: false,
          visible: true,
          columns: 80,
        });
        const kept = lines.slice(lines.length - MAX_REASONING_PANEL_LINES); // the most-recent N
        expect(panel.body).toBe(`…${kept.join('\n')}`);
      });

      it('counts WRAPPED rows: one long logical line spends multiple rows of the budget (narrow terminal)', () => {
        // At width 10, a 25-char line wraps to ceil(25/10)=3 rows. With three such lines (9 rows) plus a fourth
        // (→12) the budget is exactly full; a fifth older line (would be 15) is dropped.
        const long = (tag: string): string => `${tag}`.padEnd(25, '.');
        const lines = [long('oldest'), long('l2'), long('l3'), long('l4'), long('newest')];
        const panel = formatReasoningPanel({
          liveReasoning: lines.join('\n'),
          liveReasoningTruncated: false,
          visible: true,
          columns: 10,
        });
        // 4 lines × 3 rows = 12 rows = the budget; the oldest is dropped, so the marker shows.
        expect(panel.body).toBe(`…${lines.slice(1).join('\n')}`);
      });

      it('slices the HEAD of a single line that alone exceeds the whole budget (keeps its tail)', () => {
        // One 200-char line at width 10 = 20 rows > the 12-row budget; keep only the last 12×10 = 120 chars.
        const line = 'x'.repeat(200);
        const panel = formatReasoningPanel({
          liveReasoning: line,
          liveReasoningTruncated: false,
          visible: true,
          columns: 10,
        });
        expect(panel.body).toBe(`…${'x'.repeat(MAX_REASONING_PANEL_LINES * 10)}`);
      });

      it('ORs the row-tail elision with the store char-cap marker (one leading marker either way)', () => {
        const lines = Array.from({ length: 30 }, (_, i) => String(i));
        const panel = formatReasoningPanel({
          liveReasoning: lines.join('\n'),
          liveReasoningTruncated: true, // the store already elided the head too
          visible: true,
          columns: 80,
        });
        expect(panel.body?.startsWith('…')).toBe(true);
        expect(panel.body?.startsWith('……')).toBe(false); // exactly one marker, not doubled
      });

      it('falls back to an 80-col assumption when no width is passed (headless/test render)', () => {
        // A 400-char single line: at the 80-col fallback that is 5 rows (< budget) ⇒ kept whole, no tail.
        const line = 'y'.repeat(400);
        const panel = formatReasoningPanel({
          liveReasoning: line,
          liveReasoningTruncated: false,
          visible: true,
        });
        expect(panel.body).toBe(line);
      });

      it('falls back to 80 cols for a non-positive/fractional width (guards the div-by-zero floor)', () => {
        // The width guard is `Math.floor(columns) >= 1` — 0 / 0.5 / negative / NaN all take the 80-col fallback
        // (no divide-by-zero, no negative slice). A 400-char line = 5 rows at 80 ⇒ kept whole, proving the width.
        const line = 'y'.repeat(400);
        for (const columns of [0, 0.5, -5, Number.NaN]) {
          const panel = formatReasoningPanel({
            liveReasoning: line,
            liveReasoningTruncated: false,
            visible: true,
            columns,
          });
          expect(panel.body).toBe(line); // 80-col fallback ⇒ under budget ⇒ no crash, no tail
        }
      });

      it('does NOT count a trailing newline as a rendered row (no premature drop between stream chunks)', () => {
        // A live buffer cut off right after a line break ends in '\n'. The MAX real lines alone fit the budget
        // exactly; the trailing '\n' must not spend a phantom row that drops the oldest real line + flashes `…`.
        const lines = Array.from({ length: MAX_REASONING_PANEL_LINES }, (_, i) => String(i));
        const panel = formatReasoningPanel({
          liveReasoning: `${lines.join('\n')}\n`, // trailing newline (mid-stream cut)
          liveReasoningTruncated: false,
          visible: true,
          columns: 80,
        });
        expect(panel.body).toBe(lines.join('\n')); // every real line kept, no leading marker
      });

      it('keeps an INTENTIONAL trailing blank line (only the final cursor newline is dropped)', () => {
        // "a\n\n" is a line + a deliberate blank line + the cursor newline; stripping ONE '\n' keeps the blank.
        const panel = formatReasoningPanel({
          liveReasoning: 'a\n\n',
          liveReasoningTruncated: false,
          visible: true,
          columns: 80,
        });
        expect(panel.body).toBe('a\n'); // the intentional blank line survives; only the trailing cursor newline goes
      });
    });
  });

  describe('formatSessionFooter', () => {
    it('shows the model, running cost, and pluralized turn count', () => {
      const base = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
      const one = formatSessionFooter({
        ...base,
        model: 'claude-sonnet-4-6',
        turnCount: 1,
        cumulativeCostMicrocents: 12_345,
      });
      expect(one).toContain('claude-sonnet-4-6');
      expect(one).toContain('1 turn');
      expect(one).not.toContain('1 turns');
      expect(one).toMatch(/\$\d/); // the formatted USD cost is present

      const many = formatSessionFooter({ ...base, model: 'gpt-4o', turnCount: 3 });
      expect(many).toContain('3 turns');
    });

    it('omits the model segment before session:started resolves it (cost + turns only)', () => {
      const footer = formatSessionFooter(
        initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
      );
      expect(footer).toContain('0 turns');
      expect(footer).toMatch(/^\$/); // starts with the cost (no leading model segment / separator)
    });

    it('sanitizes the model name so it cannot inject control sequences into the footer', () => {
      const footer = formatSessionFooter({
        ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
        model: '\x1b[31mevil\x07\nmodel',
      });
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(footer).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(footer.startsWith('evil model · ')).toBe(true); // escapes stripped; newline collapsed
    });

    it('appends the context-fullness segment (last input ÷ window) after a turn completes (ADR-0062 §7)', () => {
      const footer = formatSessionFooter({
        ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
        model: 'claude-sonnet-4-6',
        lastInputTokens: 500_000,
        contextWindowTokens: 1_000_000,
        turnCount: 2,
      });
      expect(footer).toContain('50% ctx');
    });

    it('omits the fullness segment with no completed turn OR an unknown (custom-model) window', () => {
      // A known window but no lastInputTokens (no turn yet) ⇒ no segment.
      expect(
        formatSessionFooter({
          ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
          contextWindowTokens: 1_000_000,
        }),
      ).not.toContain('% ctx');
      // A last-turn count but an unknown window (a custom base-URL model) ⇒ no segment.
      expect(
        formatSessionFooter({
          ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
          lastInputTokens: 100,
        }),
      ).not.toContain('% ctx');
    });

    it('clamps the fullness to 100% for a preamble-heavy over-window turn', () => {
      const footer = formatSessionFooter({
        ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
        lastInputTokens: 1_500_000,
        contextWindowTokens: 1_000_000,
      });
      expect(footer).toContain('100% ctx');
    });
  });

  describe('formatSessionFooterWithMode', () => {
    it('appends the active mode label to the footer (always shown — auto is never hidden)', () => {
      const state = {
        ...initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND),
        turnCount: 2,
      };
      expect(formatSessionFooterWithMode(state, 'ask')).toMatch(/· ask mode$/);
      expect(formatSessionFooterWithMode(state, 'accept-edits')).toMatch(/· accept-edits mode$/);
      expect(formatSessionFooterWithMode(state, 'auto')).toMatch(/· auto mode$/);
    });
  });

  describe('formatApprovalTarget', () => {
    const req = (preview: ToolApprovalRequest['preview']): ToolApprovalRequest => ({
      toolId: 'write_file',
      action: 'fs_write',
      preview,
    });
    it('surfaces the resolved path / command / host from the preview', () => {
      expect(formatApprovalTarget(req({ path: 'notes.md' }))).toBe('notes.md');
      expect(formatApprovalTarget(req({ command: 'git commit' }))).toBe('git commit');
      expect(formatApprovalTarget(req({ host: 'example.com' }))).toBe('example.com');
    });
    it('is empty when the preview carries no target (web_search / mcp_call)', () => {
      expect(formatApprovalTarget(req({}))).toBe('');
    });
    it('sanitizes the target so a preview value cannot inject control sequences', () => {
      const target = formatApprovalTarget(req({ path: '\x1b[31mx\x07\nname' }));
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(target).not.toMatch(/[\x00-\x1f\x7f]/);
    });
  });

  describe('stripTerminalControls', () => {
    it('removes ANSI CSI + OSC escapes and bare control bytes, keeping printable text + tab/newline', () => {
      // OSC title-write, CSI color, a CR, a NUL — all stripped; the real text + \n + \t survive.
      const dirty = '\x1b]0;pwned\x07\x1b[31mred\x1b[0m\rdata\x00\tend\n';
      const clean = stripTerminalControls(dirty);
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/); // no remaining control bytes (incl. ESC, CR, NUL)
      expect(clean).toContain('red');
      expect(clean).toContain('data');
      expect(clean).toContain('\tend\n'); // tab + newline preserved
    });

    it('leaves clean text untouched', () => {
      expect(stripTerminalControls('hello world')).toBe('hello world');
    });

    it('an UNterminated OSC strips only its 2-byte introducer, preserving the following text (no silent erase)', () => {
      // The OSC terminator is required: an unterminated ESC] must NOT swallow the rest of the string.
      const out = stripTerminalControls('Use \x1b]0;title here and more text.');
      expect(out).toBe('Use 0;title here and more text.'); // ESC] gone; the rest survives
      // eslint-disable-next-line no-control-regex -- asserting the ESC byte is gone
      expect(out).not.toMatch(/\x1b/);
    });

    it('fully consumes a terminated DCS/APC/PM string sequence (payload does not leak through)', () => {
      // DCS ESC P … ST and APC ESC _ … BEL are stripped whole — no leftover payload (the old 3rd arm left it).
      expect(stripTerminalControls('a\x1bPpayload\x1b\\b')).toBe('ab');
      expect(stripTerminalControls('a\x1b_apc\x07b')).toBe('ab');
    });

    it('strips Unicode bidi/format controls - the Trojan-Source floor (Step 14)', () => {
      // The standard Trojan-Source family: overrides/embeddings U+202A-202E, isolates U+2066-2069, and the
      // marks LRM/RLM/ALM. None is in the C0/C1 range BARE_CONTROLS strips, so each would otherwise survive.
      const bidi = [
        '\u202A',
        '\u202B',
        '\u202C',
        '\u202D',
        '\u202E',
        '\u2066',
        '\u2067',
        '\u2068',
        '\u2069',
        '\u200E',
        '\u200F',
        '\u061C',
      ];
      for (const c of bidi) {
        expect(stripTerminalControls(`a${c}b`)).toBe('ab');
      }
    });

    it('flattens a Trojan-Source-style RLO spoof to its logical byte order', () => {
      // RLO then PDF would render the middle reversed as a visual spoof; stripped, only the logical text
      // survives, so what the user SEES equals the bytes (an approval-prompt path cannot lie).
      const spoof = `rm -rf \u202E/nimda\u202C safe`;
      const clean = stripTerminalControls(spoof);
      expect(clean).toBe('rm -rf /nimda safe'); // both controls gone; logical order preserved
      expect(clean).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    });

    it('preserves ZWJ / ZWNJ (legitimate in emoji sequences + Indic/Arabic shaping)', () => {
      // ZWJ (U+200D) joins emoji; ZWNJ (U+200C) is a real letter-shaping control - neither reorders text, so
      // both must survive (an over-broad strip would mangle names / emoji).
      expect(stripTerminalControls('a\u200Db')).toBe('a\u200Db');
      expect(stripTerminalControls('a\u200Cb')).toBe('a\u200Cb');
    });

    it('strips bidi controls through sanitizeInline too (shared primitive, all surfaces)', () => {
      // sanitizeInline builds on stripTerminalControls, so an id/model/path field is bidi-safe everywhere.
      expect(sanitizeInline('git\u202Estatus')).toBe('gitstatus');
    });
  });

  describe('sanitizeApprovalReason ([c] typed denial reason, Step 14)', () => {
    it('returns undefined for an empty / whitespace-only reason (degrades to a plain reject)', () => {
      expect(sanitizeApprovalReason('')).toBeUndefined();
      expect(sanitizeApprovalReason('   \t  ')).toBeUndefined();
    });

    it('trims + collapses to one line and keeps a normal reason', () => {
      expect(sanitizeApprovalReason('  use the project config instead  ')).toBe(
        'use the project config instead',
      );
      expect(sanitizeApprovalReason('line1\nline2')).toBe('line1 line2'); // newline collapsed to a space
    });

    it('strips terminal + bidi controls (secret-free-shaped, spoof-free) from the reason', () => {
      const RLO = String.fromCharCode(0x202e);
      const ESC = String.fromCharCode(0x1b);
      expect(sanitizeApprovalReason(`no ${RLO}spoof`)).toBe('no spoof'); // bidi gone
      expect(sanitizeApprovalReason(`no ${ESC}[31mansi`)).toBe('no ansi'); // ANSI gone
    });

    it('caps the reason at MAX_APPROVAL_REASON_CHARS (a pasted wall of text cannot blow up an error line)', () => {
      const long = 'x'.repeat(MAX_APPROVAL_REASON_CHARS + 50);
      expect(sanitizeApprovalReason(long)).toHaveLength(MAX_APPROVAL_REASON_CHARS);
    });

    it('does not leave a lone surrogate when the cap lands mid-astral-pair', () => {
      // A run of (MAX-1) ASCII then an astral emoji (2 UTF-16 units): the naive slice(0, MAX) would keep the
      // high surrogate and drop the low — a `�`. The back-off drops the whole pair (result is MAX-1 chars).
      const reason = `${'a'.repeat(MAX_APPROVAL_REASON_CHARS - 1)}😀tail`;
      const out = sanitizeApprovalReason(reason);
      expect(out).toHaveLength(MAX_APPROVAL_REASON_CHARS - 1); // the split emoji was dropped whole
      expect(out).toBe('a'.repeat(MAX_APPROVAL_REASON_CHARS - 1));
      // No unpaired surrogate survived (each code unit is a full BMP code point).
      for (const ch of out ?? '') expect(ch.codePointAt(0)).toBeLessThan(0xd800);
    });
  });

  describe('wrapTranscript (2.6.F Step 4b — alt-screen viewport flattening, ADR-0068 §c)', () => {
    it('flattens a user entry to a `> `-prefixed cyan line, wrapped at cols', () => {
      const entries: TranscriptEntry[] = [{ role: 'user', text: 'hello world' }];
      const lines = wrapTranscript(entries, 80);
      expect(lines).toEqual([{ text: '> hello world', style: 'user' }]);
      // Wrapped at a narrow width, the `> ` counts toward the first line's 6 cells; continuations carry no prefix.
      expect(wrapTranscript(entries, 6)).toEqual([
        { text: '> hell', style: 'user' },
        { text: 'o worl', style: 'user' },
        { text: 'd', style: 'user' },
      ]);
    });

    it('flattens a notice entry to dim lines, splitting on embedded newlines', () => {
      const entries: TranscriptEntry[] = [{ role: 'notice', text: 'line one\nline two' }];
      expect(wrapTranscript(entries, 80)).toEqual([
        { text: 'line one', style: 'notice' },
        { text: 'line two', style: 'notice' },
      ]);
    });

    it('flattens an assistant entry to its text, then the gray summary, then (if any) the yellow hint', () => {
      const okEntry: TranscriptEntry = {
        role: 'assistant',
        text: 'the answer',
        summary: { stopReason: 'stop', tokensUsed: { input: 10, output: 5 } },
      };
      const okLines = wrapTranscript([okEntry], 80);
      expect(okLines[0]).toEqual({ text: 'the answer', style: 'assistant' });
      expect(okLines[1]?.style).toBe('summary'); // the ` {summary}` line (leading space, mirrors TranscriptLine)
      expect(okLines[1]?.text.startsWith(' ')).toBe(true);
      expect(okLines).toHaveLength(2); // a successful turn has NO recovery-hint line

      // A failed turn (a code with an actionable hint) appends the yellow hint line.
      const failEntry: TranscriptEntry = {
        role: 'assistant',
        text: 'sorry',
        summary: {
          stopReason: 'stop',
          tokensUsed: { input: 0, output: 0 },
          errorCode: 'provider_auth',
        },
      };
      const failLines = wrapTranscript([failEntry], 200);
      expect(failLines.at(-1)?.style).toBe('hint');
      expect(failLines.at(-1)?.text).toContain('→'); // the ` → {hint}` marker, mirroring TranscriptLine
    });

    it('strips terminal control sequences at the display boundary (no ANSI/OSC injection through the viewport)', () => {
      const entries: TranscriptEntry[] = [{ role: 'user', text: 'a\x1b[31mred\x1b[0mb' }];
      const lines = wrapTranscript(entries, 80);
      expect(lines[0]?.text).toBe('> aredb'); // the CSI sequences are removed, exactly as TranscriptLine sanitizes
      expect(lines[0]?.text).not.toContain('\x1b');
    });

    it('preserves order across a mixed transcript', () => {
      const entries: TranscriptEntry[] = [
        { role: 'user', text: 'q' },
        {
          role: 'assistant',
          text: 'a',
          summary: { stopReason: 'stop', tokensUsed: { input: 1, output: 1 } },
        },
        { role: 'notice', text: 'n' },
      ];
      const styles = wrapTranscript(entries, 80).map((l) => l.style);
      expect(styles).toEqual(['user', 'assistant', 'summary', 'notice']);
    });
  });

  describe('liveScrollGeometry (2.6.F Step 4b-2 — fresh keypress geometry, ADR-0068 §c)', () => {
    it('reports totalLines as the CURRENT wrapped count + carries the measured height through', () => {
      const entries: TranscriptEntry[] = [
        { role: 'user', text: 'one' },
        { role: 'user', text: 'two' },
        { role: 'user', text: 'three' },
      ];
      // Each short user entry is one wrapped line at width 80 → totalLines === entry count; height passes through.
      expect(liveScrollGeometry(entries, 80, 12)).toEqual({ totalLines: 3, height: 12 });
      // The count is the WRAPPED count, not the entry count: a line wider than cols wraps to multiple rows.
      const long: TranscriptEntry[] = [{ role: 'user', text: 'x'.repeat(30) }];
      expect(liveScrollGeometry(long, 10, 8)).toEqual({
        totalLines: wrapTranscript(long, 10).length,
        height: 8,
      });
      expect(liveScrollGeometry(long, 10, 8).totalLines).toBeGreaterThan(1); // it genuinely wrapped
    });

    it('is empty-safe (a fresh session before any entry lands)', () => {
      expect(liveScrollGeometry([], 80, 24)).toEqual({ totalLines: 0, height: 24 });
    });
  });

  describe('wrapTranscript per-entry cache (2.6.F Step 4b-3 — no-thrash caps-lift, ADR-0068 §c)', () => {
    it('is incremental: appending an entry only EXTENDS the output; the whole == the per-entry concatenation', () => {
      const e1: TranscriptEntry = { role: 'user', text: 'hello world' };
      const e2: TranscriptEntry = { role: 'user', text: 'a second message here' };
      const first = wrapTranscript([e1], 80);
      const second = wrapTranscript([e1, e2], 80);
      expect(second.slice(0, first.length)).toEqual(first); // the appended entry only extends — history is stable
      expect(second).toEqual([...wrapTranscript([e1], 80), ...wrapTranscript([e2], 80)]); // == the concatenation
    });

    it('reuses the cached wrap for an unchanged entry (same object on a hit) and re-wraps on a cols change', () => {
      const entry: TranscriptEntry = {
        role: 'user',
        text: 'the quick brown fox jumped over the lazy dog',
      };
      const a = wrapTranscript([entry], 80);
      const b = wrapTranscript([entry], 80); // same cols → cache HIT
      expect(b[0]).toBe(a[0]); // the SAME DisplayLine object — proves the per-entry cache served it (not a re-wrap)
      const narrow = wrapTranscript([entry], 8); // a cols change re-wraps
      expect(narrow.length).toBeGreaterThan(a.length);
      expect(narrow).not.toEqual(a);
      expect(wrapTranscript([entry], 80)).toEqual(a); // back to 80 → identical content again
    });

    it('wraps a >8192-entry transcript correctly + repeatably — never thrashes or drifts (the fixed pathology)', () => {
      const big: TranscriptEntry[] = [];
      for (let i = 0; i < 12000; i += 1) big.push({ role: 'user', text: `msg ${i}` });
      const once = wrapTranscript(big, 40);
      const twice = wrapTranscript(big, 40);
      expect(twice).toEqual(once); // stable across re-wraps of a transcript larger than any fixed cache (no thrash)
      expect(once).toHaveLength(big.length); // each short `> msg N` line is exactly one row at cols 40
    });
  });
});

/**
 * `entryLines` + `transcriptDocument` (2.6.F Step 5d) — the UNWRAPPED projection. Until now these were exercised only
 * transitively through `wrapEntry`/`wrapTranscript`, which proves the WRAPPING, not the document shape `/edit` hands
 * to `$EDITOR` (the Step-5d-2 Sonnet review). Tested directly here, because `transcriptDocument` is what the user
 * reads, searches, and copies out of their editor.
 */
describe('entryLines — the shared, unwrapped per-entry projection', () => {
  it('a user entry is one `> `-prefixed line', () => {
    expect(entryLines({ role: 'user', text: 'hello' })).toEqual([
      { text: '> hello', style: 'user' },
    ]);
  });

  it('a notice entry is its bare text', () => {
    expect(entryLines({ role: 'notice', text: 'session resumed' })).toEqual([
      { text: 'session resumed', style: 'notice' },
    ]);
  });

  it('an assistant entry is text, THEN the summary line (leading space) — in that order', () => {
    const lines = entryLines({
      role: 'assistant',
      text: 'the answer',
      summary: { stopReason: 'stop', tokensUsed: { input: 10, output: 5 } },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ text: 'the answer', style: 'assistant' });
    expect(lines[1]?.style).toBe('summary');
    expect(lines[1]?.text.startsWith(' ')).toBe(true);
  });

  it('an assistant entry with an actionable error code appends the hint line LAST', () => {
    const lines = entryLines({
      role: 'assistant',
      text: 'sorry',
      summary: {
        stopReason: 'stop',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'provider_auth',
      },
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]?.style).toBe('hint');
    expect(lines[2]?.text.startsWith(' \u2192 ')).toBe(true);
  });

  it('does NOT wrap: a long line stays one line, and embedded newlines stay embedded', () => {
    const long = 'x'.repeat(500);
    expect(entryLines({ role: 'notice', text: long })).toEqual([{ text: long, style: 'notice' }]);
    expect(entryLines({ role: 'user', text: 'a\nb' })).toEqual([{ text: '> a\nb', style: 'user' }]);
  });

  it('sanitizes at the projection boundary (every consumer inherits it)', () => {
    expect(entryLines({ role: 'notice', text: '\x1b[31mred\x1b[0m' })).toEqual([
      { text: 'red', style: 'notice' },
    ]);
  });
});

describe('transcriptDocument — what `/edit` hands to $EDITOR', () => {
  it('joins every entry’s lines with a newline, in transcript order', () => {
    expect(
      transcriptDocument([
        { role: 'user', text: 'hi' },
        { role: 'notice', text: 'note' },
      ]),
    ).toBe('> hi\nnote');
  });

  it('an EMPTY transcript is the empty document (never `undefined`, never a stray newline)', () => {
    expect(transcriptDocument([])).toBe('');
  });

  it('a multi-line assistant answer round-trips its internal newlines UNWRAPPED', () => {
    const doc = transcriptDocument([
      {
        role: 'assistant',
        text: 'line one\nline two',
        summary: { stopReason: 'stop', tokensUsed: { input: 1, output: 1 } },
      },
    ]);
    const [first, second, summary] = doc.split('\n');
    expect(first).toBe('line one');
    expect(second).toBe('line two');
    expect(summary?.startsWith(' ')).toBe(true); // the summary line follows, not a re-wrap of the answer
  });

  it('is width-INDEPENDENT — a 500-char answer is one line, so the editor re-flows at ITS width', () => {
    const long = 'y'.repeat(500);
    expect(transcriptDocument([{ role: 'user', text: long }]).split('\n')).toHaveLength(1);
  });

  it('SECURITY: strips a Trojan-Source bidi OVERRIDE but leaves legitimate RTL text intact', () => {
    // An editor renders bidi controls, so an RLO in model output would spoof the reading order of the very
    // transcript the user opened `/edit` to inspect. But Arabic/Hebrew/Persian letters carry their direction
    // IMPLICITLY (the Unicode bidi algorithm) — stripping the explicit overrides never touches them. Relavium
    // ships `tr` today and may ship RTL locales; this must not mangle a legitimate conversation.
    const rlo = '\u202E'; // RIGHT-TO-LEFT OVERRIDE
    const doc = transcriptDocument([
      { role: 'user', text: `safe${rlo}gnp.exe` },
      { role: 'notice', text: 'مرحبا بالعالم' }, // Arabic: implicit RTL, no control characters at all
    ]);
    expect(doc).toBe('> safegnp.exe\nمرحبا بالعالم');
    expect(doc).not.toContain(rlo);
  });
});

/**
 * THE STREAMING ANSWER'S ROW BUDGET (2.6.F Step 6h, Sonnet review).
 *
 * The alt screen's frame is `height: rows` and ink clips it there, so an unbounded busy line does not scroll — it
 * COLLIDES with its siblings. Reproduced at 80x24 with a 900-character answer, well under `MAX_LIVE_TOKEN_CHARS`:
 * the "Esc to stop" hint and the streamed text landed on the SAME frame row, overwriting each other.
 */
describe('liveAnswerRowBudget', () => {
  it('is a third of the terminal, so the viewport, prompt and footer all survive', () => {
    expect(liveAnswerRowBudget(24)).toBe(8);
    expect(liveAnswerRowBudget(60)).toBe(20);
  });

  it('never returns zero — a one-row terminal still shows one row of the answer', () => {
    expect(liveAnswerRowBudget(1)).toBe(1);
    expect(liveAnswerRowBudget(2)).toBe(1);
  });

  it('falls back for a detached / zero-sized TTY rather than dividing by nothing', () => {
    expect(liveAnswerRowBudget(undefined)).toBe(8);
    expect(liveAnswerRowBudget(0)).toBe(8);
    expect(liveAnswerRowBudget(-5)).toBe(8);
  });
});

describe('formatBusyLine — the streaming content is bounded on the alt screen only', () => {
  const busy = (
    liveTokens: string,
    over: Record<string, unknown> = {},
  ): { text: string; dim: boolean } =>
    formatBusyLine({
      spinner: '*',
      compacting: false,
      liveTokens,
      liveTokensTruncated: false,
      ...over,
    });

  it('WITHOUT a row budget the content is untouched — the inline renderer stays byte-identical', () => {
    const long = 'y'.repeat(2000);
    expect(busy(long).text).toBe(`* ${long}`);
  });

  it('WITH a row budget it keeps the TAIL and marks the elision', () => {
    const long = 'y'.repeat(2000);
    const line = busy(long, { columns: 80, maxRows: 8 });
    expect(line.text.startsWith('* …')).toBe(true);
    expect(line.text.length).toBeLessThan(long.length); // …and it is a tail, not the whole thing
    expect(line.text.endsWith('y')).toBe(true); // the NEWEST characters survive
  });

  it('short content is not marked, budget or no budget', () => {
    expect(busy('hello', { columns: 80, maxRows: 8 }).text).toBe('* hello');
  });

  it('the character-cap marker still shows even when the row budget did not trigger', () => {
    expect(busy('hello', { columns: 80, maxRows: 8, liveTokensTruncated: true }).text).toBe(
      '* …hello',
    );
  });

  it('a STATUS line (pre-token, compacting, shell) is never tailed — it has no content', () => {
    expect(busy('', { columns: 80, maxRows: 8 }).dim).toBe(true);
    expect(busy('x', { compacting: true, columns: 80, maxRows: 1 }).dim).toBe(true);
  });
});

/**
 * THE RESEAT PERF HARNESS ADR-0059 ALREADY CLAIMED EXISTED (2.6.C Step 6).
 *
 * ADR-0059's Consequences say the reseat's `O(n)` cost is *"verified by the 2.6.C harness (a 200-message session
 * reseats in well under the interactive budget)"*. No such harness was ever written.
 *
 * It lives HERE, not beside the store, because the store is the WRONG place to measure: seeding a reseated store is a
 * single reference assignment (`initialSessionViewState` aliases the carried array; it never copies or iterates it),
 * so timing `createChatStore` would be O(1) at any conversation length — a tautology dressed as a budget. A first
 * draft of this harness did exactly that, and would have "verified" the ADR by measuring a pointer.
 *
 * The real O(n) cost the carry adds is HERE: `driveInk` unmounts and re-mounts ink around a standalone reseat, and
 * the fresh mount re-wraps the whole carried transcript from scratch (the wrap memo is keyed on the transcript
 * reference, which a brand-new store always busts). That is the work a 200-message reseat actually pays.
 *
 * If it ever gets slow the answer is a WRAP CACHE, not a trim: ADR-0068 Decision (c) makes the full-screen bound
 * effectively unbounded on purpose, and trimming the carry would re-introduce the clipping that ADR exists to fix.
 */
describe('the reseat carry is O(n) — the perf claim ADR-0059 makes', () => {
  const conversation = (turns: number): TranscriptEntry[] =>
    Array.from({ length: turns }, (_, i) => [
      { role: 'user' as const, text: `question ${i}: ${'x'.repeat(200)}` },
      { role: 'notice' as const, text: `answer ${i}: ${'y'.repeat(400)}` },
    ]).flat();

  /** Median of a few samples — a single wall-clock reading is GC noise, not a measurement. */
  const medianWrapMs = (entries: readonly TranscriptEntry[], samples = 5): number => {
    const runs: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const started = performance.now();
      wrapTranscript(entries, 80);
      runs.push(performance.now() - started);
    }
    return runs.sort((a, b) => a - b)[Math.floor(samples / 2)] ?? 0;
  };

  it('re-wraps a 200-message carried conversation well under the interactive budget', () => {
    const carried = conversation(100); // 100 turns => 200 messages: ADR-0059's stated case
    expect(carried).toHaveLength(200);
    wrapTranscript(carried, 80); // warm up, so the first sample does not pay for JIT

    const elapsed = medianWrapMs(carried);
    const lines = wrapTranscript(carried, 80);
    expect(lines.length).toBeGreaterThan(200); // it really did wrap every entry — not a no-op being timed
    expect(elapsed).toBeLessThan(100); // a user-initiated switch must feel instant
  });

  it('scales LINEARLY, not quadratically — 4x the conversation is not 16x the wrap', () => {
    // The guard is the SHAPE. An accidental O(n^2) (a per-entry re-scan of everything before it) would blow this ratio
    // long before it blew the budget above, and it is the only regression that makes a long chat unusable.
    wrapTranscript(conversation(50), 80); // warm up
    const small = Math.max(medianWrapMs(conversation(50)), 0.05);
    const large = medianWrapMs(conversation(200)); // 4x the conversation
    expect(large / small).toBeLessThan(10); // linear ≈ 4x; quadratic ≈ 16x
  });
});
