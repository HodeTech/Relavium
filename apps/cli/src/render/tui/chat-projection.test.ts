import { describe, expect, it } from 'vitest';

import { formatSessionFooter, formatToolCall, formatTurnSummary } from './chat-projection.js';
import { initialSessionViewState } from './session-view-model.js';

describe('chat-projection', () => {
  describe('formatTurnSummary', () => {
    it('renders the stop reason, tokens, and duration for a successful turn', () => {
      const line = formatTurnSummary({
        stopReason: 'stop',
        tokensUsed: { input: 10, output: 5 },
        durationMs: 1500,
      });
      expect(line).toContain('stop');
      expect(line).toContain('·'); // dot-separated parts
    });

    it('surfaces the error code (not the stop reason) for a failed turn', () => {
      const line = formatTurnSummary({
        stopReason: 'error',
        tokensUsed: { input: 0, output: 0 },
        errorCode: 'turn_limit',
      });
      expect(line).toContain('error: turn_limit');
    });

    it('omits the duration when it is unknown', () => {
      const line = formatTurnSummary({ stopReason: 'stop', tokensUsed: { input: 1, output: 1 } });
      expect(line).toContain('stop');
    });
  });

  describe('formatToolCall', () => {
    it('marks an unresolved call as pending and a resolved call as done — id only, no arguments', () => {
      expect(formatToolCall({ toolId: 'read_file', resolved: false })).toBe('→ read_file …');
      expect(formatToolCall({ toolId: 'read_file', resolved: true })).toBe('→ read_file ✓');
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
  });
});
