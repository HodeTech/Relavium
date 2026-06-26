import { describe, expect, it } from 'vitest';

import {
  formatSessionFooter,
  formatToolCall,
  formatTurnSummary,
  stripTerminalControls,
} from './chat-projection.js';
import { formatDuration, formatTokens } from './format.js';
import { initialSessionViewState } from './session-view-model.js';

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

    it('omits the duration segment when the duration is unknown (stop + tokens only)', () => {
      const line = formatTurnSummary({ stopReason: 'stop', tokensUsed: { input: 1, output: 1 } });
      const parts = line.split(' · ');
      expect(parts).toHaveLength(2); // stop · tokens — the duration segment is ABSENT
      expect(parts[0]).toBe('stop');
      expect(parts[1]).toBe(formatTokens({ input: 1, output: 1 }));
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

  describe('formatSessionFooter', () => {
    it('shows the model, running cost, and pluralized turn count', () => {
      const base = initialSessionViewState();
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
      const footer = formatSessionFooter(initialSessionViewState());
      expect(footer).toContain('0 turns');
      expect(footer).toMatch(/^\$/); // starts with the cost (no leading model segment / separator)
    });

    it('sanitizes the model name so it cannot inject control sequences into the footer', () => {
      const footer = formatSessionFooter({
        ...initialSessionViewState(),
        model: '\x1b[31mevil\x07\nmodel',
      });
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
      expect(footer).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(footer.startsWith('evil model · ')).toBe(true); // escapes stripped; newline collapsed
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
  });
});
